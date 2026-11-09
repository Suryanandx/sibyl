import assert from "node:assert/strict";
import type {
  ChatToolCall,
  LLMProvider,
  STTProvider,
  TTSProvider,
  ToolChatEvent,
  ToolChatMessage,
  ToolChatOptions,
  ToolChatProvider
} from "@open-gpt-live/adapters";
import { createMemoryStore, type ToolDefinition, type UsageEvent, type UsageMeter } from "@open-gpt-live/core";
import { WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer } from "../gateway.js";
import { createNoopMeter, createTestRuntime, type GatewayRuntime } from "../runtime.js";
import { ApprovalBroker, approvalDetails, approvalSummary } from "./approvals.js";
import { truncateContent } from "./tool-loop.js";

const catalog: ModelCatalog = {
  voice: [{ id: "voice/fast", label: "Fast voice" }],
  llm: [{ id: "brain/deep", label: "Deep" }],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [{ id: "tts/plain", label: "Plain", voices: ["a"] }]
};

type Round = { text?: string; calls?: ChatToolCall[] };

interface Harness {
  send(message: unknown): void;
  waitFor(predicate: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  messages: ServerMessage[];
  socket: WebSocket;
  runtime: GatewayRuntime;
  requests: Array<{ messages: ToolChatMessage[]; options: ToolChatOptions }>;
  usage: UsageEvent[];
}

/** Scripted tool-calling model: one entry per round. */
function scriptedToolLlm(rounds: Round[], requests: Harness["requests"]): ToolChatProvider {
  return {
    async *streamWithTools(messages, options = {}): AsyncIterable<ToolChatEvent> {
      requests.push({ messages: structuredClone(messages), options });
      const round = rounds[requests.length - 1] ?? { text: "Done." };
      if (round.text) yield { type: "text", delta: round.text };
      yield { type: "usage", usage: { costUsd: 0.001, promptTokens: 10, completionTokens: 5 } };
      if (round.calls) yield { type: "tool_calls", calls: round.calls };
    }
  };
}

async function withToolGateway(
  rounds: Round[],
  tools: ToolDefinition<any, any>[],
  run: (h: Harness) => Promise<void>
): Promise<void> {
  const usage: UsageEvent[] = [];
  const meter: UsageMeter = {
    ...createNoopMeter(),
    record: (event) => void usage.push({ id: String(usage.length), at: 0, ...event })
  };
  const runtime = createTestRuntime({ meter });
  for (const tool of tools) runtime.tools.register(tool);
  const requests: Harness["requests"] = [];
  const llm: LLMProvider = {
    async *streamText(_messages, options) {
      if (options?.model === "voice/fast") yield { delta: "On it.\n@brain do the task" };
      else yield { delta: "plain path" };
    }
  };
  const stt: STTProvider = { transcribe: async () => ({ text: "do it" }) };
  const tts: TTSProvider = {
    async *synthesize() {
      yield { audio: new Uint8Array([1]), mimeType: "audio/mpeg", format: "mp3" };
    }
  };
  const gateway = await createGatewayServer({
    providers: { llm, stt, tts, toolLlm: scriptedToolLlm(rounds, requests) },
    host: "127.0.0.1",
    modelCatalog: catalog,
    live: { voicePrompt: "VOICE", brainPrompt: () => "BRAIN" },
    ttsSegmentMinLength: 1,
    runtime
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  const waiters: Array<{ p: (m: ServerMessage) => boolean; r: (m: ServerMessage) => void }> = [];
  socket.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) if (w.p(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); }
  });
  await new Promise((r) => socket.once("open", r));
  try {
    await run({
      send: (m) => socket.send(JSON.stringify(m)),
      waitFor: (p, ms = 3000) => {
        const found = messages.find(p);
        if (found) return Promise.resolve(found);
        return Promise.race([
          new Promise<ServerMessage>((r) => waiters.push({ p, r })),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
        ]);
      },
      messages,
      socket,
      runtime,
      requests,
      usage
    });
  } finally {
    socket.close();
    await gateway.close();
  }
}

function fakeTool(
  name: string,
  effect: "read" | "write",
  title: string,
  calls: Array<Record<string, unknown>>,
  output = `${name} result`
): ToolDefinition<any, any> {
  return {
    name,
    title,
    description: `${title} (test)`,
    inputSchema: { type: "object", properties: {} },
    effect,
    source: "builtin",
    async run(input, context) {
      assert.ok(context.signal instanceof AbortSignal);
      assert.equal(context.ownerId, "owner");
      assert.ok(context.runId);
      calls.push(input);
      return { content: output };
    }
  };
}

