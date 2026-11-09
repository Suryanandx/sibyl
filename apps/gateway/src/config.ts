import {
  isOpenAIHostedUrl,
  type OpenAIRealtimeTranscriptionDelay
} from "@open-gpt-live/adapters";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_DEFAULTS = {
  llmModel: "google/gemini-3.8-flash",
  sttModel: "openai/gpt-4o-mini-transcribe",
  ttsModel: "hexgrad/kokoro-82m",
  ttsVoice: "af_heart"
} as const;

const OPENAI_DEFAULTS = {
  llmModel: "gpt-4o-mini",
  sttModel: "whisper-1",
  ttsModel: "tts-1",
  ttsVoice: "alloy"
} as const;

export interface ProviderEndpoint {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export interface GatewayRuntimeConfig {
  /** "openrouter" when the LLM goes through OpenRouter, else "openai-compatible". */
  provider: "openrouter" | "openai-compatible";
  llm: ProviderEndpoint;
  stt: ProviderEndpoint;
  tts: ProviderEndpoint;
  /** Extra headers sent to OpenRouter (attribution). */
  extraHeaders: Record<string, string>;
  genUiEnabled: boolean;
  /** Live conversation: audio-hearing voice brain + deep brain. */
  liveConversation: boolean;
  /** "auto": the model scout picks from the live OpenRouter catalog. */
  modelSelection: "auto" | "manual";
  modelStrategy: "cheapest" | "balanced" | "fastest" | "best";
  scoutProbe: boolean;
  hedge?: { voiceAfterMs: number; ttsAfterMs: number };
  scoutCacheFile?: string;
  assistantName: string;
  discoverVoices: boolean;
  host: string;
  port: number;
  allowedOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  ttsEnabled: boolean;
  ttsFormat: string;
  ttsVoice?: string;
  realtimeSttEnabled: boolean;
  realtimeSttLanguage?: string;
  realtimeSttDelay?: OpenAIRealtimeTranscriptionDelay;
}

const realtimeDelayValues = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const;

export function loadGatewayRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): GatewayRuntimeConfig {
  const port = parseInteger(env.GATEWAY_PORT, 8787, "GATEWAY_PORT", 0, 65_535);
  const production = env.NODE_ENV === "production";
  const openRouterApiKey = nonEmpty(env.OPENROUTER_API_KEY);
  const explicitProvider = optionalEnum(
    env.LLM_PROVIDER,
    ["openrouter", "openai"] as const,
    "LLM_PROVIDER"
  );
  const provider: GatewayRuntimeConfig["provider"] =
    explicitProvider === "openrouter" ||
    (explicitProvider === undefined && openRouterApiKey && !nonEmpty(env.OPENAI_BASE_URL))
      ? "openrouter"
      : "openai-compatible";
  const defaults = provider === "openrouter" ? OPENROUTER_DEFAULTS : OPENAI_DEFAULTS;

  const openAiApiKey =
    provider === "openrouter"
      ? openRouterApiKey ?? nonEmpty(env.OPENAI_API_KEY)
      : nonEmpty(env.OPENAI_API_KEY);
  const openAiBaseUrl =
    provider === "openrouter"
      ? nonEmpty(env.OPENROUTER_BASE_URL) ?? OPENROUTER_BASE_URL
      : nonEmpty(env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1";
  const sttApiKey = nonEmpty(env.STT_API_KEY) ?? openAiApiKey;
  const sttBaseUrl = nonEmpty(env.STT_BASE_URL) ?? openAiBaseUrl;
  const ttsApiKey = nonEmpty(env.TTS_API_KEY) ?? openAiApiKey;
  const ttsBaseUrl = nonEmpty(env.TTS_BASE_URL) ?? openAiBaseUrl;

  if (provider === "openrouter" && !openAiApiKey) {
    throw new Error("LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY");
  }

  if (production && isOpenAIHostedUrl(openAiBaseUrl) && !openAiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for api.openai.com when NODE_ENV=production"
    );
  }
  if (production && isOpenAIHostedUrl(sttBaseUrl) && !sttApiKey) {
    throw new Error(
      "STT_API_KEY or OPENAI_API_KEY is required for api.openai.com when NODE_ENV=production"
    );
  }

  const ttsEnabled = parseBoolean(
    env.TTS_ENABLED,
    Boolean(ttsApiKey),
    "TTS_ENABLED"
  );
  if (
    production &&
    ttsEnabled &&
    isOpenAIHostedUrl(ttsBaseUrl) &&
    !ttsApiKey
  ) {
    throw new Error(
      "TTS_API_KEY or OPENAI_API_KEY is required for api.openai.com when TTS_ENABLED=true"
    );
  }

  const realtimeSttEnabled = parseBoolean(
    env.STT_REALTIME_ENABLED,
    false,
    "STT_REALTIME_ENABLED"
  );
  if (realtimeSttEnabled && !sttApiKey) {
    throw new Error(
      "STT_REALTIME_ENABLED requires STT_API_KEY or OPENAI_API_KEY"
    );
  }

  const realtimeSttDelay = optionalEnum(
    env.STT_REALTIME_DELAY,
    realtimeDelayValues,
    "STT_REALTIME_DELAY"
  );
  const logLevel = optionalEnum(
    env.LOG_LEVEL,
    ["debug", "info", "warn", "error"] as const,
    "LOG_LEVEL"
  ) ?? "info";

  const extraHeaders: Record<string, string> =
    provider === "openrouter"
      ? {
          "HTTP-Referer":
            nonEmpty(env.OPENROUTER_SITE_URL) ?? "https://github.com/Suryanandx/sibyl",
          "X-Title": nonEmpty(env.OPENROUTER_APP_NAME) ?? "Sibyl"
        }
      : {};

  return {
    provider,
    llm: {
      apiKey: openAiApiKey,
      baseUrl: openAiBaseUrl,
      model: nonEmpty(env.OPENAI_MODEL) ?? nonEmpty(env.LLM_MODEL) ?? defaults.llmModel
    },
    stt: {
      apiKey: sttApiKey,
      baseUrl: sttBaseUrl,
      model: nonEmpty(env.STT_MODEL) ?? defaults.sttModel
    },
    tts: {
      apiKey: ttsApiKey,
      baseUrl: ttsBaseUrl,
      model: nonEmpty(env.TTS_MODEL) ?? defaults.ttsModel
    },
    extraHeaders,
    genUiEnabled: parseBoolean(env.GENUI_ENABLED, true, "GENUI_ENABLED"),
    liveConversation: parseBoolean(env.LIVE_CONVERSATION, true, "LIVE_CONVERSATION"),
    modelSelection:
      optionalEnum(env.MODEL_SELECTION, ["auto", "manual"] as const, "MODEL_SELECTION") ??
      (provider === "openrouter" ? "auto" : "manual"),
    modelStrategy:
      optionalEnum(env.MODEL_STRATEGY, ["cheapest", "balanced", "fastest", "best"] as const, "MODEL_STRATEGY") ??
      "balanced",
    scoutProbe: parseBoolean(env.SCOUT_PROBE, true, "SCOUT_PROBE"),
    ...(parseBoolean(env.HEDGE_REQUESTS, true, "HEDGE_REQUESTS")
      ? {
          hedge: {
            voiceAfterMs: parseInteger(env.HEDGE_VOICE_AFTER_MS, 1_200, "HEDGE_VOICE_AFTER_MS", 200, 30_000),
            ttsAfterMs: parseInteger(env.HEDGE_TTS_AFTER_MS, 1_500, "HEDGE_TTS_AFTER_MS", 200, 30_000)
          }
        }
      : {}),
    ...(nonEmpty(env.SCOUT_CACHE_FILE) === "off"
      ? {}
      : { scoutCacheFile: nonEmpty(env.SCOUT_CACHE_FILE) ?? ".model-scout.json" }),
    assistantName: nonEmpty(env.ASSISTANT_NAME) ?? "Sibyl",
    discoverVoices: parseBoolean(
      env.MODELS_DISCOVER_VOICES,
      provider === "openrouter",
      "MODELS_DISCOVER_VOICES"
    ),
    host: nonEmpty(env.GATEWAY_HOST) ?? "0.0.0.0",
    port,
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    logLevel,
    ttsEnabled,
    ttsFormat: nonEmpty(env.TTS_FORMAT) ?? "mp3",
    ttsVoice:
      nonEmpty(env.TTS_VOICE) ??
      (nonEmpty(env.TTS_MODEL) ? undefined : defaults.ttsVoice),
    realtimeSttEnabled,
    ...(nonEmpty(env.STT_REALTIME_LANGUAGE)
      ? { realtimeSttLanguage: nonEmpty(env.STT_REALTIME_LANGUAGE) }
      : {}),
    ...(realtimeSttDelay ? { realtimeSttDelay } : {})
  };
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function optionalEnum<const T extends readonly string[]>(
  value: string | undefined,
  choices: T,
  name: string
): T[number] | undefined {
  const normalized = nonEmpty(value);
  if (!normalized) return undefined;
  if (choices.includes(normalized)) return normalized as T[number];
  throw new Error(`${name} must be one of: ${choices.join(", ")}`);
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== entry
    ) {
      throw new Error(
        `ALLOWED_ORIGINS must contain exact http(s) origins without paths: ${entry}`
      );
    }
  }
  return entries;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
