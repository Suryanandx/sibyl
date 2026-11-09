/**
 * Model scout: picks cost-efficient models for every role from the live
 * OpenRouter catalog instead of a hand-maintained list.
 *
 * For each role it filters the catalog by capability, estimates cost per turn
 * from OpenRouter pricing, reads quality from OpenRouter's Design Arena
 * benchmarks, measures latency with tiny live probes, and ranks candidates
 * under three strategies: cheapest, balanced, best.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  ModelCatalog,
  ModelOption,
  ModelPreset,
  SessionSettings,
  TtsModelOption
} from "@open-gpt-live/protocol";
import { PROBE_AUDIO_WAV_BASE64 } from "./probe-audio.js";

export type Strategy = "cheapest" | "balanced" | "fastest" | "best";
export const STRATEGIES: Strategy[] = ["cheapest", "balanced", "fastest", "best"];
type Role = "voice" | "llm" | "stt" | "tts";

/** Subset of an OpenRouter /models entry that the scout reads. */
export interface OpenRouterModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  description?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, string | undefined>;
  supported_parameters?: string[];
  supported_voices?: string[] | null;
  expiration_date?: string | null;
  benchmarks?: Record<string, Array<{ arena?: string; category?: string; elo?: number }>>;
}

export interface ScoutCandidate {
  role: Role;
  id: string;
  label: string;
  /** Estimated USD per conversational turn. */
  costPerTurn: number;
  elo?: number;
  latencyMs?: number;
  params?: Record<string, unknown>;
  /** Reasoning settings to try in order; the first the model accepts wins. */
  reasoningVariants?: Array<Record<string, unknown> | undefined>;
  /** Part of costPerTurn that is reasoning tokens (removed if reasoning is off). */
  reasoningCostPerTurn?: number;
  voices?: string[];
  defaultVoice?: string;
  format?: string;
  emotionTags?: boolean;
  scores: Record<Strategy, number>;
}

export interface ScoutResult {
  generatedAt: string;
  strategy: Strategy;
  catalog: ModelCatalog;
  defaults: Partial<SessionSettings>;
  /** Server-side request params per model id (reasoning effort, provider routing). */
  llmParams: Record<string, Record<string, unknown>>;
  candidates: ScoutCandidate[];
}

export interface ScoutOptions {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  strategy?: Strategy;
  /** Models shown per role. */
  perRole?: number;
  /** Live latency probes (a few tiny paid requests, cached). */
  probe?: boolean;
  allowFree?: boolean;
  cacheFile?: string;
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Real prompts make latency probes representative (prompt size, reasoning). */
  probePrompts?: { voice?: string; brain?: string };
}

/** Typical usage per turn, used to turn per-token prices into per-turn cost. */
export const USAGE = {
  voice: { prompt: 1_800, audio: 160, completion: 80, reasoning: 150 },
  llm: { prompt: 16_000, completion: 1_300, reasoning: 400 },
  sttSeconds: 6,
  sttTokens: { prompt: 150, completion: 40 },
  ttsChars: 160,
  ttsTokens: { prompt: 45, completion: 200 }
} as const;

const WEIGHTS: Record<Strategy, { quality: number; cost: number; latency: number }> = {
  cheapest: { quality: 0.5, cost: 2, latency: 0.6 },
  balanced: { quality: 1, cost: 0.8, latency: 1 },
  fastest: { quality: 0.5, cost: 0.1, latency: 3 },
  best: { quality: 2.5, cost: 0.15, latency: 0.5 }
};
/** How much latency matters per role (voice is the most latency-critical). */
const ROLE_LATENCY_WEIGHT: Record<Role, number> = { voice: 1.6, llm: 0.5, stt: 0.3, tts: 1.3 };
/** How much quality matters per role: the deep brain designs the visuals. */
const ROLE_QUALITY_WEIGHT: Record<Role, number> = { voice: 1, llm: 2, stt: 1, tts: 1 };
/**
 * Latency budgets per strategy (voice/llm: first token; tts: slowest of three
 * first-audio probes). Candidates over budget are heavily penalized.
 */