/** A spoken turn: the voice brain hands the task to the deep brain. */
const startTask = (h: Harness) => {
  h.send({ type: WS_EVENTS.VAD_SPEECH_START, requestId: "u-1", turnMode: "live", startedAt: 1 });
  h.send({
    type: WS_EVENTS.AUDIO_CHUNK,
    requestId: "u-1",
    chunk: Buffer.alloc(4800).toString("base64"),
    mimeType: "audio/pcm;rate=24000",
    sequence: 0,
    turnMode: "live"
  });
  h.send({ type: WS_EVENTS.VAD_SPEECH_END, requestId: "u-1", endedAt: 2, reason: "silence", caption: "please do it" });
};
const brainDone = (m: ServerMessage) => m.type === WS_EVENTS.BRAIN_DONE;
const ofType = <T>(h: Harness, type: string) => h.messages.filter((m) => m.type === type) as unknown as T[];

test("a read tool runs, its steps stream, results are fed back and usage is metered", async () => {
  const searches: Array<Record<string, unknown>> = [];
  const rounds: Round[] = [
    { calls: [{ id: "c1", name: "web_search", arguments: "{\"query\":\"weather\"}" }, { id: "c2", name: "nope", arguments: "{}" }] },
    { text: "It is sunny today." }
  ];
  const big = "x".repeat(20_000);
  await withToolGateway(rounds, [fakeTool("web_search", "read", "Searching the web", searches, big)], async (h) => {
    await h.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    startTask(h);
    const done = (await h.waitFor(brainDone)) as { requestId: string; reason: string };
    assert.equal(done.reason, "stop");

    const started = ofType<{ requestId: string; callId: string; title: string; toolName: string }>(h, WS_EVENTS.TOOL_STARTED);
    assert.deepEqual(started.map((s) => [s.callId, s.title]), [["c1", "Searching the web"], ["c2", "nope"]]);
    assert.ok(started.every((s) => s.requestId === done.requestId));
    const finished = ofType<{ callId: string; status: string }>(h, WS_EVENTS.TOOL_FINISHED);
    assert.deepEqual(finished.map((f) => [f.callId, f.status]).sort(), [["c1", "ok"], ["c2", "error"]]);
    assert.deepEqual(searches, [{ query: "weather" }]);

    const brainText = ofType<{ delta: string }>(h, WS_EVENTS.BRAIN_DELTA).map((m) => m.delta).join("");
    assert.equal(brainText, "It is sunny today.");

    // The system prompt mentions tools; round 2 sees the call and (truncated) results.
    assert.equal(h.requests.length, 2);
    const first = h.requests[0]!;
    assert.match(String(first.messages[0]!.content), /^BRAIN\n\n## Tools/);
    assert.equal(first.options.tools?.[0]?.function.name, "web_search");
    const second = h.requests[1]!.messages;
    const assistant = second.at(-3) as { role: string; toolCalls: ChatToolCall[] };
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.toolCalls.length, 2);
    const results = second.slice(-2) as Array<{ role: string; toolCallId: string; content: string }>;
    assert.deepEqual(results.map((r) => [r.role, r.toolCallId]), [["tool", "c1"], ["tool", "c2"]]);
    assert.ok(results[0]!.content.length < 12_100);
    assert.match(results[0]!.content, /truncated/);
    assert.match(results[1]!.content, /no tool named "nope"/);

    // The voice turn and speech are metered too (metering wrappers); the
    // tool loop records exactly one event per model round, never twice.
    const brainUsage = h.usage.filter((event) => event.feature === "brain");
    assert.equal(brainUsage.length, 2);
    assert.equal(brainUsage[0]!.model, "brain/deep");
    assert.equal(brainUsage[0]!.costUsd, 0.001);
    assert.equal(brainUsage[0]!.requestId, done.requestId);
  });
});

