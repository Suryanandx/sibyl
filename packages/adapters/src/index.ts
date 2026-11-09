export type LLMRole = "system" | "user" | "assistant";

export * from "./streaming-stt";
export * from "./chat-tools";

/** OpenAI-style content parts; input_audio lets audio-native models hear the user. */
export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } };

export interface LLMMessage {
  role: LLMRole;
  content: string | LLMContentPart[];
}

export interface LLMStreamChunk {
  delta: string;
}

export interface ProviderCallOptions {
  signal?: AbortSignal;
  /** Per-call model override (e.g. a model chosen by the user in the UI). */
  model?: string;
  /**
   * Extra provider-specific request fields merged into the request body,
   * e.g. OpenRouter's `{ reasoning: { effort: "low" } }` or `{ provider: {...} }`.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Called with the usage the provider reports for this call (OpenRouter's
   * final `usage` chunk with `cost`, or an STT response's `usage`). Not called
   * when the provider reports nothing; callers then estimate.
   */
  onUsage?: (usage: ProviderUsage) => void;
  /**
   * Opaque caller labels (feature, request id, ...) for decorators such as
   * cost metering. Never sent to the provider.
   */
  meta?: Record<string, string | undefined>;
}

/** Usage reported by a model call (same shape as core's ModelUsage, plus audio units). */
export interface ProviderUsage {
  /** Actual USD cost when the provider reports it (OpenRouter `usage.cost`). */
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Seconds of audio billed (transcription priced per duration). */
  seconds?: number;
}

export interface STTAudioInput {
  data: Uint8Array;
  mimeType: string;
  filename?: string;
}

export interface TTSSynthesisInput {
  text: string;
  voice?: string;
  format?: string;
  sampleRate?: number;
}

export interface TTSStreamChunk {
  audio: Uint8Array;
  mimeType: string;
  format: string;
  sampleRate?: number;
  channels?: number;
}

export interface LLMProvider {
  streamText(
    messages: LLMMessage[],
    options?: ProviderCallOptions
  ): AsyncIterable<LLMStreamChunk>;
}

export interface STTProvider {
  transcribe(input: STTAudioInput, options?: ProviderCallOptions): Promise<{
    text: string;
  }>;
}

export interface TTSProvider {
  synthesize(
    input: TTSSynthesisInput,
    options?: ProviderCallOptions
  ): AsyncIterable<TTSStreamChunk>;
}

export interface OpenAILLMProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Extra request headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  extraHeaders?: Record<string, string>;
}

export interface OpenAIWhisperProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Extra request headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  extraHeaders?: Record<string, string>;
}

export interface OpenAITTSProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: string;
  extraHeaders?: Record<string, string>;
}

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  usage?: unknown;
}

