/**
 * mcp.config.json: MCP servers Sibyl connects to at startup. Same shape as
 * Claude Desktop's config (`servers` or `mcpServers`):
 *
 *   { "servers": {
 *       "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },
 *       "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${MY_TOKEN}" } }
 *   } }
 *
 * `${VAR}` in env/header values and args is replaced from the gateway's
 * environment, so secrets can stay in .env. Keys starting with "_" are
 * comments and ignored.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface McpStdioServerConfig {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig {
  kind: "http";
  url: string;
  headers: Record<string, string>;
}

export type McpServerConfig = (McpStdioServerConfig | McpHttpServerConfig) & {
  name: string;
  /** Per-server connect timeout. */
  timeoutMs?: number;
};

export interface McpConfig {
  path: string;
  servers: McpServerConfig[];
}

/** Where mcp.config.json lives: SIBYL_MCP_CONFIG, else the repo root / cwd (no example fallback). */
export function resolveMcpConfigPath(env: NodeJS.ProcessEnv, cwd = process.cwd()): string | undefined {
  const explicit = env.SIBYL_MCP_CONFIG?.trim();
  const candidates = explicit
    ? [isAbsolute(explicit) ? explicit : resolve(env.INIT_CWD ?? cwd, explicit), resolve(cwd, explicit), resolve(cwd, "../..", explicit)]
    : [
        env.INIT_CWD ? resolve(env.INIT_CWD, "mcp.config.json") : undefined,
        resolve(cwd, "mcp.config.json"),
        resolve(cwd, "../../mcp.config.json")
      ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  if (explicit) throw new Error(`SIBYL_MCP_CONFIG not found: ${explicit}`);
  return undefined;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv, cwd = process.cwd()): McpConfig | undefined {
  const path = resolveMcpConfigPath(env, cwd);
  if (!path) return undefined;
  return { path, servers: parseMcpConfig(readFileSync(path, "utf8"), env, path) };
}

const SERVER_NAME = /^[a-zA-Z0-9_-]{1,32}$/;

export function parseMcpConfig(raw: string, env: NodeJS.ProcessEnv = {}, path = "mcp.config.json"): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must be a JSON object`);
  const servers = parsed.servers ?? parsed.mcpServers ?? {};
  if (!isRecord(servers)) throw new Error(`${path}: "servers" must be an object`);

  const expand = (value: string): string =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");

  const result: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (name.startsWith("_")) continue;
    const where = `${path}: server "${name}"`;
    if (!SERVER_NAME.test(name)) throw new Error(`${where}: name must match [a-zA-Z0-9_-]{1,32}`);
    if (!isRecord(entry)) throw new Error(`${where} must be an object`);
    if (entry.disabled === true || entry.enabled === false) continue;
    const timeoutMs = typeof entry.timeoutMs === "number" && entry.timeoutMs > 0 ? entry.timeoutMs : undefined;
    if (typeof entry.command === "string" && entry.command.trim()) {
      if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string"))) {
        throw new Error(`${where}: "args" must be an array of strings`);
      }
      result.push({
        kind: "stdio",
        name,
        command: expand(entry.command.trim()),
        args: ((entry.args as string[] | undefined) ?? []).map(expand),
        env: stringRecord(entry.env, `${where}: "env"`, expand),
        cwd: typeof entry.cwd === "string" ? expand(entry.cwd) : undefined,
        timeoutMs
      });
    } else if (typeof entry.url === "string" && entry.url.trim()) {
      let url: URL;
      try {
        url = new URL(expand(entry.url.trim()));
      } catch {
        throw new Error(`${where}: "url" is not a valid URL`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${where}: "url" must be http(s)`);
      result.push({ kind: "http", name, url: url.toString(), headers: stringRecord(entry.headers, `${where}: "headers"`, expand), timeoutMs });
    } else {
      throw new Error(`${where} needs either "command" (stdio) or "url" (Streamable HTTP)`);
    }
  }
  return result;
}

function stringRecord(value: unknown, where: string, expand: (v: string) => string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${where} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("_")) continue;
    if (typeof item !== "string") throw new Error(`${where}.${key} must be a string`);
    out[key] = expand(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
