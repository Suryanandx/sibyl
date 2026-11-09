/**
 * Helpers shared by connector implementations: JSON-schema shorthands,
 * input checks, e-mail encoding and free-time computation.
 */
import { ConnectorError, type JsonSchema } from "./types.js";

/* ───────────── schema shorthands ───────────── */

export function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const str = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "string", description, ...extra });
export const int = (description: string, minimum: number, maximum: number, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "integer", description, minimum, maximum, ...extra });
export const bool = (description: string): JsonSchema => ({ type: "boolean", description });
export const strList = (description: string, maxItems = 50): JsonSchema => ({ type: "array", description, items: { type: "string" }, maxItems });
export const dateTime = (description: string): JsonSchema => ({ type: "string", description: `${description} ISO 8601 date-time, e.g. 2026-11-09T14:00:00+01:00.`, format: "date-time" });
/** A 2-D table of cell values (strings, numbers, booleans). */
export const table = (description: string): JsonSchema => ({
  type: "array",
  description,
  maxItems: 1000,
  items: { type: "array", maxItems: 200, items: { type: ["string", "number", "boolean", "null"] } }
});

/* ───────────── input checks ───────────── */

export function requireString(input: Record<string, unknown>, key: string, max = 10_000): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new ConnectorError("bad_input", `"${key}" is required.`);
  if (value.length > max) throw new ConnectorError("bad_input", `"${key}" is too long (max ${max} characters).`);
  return value.trim();
}

export function optionalString(input: Record<string, unknown>, key: string, max = 10_000): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ConnectorError("bad_input", `"${key}" must be text.`);
  if (value.length > max) throw new ConnectorError("bad_input", `"${key}" is too long (max ${max} characters).`);
  return value.trim() || undefined;
}

export function optionalInt(input: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ConnectorError("bad_input", `"${key}" must be a number.`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function stringList(input: Record<string, unknown>, key: string, max = 50): string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  const items = typeof value === "string" ? value.split(/[,;]/) : value;
  if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) throw new ConnectorError("bad_input", `"${key}" must be a list of text values.`);
  const out = (items as string[]).map((item) => item.trim()).filter(Boolean);
  if (out.length > max) throw new ConnectorError("bad_input", `"${key}" has too many entries (max ${max}).`);
  return out;
}

export function requireDateTime(input: Record<string, unknown>, key: string): string {
  const value = requireString(input, key, 64);
  if (!Number.isFinite(Date.parse(value))) throw new ConnectorError("bad_input", `"${key}" must be an ISO 8601 date-time.`);
  return value;
}

export function optionalDateTime(input: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(input, key, 64);
  if (value && !Number.isFinite(Date.parse(value))) throw new ConnectorError("bad_input", `"${key}" must be an ISO 8601 date-time.`);
  return value;
}

export function requireTable(input: Record<string, unknown>, key: string): Array<Array<string | number | boolean | null>> {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) throw new ConnectorError("bad_input", `"${key}" must be a list of rows (1–1000).`);
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length > 200) throw new ConnectorError("bad_input", `Row ${index + 1} of "${key}" must be a list of cells.`);
    return row.map((cell) => (cell === null || ["string", "number", "boolean"].includes(typeof cell) ? (cell as string | number | boolean | null) : String(cell)));
  });
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function emailList(input: Record<string, unknown>, key: string, required = false): string[] {
  const list = stringList(input, key, 100).map((entry) => {
    const match = /<([^>]+)>\s*$/.exec(entry);
    return (match ? match[1]! : entry).trim();
  });
  for (const address of list) if (!EMAIL.test(address)) throw new ConnectorError("bad_input", `"${address}" is not an e-mail address.`);
  if (required && list.length === 0) throw new ConnectorError("bad_input", `"${key}" needs at least one e-mail address.`);
  return list;
}

/** An id the vendor gave us: no slashes or spaces (it goes into a URL path). */
export function requireId(input: Record<string, unknown>, key: string): string {
  const value = requireString(input, key, 1024);
  if (/[\s/?#\\]/.test(value)) throw new ConnectorError("bad_input", `"${key}" is not a valid id.`);
  return value;
}

/* ───────────── e-mail (RFC 5322) ───────────── */

/** Encode a header value with RFC 2047 when it isn't plain ASCII. */
function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export interface MailDraft {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/** A text/plain RFC 5322 message, base64url-encoded (Gmail `raw`). */
export function rawEmail(draft: MailDraft): string {
  const lines = [
    `To: ${draft.to.join(", ")}`,
    ...(draft.cc?.length ? [`Cc: ${draft.cc.join(", ")}`] : []),
    ...(draft.bcc?.length ? [`Bcc: ${draft.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo.replace(/[\r\n]/g, "")}`] : []),
    ...(draft.references ? [`References: ${draft.references.replace(/[\r\n]/g, "")}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(draft.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n")
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/* ───────────── free time ───────────── */

export interface Interval {
  start: number;
  end: number;
}

/**
 * Free slots of at least `durationMinutes` between `from` and `to`, outside
 * `busy`, within working hours (local to `utcOffsetMinutes`) when given.
 */
export function freeSlots(input: {
  from: number;
  to: number;
  busy: Interval[];
  durationMinutes: number;
  workdayStartHour?: number;
  workdayEndHour?: number;
  utcOffsetMinutes?: number;
  maxSlots?: number;
}): Interval[] {
  const duration = input.durationMinutes * 60_000;
  const busy = input.busy
    .filter((b) => b.end > input.from && b.start < input.to)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else merged.push({ ...b });
  }
  const open: Interval[] = [];
  let cursor = input.from;
  for (const b of merged) {
    if (b.start > cursor) open.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < input.to) open.push({ start: cursor, end: input.to });

  const windows = input.workdayStartHour === undefined || input.workdayEndHour === undefined ? open : open.flatMap((slot) => clipToWorkday(slot, input.workdayStartHour!, input.workdayEndHour!, input.utcOffsetMinutes ?? 0));
  return windows.filter((slot) => slot.end - slot.start >= duration).slice(0, input.maxSlots ?? 20);
}

function clipToWorkday(slot: Interval, startHour: number, endHour: number, offsetMinutes: number): Interval[] {
  const out: Interval[] = [];
  const offset = offsetMinutes * 60_000;
  const day = 24 * 3600_000;
  let dayStart = Math.floor((slot.start + offset) / day) * day - offset;
  for (; dayStart < slot.end; dayStart += day) {
    const from = Math.max(slot.start, dayStart + startHour * 3600_000);
    const to = Math.min(slot.end, dayStart + endHour * 3600_000);
    if (to > from) out.push({ start: from, end: to });
  }
  return out;
}

/** "+01:00" / "Z" offset of an ISO date-time, in minutes (0 when absent). */
export function offsetOf(iso: string): number {
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export function isoWithOffset(ms: number, offsetMinutes: number): string {
  const local = new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 19);
  if (offsetMinutes === 0) return `${local}Z`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Encode one URL path segment. */
export const seg = (value: string): string => encodeURIComponent(value);
