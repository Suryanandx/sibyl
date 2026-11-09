/**
 * Items, filters and state: the cheap, model-free part of a check.
 *
 * - Whatever a source returns is turned into a list of items, each with a
 *   stable key (the dedupe key path, else a common id field, else the content
 *   hash), a content hash, a title and a link.
 * - `diffItems` compares them with the monitor's state: new keys are
 *   candidates; changed hashes are candidates too when the monitor watches
 *   for changes (a "changed" filter, or a web page).
 * - Structured filters run next; only what passes reaches the model.
 */
import { createHash } from "node:crypto";
import type { MonitorFilter, MonitorRecord } from "@open-gpt-live/core";

/** Keys remembered per monitor (oldest forgotten first). */
export const MAX_SEEN_KEYS = 5_000;
/** Items accepted from one fetch or webhook delivery. */
export const MAX_ITEMS_PER_CHECK = 500;
/** Characters of previous page text kept to show what changed. */
export const MAX_PAGE_TEXT = 20_000;

export interface MonitorItem {
  key: string;
  hash: string;
  title: string;
  url?: string;
  data: unknown;
}

export interface MonitorState {
  v: 1;
  /** "k:<key>" → content hash (prefix keeps insertion order for numeric keys). */
  seen: Record<string, string>;
  /** Tracked values for "changed" filters: "k:<key>" → path → value. */
  values?: Record<string, Record<string, unknown>>;
  /** Web pages: the last text, to show what changed. */
  pages?: Record<string, string>;
}

export function readState(value: unknown): MonitorState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<MonitorState>;
  if (state.v !== 1 || !state.seen || typeof state.seen !== "object") return undefined;
  return state as MonitorState;
}

/* ───────────── paths ───────────── */

/** Read a dotted path ("properties.amount", "labels.0"). */
export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/* ───────────── items ───────────── */

const LIST_KEYS = ["items", "results", "data", "records", "entries", "messages", "events", "deals", "files", "value", "rows", "hits"];
const ID_KEYS = ["id", "guid", "uid", "key", "messageId", "message_id", "threadId", "eventId", "link", "url", "permalink"];
const TITLE_KEYS = ["title", "subject", "name", "summary", "dealname", "properties.dealname", "properties.name", "properties.subject", "snippet", "headline"];
const URL_KEYS = ["url", "link", "href", "webLink", "webViewLink", "htmlLink", "htmlUrl", "permalink", "web_url"];

/** The list inside a tool result: an array, or the first array under a common key. */
export function extractList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of LIST_KEYS) {
      const value = record[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = extractListShallow(value as Record<string, unknown>);
        if (nested) return nested;
      }
    }
    const firstArray = Object.values(record).find((value) => Array.isArray(value) && value.some((v) => v && typeof v === "object"));
    if (Array.isArray(firstArray)) return firstArray;
  }
  return raw === undefined || raw === null ? [] : [raw];
}

function extractListShallow(record: Record<string, unknown>): unknown[] | undefined {
  for (const key of LIST_KEYS) if (Array.isArray(record[key])) return record[key] as unknown[];
  return undefined;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function hashOf(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex").slice(0, 24);
}

function firstString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = getPath(value, key);
    if (typeof found === "string" && found.trim()) return found.trim();
    if (typeof found === "number" && Number.isFinite(found)) return String(found);
  }
  return undefined;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Turn raw values into keyed items (deduplicated by key, capped). */