test("a write tool asks for approval; approve runs it", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const rounds: Round[] = [
    { calls: [{ id: "w1", name: "send_email", arguments: "{\"to\":\"ada@example.com\",\"subject\":\"Hi\",\"apiKey\":\"sk-secret\"}" }] },
    { text: "Sent." }
  ];
  await withToolGateway(rounds, [fakeTool("send_email", "write", "Send an email", sent)], async (h) => {
    await h.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    startTask(h);
    const request = (await h.waitFor((m) => m.type === WS_EVENTS.APPROVAL_REQUEST)) as unknown as {
      approval: { id: string; title: string; summary: string; toolName: string; details: Array<{ label: string; value: string }>; expiresAt: number; createdAt: number };
    };
    const { approval } = request;
    assert.equal(approval.toolName, "send_email");
    assert.equal(approval.title, "Send an email");
    assert.equal(approval.summary, "Sibyl will send an email with to “ada@example.com” and subject “Hi”.");
    assert.deepEqual(approval.details.find((d) => d.label === "Api key")?.value, "••••••");
    assert.equal(approval.expiresAt - approval.createdAt, 10 * 60 * 1000);
    assert.equal(sent.length, 0);

    const stored = await h.runtime.store.approvals.get("owner", approval.id);
    assert.equal(stored?.status, "pending");
    assert.equal(stored?.input.apiKey, "[redacted]");

    h.send({ type: WS_EVENTS.APPROVAL_DECISION, id: approval.id, decision: "approve" });
    const resolved = (await h.waitFor((m) => m.type === WS_EVENTS.APPROVAL_RESOLVED)) as { id: string; status: string };
    assert.deepEqual([resolved.id, resolved.status], [approval.id, "approved"]);
    await h.waitFor(brainDone);
    assert.deepEqual(sent, [{ to: "ada@example.com", subject: "Hi", apiKey: "sk-secret" }]);
    const finished = ofType<{ status: string }>(h, WS_EVENTS.TOOL_FINISHED);
    assert.deepEqual(finished.map((f) => f.status), ["ok"]);
    assert.equal((await h.runtime.store.approvals.get("owner", approval.id))?.status, "approved");
  });
});

test("declining a write tool tells the model and does not run it", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const rounds: Round[] = [
    { calls: [{ id: "w1", name: "send_email", arguments: "{\"to\":\"ada@example.com\"}" }] },
    { text: "Okay, I won't send it." }
  ];
  await withToolGateway(rounds, [fakeTool("send_email", "write", "Send an email", sent)], async (h) => {
    await h.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    startTask(h);
    const { approval } = (await h.waitFor((m) => m.type === WS_EVENTS.APPROVAL_REQUEST)) as unknown as { approval: { id: string } };
    h.send({ type: WS_EVENTS.APPROVAL_DECISION, id: approval.id, decision: "decline" });
    await h.waitFor(brainDone);
    assert.equal(sent.length, 0);
    const resolved = ofType<{ status: string }>(h, WS_EVENTS.APPROVAL_RESOLVED);
    assert.deepEqual(resolved.map((r) => r.status), ["declined"]);
    assert.deepEqual(ofType<{ status: string }>(h, WS_EVENTS.TOOL_FINISHED).map((f) => f.status), ["declined"]);
    const toolMessage = h.requests[1]!.messages.at(-1) as { role: string; content: string };
    assert.equal(toolMessage.role, "tool");
    assert.match(toolMessage.content, /user declined/);

    // A second decision on the same approval just reports where it stands.
    h.send({ type: WS_EVENTS.APPROVAL_DECISION, id: approval.id, decision: "approve" });
    await h.waitFor((m) => ofType(h, WS_EVENTS.APPROVAL_RESOLVED).length === 2 && m.type === WS_EVENTS.APPROVAL_RESOLVED);
    assert.deepEqual(ofType<{ status: string }>(h, WS_EVENTS.APPROVAL_RESOLVED).map((r) => r.status), ["declined", "declined"]);
  });
});

test("remember for this conversation auto-approves the same tool afterwards", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const rounds: Round[] = [
    { calls: [{ id: "w1", name: "send_email", arguments: "{\"to\":\"a@x.com\"}" }] },
    { calls: [{ id: "w2", name: "send_email", arguments: "{\"to\":\"b@x.com\"}" }] },
    { text: "Both sent." }
  ];
  await withToolGateway(rounds, [fakeTool("send_email", "write", "Send an email", sent)], async (h) => {
    await h.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    startTask(h);
    const { approval } = (await h.waitFor((m) => m.type === WS_EVENTS.APPROVAL_REQUEST)) as unknown as { approval: { id: string } };
    h.send({ type: WS_EVENTS.APPROVAL_DECISION, id: approval.id, decision: "approve", remember: "conversation" });
    await h.waitFor(brainDone);
    assert.equal(ofType(h, WS_EVENTS.APPROVAL_REQUEST).length, 1);
    assert.deepEqual(sent.map((s) => s.to), ["a@x.com", "b@x.com"]);
  });
});

