/**
 * What a media request will cost, before it is sent: the budget check and the
 * approval threshold both use this. Prices come from the model's listing
 * (catalog.ts); OpenRouter's actual cost replaces the estimate afterwards.
 *
 * Video SKUs come in three shapes:
 *   duration_seconds[_with_audio|_without_audio][_<res>]   USD per second
 *   cents_per_…second…[_<res>]                            cents per second
 *   video_tokens[_<res>][_without_audio|_with_video_input] USD per token,
 *      tokens = width × height × 24 fps × seconds / 1024 (Seedance; matched
 *      a measured job: 864×496, 4.04 s → $0.1706; the estimate adds 5%)
 * plus per-image input fees and a minimum per generation.
 */
import type { MediaModelEntry, ImagePriceLine } from "./catalog.js";

export interface EstimateInput {
  settings: Record<string, string | number | boolean>;
  /** Reference and frame images / videos / audio sent with the request. */
  references: { images: number; videos: number; audio: number; frames: number };
  prompt: string;
}

export interface Estimate {
  usd: number;
  /** How it was worked out, for the details panel. */
  detail: string;
}

const TOKEN_MARGIN = 1.05;
const RES_HEIGHT: Record<string, number> = { "360p": 360, "480p": 480, "540p": 540, "720p": 720, "768p": 768, "1080p": 1080, "1k": 1080, "2k": 1440, "4k": 2160 };

/** Width × height of a video request (listed size for the ratio when there is one). */
export function videoFrame(entry: MediaModelEntry, settings: EstimateInput["settings"]): { width: number; height: number } {
  const resolution = String(settings.resolution ?? defaultOf(entry, "resolution") ?? "720p").toLowerCase();
  const ratio = String(settings.aspect_ratio ?? defaultOf(entry, "aspect_ratio") ?? "16:9");
  const [rw, rh] = ratio.split(":").map(Number) as [number, number];
  const short = RES_HEIGHT[resolution] ?? 720;
  const landscape = !(rw && rh) || rw >= rh;
  const long = rw && rh ? Math.round((short * Math.max(rw, rh)) / Math.min(rw, rh)) : Math.round((short * 16) / 9);
  let width = landscape ? long : short;
  let height = landscape ? short : long;
  // Providers render on a 16-pixel grid.
  width = Math.ceil(width / 16) * 16;
  height = Math.ceil(height / 16) * 16;
  return { width, height };
}

function defaultOf(entry: MediaModelEntry, key: string): string | number | boolean | undefined {
  return entry.params.find((param) => param.key === key)?.default;
}

