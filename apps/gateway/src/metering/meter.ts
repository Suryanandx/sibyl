/**
 * The gateway's UsageMeter: records every model call into `store.usage` and
 * keeps today/month totals per owner in memory so budget checks are
 * synchronous. The cache is rebuilt from the store on start.
 *
 * Days and months follow the server's local time zone.
 */
import { randomUUID } from "node:crypto";
import type {
  BudgetDecision,
  BudgetLimits,
  Store,
  UsageEvent,
  UsageFeature,
  UsageMeter,
  UsageTotals
} from "@open-gpt-live/core";
import { PricingTable } from "./pricing.js";

/** Share of a cap at which callers should switch to cheaper models. */
export const DOWNGRADE_RATIO = 0.85;

export type RecordInput = Omit<UsageEvent, "id" | "at"> & {
  at?: number;
  /** WebSocket session that caused the spend (for "this session" totals). */
  sessionId?: string;
};

export interface GatewayMeterOptions {
  store: Store;
  limits?: BudgetLimits;
  /** Owners whose totals are rebuilt from the store on start. */
  owners?: string[];
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  pricing?: PricingTable;
}

interface OwnerCache {
  dayStart: number;
  monthStart: number;
  todayUsd: number;
  monthUsd: number;
  byFeature: Partial<Record<UsageFeature, number>>;
}

interface RoutineDay {
  dayStart: number;
  usd: number;
}

