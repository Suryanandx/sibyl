import assert from "node:assert/strict";
import type { LLMMessage, LLMProvider, STTProvider, TTSProvider } from "@open-gpt-live/adapters";
import { WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, promisesFollowUp, type GatewayProviders } from "./gateway.js";

const catalog: ModelCatalog = {
  voice: [{ id: "voice/fast", label: "Fast voice" }],
  llm: [{ id: "brain/deep", label: "Deep" }],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [
    { id: "tts/plain", label: "Plain", voices: ["a"] },
    { id: "tts/emotive", label: "Emotive", voices: ["b"], emotionTags: true }
  ]
};

interface Recorded {
  llm: Array<{ model?: string; messages: LLMMessage[] }>;
  tts: Array<{ text: string; model?: string }>;
}

function providers(replies: Record<string, string>, rec: Recorded, sttText = "show me laptops"): GatewayProviders {
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      rec.llm.push({ model: options?.model, messages });
      const reply = replies[options?.model ?? ""] ?? "";
      for (let i = 0; i < reply.length; i += 5) yield { delta: reply.slice(i, i + 5) };
    }
  };
  const stt: STTProvider = {
    async transcribe() {
      await new Promise((r) => setTimeout(r, 30));
      return { text: sttText };
    }
  };
  const tts: TTSProvider = {
    async *synthesize(input, options) {
      rec.tts.push({ text: input.text, model: options?.model });
      yield { audio: new Uint8Array([1, 2]), mimeType: "audio/mpeg", format: "mp3" };
    }
  };
  return { llm, stt, tts };
}

async function withLive(
  gatewayProviders: GatewayProviders,
  run: (c: { send(m: unknown): void; waitFor(p: (m: ServerMessage) => boolean): Promise<ServerMessage>; messages: ServerMessage[] }) => Promise<void>,
  extra: Partial<Parameters<typeof createGatewayServer>[0]> = {}
) {
  const gateway = await createGatewayServer({
    providers: gatewayProviders,
    host: "127.0.0.1",
    modelCatalog: catalog,
    genUiSystemPrompt: "GENUI",
    live: { voicePrompt: "VOICE PROMPT", brainPrompt: (genUi) => (genUi ? "BRAIN+UI" : "BRAIN") },
    ttsSegmentMinLength: 1,
    ...extra
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
  const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
  try {
    await run({
      send: (m) => socket.send(JSON.stringify(m)),
      waitFor: (p) => {
        const found = messages.find(p);
        if (found) return Promise.resolve(found);
        return Promise.race([new Promise<ServerMessage>((r) => waiters.push({ p, r })), timeout(3000)]);
      },
      messages
    });
  } finally {
    socket.close();
    await gateway.close();
  }
}

function speakLive(client: { send(m: unknown): void }, requestId: string, caption?: string) {
  client.send({ type: WS_EVENTS.VAD_SPEECH_START, requestId, turnMode: "live", startedAt: 1 });
  client.send({
    type: WS_EVENTS.AUDIO_CHUNK,
    requestId,
    chunk: Buffer.alloc(4800).toString("base64"),
    mimeType: "audio/pcm;rate=24000",
    sequence: 0,
    turnMode: "live"
  });
  client.send({ type: WS_EVENTS.VAD_SPEECH_END, requestId, endedAt: 2, reason: "silence", ...(caption ? { caption } : {}) });
}

const deltas = (messages: ServerMessage[], type: string, requestId: string) =>
  messages
    .filter((m) => m.type === type && (m as { requestId?: string }).requestId === requestId)
    .map((m) => (m as { delta: string }).delta)
    .join("");

test("live turn: voice brain hears audio, hands off to the deep brain, gist is spoken", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  const replies = {
    "voice/fast": "[warmly] Ooh, let me pull that up.\n@brain Compare 3 coding laptops in a table",
    "brain/deep": "The MacBook Air is the best all-rounder.\n```openui-lang\nroot = Card([])\n```\n"
  };
  await withLive(providers(replies, rec), async (client) => {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    speakLive(client, "live-1", "show me laptop");

    const final = (await client.waitFor((m) => m.type === WS_EVENTS.TRANSCRIPT_FINAL)) as { text: string };
    assert.equal(final.text, "show me laptop");
    const start = (await client.waitFor((m) => m.type === WS_EVENTS.BRAIN_START)) as {
      requestId: string; parentRequestId: string; task: string; model: string;
    };
    assert.equal(start.parentRequestId, "live-1");
    assert.equal(start.task, "Compare 3 coding laptops in a table");
    assert.equal(start.model, "brain/deep");
    await client.waitFor((m) => m.type === WS_EVENTS.BRAIN_DONE && m.requestId === start.requestId);
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === start.requestId);

    // Voice brain got the system prompt + raw audio.
    const voiceCall = rec.llm.find((c) => c.model === "voice/fast")!;
    assert.equal(voiceCall.messages[0]?.content, "VOICE PROMPT");
    const parts = voiceCall.messages.at(-1)!.content as Array<{ type: string }>;
    assert.equal(parts[0]?.type, "input_audio");

    // Speech streamed with the emotion cue for display; @brain line hidden.
    assert.equal(deltas(client.messages, WS_EVENTS.LLM_DELTA, "live-1"), "[warmly] Ooh, let me pull that up.\n");
    // Plain voice can't perform cues, so they're stripped before TTS.
    const spoken = rec.tts.map((t) => t.text).join(" ");
    assert.match(spoken, /Ooh, let me pull that up\./);
    assert.doesNotMatch(spoken, /\[warmly\]/);
    // Deep brain: UI + gist, gist spoken without duplicate llm.delta.
    assert.equal(deltas(client.messages, WS_EVENTS.UI_DELTA, start.requestId), "root = Card([])\n");
    assert.match(deltas(client.messages, WS_EVENTS.BRAIN_DELTA, start.requestId), /MacBook Air/);
    assert.equal(deltas(client.messages, WS_EVENTS.LLM_DELTA, start.requestId), "");
    assert.ok(rec.tts.some((t) => /MacBook Air/.test(t.text)));

    // Accurate transcript replaced the caption, and the deep brain saw it.
    await client.waitFor((m) => m.type === WS_EVENTS.TRANSCRIPT_UPDATE);
    const brainCall = rec.llm.find((c) => c.model === "brain/deep")!;
    assert.equal(brainCall.messages[0]?.content, "BRAIN+UI");
    assert.equal(brainCall.messages.at(-1)?.content, "Task from the voice: Compare 3 coding laptops in a table");
  });
});

