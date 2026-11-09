/**
 * Optional embeddings (SIBYL_EMBEDDINGS_MODEL, e.g. "openai/text-embedding-3-small").
 *
 * Calls the provider's OpenAI-compatible `POST {baseUrl}/embeddings`
 * (OpenRouter supports it) with the same key as the LLM. Every call checks
 * the budget first and is metered (feature "tool"): the provider-reported
 * cost when present, else an estimate from SIBYL_EMBEDDINGS_USD_PER_MTOK
 * (default $0.02 per million tokens). Without the env var, nothing here runs
 * and knowledge search is keyword-only.
 */
import type { UsageMeter } from "@open-gpt-live/core";
import { loadGatewayRuntimeConfig } from "../config.js";
import { estimateTokens } from "./chunk.js";

export type EmbedFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface EmbeddingsOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  usdPerMillionTokens: number;
  meter: UsageMeter;
  ownerId: string;
  fetch?: EmbedFetch;
  /** Inputs per request (default 64). */
  batchSize?: number;
}

export class EmbeddingsError extends Error {}

export class EmbeddingsClient {
  readonly model: string;
  private readonly fetchImpl: EmbedFetch;

  constructor(private readonly options: EmbeddingsOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** One vector per text (same order). Throws EmbeddingsError on budget or provider errors. */
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    const batch = this.options.batchSize ?? 64;
    for (let start = 0; start < texts.length; start += batch) {
      out.push(...(await this.embedBatch(texts.slice(start, start + batch).map((text) => text.slice(0, 24_000)), signal)));
    }
    return out;
  }

  private async embedBatch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const tokens = input.reduce((total, text) => total + estimateTokens(text), 0);
    const estimate = (tokens / 1_000_000) * this.options.usdPerMillionTokens;
    const decision = this.options.meter.check({ ownerId: this.options.ownerId, estimateUsd: estimate });
    if (!decision.allowed) throw new EmbeddingsError(decision.message);
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...(this.options.extraHeaders ?? {})
      },
      body: JSON.stringify({ model: this.model, input }),
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EmbeddingsError(`embeddings request failed (HTTP ${response.status})`);
    }
    const body = (await response.json()) as {
      data?: Array<{ embedding?: unknown; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
    };
    const data = Array.isArray(body.data) ? body.data : [];
    if (data.length !== input.length) throw new EmbeddingsError("embeddings response has the wrong number of vectors");
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map((item) => {
      if (!Array.isArray(item.embedding) || !item.embedding.every((n) => typeof n === "number")) throw new EmbeddingsError("embeddings response is malformed");
      return item.embedding as number[];
    });
    const promptTokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? tokens;
    const reported = typeof body.usage?.cost === "number" && Number.isFinite(body.usage.cost) ? body.usage.cost : undefined;
    this.options.meter.record({
      ownerId: this.options.ownerId,
      feature: "tool",
      model: this.model,
      costUsd: reported ?? (promptTokens / 1_000_000) * this.options.usdPerMillionTokens,
      estimated: reported === undefined,
      promptTokens
    });
    return vectors;
  }
}

/** The embeddings client configured by env, or undefined (keyword search only). */
export function embeddingsFromEnv(input: {
  env: NodeJS.ProcessEnv;
  meter: UsageMeter;
  ownerId: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): EmbeddingsClient | undefined {
  const model = input.env.SIBYL_EMBEDDINGS_MODEL?.trim();
  if (!model) return undefined;
  try {
    const config = loadGatewayRuntimeConfig(input.env);
    const price = Number(input.env.SIBYL_EMBEDDINGS_USD_PER_MTOK);
    return new EmbeddingsClient({
      model,
      baseUrl: input.env.SIBYL_EMBEDDINGS_BASE_URL?.trim() || config.llm.baseUrl,
      ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
      ...(config.extraHeaders ? { extraHeaders: config.extraHeaders } : {}),
      usdPerMillionTokens: Number.isFinite(price) && price >= 0 && input.env.SIBYL_EMBEDDINGS_USD_PER_MTOK?.trim() ? price : 0.02,
      meter: input.meter,
      ownerId: input.ownerId
    });
  } catch (error) {
    input.log?.("knowledge.embeddings_unavailable", { error: (error as Error).message });
    return undefined;
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    na += a[index]! * a[index]!;
    nb += b[index]! * b[index]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