const LATENCY_BUDGET_MS: Record<Strategy, Partial<Record<Role, number>>> = {
  cheapest: { voice: 3_000, tts: 3_500, llm: 10_000 },
  balanced: { voice: 2_000, tts: 1_800, llm: 5_000 },
  fastest: { voice: 1_600, tts: 1_200, llm: 3_000 },
  best: { voice: 2_500, tts: 2_500, llm: 8_000 }
};
const UI_CATEGORIES = ["uicomponent", "dataviz", "website"];
const TTS_CATEGORIES = ["text-to-speech", "audiorealism"];
const TRUSTED_STT_AUTHORS = ["openai", "deepgram", "elevenlabs", "mistralai", "assemblyai", "google", "nvidia", "microsoft"];
const PREFERRED_VOICES = ["sarah", "af_heart", "Kore", "aura-2-thalia-en", "en_paul_neutral", "alloy", "jessica"];
const MAX_AGE_DAYS = 600;
/** Bump when scoring or probing changes so stale caches are re-scouted. */
const CACHE_VERSION = 6;

export async function scoutModels(options: ScoutOptions): Promise<ScoutResult> {
  const now = options.now ?? Date.now;
  const strategy = options.strategy ?? "balanced";
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const log = options.log ?? (() => undefined);

  const cached = readCache(options.cacheFile, maxAgeMs, now());
  let candidates: ScoutCandidate[];
  if (cached) {
    candidates = cached.candidates;
    log("scout.cache_hit", { generatedAt: cached.generatedAt });
  } else {
    const models = await fetchCatalog(options);
    candidates = applyQualityFloor(
      rankCandidates(models, { allowFree: options.allowFree ?? false, now: now() })
    );
    if (options.probe !== false) {
      candidates = await probeCandidates(candidates, options, log);
    }
  }
  // Always re-score: cached candidates may predate a scoring change.
  candidates = scoreAll(candidates.map((c) => ({ ...c, scores: { cheapest: 0, balanced: 0, fastest: 0, best: 0 } })));

  const result = buildResult(candidates, strategy, options.perRole ?? 6, new Date(now()));
  if (!cached && options.cacheFile) {
    try {
      writeFileSync(
        options.cacheFile,
        JSON.stringify({ version: CACHE_VERSION, generatedAt: result.generatedAt, candidates }, null, 1)
      );
    } catch {
      // Cache is optional.
    }
  }
  return result;
}

