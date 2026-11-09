/**
 * Cost estimates for calls whose provider reports no cost (TTS, most STT,
 * aborted streams, scout probes) and for budget checks before a call.
 *
 * Two sources, best first:
 * 1. OpenRouter per-unit pricing captured from /models (see PricingTable.ingest).
 * 2. The model catalog's `costPer100Turns`, scaled by actual vs typical units.
 */
import type { UsageFeature } from "@open-gpt-live/core";
import type { ModelCatalog, ModelOption } from "@open-gpt-live/protocol";
import {
  USAGE,
  llmCost,
  price,
  sttCost,
  ttsCost,
  voiceCost,
  type OpenRouterModel
} from "../scout.js";

/** OpenRouter /models pricing per model id. */
export class PricingTable {
  private readonly models = new Map<string, OpenRouterModel>();

  ingest(models: OpenRouterModel[]): void {
    for (const model of models) {
      if (model?.id && model.pricing) this.models.set(model.id, model);
    }
  }

  get(id: string | undefined): OpenRouterModel | undefined {
    return id ? this.models.get(id) : undefined;
  }

  get size(): number {
    return this.models.size;
  }
}

type Role = "voice" | "llm" | "stt" | "tts";

export class CostEstimator {
  constructor(
    private readonly pricing: PricingTable,
    private readonly catalog: () => ModelCatalog | undefined
  ) {}

  /** Typical cost of one call (one turn) of this feature on this model. */
  turn(feature: UsageFeature, model: string | undefined): number {
    const role = roleFor(feature);
    const priced = this.pricing.get(model);
    if (priced) {
      const reasoning = priced.supported_parameters?.includes("reasoning") ?? false;
      switch (role) {
        case "voice":
          return voiceCost(priced, false);
        case "llm":
          return llmCost(priced, reasoning);
        case "stt":
          return sttCost(priced);
        case "tts":
          return ttsCost(priced);
      }
    }
    return this.catalogTurnCost(role, model) ?? 0;
  }

  /** Chat completion cost from token counts. */
  llm(feature: UsageFeature, model: string | undefined, promptTokens: number, completionTokens: number): number {
    const priced = this.pricing.get(model);
    if (priced) {
      return price(priced, "prompt") * promptTokens + price(priced, "completion") * completionTokens;
    }
    const role = roleFor(feature);
    const perTurn = this.catalogTurnCost(role, model);
    if (perTurn === undefined) return 0;
    // Completion tokens usually cost ~4x prompt tokens.
    const typical = role === "voice" ? USAGE.voice : USAGE.llm;
    const weight = (prompt: number, completion: number) => prompt + completion * 4;
    return perTurn * (weight(promptTokens, completionTokens) / weight(typical.prompt, typical.completion));
  }

  /** Transcription cost for this many seconds of audio. */
  stt(model: string | undefined, seconds: number): number {
    const priced = this.pricing.get(model);
    if (priced && price(priced, "completion") === 0) return price(priced, "prompt") * seconds;
    const perTurn = priced ? sttCost(priced) : this.catalogTurnCost("stt", model);
    return perTurn === undefined ? 0 : perTurn * (seconds / USAGE.sttSeconds);
  }

  /** Speech cost for this many characters. */
  tts(model: string | undefined, characters: number): number {
    const priced = this.pricing.get(model);
    if (priced && price(priced, "completion") === 0) return price(priced, "prompt") * characters;
    const perTurn = priced ? ttsCost(priced) : this.catalogTurnCost("tts", model);
    return perTurn === undefined ? 0 : perTurn * (characters / USAGE.ttsChars);
  }

  private catalogTurnCost(role: Role, model: string | undefined): number | undefined {
    const catalog = this.catalog();
    if (!catalog) return undefined;
    const list: ModelOption[] | undefined =
      role === "voice" ? catalog.voice : role === "llm" ? catalog.llm : role === "stt" ? catalog.stt : catalog.tts;
    const option = (model ? list?.find((m) => m.id === model) : undefined) ?? (model ? undefined : list?.[0]);
    return option?.costPer100Turns !== undefined ? option.costPer100Turns / 100 : undefined;
  }
}

function roleFor(feature: UsageFeature): Role {
  switch (feature) {
    case "voice":
    case "warmup":
      return "voice";
    case "stt":
      return "stt";
    case "tts":
      return "tts";
    default:
      return "llm";
  }
}

/** Rough token count of chat messages (text ~4 chars/token, audio ~10 tokens/s). */
export function estimatePromptTokens(
  messages: Array<{ content: string | Array<{ type: string; text?: string; input_audio?: { data: string } }> }>
): number {
  let tokens = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      tokens += Math.ceil(message.content.length / 4) + 4;
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text" && part.text) tokens += Math.ceil(part.text.length / 4);
      if (part.type === "input_audio" && part.input_audio) {
        // base64 → bytes → seconds of 16 kHz PCM16 → ~10 audio tokens per second.
        const seconds = (part.input_audio.data.length * 0.75) / 32_000;
        tokens += Math.ceil(seconds * 10);
      }
    }
    tokens += 4;
  }
  return tokens;
}

/** Seconds of audio in an upload: exact for WAV, a bitrate guess otherwise. */
export function estimateAudioSeconds(data: Uint8Array, mimeType: string): number {
  if (/wav/i.test(mimeType) && data.byteLength > 44) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const byteRate = view.getUint32(28, true);
    if (byteRate > 0) return (data.byteLength - 44) / byteRate;
  }
  if (/pcm/i.test(mimeType)) {
    const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 16_000);
    return data.byteLength / (rate * 2);
  }
  // Compressed speech (webm/opus, mp4/aac) runs around 32 kbit/s.
  return data.byteLength / 4_000;
}
