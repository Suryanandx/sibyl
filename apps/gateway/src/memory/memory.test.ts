import assert from "node:assert/strict";
import type { LLMMessage, LLMProvider, STTProvider, ToolChatProvider } from "@open-gpt-live/adapters";
import { createMemoryStore, createToolRegistry, type Principal, type ToolContext } from "@open-gpt-live/core";
import { WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayServerOptions } from "../gateway.js";
import { createNoopMeter, createTestRuntime } from "../runtime.js";
import {
  MAX_MEMORIES,
  MAX_MEMORY_CHARS,
  MEMORY_PROMPT_CHARS,
  MemoryService,
  createMemoryTools,
  formatMemoryBlock,
  looksSecret,
  memoryKeys,
  withUserMemory
} from "./index.js";

const owner = "owner";

function context(store = createMemoryStore()): ToolContext {
  return {
    signal: new AbortController().signal,
    ownerId: owner,
    runId: "run-1",
    store,
    meter: createNoopMeter(),
    log() {}
  };
}

describe("secret detection", () => {
  test.each([
    "my password is hunter2",
    "Password: correcthorse",
    "API key sk-or-v1-0123456789abcdef0123",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "AKIAIOSFODNN7EXAMPLE is the access key",
    "my card is 4111 1111 1111 1111",
    "4242-4242-4242-4242",
    "SSN 123-45-6789",
    "-----BEGIN RSA PRIVATE KEY-----",
    "pin is 4512",
    "here is a bearer token for you",
    "secret: aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gH3"
  ])("refuses %s", (text) => {
    expect(looksSecret(text)).toBe(true);
  });

  test.each([
    "I prefer metric units",
    "My company is Acme Corp",
    "I was born in 1987 and live in Berlin",
    "My phone number is 555 0100",
    "I pin important notes to the top",
    "The mountain pass is beautiful in May",
    "Order number 12345678 shipped"
  ])("allows %s", (text) => {
    expect(looksSecret(text)).toBe(false);
  });
});

