/**
 * LiveKit Inference speech for Sibyl voice: hosted streaming speech-to-text and
 * text-to-speech (Deepgram, AssemblyAI, Cartesia, Inworld, Rime…) reached with
 * the LiveKit Cloud project's API key, no other provider keys.
 *
 * Opt-in per session (Settings → Voice → Speech), available only when
 * LIVEKIT_URL is a LiveKit Cloud project (`*.livekit.cloud`). The voice brain and
 * the deep brain stay on OpenRouter, so one OpenRouter key keeps working.
 *
 * Wire protocol (the one `@livekit/agents` 1.9.5 `src/inference/{stt,tts}.ts`
 * speaks; we call it directly, without the Agents framework):
 *   wss://agent-gateway.livekit.cloud/v1/tts?model=…   Authorization: Bearer <JWT with inference.perform>
 *     → session.create {sample_rate, encoding, model, voice?, language, extra}
 *     → input_transcript {transcript, generation_config} → session.flush
 *     ← output_audio {audio: base64 pcm_s16le} … ← done
 *   wss://…/v1/stt?model=…
 *     → session.create {model, settings: {sample_rate, encoding, language, extra}}
 *     → input_audio {audio: base64 pcm_s16le} … → session.finalize
 *     ← final_transcript {transcript} … ← session.finalized
 *
 * Costs are reported with each call (provider usage `costUsd`) from LiveKit's
 * published prices, so they are metered and budgeted like every model call.
 * Not verified against LiveKit Cloud here (no Cloud project was available);
 * the tests run against a local stand-in that speaks the same protocol.
 */
import { AccessToken } from "livekit-server-sdk";
import { WebSocket } from "ws";
import type {
  ProviderCallOptions,
  STTAudioInput,
  STTProvider,
  TTSProvider,
  TTSStreamChunk,
  TTSSynthesisInput
} from "@open-gpt-live/adapters";
import type { SpeechProviderCapability } from "@open-gpt-live/protocol";
import { decodeWav } from "../realtime/audio.js";

/** Model ids routed to LiveKit Inference carry this prefix inside the gateway. */
export const LIVEKIT_SPEECH_PREFIX = "livekit:";
export const DEFAULT_INFERENCE_URL = "https://agent-gateway.livekit.cloud/v1";
export const DEFAULT_STT_MODEL = "deepgram/nova-3";
export const DEFAULT_TTS_MODEL = "cartesia/sonic-3";
/** Raw PCM sample rate asked of LiveKit TTS (what the browser and the room agent play). */
export const LIVEKIT_TTS_SAMPLE_RATE = 24_000;

/**
 * Published LiveKit Inference prices (livekit.com/pricing/inference, Build/Ship plans,
 * checked 2026-11-10): STT in USD per minute of audio, TTS in USD per 1M characters.
 * Override or extend with SIBYL_LIVEKIT_INFERENCE_PRICES ({"model": price}).
 */
export const LIVEKIT_STT_USD_PER_MINUTE: Record<string, number> = {
  "deepgram/nova-3": 0.0048,
  "deepgram/flux-general-en": 0.0065,
  "assemblyai/universal-streaming": 0.0025,
  "assemblyai/universal-3-6-pro": 0.0075,
  "cartesia/ink-whisper": 0.003,
  "cartesia/ink-2": 0.009
};
export const LIVEKIT_TTS_USD_PER_MILLION_CHARS: Record<string, number> = {
  "cartesia/sonic-3": 50,
  "deepgram/aura-2": 30,
  "inworld/inworld-tts-2": 25,
  "rime/mistv3": 30,
  "rime/coda": 50
};
/** Used for a model missing from the table (and said to be an estimate in the docs). */
const FALLBACK_STT_USD_PER_MINUTE = 0.01;
const FALLBACK_TTS_USD_PER_MILLION_CHARS = 50;

/** A "minute" of conversation, as on the voice engine prices: ~25 s of you, ~25 s of reply (~15 characters a second). */
const MINUTE_USER_SECONDS = 25;
const MINUTE_REPLY_CHARACTERS = 375;

export interface LiveKitSpeech {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  stt: { model: string; language: string; usdPerMinute: number };
  tts: { model: string; voice?: string; language: string; usdPerMillionChars: number };
}

export interface LiveKitSpeechSetup {
  /** Set when usable. */
  speech?: LiveKitSpeech;
  capability: SpeechProviderCapability["livekit"];
}

