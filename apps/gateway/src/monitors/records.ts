/**
 * Monitor records: creating and editing them from validated input, spend
 * bookkeeping, plain-language descriptions, cost estimates and the views
 * sent to the browser.
 */
import type { MonitorEventRecord, MonitorRecord, MonitorSource, MonitorSpend } from "@open-gpt-live/core";
import type { MonitorEventView, MonitorInput, MonitorStatusKind, MonitorStatusView, MonitorView } from "@open-gpt-live/protocol";
import { tenantPath } from "../tenancy/mode.js";

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
const MONTH_MINUTES = 30 * DAY_MINUTES;
/** Share of checks assumed to have new candidates for the "typical" estimate. */
const TYPICAL_CANDIDATE_SHARE = 0.1;
/** Webhook deliveries assumed per month for estimates. */
const WEBHOOK_DELIVERIES_PER_MONTH = 300;

export const HOOK_PATH_PREFIX = "/api/monitors/hooks/";

/** The webhook address of a monitor (hosted organizations: under /o/<orgId>). */
export function hookPath(id: string, ownerId: string): string {
  return tenantPath(ownerId, `${HOOK_PATH_PREFIX}${encodeURIComponent(id)}`);
}

export function sourceFromInput(input: MonitorInput["source"], secretRef: string | undefined): MonitorSource {
  if (input.kind === "webhook") return { kind: "webhook", secretRef: input.secretRef ?? secretRef ?? "" };
  if (input.kind === "tool") return { kind: "tool", toolName: input.toolName, input: input.input };
  return { kind: input.kind, url: input.url };
}

function sameSource(a: MonitorSource, b: MonitorSource): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createMonitorRecord(
  input: MonitorInput,
  meta: { id: string; ownerId: string; workspaceId: string; createdBy: string; now: number; secretRef?: string }
): MonitorRecord {
  const source = sourceFromInput(input.source, meta.secretRef);
  const enabled = input.enabled ?? true;
  const record: MonitorRecord = {
    id: meta.id,
    ownerId: meta.ownerId,
    workspaceId: meta.workspaceId,
    createdBy: meta.createdBy,
    name: input.name,
    source,
    schedule: { everyMinutes: input.schedule.everyMinutes },
    condition: input.condition,
    actions: input.actions,
    dedupe: input.dedupe ?? {},
    enabled,
    createdAt: meta.now,
    updatedAt: meta.now
  };
  if (input.agentId) record.agentId = input.agentId;
  if (input.budget?.dailyUsd !== undefined) record.budget = { dailyUsd: input.budget.dailyUsd };
  // First check right away: it records what is there (a baseline) so you only hear about what's new.
  if (enabled && source.kind !== "webhook") record.nextCheckAt = meta.now;
  return record;
}

/** Replace a monitor's editable parts. A different source starts over (new baseline). */
export function applyMonitorInput(existing: MonitorRecord, input: MonitorInput, now: number): MonitorRecord {
  const source = sourceFromInput(
    input.source.kind === "webhook" && !input.source.secretRef && existing.source.kind === "webhook" ? { kind: "webhook", secretRef: existing.source.secretRef } : input.source,
    undefined
  );
  const next: MonitorRecord = {
    ...existing,
    name: input.name,
    source,
    schedule: { everyMinutes: input.schedule.everyMinutes },
    condition: input.condition,
    actions: input.actions,
    dedupe: input.dedupe ?? existing.dedupe,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: now
  };
  if (input.agentId) next.agentId = input.agentId;
  else delete next.agentId;
  if (input.budget !== undefined) {
    if (input.budget.dailyUsd === undefined) delete next.budget;
    else next.budget = { dailyUsd: input.budget.dailyUsd };
  }
  const sourceChanged = !sameSource(existing.source, source) || existing.dedupe.keyPath !== next.dedupe.keyPath;
  if (sourceChanged) delete next.state;
  if (next.enabled) {
    delete next.pausedReason;
    if (next.source.kind === "webhook") delete next.nextCheckAt;
    else next.nextCheckAt = sourceChanged || !existing.lastCheckedAt ? now : Math.max(now, existing.lastCheckedAt + next.schedule.everyMinutes * MINUTE);
  } else {
    delete next.nextCheckAt;
  }
  return next;
}

