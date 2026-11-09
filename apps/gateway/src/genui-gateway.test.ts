import assert from "node:assert/strict";
import type { LLMProvider, STTProvider, TTSProvider } from "@open-gpt-live/adapters";
import {
  WS_EVENTS,
  type ModelCatalog,
  type ServerMessage,
  type ServerSessionConfigMessage
} from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayProviders } from "./gateway.js";

const catalog: ModelCatalog = {
  llm: [
    { id: "google/gemini-3.8-flash", label: "Gemini" },
    { id: "anthropic/claude-sonnet-5.5", label: "Claude" }
  ],
  stt: [{ id: "openai/gpt-4o-mini-transcribe", label: "Mini transcribe" }],
  tts: [
    { id: "hexgrad/kokoro-82m", label: "Kokoro", voices: ["af_heart", "am_adam"], defaultVoice: "af_heart" },
    { id: "elevenlabs/eleven-flash-v2.5", label: "Eleven", voices: ["george", "sarah"] },
    { id: "google/gemini-3.8-flash-tts", label: "Gemini TTS", voices: ["Kore"], format: "pcm", sampleRate: 24000 }
  ]
};

interface Calls {
  llm: Array<{ model?: string; system?: string }>;
  stt: Array<{ model?: string }>;
  tts: Array<{ model?: string; voice?: string; text: string }>;
}

function providers(reply: string[], calls: Calls): GatewayProviders {
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      calls.llm.push({ model: options?.model, system: messages[0]?.content as string | undefined });
      for (const delta of reply) yield { delta };
    }
  };
  const stt: STTProvider = {
    async transcribe(_input, options) {
      calls.stt.push({ model: options?.model });
      return { text: "spoken" };
    }
  };
  const tts: TTSProvider = {
    async *synthesize(input, options) {
      calls.tts.push({ model: options?.model, voice: input.voice, text: input.text });
      yield { audio: new Uint8Array([1]), mimeType: "audio/mpeg", format: "mp3" };
    }
  };
  return { llm, stt, tts };
}

async function withClient(
  gatewayProviders: GatewayProviders,
  run: (client: {
    send(message: unknown): void;
    waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage>;
    messages: ServerMessage[];
  }) => Promise<void>
): Promise<void> {
  const gateway = await createGatewayServer({
    providers: gatewayProviders,
    host: "127.0.0.1",
    modelCatalog: catalog,
    genUiSystemPrompt: "GENUI PROMPT",
    ttsSegmentMinLength: 1
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  const waiters: Array<{ predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  await new Promise((resolve) => socket.once("open", resolve));
  try {
    await run({
      send: (message) => socket.send(JSON.stringify(message)),
      waitFor: (predicate) => {
        const found = messages.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve) => waiters.push({ predicate, resolve }));
      },
      messages
    });
  } finally {
    socket.close();
    await gateway.close();
  }
}

const isConfig = (message: ServerMessage): message is ServerSessionConfigMessage =>
  message.type === WS_EVENTS.SESSION_CONFIG;

test("session.config advertises the catalog and default settings", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  await withClient(providers(["hi"], calls), async (client) => {
    const config = (await client.waitFor(isConfig)) as ServerSessionConfigMessage;
    assert.equal(config.catalog.llm.length, 2);
    assert.deepEqual(config.settings, {
      llmModel: "google/gemini-3.8-flash",
      sttModel: "openai/gpt-4o-mini-transcribe",
      ttsModel: "hexgrad/kokoro-82m",
      ttsVoice: "af_heart",
      genUi: true,
      speak: true,
      preemptiveGeneration: true,
      speechProvider: "openrouter"
    });
    assert.deepEqual(config.capabilities, {
      provider: "openai-compatible",
      genUi: true,
      tts: true,
      realtimeStt: false
    });
  });
});

