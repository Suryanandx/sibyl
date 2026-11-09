import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createMemoryStore, DEFAULT_OWNER_ID, type UsageEvent } from "@open-gpt-live/core";
import { resamplePcm16, parseRealtimeUsage, type LLMProvider, type STTProvider, type StreamingSTTWebSocket, type TTSProvider } from "@open-gpt-live/adapters";
import { parseClientMessage, WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { createGatewayServer } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import { createUsageMeter } from "../metering/meter.js";
import { realtimeEngineConfig, realtimeUsdPerMinute, responseUsd, sibylUsdPerMinute, transcriptionUsd, DEFAULT_REALTIME_PRICES } from "./config.js";
import { apiBaseFor, checkOpenAIKey, VoiceEngineService } from "./service.js";
import { closestRealtimeVoice } from "./voices.js";
import { agentRealtimeVoice, realtimeSettings, wantedEngine, applyVoiceEngineSettings } from "./session.js";
import { protectedRoutePermission } from "../identity/http.js";
import { CreditsService } from "../tenancy/credits.js";
import { startFakeRealtime, type FakeRealtimeOptions, type FakeRealtimeServer } from "./fake-openai-realtime.js";

const KEY = "sk-test-0123456789abcdefghijklmnop";
const wsFactory = (url: string, options: { headers: Record<string, string> }) => new WebSocket(url, { headers: options.headers }) as unknown as StreamingSTTWebSocket;

describe("prices and per-minute estimates", () => {
  const flagship = DEFAULT_REALTIME_PRICES["gpt-realtime-2.1"]!.prices;
  test("a response's tokens at OpenAI's published prices (cached input at the cached rate)", () => {
    const usd = responseUsd(
      { inputTextTokens: 1_000, inputAudioTokens: 600, cachedTextTokens: 400, cachedAudioTokens: 100, outputTextTokens: 50, outputAudioTokens: 1_200 },
      flagship
    );
    // 600 text×4 + 400×0.4 + 500 audio×32 + 100×0.4 + 50×24 + 1200×64, per 1M
    expect(usd).toBeCloseTo((600 * 4 + 400 * 0.4 + 500 * 32 + 100 * 0.4 + 50 * 24 + 1200 * 64) / 1e6, 10);
  });
  test("usage events from response.done", () => {
    expect(
      parseRealtimeUsage({
        input_token_details: { text_tokens: 10, audio_tokens: 20, cached_tokens: 5, cached_tokens_details: { text_tokens: 5, audio_tokens: 0 } },
        output_token_details: { text_tokens: 3, audio_tokens: 40 }
      })
    ).toEqual({ inputTextTokens: 10, inputAudioTokens: 20, cachedTextTokens: 5, cachedAudioTokens: 0, outputTextTokens: 3, outputAudioTokens: 40 });
  });
  test("per minute: the flagship is several times the mini, and far above Sibyl voice", () => {
    const big = realtimeUsdPerMinute(flagship, "gpt-4o-mini-transcribe");
    const mini = realtimeUsdPerMinute(DEFAULT_REALTIME_PRICES["gpt-realtime-2.1-mini"]!.prices, "gpt-4o-mini-transcribe");
    expect(big).toBeGreaterThan(0.03);
    expect(big).toBeLessThan(0.1);
    expect(mini).toBeLessThan(big / 2.5);
    // Balanced preset ~$0.13 per 100 turns → ~$0.005 a minute.
    expect(sibylUsdPerMinute(0.13)).toBeCloseTo(0.0052, 4);
  });
  test("hosted credits: calls on the organization's own OpenAI key are never charged as credits", () => {
    const credits = new CreditsService({ store: createMemoryStore(), orgId: "o1", active: true, margin: 0.2 });
    const event = { id: "e1", at: 1, ownerId: "o1", feature: "voice" as const, model: "openai/gpt-realtime-2.1", costUsd: 0.05, estimated: false };
    expect(credits.chargeFor(event)).toBeDefined();
    expect(credits.chargeFor({ ...event, ownKey: true })).toBeUndefined();
  });
  test("transcription: tokens when OpenAI reports them, else per minute", () => {
    expect(transcriptionUsd("gpt-4o-mini-transcribe", { type: "tokens", inputTokens: 1000, outputTokens: 100 }, 0)).toBeCloseTo((1000 * 1.25 + 100 * 5) / 1e6, 10);
    expect(transcriptionUsd("gpt-4o-mini-transcribe", undefined, 60)).toBeCloseTo(0.003, 10);
  });
  test("environment: defaults, overrides, hosted never uses the server key", () => {
    const config = realtimeEngineConfig({
      OPENAI_API_KEY: KEY,
      SIBYL_REALTIME_ENGINE_DEFAULT: "gpt-realtime",
      SIBYL_REALTIME_MODEL: "gpt-realtime-2.1-mini",
      SIBYL_REALTIME_VOICE: "cedar",
      SIBYL_REALTIME_PRICES: JSON.stringify({ "gpt-realtime-2.1": { audioOut: 50 }, "my-model": { label: "Mine", audioIn: 1 } })
    });
    expect(config.defaultEngine).toBe("gpt-realtime");
    expect(config.defaultModel).toBe("gpt-realtime-2.1-mini");
    expect(config.defaultVoice).toBe("cedar");
    expect(config.prices["gpt-realtime-2.1"]!.prices.audioOut).toBe(50);
    expect(config.prices["gpt-realtime-2.1"]!.prices.audioIn).toBe(32);
    expect(config.prices["my-model"]!.label).toBe("Mine");
    expect(config.serverKey).toBe(KEY);
    expect(realtimeEngineConfig({ OPENAI_API_KEY: KEY }, { hosted: true }).serverKey).toBeUndefined();
    expect(realtimeEngineConfig({ SIBYL_REALTIME_ENGINE: "off" }).enabled).toBe(false);
    expect(realtimeEngineConfig({}).defaultEngine).toBe("sibyl");
  });
});

describe("voices and settings", () => {
  test("closest GPT Realtime voice to a Sibyl voice and style", () => {
    expect(closestRealtimeVoice({ ttsVoice: "am_michael", fallback: "marin" })).toBe("cedar");
    expect(closestRealtimeVoice({ ttsVoice: "af_heart", style: "Warm, upbeat", fallback: "marin" })).toBe("coral");
    expect(closestRealtimeVoice({ ttsVoice: "sarah", style: "calm and soft", fallback: "marin" })).toBe("sage");
    expect(closestRealtimeVoice({ ttsVoice: "ash", fallback: "marin" })).toBe("ash");
    expect(closestRealtimeVoice({ fallback: "marin" })).toBe("marin");
    expect(agentRealtimeVoice({ voice: { realtimeVoice: "verse" } }, "marin")).toBe("verse");
    expect(agentRealtimeVoice(undefined, "marin")).toBe("marin");
  });
  test("engine per turn: the agent's override, else the session's, else the server default", async () => {
    const service = await new VoiceEngineService({ store: createMemoryStore(), orgId: DEFAULT_OWNER_ID, vault: undefined, env: { OPENAI_API_KEY: KEY }, hosted: false, webSocketFactory: wsFactory }).load();
    expect(wantedEngine({}, undefined, service)).toBe("sibyl");
    expect(wantedEngine({ voiceEngine: "gpt-realtime" }, undefined, service)).toBe("gpt-realtime");
    expect(wantedEngine({ voiceEngine: "gpt-realtime" }, { voice: { engine: "sibyl" } }, service)).toBe("sibyl");
    expect(wantedEngine({}, { voice: { engine: "gpt-realtime" } }, service)).toBe("gpt-realtime");
    expect(realtimeSettings({ realtimeModel: "nope", realtimeVoice: "nope" }, service)).toEqual({ model: "gpt-realtime-2.1", voice: "marin", turn: "quick" });
    const next = {};
    expect(applyVoiceEngineSettings({ realtimeModel: "gpt-4o" }, next, service)).toMatch(/not offered/);
    expect(applyVoiceEngineSettings({ realtimeVoice: "nova" }, next, service)).toMatch(/no voice/);
    expect(applyVoiceEngineSettings({ voiceEngine: "gpt-realtime", realtimeModel: "gpt-realtime-2.1-mini" }, next, service)).toBeUndefined();
    expect(next).toEqual({ voiceEngine: "gpt-realtime", realtimeModel: "gpt-realtime-2.1-mini" });
  });
  test("session.update carries the engine fields; bad values are refused", () => {
    const ok = parseClientMessage({ type: "session.update", settings: { voiceEngine: "gpt-realtime", realtimeModel: "gpt-realtime-2.1-mini", realtimeVoice: "cedar", realtimeTurn: "patient" } });
    expect(ok.success && ok.data).toMatchObject({ settings: { voiceEngine: "gpt-realtime", realtimeTurn: "patient" } });
    expect(parseClientMessage({ type: "session.update", settings: { voiceEngine: "elevenlabs" } }).success).toBe(false);
    expect(parseClientMessage({ type: "session.update", settings: { realtimeTurn: "slow" } }).success).toBe(false);
  });
  test("resampling 16 kHz → 24 kHz keeps the duration", () => {
    const pcm = Buffer.alloc(16_000 * 2);
    expect(resamplePcm16(pcm, 16_000, 24_000).byteLength).toBe(24_000 * 2);
  });
});

describe("the OpenAI key", () => {
  test("routes: anyone who chats reads; owners/admins change the key; workspace admins the switch", () => {
    expect(protectedRoutePermission("GET", "/api/voice-engine")?.permission).toBe("chat.use");
    expect(protectedRoutePermission("PUT", "/api/voice-engine/key")?.permission).toBe("org.settings");
    expect(protectedRoutePermission("POST", "/api/voice-engine/key/test")?.permission).toBe("org.settings");
    expect(protectedRoutePermission("DELETE", "/api/voice-engine/key")?.permission).toBe("org.settings");
    expect(protectedRoutePermission("PUT", "/api/voice-engine/policy")?.permission).toBe("workspace.settings");
  });
  test("the API base next to a Realtime URL", () => {
    expect(apiBaseFor(undefined)).toBe("https://api.openai.com/v1");
    expect(apiBaseFor("ws://127.0.0.1:9/v1/realtime")).toBe("http://127.0.0.1:9/v1");
  });
  test("checked with OpenAI: accepted, refused, or without Realtime access", async () => {
    const fetchFor = (status: Record<string, number>) => async (url: string) => ({ ok: (status[url] ?? 200) < 300, status: status[url] ?? 200 });
    await expect(checkOpenAIKey(KEY, { model: "gpt-realtime-2.1", fetch: fetchFor({}) })).resolves.toMatchObject({ last4: "mnop", realtimeAccess: true });
    await expect(checkOpenAIKey(KEY, { model: "gpt-realtime-2.1", fetch: fetchFor({ "https://api.openai.com/v1/models/gpt-realtime-2.1": 401 }) })).rejects.toMatchObject({ code: "invalid_key" });
    await expect(checkOpenAIKey(KEY, { model: "gpt-realtime-2.1", fetch: fetchFor({ "https://api.openai.com/v1/models/gpt-realtime-2.1": 404 }) })).resolves.toMatchObject({ realtimeAccess: false });
    await expect(checkOpenAIKey("short", { model: "x" })).rejects.toMatchObject({ code: "invalid_key" });
  });
  test("availability: no key, the workspace switch", async () => {
    const store = createMemoryStore();
    const none = await new VoiceEngineService({ store, orgId: DEFAULT_OWNER_ID, vault: undefined, env: {}, hosted: false, webSocketFactory: wsFactory }).load();
    expect(none.capability("default").realtime).toMatchObject({ available: false, unavailableReason: "no_key" });
    const server = await new VoiceEngineService({ store, orgId: DEFAULT_OWNER_ID, vault: undefined, env: { OPENAI_API_KEY: KEY }, hosted: false, webSocketFactory: wsFactory }).load();
    expect(server.capability("default").realtime.available).toBe(true);
    expect(server.keySource).toBe("server");
    let changes = 0;
    server.onChange(() => (changes += 1));
    await server.setPolicy("default", false);
    expect(server.capability("default").realtime).toMatchObject({ available: false, unavailableReason: "blocked" });
    expect(server.capability("other").realtime.available).toBe(true);
    expect(changes).toBe(1);
    // Hosted organizations need their own key (vault), never the server's.
    const hosted = await new VoiceEngineService({ store, orgId: "org-x", vault: undefined, env: { OPENAI_API_KEY: KEY }, hosted: true, webSocketFactory: wsFactory }).load();
    expect(hosted.capability("default").realtime.unavailableReason).toBe("no_key");
  });
});

/* ───────────── a gateway session on GPT Realtime (fake OpenAI server) ───────────── */

const catalog: ModelCatalog = {
  voice: [{ id: "voice/fast", label: "Fast voice" }],
  llm: [{ id: "brain/deep", label: "Deep" }],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [{ id: "tts/plain", label: "Plain", voices: ["a"] }],
  presets: [{ id: "balanced", label: "Balanced", settings: { voiceModel: "voice/fast", llmModel: "brain/deep" }, costPer100Turns: 0.13 }]
};

function providers(rec: { llm: string[]; tts: string[] }): { llm: LLMProvider; stt: STTProvider; tts: TTSProvider } {
  return {
    llm: {
      async *streamText(_messages, options) {
        rec.llm.push(options?.model ?? "");
        const reply =
          options?.model === "brain/deep"
            ? "Tokyo is warmest in August.\n```openui-lang\nroot = Card([])\n```\n"
            : "Sibyl pipeline reply.";
        for (let i = 0; i < reply.length; i += 6) yield { delta: reply.slice(i, i + 6) };
      }
    },
    stt: { async transcribe() { return { text: "fallback words" }; } },
    tts: {
      async *synthesize(input) {
        rec.tts.push(input.text);
        yield { audio: new Uint8Array([1, 2]), mimeType: "audio/mpeg", format: "mp3" };
      }
    }
  };
}

interface Session {
  send(message: unknown): void;
  waitFor(predicate: (message: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  messages: ServerMessage[];
  usage: UsageEvent[];
  fake: FakeRealtimeServer;
  rec: { llm: string[]; tts: string[] };
}

async function withRealtime(fakeOptions: Partial<FakeRealtimeOptions>, run: (session: Session) => Promise<void>, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const fake = await startFakeRealtime({ apiKey: KEY, ...fakeOptions });
  const store = createMemoryStore();
  const usage: UsageEvent[] = [];
  const meterEnv = { ...env };
  const meter = await createUsageMeter({ store, ownerId: DEFAULT_OWNER_ID, env: meterEnv, load: false });
  meter.addPolicy({ check: () => undefined, recorded: (event) => void usage.push(event) });
  const voiceEngines = await new VoiceEngineService({
    store,
    orgId: DEFAULT_OWNER_ID,
    vault: undefined,
    env: { OPENAI_API_KEY: KEY, SIBYL_REALTIME_URL: env.SIBYL_REALTIME_URL ?? fake.url, ...env },
    hosted: false,
    webSocketFactory: wsFactory
  }).load();
  const rec = { llm: [] as string[], tts: [] as string[] };
  const gateway = await createGatewayServer({
    providers: providers(rec),
    host: "127.0.0.1",
    modelCatalog: catalog,
    genUiSystemPrompt: "GENUI",
    live: { voicePrompt: "VOICE PROMPT", realtimePrompt: "REALTIME PROMPT", brainPrompt: () => "BRAIN" },
    ttsSegmentMinLength: 1,
    runtime: createTestRuntime({ store, meter, voiceEngines })
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  const waiters: Array<{ predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.predicate(message)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  await new Promise((resolve) => socket.once("open", resolve));
  try {
    await run({
      send: (message) => socket.send(JSON.stringify(message)),
      waitFor: (predicate, ms = 4000) => {
        const found = messages.find(predicate);
        if (found) return Promise.resolve(found);
        return Promise.race([
          new Promise<ServerMessage>((resolve) => waiters.push({ predicate, resolve })),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting")), ms))
        ]);
      },
      messages,
      usage,
      fake,
      rec
    });
  } finally {
    socket.close();
    await gateway.close();
    await fake.close();
  }
}

/** A spoken turn: 16 kHz PCM (resampled to 24 kHz by the engine). */
function speak(session: Session, requestId: string, options: { caption?: string; ms?: number; rate?: number } = {}): void {
  const rate = options.rate ?? 16_000;
  const samples = Math.round((rate * (options.ms ?? 600)) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 4000), i * 2);
  session.send({ type: WS_EVENTS.VAD_SPEECH_START, requestId, turnMode: "live", startedAt: 1 });
  session.send({ type: WS_EVENTS.AUDIO_CHUNK, requestId, chunk: pcm.toString("base64"), mimeType: `audio/pcm;rate=${rate}`, sequence: 0, turnMode: "live" });
  session.send({ type: WS_EVENTS.AUDIO_CHUNK, requestId, mimeType: `audio/pcm;rate=${rate}`, sequence: 1, turnMode: "live", isFinal: true });
  session.send({ type: WS_EVENTS.VAD_SPEECH_END, requestId, endedAt: 2, reason: "silence", ...(options.caption ? { caption: options.caption } : {}) });
}

const of = (requestId: string, type: string) => (message: ServerMessage) => message.type === type && (message as { requestId?: string }).requestId === requestId;

describe("GPT Realtime in a session", () => {
  test("a spoken turn: audio in, spoken answer out, transcripts saved, usage metered", async () => {
    await withRealtime({ transcripts: ["what's the weather like"], replies: [{ say: "It's sunny and warm today." }] }, async (session) => {
      const config = (await session.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG)) as Extract<ServerMessage, { type: "session.config" }>;
      expect(config.capabilities.voiceEngines?.realtime).toMatchObject({ available: true, defaultModel: "gpt-realtime-2.1" });
      expect(config.capabilities.voiceEngines?.sibylUsdPerMinute).toBeCloseTo(0.0052, 4);
      session.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { voiceEngine: "gpt-realtime", realtimeVoice: "cedar" } });
      await session.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG && (m as { settings: { voiceEngine?: string } }).settings.voiceEngine === "gpt-realtime");
      speak(session, "turn-1", { caption: "whats the weather" });

      expect(((await session.waitFor(of("turn-1", WS_EVENTS.TRANSCRIPT_FINAL))) as { text: string }).text).toBe("whats the weather");
      const start = (await session.waitFor(of("turn-1", WS_EVENTS.TTS_START))) as { mimeType: string; voice: string };
      expect(start).toMatchObject({ mimeType: "audio/wav", voice: "cedar" });
      await session.waitFor(of("turn-1", WS_EVENTS.TTS_END));
      await session.waitFor(of("turn-1", WS_EVENTS.LLM_DONE));
      const update = (await session.waitFor(of("turn-1", WS_EVENTS.TRANSCRIPT_UPDATE))) as { text: string };
      expect(update.text).toBe("what's the weather like");

      const chunks = session.messages.filter(of("turn-1", WS_EVENTS.TTS_CHUNK)) as Array<{ chunk: string; mimeType: string; isFinal?: boolean }>;
      expect(chunks.length).toBeGreaterThan(0);
      expect(Buffer.from(chunks[0]!.chunk, "base64").subarray(0, 4).toString()).toBe("RIFF");
      expect(chunks.at(-1)!.isFinal).toBe(true);
      const said = session.messages.filter(of("turn-1", WS_EVENTS.LLM_DELTA)).map((m) => (m as { delta: string }).delta).join("");
      expect(said).toBe("It's sunny and warm today.");
      // Nothing went through Sibyl's own voice brain or TTS.
      expect(session.rec.llm).not.toContain("voice/fast");
      expect(session.rec.tts).toEqual([]);

      // What OpenAI got: the persona, the voice, our function, manual turns, 24 kHz audio (600 ms at 16 kHz → 28 800 bytes).
      const configured = session.fake.lastSession() as { instructions: string; tools: Array<{ name: string }>; audio: { input: { turn_detection: unknown; transcription: { model: string } }; output: { voice: string } } };
      expect(configured.instructions).toContain("REALTIME PROMPT");
      expect(configured.tools.map((tool) => tool.name)).toEqual(["ask_sibyl"]);
      expect(configured.audio.input.turn_detection).toBeNull();
      expect(configured.audio.input.transcription.model).toBe("gpt-4o-mini-transcribe");
      expect(configured.audio.output.voice).toBe("cedar");
      expect(session.fake.appendedBytes()).toBe(28_800);
      expect(session.fake.events.map((e) => e.type)).toEqual(expect.arrayContaining(["input_audio_buffer.commit", "response.create"]));

      // Usage: the response at GPT Realtime prices and the input transcription.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const voice = session.usage.find((event) => event.model === "openai/gpt-realtime-2.1")!;
      expect(voice).toMatchObject({ feature: "voice", requestId: "turn-1", estimated: false });
      expect(voice.costUsd).toBeGreaterThan(0);
      expect(session.usage.some((event) => event.model === "openai/gpt-4o-mini-transcribe")).toBe(true);
      const usage = (await session.waitFor((m) => m.type === WS_EVENTS.USAGE_UPDATE)) as { usage: unknown };
      expect(usage).toBeTruthy();
    });
  });

  test("barge-in: talking over the reply cancels it and cuts the audio OpenAI keeps", async () => {
    await withRealtime({ replies: [{ say: "This is a long answer that goes on and on for a while", audioMs: 3000, chunkDelayMs: 40 }, { say: "Sure." }] }, async (session) => {
      session.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { voiceEngine: "gpt-realtime" } });
      speak(session, "long-1");
      await session.waitFor(of("long-1", WS_EVENTS.TTS_CHUNK));
      session.send({ type: WS_EVENTS.INTERRUPT, requestId: "long-1", reason: "live mode barge-in" });
      expect(((await session.waitFor(of("long-1", WS_EVENTS.TTS_END))) as { reason: string }).reason).toBe("interrupted");
      expect(((await session.waitFor(of("long-1", WS_EVENTS.LLM_DONE))) as { reason: string }).reason).toBe("interrupted");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(session.fake.events.some((e) => e.type === "response.cancel")).toBe(true);
      const truncate = session.fake.events.find((e) => e.type === "conversation.item.truncate") as { audio_end_ms: number };
      expect(truncate.audio_end_ms).toBeGreaterThanOrEqual(0);
      expect(truncate.audio_end_ms).toBeLessThan(3000);
      // The next turn is answered normally.
      speak(session, "next-1");
      expect(((await session.waitFor(of("next-1", WS_EVENTS.LLM_DONE))) as { reason: string }).reason).toBe("stop");
    });
  });

  test("handoff: ask_sibyl runs the deep brain (visual in chat) and the result is spoken by GPT Realtime", async () => {
    await withRealtime(
      { transcripts: ["compare tokyo weather by month"], replies: [{ say: "Let me pull that up.", handoff: "Show Tokyo's average temperature by month in a chart" }] },
      async (session) => {
        session.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { voiceEngine: "gpt-realtime" } });
        speak(session, "ask-1");
        const brain = (await session.waitFor((m) => m.type === WS_EVENTS.BRAIN_START)) as { requestId: string; parentRequestId: string; task: string; model: string };
        expect(brain).toMatchObject({ parentRequestId: "ask-1", task: "Show Tokyo's average temperature by month in a chart", model: "brain/deep" });
        await session.waitFor(of(brain.requestId, WS_EVENTS.UI_DELTA));
        await session.waitFor(of(brain.requestId, WS_EVENTS.BRAIN_DONE));
        // The result goes back to GPT Realtime, which says it in its own voice (no Sibyl TTS).
        await session.waitFor(of(brain.requestId, WS_EVENTS.TTS_START), 3000);
        await session.waitFor(of(brain.requestId, WS_EVENTS.TTS_END));
        const output = session.fake.events.find((e) => e.type === "conversation.item.create" && (e.item as { type: string }).type === "function_call_output") as { item: { output: string } };
        expect(JSON.parse(output.item.output)).toEqual({ result: "Tokyo is warmest in August.", visualOnScreen: true });
        expect(session.rec.tts).toEqual([]);
        expect(session.fake.events.filter((e) => e.type === "response.create").length).toBe(2);
      }
    );
  });

  test("semantic turn detection: a pause mid-thought folds the next turn in", async () => {
    await withRealtime({ transcripts: ["I want to go to... Tokyo in spring"], replies: [{ say: "Spring in Tokyo is lovely." }] }, async (session) => {
      session.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { voiceEngine: "gpt-realtime", realtimeTurn: "patient" } });
      // Wait for the session to exist with semantic detection, then pause briefly between two browser turns.
      speak(session, "part-1", { ms: 300 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      speak(session, "part-2", { ms: 300 });
      const merged = (await session.waitFor((m) => m.type === WS_EVENTS.TURN_MERGED)) as { requestId: string; mergedRequestId: string };
      expect(merged).toMatchObject({ requestId: "part-2", mergedRequestId: "part-1" });
      await session.waitFor(of("part-2", WS_EVENTS.LLM_DONE), 6000);
      const configured = session.fake.lastSession() as { audio: { input: { turn_detection: { type: string; eagerness: string } } } };
      expect(configured.audio.input.turn_detection).toMatchObject({ type: "semantic_vad", eagerness: "low" });
      expect(session.fake.events.filter((e) => e.type === "response.create").length).toBe(1);
    });
  });

  test("budget cap: no Realtime turn starts once the cap is reached", async () => {
    await withRealtime(
      {},
      async (session) => {
        session.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { voiceEngine: "gpt-realtime" } });
        speak(session, "capped-1");
        const blocked = (await session.waitFor((m) => m.type === WS_EVENTS.BUDGET_BLOCKED)) as { requestId: string; scope: string };
        expect(blocked).toMatchObject({ requestId: "capped-1", scope: "daily" });
        expect(((await session.waitFor(of("capped-1", WS_EVENTS.LLM_DONE))) as { reason: string }).reason).toBe("error");
        expect(session.fake.sessions).toBe(0);
        expect(session.rec.llm).toEqual([]);
      },
      { SIBYL_BUDGET_DAILY_USD: "0.000001" }
    );
  });

  test("OpenAI unreachable: the turn falls back to Sibyl voice", async () => {
    await withRealtime(
      {},
      async (session) => {
        session.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { voiceEngine: "gpt-realtime" } });
        speak(session, "down-1", { caption: "hello there" });
        const notice = (await session.waitFor((m) => m.type === "error" && /GPT Realtime isn't available/.test((m as { message: string }).message), 12_000)) as { message: string };
        expect(notice.message).toMatch(/Using Sibyl voice/);
        await session.waitFor(of("down-1", WS_EVENTS.LLM_DONE), 6000);
        expect(session.rec.llm).toContain("voice/fast");
      },
      { SIBYL_REALTIME_URL: "ws://127.0.0.1:9/v1/realtime" }
    );
  }, 20_000);

  test("without a key the option says so and Sibyl voice answers", async () => {
    const store = createMemoryStore();
    const voiceEngines = await new VoiceEngineService({ store, orgId: DEFAULT_OWNER_ID, vault: undefined, env: {}, hosted: false, webSocketFactory: wsFactory }).load();
    const rec = { llm: [] as string[], tts: [] as string[] };
    const gateway = await createGatewayServer({
      providers: providers(rec),
      host: "127.0.0.1",
      modelCatalog: catalog,
      live: { voicePrompt: "VOICE PROMPT", brainPrompt: () => "BRAIN" },
      runtime: createTestRuntime({ store, voiceEngines })
    });
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
    await new Promise((resolve) => socket.once("open", resolve));
    try {
      socket.send(JSON.stringify({ type: WS_EVENTS.SESSION_UPDATE, settings: { voiceEngine: "gpt-realtime" } }));
      speak({ send: (m: unknown) => socket.send(JSON.stringify(m)) } as Session, "nokey-1");
      for (let i = 0; i < 100 && !messages.some(of("nokey-1", WS_EVENTS.LLM_DONE)); i += 1) await new Promise((resolve) => setTimeout(resolve, 30));
      const config = messages.find((m) => m.type === WS_EVENTS.SESSION_CONFIG) as Extract<ServerMessage, { type: "session.config" }>;
      expect(config.capabilities.voiceEngines?.realtime.unavailableReason).toBe("no_key");
      expect(messages.some((m) => m.type === "error" && /Add an OpenAI key to use GPT Realtime/.test((m as { message: string }).message))).toBe(true);
      expect(rec.llm).toContain("voice/fast");
    } finally {
      socket.close();
      await gateway.close();
    }
  });
});
