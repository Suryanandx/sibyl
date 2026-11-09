import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { WebSocket } from "ws";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMemoryStore, createToolRegistry, type ToolDefinition } from "@open-gpt-live/core";
import {
  CONNECTIONS_EVENTS,
  parseClientMessage,
  parseConnectionServerInput,
  parseServerMessage,
  type ConnectionCatalogEntry,
  type ConnectionServerInput,
  type ConnectionsServerMessage,
  type ConnectionsStateMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import type { GatewayProviders } from "../gateway.js";
import { createGatewayServer } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import {
  ConnectionsManager,
  MCP_DISABLED_SERVERS_KEY,
  MCP_SERVERS_KEY,
  STDIO_NOT_ALLOWED,
  loadCatalog,
  maskArg,
  maskSecret,
  maskUrl,
  mergeInput,
  type ResolveSecrets
} from "./connections.js";
import type { McpServerConfig } from "./mcp/config.js";
import { DISABLED_TOOLS_KEY } from "./switches.js";
import { handleConnectionsMessage } from "./ws.js";

const OWNER = "owner";

/** One read tool and one write tool per server; `failing` names refuse to connect. */
function harness(
  options: { env?: NodeJS.ProcessEnv; fileServers?: McpServerConfig[]; failing?: Set<string>; resolveSecrets?: ResolveSecrets } = {}
) {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const connects: string[] = [];
  const seen: McpServerConfig[] = [];
  const builtin = (name: string): ToolDefinition => ({
    name,
    title: name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    effect: "read",
    source: "builtin",
    run: async () => ({ content: "ok" })
  });
  tools.register(builtin("weather"));
  tools.register(builtin("calculate"));
  const failing = options.failing ?? new Set<string>();
  const createManager = () =>
    new ConnectionsManager({
      tools,
      store,
      ownerId: OWNER,
      env: options.env ?? {},
      log: () => {},
      fileServers: options.fileServers,
      resolveSecrets: options.resolveSecrets,
      mcp: {
        connectTimeoutMs: 2_000,
        async createTransport(config) {
          connects.push(config.name);
          seen.push(config);
          if (failing.has(config.name)) throw new Error(`cannot reach ${config.name}`);
          const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
          const server = new Server({ name: config.name, version: "1.0.0" }, { capabilities: { tools: {} } });
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
              { name: "search", description: "Search.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              { name: "create", description: "Create.", inputSchema: { type: "object" } }
            ]
          }));
          server.setRequestHandler(CallToolRequestSchema, async (request) => ({
            content: [{ type: "text", text: `${config.name}:${request.params.name}` }]
          }));
          await server.connect(serverSide);
          return clientSide;
        }
      }
    });
  return { store, tools, connects, seen, failing, createManager };
}

type HttpInput = Extract<ConnectionServerInput, { transport: "http" }>;
type StdioInput = Extract<ConnectionServerInput, { transport: "stdio" }>;

const remote = (name: string, token = "secret-token-abcd1234"): HttpInput => ({
  name,
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: `Bearer ${token}` }
});

const local = (name: string): StdioInput => ({
  name,
  transport: "stdio",
  command: "npx",
  args: ["-y", "some-server", "postgresql://app:hunter2-long-password@db:5432/app"],
  env: { API_KEY: "sk-live-0123456789wxyz" }
});

