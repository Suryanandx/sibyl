import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { LLMProvider, ProviderUsage, STTProvider, TTSProvider } from "@open-gpt-live/adapters";
import { VOICE_LATENCY_EVENTS, WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { createGatewayServer } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import { startFakeInference, type FakeInference } from "./fake-livekit-inference.js";
import { isLiveKitCloud, liveKitSpeechFromEnv, withLiveKitSpeech } from "./livekit-inference.js";
import { pcm16MonoToWav } from "./speech-stream.js";

const KEY = "lk-test-key";
const SECRET = "lk-test-secret-0123456789abcdefghijklmn";
let fake: FakeInference | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

function cloudEnv(url: string): NodeJS.ProcessEnv {
  return { LIVEKIT_URL: "wss://sibyl-test.livekit.cloud", LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, LIVEKIT_INFERENCE_URL: url };
}

const inner = (calls: string[]): { stt: STTProvider; tts: TTSProvider } => ({
  stt: {
    async transcribe(_input, options) {
      calls.push(`stt:${options?.model}`);
      return { text: "from openrouter" };
    }
  },
  tts: {
    async *synthesize(_input, options) {
      calls.push(`tts:${options?.model}`);
      yield { audio: new Uint8Array([1, 2]), mimeType: "audio/mpeg", format: "mp3" };
    }
  }
});

describe("LiveKit Inference setup", () => {
  it("is offered only for LiveKit Cloud, with a price per minute from the published table", () => {
    expect(isLiveKitCloud("wss://my-project.livekit.cloud")).toBe(true);
    expect(isLiveKitCloud("ws://localhost:7880")).toBe(false);
    expect(liveKitSpeechFromEnv({}).capability).toMatchObject({ available: false, unavailableReason: "not_configured" });
    expect(liveKitSpeechFromEnv({ LIVEKIT_URL: "ws://localhost:7880", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }).capability.unavailableReason).toBe("not_cloud");
    const env = { LIVEKIT_URL: "wss://p.livekit.cloud", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" };
    expect(liveKitSpeechFromEnv({ ...env, SIBYL_LIVEKIT_INFERENCE: "off" }).capability.unavailableReason).toBe("disabled");
    const setup = liveKitSpeechFromEnv(env);
    expect(setup.speech?.baseUrl).toBe("https://agent-gateway.livekit.cloud/v1");
    // 25 s of Deepgram Nova-3 ($0.0048/min) + 375 characters of Cartesia Sonic 3 ($50/M).
    expect(setup.capability).toMatchObject({ available: true, sttModel: "deepgram/nova-3", ttsModel: "cartesia/sonic-3" });
    expect(setup.capability.usdPerMinute).toBeCloseTo(0.0208, 3);
    const custom = liveKitSpeechFromEnv({ ...env, LIVEKIT_INFERENCE_TTS: "inworld/inworld-tts-2:Ashley", SIBYL_LIVEKIT_INFERENCE_PRICES: '{"inworld/inworld-tts-2": 15}' });
    expect(custom.speech?.tts).toMatchObject({ model: "inworld/inworld-tts-2", voice: "Ashley", usdPerMillionChars: 15 });
  });
});

describe("LiveKit Inference speech", () => {
  it("synthesizes streamed PCM over one reused socket and reports its cost", async () => {
    fake = await startFakeInference({ apiKey: KEY, apiSecret: SECRET });
    const calls: string[] = [];
    const providers = withLiveKitSpeech(inner(calls), liveKitSpeechFromEnv(cloudEnv(fake.url)).speech);
    const usage: ProviderUsage[] = [];
    for (const text of ["Hello there.", "Second segment."]) {
      const parts = [];
      for await (const chunk of providers.tts!.synthesize({ text }, { model: "livekit:cartesia/sonic-3", onUsage: (u) => usage.push(u) })) parts.push(chunk);
      expect(parts.length).toBe(3);
      expect(parts[0]).toMatchObject({ format: "pcm", sampleRate: 24_000 });
    }
    expect(fake.connections["/v1/tts"]).toBe(1);
    const create = fake.received.find((entry) => entry.event.type === "session.create");
    expect(create?.event).toMatchObject({ sample_rate: "24000", encoding: "pcm_s16le", model: "cartesia/sonic-3" });
    expect(fake.received.filter((entry) => entry.event.type === "input_transcript").map((entry) => entry.event.transcript)).toEqual(["Hello there. ", "Second segment. "]);
    expect(usage[0]?.costUsd).toBeCloseTo((12 / 1_000_000) * 50, 10);
    // Other models still go to the original provider.
    for await (const _chunk of providers.tts!.synthesize({ text: "x" }, { model: "openai/tts" })) break;
    expect(calls).toEqual(["tts:openai/tts"]);
  });

  it("transcribes a turn's PCM or WAV and reports seconds and cost", async () => {
    fake = await startFakeInference({ apiKey: KEY, apiSecret: SECRET, transcript: "what a day" });
    const calls: string[] = [];
    const providers = withLiveKitSpeech(inner(calls), liveKitSpeechFromEnv(cloudEnv(fake.url)).speech);
    const usage: ProviderUsage[] = [];
    const wav = pcm16MonoToWav(Buffer.alloc(24_000 * 2 * 3), 24_000);
    const result = await providers.stt.transcribe({ data: wav, mimeType: "audio/wav" }, { model: "livekit:deepgram/nova-3", onUsage: (u) => usage.push(u) });
    expect(result.text).toBe("what a day");
    expect(usage[0]?.seconds).toBe(3);
    expect(usage[0]?.costUsd).toBeCloseTo((3 / 60) * 0.0048, 10);
    expect(fake.received.find((entry) => entry.event.type === "audio_bytes")?.event.bytes).toBe(24_000 * 2 * 3);
    expect(fake.received.find((entry) => entry.event.type === "session.create")?.event).toMatchObject({ model: "deepgram/nova-3", settings: { sample_rate: "24000", encoding: "pcm_s16le" } });
    await expect(providers.stt.transcribe({ data: new Uint8Array([1]), mimeType: "audio/webm" }, { model: "livekit:deepgram/nova-3" })).rejects.toThrow(/PCM or WAV/);
    expect((await providers.stt.transcribe({ data: new Uint8Array([1]), mimeType: "audio/webm" }, { model: "openai/whisper" })).text).toBe("from openrouter");
  });

  it("is refused without the inference grant's key", async () => {
    fake = await startFakeInference({ apiKey: KEY, apiSecret: SECRET });
    const speech = liveKitSpeechFromEnv({ ...cloudEnv(fake.url), LIVEKIT_API_SECRET: "wrong-secret-0123456789abcdefghijklmn" }).speech;
    const providers = withLiveKitSpeech(inner([]), speech);
    await expect(
      (async () => {
        for await (const _chunk of providers.tts!.synthesize({ text: "hi" }, { model: "livekit:cartesia/sonic-3" })) break;
      })()
    ).rejects.toThrow(/401/);
  });
});

describe("LiveKit Inference in a voice session", () => {
  it("speaks and transcribes through LiveKit when the session chooses it; usage is metered", async () => {
    fake = await startFakeInference({ apiKey: KEY, apiSecret: SECRET, transcript: "tell me a joke" });
    const llm: LLMProvider = {
      async *streamText() {
        yield { delta: "Why did the chicken cross the road? " };
        yield { delta: "To get to the other side." };
      }
    };
    const calls: string[] = [];
    const catalog: ModelCatalog = {
      voice: [{ id: "voice/fast", label: "Fast voice" }],
      llm: [{ id: "brain/deep", label: "Deep" }],
      stt: [{ id: "stt/x", label: "STT" }],
      tts: [{ id: "tts/plain", label: "Plain", voices: ["a"] }]
    };
    const runtime = createTestRuntime();
    const recorded: Array<{ feature: string; model?: string; costUsd: number }> = [];
    runtime.meter.record = (event) => void recorded.push(event as (typeof recorded)[number]);
    const gateway = await createGatewayServer({
      runtime,
      providers: { llm, ...inner(calls) },
      host: "127.0.0.1",
      modelCatalog: catalog,
      live: { voicePrompt: "VOICE", brainPrompt: () => "BRAIN" },
      livekitSpeech: liveKitSpeechFromEnv(cloudEnv(fake.url))
    });
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
    const waitFor = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
      for (let i = 0; i < 200; i += 1) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("timeout");
    };
    try {
      await new Promise((resolve) => socket.once("open", resolve));
      const config = (await waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG)) as { capabilities: { speech?: { livekit: { available: boolean } } } };
      expect(config.capabilities.speech?.livekit.available).toBe(true);
      socket.send(JSON.stringify({ type: WS_EVENTS.SESSION_UPDATE, settings: { speechProvider: "livekit" } }));
      await waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG && (m as { settings: { speechProvider?: string } }).settings.speechProvider === "livekit");
      socket.send(JSON.stringify({ type: WS_EVENTS.VAD_SPEECH_START, requestId: "lk-1", turnMode: "live", startedAt: 1 }));
      socket.send(JSON.stringify({ type: WS_EVENTS.AUDIO_CHUNK, requestId: "lk-1", chunk: Buffer.alloc(9600).toString("base64"), mimeType: "audio/pcm;rate=24000", sequence: 0, turnMode: "live" }));
      socket.send(JSON.stringify({ type: WS_EVENTS.VAD_SPEECH_END, requestId: "lk-1", endedAt: 2, reason: "silence" }));
      await waitFor((m) => m.type === WS_EVENTS.TTS_END && m.requestId === "lk-1");
      const update = (await waitFor((m) => m.type === WS_EVENTS.TRANSCRIPT_UPDATE && m.requestId === "lk-1")) as { text: string };
      expect(update.text).toBe("tell me a joke");
      const chunks = messages.filter((m) => m.type === WS_EVENTS.TTS_CHUNK && m.requestId === "lk-1") as Array<{ mimeType: string; isFinal?: boolean }>;
      expect(chunks.length).toBeGreaterThan(1);
      expect(new Set(chunks.map((c) => c.mimeType))).toEqual(new Set(["audio/wav"]));
      expect(chunks.filter((c) => c.isFinal).length).toBe(1);
      expect(calls).toEqual([]);
      const metrics = (await waitFor((m) => m.type === VOICE_LATENCY_EVENTS.TURN_METRICS)) as { metrics: { ttsModel?: string; ttsTtfbMs?: number } };
      expect(metrics.metrics.ttsModel).toBe("livekit:cartesia/sonic-3");
      expect(typeof metrics.metrics.ttsTtfbMs).toBe("number");
      // Metered at LiveKit's published prices, like every model call.
      const tts = recorded.filter((event) => event.model === "livekit:cartesia/sonic-3");
      expect(tts.length).toBeGreaterThan(0);
      expect(tts.every((event) => event.feature === "tts" && event.costUsd > 0)).toBe(true);
      expect(recorded.some((event) => event.model === "livekit:deepgram/nova-3" && event.feature === "stt")).toBe(true);
    } finally {
      socket.close();
      await gateway.close();
    }
  });
});
