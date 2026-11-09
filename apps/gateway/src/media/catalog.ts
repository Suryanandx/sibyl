/**
 * Media model catalogue, read from OpenRouter (never a hard-coded list):
 *
 *   GET /videos/models                        video models: durations, resolutions, aspect ratios, frames, pricing SKUs
 *   GET /images/models                        image models: typed parameter descriptors (enum / range / boolean)
 *   GET /images/models/<id>/endpoints         an image model's price lines (fetched when first needed)
 *   GET /models?output_modalities=speech      voice-over models and their voices
 *   GET /models?output_modalities=audio       music models (Lyria): price per clip from the listing
 *
 * Each model becomes a MediaModelView (the settings the UI shows) plus the
 * pricing the estimator needs. Refreshed every few hours; the last good copy
 * is kept when OpenRouter is unreachable.
 */
import type { MediaKind, MediaModelView, MediaParamSpec, MediaReferenceSupport } from "@open-gpt-live/protocol";
import type { MediaClient } from "./client.js";

/** Defaults tested live (docs/media.md); each can be changed with an env var. */
export const TESTED_DEFAULTS = {
  image: "google/gemini-2.5-flash-image",
  video: "bytedance/seedance-2.0-fast",
  speech: "hexgrad/kokoro-82m",
  music: "google/lyria-3-clip-preview"
} as const;

const REFRESH_MS = 6 * 60 * 60 * 1000;

export type ImagePriceLine = { billable: string; unit: "image" | "megapixel" | "token" | string; usd: number };

export type MediaPricing =
  | { kind: "video"; skus: Record<string, number> }
  | { kind: "image"; lines?: ImagePriceLine[] }
  | { kind: "speech"; perChar: number; perOutputToken: number }
  | { kind: "music"; perClip: number };

export interface MediaModelEntry extends MediaModelView {
  pricing: MediaPricing;
  /** Voices of a speech model. */
  voices?: string[];
  /** Pixel sizes the model lists (video): the estimator's frame size. */
  sizes?: string[];
  /** Provider options OpenRouter forwards (allowed_passthrough_parameters). */
  passthrough?: string[];
  /** Input modalities from the listing. */
  inputs: string[];
}

