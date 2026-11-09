/**
 * Response trimming for the model: vendor APIs return large, noisy JSON.
 * Drop empty values and links the model can't use, cap long strings and
 * arrays, and keep the whole result under a character budget.
 */

export const MAX_RESULT_CHARS = 9_000;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 7;
/** Keys that are noise for the model (etags, API links, internal kinds). */
const NOISE_KEYS = new Set(["etag", "@odata.etag", "@odata.context", "@odata.type", "kind", "_links", "attributes", "iCalUID", "sequence"]);

export interface TrimOptions {
  maxChars?: number;
  maxString?: number;
  maxItems?: number;
}

/** A trimmed copy of `value` (JSON-safe). */
export function trimValue(value: unknown, options: TrimOptions = {}, depth = 0): unknown {
  const maxString = options.maxString ?? MAX_STRING_CHARS;
  const maxItems = options.maxItems ?? MAX_ARRAY_ITEMS;
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const text = value.replace(/\r\n/g, "\n");
    if (!text.trim()) return undefined;
    return text.length > maxString ? `${text.slice(0, maxString)}… [${text.length - maxString} more characters]` : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((item) => trimValue(item, options, depth + 1)).filter((item) => item !== undefined);
    if (value.length > maxItems) items.push(`… ${value.length - maxItems} more`);
    return items.length ? items : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (NOISE_KEYS.has(key)) continue;
    const trimmed = trimValue(inner, options, depth + 1);
    if (trimmed !== undefined) out[key] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Compact JSON text for the model, shrinking until it fits `maxChars`. */
export function toModelText(value: unknown, options: TrimOptions = {}): string {
  const maxChars = options.maxChars ?? MAX_RESULT_CHARS;
  if (typeof value === "string") return value.length > maxChars ? `${value.slice(0, maxChars)}… [truncated]` : value;
  let maxString = options.maxString ?? MAX_STRING_CHARS;
  let maxItems = options.maxItems ?? MAX_ARRAY_ITEMS;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const text = JSON.stringify(trimValue(value, { maxString, maxItems }) ?? null);
    if (text.length <= maxChars) return text;
    maxString = Math.max(120, Math.floor(maxString / 2));
    maxItems = Math.max(5, Math.floor(maxItems / 2));
  }
  const text = JSON.stringify(trimValue(value, { maxString, maxItems }) ?? null);
  return `${text.slice(0, maxChars)}… [truncated]`;
}

/** Plain text from HTML (mail bodies, Teams messages). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
