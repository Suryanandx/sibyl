/**
 * Routine records: validation, edits and the views sent to the browser.
 * Shared by the chat tools and the WebSocket handlers so both apply the same
 * rules (valid cron + time zone, nextRunAt recomputed on every change).
 */
import type { RoutineRecord, RoutineRunRecord } from "@open-gpt-live/core";
import type { RoutinePatch, RoutineRunView, RoutineView } from "@open-gpt-live/protocol";
import { CronError, describeSchedule, nextRun, validateSchedule } from "./cron.js";

/** Per-run cap used when neither the routine nor SIBYL_BUDGET_ROUTINE_RUN_USD sets one. */
export const DEFAULT_ROUTINE_RUN_USD = 0.25;
export const MAX_ROUTINE_RUN_USD = 100;

export class RoutineInputError extends Error {}

export interface NewRoutineInput {
  name: string;
  instruction: string;
  cron: string;
  timezone: string;
  maxRunUsd?: number;
  enabled?: boolean;
  /** Run as this agent. */
  agentId?: string;
  /** A one-time task (pauses after its first run). */
  once?: boolean;
}

export interface NewRoutineMeta {
  id: string;
  ownerId: string;
  now: number;
  /** Workspace it runs in (default: `default`). */
  workspaceId?: string;
  /** Creator id (see creatorId()); runs act with their current rights (default: the org owner). */
  createdBy?: string;
}

export function createRoutineRecord(input: NewRoutineInput, meta: NewRoutineMeta): RoutineRecord {
  const name = cleanText(input.name, "name", 120);
  const instruction = cleanText(input.instruction, "instruction", 4_000);
  const cron = cleanText(input.cron, "cron", 120);
  const timezone = cleanText(input.timezone, "timezone", 64);
  const schedule = checkSchedule(cron, timezone, meta.now);
  const enabled = input.enabled ?? true;
  const record: RoutineRecord = {
    id: meta.id,
    ownerId: meta.ownerId,
    name,
    instruction,
    cron,
    timezone,
    enabled,
    ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
    ...(meta.createdBy ? { createdBy: meta.createdBy } : {}),
    createdAt: meta.now,
    updatedAt: meta.now
  };
  const cap = checkCap(input.maxRunUsd);
  if (cap !== undefined) record.maxRunUsd = cap;
  if (input.agentId) record.agentId = input.agentId;
  if (input.once) record.once = true;
  if (enabled) {
    const next = nextRun(schedule, timezone, meta.now);
    if (next !== undefined) record.nextRunAt = next;
  }
  return record;
}

/** Apply an edit; recomputes nextRunAt. Throws RoutineInputError on bad input. */
export function applyRoutinePatch(routine: RoutineRecord, patch: RoutinePatch, now: number): RoutineRecord {
  const next: RoutineRecord = { ...routine, updatedAt: now };
  if (patch.name !== undefined) next.name = cleanText(patch.name, "name", 120);
  if (patch.instruction !== undefined) next.instruction = cleanText(patch.instruction, "instruction", 4_000);
  if (patch.cron !== undefined) next.cron = cleanText(patch.cron, "cron", 120);
  if (patch.timezone !== undefined) next.timezone = cleanText(patch.timezone, "timezone", 64);
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.agentId === null) delete next.agentId;
  else if (patch.agentId !== undefined) next.agentId = patch.agentId;
  if (patch.maxRunUsd === null) delete next.maxRunUsd;
  else if (patch.maxRunUsd !== undefined) next.maxRunUsd = checkCap(patch.maxRunUsd);
  const schedule = checkSchedule(next.cron, next.timezone, now);
  delete next.nextRunAt;
  if (next.enabled) {
    const at = nextRun(schedule, next.timezone, now);
    if (at !== undefined) next.nextRunAt = at;
  }
  return next;
}

function checkSchedule(cron: string, timezone: string, now: number) {
  try {
    return validateSchedule(cron, timezone, now);
  } catch (error) {
    if (error instanceof CronError) throw new RoutineInputError(error.message);
    throw error;
  }
}

function checkCap(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_ROUTINE_RUN_USD) {
    throw new RoutineInputError(`maxRunUsd must be a number above 0 and up to ${MAX_ROUTINE_RUN_USD}`);
  }
  return value;
}

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new RoutineInputError(`${label} is required`);
  const text = value.trim();
  if (text.length > max) throw new RoutineInputError(`${label} is too long (max ${max} characters)`);
  return text;
}

/** The cap that applies to one run of this routine, if any. */
export function effectiveRunCap(routine: Pick<RoutineRecord, "maxRunUsd">, envCapUsd: number | undefined): number | undefined {
  return routine.maxRunUsd ?? envCapUsd;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** "a cost cap of $0.25 per run" / "no per-run cost cap". */
export function capWords(capUsd: number | undefined): string {
  return capUsd === undefined ? "no per-run cost cap (daily and monthly budgets still apply)" : `a cost cap of ${formatUsd(capUsd)} per run`;
}

/** A time in the routine's zone, e.g. "Tue 10 Nov, 08:00". */
export function formatWhen(at: number | undefined, timeZone: string): string {
  if (at === undefined) return "not scheduled";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

export function toRunView(run: RoutineRunRecord): RoutineRunView {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    costUsd: run.costUsd,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.summary ? { summary: run.summary } : {}),
    ...(run.error ? { error: run.error } : {})
  };
}

export function toRoutineView(routine: RoutineRecord, lastRun: RoutineRunRecord | undefined): RoutineView {
  return {
    id: routine.id,
    name: routine.name,
    instruction: routine.instruction,
    cron: routine.cron,
    timezone: routine.timezone,
    schedule: describeSchedule(routine.cron, routine.timezone),
    enabled: routine.enabled,
    ...(routine.conversationId ? { conversationId: routine.conversationId } : {}),
    ...(routine.maxRunUsd === undefined ? {} : { maxRunUsd: routine.maxRunUsd }),
    ...(routine.nextRunAt === undefined ? {} : { nextRunAt: routine.nextRunAt }),
    ...(routine.lastRunAt === undefined ? {} : { lastRunAt: routine.lastRunAt }),
    ...(lastRun ? { lastRun: toRunView(lastRun) } : {}),
    ...(routine.agentId ? { agentId: routine.agentId } : {}),
    ...(routine.workspaceId ? { workspaceId: routine.workspaceId } : {}),
    ...(routine.createdBy ? { createdBy: routine.createdBy } : {})
  };
}