export function toItems(raw: unknown[], keyPath: string | undefined): MonitorItem[] {
  const out = new Map<string, MonitorItem>();
  for (const data of raw.slice(0, MAX_ITEMS_PER_CHECK)) {
    const hash = hashOf(data);
    const fromPath = keyPath ? getPath(data, keyPath) : undefined;
    const key =
      (typeof fromPath === "string" || typeof fromPath === "number") && String(fromPath).trim()
        ? String(fromPath).trim()
        : (!keyPath ? firstString(data, ID_KEYS) : undefined) ?? hash;
    const url = firstString(data, URL_KEYS);
    const title = firstString(data, TITLE_KEYS) ?? (typeof data === "string" ? data : stableJson(data));
    out.set(key, { key, hash, title: oneLine(title, 160), ...(url && /^https?:\/\//i.test(url) ? { url } : {}), data });
  }
  return [...out.values()];
}

/* ───────────── filters ───────────── */

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && /^[-+]?[\d,]*\.?\d+(e[-+]?\d+)?$/i.test(value.trim())) {
    const n = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asTime(value: unknown): number | undefined {
  if (typeof value !== "string" || !/\d{4}-\d{2}-\d{2}|[A-Za-z]{3},? \d/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  if (typeof a === "boolean" || typeof b === "boolean") return String(a).toLowerCase() === String(b).toLowerCase();
  return false;
}

function compare(a: unknown, b: unknown): number | undefined {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  const ta = asTime(a);
  const tb = asTime(b);
  if (ta !== undefined && tb !== undefined) return ta - tb;
  return undefined;
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((entry) => looseEqual(entry, needle) || contains(entry, needle));
  if (typeof haystack === "string") return haystack.toLowerCase().includes(String(needle ?? "").toLowerCase());
  if (haystack && typeof haystack === "object") return stableJson(haystack).toLowerCase().includes(String(needle ?? "").toLowerCase());
  return false;
}

/** Does the item pass one filter? `previous` is the tracked value from the last time it was seen. */
export function passesFilter(item: unknown, filter: MonitorFilter, previous: { seen: boolean; value: unknown }): boolean {
  const value = getPath(item, filter.path);
  switch (filter.op) {
    case "eq":
      return looseEqual(value, filter.value);
    case "neq":
      return !looseEqual(value, filter.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const diff = compare(value, filter.value);
      if (diff === undefined) return false;
      return filter.op === "gt" ? diff > 0 : filter.op === "gte" ? diff >= 0 : filter.op === "lt" ? diff < 0 : diff <= 0;
    }
    case "contains":
      return contains(value, filter.value);
    case "not_contains":
      return !contains(value, filter.value);
    case "in":
      return Array.isArray(filter.value) && filter.value.some((option) => looseEqual(value, option));
    case "exists":
      return value !== undefined && value !== null && value !== "";
    case "changed": {
      // A new item counts as changed (it arrived with this value).
      const moved = !previous.seen || stableJson(previous.value) !== stableJson(value);
      return moved && (filter.value === undefined || looseEqual(value, filter.value));
    }
  }
}

/** Paths whose values must be remembered (for "changed" filters). */
export function trackedPaths(monitor: Pick<MonitorRecord, "condition">): string[] {
  return [...new Set((monitor.condition.filter ?? []).filter((f) => f.op === "changed").map((f) => f.path))];
}

/* ───────────── diff ───────────── */

export interface DiffResult {
  /** Items to evaluate (new, or changed when the monitor watches for changes). */
  candidates: MonitorItem[];
  newCount: number;
}

export function seenKey(key: string): string {
  return `k:${key}`;
}

export function watchesChanges(monitor: Pick<MonitorRecord, "condition" | "source">): boolean {
  return monitor.source.kind === "webpage" || trackedPaths(monitor).length > 0;
}

export function diffItems(monitor: Pick<MonitorRecord, "condition" | "source">, items: MonitorItem[], state: MonitorState | undefined): DiffResult {
  const changes = watchesChanges(monitor);
  const candidates: MonitorItem[] = [];
  let newCount = 0;
  for (const item of items) {
    const before = state?.seen[seenKey(item.key)];
    if (before === undefined) {
      newCount += 1;
      candidates.push(item);
    } else if (before !== item.hash && changes) {
      candidates.push(item);
    }
  }
  return { candidates, newCount };
}

/** Run the structured filters (all must pass). */
export function applyFilters(monitor: Pick<MonitorRecord, "condition">, items: MonitorItem[], state: MonitorState | undefined): MonitorItem[] {
  const filters = monitor.condition.filter ?? [];
  if (filters.length === 0) return items;
  return items.filter((item) => {
    const key = seenKey(item.key);
    const seen = state?.seen[key] !== undefined;
    return filters.every((filter) => passesFilter(item.data, filter, { seen, value: state?.values?.[key]?.[filter.path] }));
  });
}

/** Remember these items (and their tracked values); forget the oldest beyond the cap. */
export function rememberItems(monitor: Pick<MonitorRecord, "condition" | "source">, state: MonitorState | undefined, items: MonitorItem[]): MonitorState {
  const next: MonitorState = { v: 1, seen: { ...(state?.seen ?? {}) } };
  const paths = trackedPaths(monitor);
  if (paths.length > 0 || state?.values) next.values = { ...(state?.values ?? {}) };
  if (monitor.source.kind === "webpage" || state?.pages) next.pages = { ...(state?.pages ?? {}) };
  for (const item of items) {
    const key = seenKey(item.key);
    delete next.seen[key]; // re-insert: most recent last
    next.seen[key] = item.hash;
    if (paths.length > 0) {
      const values: Record<string, unknown> = {};
      for (const path of paths) {
        const value = getPath(item.data, path);
        if (value !== undefined) values[path] = value;
      }
      next.values![key] = values;
    }
    if (monitor.source.kind === "webpage") {
      const text = getPath(item.data, "text");
      if (typeof text === "string") next.pages![key] = text.slice(0, MAX_PAGE_TEXT);
    }
  }
  const keys = Object.keys(next.seen);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SEEN_KEYS))) {
    delete next.seen[key];
    if (next.values) delete next.values[key];
    if (next.pages) delete next.pages[key];
  }
  return next;
}

/** Lines added and removed between two page texts (for change summaries and the model). */
export function pageChanges(before: string | undefined, after: string): { added: string[]; removed: string[] } {
  const split = (text: string) => text.split(/\n+/).map((line) => line.trim()).filter((line) => line.length > 1);
  const old = new Set(split(before ?? ""));
  const now = split(after);
  const nowSet = new Set(now);
  return {
    added: now.filter((line) => !old.has(line)).slice(0, 40),
    removed: [...old].filter((line) => !nowSet.has(line)).slice(0, 40)
  };
}
