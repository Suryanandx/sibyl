/**
 * Metered provider decorators: every LLM, STT and TTS call made through the
 * gateway's providers is recorded on the UsageMeter, with the provider's
 * reported cost when available and an estimate otherwise.
 *
 * Call sites label calls with `options.meta` ({ feature, requestId,
 * sessionId, conversationId }); `meta.metering === "off"` skips recording
 * (for callers that record their own usage).
 */
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamChunk,
  ProviderCallOptions,
  ProviderUsage,
  STTAudioInput,
  STTProvider,
  StreamingSTTEvent,
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSTTSessionOptions,
  TTSProvider,
  TTSStreamChunk,
  TTSSynthesisInput
} from "@open-gpt-live/adapters";
import type { UsageFeature, UsageMeter } from "@open-gpt-live/core";
import type { ModelCatalog } from "@open-gpt-live/protocol";
import { GatewayUsageMeter, type RecordInput } from "./meter.js";
import { CostEstimator, PricingTable, estimateAudioSeconds, estimatePromptTokens } from "./pricing.js";

export interface MeterableProviders {
  llm: LLMProvider;
  stt: STTProvider;
  streamingStt?: StreamingSTTProvider;
  tts?: TTSProvider;
}

export interface MeteringContext {
  meter: UsageMeter;
  ownerId: string;
  /** Current model catalog (for estimates from costPer100Turns). */
  catalog?: () => ModelCatalog | undefined;
}

/** Realtime transcription (OpenAI gpt-4o-transcribe) is about $0.006 per minute. */
export const REALTIME_STT_USD_PER_SECOND = 0.0001;

const FEATURES: readonly UsageFeature[] = [
  "voice",
  "brain",
  "stt",
  "tts",
  "slides",
  "routine",
  "tool",
  "scout",
  "warmup"
];

export function meterProviders<T extends MeterableProviders>(providers: T, context: MeteringContext): T {
  const pricing = context.meter instanceof GatewayUsageMeter ? context.meter.pricing : new PricingTable();
  const estimator = new CostEstimator(pricing, context.catalog ?? (() => undefined));
  const recorder = new Recorder(context, estimator);
  return {
    ...providers,
    llm: new MeteredLLMProvider(providers.llm, recorder),
    stt: new MeteredSTTProvider(providers.stt, recorder),
    ...(providers.streamingStt ? { streamingStt: new MeteredStreamingSTTProvider(providers.streamingStt, recorder) } : {}),
    ...(providers.tts ? { tts: new MeteredTTSProvider(providers.tts, recorder) } : {})
  };
}

class Recorder {
  constructor(
    private readonly context: MeteringContext,
    readonly estimate: CostEstimator
  ) {}

  enabled(options: ProviderCallOptions | undefined): boolean {
    return options?.meta?.metering !== "off";
  }

  feature(options: ProviderCallOptions | undefined, fallback: UsageFeature): UsageFeature {
    const feature = options?.meta?.feature;
    return feature && (FEATURES as readonly string[]).includes(feature) ? (feature as UsageFeature) : fallback;
  }

  record(
    options: ProviderCallOptions | undefined,
    event: Omit<RecordInput, "ownerId" | "requestId" | "conversationId" | "sessionId">
  ): void {
    const meta = options?.meta ?? {};
    try {
      this.context.meter.record({
        ownerId: meta.ownerId ?? this.context.ownerId,
        ...event,
        ...(meta.requestId ? { requestId: meta.requestId } : {}),
        ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
        ...(meta.routineId ? { routineId: meta.routineId } : {}),
        ...(meta.sessionId ? { sessionId: meta.sessionId } : {})
      } as RecordInput);
    } catch {
      // Metering must never break a conversation.
    }
  }
}

function withUsage(options: ProviderCallOptions, sink: (usage: ProviderUsage) => void): ProviderCallOptions {
  return {
    ...options,
    onUsage: (usage) => {
      sink(usage);
      options.onUsage?.(usage);
    }
  };
}

class MeteredLLMProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly recorder: Recorder
  ) {}

  async *streamText(messages: LLMMessage[], options: ProviderCallOptions = {}): AsyncIterable<LLMStreamChunk> {
    if (!this.recorder.enabled(options)) {
      yield* this.inner.streamText(messages, options);
      return;
    }
    let usage: ProviderUsage | undefined;
    let outputChars = 0;
    let started = false;
    try {
      for await (const chunk of this.inner.streamText(messages, withUsage(options, (u) => (usage = u)))) {
        started = true;
        outputChars += chunk.delta.length;
        yield chunk;
      }
    } finally {
      if (started || usage) {
        const feature = this.recorder.feature(options, "voice");
        const model = options.model ?? "default";
        const promptTokens = usage?.promptTokens ?? estimatePromptTokens(messages);
        const completionTokens = usage?.completionTokens ?? Math.ceil(outputChars / 4);
        const actual = usage?.costUsd;
        this.recorder.record(options, {
          feature,
          model,
          costUsd: actual ?? this.recorder.estimate.llm(feature, options.model, promptTokens, completionTokens),
          estimated: actual === undefined,
          promptTokens,
          completionTokens
        });
      }
    }
  }
}

class MeteredSTTProvider implements STTProvider {
  constructor(
    private readonly inner: STTProvider,
    private readonly recorder: Recorder
  ) {}

  async transcribe(input: STTAudioInput, options: ProviderCallOptions = {}): Promise<{ text: string }> {
    if (!this.recorder.enabled(options)) return this.inner.transcribe(input, options);
    let usage: ProviderUsage | undefined;
    const result = await this.inner.transcribe(input, withUsage(options, (u) => (usage = u)));
    const seconds = usage?.seconds ?? estimateAudioSeconds(input.data, input.mimeType);
    const actual = (usage as ProviderUsage | undefined)?.costUsd;
    this.recorder.record(options, {
      feature: this.recorder.feature(options, "stt"),
      model: options.model ?? "default",
      costUsd: actual ?? this.recorder.estimate.stt(options.model, seconds),
      estimated: actual === undefined,
      units: Math.round(seconds * 10) / 10,
      ...(usage?.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
      ...(usage?.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {})
    });
    return result;
  }
}

class MeteredTTSProvider implements TTSProvider {
  constructor(
    private readonly inner: TTSProvider,
    private readonly recorder: Recorder
  ) {}

  /** Keep `configured` (and other getters) of the wrapped provider visible. */
  get configured(): boolean | undefined {
    return (this.inner as { configured?: boolean }).configured;
  }

  async *synthesize(input: TTSSynthesisInput, options: ProviderCallOptions = {}): AsyncIterable<TTSStreamChunk> {
    if (!this.recorder.enabled(options)) {
      yield* this.inner.synthesize(input, options);
      return;
    }
    let usage: ProviderUsage | undefined;
    let bytes = 0;
    try {
      for await (const chunk of this.inner.synthesize(input, withUsage(options, (u) => (usage = u)))) {
        bytes += chunk.audio.byteLength;
        yield chunk;
      }
    } finally {
      if (bytes > 0 || usage) {
        const actual = (usage as ProviderUsage | undefined)?.costUsd;
        this.recorder.record(options, {
          feature: this.recorder.feature(options, "tts"),
          model: options.model ?? "default",
          costUsd: actual ?? this.recorder.estimate.tts(options.model, input.text.length),
          estimated: actual === undefined,
          units: input.text.length
        });
      }
    }
  }
}

class MeteredStreamingSTTProvider implements StreamingSTTProvider {
  constructor(
    private readonly inner: StreamingSTTProvider,
    private readonly recorder: Recorder
  ) {}

  async createSession(options?: StreamingSTTSessionOptions & { meta?: Record<string, string | undefined> }): Promise<StreamingSTTSession> {
    const session = await this.inner.createSession(options);
    const callOptions: ProviderCallOptions = { meta: options?.meta };
    if (!this.recorder.enabled(callOptions)) return session;
    let bytes = 0;
    let recorded = false;
    const record = (): void => {
      if (recorded || bytes === 0) return;
      recorded = true;
      const format = session.inputFormat;
      const bytesPerSecond = Math.max(1, format.sampleRateHz * format.channels * 2);
      const seconds = bytes / bytesPerSecond;
      this.recorder.record(callOptions, {
        feature: this.recorder.feature(callOptions, "stt"),
        model: "realtime-transcription",
        costUsd: seconds * REALTIME_STT_USD_PER_SECOND,
        estimated: true,
        units: Math.round(seconds * 10) / 10
      });
    };
    return {
      get inputFormat() {
        return session.inputFormat;
      },
      appendAudio(audio: Uint8Array) {
        bytes += audio.byteLength;
        session.appendAudio(audio);
      },
      commit() {
        session.commit();
      },
      close(code?: number, reason?: string) {
        record();
        session.close(code, reason);
      },
      async *[Symbol.asyncIterator](): AsyncIterator<StreamingSTTEvent> {
        try {
          yield* session;
        } finally {
          record();
        }
      }
    };
  }
}