export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function startOfLocalMonth(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function startOfNextLocalMonth(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

export class GatewayUsageMeter implements UsageMeter {
  readonly pricing: PricingTable;
  private readonly store: Store;
  private readonly budget: BudgetLimits;
  private readonly now: () => number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private readonly owners = new Map<string, OwnerCache>();
  private readonly routineDays = new Map<string, RoutineDay>();
  private readonly sessions = new Map<string, number>();
  private readonly requestSessions = new Map<string, string>();
  /** Rolling mean cost per call, keyed by feature + model. */
  private readonly averages = new Map<string, number>();
  private pendingWrites = new Set<Promise<void>>();

  constructor(options: GatewayMeterOptions) {
    this.store = options.store;
    this.budget = { ...options.limits };
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.pricing = options.pricing ?? new PricingTable();
  }

  /** Rebuild today/month totals (and routine daily spend) from the store. */
  async load(owners: string[]): Promise<void> {
    const now = this.now();
    const dayStart = startOfLocalDay(now);
    const monthStart = startOfLocalMonth(now);
    const monthEnd = startOfNextLocalMonth(now);
    for (const ownerId of owners) {
      const [todayUsd, monthUsd, byFeature] = await Promise.all([
        this.store.usage.sum(ownerId, dayStart, monthEnd),
        this.store.usage.sum(ownerId, monthStart, monthEnd),
        this.store.usage.byFeature(ownerId, monthStart, monthEnd)
      ]);
      this.owners.set(ownerId, {
        dayStart,
        monthStart,
        todayUsd,
        monthUsd,
        byFeature: byFeature as Partial<Record<UsageFeature, number>>
      });
      const routines = await this.store.routines.list(ownerId).catch(() => []);
      for (const routine of routines) {
        const usd = await this.store.usage.sum(ownerId, dayStart, monthEnd, { routineId: routine.id });
        if (usd > 0) this.routineDays.set(routineKey(ownerId, routine.id), { dayStart, usd });
      }
    }
  }

  record(input: RecordInput): void {
    const { sessionId: explicitSession, ...rest } = input;
    const costUsd = Number.isFinite(rest.costUsd) && rest.costUsd > 0 ? rest.costUsd : 0;
    const event: UsageEvent = { ...rest, costUsd, id: randomUUID(), at: rest.at ?? this.now() };

    const cache = this.cache(event.ownerId, event.at);
    if (event.at >= cache.dayStart) cache.todayUsd += costUsd;
    if (event.at >= cache.monthStart) {
      cache.monthUsd += costUsd;
      cache.byFeature[event.feature] = (cache.byFeature[event.feature] ?? 0) + costUsd;
    }
    if (event.routineId) {
      const key = routineKey(event.ownerId, event.routineId);
      const day = this.routineDay(key, event.at);
      day.usd += costUsd;
    }
    const sessionId =
      explicitSession ??
      (event.requestId ? this.requestSessions.get(event.requestId) : undefined) ??
      (event.conversationId ? this.requestSessions.get(event.conversationId) : undefined);
    if (sessionId) this.sessions.set(sessionId, (this.sessions.get(sessionId) ?? 0) + costUsd);
    if (costUsd > 0) {
      const key = averageKey(event.feature, event.model);
      const previous = this.averages.get(key);
      this.averages.set(key, previous === undefined ? costUsd : previous * 0.7 + costUsd * 0.3);
    }

    const write = this.store.usage
      .insert(event)
      .catch((error: unknown) =>
        this.log("usage.store_failed", { error: error instanceof Error ? error.message : String(error) })
      );
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));
  }

  totals(ownerId: string, now = this.now()): UsageTotals {
    const cache = this.cache(ownerId, now);
    return {
      todayUsd: cache.todayUsd,
      monthUsd: cache.monthUsd,
      byFeature: { ...cache.byFeature }
    };
  }

  check(input: {
    ownerId: string;
    estimateUsd: number;
    routineId?: string;
    routineRunUsdSoFar?: number;
    now?: number;
  }): BudgetDecision {
    const now = input.now ?? this.now();
    const estimate = Number.isFinite(input.estimateUsd) && input.estimateUsd > 0 ? input.estimateUsd : 0;
    const cache = this.cache(input.ownerId, now);
    const caps: Array<{ scope: "daily" | "monthly" | "routine_run" | "routine_daily"; spent: number; cap?: number }> = [
      { scope: "monthly", spent: cache.monthUsd, cap: this.budget.monthlyUsd },
      { scope: "daily", spent: cache.todayUsd, cap: this.budget.dailyUsd }
    ];
    if (input.routineId) {
      caps.push(
        { scope: "routine_run", spent: input.routineRunUsdSoFar ?? 0, cap: this.budget.perRoutineRunUsd },
        {
          scope: "routine_daily",
          spent: this.routineDay(routineKey(input.ownerId, input.routineId), now).usd,
          cap: this.budget.perRoutineDailyUsd
        }
      );
    }
    let downgrade = false;
    for (const { scope, spent, cap } of caps) {
      if (cap === undefined) continue;
      if (spent >= cap || spent + estimate > cap) {
        return { allowed: false, scope, message: blockedMessage(scope, cap, spent) };
      }
      if (spent + estimate >= cap * DOWNGRADE_RATIO) downgrade = true;
    }
    return downgrade ? { allowed: true, downgrade: true } : { allowed: true };
  }

  limits(): BudgetLimits {
    return { ...this.budget };
  }

  /** Spend recorded for one WebSocket session. */
  sessionUsd(sessionId: string): number {
    return this.sessions.get(sessionId) ?? 0;
  }

  /** Attribute later events carrying this request (or conversation) id to a session. */
  bindRequest(requestId: string, sessionId: string): void {
    this.requestSessions.set(requestId, sessionId);
    if (this.requestSessions.size > 5_000) {
      const oldest = this.requestSessions.keys().next().value;
      if (oldest !== undefined) this.requestSessions.delete(oldest);
    }
  }

  /** Recent mean cost of one call of this feature on this model, if any. */
  averageCost(feature: UsageFeature, model: string | undefined): number | undefined {
    return model ? this.averages.get(averageKey(feature, model)) : undefined;
  }

  /** Wait for queued store writes (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingWrites]);
  }

  private cache(ownerId: string, now: number): OwnerCache {
    const dayStart = startOfLocalDay(now);
    const monthStart = startOfLocalMonth(now);
    let cache = this.owners.get(ownerId);
    if (!cache) {
      cache = { dayStart, monthStart, todayUsd: 0, monthUsd: 0, byFeature: {} };
      this.owners.set(ownerId, cache);
      return cache;
    }
    if (dayStart > cache.dayStart) {
      cache.dayStart = dayStart;
      cache.todayUsd = 0;
    }
    if (monthStart > cache.monthStart) {
      cache.monthStart = monthStart;
      cache.monthUsd = 0;
      cache.byFeature = {};
    }
    return cache;
  }

  private routineDay(key: string, now: number): RoutineDay {
    const dayStart = startOfLocalDay(now);
    let day = this.routineDays.get(key);
    if (!day || dayStart > day.dayStart) {
      day = { dayStart, usd: 0 };
      this.routineDays.set(key, day);
    }
    return day;
  }
}

function routineKey(ownerId: string, routineId: string): string {
  return `${ownerId}\u0000${routineId}`;
}

function averageKey(feature: UsageFeature, model: string): string {
  return `${feature}\u0000${model}`;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function blockedMessage(
  scope: "daily" | "monthly" | "routine_run" | "routine_daily",
  cap: number,
  spent: number
): string {
  const used = `${formatUsd(spent)} of ${formatUsd(cap)}`;
  switch (scope) {
    case "daily":
      return `Today's budget is used up (${used}), so I'm pausing model calls until midnight. Raise SIBYL_BUDGET_DAILY_USD to keep going.`;
    case "monthly":
      return `This month's budget is used up (${used}), so I'm pausing model calls until the 1st. Raise SIBYL_BUDGET_MONTHLY_USD to keep going.`;
    case "routine_run":
      return `This routine run hit its budget (${used}) and was stopped. Raise SIBYL_BUDGET_ROUTINE_RUN_USD to allow longer runs.`;
    case "routine_daily":
      return `This routine used its daily budget (${used}). It runs again tomorrow, or raise SIBYL_BUDGET_ROUTINE_DAILY_USD.`;
  }
}

/** Budget caps from SIBYL_BUDGET_* env vars (all optional, USD). */
export function budgetLimitsFromEnv(
  env: NodeJS.ProcessEnv,
  log: (event: string, fields?: Record<string, unknown>) => void = () => undefined
): BudgetLimits {
  const read = (name: string): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      log("usage.invalid_budget", { name, value: raw });
      return undefined;
    }
    return value;
  };
  const limits: BudgetLimits = {};
  const daily = read("SIBYL_BUDGET_DAILY_USD");
  const monthly = read("SIBYL_BUDGET_MONTHLY_USD");
  const run = read("SIBYL_BUDGET_ROUTINE_RUN_USD");
  const routineDaily = read("SIBYL_BUDGET_ROUTINE_DAILY_USD");
  if (daily !== undefined) limits.dailyUsd = daily;
  if (monthly !== undefined) limits.monthlyUsd = monthly;
  if (run !== undefined) limits.perRoutineRunUsd = run;
  if (routineDaily !== undefined) limits.perRoutineDailyUsd = routineDaily;
  return limits;
}

/** Create the meter with env budgets and totals rebuilt from the store. */
export async function createUsageMeter(options: {
  store: Store;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}): Promise<GatewayUsageMeter> {
  const log = options.log ?? (() => undefined);
  const limits = budgetLimitsFromEnv(options.env, log);
  const meter = new GatewayUsageMeter({ store: options.store, limits, log, now: options.now });
  try {
    await meter.load([options.ownerId]);
  } catch (error) {
    log("usage.load_failed", { error: error instanceof Error ? error.message : String(error) });
  }
  log("usage.meter_ready", { ...limits });
  return meter;
}
