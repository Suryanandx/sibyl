/**
 * GPT Realtime settings and prices (environment; see docs/configuration.md).
 *
 * Prices are OpenAI's published rates in USD per 1M tokens (checked
 * 2026-11-10, https://developers.openai.com/api/docs/pricing). They change, so
 * SIBYL_REALTIME_PRICES can override or add models:
 *   SIBYL_REALTIME_PRICES='{"gpt-realtime-2.1":{"audioIn":32,"audioOut":64}}'
 */
import type { RealtimeResponseUsage, RealtimeTranscriptionUsage } from "@open-gpt-live/adapters";
import { REALTIME_VOICES, type RealtimeModelOption, type VoiceEngineId } from "@open-gpt-live/protocol";

export type RealtimePrices = RealtimeModelOption["prices"];

interface PriceEntry {
  label: string;
  description?: string;
  prices: RealtimePrices;
}

/** Published prices (USD per 1M tokens). */
export const DEFAULT_REALTIME_PRICES: Record<string, PriceEntry> = {
  "gpt-realtime-2.1": {
    label: "GPT Realtime",
    description: "OpenAI's most natural speech-to-speech voice",
    prices: { audioIn: 32, audioInCached: 0.4, audioOut: 64, textIn: 4, textInCached: 0.4, textOut: 24 }
  },
  "gpt-realtime-2.1-mini": {
    label: "GPT Realtime mini",
    description: "The same voices for about a third of the price",
    prices: { audioIn: 10, audioInCached: 0.3, audioOut: 20, textIn: 0.6, textInCached: 0.06, textOut: 2.4 }
  },
  "gpt-realtime-2": {
    label: "GPT Realtime 2",
    prices: { audioIn: 32, audioInCached: 0.4, audioOut: 64, textIn: 4, textInCached: 0.4, textOut: 24 }
  },
  "gpt-realtime": {
    label: "GPT Realtime (2025)",
    prices: { audioIn: 32, audioInCached: 0.4, audioOut: 64, textIn: 4, textInCached: 0.4, textOut: 16 }
  },
  "gpt-realtime-mini": {
    label: "GPT Realtime mini (2025)",
    prices: { audioIn: 10, audioInCached: 0.3, audioOut: 20, textIn: 0.6, textInCached: 0.06, textOut: 2.4 }
  }
};

/** Input transcription (user transcripts): USD per minute, or per 1M tokens when OpenAI reports tokens. */
export const DEFAULT_TRANSCRIPTION_PRICES: Record<string, { perMinute: number; inputPerM: number; outputPerM: number }> = {
  "gpt-4o-mini-transcribe": { perMinute: 0.003, inputPerM: 1.25, outputPerM: 5 },
  "gpt-4o-transcribe": { perMinute: 0.006, inputPerM: 2.5, outputPerM: 10 },
  "gpt-transcribe": { perMinute: 0.0045, inputPerM: 2.5, outputPerM: 10 },
  "whisper-1": { perMinute: 0.006, inputPerM: 0, outputPerM: 0 }
};

/**
 * What a "minute of conversation" means for the per-minute estimates (both engines):
 * 4 turns, 25 s of you speaking and 25 s of the reply, with the conversation so far
 * re-read (mostly cached) on every turn.
 */
export const MINUTE = { turns: 4, userSeconds: 25, replySeconds: 25, contextTokensPerTurn: 2_800 };
/** OpenAI bills audio at about 10 tokens per second in, 20 per second out. */
const AUDIO_IN_TOKENS_PER_SECOND = 10;
const AUDIO_OUT_TOKENS_PER_SECOND = 20;

export interface RealtimeEngineConfig {
  /** SIBYL_REALTIME_ENGINE=off hides the premium engine. */
  enabled: boolean;
  defaultEngine: VoiceEngineId;
  /** Models offered (ids in the price table), first is the default unless SIBYL_REALTIME_MODEL says otherwise. */
  models: string[];
  defaultModel: string;
  defaultVoice: string;
  prices: Record<string, PriceEntry>;
  transcriptionModel: string;
  /** wss://… (tests and compatible endpoints). */
  url?: string;
  /** Close an idle Realtime session after this long (it reconnects with the conversation on the next turn). */
  idleMs: number;
  /** OPENAI_API_KEY on a self-hosted server (never used for hosted organizations). */
  serverKey?: string;
}