describe("MemoryService", () => {
  test("adds, dedupes, updates, pins, forgets and orders pinned first", async () => {
    let clock = 1;
    const memory = new MemoryService({ store: createMemoryStore(), ownerId: owner, env: {}, now: () => clock++ });
    const metric = await memory.add("I prefer metric units");
    await memory.add("My company is Acme");
    await memory.add("  i prefer   METRIC units ");
    expect((await memory.list()).length).toBe(2);
    await memory.update(metric.id, { pinned: true });
    await memory.add("Works as a designer");
    const list = await memory.list();
    expect(list[0]!.text).toBe("I prefer metric units");
    expect(list[1]!.text).toBe("Works as a designer");
    const removed = await memory.forget("acme");
    expect(removed.map((item) => item.text)).toEqual(["My company is Acme"]);
    expect(await memory.remove(metric.id)).toBe(true);
    expect((await memory.list()).map((item) => item.text)).toEqual(["Works as a designer"]);
  });

  test("refuses secrets, empty and over-long facts, and enforces the item cap", async () => {
    const memory = new MemoryService({ store: createMemoryStore(), ownerId: owner, env: {} });
    await expect(memory.add("my password is hunter2")).rejects.toMatchObject({ code: "secret" });
    await expect(memory.add("   ")).rejects.toMatchObject({ code: "empty" });
    await expect(memory.add("x".repeat(MAX_MEMORY_CHARS + 1))).rejects.toMatchObject({ code: "too_long" });
    await Promise.all(Array.from({ length: MAX_MEMORIES }, (_, index) => memory.add(`Fact number ${index}`)));
    expect((await memory.list()).length).toBe(MAX_MEMORIES);
    await expect(memory.add("One more fact")).rejects.toMatchObject({ code: "full" });
  });

  test("prompt block is capped, pinned/recent first, and empty when off", async () => {
    let clock = 1;
    const store = createMemoryStore();
    const memory = new MemoryService({ store, ownerId: owner, env: {}, now: () => clock++ });
    for (let index = 0; index < 40; index += 1) await memory.add(`User fact ${index} ${"lorem ".repeat(8)}`);
    const pinned = await memory.add("Pinned: likes tea");
    await memory.update(pinned.id, { pinned: true });
    clock += 10;
    const block = await memory.promptBlock();
    expect(block.length).toBeLessThanOrEqual(MEMORY_PROMPT_CHARS);
    expect(block).toContain("What you know about the user");
    const lines = block.split("\n").filter((line) => line.startsWith("- "));
    expect(lines[0]).toBe("- Pinned: likes tea");
    expect(lines[1]).toContain("User fact 39");
    expect(block).not.toContain("User fact 0 ");

    await memory.setEnabled(false);
    expect(await memory.promptBlock()).toBe("");
    await memory.setEnabled(true);
    const disabled = new MemoryService({ store, ownerId: owner, env: { SIBYL_MEMORY: "false" } });
    expect(await disabled.promptBlock()).toBe("");
    expect(await withUserMemory("BASE", { store, ownerId: owner, env: { SIBYL_MEMORY: "off" } })).toBe("BASE");
    expect(await withUserMemory("BASE", { store, ownerId: owner, env: {} })).toMatch(/^BASE\n\n## What you know about the user/);
    expect(formatMemoryBlock([])).toBe("");
  });

  test("facts are personal and per workspace; the switch is per workspace", async () => {
    const store = createMemoryStore();
    const person = (userId: string): Principal => ({ kind: "user", orgId: owner, userId, workspaceRoles: { default: "member", team: "member" } });
    const ada = new MemoryService({ store, ownerId: owner, env: {}, principal: person("ada") });
    const bob = new MemoryService({ store, ownerId: owner, env: {}, principal: person("bob") });
    const adaTeam = new MemoryService({ store, ownerId: owner, env: {}, principal: person("ada"), workspaceId: "team" });
    const ownerDefault = new MemoryService({ store, ownerId: owner, env: {} });
    await ada.add("Ada likes tea");
    await ownerDefault.add("Owner likes coffee");
    expect((await ada.list()).map((item) => item.text)).toEqual(["Ada likes tea"]);
    expect(await bob.list()).toEqual([]);
    expect(await adaTeam.list()).toEqual([]);
    // The owner token / local mode keep the original key (memory from before workspaces).
    expect(memoryKeys()).toEqual({ items: "memory.items", enabled: "memory.enabled" });
    expect(memoryKeys({ principal: person("ada"), workspaceId: "team" })).toEqual({ items: "memory.items:team:user:ada", enabled: "memory.enabled:team" });
    expect((await store.kv.get<Array<{ text: string }>>(owner, "memory.items"))?.map((item) => item.text)).toEqual(["Owner likes coffee"]);
    await adaTeam.setEnabled(false);
    expect(await adaTeam.enabled()).toBe(false);
    expect(await ada.enabled()).toBe(true);
    expect(await withUserMemory("BASE", { store, ownerId: owner, env: {}, principal: person("bob") })).toBe("BASE");
  });
});

describe("memory tools", () => {
  test("remember / recall / forget, with secret refusal", async () => {
    const ctx = context();
    const [remember, forget, recall] = createMemoryTools({});
    expect([remember!.name, forget!.name, recall!.name]).toEqual(["remember", "forget", "recall"]);
    expect([remember!.effect, forget!.effect, recall!.effect]).toEqual(["read", "read", "read"]);

    const saved = await remember!.run({ fact: "Prefers metric units" }, ctx);
    expect(saved.isError).toBeUndefined();
    expect(saved.content).toBe("Saved to memory: Prefers metric units");

    const secret = await remember!.run({ fact: "My API key is sk-abcdefghijklmnopqrstuvwx" }, ctx);
    expect(secret.isError).toBe(true);
    expect(secret.content).toMatch(/never stores secrets/);

    const listed = await recall!.run({}, ctx);
    expect(listed.content).toMatch(/Prefers metric units/);
    expect(listed.content).not.toMatch(/sk-/);

    const gone = await forget!.run({ query: "metric" }, ctx);
    expect(gone.content).toMatch(/Forgot 1 fact/);
    expect((await recall!.run({}, ctx)).content).toBe("Memory is empty.");
  });

  test("remember refuses when the user turned memory off", async () => {
    const ctx = context();
    await new MemoryService({ store: ctx.store, ownerId: owner, env: {} }).setEnabled(false);
    const [remember] = createMemoryTools({});
    const result = await remember!.run({ fact: "Likes jazz" }, ctx);
    expect(result.isError).toBe(true);
    expect(await new MemoryService({ store: ctx.store, ownerId: owner, env: {} }).list()).toEqual([]);
  });
});

// ── HTTP API ──

async function withHttp(
  run: (base: string, store: ReturnType<typeof createMemoryStore>) => Promise<void>,
  extra: Partial<GatewayServerOptions> = {}
): Promise<void> {
  const runtime = createTestRuntime();
  const gateway = await createGatewayServer({
    providers: { llm: { async *streamText() {} }, stt: { async transcribe() { return { text: "" }; } } },
    host: "127.0.0.1",
    env: {},
    ...extra,
    runtime
  });
  try {
    await run(`http://127.0.0.1:${gateway.port}`, runtime.store as ReturnType<typeof createMemoryStore>);
  } finally {
    await gateway.close();
  }
}

test("memory HTTP API: auth, CRUD, secret refusal and the switch", async () => {
  await withHttp(
    async (base) => {
      expect((await fetch(`${base}/api/memory`)).status).toBe(401);
      const auth = { Authorization: "Bearer s3cret", "Content-Type": "application/json" };
      const added = await fetch(`${base}/api/memory`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Lives in Lisbon" }) });
      expect(added.status).toBe(201);
      const { item } = (await added.json()) as { item: { id: string } };

      const refused = await fetch(`${base}/api/memory`, { method: "POST", headers: auth, body: JSON.stringify({ text: "password: abc123" }) });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe("secret");

      const edited = await fetch(`${base}/api/memory/${item.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ text: "Lives in Porto", pinned: true }) });
      expect(edited.status).toBe(200);

      const off = await fetch(`${base}/api/memory/settings`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: false }) });
      expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);

      const state = (await (await fetch(`${base}/api/memory`, { headers: auth })).json()) as {
        available: boolean;
        enabled: boolean;
        items: Array<{ text: string; pinned?: boolean }>;
      };
      expect(state).toMatchObject({ available: true, enabled: false, items: [{ text: "Lives in Porto", pinned: true }] });

      expect((await fetch(`${base}/api/memory/${item.id}`, { method: "DELETE", headers: auth })).status).toBe(200);
      expect((await fetch(`${base}/api/memory/${item.id}`, { method: "DELETE", headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/api/memory/..%2F..`, { method: "DELETE", headers: auth })).status).toBe(404);
    },
    { ownerToken: "s3cret" }
  );
});