export function liveKitSpeechFromEnv(env: NodeJS.ProcessEnv): LiveKitSpeechSetup {
  const [ttsModel, voice] = splitModelVoice(env.LIVEKIT_INFERENCE_TTS?.trim() || DEFAULT_TTS_MODEL);
  const sttModel = env.LIVEKIT_INFERENCE_STT?.trim() || DEFAULT_STT_MODEL;
  const prices = parsePrices(env.SIBYL_LIVEKIT_INFERENCE_PRICES);
  const sttPrice = prices[sttModel] ?? LIVEKIT_STT_USD_PER_MINUTE[sttModel] ?? FALLBACK_STT_USD_PER_MINUTE;
  const ttsPrice = prices[ttsModel] ?? LIVEKIT_TTS_USD_PER_MILLION_CHARS[ttsModel] ?? FALLBACK_TTS_USD_PER_MILLION_CHARS;
  const usdPerMinute = round((MINUTE_USER_SECONDS / 60) * sttPrice + (MINUTE_REPLY_CHARACTERS / 1_000_000) * ttsPrice);
  const base = { sttModel, ttsModel, usdPerMinute };
  const url = env.LIVEKIT_URL?.trim();
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  if ((env.SIBYL_LIVEKIT_INFERENCE ?? "auto").trim().toLowerCase() === "off") {
    return { capability: { available: false, unavailableReason: "disabled", ...base } };
  }
  if (!url || !apiKey || !apiSecret) return { capability: { available: false, unavailableReason: "not_configured", ...base } };
  if (!isLiveKitCloud(url) && !env.LIVEKIT_INFERENCE_URL?.trim()) {
    return { capability: { available: false, unavailableReason: "not_cloud", ...base } };
  }
  const language = env.LIVEKIT_INFERENCE_LANGUAGE?.trim() || "en";
  return {
    speech: {
      baseUrl: (env.LIVEKIT_INFERENCE_URL?.trim() || DEFAULT_INFERENCE_URL).replace(/\/+$/, ""),
      apiKey,
      apiSecret,
      stt: { model: sttModel, language, usdPerMinute: sttPrice },
      tts: { model: ttsModel, ...(voice ? { voice } : {}), language, usdPerMillionChars: ttsPrice }
    },
    capability: { available: true, ...base }
  };
}

export function isLiveKitCloud(url: string): boolean {
  try {
    return new URL(url.replace(/^ws/i, "http")).hostname.toLowerCase().endsWith(".livekit.cloud");
  } catch {
    return false;
  }
}

/** "cartesia/sonic-3:<voice id>" → model and voice (the agents SDK's model string form). */
function splitModelVoice(value: string): [string, string | undefined] {
  const index = value.indexOf(":");
  return index === -1 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1) || undefined];
}

function parsePrices(raw: string | undefined): Record<string, number> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0)
    );
  } catch {
    return {};
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Providers with LiveKit Inference added: a call whose model starts with
 * `livekit:` goes to LiveKit, everything else to the original provider.
 */
export function withLiveKitSpeech<T extends { stt: STTProvider; tts?: TTSProvider }>(providers: T, speech: LiveKitSpeech | undefined): T {
  if (!speech) return providers;
  const tokens = new InferenceTokens(speech);
  const stt = new LiveKitInferenceSTT(speech, tokens);
  const tts = new LiveKitInferenceTTS(speech, tokens);
  const innerStt = providers.stt;
  const innerTts = providers.tts;
  return {
    ...providers,
    stt: {
      transcribe: (input: STTAudioInput, options?: ProviderCallOptions) =>
        isLiveKitModel(options?.model) ? stt.transcribe(input, options) : innerStt.transcribe(input, options)
    },
    ...(innerTts
      ? {
          tts: {
            get configured() {
              return (innerTts as { configured?: boolean }).configured;
            },
            synthesize: (input: TTSSynthesisInput, options?: ProviderCallOptions) =>
              isLiveKitModel(options?.model) ? tts.synthesize(input, options) : innerTts.synthesize(input, options)
          } as TTSProvider
        }
      : {})
  };
}

export function isLiveKitModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith(LIVEKIT_SPEECH_PREFIX));
}

/** Short-lived JWTs with the inference grant, reused for a few minutes. */
class InferenceTokens {
  private cached: { token: string; until: number } | undefined;

  constructor(private readonly speech: Pick<LiveKitSpeech, "apiKey" | "apiSecret">) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.token;
    const access = new AccessToken(this.speech.apiKey, this.speech.apiSecret, { identity: "sibyl-gateway", ttl: 600 });
    access.addInferenceGrant({ perform: true });
    const token = await access.toJwt();
    this.cached = { token, until: Date.now() + 8 * 60_000 };
    return token;
  }
}

