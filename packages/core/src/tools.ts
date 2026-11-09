/**
 * Tools: the one way Sibyl's brain does things in the world.
 *
 * Built-in tools, MCP servers and the slides service all register here. The
 * deep brain sees the registry as OpenAI-style function tools; anything with
 * effect "write" pauses for an approval before it runs.
 */
import type { Store } from "./store";
import type { UsageMeter } from "./usage";

export type ToolEffect = "read" | "write";

/** Where a tool comes from (shown in the UI, used for per-source switches). */
export type ToolSource = "builtin" | "mcp" | "slides" | (string & {});

export interface ToolDefinition<Input = Record<string, unknown>, Output = unknown> {
  /** Unique, snake_case, ≤ 64 chars (OpenAI function-name rules). */
  name: string;
  /** Short human label, e.g. "Search the web". */
  title: string;
  /** What it does and when to use it — written for the model. */
  description: string;
  /** JSON Schema (object) for the input. */
  inputSchema: Record<string, unknown>;
  /** "write" tools (send, create, delete, spend) need an approval first. */
  effect: ToolEffect;
  source: ToolSource;
  /** Optional MCP server / provider id for grouping and toggles. */
  provider?: string;
  run(input: Input, context: ToolContext): Promise<ToolResult<Output>>;
}

export interface ToolContext {
  signal: AbortSignal;
  ownerId: string;
  conversationId?: string;
  /** The brain run this call belongs to (deep-work request id or routine run id). */
  runId: string;
  store: Store;
  meter: UsageMeter;
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface ToolResult<Output = unknown> {
  /** Text the model reads (keep it compact; truncate large payloads). */
  content: string;
  /** Structured data for the UI or follow-up tools. */
  data?: Output;
  /** True when the call failed; content explains why. */
  isError?: boolean;
  /** Files or decks produced (e.g. a slides deck). */
  artifacts?: ArtifactRef[];
}

export interface ArtifactRef {
  id: string;
  kind: "slides" | "file";
  title: string;
}

export interface ToolRegistry {
  register(tool: ToolDefinition<any, any>): void;
  unregister(name: string): void;
  get(name: string): ToolDefinition<any, any> | undefined;
  list(filter?: { source?: ToolSource; provider?: string; enabledOnly?: boolean }): ToolDefinition<any, any>[];
  /** Per-tool on/off switch (persisted by whoever owns the registry). */
  setEnabled(name: string, enabled: boolean): void;
  isEnabled(name: string): boolean;
}

/** Simple in-process registry. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const disabled = new Set<string>();
  return {
    register(tool) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
        throw new Error(`Invalid tool name: ${tool.name}`);
      }
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    },
    unregister(name) {
      tools.delete(name);
    },
    get(name) {
      return tools.get(name);
    },
    list(filter = {}) {
      return [...tools.values()].filter(
        (tool) =>
          (!filter.source || tool.source === filter.source) &&
          (!filter.provider || tool.provider === filter.provider) &&
          (!filter.enabledOnly || !disabled.has(tool.name))
      );
    },
    setEnabled(name, enabled) {
      if (enabled) disabled.delete(name);
      else disabled.add(name);
    },
    isEnabled(name) {
      return tools.has(name) && !disabled.has(name);
    }
  };
}

/** OpenAI-compatible function-tool spec for chat/completions `tools`. */
export function toFunctionTools(tools: ToolDefinition<any, any>[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.effect === "write"
        ? `${tool.description}\n(Needs the user's approval before it runs.)`
        : tool.description,
      parameters: tool.inputSchema
    }
  }));
}