test("session.update switches models per turn and rejects unknown models", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  await withClient(providers(["Hello there."], calls), async (client) => {
    await client.waitFor(isConfig);
    client.send({
      type: WS_EVENTS.SESSION_UPDATE,
      settings: { llmModel: "anthropic/claude-sonnet-5.5", ttsModel: "elevenlabs/eleven-flash-v2.5" }
    });
    const updated = (await client.waitFor(
      (m) => isConfig(m) && m.settings.llmModel === "anthropic/claude-sonnet-5.5"
    )) as ServerSessionConfigMessage;
    // Voice falls back to the new model's first voice.
    assert.equal(updated.settings.ttsVoice, "george");

    client.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { llmModel: "evil/unlisted" } });
    const error = await client.waitFor((m) => m.type === "error");
    assert.match((error as { message: string }).message, /not allowed/);

    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "r1", text: "hi" });
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "r1");
    assert.equal(calls.llm[0]?.model, "anthropic/claude-sonnet-5.5");
    assert.equal(calls.tts[0]?.model, "elevenlabs/eleven-flash-v2.5");
    assert.equal(calls.tts[0]?.voice, "george");
  });
});

test("a remembered voice from another speech model is ignored quietly", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  await withClient(providers(["Hello there."], calls), async (client) => {
    await client.waitFor(isConfig);
    // A browser restoring a voice that belonged to a different speech model.
    client.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { ttsModel: "elevenlabs/eleven-flash-v2.5", ttsVoice: "af_heart" } });
    const updated = (await client.waitFor(
      (m) => isConfig(m) && m.settings.ttsModel === "elevenlabs/eleven-flash-v2.5"
    )) as ServerSessionConfigMessage;
    assert.equal(updated.settings.ttsVoice, "george");
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "r1", text: "hi" });
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "r1");
    assert.equal(calls.tts[0]?.voice, "george");
    assert.equal(client.messages.some((m) => m.type === "error"), false);
  });
});

test("generative UI is streamed as ui.delta and never spoken", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  const reply = ["Here is **the** chart.\n\n``", "`openui-lang\nroot = Card([t])\n", 't = TextContent("x")\n```\n'];
  await withClient(providers(reply, calls), async (client) => {
    await client.waitFor(isConfig);
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "g1", text: "chart" });
    await client.waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "g1");

    const speech = client.messages
      .filter((m) => m.type === WS_EVENTS.LLM_DELTA)
      .map((m) => (m as { delta: string }).delta)
      .join("");
    const ui = client.messages
      .filter((m) => m.type === WS_EVENTS.UI_DELTA)
      .map((m) => (m as { delta: string }).delta)
      .join("");
    assert.equal(speech.trim(), "Here is **the** chart.");
    assert.equal(ui, 'root = Card([t])\nt = TextContent("x")\n');
    assert.equal(calls.llm[0]?.system, "GENUI PROMPT");
    const spoken = calls.tts.map((call) => call.text).join(" ");
    assert.equal(spoken, "Here is the chart.");
  });
});

test("genUi=false uses the plain prompt and speak=false skips TTS", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  await withClient(providers(["Plain answer."], calls), async (client) => {
    await client.waitFor(isConfig);
    client.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { genUi: false, speak: false } });
    await client.waitFor((m) => isConfig(m) && !m.settings.genUi && !m.settings.speak);
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "p1", text: "hi" });
    await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "p1");
    assert.notEqual(calls.llm[0]?.system, "GENUI PROMPT");
    assert.equal(calls.tts.length, 0);
  });
});

test("voice turns transcribe with the selected STT model", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  await withClient(providers(["ok"], calls), async (client) => {
    await client.waitFor(isConfig);
    client.send({
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: "v1",
      chunk: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "audio/webm",
      sequence: 0,
      isFinal: true,
      turnMode: "ptt"
    });
    await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "v1");
    assert.equal(calls.stt[0]?.model, "openai/gpt-4o-mini-transcribe");
  });
});

