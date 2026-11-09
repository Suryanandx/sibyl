/**
 * MCP client: connects to the servers in mcp.config.json with the official
 * SDK and exposes each server tool as a Sibyl ToolDefinition.
 *
 * - Names: `mcp_<server>_<tool>`, sanitized to [a-zA-Z0-9_-]{1,64}.
 * - Effects: "read" only when the server marks the tool `readOnlyHint: true`;
 *   everything else is "write" and needs the user's approval.
 * - A server that fails to start is logged and skipped; the others still load.
 * - When a transport breaks, the connection is dropped and re-established on
 *   the next call (never by silently re-running a call that may have executed).
 */
import { createHash } from "node:crypto";
import type { ToolDefinition, ToolResult } from "@open-gpt-live/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_CONTENT_CHARS = 20_000;
const CLIENT_INFO = { name: "sibyl", version: "0.3.0" };

type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface McpConnectionOptions {
  log: Log;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Override transport creation (tests use the SDK's in-memory transport). */
  createTransport?: (config: McpServerConfig) => Transport | Promise<Transport>;
}

/** One configured server; owns (and lazily re-creates) its SDK client. */
export class McpServerConnection {
  private client?: Client;
  private connecting?: Promise<Client>;
  private closed = false;

  constructor(
    readonly config: McpServerConfig,
    private readonly options: McpConnectionOptions
  ) {}

  get name(): string {
    return this.config.name;
  }

  async connect(): Promise<Client> {
    if (this.closed) throw new Error(`MCP server ${this.name} is shut down`);
    if (this.client) return this.client;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const timeoutMs = this.config.timeoutMs ?? this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const transport = await this.createTransport();
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transport, { timeout: timeoutMs }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        })
      ]);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        if (!this.closed) this.options.log("mcp.disconnected", { server: this.name });
      }
    };
    client.onerror = (error) => {
      this.options.log("mcp.transport_error", { server: this.name, error: error.message });
    };
    if (this.closed) {
      await client.close().catch(() => undefined);
      throw new Error(`MCP server ${this.name} is shut down`);
    }
    this.client = client;
    return client;
  }

  private async createTransport(): Promise<Transport> {
    if (this.options.createTransport) return this.options.createTransport(this.config);
    const config = this.config;
    if (config.kind === "http") {
      return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // The SDK merges a minimal safe environment (PATH, HOME, …) under this — never the gateway's secrets.
      env: config.env,
      cwd: config.cwd,
      stderr: "pipe"
    });
    // Drain the server's stderr into our log (an undrained pipe would stall the child).
    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.options.log("mcp.stderr", { server: this.name, text: text.slice(0, 500) });
    });
    return transport;
  }

  async listTools(): Promise<Tool[]> {
    const client = await this.connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    let client: Client;
    try {
      client = await this.connect();
    } catch (error) {
      return { content: `MCP server "${this.name}" is unavailable: ${errorMessage(error)}`, isError: true };
    }
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true
      });
      return convertCallResult(result);
    } catch (error) {
      if (signal.aborted) return { content: "The tool call was cancelled.", isError: true };
      if (isTransportFailure(error)) {
        // Drop the broken client; the next call reconnects.
        if (this.client === client) this.client = undefined;
        await client.close().catch(() => undefined);
        this.options.log("mcp.call_transport_failed", { server: this.name, tool: name, error: errorMessage(error) });
        return {
          content: `Lost the connection to MCP server "${this.name}" (${errorMessage(error)}). It will reconnect on the next call; the action may or may not have run.`,
          isError: true
        };
      }
      return { content: `MCP tool ${name} failed: ${errorMessage(error)}`, isError: true };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client ?? (await this.connecting?.catch(() => undefined));
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed;
  // Anything that isn't a JSON-RPC error (socket reset, fetch failure, closed stream).
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convert an MCP CallToolResult into compact text for the model (+ structured data). */
export function convertCallResult(result: Record<string, unknown>): ToolResult {
  if ("toolResult" in result && !("content" in result)) {
    const data = result.toolResult;
    return { content: truncateText(typeof data === "string" ? data : JSON.stringify(data)), data };
  }
  const blocks = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  const parts = blocks.map(blockToText).filter((part) => part.length > 0);
  const structured = result.structuredContent;
  if (parts.length === 0 && structured !== undefined) parts.push(JSON.stringify(structured));
  const content = truncateText(parts.join("\n\n")) || (result.isError ? "The tool reported an error." : "(no output)");
  return {
    content,
    data: structured ?? undefined,
    isError: result.isError === true ? true : undefined
  };
}

function blockToText(block: Record<string, unknown>): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "image":
      return `[image${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""} omitted]`;
    case "audio":
      return `[audio${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""} omitted]`;
    case "resource_link":
      return `[resource: ${String(block.name ?? block.title ?? "")} ${String(block.uri ?? "")}]`.replace(/\s+\]/, "]");
    case "resource": {
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      if (typeof resource.text === "string") return resource.text;
      return `[resource ${String(resource.uri ?? "")}${typeof resource.mimeType === "string" ? ` (${resource.mimeType})` : ""} omitted]`;
    }
    default:
      return `[${String(block.type ?? "unknown")} content omitted]`;
  }
}