/** Pause or resume. Resuming clears the failure streak and checks soon. */
export function setPaused(monitor: MonitorRecord, paused: boolean, now: number, reason?: string): MonitorRecord {
  const next: MonitorRecord = { ...monitor, enabled: !paused, updatedAt: now };
  if (paused) {
    delete next.nextCheckAt;
    if (reason) next.pausedReason = reason;
    else delete next.pausedReason;
  } else {
    delete next.pausedReason;
    delete next.lastError;
    next.failureCount = 0;
    if (next.source.kind !== "webhook") next.nextCheckAt = now;
  }
  return next;
}

/* ───────────── spend ───────────── */

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function utcMonth(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

export function nextUtcMidnight(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** Spend for the current day and month (older totals reset). */
export function currentSpend(spend: MonitorSpend | undefined, now: number): MonitorSpend {
  const day = utcDay(now);
  const month = utcMonth(now);
  return {
    day,
    dayUsd: spend?.day === day ? spend.dayUsd : 0,
    month,
    monthUsd: spend?.month === month ? spend.monthUsd : 0
  };
}

export function addSpend(spend: MonitorSpend | undefined, usd: number, now: number): MonitorSpend {
  const current = currentSpend(spend, now);
  const add = Number.isFinite(usd) && usd > 0 ? usd : 0;
  return { ...current, dayUsd: current.dayUsd + add, monthUsd: current.monthUsd + add };
}

/* ───────────── words ───────────── */

export function frequencyWords(monitor: Pick<MonitorRecord, "source" | "schedule">): string {
  if (monitor.source.kind === "webhook") return "whenever the webhook is called";
  return everyWords(monitor.schedule.everyMinutes);
}

export function everyWords(minutes: number): string {
  if (minutes % DAY_MINUTES === 0) return minutes === DAY_MINUTES ? "once a day" : `every ${minutes / DAY_MINUTES} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

export function sourceWords(source: MonitorSource | MonitorInput["source"]): string {
  switch (source.kind) {
    case "tool":
      return `the results of ${source.toolName}`;
    case "rss":
      return `the feed ${source.url}`;
    case "webpage":
      return `the page ${source.url}`;
    case "webhook":
      return "a webhook";
  }
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/* ───────────── cost estimate ───────────── */

export interface CostEstimate {
  typicalMonthUsd: number;
  maxMonthUsd: number;
}

/**
 * Monthly cost: fetching is free (read tools, feeds, pages); the model is
 * only asked when a check has new candidates, and a task is a brain run per
 * match. max = every check has candidates; typical = one check in ten.
 * Both are capped by the monitor's daily budget.
 */
export function estimateMonthlyCost(
  monitor: Pick<MonitorRecord, "source" | "schedule" | "condition" | "actions" | "budget">,
  unit: { askUsd: number; taskUsd: number }
): CostEstimate {
  const checks = monitor.source.kind === "webhook" ? WEBHOOK_DELIVERIES_PER_MONTH : MONTH_MINUTES / monitor.schedule.everyMinutes;
  const perCheck = (monitor.condition.ask ? unit.askUsd : 0) + (monitor.actions.some((action) => action.kind === "task") ? unit.taskUsd : 0);
  let max = checks * perCheck;
  let typical = max * TYPICAL_CANDIDATE_SHARE;
  const cap = monitor.budget?.dailyUsd === undefined ? undefined : monitor.budget.dailyUsd * 30;
  if (cap !== undefined) {
    max = Math.min(max, cap);
    typical = Math.min(typical, cap);
  }
  return { typicalMonthUsd: round(typical), maxMonthUsd: round(max) };
}

export function estimateWords(estimate: CostEstimate): string {
  if (estimate.maxMonthUsd === 0) return "no model cost (fetching and filtering are free)";
  return `about ${formatUsd(estimate.typicalMonthUsd)} a month (at most ${formatUsd(estimate.maxMonthUsd)})`;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/* ───────────── views ───────────── */

export function statusOf(monitor: MonitorRecord, running: boolean): MonitorStatusKind {
  if (running) return "checking";
  if (!monitor.enabled) return "paused";
  if ((monitor.failureCount ?? 0) > 0 && monitor.lastError) return "error";
  return "active";
}

export function toMonitorView(monitor: MonitorRecord, context: { mine: boolean; running: boolean; now: number; estimate: CostEstimate }): MonitorView {
  const spend = currentSpend(monitor.spend, context.now);
  const source: MonitorView["source"] =
    monitor.source.kind === "webhook"
      ? { kind: "webhook", secretRef: monitor.source.secretRef, hookPath: hookPath(monitor.id, monitor.ownerId) }
      : monitor.source.kind === "tool"
        ? // Tool input may hold search terms the creator typed; only they see it.
          { kind: "tool", toolName: monitor.source.toolName, input: context.mine ? monitor.source.input : {} }
        : { kind: monitor.source.kind, url: monitor.source.url };
  return {
    id: monitor.id,
    name: monitor.name,
    workspaceId: monitor.workspaceId,
    createdBy: monitor.createdBy,
    mine: context.mine,
    ...(monitor.agentId ? { agentId: monitor.agentId } : {}),
    source,
    schedule: { everyMinutes: monitor.schedule.everyMinutes },
    frequency: frequencyWords(monitor),
    condition: context.mine ? (monitor.condition as MonitorView["condition"]) : {},
    actions: context.mine ? monitor.actions : monitor.actions.map((action) => (action.kind === "task" ? { kind: "task", instruction: "(private)" } : action)),
    dedupe: monitor.dedupe,
    enabled: monitor.enabled,
    ...(monitor.budget ? { budget: monitor.budget } : {}),
    status: statusOf(monitor, context.running),
    ...(monitor.pausedReason ? { pausedReason: monitor.pausedReason } : {}),
    ...(monitor.lastError ? { lastError: monitor.lastError } : {}),
    ...(monitor.lastCheckedAt === undefined ? {} : { lastCheckedAt: monitor.lastCheckedAt }),
    ...(monitor.lastFiredAt === undefined ? {} : { lastFiredAt: monitor.lastFiredAt }),
    ...(monitor.nextCheckAt === undefined ? {} : { nextCheckAt: monitor.nextCheckAt }),
    costTodayUsd: round(spend.dayUsd),
    costMonthUsd: round(spend.monthUsd),
    estimate: context.estimate,
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt
  };
}

export function toStatusView(monitor: MonitorRecord, running: boolean, now: number): MonitorStatusView {
  return {
    id: monitor.id,
    status: statusOf(monitor, running),
    enabled: monitor.enabled,
    ...(monitor.lastCheckedAt === undefined ? {} : { lastCheckedAt: monitor.lastCheckedAt }),
    ...(monitor.lastFiredAt === undefined ? {} : { lastFiredAt: monitor.lastFiredAt }),
    ...(monitor.nextCheckAt === undefined ? {} : { nextCheckAt: monitor.nextCheckAt }),
    ...(monitor.lastError ? { lastError: monitor.lastError } : {}),
    ...(monitor.pausedReason ? { pausedReason: monitor.pausedReason } : {}),
    costMonthUsd: round(currentSpend(monitor.spend, now).monthUsd)
  };
}

export function toEventView(event: MonitorEventRecord, monitor: Pick<MonitorRecord, "name" | "conversationId"> | undefined): MonitorEventView {
  return {
    id: event.id,
    monitorId: event.monitorId,
    ...(monitor ? { monitorName: monitor.name } : {}),
    at: event.at,
    kind: event.kind,
    summary: event.summary,
    items: event.items,
    links: event.links,
    costUsd: round(event.costUsd),
    actions: event.actions,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.runId && monitor?.conversationId ? { conversationId: monitor.conversationId } : {})
  };
}