describe("ConnectionsManager", () => {
  test("tool and built-in switches persist and apply immediately", async () => {
    const h = harness();
    const manager = h.createManager();
    await manager.start();
    await manager.setToolEnabled("weather", false);
    assert.equal(h.tools.isEnabled("weather"), false);
    assert.deepEqual(await h.store.kv.get(OWNER, DISABLED_TOOLS_KEY), ["weather"]);

    await manager.setBuiltinEnabled(false);
    assert.equal(h.tools.isEnabled("calculate"), false);
    assert.deepEqual(await h.store.kv.get(OWNER, DISABLED_TOOLS_KEY), ["calculate", "weather"]);
    await manager.setBuiltinEnabled(true);
    assert.equal(h.tools.isEnabled("weather"), true);
    assert.deepEqual(await h.store.kv.get(OWNER, DISABLED_TOOLS_KEY), []);

    await assert.rejects(manager.setToolEnabled("nope", false), /Unknown tool/);
    const state = await manager.state();
    assert.deepEqual(state.builtin.map((tool) => tool.name).sort(), ["calculate", "weather"]);
    await manager.close();
  });

  test("add, edit, remove, reconnect and switch off a remote server", async () => {
    const h = harness();
    const manager = h.createManager();
    await manager.start();

    await manager.saveServer(remote("crm"));
    assert.ok(h.tools.get("mcp_crm_search"));
    assert.equal(h.tools.get("mcp_crm_create")?.effect, "write");
    let state = await manager.state();
    const crm = state.servers.find((server) => server.name === "crm")!;
    assert.equal(crm.status, "connected");
    assert.equal(crm.origin, "ui");
    assert.equal(crm.toolCount, 2);
    assert.equal(crm.headers?.Authorization, "••••1234");
    assert.ok(!JSON.stringify(state).includes("secret-token"));
    const stored = (await h.store.kv.get<Array<Record<string, unknown>>>(OWNER, MCP_SERVERS_KEY))!;
    assert.deepEqual(stored[0]?.headers, { Authorization: "Bearer secret-token-abcd1234" });

    // A disabled tool stays disabled across a reconnect.
    await manager.setToolEnabled("mcp_crm_create", false);
    await manager.reconnect("crm");
    assert.equal(h.connects.filter((name) => name === "crm").length, 2);
    assert.equal(h.tools.isEnabled("mcp_crm_create"), false);
    assert.equal(h.tools.isEnabled("mcp_crm_search"), true);

    // Edit keeps the secret when the form sends null, and renames.
    await manager.saveServer({ ...remote("crm2"), headers: { Authorization: null, "X-Team": "blue" } }, "crm");
    assert.equal(h.tools.get("mcp_crm_search"), undefined);
    assert.ok(h.tools.get("mcp_crm2_search"));
    assert.deepEqual(h.seen.at(-1), {
      kind: "http",
      name: "crm2",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret-token-abcd1234", "X-Team": "blue" }
    });

    // Switch the whole server off and on.
    await manager.setServerEnabled("crm2", false);
    assert.equal(h.tools.get("mcp_crm2_search"), undefined);
    assert.deepEqual(await h.store.kv.get(OWNER, MCP_DISABLED_SERVERS_KEY), ["crm2"]);
    state = await manager.state();
    assert.equal(state.servers[0]?.status, "disabled");
    await assert.rejects(manager.reconnect("crm2"), /switched off/);
    await manager.setServerEnabled("crm2", true);
    assert.ok(h.tools.get("mcp_crm2_search"));

    // A fresh manager (gateway restart) restores servers and switches from kv.
    await manager.setServerEnabled("crm2", false);
    await manager.close();
    const restarted = h.createManager();
    for (const tool of h.tools.list({ source: "mcp" })) h.tools.unregister(tool.name);
    await restarted.start();
    assert.equal((await restarted.state()).servers[0]?.status, "disabled");
    await restarted.setServerEnabled("crm2", true);
    assert.ok(h.tools.get("mcp_crm2_search"));

    await restarted.removeServer("crm2");
    assert.equal(h.tools.get("mcp_crm2_search"), undefined);
    assert.deepEqual(await h.store.kv.get(OWNER, MCP_SERVERS_KEY), []);
    assert.deepEqual(await h.store.kv.get(OWNER, MCP_DISABLED_SERVERS_KEY), []);
    await assert.rejects(restarted.removeServer("crm2"), /Unknown server/);
    await restarted.close();
  });

  test("failed servers report the error; file servers are read-only and win name clashes", async () => {
    const h = harness({
      fileServers: [{ kind: "http", name: "files", url: "https://files.example/mcp", headers: { Authorization: "Bearer file-secret-9876" } }],
      failing: new Set(["broken"])
    });
    const manager = h.createManager();
    await manager.start();
    await manager.saveServer(remote("broken"));
    let state = await manager.state();
    const broken = state.servers.find((server) => server.name === "broken")!;
    assert.equal(broken.status, "failed");
    assert.match(broken.error ?? "", /cannot reach broken/);
    assert.equal(broken.toolCount, 0);

    h.failing.delete("broken");
    await manager.reconnect("broken");
    state = await manager.state();
    assert.equal(state.servers.find((server) => server.name === "broken")?.status, "connected");

    const files = state.servers.find((server) => server.name === "files")!;
    assert.equal(files.origin, "file");
    assert.equal(files.headers?.Authorization, "••••9876");
    await assert.rejects(manager.saveServer(remote("files")), /already exists/);
    await assert.rejects(manager.saveServer(remote("files"), "files"), /mcp.config.json/);
    await assert.rejects(manager.removeServer("files"), /mcp.config.json/);
    await manager.close();
  });

  test("stdio servers from the app need SIBYL_ALLOW_STDIO_MCP=true", async () => {
    const blocked = harness();
    const manager = blocked.createManager();
    await manager.start();
    assert.equal((await manager.state()).allowStdio, false);
    await assert.rejects(manager.saveServer(local("db")), (error: Error) => error.message === STDIO_NOT_ALLOWED);
    assert.equal(await blocked.store.kv.get(OWNER, MCP_SERVERS_KEY), undefined);
    const test = await manager.test({ server: local("db") });
    assert.equal(test.ok, false);
    assert.equal(test.error, STDIO_NOT_ALLOWED);
    assert.equal(blocked.connects.length, 0);
    await manager.close();

    const allowed = harness({ env: { SIBYL_ALLOW_STDIO_MCP: "true" } });
    const open = allowed.createManager();
    await open.start();
    await open.saveServer(local("db"));
    assert.ok(allowed.tools.get("mcp_db_search"));
    const view = (await open.state()).servers[0]!;
    assert.equal(view.env?.API_KEY, "••••wxyz");
    assert.equal(view.args?.[2], "postgresql://app:••••@db:5432/app");
    assert.ok(!JSON.stringify(view).includes("hunter2"));
    // Saving the masked arg back keeps the real one.
    await open.saveServer({ ...local("db"), args: view.args!, env: { API_KEY: null } }, "db");
    const config = allowed.seen.at(-1) as Extract<McpServerConfig, { kind: "stdio" }>;
    assert.equal(config.args[2], "postgresql://app:hunter2-long-password@db:5432/app");
    assert.equal(config.env.API_KEY, "sk-live-0123456789wxyz");
    await open.close();

    // A stored stdio server isn't started once the flag is turned off.
    const later = harness();
    await later.store.kv.set(OWNER, MCP_SERVERS_KEY, [{ name: "db", transport: "stdio", command: "npx", args: [], env: {} }]);
    const off = later.createManager();
    await off.start();
    const db = (await off.state()).servers[0]!;
    assert.equal(db.status, "failed");
    assert.equal(db.error, STDIO_NOT_ALLOWED);
    assert.equal(later.connects.length, 0);
    await off.close();
  });

  test("test() tries a draft or a saved server without keeping it", async () => {
    const h = harness();
    const manager = h.createManager();
    await manager.start();
    const draft = await manager.test({ server: remote("probe") });
    assert.equal(draft.ok, true);
    assert.equal(draft.toolCount, 2);
    assert.deepEqual(draft.tools, ["search", "create"]);
    assert.equal(h.tools.get("mcp_probe_search"), undefined);

    await manager.saveServer(remote("crm"));
    const saved = await manager.test({ name: "crm" });
    assert.equal(saved.ok, true);
    const edit = await manager.test({ server: { ...remote("crm"), headers: { Authorization: null } }, original: "crm" });
    assert.equal(edit.ok, true);
    assert.equal((h.seen.at(-1) as { headers: Record<string, string> }).headers.Authorization, "Bearer secret-token-abcd1234");
    const missing = await manager.test({ server: { ...remote("new"), headers: { Authorization: null } } });
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /needs a value/);
    await manager.close();
  });

  test("${secret:NAME} references are stored as-is, shown unmasked and resolved only at connect time", async () => {
    const calls: Array<{ value: string; host?: string }> = [];
    const h = harness({
      env: { SIBYL_ALLOW_STDIO_MCP: "true" },
      resolveSecrets: async (value, ctx) => {
        calls.push({ value, host: ctx.host });
        if (value.includes("MISSING")) throw new Error("Secret MISSING is not set");
        return value.replace(/\$\{secret:([A-Za-z0-9_.-]+)\}/g, (_m, name: string) => `resolved-${name}`);
      }
    });
    const manager = h.createManager();
    await manager.start();
    await manager.saveServer({ ...remote("crm"), headers: { Authorization: "Bearer ${secret:CRM_TOKEN}", "X-Plain": "x" } });
    await manager.saveServer({ ...local("db"), env: { API_KEY: "${secret:DB_KEY}", LITERAL: "sk-live-0123456789wxyz" } });

    const stored = (await h.store.kv.get<Array<Record<string, any>>>(OWNER, MCP_SERVERS_KEY))!;
    assert.equal(stored.find((s) => s.name === "crm")?.headers.Authorization, "Bearer ${secret:CRM_TOKEN}");
    const state = await manager.state();
    const crm = state.servers.find((s) => s.name === "crm")!;
    const db = state.servers.find((s) => s.name === "db")!;
    assert.equal(crm.headers?.Authorization, "Bearer ${secret:CRM_TOKEN}");
    assert.equal(db.env?.API_KEY, "${secret:DB_KEY}");
    assert.equal(db.env?.LITERAL, "••••wxyz");

    const httpConfig = h.seen.find((c) => c.name === "crm") as Extract<McpServerConfig, { kind: "http" }>;
    assert.equal(httpConfig.headers.Authorization, "Bearer resolved-CRM_TOKEN");
    assert.equal(httpConfig.headers["X-Plain"], "x");
    const stdioConfig = h.seen.find((c) => c.name === "db") as Extract<McpServerConfig, { kind: "stdio" }>;
    assert.equal(stdioConfig.env.API_KEY, "resolved-DB_KEY");
    assert.deepEqual(calls, [
      { value: "Bearer ${secret:CRM_TOKEN}", host: "mcp.example.com" },
      { value: "${secret:DB_KEY}", host: undefined }
    ]);

    await manager.saveServer({ ...remote("bad"), headers: { Authorization: "Bearer ${secret:MISSING}" } });
    const bad = (await manager.state()).servers.find((s) => s.name === "bad")!;
    assert.equal(bad.status, "failed");
    assert.match(bad.error ?? "", /MISSING is not set/);
    const test = await manager.test({ name: "bad" });
    assert.equal(test.ok, false);
    await manager.close();

    // Without a hook, references pass through unchanged.
    const plain = harness();
    const unresolved = plain.createManager();
    await unresolved.start();
    await unresolved.saveServer({ ...remote("crm"), headers: { Authorization: "Bearer ${secret:CRM_TOKEN}" } });
    assert.equal((plain.seen.at(-1) as { headers: Record<string, string> }).headers.Authorization, "Bearer ${secret:CRM_TOKEN}");
    await unresolved.close();
  });
});

