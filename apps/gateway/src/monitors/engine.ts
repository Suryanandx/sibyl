/**
 * One evaluation of fetched items, cheapest step first:
 *
 *   items → diff against state (new / changed) → structured filters
 *         → plain-language `ask` (small model, capped batch, only if set)
 *         → matches
 *
 * Modes:
 * - "check": a scheduled or manual check. The very first check of a polled
 *   monitor is a baseline: it remembers what is there and fires nothing.
 * - "webhook": a delivery; never a baseline (each delivery is news), still
 *   deduplicated by key so retries don't fire twice.
 * - "test": dry run for the "Test now" button: every fetched item is a
 *   candidate, nothing is remembered.
 *
 * Candidates that could not be evaluated (over the model cap, or the budget
 * stopped the model call) are not remembered, so the next check picks them up.
 */
import type { MonitorRecord } from "@open-gpt-live/core";
import { MAX_ASK_ITEMS } from "./ask.js";
import {
  applyFilters,
  diffItems,
  getPath,
  pageChanges,
  readState,
  rememberItems,
  seenKey,
  toItems,
  type MonitorItem,
  type MonitorState
} from "./items.js";

/** Matches reported per event (the rest are counted). */
export const MAX_EVENT_ITEMS = 25;

export type EvaluateMode = "check" | "webhook" | "test";

export interface Match {
  item: MonitorItem;
  reason?: string;
}

export interface Evaluation {
  fetched: number;
  newItems: number;
  candidates: number;
  matches: Match[];
  /** State to save (undefined in test mode). */
  nextState?: MonitorState;
  baseline: boolean;
  /** Candidates left for the next check (model cap or budget). */
  deferred: number;
  /** Why the model was not asked (budget), if it wasn't. */
  askSkipped?: string;
}

export interface EvaluateInput {
  monitor: MonitorRecord;
  raw: unknown[];
  mode: EvaluateMode;
  /** Ask the model; resolves index → reason. Absent: no model configured. */
  ask?(items: MonitorItem[]): Promise<Map<number, string>>;
  /** Returns why the model may not be called now (budget), or undefined. */
  canAsk?(): string | undefined;
}

export async function evaluate(input: EvaluateInput): Promise<Evaluation> {
  const { monitor, mode } = input;
  const state = readState(monitor.state);
  const items = toItems(input.raw, monitor.dedupe.keyPath);
  const baseline = mode === "check" && state === undefined && monitor.source.kind !== "webhook";

  if (baseline) {
    return { fetched: items.length, newItems: items.length, candidates: 0, matches: [], nextState: rememberItems(monitor, state, items), baseline: true, deferred: 0 };
  }

  const diff = mode === "test" ? { candidates: items, newCount: items.filter((item) => state?.seen[seenKey(item.key)] === undefined).length } : diffItems(monitor, items, state);
  // Web pages: show the model (and the person) what changed, not the whole page.
  const enriched = monitor.source.kind === "webpage" ? diff.candidates.map((item) => withPageChanges(item, state)) : diff.candidates;
  const filtered = applyFilters(monitor, enriched, mode === "test" ? undefined : state);

  let matches: Match[] = [];
  let evaluated = new Set<string>(filtered.map((item) => item.key));
  let askSkipped: string | undefined;
  const question = monitor.condition.ask?.trim();
  if (question && filtered.length > 0) {
    const batch = filtered.slice(0, MAX_ASK_ITEMS);
    const blocked = input.canAsk?.();
    if (!input.ask) {
      askSkipped = "No model is configured for monitors, so the plain-language condition can't be checked.";
      evaluated = new Set();
    } else if (blocked) {
      askSkipped = blocked;
      evaluated = new Set();
    } else {
      const answers = await input.ask(batch);
      matches = batch.flatMap((item, index) => (answers.has(index) ? [{ item, ...(answers.get(index) ? { reason: answers.get(index)! } : {}) }] : []));
      evaluated = new Set(batch.map((item) => item.key));
    }
  } else {
    matches = filtered.map((item) => ({ item }));
  }

  const deferredKeys = new Set(filtered.filter((item) => !evaluated.has(item.key)).map((item) => item.key));
  const nextState = mode === "test" ? undefined : rememberItems(monitor, state, items.filter((item) => !deferredKeys.has(item.key)));
  return {
    fetched: items.length,
    newItems: diff.newCount,
    candidates: filtered.length,
    matches,
    ...(nextState ? { nextState } : {}),
    baseline: false,
    deferred: deferredKeys.size,
    ...(askSkipped ? { askSkipped } : {})
  };
}

function withPageChanges(item: MonitorItem, state: MonitorState | undefined): MonitorItem {
  const text = getPath(item.data, "text");
  if (typeof text !== "string") return item;
  const changes = pageChanges(state?.pages?.[seenKey(item.key)], text);
  const data = { ...(item.data as Record<string, unknown>), added: changes.added, removed: changes.removed };
  // The model sees the change, not the full text.
  delete (data as { text?: unknown }).text;
  return { ...item, data };
}

/** A short, plain-language summary of what fired. */
export function summarizeMatches(monitorName: string, matches: Match[]): string {
  if (matches.length === 0) return `Nothing new for “${monitorName}”.`;
  const titles = matches.slice(0, 3).map((match) => match.item.title);
  const more = matches.length > 3 ? ` and ${matches.length - 3} more` : "";
  const what = matches.length === 1 ? "1 new match" : `${matches.length} new matches`;
  return `${what} for “${monitorName}”: ${titles.join("; ")}${more}.`;
}

export function linksOf(matches: Match[]): string[] {
  return [...new Set(matches.map((match) => match.item.url).filter((url): url is string => Boolean(url)))].slice(0, MAX_EVENT_ITEMS);
}
