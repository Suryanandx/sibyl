/**
 * End to end over a real WebSocket: the assistant asks for a key in the
 * secure box, the user saves it, the assistant uses it through api_request,
 * and the value never shows up in anything but the outbound HTTP request.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { ChatToolCall, LLMProvider, STTProvider, ToolChatMessage, ToolChatProvider } from "@open-gpt-live/adapters";
import { createMemoryStore, createToolRegistry, type ToolDefinition } from "@open-gpt-live/core";
import { SECRET_EVENTS, WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayLogger } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import { installSecrets } from "./index.js";

const VALUE = "hf_live_e2e_Q7w8E9r0T1y2U3i4O5p6";
const catalog: ModelCatalog = {
  voice: [{ id: "voice/fast", label: "Fast voice" }],
  llm: [{ id: "brain/deep", label: "Deep" }],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [{ id: "tts/plain", label: "Plain", voices: ["a"] }]
};

type Round = { text?: string; calls?: ChatToolCall[] };
const stt: STTProvider = { transcribe: async () => ({ text: "" }) };

test("request_secret → secure box → api_request: the value never reaches the model, the browser, storage or logs", async () => {
  const rounds: Round[] = [
    {
      calls: [
        {
          id: "s1",
          name: "request_secret",
          arguments: JSON.stringify({
            name: "HIGGSFIELD_API_KEY",
            service: "Higgsfield",
            description: "To generate the video you asked for.",
            allowedHosts: ["api.higgsfield.ai", "*.higgsfield.ai"],
            howToGet: "Settings → API keys → Create key",
            docsUrl: "https://higgsfield.ai/settings/api"
          })
        }
      ]
    },
    {
      calls: [
        {
          id: "a1",
          name: "api_request",
          arguments: JSON.stringify({
            method: "POST",
            url: "https://api.higgsfield.ai/v1/generate",
            headers: { Authorization: "Bearer ${secret:HIGGSFIELD_API_KEY}" },
            body: { prompt: "a cat surfing" }
          })
        }
      ]
    },
    // A tool that leaks the raw value: the tool-loop hook must mask it.
    { calls: [{ id: "l1", name: "leaky_tool", arguments: "{}" }] },
    { text: "Your video is queued." }
  ];

  const requests: Array<{ messages: ToolChatMessage[] }> = [];
  const toolLlm: ToolChatProvider = {
    async *streamWithTools(messages) {
      requests.push({ messages: structuredClone(messages) });
      const round = rounds[requests.length - 1] ?? { text: "Done." };
      if (round.text) yield { type: "text", delta: round.text };
      yield { type: "usage", usage: { costUsd: 0.001 } };
      if (round.calls) yield { type: "tool_calls", calls: round.calls };
    }
  };
  const llm: LLMProvider = {
    async *streamText() {
      yield { delta: "plain" };
    }
  };

  const logLines: unknown[] = [];
  const logger: GatewayLogger = {
    info: (event, fields) => void logLines.push([event, fields]),
    warn: (event, fields) => void logLines.push([event, fields]),
    error: (event, fields) => void logLines.push([event, fields])
  };

  const outbound: Array<{ url: string; authorization?: string; body?: string }> = [];
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const secrets = (await installSecrets({
    store,
    tools,
    ownerId: "owner",
    env: {},
    key: randomBytes(32),
    log: (event, fields) => logger.info(event, fields),
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      outbound.push({ url: String(url), ...(headers.authorization ? { authorization: headers.authorization } : {}), ...(init?.body ? { body: String(init.body) } : {}) });
      // The service echoes the key back (some APIs do, in errors).
      return new Response(JSON.stringify({ id: "job-1", status: "queued", debug: { auth: headers.authorization } }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    }
  }))!;
  const leaky: ToolDefinition = {
    name: "leaky_tool",
    title: "Leaky tool",
    description: "test",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    source: "builtin",
    async run() {
      return { content: `env dump: HIGGSFIELD=${VALUE} b64=${Buffer.from(VALUE).toString("base64")}` };
    }
  };
  tools.register(leaky);
  const runtime = createTestRuntime({ store, tools, secrets });

  const gateway = await createGatewayServer({
    providers: { llm, stt, toolLlm },
    host: "127.0.0.1",
    modelCatalog: catalog,
    runtime,
    logger
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const raw: string[] = [];
  const messages: ServerMessage[] = [];
  const waiters: Array<{ p: (m: ServerMessage) => boolean; r: (m: ServerMessage) => void }> = [];
  socket.on("message", (data) => {
    raw.push(data.toString());
    const m = JSON.parse(data.toString()) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) if (w.p(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); }
  });
  const waitFor = (p: (m: ServerMessage) => boolean, ms = 3000, from = 0): Promise<ServerMessage> => {
    const found = messages.slice(from).find(p);
    if (found) return Promise.resolve(found);
    return Promise.race([
      new Promise<ServerMessage>((r) => waiters.push({ p, r })),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
    ]);
  };
  const send = (m: unknown) => socket.send(JSON.stringify(m));
  await new Promise((r) => socket.once("open", r));

  try {
    await waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    send({ type: WS_EVENTS.USER_TEXT, requestId: "typed-1", text: "Make me a video with Higgsfield" });

    // 1. The secure box appears inside this reply.
    const prompt = (await waitFor((m) => m.type === SECRET_EVENTS.REQUEST)) as Extract<ServerMessage, { type: "secret.request" }>;
    assert.equal(prompt.request.runId, "typed-1");
    assert.equal(prompt.request.name, "HIGGSFIELD_API_KEY");
    assert.equal(prompt.request.service, "Higgsfield");
    assert.deepEqual(prompt.request.allowedHosts, ["api.higgsfield.ai", "*.higgsfield.ai"]);
    assert.equal(prompt.request.docsUrl, "https://higgsfield.ai/settings/api");
    assert.equal(prompt.request.expiresAt - prompt.request.createdAt, 10 * 60 * 1000);

    // A rejected save keeps the box open.
    send({ type: SECRET_EVENTS.PROVIDE, id: prompt.request.id, value: VALUE, allowedHosts: ["not a host"] });
    const invalid = (await waitFor((m) => m.type === SECRET_EVENTS.RESOLVED)) as Extract<ServerMessage, { type: "secret.resolved" }>;
    assert.equal(invalid.status, "invalid");

    // 2. The user narrows the hosts and saves.
    send({ type: SECRET_EVENTS.PROVIDE, id: prompt.request.id, value: VALUE, allowedHosts: ["api.higgsfield.ai"] });
    const saved = (await waitFor((m) => m.type === SECRET_EVENTS.RESOLVED && m.status === "saved")) as Extract<ServerMessage, { type: "secret.resolved" }>;
    assert.deepEqual(saved.allowedHosts, ["api.higgsfield.ai"]);

    // 3. api_request asks for approval: method, host and secret name — never the value.
    const approvalMessage = (await waitFor((m) => m.type === WS_EVENTS.APPROVAL_REQUEST)) as Extract<ServerMessage, { type: "approval.request" }>;
    const approval = approvalMessage.approval;
    assert.equal(approval.toolName, "api_request");
    assert.match(approval.summary, /POST/);
    assert.match(approval.summary, /api\.higgsfield\.ai/);
    assert.ok(approval.details?.some((d) => d.value.includes("${secret:HIGGSFIELD_API_KEY}")));
    send({ type: WS_EVENTS.APPROVAL_DECISION, id: approval.id, decision: "approve" });

    await waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "typed-1", 5000);

    // The key went to the allowed host, resolved on the server.
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]!.url, "https://api.higgsfield.ai/v1/generate");
    assert.equal(outbound[0]!.authorization, `Bearer ${VALUE}`);

    // What the model read.
    const toolResults = requests.flatMap((r) => r.messages).filter((m) => m.role === "tool").map((m) => String(m.content));
    assert.ok(toolResults.some((c) => c === "Saved HIGGSFIELD_API_KEY (allowed for api.higgsfield.ai). Use it as ${secret:HIGGSFIELD_API_KEY}."));
    assert.ok(toolResults.some((c) => /^HTTP 202/.test(c) && c.includes("Bearer [secret:HIGGSFIELD_API_KEY]")));
    assert.ok(toolResults.some((c) => c.includes("HIGGSFIELD=[secret:HIGGSFIELD_API_KEY]")));

    // The Secrets panel lists metadata only.
    const before = messages.length;
    send({ type: SECRET_EVENTS.LIST });
    const state = (await waitFor((m) => m.type === SECRET_EVENTS.STATE, 3000, before)) as Extract<ServerMessage, { type: "secrets.state" }>;
    assert.deepEqual(state.secrets.map((s) => [s.name, s.allowedHosts, s.readable]), [["HIGGSFIELD_API_KEY", ["api.higgsfield.ai"], true]]);
    assert.ok(state.secrets[0]!.lastUsedAt);

    // Panel edits: narrow hosts, replace the value, delete.
    send({ type: SECRET_EVENTS.UPDATE, name: "HIGGSFIELD_API_KEY", allowedHosts: ["api.higgsfield.ai", "*.higgsfield.ai"], description: "Video generation" });
    await waitFor((m) => m.type === SECRET_EVENTS.STATE && m.secrets[0]?.allowedHosts.length === 2);
    send({ type: SECRET_EVENTS.UPDATE, name: "NEW_TOKEN", allowedHosts: ["api.example.com"] });
    const failed = (await waitFor((m) => m.type === SECRET_EVENTS.STATE && Boolean(m.error))) as Extract<ServerMessage, { type: "secrets.state" }>;
    assert.match(failed.error!, /no secret named NEW_TOKEN/);
  } finally {
    socket.close();
    await gateway.close();
    secrets.close();
  }

  // The value is nowhere it shouldn't be.
  const b64 = Buffer.from(VALUE).toString("base64");
  const haystacks: Record<string, string> = {
    "WebSocket messages to the browser": raw.join("\n"),
    "model requests": JSON.stringify(requests),
    logs: JSON.stringify(logLines),
    "stored conversations": JSON.stringify(await Promise.all((await store.conversations.list("owner")).map((c) => store.conversations.get("owner", c.id)))),
    "stored approvals": JSON.stringify(await store.approvals.listPending("owner")),
    "kv store": JSON.stringify(await store.kv.get("owner", "secrets.v1"))
  };
  for (const [where, haystack] of Object.entries(haystacks)) {
    assert.ok(!haystack.includes(VALUE), `value leaked into ${where}`);
    assert.ok(!haystack.includes(b64), `base64 value leaked into ${where}`);
  }
  // Conversations were in fact stored (the check above is not vacuous).
  assert.ok((await store.conversations.list("owner")).length > 0);
});

test("cancelling the secure box tells the model \"User cancelled\" and saves nothing", async () => {
  const rounds: Round[] = [
    { calls: [{ id: "s1", name: "request_secret", arguments: JSON.stringify({ name: "SHOPIFY_TOKEN", service: "Shopify", description: "Orders", allowedHosts: ["*.myshopify.com"] }) }] },
    { text: "Okay." }
  ];
  const requests: ToolChatMessage[][] = [];
  const toolLlm: ToolChatProvider = {
    async *streamWithTools(messages) {
      requests.push(structuredClone(messages));
      const round = rounds[requests.length - 1] ?? { text: "Done." };
      if (round.text) yield { type: "text", delta: round.text };
      if (round.calls) yield { type: "tool_calls", calls: round.calls };
    }
  };
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const secrets = (await installSecrets({ store, tools, ownerId: "owner", env: {}, key: randomBytes(32), log: () => undefined }))!;
  const gateway = await createGatewayServer({
    providers: { llm: { async *streamText() { yield { delta: "x" }; } }, stt, toolLlm },
    host: "127.0.0.1",
    modelCatalog: catalog,
    runtime: createTestRuntime({ store, tools, secrets })
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  await new Promise((r) => socket.once("open", r));
  const until = async (p: () => boolean) => {
    for (let i = 0; i < 300 && !p(); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(p());
  };
  try {
    socket.send(JSON.stringify({ type: WS_EVENTS.USER_TEXT, requestId: "t-1", text: "connect shopify" }));
    await until(() => messages.some((m) => m.type === SECRET_EVENTS.REQUEST));
    const prompt = messages.find((m) => m.type === SECRET_EVENTS.REQUEST) as Extract<ServerMessage, { type: "secret.request" }>;
    socket.send(JSON.stringify({ type: SECRET_EVENTS.CANCEL, id: prompt.request.id }));
    await until(() => messages.some((m) => m.type === WS_EVENTS.LLM_DONE));
    const toolMessage = requests[1]!.at(-1)!;
    assert.equal(toolMessage.role, "tool");
    assert.match(String(toolMessage.content), /^User cancelled/);
    assert.equal(await secrets.vault.has("owner", "SHOPIFY_TOKEN"), false);
    assert.ok(messages.some((m) => m.type === SECRET_EVENTS.RESOLVED && m.status === "cancelled"));
  } finally {
    socket.close();
    await gateway.close();
    secrets.close();
  }
});