test("memory HTTP API reports when SIBYL_MEMORY=false", async () => {
  await withHttp(
    async (base) => {
      const state = (await (await fetch(`${base}/api/memory`)).json()) as { available: boolean };
      expect(state.available).toBe(false);
      const add = await fetch(`${base}/api/memory`, { method: "POST", body: JSON.stringify({ text: "x" }) });
      expect(add.status).toBe(409);
    },
    { env: { SIBYL_MEMORY: "false" } }
  );
});

// ── Injection into every brain's system prompt ──

const catalog: ModelCatalog = {
  voice: [{ id: "voice/fast", label: "Fast voice" }],
  llm: [{ id: "brain/deep", label: "Deep" }],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [{ id: "tts/plain", label: "Plain", voices: ["a"] }]
};

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise((resolve) => socket.once("open", resolve));
  const waitFor = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
    for (let i = 0; i < 300; i += 1) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  return { socket, messages, waitFor, send: (m: unknown) => socket.send(JSON.stringify(m)) };
}

test("the memory block reaches typed chat, the voice brain and the deep brain", async () => {
  const calls: Array<{ model?: string; messages: LLMMessage[] }> = [];
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      calls.push({ model: options?.model, messages: structuredClone(messages) });
      const reply = options?.model === "voice/fast" ? "On it.\n@brain Plan a trip" : "Done.";
      yield { delta: reply };
    }
  };
  const stt: STTProvider = { async transcribe() { return { text: "plan a trip" }; } };
  const toolCalls: Array<{ messages: unknown[] }> = [];
  const toolLlm: ToolChatProvider = {
    async *streamWithTools(messages) {
      toolCalls.push({ messages: structuredClone(messages) });
      yield { type: "text", delta: "Tool-capable answer." };
    }
  };
  const runtime = createTestRuntime({ tools: createToolRegistry() });
  for (const tool of createMemoryTools({})) runtime.tools.register(tool);
  await new MemoryService({ store: runtime.store, ownerId: runtime.ownerId, env: {} }).add("Prefers metric units");

  const gateway = await createGatewayServer({
    providers: { llm, stt, toolLlm },
    host: "127.0.0.1",
    modelCatalog: catalog,
    env: {},
    live: { voicePrompt: "VOICE PROMPT", brainPrompt: () => "BRAIN" },
    runtime
  });
  const client = await connect(gateway.port);
  try {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    // Typed chat (tool loop, since tools are registered).
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t1", text: "how tall is Everest?" });
    await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "t1");
    const typedSystem = String((toolCalls[0]!.messages[0] as { content: string }).content);
    assert.match(typedSystem, /What you know about the user\n.*\n- Prefers metric units/);
    assert.match(typedSystem, /## Tools/);

    // Spoken turn → voice brain → deep brain.
    client.send({ type: WS_EVENTS.VAD_SPEECH_START, requestId: "v1", turnMode: "live", startedAt: 1 });
    client.send({ type: WS_EVENTS.AUDIO_CHUNK, requestId: "v1", chunk: Buffer.alloc(4800).toString("base64"), mimeType: "audio/pcm;rate=24000", sequence: 0, turnMode: "live" });
    client.send({ type: WS_EVENTS.VAD_SPEECH_END, requestId: "v1", endedAt: 2, reason: "silence", caption: "plan a trip" });
    await client.waitFor((m) => m.type === WS_EVENTS.BRAIN_DONE);
    const voice = calls.find((call) => call.model === "voice/fast")!;
    assert.match(String(voice.messages[0]!.content), /^VOICE PROMPT\n\n## What you know about the user[\s\S]*Prefers metric units/);
    const brainSystem = String((toolCalls[1]!.messages[0] as { content: string }).content);
    assert.match(brainSystem, /^BRAIN\n\n## What you know about the user[\s\S]*Prefers metric units/);
  } finally {
    client.socket.close();
    await gateway.close();
  }
});

test("SIBYL_MEMORY=false keeps prompts unchanged", async () => {
  const calls: LLMMessage[][] = [];
  const llm: LLMProvider = {
    async *streamText(messages) {
      calls.push(structuredClone(messages));
      yield { delta: "ok" };
    }
  };
  const runtime = createTestRuntime();
  await new MemoryService({ store: runtime.store, ownerId: runtime.ownerId, env: {} }).add("Prefers metric units");
  const gateway = await createGatewayServer({
    providers: { llm, stt: { async transcribe() { return { text: "" }; } } },
    host: "127.0.0.1",
    systemPrompt: "SYSTEM",
    env: { SIBYL_MEMORY: "false" },
    runtime
  });
  const client = await connect(gateway.port);
  try {
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t1", text: "hi" });
    await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE);
    assert.equal(calls[0]![0]!.content, "SYSTEM");
  } finally {
    client.socket.close();
    await gateway.close();
  }
});