export function realtimeEngineConfig(env: NodeJS.ProcessEnv, options: { hosted?: boolean; log?: (event: string, fields?: Record<string, unknown>) => void } = {}): RealtimeEngineConfig {
  const prices = { ...DEFAULT_REALTIME_PRICES };
  const raw = env.SIBYL_REALTIME_PRICES?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<RealtimePrices> & { label?: string }>;
      for (const [id, entry] of Object.entries(parsed)) {
        if (!/^[A-Za-z0-9._:-]{1,100}$/.test(id) || !entry || typeof entry !== "object") continue;
        const base = prices[id]?.prices ?? DEFAULT_REALTIME_PRICES["gpt-realtime-2.1"]!.prices;
        const merged = { ...base };
        for (const key of Object.keys(base) as Array<keyof RealtimePrices>) {
          const value = entry[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) merged[key] = value;
        }
        prices[id] = { label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 60) : prices[id]?.label ?? id, prices: merged };
      }
    } catch {
      options.log?.("voice_engine.prices_invalid", { reason: "SIBYL_REALTIME_PRICES is not JSON" });
    }
  }
  const listed = (env.SIBYL_REALTIME_MODELS?.split(",") ?? ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"])
    .map((id) => id.trim())
    .filter((id) => id && prices[id]);
  const models = listed.length ? listed : ["gpt-realtime-2.1"];
  const wanted = env.SIBYL_REALTIME_MODEL?.trim();
  const defaultModel = wanted && prices[wanted] ? wanted : models[0]!;
  if (!models.includes(defaultModel)) models.unshift(defaultModel);
  const voice = env.SIBYL_REALTIME_VOICE?.trim().toLowerCase();
  const engineDefault = env.SIBYL_REALTIME_ENGINE_DEFAULT?.trim().toLowerCase();
  const idleSeconds = Number(env.SIBYL_REALTIME_IDLE_SECONDS);
  const serverKey = options.hosted ? undefined : env.OPENAI_API_KEY?.trim() || undefined;
  return {
    enabled: !/^(off|false|0|no)$/i.test(env.SIBYL_REALTIME_ENGINE?.trim() ?? ""),
    defaultEngine: engineDefault === "gpt-realtime" ? "gpt-realtime" : "sibyl",
    models,
    defaultModel,
    defaultVoice: voice && (REALTIME_VOICES as readonly string[]).includes(voice) ? voice : "marin",
    prices,
    transcriptionModel: env.SIBYL_REALTIME_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe",
    ...(env.SIBYL_REALTIME_URL?.trim() ? { url: env.SIBYL_REALTIME_URL.trim() } : {}),
    idleMs: Number.isFinite(idleSeconds) && idleSeconds >= 10 ? idleSeconds * 1000 : 300_000,
    ...(serverKey ? { serverKey } : {})
  };
}

/** USD for one response's tokens (cached tokens are part of the input counts). */
export function responseUsd(usage: RealtimeResponseUsage, prices: RealtimePrices): number {
  const textIn = Math.max(0, usage.inputTextTokens - usage.cachedTextTokens);
  const audioIn = Math.max(0, usage.inputAudioTokens - usage.cachedAudioTokens);
  return (
    (textIn * prices.textIn +
      usage.cachedTextTokens * prices.textInCached +
      audioIn * prices.audioIn +
      usage.cachedAudioTokens * prices.audioInCached +
      usage.outputTextTokens * prices.textOut +
      usage.outputAudioTokens * prices.audioOut) /
    1_000_000
  );
}

export function transcriptionUsd(model: string, usage: RealtimeTranscriptionUsage | undefined, seconds: number): number {
  const price = DEFAULT_TRANSCRIPTION_PRICES[model] ?? DEFAULT_TRANSCRIPTION_PRICES["gpt-4o-transcribe"]!;
  if (usage?.type === "tokens") return (usage.inputTokens * price.inputPerM + usage.outputTokens * price.outputPerM) / 1_000_000;
  const billed = usage?.type === "duration" ? usage.seconds : seconds;
  return (billed / 60) * price.perMinute;
}

/** Estimated USD per minute of conversation (see MINUTE). */
export function realtimeUsdPerMinute(prices: RealtimePrices, transcriptionModel?: string): number {
  const audioIn = MINUTE.userSeconds * AUDIO_IN_TOKENS_PER_SECOND;
  const audioOut = MINUTE.replySeconds * AUDIO_OUT_TOKENS_PER_SECOND;
  const context = MINUTE.turns * MINUTE.contextTokensPerTurn;
  // The context is mostly earlier audio, re-read from the cache.
  const usd =
    (audioIn * prices.audioIn + audioOut * prices.audioOut + context * 0.8 * prices.audioInCached + context * 0.2 * prices.textInCached) / 1_000_000;
  return round(usd + (transcriptionModel ? transcriptionUsd(transcriptionModel, undefined, MINUTE.userSeconds) : 0));
}

/** Sibyl voice per minute from a preset's cost per 100 spoken turns. */
export function sibylUsdPerMinute(costPer100Turns: number | undefined): number | undefined {
  return costPer100Turns === undefined ? undefined : round((costPer100Turns / 100) * MINUTE.turns);
}

/** Expected cost of one realtime turn (for the budget check before it starts). */
export function realtimeTurnEstimate(prices: RealtimePrices, transcriptionModel?: string): number {
  return round(realtimeUsdPerMinute(prices, transcriptionModel) / MINUTE.turns);
}

export function modelOptions(config: RealtimeEngineConfig): RealtimeModelOption[] {
  return config.models.map((id) => {
    const entry = config.prices[id]!;
    return {
      id,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      usdPerMinute: realtimeUsdPerMinute(entry.prices, config.transcriptionModel),
      prices: entry.prices
    };
  });
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}