export function durationOf(entry: MediaModelEntry, settings: EstimateInput["settings"]): number {
  const value = Number(settings.duration ?? defaultOf(entry, "duration") ?? 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

interface Sku {
  key: string;
  value: number;
  unit: "usd_s" | "cents_s" | "token" | "image_fee" | "minimum";
  res?: string;
  audio?: boolean;
  mode?: "t2v" | "i2v" | "reference" | "long" | "continuation" | "video_input";
}

function parseSku(key: string, value: number): Sku | undefined {
  const lower = key.toLowerCase();
  const res = /(360p|480p|540p|720p|768p|1080p|2k|4k)/.exec(lower)?.[1];
  const audio = /without_audio/.test(lower) ? false : /with_audio/.test(lower) ? true : undefined;
  const mode: Sku["mode"] = /continuation/.test(lower)
    ? "continuation"
    : /video_input/.test(lower)
      ? "video_input"
      : /^long_/.test(lower)
        ? "long"
        : /^reference_duration|reference_input_images|^reference_images/.test(lower)
          ? "reference"
          : /image_to_video/.test(lower)
            ? "i2v"
            : /text_to_video/.test(lower)
              ? "t2v"
              : undefined;
  const base = { key, value, ...(res ? { res } : {}), ...(audio !== undefined ? { audio } : {}), ...(mode ? { mode } : {}) };
  if (/minimum/.test(lower)) return { ...base, unit: "minimum" };
  if (/image_input|input_images|reference_images/.test(lower)) return { ...base, unit: "image_fee" };
  if (/^video_tokens/.test(lower)) return { ...base, unit: "token" };
  if (/^cents_per/.test(lower) && /second/.test(lower)) return { ...base, unit: "cents_s" };
  if (/duration_seconds/.test(lower)) return { ...base, unit: "usd_s" };
  return undefined;
}

/** The SKUs that apply: same resolution (else unmarked), matching audio and mode; the highest wins (never under-estimate). */
function pickRate(skus: Sku[], want: { res: string; audio: boolean; mode: Sku["mode"] }): Sku | undefined {
  const rated = skus.filter((sku) => sku.unit === "usd_s" || sku.unit === "cents_s" || sku.unit === "token");
  const allowedModes = new Set<Sku["mode"]>([undefined, want.mode]);
  let pool = rated.filter((sku) => allowedModes.has(sku.mode));
  if (!pool.length) pool = rated.filter((sku) => sku.mode !== "continuation" && sku.mode !== "long");
  const byRes = pool.filter((sku) => sku.res === want.res);
  pool = byRes.length ? byRes : pool.filter((sku) => sku.res === undefined).length ? pool.filter((sku) => sku.res === undefined) : pool;
  const byAudio = pool.filter((sku) => sku.audio === want.audio);
  pool = byAudio.length ? byAudio : pool.filter((sku) => sku.audio === undefined).length ? pool.filter((sku) => sku.audio === undefined) : pool;
  const modeMatch = pool.filter((sku) => sku.mode === want.mode && want.mode !== undefined);
  if (modeMatch.length) pool = modeMatch;
  return pool.sort((a, b) => perSecond(b) - perSecond(a))[0];
}

function perSecond(sku: Sku): number {
  if (sku.unit === "cents_s") return sku.value / 100;
  if (sku.unit === "token") return sku.value * ((1280 * 720 * 24) / 1024);
  return sku.value;
}

export function estimateVideo(entry: MediaModelEntry, input: EstimateInput): Estimate {
  if (entry.pricing.kind !== "video") return { usd: 0, detail: "no price listed" };
  const seconds = durationOf(entry, input.settings);
  const resolution = String(input.settings.resolution ?? defaultOf(entry, "resolution") ?? "720p").toLowerCase();
  const audioParam = entry.params.some((param) => param.key === "generate_audio");
  const audio = audioParam ? input.settings.generate_audio !== false : false;
  const mode: Sku["mode"] = input.references.videos > 0 ? "video_input" : input.references.images > 0 ? "reference" : input.references.frames > 0 ? "i2v" : "t2v";
  const skus = Object.entries(entry.pricing.skus).flatMap(([key, value]) => parseSku(key, value) ?? []);
  const rate = pickRate(skus, { res: resolution, audio, mode });
  let usd = 0;
  let detail = "no price listed";
  if (rate?.unit === "token") {
    const { width, height } = videoFrame(entry, input.settings);
    // Providers render a little more than asked (864×496 for 480p, 4.04 s for 4 s): +5%.
    const tokens = ((width * height * 24 * seconds) / 1024) * TOKEN_MARGIN;
    usd = tokens * rate.value;
    detail = `≈${Math.round(tokens).toLocaleString("en-US")} video tokens (${width}×${height}, ${seconds} s at 24 fps, +5%) × $${rate.value}`;
  } else if (rate) {
    const each = rate.unit === "cents_s" ? rate.value / 100 : rate.value;
    usd = each * seconds;
    detail = `${seconds} s × $${round(each)}/s (${rate.key})`;
  }
  const imageFee = skus.filter((sku) => sku.unit === "image_fee").sort((a, b) => b.value - a.value)[0];
  const images = input.references.images + input.references.frames;
  if (imageFee && images > 0) {
    const fee = /cents/.test(imageFee.key) ? imageFee.value / 100 : imageFee.value;
    usd += fee * images;
    detail += ` + ${images} input image${images === 1 ? "" : "s"} × $${round(fee)}`;
  }
  const minimum = skus.find((sku) => sku.unit === "minimum");
  if (minimum) {
    const floor = /cents/.test(minimum.key) ? minimum.value / 100 : minimum.value;
    if (usd < floor) {
      usd = floor;
      detail += ` (minimum $${round(floor)})`;
    }
  }
  return { usd, detail };
}

const MEGAPIXELS: Record<string, number> = { "512": 0.26, "768": 0.59, "1k": 1.05, "1.5k": 2.36, "2k": 4.19, "4k": 16.78 };

export function estimateImage(entry: MediaModelEntry, lines: ImagePriceLine[], input: EstimateInput): Estimate {
  const count = Math.max(1, Math.min(10, Math.round(Number(input.settings.n ?? 1)) || 1));
  const resolution = String(input.settings.resolution ?? defaultOf(entry, "resolution") ?? "1K").toLowerCase();
  const megapixels = MEGAPIXELS[resolution] ?? 1.05;
  const output = lines.find((line) => line.billable === "output_image");
  let each = 0.04;
  let detail = "≈$0.04 per image (no price listed)";
  if (output?.unit === "image") {
    each = output.usd;
    detail = `$${round(each)} per image`;
  } else if (output?.unit === "megapixel") {
    each = output.usd * megapixels;
    detail = `${megapixels} MP × $${round(output.usd)}/MP`;
  } else if (output?.unit === "token") {
    // ≈1,300 output tokens for a 1-megapixel image; "high" quality on GPT Image ≈4,200.
    const tokens = (String(input.settings.quality ?? "") === "high" ? 4_200 : 1_300) * Math.max(1, megapixels);
    each = output.usd * tokens;
    detail = `≈${Math.round(tokens).toLocaleString("en-US")} output tokens × $${output.usd}`;
  }
  const inputLine = lines.find((line) => line.billable === "input_image" || line.billable === "input_reference");
  let refs = 0;
  if (inputLine && input.references.images > 0) {
    refs = inputLine.unit === "token" ? inputLine.usd * 1_300 * input.references.images : inputLine.usd * input.references.images;
  }
  return { usd: each * count + refs, detail: `${count} × ${detail}${refs ? ` + references $${round(refs)}` : ""}` };
}

export function estimateAudio(entry: MediaModelEntry, input: EstimateInput): Estimate {
  if (entry.pricing.kind === "music") return { usd: entry.pricing.perClip, detail: `$${round(entry.pricing.perClip)} per clip (from the model listing)` };
  if (entry.pricing.kind !== "speech") return { usd: 0, detail: "no price listed" };
  const chars = input.prompt.length;
  // Speech models bill input characters; token-billed ones ≈1.7 audio tokens per character.
  const usd = chars * entry.pricing.perChar + chars * 1.7 * entry.pricing.perOutputToken;
  return { usd, detail: `${chars.toLocaleString("en-US")} characters` };
}

function round(value: number): string {
  return value >= 0.01 ? value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : value.toPrecision(2);
}
