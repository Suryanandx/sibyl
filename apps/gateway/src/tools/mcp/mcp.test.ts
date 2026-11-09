import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMemoryStore, createToolRegistry } from "@open-gpt-live/core";
import { createNoopMeter } from "../../runtime.js";
import { testContext } from "../builtin/test-helpers.js";
import { installSibylTools } from "../index.js";
import { setToolEnabled } from "../switches.js";
import { connectMcpServers, convertCallResult, mcpToolName } from "./client.js";
import { parseMcpConfig, type McpServerConfig } from "./config.js";

/** A tiny MCP server: one read-only tool, one write tool, one tool that hangs. */
function createTestServer(state: { notes: string[] }): Server {
  const server = new Server({ name: "test-notes", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_notes",
        description: "List all notes.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true }
      },
      {
        name: "add.note",
        title: "Add a note",
        description: "Add a note.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
      },
      { name: "slow", description: "Never finishes.", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }
    ]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (request.params.name) {
      case "list_notes":
        return {
          content: [
            { type: "text", text: state.notes.length ? state.notes.join("\n") : "(no notes)" },
            { type: "image", data: "aGk=", mimeType: "image/png" }
          ],
          structuredContent: { notes: state.notes }
        };
      case "add.note":
        if (typeof args.text !== "string" || !args.text) return { content: [{ type: "text", text: "text is required" }], isError: true };
        state.notes.push(args.text);
        return { content: [{ type: "text", text: `Added note #${state.notes.length}` }] };
      case "slow":
        await new Promise((resolve) => extra.signal.addEventListener("abort", resolve));
        return { content: [{ type: "text", text: "late" }] };
      default:
        throw new Error(`unknown tool ${request.params.name}`);
    }
  });
  return server;
}

function inMemoryFactory(state: { notes: string[] }, counter = { connects: 0 }) {
  return {
    counter,
    servers: [] as Server[],
    async createTransport(_config: McpServerConfig) {
      counter.connects += 1;
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const server = createTestServer(state);
      this.servers.push(server);
      await server.connect(serverSide);
      return clientSide;
    }
  };
}

const notesConfig: McpServerConfig = { kind: "stdio", name: "notes", command: "unused", args: [], env: {} };