function truncateText(text: string): string {
  return text.length <= MAX_CONTENT_CHARS ? text : `${text.slice(0, MAX_CONTENT_CHARS)}\n… (output truncated)`;
}

/** `mcp_<server>_<tool>` → [a-zA-Z0-9_-]{1,64}, unique within `taken`. */
export function mcpToolName(server: string, tool: string, taken: Set<string> = new Set()): string {
  const base = `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const hashed = (seed: string) => `${base.slice(0, 57)}_${createHash("sha1").update(seed).digest("hex").slice(0, 6)}`;
  let name = base.length <= 64 ? base : hashed(base);
  for (let i = 1; taken.has(name); i += 1) name = hashed(`${base}#${i}`);
  taken.add(name);
  return name;
}

/** Wrap one server tool as a Sibyl ToolDefinition. */
export function toToolDefinition(connection: McpServerConnection, tool: Tool, name: string): ToolDefinition {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const schema = (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>;
  return {
    name,
    title: tool.title ?? tool.annotations?.title ?? tool.name,
    description: (tool.description?.trim() || `${tool.name} (from MCP server ${connection.name})`).slice(0, 4_000),
    inputSchema: { ...schema, type: "object", properties: schema.properties ?? {} },
    effect: readOnly ? "read" : "write",
    source: "mcp",
    provider: connection.name,
    run: (input, context) => connection.callTool(tool.name, (input ?? {}) as Record<string, unknown>, context.signal)
  };
}

export interface McpToolSet {
  tools: ToolDefinition[];
  connections: McpServerConnection[];
  close(): Promise<void>;
}

/** Connect every server (in parallel), list their tools, and wrap them. */
export async function connectMcpServers(configs: McpServerConfig[], options: McpConnectionOptions): Promise<McpToolSet> {
  const connections = configs.map((config) => new McpServerConnection(config, options));
  const listed = await Promise.all(
    connections.map(async (connection) => {
      const startedAt = Date.now();
      try {
        const tools = await connection.listTools();
        options.log("mcp.connected", {
          server: connection.name,
          transport: connection.config.kind,
          tools: tools.length,
          ms: Date.now() - startedAt
        });
        return { connection, tools };
      } catch (error) {
        options.log("mcp.server_failed", { server: connection.name, transport: connection.config.kind, error: errorMessage(error) });
        await connection.close();
        return { connection, tools: [] as Tool[] };
      }
    })
  );
  const taken = new Set<string>();
  const tools: ToolDefinition[] = [];
  for (const { connection, tools: serverTools } of listed) {
    for (const tool of serverTools) tools.push(toToolDefinition(connection, tool, mcpToolName(connection.name, tool.name, taken)));
  }
  return {
    tools,
    connections,
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    }
  };
}