export interface MediaCatalogOptions {
  client: MediaClient;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class MediaCatalog {
  private entries: MediaModelEntry[] = [];
  private loadedAt = 0;
  private loading?: Promise<void>;
  private readonly expected = new Map<string, { expectedMs: number; tag?: string }>();
  private readonly now: () => number;

  constructor(private readonly options: MediaCatalogOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Default model per kind (env override, else the tested default, else the first listed). */
  defaults(): Partial<Record<MediaKind, string>> & { speech?: string; music?: string } {
    const env = this.options.env ?? {};
    const pick = (wanted: string | undefined, fallback: string, filter: (entry: MediaModelEntry) => boolean): string | undefined => {
      const candidates = this.entries.filter(filter);
      for (const id of [wanted?.trim(), fallback]) if (id && candidates.some((entry) => entry.id === id)) return id;
      return candidates[0]?.id;
    };
    const speech = pick(env.SIBYL_MEDIA_SPEECH_MODEL, TESTED_DEFAULTS.speech, (e) => e.audioKind === "speech");
    const music = pick(env.SIBYL_MEDIA_MUSIC_MODEL, TESTED_DEFAULTS.music, (e) => e.audioKind === "music");
    const image = pick(env.SIBYL_MEDIA_IMAGE_MODEL, TESTED_DEFAULTS.image, (e) => e.kind === "image");
    const video = pick(env.SIBYL_MEDIA_VIDEO_MODEL, TESTED_DEFAULTS.video, (e) => e.kind === "video");
    return {
      ...(image ? { image } : {}),
      ...(video ? { video } : {}),
      ...(speech ? { audio: speech, speech } : music ? { audio: music } : {}),
      ...(music ? { music } : {})
    };
  }

  /** The models (loading or refreshing them when stale). */
  async models(): Promise<MediaModelEntry[]> {
    if (!this.entries.length || this.now() - this.loadedAt > REFRESH_MS) await this.refresh();
    return this.entries;
  }

  /** A model from the loaded catalogue, without loading (synchronous callers). */
  peek(id: string): MediaModelEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  async get(id: string): Promise<MediaModelEntry | undefined> {
    return (await this.models()).find((entry) => entry.id === id);
  }

  /** Browser view with the defaults marked. */
  async views(): Promise<MediaModelView[]> {
    const models = await this.models();
    const defaults = new Set(Object.values(this.defaults()));
    return models.map(({ pricing: _p, voices: _v, sizes: _s, passthrough: _t, inputs: _i, ...view }) => ({ ...view, ...(defaults.has(view.id) ? { isDefault: true } : {}) }));
  }

  refresh(): Promise<void> {
    if (!this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  /** Test seam and offline use: replace the catalogue. */
  set(entries: MediaModelEntry[]): void {
    this.entries = entries;
    this.loadedAt = this.now();
  }

  private async load(): Promise<void> {
    const { client } = this.options;
    const [videos, images, speech, audio, videoListing] = await Promise.allSettled([
      client.getJson("/videos/models"),
      client.getJson("/images/models"),
      client.getJson("/models?output_modalities=speech"),
      client.getJson("/models?output_modalities=audio"),
      // The video listing has no input modalities; the general models listing does.
      client.getJson("/models?output_modalities=video")
    ]);
    const list = (result: PromiseSettledResult<unknown>): Record<string, unknown>[] => {
      if (result.status === "rejected") {
        this.options.log?.("media.catalog_failed", { error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
        return [];
      }
      const data = (result.value as { data?: unknown })?.data;
      return Array.isArray(data) ? (data.filter((item) => item && typeof item === "object") as Record<string, unknown>[]) : [];
    };
    const videoInputs = new Map(list(videoListing).map((raw) => [String(raw.id), inputsOf(raw)] as const));
    const entries = [
      ...list(images).flatMap((raw) => imageEntry(raw) ?? []),
      ...list(videos).flatMap((raw) => videoEntry(raw, videoInputs.get(String(raw.id))) ?? []),
      ...list(speech).flatMap((raw) => speechEntry(raw) ?? []),
      ...list(audio).flatMap((raw) => musicEntry(raw) ?? [])
    ];
    if (entries.length) {
      // Keep image price lines already fetched.
      const previous = new Map(this.entries.map((entry) => [entry.id, entry]));
      for (const entry of entries) {
        const old = previous.get(entry.id);
        if (entry.pricing.kind === "image" && old?.pricing.kind === "image" && old.pricing.lines) entry.pricing.lines = old.pricing.lines;
      }
      this.entries = entries;
      this.loadedAt = this.now();
      this.options.log?.("media.catalog_loaded", {
        image: entries.filter((e) => e.kind === "image").length,
        video: entries.filter((e) => e.kind === "video").length,
        speechAndMusic: entries.filter((e) => e.kind === "audio").length
      });
    } else if (!this.entries.length) {
      throw new Error("No media models could be loaded from OpenRouter.");
    }
  }

  /** An image model's price lines (fetched once from its endpoints listing). */
  async imagePricing(entry: MediaModelEntry): Promise<ImagePriceLine[]> {
    if (entry.pricing.kind !== "image") return [];
    if (entry.pricing.lines) return entry.pricing.lines;
    try {
      const body = (await this.options.client.getJson(`/images/models/${entry.id}/endpoints`)) as { endpoints?: Array<{ pricing?: unknown }> };
      const lines: ImagePriceLine[] = [];
      for (const endpoint of body.endpoints ?? []) {
        for (const line of Array.isArray(endpoint.pricing) ? endpoint.pricing : []) {
          const raw = line as { billable?: unknown; unit?: unknown; cost_usd?: unknown };
          const usd = Number(raw.cost_usd);
          if (typeof raw.billable === "string" && typeof raw.unit === "string" && Number.isFinite(usd)) lines.push({ billable: raw.billable, unit: raw.unit, usd });
        }
        if (lines.length) break;
      }
      entry.pricing.lines = lines;
      entry.priceLabel = imagePriceLabel(lines) ?? entry.priceLabel;
      return lines;
    } catch (error) {
      this.options.log?.("media.image_pricing_failed", { model: entry.id, error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /**
   * The model's first provider endpoint: its slug (provider options are keyed
   * by it) and the typical time it takes (p50 latency), for progress.
   */
  async endpoint(entry: MediaModelEntry): Promise<{ expectedMs: number; tag?: string }> {
    const known = this.expected.get(entry.id);
    if (known) return known;
    const info: { expectedMs: number; tag?: string } = { expectedMs: entry.kind === "video" ? 150_000 : 20_000 };
    try {
      const body = (await this.options.client.getJson(`/models/${entry.id}/endpoints`)) as {
        data?: { endpoints?: Array<{ tag?: string; perf_last_30m_by_workload?: Record<string, { latency?: { p50?: number } }>; latency_last_30m?: { p50?: number } }> };
      };
      const endpoint = body.data?.endpoints?.[0];
      const p50 = endpoint?.perf_last_30m_by_workload?.video_generation?.latency?.p50 ?? endpoint?.latency_last_30m?.p50;
      if (typeof p50 === "number" && p50 > 1_000) info.expectedMs = p50;
      if (typeof endpoint?.tag === "string") info.tag = endpoint.tag.split("/")[0]!;
      this.expected.set(entry.id, info);
    } catch {
      // Keep the fallback (asked again next time).
    }
    return info;
  }
}

/* ───────────── listing → entry ───────────── */

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function short(description: unknown): string | undefined {
  const text = str(description);
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, " ").replace(/\.\.\.$/, "…");
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean;
}

function inputsOf(raw: Record<string, unknown>): string[] {
  return strings((raw.architecture as { input_modalities?: unknown } | undefined)?.input_modalities);
}

/** How the prompt names references, by model family (Seedance and Wan docs). */
export function referenceSyntax(id: string): MediaReferenceSupport["syntax"] {
  if (/seedance/i.test(id)) return "seedance";
  if (/(^|\/)wan-/i.test(id)) return "wan";
  return "plain";
}

const LABELS: Record<string, string> = {
  aspect_ratio: "Aspect ratio",
  resolution: "Resolution",
  quality: "Quality",
  n: "Images",
  seed: "Seed",
  background: "Background",
  output_format: "Format",
  duration: "Duration (s)",
  generate_audio: "Sound",
  negative_prompt: "Avoid (negative prompt)",
  enhance_prompt: "Enhance prompt",
  voice: "Voice",
  instrumental: "Instrumental"
};

function imageEntry(raw: Record<string, unknown>): MediaModelEntry | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  const supported = (raw.supported_parameters ?? {}) as Record<string, { type?: string; values?: unknown[]; min?: number; max?: number }>;
  // Vector (SVG-only) models are left out: SVG can carry scripts, so it is never stored as an image.
  const formats = supported.output_format?.values?.filter((value): value is string => typeof value === "string") ?? [];
  if (formats.length && formats.every((format) => format === "svg")) return undefined;
  const params: MediaParamSpec[] = [];
  for (const key of ["aspect_ratio", "resolution", "quality", "n", "background", "seed"] as const) {
    const spec = supported[key];
    if (!spec) continue;
    if (spec.type === "enum" && Array.isArray(spec.values) && spec.values.length) {
      const values = spec.values.filter((value): value is string => typeof value === "string" && value !== "svg");
      if (values.length > 1) params.push({ key, label: LABELS[key]!, type: "enum", values, default: key === "aspect_ratio" && values.includes("1:1") ? "1:1" : key === "quality" && values.includes("auto") ? "auto" : values[0]! });
    } else if (spec.type === "range" && key === "n" && typeof spec.max === "number" && spec.max > 1) {
      params.push({ key, label: LABELS[key]!, type: "range", min: Math.max(1, spec.min ?? 1), max: Math.min(4, spec.max), step: 1, default: 1 });
    } else if (spec.type === "boolean" && key === "seed") {
      params.push({ key, label: LABELS[key]!, type: "range", min: 0, max: 2_147_483_647, step: 1, help: "Same seed and settings give a similar result." });
    }
  }
  const maxRefs = supported.input_references?.max;
  return {
    id,
    name: str(raw.name) ?? id,
    kind: "image",
    ...(short(raw.description) ? { description: short(raw.description)! } : {}),
    params,
    references: { images: typeof maxRefs === "number" ? Math.max(0, maxRefs) : 0, videos: 0, audio: 0, frames: [], syntax: "plain" },
    priceLabel: "price on first use",
    pricing: { kind: "image" },
    inputs: strings((raw.architecture as { input_modalities?: unknown } | undefined)?.input_modalities)
  };
}

function videoEntry(raw: Record<string, unknown>, listedInputs?: string[]): MediaModelEntry | undefined {
  const id = str(raw.id);
  const durations = Array.isArray(raw.supported_durations) ? raw.supported_durations.filter((d): d is number => typeof d === "number").sort((a, b) => a - b) : [];
  // Edit / upscale / avatar models need a source video or avatar, not a prompt: not offered for creation.
  if (!id || !durations.length) return undefined;
  const resolutions = strings(raw.supported_resolutions);
  const ratios = strings(raw.supported_aspect_ratios);
  const frames = strings(raw.supported_frame_images).filter((f): f is "first_frame" | "last_frame" => f === "first_frame" || f === "last_frame");
  const passthrough = strings(raw.allowed_passthrough_parameters);
  const params: MediaParamSpec[] = [];
  const preferred = (values: string[], wanted: string[]) => wanted.find((value) => values.includes(value)) ?? values[0]!;
  if (ratios.length > 1) params.push({ key: "aspect_ratio", label: LABELS.aspect_ratio!, type: "enum", values: ratios, default: preferred(ratios, ["16:9"]) });
  if (resolutions.length > 1) params.push({ key: "resolution", label: LABELS.resolution!, type: "enum", values: sortResolutions(resolutions), default: preferred(resolutions, ["720p", "768p", "480p"]) });
  params.push({ key: "duration", label: LABELS.duration!, type: "enum", values: durations, default: durations.find((d) => d >= 5) ?? durations[durations.length - 1]! });
  if (raw.generate_audio === true) params.push({ key: "generate_audio", label: LABELS.generate_audio!, type: "boolean", default: true, help: "Generate sound with the video (costs more on some models)." });
  if (raw.seed === true) params.push({ key: "seed", label: LABELS.seed!, type: "range", min: 0, max: 2_147_483_647, step: 1 });
  if (passthrough.includes("negative_prompt") || passthrough.includes("negativePrompt")) params.push({ key: "negative_prompt", label: LABELS.negative_prompt!, type: "text" });
  if (passthrough.some((key) => key === "enhancePrompt" || key === "prompt_extend" || key === "enable_prompt_expansion" || key === "prompt_optimizer")) {
    params.push({ key: "enhance_prompt", label: LABELS.enhance_prompt!, type: "boolean", default: false, help: "Let the model rewrite the prompt with more detail." });
  }
  const skus: Record<string, number> = {};
  for (const [key, value] of Object.entries((raw.pricing_skus ?? {}) as Record<string, unknown>)) {
    const n = Number(value);
    if (Number.isFinite(n)) skus[key] = n;
  }
  const inputs = listedInputs?.length ? listedInputs : inputsOf(raw);
  const syntax = referenceSyntax(id);
  const description = short(raw.description) ?? "";
  const mentionsReferences = /reference/i.test(description) || Object.keys(skus).some((key) => /reference/.test(key));
  const references: MediaReferenceSupport = {
    // Seedance 2.x: up to 9 images, 3 videos, 3 audio (12 files). Wan: 5 images + videos combined.
    images: syntax === "seedance" ? (inputs.includes("video") ? 9 : 0) : syntax === "wan" ? 5 : mentionsReferences ? 3 : 0,
    videos: syntax === "seedance" && inputs.includes("video") ? 3 : 0,
    audio: syntax === "seedance" && inputs.includes("audio") ? 3 : 0,
    frames,
    syntax
  };
  return {
    id,
    name: str(raw.name) ?? id,
    kind: "video",
    ...(description ? { description } : {}),
    params,
    references,
    priceLabel: videoPriceLabel(skus),
    pricing: { kind: "video", skus },
    sizes: strings(raw.supported_sizes),
    passthrough,
    inputs
  };
}

function speechEntry(raw: Record<string, unknown>): MediaModelEntry | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  const voices = strings(raw.supported_voices);
  const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const perChar = Number(pricing.prompt) || 0;
  const perOutputToken = Number(pricing.completion) || 0;
  const params: MediaParamSpec[] = voices.length ? [{ key: "voice", label: LABELS.voice!, type: "enum", values: voices, default: voices[0]! }] : [];
  return {
    id,
    name: str(raw.name) ?? id,
    kind: "audio",
    audioKind: "speech",
    ...(short(raw.description) ? { description: short(raw.description)! } : {}),
    params,
    references: { images: 0, videos: 0, audio: 0, frames: [], syntax: "plain" },
    priceLabel: perChar > 0 ? `${usd(perChar * 1_000_000)} / 1M chars` : perOutputToken > 0 ? `${usd(perOutputToken * 1_000_000)} / 1M audio tokens` : "free",
    pricing: { kind: "speech", perChar, perOutputToken },
    voices,
    inputs: inputsOf(raw)
  };
}

function musicEntry(raw: Record<string, unknown>): MediaModelEntry | undefined {
  const id = str(raw.id);
  const description = str(raw.description) ?? "";
  // Only music models: chat models that also speak (gpt-audio) are not media models.
  if (!id || !/music|song|lyria/i.test(`${id} ${description}`)) return undefined;
  const price = /\$([\d.]+)\s+per\s+(clip|song)/i.exec(description);
  const perClip = price ? Number(price[1]) : 0.08;
  return {
    id,
    name: str(raw.name) ?? id,
    kind: "audio",
    audioKind: "music",
    ...(short(description) ? { description: short(description)! } : {}),
    params: [{ key: "instrumental", label: LABELS.instrumental!, type: "boolean", default: true, help: "No vocals." }],
    references: { images: 0, videos: 0, audio: 0, frames: [], syntax: "plain" },
    priceLabel: `${usd(perClip)} / ${price?.[2]?.toLowerCase() ?? "clip"}`,
    pricing: { kind: "music", perClip },
    inputs: inputsOf(raw)
  };
}

const RESOLUTION_ORDER = ["360p", "480p", "540p", "720p", "768p", "1K", "1080p", "1.5K", "2K", "4K"];
function sortResolutions(values: string[]): string[] {
  const rank = (value: string) => {
    const index = RESOLUTION_ORDER.indexOf(value);
    return index < 0 ? 99 : index;
  };
  return [...values].sort((a, b) => rank(a) - rank(b));
}

export function usd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(value >= 0.1 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toPrecision(2)}`;
}

/** "$0.05–0.20 / s" from the per-second SKUs (cents converted); token-priced models say so. */
export function videoPriceLabel(skus: Record<string, number>): string {
  const perSecond: number[] = [];
  for (const [key, value] of Object.entries(skus)) {
    if (/continuation|minimum|image|reference_images|long_/.test(key)) continue;
    if (/^cents_per/.test(key) && /second/.test(key)) perSecond.push(value / 100);
    else if (/duration_seconds/.test(key)) perSecond.push(value);
  }
  if (perSecond.length) {
    const low = Math.min(...perSecond);
    const high = Math.max(...perSecond);
    return low === high ? `${usd(low)} / s` : `${usd(low)}–${usd(high).slice(1)} / s`;
  }
  const tokens = Object.entries(skus).filter(([key]) => /^video_tokens/.test(key) && !/video_input/.test(key));
  if (tokens.length) {
    // ≈ cost of one second of 720p at 24 fps (tokens = width × height × fps × seconds / 1024).
    const perToken = Math.max(...tokens.map(([, value]) => value));
    return `≈${usd(((1280 * 720 * 24) / 1024) * perToken)} / s at 720p`;
  }
  return "see OpenRouter";
}

export function imagePriceLabel(lines: ImagePriceLine[]): string | undefined {
  const output = lines.find((line) => line.billable === "output_image");
  if (!output) return undefined;
  if (output.unit === "image") return `${usd(output.usd)} / image`;
  if (output.unit === "megapixel") return `${usd(output.usd)} / megapixel`;
  if (output.unit === "token") return `≈${usd(output.usd * 1_300)} / image`;
  return undefined;
}