test("noise-only turns are ignored and not added to the conversation", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  await withLive(providers({ "voice/fast": "@silence" }, rec), async (client) => {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    speakLive(client, "noise-1");
    const done = (await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE)) as { reason: string };
    assert.equal(done.reason, "ignored");
    assert.equal(rec.tts.length, 0);

    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t-2", text: "hello" });
    await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "t-2");
    const second = rec.llm.at(-1)!;
    // Only system + the new user message: the noise turn left no trace.
    assert.equal(second.messages.length, 2);
  });
});

test("typed chat is a normal reply from the llm model; spoken turns still use the voice brain", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  const replies = {
    "voice/fast": "[warmly] Sure thing!",
    "brain/deep": "Paris is the capital of France.\n```openui-lang\nroot = Card([])\n```\n"
  };
  await withLive(providers(replies, rec), async (client) => {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "typed-1", text: "capital of France?" });
    const done = (await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "typed-1")) as { reason: string };
    assert.equal(done.reason, "stop");
    await new Promise((r) => setTimeout(r, 30));

    // One plain reply: llm model, normal system prompt, text + visual, no voice.
    assert.deepEqual(rec.llm.map((c) => c.model), ["brain/deep"]);
    assert.equal(rec.llm[0]!.messages[0]?.content, "GENUI");
    assert.equal(deltas(client.messages, WS_EVENTS.LLM_DELTA, "typed-1"), "Paris is the capital of France.\n");
    assert.equal(deltas(client.messages, WS_EVENTS.UI_DELTA, "typed-1"), "root = Card([])\n");
    assert.equal(rec.tts.length, 0);
    assert.equal(client.messages.some((m) => m.type === WS_EVENTS.TTS_START || m.type === WS_EVENTS.TTS_CHUNK), false);
    assert.equal(client.messages.some((m) => m.type === WS_EVENTS.BRAIN_START), false);

    // A spoken turn still goes to the voice brain, and it sees the typed exchange.
    speakLive(client, "voice-1", "and Germany?");
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "voice-1");
    const voiceCall = rec.llm.at(-1)!;
    assert.equal(voiceCall.model, "voice/fast");
    assert.equal(voiceCall.messages[0]?.content, "VOICE PROMPT");
    assert.ok(voiceCall.messages.some((m) => m.role === "user" && m.content === "capital of France?"));
    assert.ok(rec.tts.some((t) => /Sure thing!/.test(t.text)));
  });
});

test("emotive voices keep emotion cues", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  await withLive(providers({ "voice/fast": "[laughs] That's great!" }, rec), async (client) => {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    client.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { ttsModel: "tts/emotive" } });
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG && (m as { settings: { ttsModel?: string } }).settings.ttsModel === "tts/emotive");
    speakLive(client, "e-1", "I got the job");
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "e-1");
    assert.equal(rec.tts[0]?.text, "[laughs] That's great!");
  });
});