function socketUrl(baseUrl: string, kind: "stt" | "tts", model: string): string {
  return `${baseUrl.replace(/^http/i, "ws")}/${kind}?model=${encodeURIComponent(model)}`;
}

function openSocket(url: string, token: string, signal: AbortSignal | undefined): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "sibyl-gateway" }, handshakeTimeout: 10_000 });
    const onAbort = (): void => {
      socket.terminate();
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("open", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(socket);
    });
    socket.once("unexpected-response", (_request, response) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`LiveKit Inference refused the connection (${response.statusCode})`));
    });
    socket.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

interface InferenceEvent {
  type?: string;
  audio?: string;
  transcript?: string;
  message?: string;
  code?: number | string;
}

/** Streams JSON events from a socket until `stop` says so; errors and closes end it. */
async function* events(socket: WebSocket, signal: AbortSignal | undefined, stop: (event: InferenceEvent) => boolean, timeoutMs: number): AsyncIterable<InferenceEvent> {
  const queue: InferenceEvent[] = [];
  let failure: Error | undefined;
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const onMessage = (data: Buffer): void => {
    try {
      queue.push(JSON.parse(data.toString()) as InferenceEvent);
    } catch {
      return;
    }
    notify();
  };
  const onClose = (): void => {
    closed = true;
    notify();
  };
  const onError = (error: Error): void => {
    failure = error;
    notify();
  };
  const onAbort = (): void => {
    failure = new Error("aborted");
    notify();
  };
  const timer = setTimeout(() => {
    failure = new Error("LiveKit Inference timed out");
    notify();
  }, timeoutMs);
  socket.on("message", onMessage);
  socket.once("close", onClose);
  socket.once("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      while (queue.length) {
        const event = queue.shift()!;
        if (event.type === "error") throw new Error(`LiveKit Inference error: ${event.message ?? event.code ?? "unknown"}`);
        yield event;
        if (stop(event)) return;
      }
      if (failure) throw failure;
      if (closed) throw new Error("LiveKit Inference closed the connection");
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    clearTimeout(timer);
    socket.off("message", onMessage);
    socket.off("close", onClose);
    socket.off("error", onError);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Text-to-speech over LiveKit Inference. Sockets are kept open between
 * segments (a new one costs a TLS handshake) and reused for up to four
 * minutes; segments synthesized in parallel each take their own socket.
 */
export class LiveKitInferenceTTS implements TTSProvider {
  private readonly idle: Array<{ socket: WebSocket; key: string; openedAt: number; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    private readonly speech: LiveKitSpeech,
    private readonly tokens: InferenceTokens = new InferenceTokens(speech)
  ) {}

  async *synthesize(input: TTSSynthesisInput, options: ProviderCallOptions = {}): AsyncIterable<TTSStreamChunk> {
    const model = stripPrefix(options.model) || this.speech.tts.model;
    const voice = input.voice || this.speech.tts.voice;
    const key = `${model}|${voice ?? ""}`;
    const socket = await this.take(key, model, voice, options.signal);
    let reusable = false;
    try {
      socket.send(
        JSON.stringify({
          type: "input_transcript",
          transcript: `${input.text} `,
          generation_config: { model, language: this.speech.tts.language, ...(voice ? { voice } : {}) },
          extra: {}
        })
      );
      socket.send(JSON.stringify({ type: "session.flush" }));
      for await (const event of events(socket, options.signal, (e) => e.type === "done", 30_000)) {
        if (event.type === "output_audio" && event.audio) {
          yield { audio: Buffer.from(event.audio, "base64"), mimeType: `audio/pcm;rate=${LIVEKIT_TTS_SAMPLE_RATE}`, format: "pcm", sampleRate: LIVEKIT_TTS_SAMPLE_RATE };
        }
        if (event.type === "done") reusable = true;
      }
      options.onUsage?.({ costUsd: (input.text.length / 1_000_000) * this.speech.tts.usdPerMillionChars });
    } finally {
      if (reusable && !options.signal?.aborted) this.release(socket, key);
      else socket.terminate();
    }
  }

  private async take(key: string, model: string, voice: string | undefined, signal: AbortSignal | undefined): Promise<WebSocket> {
    for (let index = this.idle.length - 1; index >= 0; index -= 1) {
      const entry = this.idle[index]!;
      if (entry.key !== key) continue;
      this.idle.splice(index, 1);
      clearTimeout(entry.timer);
      if (entry.socket.readyState === WebSocket.OPEN && Date.now() - entry.openedAt < 240_000) return entry.socket;
      entry.socket.terminate();
    }
    const socket = await openSocket(socketUrl(this.speech.baseUrl, "tts", model), await this.tokens.get(), signal);
    (socket as WebSocket & { openedAt?: number }).openedAt = Date.now();
    socket.send(
      JSON.stringify({
        type: "session.create",
        sample_rate: String(LIVEKIT_TTS_SAMPLE_RATE),
        encoding: "pcm_s16le",
        model,
        language: this.speech.tts.language,
        extra: {},
        ...(voice ? { voice } : {})
      })
    );
    return socket;
  }

  private release(socket: WebSocket, key: string): void {
    const openedAt = (socket as WebSocket & { openedAt?: number }).openedAt ?? Date.now();
    // Idle sockets close after a minute without use.
    const timer = setTimeout(() => {
      const index = this.idle.findIndex((entry) => entry.socket === socket);
      if (index >= 0) this.idle.splice(index, 1);
      socket.close();
    }, 60_000);
    timer.unref?.();
    this.idle.push({ socket, key, openedAt, timer });
    while (this.idle.length > 4) {
      const oldest = this.idle.shift()!;
      clearTimeout(oldest.timer);
      oldest.socket.close();
    }
  }
}

/** Speech-to-text of a whole turn over LiveKit Inference's streaming endpoint. */
export class LiveKitInferenceSTT implements STTProvider {
  constructor(
    private readonly speech: LiveKitSpeech,
    private readonly tokens: InferenceTokens = new InferenceTokens(speech)
  ) {}

  async transcribe(input: STTAudioInput, options: ProviderCallOptions = {}): Promise<{ text: string }> {
    const pcm = toPcm(input);
    const model = stripPrefix(options.model) || this.speech.stt.model;
    const socket = await openSocket(socketUrl(this.speech.baseUrl, "stt", model), await this.tokens.get(), options.signal);
    const parts: string[] = [];
    try {
      socket.send(
        JSON.stringify({
          type: "session.create",
          model,
          settings: { sample_rate: String(pcm.sampleRate), encoding: "pcm_s16le", language: this.speech.stt.language, extra: {} }
        })
      );
      // 100 ms frames, as fast as the socket takes them (the turn is already over).
      const frame = Math.round(pcm.sampleRate / 10) * 2;
      for (let offset = 0; offset < pcm.data.byteLength; offset += frame) {
        socket.send(JSON.stringify({ type: "input_audio", audio: pcm.data.subarray(offset, offset + frame).toString("base64") }));
      }
      socket.send(JSON.stringify({ type: "session.finalize" }));
      for await (const event of events(socket, options.signal, (e) => e.type === "session.finalized", 20_000)) {
        if (event.type === "final_transcript" && event.transcript?.trim()) parts.push(event.transcript.trim());
      }
      socket.send(JSON.stringify({ type: "session.close" }));
    } finally {
      socket.close();
    }
    const seconds = pcm.data.byteLength / 2 / pcm.sampleRate;
    options.onUsage?.({ seconds, costUsd: (seconds / 60) * this.speech.stt.usdPerMinute });
    return { text: parts.join(" ") };
  }
}

function stripPrefix(model: string | undefined): string {
  return model?.startsWith(LIVEKIT_SPEECH_PREFIX) ? model.slice(LIVEKIT_SPEECH_PREFIX.length) : "";
}

/** 16-bit mono PCM from what the gateway transcribes (live turns: PCM or WAV). */
function toPcm(input: STTAudioInput): { data: Buffer; sampleRate: number } {
  const type = input.mimeType.toLowerCase();
  if (type.includes("wav")) {
    const decoded = decodeWav(input.data);
    return { data: Buffer.from(decoded.samples.buffer, decoded.samples.byteOffset, decoded.samples.byteLength), sampleRate: decoded.sampleRate };
  }
  if (type.includes("pcm") || type.includes("l16")) {
    return { data: Buffer.from(input.data), sampleRate: Number(/rate=(\d+)/.exec(type)?.[1]) || 24_000 };
  }
  throw new Error(`LiveKit Inference speech-to-text needs PCM or WAV audio, not ${input.mimeType}`);
}

/** Whether audio of this type can be sent to LiveKit Inference speech-to-text. */
export function isLiveKitTranscribable(mimeType: string): boolean {
  return /wav|pcm|l16/i.test(mimeType);
}
