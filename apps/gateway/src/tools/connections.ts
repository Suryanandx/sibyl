/**
 * Connections: MCP servers and tool switches managed at runtime (the
 * Connections screen in the web app).
 *
 * - Servers come from mcp.config.json (read-only here) and from the app
 *   (persisted in kv `mcp.servers`). File servers win on a name clash.
 * - A whole server can be switched off (kv `mcp.servers.disabled`): it is
 *   disconnected and its tools leave the registry.
 * - Per-tool switches reuse kv `tools.disabled` (see switches.ts).
 * - Secrets (env and header values, URL passwords) stay on the gateway; views
 *   carry masked values, and a `null` in a save keeps the stored value.
 * - Adding a stdio server runs a local command, so the app may only add or
 *   start one when SIBYL_ALLOW_STDIO_MCP=true.
 * - Env and header values may hold `${secret:NAME}` references to the secrets
 *   store. They are stored and shown as-is (a reference is not a secret) and
 *   resolved only when connecting, through the optional `resolveSecrets` hook.
 */
import type { Store, ToolDefinition, ToolRegistry } from "@open-gpt-live/core";
import type {
  ConnectionCatalogEntry,
  ConnectionServerInput,
  ConnectionServerStatus,
  ConnectionServerView,
  ConnectionToolView,
  ConnectionsState
} from "@open-gpt-live/protocol";
import catalogJson from "./catalog.json";
import { McpServerConnection, mcpToolName, toToolDefinition, type McpConnectionOptions } from "./mcp/client.js";
import type { McpServerConfig } from "./mcp/config.js";
import { loadDisabledTools, setToolEnabled } from "./switches.js";

export const MCP_SERVERS_KEY = "mcp.servers";
export const MCP_DISABLED_SERVERS_KEY = "mcp.servers.disabled";
const SERVER_NAME = /^[a-zA-Z0-9_-]{1,32}$/;

export const STDIO_NOT_ALLOWED =
  "Local (stdio) servers run a command on the gateway host, so adding them from the app is off. Set SIBYL_ALLOW_STDIO_MCP=true on the gateway, or add the server to mcp.config.json.";

type Log = (event: string, fields?: Record<string, unknown>) => void;

/** A server added from the app, as stored in kv (raw values, server-side only). */
export interface StoredServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  catalogId?: string;
}

interface ServerEntry {
  name: string;
  origin: "file" | "ui";
  config: McpServerConfig;
  catalogId?: string;
  status: ConnectionServerStatus;
  error?: string;
  connection?: McpServerConnection;
  toolNames: string[];
  /** Bumped on every (re)connect/disconnect; stale results are dropped. */
  generation: number;
}

/**
 * Resolves `${secret:NAME}` references in one env/header value at connect
 * time. `host` is the remote server's hostname (undefined for stdio), so the
 * secrets store can refuse to send a secret to the wrong host.
 */
export type ResolveSecrets = (value: string, ctx: { host?: string }) => Promise<string>;

export const SECRET_REF = /\$\{secret:[A-Za-z0-9_.-]{1,128}\}/;

export interface ConnectionsManagerOptions {
  tools: ToolRegistry;
  store: Store;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: Log;
  /** Servers from mcp.config.json (already parsed). */
  fileServers?: McpServerConfig[];
  configPath?: string;
  configError?: string;
  mcp?: Partial<McpConnectionOptions>;
  catalog?: ConnectionCatalogEntry[];
  /** Resolve `${secret:NAME}` references when connecting; values pass unchanged without it. */
  resolveSecrets?: ResolveSecrets;
}

export interface TestResult {
  ok: boolean;
  toolCount?: number;
  tools?: string[];
  error?: string;
  ms: number;
}

export function loadCatalog(): ConnectionCatalogEntry[] {
  return (catalogJson as { entries: ConnectionCatalogEntry[] }).entries;
}

export function stdioAllowed(env: NodeJS.ProcessEnv): boolean {
  return /^(true|1|yes|on)$/i.test(env.SIBYL_ALLOW_STDIO_MCP?.trim() ?? "");
}