describe("masking", () => {
  test("secrets, URLs and args", () => {
    assert.equal(maskSecret(""), "");
    assert.equal(maskSecret("short"), "••••");
    assert.equal(maskSecret("ghp_abcdefghijklmnop"), "••••mnop");
    assert.equal(maskUrl("https://x.example/mcp?api_key=abc&q=1"), "https://x.example/mcp?api_key=••••&q=1");
    assert.equal(maskUrl("https://x.example/mcp"), "https://x.example/mcp");
    assert.equal(maskArg("--token=abcdefghijklmnop"), "--token=••••mnop");
    assert.equal(maskArg("/srv/files"), "/srv/files");
    assert.equal(maskArg("postgresql://localhost/mydb"), "postgresql://localhost/mydb");
    const merged = mergeInput(
      { name: "x", transport: "http", url: "https://x.example/mcp?api_key=••••", headers: {} },
      { name: "x", transport: "http", url: "https://x.example/mcp?api_key=real", headers: {} }
    );
    assert.equal(merged.url, "https://x.example/mcp?api_key=real");
  });
});

describe("catalog", () => {
  test("every entry is valid and prefills a valid server", () => {
    const entries: ConnectionCatalogEntry[] = loadCatalog();
    assert.ok(entries.length >= 9);
    const ids = new Set<string>();
    for (const entry of entries) {
      assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`);
      ids.add(entry.id);
      assert.match(entry.id, /^[a-z0-9-]{1,64}$/);
      assert.match(entry.docsUrl, /^https:\/\//);
      assert.ok(entry.title && entry.description && entry.maintainer && entry.category);
      assert.ok(["official", "archived", "community"].includes(entry.status));
      const input =
        entry.transport === "http"
          ? {
              name: entry.name,
              transport: "http",
              url: entry.url,
              headers: Object.fromEntries((entry.headers ?? []).map((field) => [field.key, `${field.valuePrefix ?? ""}value`])),
              catalogId: entry.id
            }
          : {
              name: entry.name,
              transport: "stdio",
              command: entry.command,
              args: entry.args ?? [],
              env: Object.fromEntries((entry.env ?? []).map((field) => [field.key, "value"])),
              catalogId: entry.id
            };
      const parsed = parseConnectionServerInput(input);
      assert.notEqual(typeof parsed, "string", `${entry.id}: ${String(parsed)}`);
    }
  });
});

describe("Connections protocol and WebSocket", () => {
  test("strict client parsing", () => {
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.REQUEST }).success, true);
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.TOOL_TOGGLE, name: "weather", enabled: "no" }).success, false);
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.TOOL_TOGGLE, name: "bad name!", enabled: true }).success, false);
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.SERVER_TOGGLE, scope: "server", enabled: true }).success, false);
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.SERVER_TOGGLE, scope: "builtin", enabled: false }).success, true);
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.SERVER_SAVE, server: remote("crm") }).success, false);
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.SERVER_SAVE, requestId: "r", server: remote("crm") }).success, true);
    assert.equal(
      parseClientMessage({ type: CONNECTIONS_EVENTS.SERVER_SAVE, requestId: "r", server: { ...remote("crm"), url: "file:///etc/passwd" } }).success,
      false
    );
    assert.equal(
      parseClientMessage({ type: CONNECTIONS_EVENTS.SERVER_SAVE, requestId: "r", server: { ...local("db"), env: { "BAD KEY": "x" } } }).success,
      false
    );
    assert.equal(parseClientMessage({ type: CONNECTIONS_EVENTS.SERVER_TEST, requestId: "r" }).success, false);
    assert.equal(parseServerMessage({ type: CONNECTIONS_EVENTS.STATE, builtin: [], servers: [], catalog: [] }).success, false);
    assert.equal(parseServerMessage({ type: CONNECTIONS_EVENTS.STATE, builtin: [], servers: [], catalog: [], allowStdio: false }).success, true);
  });

  test("handler replies with results and state", async () => {
    const h = harness();
    const manager = h.createManager();
    await manager.start();
    const runtime = createTestRuntime({ tools: h.tools, store: h.store, ownerId: OWNER, connections: manager });
    const sent: Array<ConnectionsServerMessage | { type: "error"; message: string }> = [];
    const context = { runtime, send: (message: (typeof sent)[number]) => sent.push(message) };

    await handleConnectionsMessage({ type: CONNECTIONS_EVENTS.SERVER_SAVE, requestId: "r1", server: remote("crm") }, context);
    assert.deepEqual(sent[0], { type: CONNECTIONS_EVENTS.RESULT, requestId: "r1", ok: true });
    assert.equal((sent[1] as ConnectionsStateMessage).servers[0]?.status, "connected");

    await handleConnectionsMessage({ type: CONNECTIONS_EVENTS.SERVER_REMOVE, requestId: "r2", name: "ghost" }, context);
    assert.deepEqual(sent[2], { type: CONNECTIONS_EVENTS.RESULT, requestId: "r2", ok: false, error: "Unknown server: ghost" });

    await handleConnectionsMessage({ type: CONNECTIONS_EVENTS.SERVER_TEST, requestId: "r3", name: "crm" }, context);
    const result = sent.find((message) => message.type === CONNECTIONS_EVENTS.TEST_RESULT);
    assert.equal(result && "ok" in result && result.ok, true);
    for (const message of sent) assert.equal(parseServerMessage(message).success, true, JSON.stringify(message));
    await manager.close();
  });

  test("gateway dispatches connections messages over the socket", async () => {
    const providers: GatewayProviders = {
      llm: { async *streamText() {} },
      stt: { async transcribe() { return { text: "" }; } }
    };
    const gateway = await createGatewayServer({ providers, host: "127.0.0.1" });
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    try {
      const state = await new Promise<ServerMessage>((resolve, reject) => {
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as ServerMessage;
          if (message.type === CONNECTIONS_EVENTS.STATE || message.type === "error") resolve(message);
        });
        socket.once("error", reject);
        socket.once("open", () => socket.send(JSON.stringify({ type: CONNECTIONS_EVENTS.REQUEST })));
        setTimeout(() => reject(new Error("timeout")), 3_000);
      });
      assert.equal(state.type, CONNECTIONS_EVENTS.STATE);
      assert.equal(parseServerMessage(state).success, true);
      assert.ok((state as ConnectionsStateMessage).catalog.length > 0);
    } finally {
      socket.close();
      await gateway.close();
    }
  });
});
