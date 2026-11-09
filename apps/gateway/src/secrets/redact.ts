/**
 * Redaction: replace any stored secret value — raw, base64 (any alignment,
 * so `Basic base64(user:key)` is caught too), base64url, URL-encoded or
 * JSON-escaped — with `[secret:NAME]`.
 *
 * `redactSecrets(ownerId, text)` is the process-wide hook the tool loop calls
 * on every tool result before the model sees it. Vaults register here.
 */

/** Values shorter than this are not redacted (they would mangle normal text). */
export const MIN_REDACT_LENGTH = 4;
/** Base64 fragments shorter than this are too likely to collide with real text. */
const MIN_FRAGMENT = 8;

export interface RedactionEntry {
  name: string;
  /** Every form of the value to look for (longest first). */
  needles: string[];
}

/** All the encodings of one value we look for. */
export function redactionNeedles(value: string): string[] {
  if (value.length < MIN_REDACT_LENGTH) return [];
  const needles = new Set<string>([value]);
  const add = (needle: string): void => {
    if (needle.length >= MIN_FRAGMENT || (needle.length >= MIN_REDACT_LENGTH && needle === value)) needles.add(needle);
  };
  add(encodeURIComponent(value));
  add(encodeURIComponent(value).replace(/%20/g, "+"));
  add(JSON.stringify(value).slice(1, -1));
  const bytes = Buffer.from(value, "utf8");
  // Base64 of the value at each of the three byte alignments. Only the
  // characters that encode value bytes alone are kept (no neighbours).
  for (let shift = 0; shift < 3; shift += 1) {
    const padded = Buffer.concat([Buffer.alloc(shift), bytes]);
    const encoded = padded.toString("base64").replace(/=+$/, "");
    const start = shift === 0 ? 0 : 4;
    // Drop a trailing partial group (it depends on whatever follows the value).
    const usable = Math.floor((padded.length * 8) / 24) * 4;
    const core = encoded.slice(start, Math.max(start, usable));
    if (shift === 0) {
      add(bytes.toString("base64"));
      add(bytes.toString("base64").replace(/=+$/, ""));
      add(bytes.toString("base64url"));
    }
    add(core);
    add(core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

/** Replace every needle in `text` with `[secret:NAME]`. */
export function redactWith(entries: readonly RedactionEntry[], text: string): string {
  if (!text || entries.length === 0) return text;
  const all = entries
    .flatMap((entry) => entry.needles.map((needle) => ({ needle, name: entry.name })))
    .sort((a, b) => b.needle.length - a.needle.length);
  let out = text;
  for (const { needle, name } of all) {
    if (out.includes(needle)) out = out.split(needle).join(`[secret:${name}]`);
  }
  return out;
}

type Redactor = (ownerId: string, text: string) => string;
const redactors = new Set<Redactor>();

/** Register a vault's redactor; returns an unregister function. */
export function registerRedactor(redactor: Redactor): () => void {
  redactors.add(redactor);
  return () => void redactors.delete(redactor);
}

/** Process-wide: redact every secret any installed vault knows for this owner. */
export function redactSecrets(ownerId: string, text: string): string {
  let out = text;
  for (const redactor of redactors) out = redactor(ownerId, out);
  return out;
}