export class ConnectionsManager {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly options: ConnectionsManagerOptions;
  private readonly catalog: ConnectionCatalogEntry[];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: ConnectionsManagerOptions) {
    this.options = options;
    this.catalog = options.catalog ?? loadCatalog();
  }

  get allowStdio(): boolean {
    return stdioAllowed(this.options.env);
  }

  /** Connect every enabled server (in parallel) and apply the tool switches. */
  async start(): Promise<void> {
    const disabled = new Set(await this.loadDisabledServers());
    for (const config of this.options.fileServers ?? []) {
      this.entries.set(config.name, newEntry(config.name, "file", config));
    }
    for (const stored of await this.loadStoredServers()) {
      if (this.entries.has(stored.name)) {
        this.options.log("connections.name_clash", { server: stored.name, kept: "mcp.config.json" });
        continue;
      }
      this.entries.set(stored.name, newEntry(stored.name, "ui", toConfig(stored), stored.catalogId));
    }
    await Promise.all(
      [...this.entries.values()].map((entry) => {
        if (disabled.has(entry.name)) {
          entry.status = "disabled";
          return Promise.resolve();
        }
        return this.connectEntry(entry, false);
      })
    );
    await this.applyToolSwitches();
  }

  /** Everything the Connections screen shows (secrets masked). */
  async state(): Promise<ConnectionsState> {
    const { tools } = this.options;
    const toolView = (tool: ToolDefinition<any, any>): ConnectionToolView => ({
      name: tool.name,
      title: tool.title,
      description: tool.description.slice(0, 600),
      effect: tool.effect,
      enabled: tools.isEnabled(tool.name)
    });
    const servers: ConnectionServerView[] = [...this.entries.values()].map((entry) => {
      const serverTools = entry.toolNames
        .map((name) => tools.get(name))
        .filter((tool): tool is ToolDefinition<any, any> => Boolean(tool))
        .map(toolView);
      const config = entry.config;
      return {
        name: entry.name,
        origin: entry.origin,
        transport: config.kind,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
        enabled: entry.status !== "disabled",
        toolCount: serverTools.length,
        tools: serverTools,
        ...(config.kind === "stdio"
          ? {
              command: config.command,
              args: config.args.map(maskArg),
              env: maskRecord(config.env),
              ...(config.cwd ? { cwd: config.cwd } : {})
            }
          : { url: maskUrl(config.url), headers: maskRecord(config.headers) }),
        ...(entry.catalogId ? { catalogId: entry.catalogId } : {})
      };
    });
    return {
      builtin: tools.list({ source: "builtin" }).map(toolView),
      servers,
      catalog: this.catalog,
      allowStdio: this.allowStdio,
      ...(this.options.configPath ? { configPath: this.options.configPath } : {}),
      ...(this.options.configError ? { configError: this.options.configError } : {})
    };
  }

  setToolEnabled(name: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      if (!this.options.tools.get(name)) throw new Error(`Unknown tool: ${name}`);
      await setToolEnabled(this.options.tools, this.options.store, this.options.ownerId, name, enabled);
    });
  }

  /** Flip every built-in tool at once. */
  setBuiltinEnabled(enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const { tools, store, ownerId } = this.options;
      const names = tools.list({ source: "builtin" }).map((tool) => tool.name);
      const disabled = new Set(await loadDisabledTools(store, ownerId));
      for (const name of names) {
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        tools.setEnabled(name, enabled);
      }
      await store.kv.set(ownerId, "tools.disabled", [...disabled].sort());
    });
  }

  /** Switch a whole MCP server on (connect) or off (disconnect, tools removed). */
  setServerEnabled(name: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      const entry = this.requireEntry(name);
      const disabled = new Set(await this.loadDisabledServers());
      if (enabled) disabled.delete(name);
      else disabled.add(name);
      await this.options.store.kv.set(this.options.ownerId, MCP_DISABLED_SERVERS_KEY, [...disabled].sort());
      if (enabled) {
        if (entry.status === "disabled") await this.connectEntry(entry);
      } else {
        await this.disconnectEntry(entry);
        entry.status = "disabled";
        entry.error = undefined;
      }
    });
  }

  /** Add (no original) or edit (original = current name) an app-managed server. */
  saveServer(input: ConnectionServerInput, original?: string): Promise<void> {
    return this.serialize(async () => {
      const stored = await this.loadStoredServers();
      const previous = original ? stored.find((server) => server.name === original) : undefined;
      if (original && !previous) {
        throw new Error(this.entries.get(original)?.origin === "file"
          ? `"${original}" comes from mcp.config.json; edit that file instead.`
          : `Unknown server: ${original}`);
      }
      if (input.name !== original && this.entries.has(input.name)) {
        throw new Error(`A server named "${input.name}" already exists.`);
      }
      const next = mergeInput(input, previous);
      if (next.transport === "stdio" && !this.allowStdio) throw new Error(STDIO_NOT_ALLOWED);

      const list = stored.filter((server) => server.name !== original && server.name !== next.name);
      list.push(next);
      await this.saveStoredServers(list);

      if (original) {
        const old = this.entries.get(original);
        if (old) await this.disconnectEntry(old);
        this.entries.delete(original);
        if (original !== next.name) await this.renameDisabled(original, next.name);
      }
      const entry = newEntry(next.name, "ui", toConfig(next), next.catalogId);
      this.entries.set(next.name, entry);
      if ((await this.loadDisabledServers()).includes(next.name)) {
        entry.status = "disabled";
        return;
      }
      await this.connectEntry(entry);
    });
  }

  removeServer(name: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.requireEntry(name);
      if (entry.origin === "file") throw new Error(`"${name}" comes from mcp.config.json; remove it there.`);
      await this.disconnectEntry(entry);
      this.entries.delete(name);
      await this.saveStoredServers((await this.loadStoredServers()).filter((server) => server.name !== name));
      await this.renameDisabled(name, undefined);
    });
  }

  reconnect(name: string): Promise<void> {
    return this.serialize(async () => {
      const entry = this.requireEntry(name);
      if (entry.status === "disabled") throw new Error(`"${name}" is switched off.`);
      await this.connectEntry(entry);
    });
  }

  /**
   * Try a server without keeping it: a saved one by name, or a draft from the
   * form (`original` says whose stored secrets a null value refers to).
   */
  async test(target: { name?: string; server?: ConnectionServerInput; original?: string }): Promise<TestResult> {
    const startedAt = Date.now();
    let config: McpServerConfig;
    try {
      if (target.server) {
        const previous = target.original
          ? (await this.loadStoredServers()).find((server) => server.name === target.original)
          : undefined;
        const draft = mergeInput(target.server, previous);
        if (draft.transport === "stdio" && !this.allowStdio) throw new Error(STDIO_NOT_ALLOWED);
        config = toConfig(draft);
      } else {
        const entry = this.requireEntry(target.name ?? "");
        if (entry.origin === "ui" && entry.config.kind === "stdio" && !this.allowStdio) throw new Error(STDIO_NOT_ALLOWED);
        config = entry.config;
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error), ms: Date.now() - startedAt };
    }
    let connection: McpServerConnection;
    try {
      connection = new McpServerConnection(await this.resolveConfig(config), this.connectionOptions());
    } catch (error) {
      return { ok: false, error: errorMessage(error), ms: Date.now() - startedAt };
    }
    try {
      const tools = await connection.listTools();
      return { ok: true, toolCount: tools.length, tools: tools.map((tool) => tool.name).slice(0, 100), ms: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, error: errorMessage(error), ms: Date.now() - startedAt };
    } finally {
      await connection.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.values()].map((entry) => entry.connection?.close().catch(() => undefined)));
  }

  // ── internals ──

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireEntry(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown server: ${name}`);
    return entry;
  }

  private connectionOptions(): McpConnectionOptions {
    const { env, log, mcp } = this.options;
    return {
      log,
      connectTimeoutMs: positiveInt(env.SIBYL_MCP_CONNECT_TIMEOUT_MS),
      callTimeoutMs: positiveInt(env.SIBYL_MCP_CALL_TIMEOUT_MS),
      ...mcp
    };
  }

  /** (Re)connect a server, list its tools and register them. Never throws. */
  private async connectEntry(entry: ServerEntry, applySwitches = true): Promise<void> {
    await this.disconnectEntry(entry);
    if (this.closed) return;
    const generation = ++entry.generation;
    if (entry.origin === "ui" && entry.config.kind === "stdio" && !this.allowStdio) {
      entry.status = "failed";
      entry.error = STDIO_NOT_ALLOWED;
      return;
    }
    entry.status = "connecting";
    entry.error = undefined;
    let connection: McpServerConnection | undefined;
    const startedAt = Date.now();
    try {
      const resolved = await this.resolveConfig(entry.config);
      if (entry.generation !== generation || this.closed) return;
      connection = new McpServerConnection(resolved, this.connectionOptions());
      entry.connection = connection;
      const serverTools = await connection.listTools();
      if (entry.generation !== generation || this.entries.get(entry.name) !== entry) {
        await connection.close();
        return;
      }
      const { tools, log } = this.options;
      const taken = new Set(tools.list().map((tool) => tool.name));
      for (const tool of serverTools) {
        const name = mcpToolName(entry.name, tool.name, taken);
        try {
          tools.register(toToolDefinition(connection, tool, name));
          entry.toolNames.push(name);
        } catch (error) {
          log("mcp.tool_skipped", { tool: name, error: errorMessage(error) });
        }
      }
      entry.status = "connected";
      log("mcp.connected", { server: entry.name, transport: entry.config.kind, tools: serverTools.length, ms: Date.now() - startedAt });
      if (applySwitches) await this.applyToolSwitches();
    } catch (error) {
      if (entry.generation !== generation) return;
      entry.status = "failed";
      entry.error = errorMessage(error).slice(0, 500);
      entry.connection = undefined;
      this.options.log("mcp.server_failed", { server: entry.name, transport: entry.config.kind, error: entry.error });
      await connection?.close();
    }
  }

  /** A copy of the config with `${secret:NAME}` references resolved (connect time only). */
  private async resolveConfig(config: McpServerConfig): Promise<McpServerConfig> {
    const resolve = this.options.resolveSecrets;
    if (!resolve) return config;
    const host = config.kind === "http" ? safeHost(config.url) : undefined;
    const resolveRecord = async (record: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) {
        out[key] = SECRET_REF.test(value) ? await resolve(value, { host }) : value;
      }
      return out;
    };
    return config.kind === "http"
      ? { ...config, headers: await resolveRecord(config.headers) }
      : { ...config, env: await resolveRecord(config.env) };
  }

  private async disconnectEntry(entry: ServerEntry): Promise<void> {
    entry.generation += 1;
    for (const name of entry.toolNames) this.options.tools.unregister(name);
    entry.toolNames = [];
    const connection = entry.connection;
    entry.connection = undefined;
    await connection?.close().catch(() => undefined);
  }

  private async applyToolSwitches(): Promise<void> {
    try {
      for (const name of await loadDisabledTools(this.options.store, this.options.ownerId)) {
        this.options.tools.setEnabled(name, false);
      }
    } catch (error) {
      this.options.log("tools.switches_failed", { error: errorMessage(error) });
    }
  }

  private async loadStoredServers(): Promise<StoredServer[]> {
    const value = await this.options.store.kv.get<unknown>(this.options.ownerId, MCP_SERVERS_KEY);
    if (!Array.isArray(value)) return [];
    return value.filter(isStoredServer);
  }

  private async saveStoredServers(list: StoredServer[]): Promise<void> {
    await this.options.store.kv.set(
      this.options.ownerId,
      MCP_SERVERS_KEY,
      [...list].sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  private async loadDisabledServers(): Promise<string[]> {
    const value = await this.options.store.kv.get<unknown>(this.options.ownerId, MCP_DISABLED_SERVERS_KEY);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  private async renameDisabled(from: string, to: string | undefined): Promise<void> {
    const disabled = new Set(await this.loadDisabledServers());
    if (!disabled.delete(from)) return;
    if (to) disabled.add(to);
    await this.options.store.kv.set(this.options.ownerId, MCP_DISABLED_SERVERS_KEY, [...disabled].sort());
  }
}

function newEntry(name: string, origin: "file" | "ui", config: McpServerConfig, catalogId?: string): ServerEntry {
  return { name, origin, config, catalogId, status: "connecting", toolNames: [], generation: 0 };
}

/** UI-stored server → client config. No ${VAR} expansion: the gateway's env stays private. */
export function toConfig(stored: StoredServer): McpServerConfig {
  if (stored.transport === "http") {
    return { kind: "http", name: stored.name, url: stored.url ?? "", headers: { ...(stored.headers ?? {}) } };
  }
  return {
    kind: "stdio",
    name: stored.name,
    command: stored.command ?? "",
    args: [...(stored.args ?? [])],
    env: { ...(stored.env ?? {}) },
    ...(stored.cwd ? { cwd: stored.cwd } : {})
  };
}

/**
 * Form input → stored server. Null values keep the previous secret; values
 * that equal their own masked form (args, url) keep the previous value too.
 */
export function mergeInput(input: ConnectionServerInput, previous?: StoredServer): StoredServer {
  const keep = (values: Record<string, string | null>, old: Record<string, string> | undefined, label: string) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        const stored = old?.[key];
        if (stored === undefined) throw new Error(`${label} ${key} needs a value.`);
        out[key] = stored;
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  const base = { name: input.name, ...(input.catalogId ? { catalogId: input.catalogId } : {}) };
  const sameTransport = previous?.transport === input.transport ? previous : undefined;
  if (input.transport === "http") {
    let url = input.url;
    if (sameTransport?.url && url === maskUrl(sameTransport.url)) url = sameTransport.url;
    return { ...base, transport: "http", url, headers: keep(input.headers, sameTransport?.headers, "Header") };
  }
  const oldArgs = sameTransport?.args ?? [];
  const args = input.args.map((arg, index) => {
    const old = oldArgs[index];
    return old !== undefined && arg === maskArg(old) && arg !== old ? old : arg;
  });
  return {
    ...base,
    transport: "stdio",
    command: input.command,
    args,
    env: keep(input.env, sameTransport?.env, "Variable"),
    ...(input.cwd ? { cwd: input.cwd } : {})
  };
}

function isStoredServer(value: unknown): value is StoredServer {
  if (typeof value !== "object" || value === null) return false;
  const server = value as Record<string, unknown>;
  if (typeof server.name !== "string" || !SERVER_NAME.test(server.name)) return false;
  if (server.transport === "http") return typeof server.url === "string";
  return server.transport === "stdio" && typeof server.command === "string";
}

// ── masking ──

const MASK = "••••";

/**
 * "••••last4" for long values; short values are fully hidden. Values that use
 * `${secret:NAME}` references (with at most a short literal such as "Bearer ")
 * are shown as-is: a reference is not a secret.
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (SECRET_REF.test(value) && value.replace(new RegExp(SECRET_REF.source, "g"), "").trim().length <= 12) return value;
  return value.length >= 12 ? `${MASK}${value.slice(-4)}` : MASK;
}

export function maskRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, maskSecret(value)]));
}

const SECRET_PARAM = /key|token|secret|pass|auth|sig|credential/i;

/** Hide a URL's password and secret-looking query values. */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  let changed = false;
  if (url.password) {
    url.password = "____";
    changed = true;
  }
  for (const [key] of [...url.searchParams]) {
    if (SECRET_PARAM.test(key)) {
      url.searchParams.set(key, "____");
      changed = true;
    }
  }
  return changed ? url.toString().replace(/____/g, MASK) : raw;
}

/** Args may hold connection strings or tokens: mask URL passwords and --token=… style values. */
export function maskArg(arg: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return maskUrl(arg);
  const flag = /^(--?[A-Za-z0-9_-]*(?:key|token|secret|password|pass)[A-Za-z0-9_-]*=)(.+)$/i.exec(arg);
  if (flag) return `${flag[1]}${maskSecret(flag[2]!)}`;
  return arg;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