test("pending approvals expire when the socket closes", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let runtime: GatewayRuntime | undefined;
  let approvalId = "";
  await withToolGateway(
    [{ calls: [{ id: "w1", name: "send_email", arguments: "{\"to\":\"a@x.com\"}" }] }],
    [fakeTool("send_email", "write", "Send an email", sent)],
    async (h) => {
      runtime = h.runtime;
      await h.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
      startTask(h);
      const { approval } = (await h.waitFor((m) => m.type === WS_EVENTS.APPROVAL_REQUEST)) as unknown as { approval: { id: string } };
      approvalId = approval.id;
      h.socket.close();
      await new Promise((r) => h.socket.once("close", r));
    }
  );
  for (let i = 0; i < 50; i += 1) {
    if ((await runtime!.store.approvals.get("owner", approvalId))?.status === "expired") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await runtime!.store.approvals.get("owner", approvalId))?.status, "expired");
  assert.equal(sent.length, 0);
});

test("approvals expire after their time-to-live", async () => {
  const store = createMemoryStore();
  const sent: ServerMessage[] = [];
  let id = 0;
  const broker = new ApprovalBroker({
    store,
    ownerId: "owner",
    send: (m) => sent.push(m),
    createId: () => `a${++id}`,
    now: () => Date.now(),
    ttlMs: 20
  });
  const outcome = await broker.request({
    runId: "r1",
    tool: fakeTool("delete_file", "write", "Delete a file", []),
    input: { path: "/tmp/x" },
    signal: new AbortController().signal
  });
  assert.equal(outcome, "expired");
  assert.equal((await store.approvals.get("owner", "a1"))?.status, "expired");
  assert.deepEqual(sent.map((m) => m.type), [WS_EVENTS.APPROVAL_REQUEST, WS_EVENTS.APPROVAL_RESOLVED]);
});

test("approval summaries and details are human and redacted", () => {
  const details = approvalDetails({ eventTitle: "Lunch", attendees: ["a@x.com", "b@x.com"], password: "hunter2", empty: "" });
  assert.deepEqual(details, [
    { label: "Event title", value: "Lunch" },
    { label: "Attendees", value: "a@x.com, b@x.com" },
    { label: "Password", value: "••••••" }
  ]);
  assert.equal(approvalSummary({ title: "Create a calendar event" }, details), "Sibyl will create a calendar event with event title “Lunch” and attendees “a@x.com, b@x.com”.");
  assert.equal(approvalSummary({ title: "SMS the team" }, []), "Sibyl will SMS the team.");
  assert.equal(truncateContent("abc", 2), "ab\n…[truncated 1 characters]");
});

test("typed chat uses the tool loop as one normal reply (no voice brain, no speech)", async () => {
  const searches: Array<Record<string, unknown>> = [];
  const rounds: Round[] = [
    { calls: [{ id: "t1", name: "web_search", arguments: "{\"query\":\"news\"}" }] },
    { text: "Here is the news." }
  ];
  await withToolGateway(rounds, [fakeTool("web_search", "read", "Searching the web", searches)], async (h) => {
    await h.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    h.send({ type: WS_EVENTS.USER_TEXT, requestId: "typed-1", text: "what's new?" });
    const done = (await h.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "typed-1")) as { reason: string };
    assert.equal(done.reason, "stop");
    const text = h.messages
      .filter((m) => m.type === WS_EVENTS.LLM_DELTA && m.requestId === "typed-1")
      .map((m) => (m as { delta: string }).delta)
      .join("");
    assert.equal(text, "Here is the news.");
    const started = ofType<{ requestId: string; title: string }>(h, WS_EVENTS.TOOL_STARTED);
    assert.deepEqual(started.map((s) => [s.requestId, s.title]), [["typed-1", "Searching the web"]]);
    assert.deepEqual(searches, [{ query: "news" }]);
    assert.equal(h.requests[0]!.options.model, "brain/deep");
    assert.match(String(h.requests[0]!.messages[0]!.content), /## Tools/);
    assert.equal(ofType(h, WS_EVENTS.BRAIN_START).length, 0);
    assert.equal(ofType(h, WS_EVENTS.TTS_START).length, 0);
  });
});