test("a deep-brain gist is not spoken over a newer user turn", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  let releaseBrain!: () => void;
  const gate = new Promise<void>((r) => (releaseBrain = r));
  const base = providers({ "voice/fast": "Let me check.\n@brain long task" }, rec);
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      if (options?.model === "brain/deep") {
        await gate;
        yield { delta: "Old result." };
        return;
      }
      yield* base.llm.streamText(messages, options);
    }
  };
  await withLive({ ...base, llm }, async (client) => {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    speakLive(client, "a", "do the long thing");
    const start = (await client.waitFor((m) => m.type === WS_EVENTS.BRAIN_START)) as { requestId: string };
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "a");
    speakLive(client, "b", "actually, something else");
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "b");
    releaseBrain();
    await client.waitFor((m) => m.type === WS_EVENTS.BRAIN_DONE && m.requestId === start.requestId);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.messages.some((m) => m.type === WS_EVENTS.TTS_START && m.requestId === start.requestId), false);
  });
});

test("a pause mid-thought merges both fragments into one turn", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  let release!: () => void;
  const slowFirst = new Promise<void>((r) => (release = r));
  const base = providers({ "voice/fast": "Got it, that sounds stressful." }, rec);
  let voiceCalls = 0;
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      voiceCalls += 1;
      if (voiceCalls === 1) {
        // First fragment's reply is still "thinking" when the user resumes.
        await Promise.race([slowFirst, new Promise((r) => setTimeout(r, 2000))]);
        if (options?.signal?.aborted) return;
      }
      yield* base.llm.streamText(messages, options);
    }
  };
  await withLive({ ...base, llm }, async (client) => {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    speakLive(client, "frag-1", "I have an exam tomorrow");
    await client.waitFor((m) => m.type === WS_EVENTS.TRANSCRIPT_FINAL && m.requestId === "frag-1");
    await new Promise((r) => setTimeout(r, 30));
    speakLive(client, "frag-2", "and I haven't studied");
    const merged = (await client.waitFor((m) => m.type === WS_EVENTS.TURN_MERGED)) as { requestId: string; mergedRequestId: string };
    release();
    assert.deepEqual(merged, { type: WS_EVENTS.TURN_MERGED, requestId: "frag-2", mergedRequestId: "frag-1" });
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "frag-2");
    const final = client.messages.find((m) => m.type === WS_EVENTS.TRANSCRIPT_FINAL && m.requestId === "frag-2") as { text: string };
    assert.equal(final.text, "I have an exam tomorrow and I haven't studied");
    // The voice brain heard both fragments plus the pause in one clip.
    const last = rec.llm.at(-1)!;
    const audioPart = (last.messages.at(-1)!.content as Array<{ type: string; input_audio?: { data: string } }>)[0]!;
    const wavBytes = Buffer.from(audioPart.input_audio!.data, "base64").length;
    assert.equal(wavBytes, 44 + 4800 + 12000 + 4800); // header + fragment + 250 ms gap + fragment
    // Only one user entry for the merged thought in the next prompt.
    const users = last.messages.filter((m) => m.role === "user");
    assert.equal(users.length, 1);
  });
});

test("a slow voice brain is hedged: the next-best voice model answers", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  const base = providers({}, rec);
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      rec.llm.push({ model: options?.model, messages });
      if (options?.model === "voice/slow") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (options.signal?.aborted) return;
        yield { delta: "Slow answer." };
        return;
      }
      yield { delta: "Quick answer." };
    }
  };
  await withLive(
    { ...base, llm },
    async (client) => {
      await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
      speakLive(client, "h-1", "hi");
      await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "h-1");
      assert.equal(deltas(client.messages, WS_EVENTS.LLM_DELTA, "h-1"), "Quick answer.");
      assert.deepEqual(rec.llm.map((c) => c.model), ["voice/slow", "voice/fast"]);
    },
    {
      modelCatalog: { ...catalog, voice: [{ id: "voice/slow", label: "Slow" }, { id: "voice/fast", label: "Fast" }] },
      hedge: { voiceAfterMs: 50, ttsAfterMs: 5000 }
    }
  );
});

test("a spoken promise to look into something is kept even without @brain", async () => {
  const rec: Recorded = { llm: [], tts: [] };
  const replies = { "voice/fast": "Ooh, give me a second to think that through.", "brain/deep": "Here you go." };
  await withLive(providers(replies, rec), async (client) => {
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    speakLive(client, "p-1", "compare three laptops");
    const start = (await client.waitFor((m) => m.type === WS_EVENTS.BRAIN_START)) as { parentRequestId: string };
    assert.equal(start.parentRequestId, "p-1");
  });
  assert.equal(promisesFollowUp("Let me pull that up for you."), true);
  assert.equal(promisesFollowUp("Hang on, checking."), true);
  assert.equal(promisesFollowUp("Paris is the capital of France."), false);
  assert.equal(promisesFollowUp("Let me know if you need anything."), false);
});