/** Normalize an OpenAI/OpenRouter `usage` object into ProviderUsage. */
export function parseProviderUsage(value: unknown): ProviderUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const candidate = raw[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return undefined;
  };
  const usage: ProviderUsage = {};
  const costUsd = num("cost");
  const promptTokens = num("prompt_tokens", "input_tokens");
  const completionTokens = num("completion_tokens", "output_tokens");
  const seconds = num("seconds");
  if (costUsd !== undefined) usage.costUsd = costUsd;
  if (promptTokens !== undefined) usage.promptTokens = promptTokens;
  if (completionTokens !== undefined) usage.completionTokens = completionTokens;
  if (seconds !== undefined) usage.seconds = seconds;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export class OpenAILLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAILLMProviderConfig = {}) {
    this.extraHeaders = config.extraHeaders ?? {};
    this.apiKey = firstNonEmpty(config.apiKey, process.env.OPENAI_API_KEY) ?? "";
    this.baseUrl = stripTrailingSlash(
      firstNonEmpty(config.baseUrl, process.env.OPENAI_BASE_URL) ??
        "https://api.openai.com/v1"
    );
    this.model =
      firstNonEmpty(config.model, process.env.OPENAI_MODEL) ?? "gpt-4o-mini";
  }

  async *streamText(
    messages: LLMMessage[],
    options: ProviderCallOptions = {}
  ): AsyncIterable<LLMStreamChunk> {
    if (!this.apiKey && isOpenAIHostedUrl(this.baseUrl)) {
      throw new Error("OPENAI_API_KEY is required");
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        ...authorizationHeader(this.apiKey),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // OpenRouter reports the real cost in the final chunk when asked.
        ...(isOpenRouterUrl(this.baseUrl) ? { usage: { include: true } } : {}),
        ...options.extraBody,
        model: options.model ?? this.model,
        messages,
        stream: true
      }),
      signal: options.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible API error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error("OpenAI-compatible API returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          for (const data of readSseDataLines(event)) {
            if (data === "[DONE]") {
              return;
            }

            const parsed = JSON.parse(data) as OpenAIChatCompletionChunk;
            const usage = parseProviderUsage(parsed.usage);
            if (usage) {
              options.onUsage?.(usage);
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              yield { delta };
            }
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

export class OpenAIWhisperProvider implements STTProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAIWhisperProviderConfig = {}) {
    this.extraHeaders = config.extraHeaders ?? {};
    this.apiKey = firstNonEmpty(
      config.apiKey,
      process.env.STT_API_KEY,
      process.env.OPENAI_API_KEY
    ) ?? "";
    this.baseUrl = stripTrailingSlash(
      firstNonEmpty(
        config.baseUrl,
        process.env.STT_BASE_URL,
        process.env.OPENAI_BASE_URL
      ) ??
        "https://api.openai.com/v1"
    );
    this.model = firstNonEmpty(config.model, process.env.STT_MODEL) ?? "whisper-1";
  }

  async transcribe(
    input: STTAudioInput,
    options: ProviderCallOptions = {}
  ): Promise<{ text: string }> {
    if (!this.apiKey && isOpenAIHostedUrl(this.baseUrl)) {
      throw new Error("STT_API_KEY or OPENAI_API_KEY is required");
    }

    const formData = new FormData();
    formData.append("model", options.model ?? this.model);
    formData.append(
      "file",
      new Blob([input.data], { type: input.mimeType }),
      input.filename ?? filenameForMimeType(input.mimeType)
    );

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        ...authorizationHeader(this.apiKey)
      },
      body: formData,
      signal: options.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible STT API error ${response.status}: ${body}`);
    }

    const parsed = (await response.json()) as { text?: unknown; usage?: unknown };
    if (typeof parsed.text !== "string") {
      throw new Error("OpenAI-compatible STT API returned no text");
    }
    const usage = parseProviderUsage(parsed.usage);
    if (usage) {
      options.onUsage?.(usage);
    }

    return { text: parsed.text };
  }
}

export class OpenAITTSProvider implements TTSProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly format: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAITTSProviderConfig = {}) {
    this.extraHeaders = config.extraHeaders ?? {};
    this.apiKey = firstNonEmpty(
      config.apiKey,
      process.env.TTS_API_KEY,
      process.env.OPENAI_API_KEY
    ) ?? "";
    this.baseUrl = stripTrailingSlash(
      firstNonEmpty(
        config.baseUrl,
        process.env.TTS_BASE_URL,
        process.env.OPENAI_BASE_URL
      ) ??
        "https://api.openai.com/v1"
    );
    this.model = firstNonEmpty(config.model, process.env.TTS_MODEL) ?? "tts-1";
    this.voice = firstNonEmpty(config.voice, process.env.TTS_VOICE) ?? "alloy";
    this.format = firstNonEmpty(config.format, process.env.TTS_FORMAT) ?? "mp3";
  }

  get configured(): boolean {
    return this.apiKey.length > 0 || !isOpenAIHostedUrl(this.baseUrl);
  }

  async *synthesize(
    input: TTSSynthesisInput,
    options: ProviderCallOptions = {}
  ): AsyncIterable<TTSStreamChunk> {
    if (!this.apiKey && isOpenAIHostedUrl(this.baseUrl)) {
      throw new Error("TTS_API_KEY or OPENAI_API_KEY is required");
    }

    const format = input.format ?? this.format;
    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        ...authorizationHeader(this.apiKey),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model ?? this.model,
        input: input.text,
        voice: input.voice ?? this.voice,
        response_format: format
      }),
      signal: options.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible TTS API error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error("OpenAI-compatible TTS API returned no response body");
    }

    const reader = response.body.getReader();
    const mimeType = mimeTypeForAudioFormat(format);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        yield {
          audio: value,
          mimeType,
          format,
          sampleRate: input.sampleRate
        };
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

/**
 * True for hosted providers that always require an API key (OpenAI, OpenRouter).
 * Self-hosted OpenAI-compatible servers (Ollama, Speaches, ...) may run keyless.
 */
export function isOpenAIHostedUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "api.openai.com" || isOpenRouterUrl(value);
  } catch {
    // Invalid provider URLs should not accidentally bypass credential checks.
    return true;
  }
}

export function isOpenRouterUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function authorizationHeader(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function filenameForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) {
    return "recording.webm";
  }
  if (mimeType.includes("mp4")) {
    return "recording.mp4";
  }
  if (mimeType.includes("mpeg")) {
    return "recording.mp3";
  }
  if (mimeType.includes("wav")) {
    return "recording.wav";
  }
  return "recording.webm";
}

function mimeTypeForAudioFormat(format: string): string {
  switch (format) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/ogg; codecs=opus";
    case "pcm":
      return "audio/pcm";
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

function readSseDataLines(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
}