describe("MCP adapter", () => {
  test("registers tools with names, effects and results", async () => {
    const state = { notes: [] as string[] };
    const factory = inMemoryFactory(state);
    const logs: string[] = [];
    const set = await connectMcpServers([notesConfig], {
      log: (event) => void logs.push(event),
      createTransport: (config) => factory.createTransport(config)
    });
    try {
      const byName = new Map(set.tools.map((tool) => [tool.name, tool]));
      assert.deepEqual([...byName.keys()], ["mcp_notes_list_notes", "mcp_notes_add_note", "mcp_notes_slow"]);
      const list = byName.get("mcp_notes_list_notes")!;
      const add = byName.get("mcp_notes_add_note")!;
      assert.equal(list.effect, "read");
      assert.equal(add.effect, "write");
      assert.equal(byName.get("mcp_notes_slow")!.effect, "write");
      assert.equal(add.source, "mcp");
      assert.equal(add.provider, "notes");
      assert.equal(add.title, "Add a note");
      assert.equal(add.description, "Add a note.");
      assert.deepEqual(add.inputSchema, { type: "object", properties: { text: { type: "string" } }, required: ["text"] });
      assert.ok(logs.includes("mcp.connected"));

      const added = await add.run({ text: "buy milk" }, testContext());
      assert.equal(added.content, "Added note #1");
      assert.ok(!added.isError);
      const listed = await list.run({}, testContext());
      assert.equal(listed.content, "buy milk\n\n[image: image/png omitted]");
      assert.deepEqual(listed.data, { notes: ["buy milk"] });
      const failed = await add.run({}, testContext());
      assert.equal(failed.isError, true);
      assert.equal(failed.content, "text is required");
    } finally {
      await set.close();
    }
  });

  test("honors the AbortSignal", async () => {
    const factory = inMemoryFactory({ notes: [] });
    const set = await connectMcpServers([notesConfig], { log: () => {}, createTransport: (c) => factory.createTransport(c) });
    try {
      const controller = new AbortController();
      const slow = set.tools.find((tool) => tool.name === "mcp_notes_slow")!;
      const pending = slow.run({}, testContext({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 20);
      const result = await pending;
      assert.equal(result.isError, true);
      assert.match(result.content, /cancelled/);
    } finally {
      await set.close();
    }
  });

  test("reconnects lazily after the transport closes", async () => {
    const state = { notes: ["a"] };
    const factory = inMemoryFactory(state);
    const set = await connectMcpServers([notesConfig], { log: () => {}, createTransport: (c) => factory.createTransport(c) });
    try {
      assert.equal(factory.counter.connects, 1);
      await factory.servers[0]!.close(); // server side drops the connection
      await new Promise((resolve) => setTimeout(resolve, 10));
      const list = set.tools.find((tool) => tool.name === "mcp_notes_list_notes")!;
      const result = await list.run({}, testContext());
      assert.ok(!result.isError, result.content);
      assert.match(result.content, /^a/);
      assert.equal(factory.counter.connects, 2);
    } finally {
      await set.close();
    }
  });

  test("a failing server is skipped, others still load", async () => {
    const factory = inMemoryFactory({ notes: [] });
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const set = await connectMcpServers(
      [{ ...notesConfig, name: "broken" }, notesConfig],
      {
        log: (event, fields) => void logs.push([event, fields]),
        createTransport: (config) => {
          if (config.name === "broken") throw new Error("spawn npx ENOENT");
          return factory.createTransport(config);
        }
      }
    );
    try {
      assert.equal(set.tools.length, 3);
      const failure = logs.find(([event]) => event === "mcp.server_failed");
      assert.equal(failure?.[1]?.server, "broken");
      assert.match(String(failure?.[1]?.error), /ENOENT/);
    } finally {
      await set.close();
    }
  });

  test("connect timeout", async () => {
    const set = await connectMcpServers([notesConfig], {
      log: () => {},
      connectTimeoutMs: 50,
      createTransport: () => {
        const [clientSide] = InMemoryTransport.createLinkedPair(); // nobody answers
        return clientSide;
      }
    });
    assert.equal(set.tools.length, 0);
    await set.close();
  });
});

describe("MCP helpers", () => {
  test("tool names are sanitized, capped at 64 and unique", () => {
    const taken = new Set<string>();
    assert.equal(mcpToolName("github", "create issue/v2", taken), "mcp_github_create_issue_v2");
    const long = mcpToolName("server", "x".repeat(100), taken);
    assert.equal(long.length, 64);
    assert.match(long, /^[a-zA-Z0-9_-]{1,64}$/);
    const again = mcpToolName("github", "create issue/v2", taken);
    assert.notEqual(again, "mcp_github_create_issue_v2");
    assert.match(again, /^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("content conversion", () => {
    const result = convertCallResult({
      content: [
        { type: "text", text: "hello" },
        { type: "audio", data: "x", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "file body" } },
        { type: "resource", resource: { uri: "file:///b.bin", blob: "AAA", mimeType: "application/octet-stream" } },
        { type: "resource_link", uri: "file:///c", name: "c" }
      ]
    });
    assert.equal(
      result.content,
      "hello\n\n[audio: audio/wav omitted]\n\nfile body\n\n[resource file:///b.bin (application/octet-stream) omitted]\n\n[resource: c file:///c]"
    );
    assert.equal(convertCallResult({ content: [], isError: true }).content, "The tool reported an error.");
    assert.equal(convertCallResult({ content: [], structuredContent: { a: 1 } }).content, '{"a":1}');
  });

  test("config parsing", () => {
    const servers = parseMcpConfig(
      JSON.stringify({
        _comment: "ignored",
        mcpServers: {
          files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "${HOME_DIR}/docs"], env: { TOKEN: "${SECRET}" } },
          remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${SECRET}" } },
          off: { url: "https://x.example.com", disabled: true },
          _note: "also ignored"
        }
      }),
      { HOME_DIR: "/home/me", SECRET: "s3" }
    );
    assert.deepEqual(servers, [
      { kind: "stdio", name: "files", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/docs"], env: { TOKEN: "s3" }, cwd: undefined, timeoutMs: undefined },
      { kind: "http", name: "remote", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer s3" }, timeoutMs: undefined }
    ]);
    assert.throws(() => parseMcpConfig(JSON.stringify({ servers: { x: { foo: 1 } } })), /needs either/);
    assert.throws(() => parseMcpConfig(JSON.stringify({ servers: { "bad name": { url: "https://a.b" } } })), /name must match/);
    assert.throws(() => parseMcpConfig("{nope"), /not valid JSON/);
  });
});

describe("installSibylTools", () => {
  test("built-ins, MCP from config, persisted switches, close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sibyl-mcp-"));
    writeFileSync(join(dir, "mcp.config.json"), JSON.stringify({ servers: { notes: { command: "unused" } } }));
    const store = createMemoryStore();
    const registry = createToolRegistry();
    const factory = inMemoryFactory({ notes: [] });
    await setToolEnabled(registry, store, "owner", "weather", false);
    await setToolEnabled(registry, store, "owner", "mcp_notes_add_note", false);
    assert.deepEqual(await store.kv.get("owner", "tools.disabled"), ["mcp_notes_add_note", "weather"]);

    const fresh = createToolRegistry();
    const installed = await installSibylTools({
      tools: fresh,
      store,
      meter: createNoopMeter(),
      ownerId: "owner",
      env: { OPENROUTER_API_KEY: "sk-test" },
      cwd: dir,
      log: () => {},
      mcp: { createTransport: (config) => factory.createTransport(config) }
    });
    try {
      const names = fresh.list().map((tool) => tool.name);
      assert.ok(names.includes("web_search"));
      assert.ok(names.includes("calculate"));
      assert.ok(names.includes("mcp_notes_list_notes"));
      assert.equal(fresh.isEnabled("weather"), false);
      assert.equal(fresh.isEnabled("mcp_notes_add_note"), false);
      assert.equal(fresh.isEnabled("mcp_notes_list_notes"), true);
      assert.ok(!fresh.list({ enabledOnly: true }).some((tool) => tool.name === "weather"));
    } finally {
      await installed.close();
    }

    const bare = createToolRegistry();
    const none = await installSibylTools({
      tools: bare,
      store: createMemoryStore(),
      meter: createNoopMeter(),
      ownerId: "owner",
      env: { SIBYL_BUILTIN_TOOLS: "false" },
      cwd: mkdtempSync(join(tmpdir(), "sibyl-empty-")),
      log: () => {}
    });
    assert.equal(bare.list().length, 0);
    await none.close();
  });
});