async function fetchCatalog(options: ScoutOptions): Promise<OpenRouterModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // The default listing only covers text-output models; speech and
  // transcription models must be requested explicitly.
  const queries = ["", "?output_modalities=speech", "?output_modalities=transcription"];
  const pages = await Promise.all(
    queries.map(async (query) => {
      const response = await fetchImpl(`${trimSlash(options.baseUrl)}/models${query}`, {
        headers: { ...options.extraHeaders, Authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`OpenRouter /models${query} failed: ${response.status}`);
      const body = (await response.json()) as { data?: OpenRouterModel[] };
      return body.data ?? [];
    })
  );
  const byId = new Map<string, OpenRouterModel>();
  for (const model of pages.flat()) byId.set(model.id, model);
  return [...byId.values()];
}

/** Filter the catalog per role and compute static signals (cost, quality). */
export function rankCandidates(
  models: OpenRouterModel[],
  options: { allowFree: boolean; now: number }
): ScoutCandidate[] {
  const out: ScoutCandidate[] = [];
  for (const model of models) {
    if (!isUsable(model, options)) continue;
    const input = model.architecture?.input_modalities ?? [];
    const output = model.architecture?.output_modalities ?? [];
    const label = cleanLabel(model);
    const reasoning = model.supported_parameters?.includes("reasoning") ?? false;
    const base = { id: model.id, label, scores: { cheapest: 0, balanced: 0, fastest: 0, best: 0 } };

    if (output.includes("speech")) {
      const voices = model.supported_voices ?? [];
      if (voices.length === 0) continue;
      out.push({
        ...base,
        role: "tts",
        costPerTurn: ttsCost(model),
        elo: meanElo(model, TTS_CATEGORIES),
        voices,
        defaultVoice: voices.find((voice) => PREFERRED_VOICES.includes(voice)) ?? voices[0],
        emotionTags: /eleven-v3|audio tags|inline tags|\[laughs\]/i.test(`${model.id} ${model.description ?? ""}`)
      });
      continue;
    }
    if (output.includes("transcription")) {
      const author = model.id.split("/")[0] ?? "";
      if (!TRUSTED_STT_AUTHORS.includes(author) || /medical|streaming/i.test(model.id)) continue;
      out.push({ ...base, role: "stt", costPerTurn: sttCost(model) });
      continue;
    }
    if (!output.includes("text") || output.some((m) => m !== "text")) continue;
    if (!input.includes("text")) continue;

    if (input.includes("audio") && (model.context_length ?? 0) >= 32_000) {
      // The voice brain should answer instantly: prefer reasoning off.
      out.push({
        ...base,
        role: "voice",
        costPerTurn: voiceCost(model, false),
        elo: meanElo(model),
        params: {
          ...(reasoning ? { reasoning: { enabled: false } } : {}),
          provider: { sort: "latency" }
        },
        ...(reasoning
          ? {
              reasoningVariants: [{ enabled: false }, { effort: "low" }, undefined],
              reasoningCostPerTurn:
                price(model, "internal_reasoning", price(model, "completion")) * USAGE.voice.reasoning
            }
          : {})
      });
    }
    const uiElo = meanElo(model, UI_CATEGORIES);
    if (uiElo !== undefined && (model.context_length ?? 0) >= 64_000) {
      out.push({
        ...base,
        role: "llm",
        costPerTurn: llmCost(model, reasoning),
        elo: uiElo,
        params: {
          ...(reasoning ? { reasoning: { effort: "low" } } : {}),
          provider: { sort: "throughput" }
        },
        ...(reasoning ? { reasoningVariants: [{ effort: "low" }, undefined] } : {})
      });
    }
  }
  return out;
}

function isUsable(model: OpenRouterModel, options: { allowFree: boolean; now: number }): boolean {
  const id = model.id;
  if (!id || id.startsWith("~") || id.includes(":batch") || /^(openrouter|stealth)\//.test(id)) return false;
  if (!options.allowFree && id.endsWith(":free")) return false;
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion ?? 0);
  if (!Number.isFinite(prompt) || prompt < 0 || completion < 0) return false;
  if (!options.allowFree && prompt === 0 && completion === 0) return false;
  if (model.expiration_date && Date.parse(model.expiration_date) < options.now + 30 * 86_400_000) return false;
  if (model.created && options.now / 1000 - model.created > MAX_AGE_DAYS * 86_400) return false;
  return true;
}

export function price(model: OpenRouterModel, key: string, fallback = 0): number {
  const value = Number(model.pricing?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function voiceCost(model: OpenRouterModel, reasoning: boolean): number {
  const prompt = price(model, "prompt");
  const completion = price(model, "completion");
  return (
    prompt * USAGE.voice.prompt +
    price(model, "audio", prompt) * USAGE.voice.audio +
    completion * USAGE.voice.completion +
    (reasoning ? price(model, "internal_reasoning", completion) * USAGE.voice.reasoning : 0)
  );
}

export function llmCost(model: OpenRouterModel, reasoning: boolean): number {
  const completion = price(model, "completion");
  return (
    price(model, "prompt") * USAGE.llm.prompt +
    completion * USAGE.llm.completion +
    (reasoning ? price(model, "internal_reasoning", completion) * USAGE.llm.reasoning : 0)
  );
}

export function sttCost(model: OpenRouterModel): number {
  const completion = price(model, "completion");
  // Flat-priced transcription is billed per second of audio; token-priced
  // models (e.g. gpt-4o-mini-transcribe) bill audio input + text output tokens.
  return completion === 0
    ? price(model, "prompt") * USAGE.sttSeconds
    : price(model, "prompt") * USAGE.sttTokens.prompt + completion * USAGE.sttTokens.completion;
}

export function ttsCost(model: OpenRouterModel): number {
  const completion = price(model, "completion");
  // Flat-priced voices bill per character; token-priced ones per audio token.
  return completion === 0
    ? price(model, "prompt") * USAGE.ttsChars
    : price(model, "prompt") * USAGE.ttsTokens.prompt + completion * USAGE.ttsTokens.completion;
}

function meanElo(model: OpenRouterModel, categories?: string[]): number | undefined {
  const entries = Object.values(model.benchmarks ?? {})
    .flat()
    .filter(
      (entry) =>
        entry.arena === "models" &&
        typeof entry.elo === "number" &&
        (!categories || categories.includes(entry.category ?? ""))
    );
  if (entries.length === 0) return undefined;
  return entries.reduce((sum, entry) => sum + (entry.elo ?? 0), 0) / entries.length;
}

/** Probe the most promising candidates per role for real latency. */
async function probeCandidates(
  candidates: ScoutCandidate[],
  options: ScoutOptions,
  log: NonNullable<ScoutOptions["log"]>
): Promise<ScoutCandidate[]> {
  const preliminary = scoreAll(candidates);
  const toProbe: ScoutCandidate[] = [];
  for (const role of ["voice", "llm", "tts"] as Role[]) {
    const pool = preliminary.filter((c) => c.role === role);
    const picked = new Set<ScoutCandidate>();
    for (const strategy of STRATEGIES) {
      // Voice is the most latency-sensitive role, so look at more candidates.
      const breadth = role === "voice" ? 10 : role === "tts" ? 6 : 4;
      [...pool].sort((a, b) => b.scores[strategy] - a.scores[strategy]).slice(0, breadth).forEach((c) => picked.add(c));
    }
    toProbe.push(...picked);
  }

  const failed = new Set<string>();
  // A few at a time: firing every probe at once skews the latency numbers.
  await mapWithConcurrency(toProbe, 5, async (candidate) => {
      try {
        const result: { latencyMs: number; format?: string; reasoning?: Record<string, unknown> | null } =
          candidate.role === "tts"
            ? await probeTts(candidate, options)
            : await probeChat(candidate, options);
        candidate.latencyMs = result.latencyMs;
        if (result.format) candidate.format = result.format;
        if (result.reasoning !== undefined && candidate.params) {
          const { reasoning: _reasoning, ...rest } = candidate.params;
          candidate.params = result.reasoning ? { ...rest, reasoning: result.reasoning } : rest;
          // Reasoning stayed on (model requires it): count its tokens.
          if (candidate.role === "voice" && result.reasoning && !("enabled" in result.reasoning)) {
            candidate.costPerTurn += candidate.reasoningCostPerTurn ?? 0;
          }
        }
      } catch (error) {
        failed.add(`${candidate.role}:${candidate.id}`);
        log("scout.probe_failed", { role: candidate.role, id: candidate.id, error: String(error).slice(0, 160) });
      }
  });
  log("scout.probed", {
    probed: toProbe.length,
    failed: failed.size,
    latency: Object.fromEntries(
      toProbe.filter((c) => c.latencyMs !== undefined).map((c) => [`${c.role}:${c.id}`, c.latencyMs])
    )
  });
  // A voice that takes more than 4 s to start talking doesn't feel live.
  return candidates.filter(
    (c) =>
      !failed.has(`${c.role}:${c.id}`) &&
      !(c.role === "voice" && c.latencyMs !== undefined && c.latencyMs > 4_000)
  );
}

async function probeChat(
  candidate: ScoutCandidate,
  options: ScoutOptions
): Promise<{ latencyMs: number; reasoning?: Record<string, unknown> | null }> {
  const attempt = async (params: Record<string, unknown> | undefined) => {
    const started = performance.now();
    const response = await (options.fetchImpl ?? fetch)(`${trimSlash(options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        ...options.extraHeaders,
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...params,
        model: candidate.id,
        stream: true,
        max_tokens: 400,
        messages:
          candidate.role === "voice"
            ? [
                {
                  role: "system",
                  content: options.probePrompts?.voice ?? "You are a friendly voice assistant. Answer in one short sentence."
                },
                {
                  role: "user",
                  content: [
                    { type: "input_audio", input_audio: { data: PROBE_AUDIO_WAV_BASE64, format: "wav" } }
                  ]
                }
              ]
            : [
                {
                  role: "system",
                  content: options.probePrompts?.brain ?? "You are a helpful assistant."
                },
                {
                  role: "user",
                  content: "Task from the voice: Show the three largest planets with their diameters."
                }
              ]
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (/"content":"[^"]/.test(buffer)) return performance.now() - started;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error("no content");
  };
  // Two runs (the first includes connection/cold-start cost); report the mean.
  const measure = async (params: Record<string, unknown> | undefined) => {
    const first = await attempt(params);
    const second = await attempt(params).catch(() => first);
    return Math.round((first + second) / 2);
  };
  const variants = candidate.reasoningVariants ?? [candidate.params?.reasoning as Record<string, unknown> | undefined];
  const { reasoning: _reasoning, ...rest } = candidate.params ?? {};
  let lastError: unknown;
  // Some models reject a reasoning setting (e.g. can't disable it); try the next.
  for (const reasoning of variants) {
    try {
      const latencyMs = await measure(reasoning ? { ...rest, reasoning } : rest);
      return { latencyMs, reasoning: reasoning ?? null };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function probeTts(
  candidate: ScoutCandidate,
  options: ScoutOptions
): Promise<{ latencyMs: number; format?: string }> {
  const attempt = async (format: string) => {
    const started = performance.now();
    const response = await (options.fetchImpl ?? fetch)(`${trimSlash(options.baseUrl)}/audio/speech`, {
      method: "POST",
      headers: {
        ...options.extraHeaders,
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: candidate.id,
        input: "Hi there!",
        voice: candidate.defaultVoice,
        response_format: format
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(`${response.status} ${text.slice(0, 160)}`), { body: text });
    }
    const reader = response.body!.getReader();
    try {
      const { value } = await reader.read();
      if (!value?.length) throw new Error("no audio");
      return performance.now() - started;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
  // Judge voices by their slowest of three starts: a voice that is usually
  // fast but sometimes takes seconds feels broken in a live conversation.
  const worstOfThree = async (format: string) => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i += 1) runs.push(await attempt(format));
    return Math.round(Math.max(...runs));
  };
  try {
    return { latencyMs: await worstOfThree("mp3") };
  } catch (error) {
    // Some voices only produce raw PCM; the Gateway wraps that as WAV.
    if (!/pcm/i.test(String((error as { body?: string }).body ?? error))) throw error;
    return { latencyMs: await worstOfThree("pcm"), format: "pcm" };
  }
}

/**
 * Deep brains must write good UI: drop the bottom half by UI benchmark so a
 * very cheap model with weak UI scores can't win on price alone.
 */
export function applyQualityFloor(candidates: ScoutCandidate[]): ScoutCandidate[] {
  const elos = candidates
    .filter((c) => c.role === "llm" && c.elo !== undefined)
    .map((c) => c.elo!)
    .sort((a, b) => a - b);
  if (elos.length < 5) return candidates;
  const floor = elos[Math.floor(elos.length * 0.5)]!;
  return candidates.filter((c) => c.role !== "llm" || (c.elo ?? 0) >= floor);
}

/** Compute per-strategy scores relative to the other candidates of the same role. */
export function scoreAll(candidates: ScoutCandidate[]): ScoutCandidate[] {
  for (const role of ["voice", "llm", "stt", "tts"] as Role[]) {
    const pool = candidates.filter((c) => c.role === role);
    if (pool.length === 0) continue;
    const elos = pool.map((c) => c.elo).filter((v): v is number => v !== undefined);
    const minElo = Math.min(...elos);
    const maxElo = Math.max(...elos);
    const medianCost = median(pool.map((c) => c.costPerTurn).filter((v) => v > 0)) || 1;
    const latencies = pool.map((c) => c.latencyMs).filter((v): v is number => v !== undefined);
    const medianLatency = median(latencies) || 1;
    for (const candidate of pool) {
      // Benchmarked models range 0.7–1.5 relative to each other; models
      // without a benchmark are assumed slightly below average (0.85).
      const quality =
        candidate.elo === undefined
          ? 0.85
          : maxElo === minElo
            ? 1.3
            : 0.7 + (0.8 * (candidate.elo - minElo)) / (maxElo - minElo);
      const cost = Math.max(candidate.costPerTurn, medianCost * 0.02) / medianCost;
      const latency = candidate.latencyMs === undefined ? 1.3 : Math.max(candidate.latencyMs, 150) / medianLatency;
      for (const strategy of STRATEGIES) {
        const w = WEIGHTS[strategy];
        let score =
          quality ** (w.quality * ROLE_QUALITY_WEIGHT[role]) /
          (cost ** w.cost * latency ** (w.latency * ROLE_LATENCY_WEIGHT[role]));
        // Live conversation needs hard-ish latency limits: no price is cheap
        // enough to make a slow voice feel right.
        const budget = LATENCY_BUDGET_MS[strategy][role];
        if (budget !== undefined) {
          if (candidate.latencyMs === undefined) score *= 0.5;
          else if (candidate.latencyMs > budget) score *= 0.1;
        }
        candidate.scores[strategy] = score;
      }
    }
  }
  return candidates;
}

function buildResult(
  candidates: ScoutCandidate[],
  strategy: Strategy,
  perRole: number,
  generatedAt: Date
): ScoutResult {
  const byRole = (role: Role) => candidates.filter((c) => c.role === role);
  const best = (role: Role, s: Strategy) =>
    [...byRole(role)].sort((a, b) => b.scores[s] - a.scores[s])[0];

  const shown = (role: Role): ScoutCandidate[] => {
    const pool = byRole(role);
    const picks = new Set<ScoutCandidate>();
    for (const s of STRATEGIES) {
      const top = best(role, s);
      if (top) picks.add(top);
    }
    for (const candidate of [...pool].sort((a, b) => b.scores.balanced - a.scores.balanced)) {
      if (picks.size >= perRole) break;
      picks.add(candidate);
    }
    return [...picks].sort((a, b) => b.scores[strategy] - a.scores[strategy]);
  };

  const presetTags = (c: ScoutCandidate): Strategy[] =>
    STRATEGIES.filter((s) => best(c.role, s) === c);
  const toOption = (c: ScoutCandidate): ModelOption => ({
    id: c.id,
    label: c.label,
    description: describe(c, presetTags(c)),
    costPer100Turns: round(c.costPerTurn * 100, 4),
    ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
    ...(c.elo !== undefined ? { elo: Math.round(c.elo) } : {})
  });
  const toTts = (c: ScoutCandidate): TtsModelOption => ({
    ...toOption(c),
    voices: c.voices,
    ...(c.defaultVoice ? { defaultVoice: c.defaultVoice } : {}),
    ...(c.format ? { format: c.format, sampleRate: 24_000 } : {}),
    ...(c.emotionTags ? { emotionTags: true } : {})
  });

  const presetSettings = (s: Strategy): Partial<SessionSettings> => {
    const voice = best("voice", s);
    const llm = best("llm", s);
    const stt = best("stt", s);
    const tts = best("tts", s);
    return {
      ...(voice ? { voiceModel: voice.id } : {}),
      ...(llm ? { llmModel: llm.id } : {}),
      ...(stt ? { sttModel: stt.id } : {}),
      ...(tts ? { ttsModel: tts.id, ...(tts.defaultVoice ? { ttsVoice: tts.defaultVoice } : {}) } : {})
    };
  };
  const presets: ModelPreset[] = STRATEGIES.map((s) => {
    const settings = presetSettings(s);
    const cost = (["voice", "llm", "stt", "tts"] as Role[]).reduce((sum, role) => {
      const id = role === "voice" ? settings.voiceModel : role === "llm" ? settings.llmModel : role === "stt" ? settings.sttModel : settings.ttsModel;
      const candidate = byRole(role).find((c) => c.id === id);
      // The deep brain runs on some turns only; assume about one in three.
      return sum + (candidate ? candidate.costPerTurn * (role === "llm" ? 0.33 : 1) : 0);
    }, 0);
    return {
      id: s,
      label:
        s === "cheapest" ? "Cheapest" : s === "balanced" ? "Balanced" : s === "fastest" ? "Fastest" : "Best quality",
      settings,
      costPer100Turns: round(cost * 100, 3)
    };
  });

  const llmParams: Record<string, Record<string, unknown>> = {};
  for (const c of candidates) {
    if ((c.role === "voice" || c.role === "llm") && c.params) {
      llmParams[c.id] = { ...llmParams[c.id], ...c.params };
    }
  }

  return {
    generatedAt: generatedAt.toISOString(),
    strategy,
    catalog: {
      voice: shown("voice").map(toOption),
      llm: shown("llm").map(toOption),
      stt: shown("stt").map(toOption),
      tts: shown("tts").map(toTts),
      presets
    },
    defaults: presetSettings(strategy),
    llmParams,
    candidates
  };
}

function describe(c: ScoutCandidate, tags: Strategy[]): string {
  const parts: string[] = [];
  if (tags.length) {
    parts.push(tags.map((t) => (t === "best" ? "best quality" : t)).join(" & ") + " pick");
  }
  parts.push(`≈$${formatUsd(c.costPerTurn * 100)}/100 turns`);
  if (c.latencyMs !== undefined) parts.push(`${(c.latencyMs / 1000).toFixed(1)}s`);
  if (c.elo !== undefined) parts.push(`Elo ${Math.round(c.elo)}`);
  if (c.emotionTags) parts.push("performs emotion cues");
  return parts.join(" · ");
}

/** True when a scout cache newer than maxAgeMs exists (startup can await it). */
export function hasFreshScoutCache(file: string | undefined, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  return readCache(file, maxAgeMs, Date.now()) !== undefined;
}

function readCache(
  file: string | undefined,
  maxAgeMs: number,
  now: number
): { generatedAt: string; candidates: ScoutCandidate[] } | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as {
      version?: number;
      generatedAt: string;
      candidates: ScoutCandidate[];
    };
    if (
      cached.version !== CACHE_VERSION ||
      now - Date.parse(cached.generatedAt) > maxAgeMs ||
      !Array.isArray(cached.candidates)
    ) {
      return undefined;
    }
    return cached;
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item);
    }
  });
  await Promise.all(workers);
}

function cleanLabel(model: OpenRouterModel): string {
  const name = model.name ?? model.id;
  return name.includes(": ") ? name.split(": ").slice(1).join(": ") : name;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatUsd(value: number): string {
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(3);
  return value.toPrecision(2);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