test("a TTS failure is non-fatal: text and UI still stream to llm.done stop", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  const base = providers(["Spoken first.\n```openui-lang\nroot = Card([])\n```\n"], calls);
  const tts: TTSProvider = {
    async *synthesize() {
      throw new Error("voice down");
    }
  };
  await withClient({ ...base, tts }, async (client) => {
    await client.waitFor(isConfig);
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t1", text: "hi" });
    const done = await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "t1");
    assert.equal((done as { reason: string }).reason, "stop");
    const error = client.messages.find((m) => m.type === "error") as { scope?: string; message: string };
    assert.equal(error.scope, "tts");
    assert.equal(error.message, "voice down");
    assert.ok(client.messages.some((m) => m.type === WS_EVENTS.UI_DELTA));
  });
});

test("PCM-only voice models are wrapped as WAV for the browser", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  const formats: Array<string | undefined> = [];
  const base = providers(["Hello there."], calls);
  const tts: TTSProvider = {
    async *synthesize(input) {
      formats.push(input.format);
      yield { audio: new Uint8Array([1, 0, 2, 0]), mimeType: "audio/pcm", format: "pcm" };
    }
  };
  await withClient({ ...base, tts }, async (client) => {
    await client.waitFor(isConfig);
    client.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { ttsModel: "google/gemini-3.8-flash-tts" } });
    await client.waitFor((m) => isConfig(m) && m.settings.ttsModel === "google/gemini-3.8-flash-tts");
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "w1", text: "hi" });
    const chunk = (await client.waitFor((m) => m.type === WS_EVENTS.TTS_CHUNK)) as { chunk: string; mimeType: string };
    const start = client.messages.find((m) => m.type === WS_EVENTS.TTS_START) as { mimeType: string; format: string };
    assert.equal(formats[0], "pcm");
    assert.equal(chunk.mimeType, "audio/wav");
    assert.equal(start.format, "wav");
    const bytes = Buffer.from(chunk.chunk, "base64");
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(bytes.readUInt32LE(24), 24000);
    assert.equal(bytes.length, 44 + 4);
  });
});

test("updateModels swaps the catalog live and keeps the user's own picks", async () => {
  const calls: Calls = { llm: [], stt: [], tts: [] };
  const gateway = await createGatewayServer({
    providers: providers(["hi"], calls),
    host: "127.0.0.1",
    modelCatalog: catalog,
    genUiSystemPrompt: "GENUI PROMPT"
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const configs: ServerSessionConfigMessage[] = [];
  let waiter: (() => void) | undefined;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    if (isConfig(message)) { configs.push(message); waiter?.(); }
  });
  const nextConfig = () => new Promise<void>((resolve) => (waiter = resolve));
  try {
    await nextConfig();
    socket.send(JSON.stringify({ type: WS_EVENTS.SESSION_UPDATE, settings: { llmModel: "anthropic/claude-sonnet-5.5" } }));
    await nextConfig();
    const pending = nextConfig();
    gateway.updateModels({
      catalog: {
        llm: [{ id: "new/default", label: "New" }, { id: "anthropic/claude-sonnet-5.5", label: "Claude" }],
        stt: [{ id: "new/stt", label: "STT" }],
        tts: [{ id: "new/tts", label: "TTS", voices: ["v"], defaultVoice: "v" }],
        presets: [{ id: "balanced", label: "Balanced", settings: { llmModel: "new/default" } }]
      },
      defaults: { llmModel: "new/default", sttModel: "new/stt", ttsModel: "new/tts", ttsVoice: "v" }
    });
    await pending;
    const latest = configs.at(-1)!;
    assert.equal(latest.settings.llmModel, "anthropic/claude-sonnet-5.5"); // user's pick kept
    assert.equal(latest.settings.sttModel, "new/stt"); // default adopted
    assert.equal(latest.settings.ttsVoice, "v");
    assert.equal(latest.catalog.presets?.[0]?.id, "balanced");
  } finally {
    socket.close();
    await gateway.close();
  }
});
