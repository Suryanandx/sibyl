/**
 * The gateway's UsageMeter: records every model call into `store.usage` and
 * keeps today/month totals per owner in memory so budget checks are
 * synchronous. The cache is rebuilt from the store on start.
 *
 * Days and months follow the server's local time zone.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_OWNER_ID, DEFAULT_WORKSPACE_ID } from "@open-gpt-live/core";
import type {
  AgentBudgetScope,
  AppBudgets,
  BudgetDecision,
  BudgetLimits,
  CreditEntry,
  Store,
  UsageAttribution,
  UsageEvent,
  UsageFeature,
  UsageMeter,
  UsagePolicy,
  UsageTotals
} from "@open-gpt-live/core";
import { applyAppBudgets } from "./app-budgets.js";
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

/** One agent's spend (agent budgets). Persisted by the agents runtime, seeded on start. */
export interface AgentSpend {
  dayStart: number;
  monthStart: number;
  todayUsd: number;
  monthUsd: number;
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
  /** Caps from SIBYL_BUDGET_* (the organization caps' upper bound). */
  private readonly budget: BudgetLimits;
  /** Caps set in the app (Admin → Organization, Settings → Workspace). */
  /** In-app budgets per organization (one meter serves every organization in hosted Sibyl). */
  private readonly appBudgets = new Map<string, AppBudgets>();
  /** Spend per workspace today / this month (key: owner + workspace). */
  private readonly workspaceSpends = new Map<string, AgentSpend>();
  private readonly now: () => number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private readonly owners = new Map<string, OwnerCache>();
  private readonly routineDays = new Map<string, RoutineDay>();
  private readonly sessions = new Map<string, number>();
  private readonly requestSessions = new Map<string, string>();
  /** Request id → agent whose budget the request's spend counts toward. */
  private readonly requestAgents = new Map<string, string>();
  private readonly agentSpends = new Map<string, AgentSpend>();
  /** Cost per request id (a reply, a deep-work run, a deck), most recent last. */
  private readonly requestCosts = new Map<string, { usd: number; estimated: boolean }>();
  /** Rolling mean cost per call, keyed by feature + model. */
  private readonly averages = new Map<string, number>();
  private pendingWrites = new Set<Promise<void>>();
  /** WebSocket session → who is spending there (read live: the workspace can change). */
  private readonly sessionAttribution = new Map<string, () => UsageAttribution>();
  /** Usage policies (Enterprise advanced usage controls), asked after the built-in caps. */
  private readonly policies: UsagePolicy[] = [];

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
      // Workspace spend this month (workspace budgets).
      for (const [key] of this.workspaceSpends) if (key.startsWith(`${ownerId}\u0000`)) this.workspaceSpends.delete(key);
      for (const event of await this.store.usage.list(ownerId, monthStart, monthEnd)) {
        this.addWorkspaceSpend(ownerId, event.workspaceId, event.costUsd, event.at, now);
      }
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
    const agentId = rest.agentId ?? (rest.requestId ? this.requestAgents.get(rest.requestId) : undefined);
    const sessionId =
      explicitSession ??
      (rest.requestId ? this.requestSessions.get(rest.requestId) : undefined) ??
      (rest.conversationId ? this.requestSessions.get(rest.conversationId) : undefined);
    const who = sessionId ? this.attributionOf(sessionId) : {};
    const userId = rest.userId ?? who.userId;
    const workspaceId = rest.workspaceId ?? who.workspaceId;
    const event: UsageEvent = {
      ...rest,
      ...(agentId ? { agentId } : {}),
      ...(userId ? { userId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      costUsd,
      id: randomUUID(),
      at: rest.at ?? this.now()
    };
    if (agentId) {
      const spend = this.agentSpend(event.ownerId, agentId, event.at);
      if (event.at >= spend.dayStart) spend.todayUsd += costUsd;
      if (event.at >= spend.monthStart) spend.monthUsd += costUsd;
    }

    const cache = this.cache(event.ownerId, event.at);
    if (event.at >= cache.dayStart) cache.todayUsd += costUsd;
    if (event.at >= cache.monthStart) {
      cache.monthUsd += costUsd;
      cache.byFeature[event.feature] = (cache.byFeature[event.feature] ?? 0) + costUsd;
    }
    this.addWorkspaceSpend(event.ownerId, event.workspaceId, costUsd, event.at, event.at);
    if (event.routineId) {
      const key = routineKey(event.ownerId, event.routineId);
      const day = this.routineDay(key, event.at);
      day.usd += costUsd;
    }
    if (sessionId) this.sessions.set(sessionId, (this.sessions.get(sessionId) ?? 0) + costUsd);
    if (event.requestId && event.feature !== "warmup" && event.feature !== "scout") {
      const previous = this.requestCosts.get(event.requestId);
      this.requestCosts.delete(event.requestId);
      this.requestCosts.set(event.requestId, {
        usd: (previous?.usd ?? 0) + costUsd,
        estimated: Boolean(previous?.estimated) || event.estimated
      });
      if (this.requestCosts.size > 2_000) {
        const oldest = this.requestCosts.keys().next().value;
        if (oldest !== undefined) this.requestCosts.delete(oldest);
      }
    }
    if (costUsd > 0) {
      const key = averageKey(event.feature, event.model);
      const previous = this.averages.get(key);
      this.averages.set(key, previous === undefined ? costUsd : previous * 0.7 + costUsd * 0.3);
    }

    // A policy's ledger charge (hosted credits) commits with the event in one transaction.
    let credit: CreditEntry | undefined;
    for (const policy of this.policies) {
      try {
        credit ??= policy.charge?.(event);
      } catch (error) {
        this.log("usage.policy_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const write = this.store.usage
      .insert(event, credit)
      .catch((error: unknown) =>
        this.log("usage.store_failed", { error: error instanceof Error ? error.message : String(error) })
      );
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));
    for (const policy of this.policies) {
      try {
        policy.recorded?.(event);
      } catch (error) {
        this.log("usage.policy_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
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
    agent?: AgentBudgetScope;
    userId?: string;
    workspaceId?: string;
    role?: string;
    sessionId?: string;
    feature?: UsageFeature;
    model?: string;
    now?: number;
  }): BudgetDecision {
    const now = input.now ?? this.now();
    const estimate = Number.isFinite(input.estimateUsd) && input.estimateUsd > 0 ? input.estimateUsd : 0;
    const cache = this.cache(input.ownerId, now);
    const org = this.limits(input.ownerId);
    const caps: Array<{ scope: BlockedScope; spent: number; cap?: number }> = [
      { scope: "monthly", spent: cache.monthUsd, cap: org.monthlyUsd },
      { scope: "daily", spent: cache.todayUsd, cap: org.dailyUsd }
    ];
    // The workspace's own caps (Settings → Workspace). The economy switch below
    // follows whichever applicable cap is closest.
    const workspaceId = input.workspaceId ?? (input.sessionId ? this.attributionOf(input.sessionId).workspaceId : undefined) ?? DEFAULT_WORKSPACE_ID;
    const workspaceCaps = this.appBudgets.get(input.ownerId)?.workspaces?.[workspaceId];
    if (workspaceCaps) {
      const spend = this.workspaceSpend(input.ownerId, workspaceId, now);
      caps.push(
        { scope: "workspace_monthly", spent: spend.monthUsd, cap: workspaceCaps.monthlyUsd },
        { scope: "workspace_daily", spent: spend.todayUsd, cap: workspaceCaps.dailyUsd }
      );
    }
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
    if (input.agent) {
      const spend = this.agentSpend(input.ownerId, input.agent.id, now);
      caps.push(
        { scope: "agent_monthly", spent: spend.monthUsd, cap: input.agent.monthlyUsd },
        { scope: "agent_daily", spent: spend.todayUsd, cap: input.agent.dailyUsd }
      );
    }
    let downgrade = false;
    for (const { scope, spent, cap } of caps) {
      if (cap === undefined) continue;
      if (spent >= cap || spent + estimate > cap) {
        return { allowed: false, scope, message: blockedMessage(scope, cap, spent, input.agent?.name) };
      }
      if (spent + estimate >= cap * DOWNGRADE_RATIO) downgrade = true;
    }
    // The built-in caps allowed it: now the usage policies (none in the open-source edition).
    if (this.policies.length > 0) {
      const who = input.sessionId ? this.attributionOf(input.sessionId) : {};
      const userId = input.userId ?? who.userId;
      const workspaceId = input.workspaceId ?? who.workspaceId;
      const role = input.role ?? who.role;
      for (const policy of this.policies) {
        let decision: BudgetDecision | undefined;
        try {
          decision = policy.check({
            ownerId: input.ownerId,
            estimateUsd: estimate,
            now,
            ...(userId ? { userId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(role ? { role } : {}),
            ...(input.feature ? { feature: input.feature } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.routineId ? { routineId: input.routineId } : {})
          });
        } catch (error) {
          // A broken policy never blocks spending the built-in caps allow.
          this.log("usage.policy_failed", { error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (decision && !decision.allowed) return decision;
        if (decision?.downgrade) downgrade = true;
      }
    }
    return downgrade ? { allowed: true, downgrade: true } : { allowed: true };
  }

  /** The organization caps in force: the env caps (per organization), tightened by its in-app budget. */
  limits(ownerId: string = DEFAULT_OWNER_ID): BudgetLimits {
    const app = this.appBudgets.get(ownerId)?.org ?? {};
    const tighter = (env: number | undefined, set: number | undefined) => (env === undefined ? set : set === undefined ? env : Math.min(env, set));
    const dailyUsd = tighter(this.budget.dailyUsd, app.dailyUsd);
    const monthlyUsd = tighter(this.budget.monthlyUsd, app.monthlyUsd);
    const { dailyUsd: _d, monthlyUsd: _m, ...rest } = this.budget;
    return { ...rest, ...(dailyUsd !== undefined ? { dailyUsd } : {}), ...(monthlyUsd !== undefined ? { monthlyUsd } : {}) };
  }

  /** The SIBYL_BUDGET_* caps alone (the upper bound for the in-app organization budget). */
  envLimits(): BudgetLimits {
    return { ...this.budget };
  }

  configureBudgets(budgets: AppBudgets, ownerId: string = DEFAULT_OWNER_ID): void {
    this.appBudgets.set(ownerId, structuredClone(budgets));
  }

  /** A workspace's spend and caps (Settings → Usage). */
  workspaceUsage(ownerId: string, workspaceId: string, now = this.now()): { todayUsd: number; monthUsd: number; dailyUsd?: number; monthlyUsd?: number } {
    const spend = this.workspaceSpend(ownerId, workspaceId, now);
    const caps = this.appBudgets.get(ownerId)?.workspaces?.[workspaceId] ?? {};
    return {
      todayUsd: spend.todayUsd,
      monthUsd: spend.monthUsd,
      ...(caps.dailyUsd !== undefined ? { dailyUsd: caps.dailyUsd } : {}),
      ...(caps.monthlyUsd !== undefined ? { monthlyUsd: caps.monthlyUsd } : {})
    };
  }

  private workspaceSpend(ownerId: string, workspaceId: string, now: number): AgentSpend {
    const key = `${ownerId}\u0000${workspaceId}`;
    const dayStart = startOfLocalDay(now);
    const monthStart = startOfLocalMonth(now);
    let spend = this.workspaceSpends.get(key);
    if (!spend) {
      spend = { dayStart, monthStart, todayUsd: 0, monthUsd: 0 };
      this.workspaceSpends.set(key, spend);
    }
    if (dayStart > spend.dayStart) {
      spend.dayStart = dayStart;
      spend.todayUsd = 0;
    }
    if (monthStart > spend.monthStart) {
      spend.monthStart = monthStart;
      spend.monthUsd = 0;
    }
    return spend;
  }

  /** Count spend toward its workspace (events without one belong to the default workspace). */
  private addWorkspaceSpend(ownerId: string, workspaceId: string | undefined, usd: number, at: number, now: number): void {
    if (!(usd > 0)) return;
    const spend = this.workspaceSpend(ownerId, workspaceId ?? DEFAULT_WORKSPACE_ID, now);
    if (at >= spend.dayStart) spend.todayUsd += usd;
    if (at >= spend.monthStart) spend.monthUsd += usd;
  }

  addPolicy(policy: UsagePolicy): () => void {
    this.policies.push(policy);
    return () => {
      const index = this.policies.indexOf(policy);
      if (index >= 0) this.policies.splice(index, 1);
    };
  }

  /**
   * Say who spends in a WebSocket session (read on every event, so a
   * workspace switch applies at once). Returns the unbinding.
   */
  attributeSession(sessionId: string, attribution: () => UsageAttribution): () => void {
    this.sessionAttribution.set(sessionId, attribution);
    return () => {
      if (this.sessionAttribution.get(sessionId) === attribution) this.sessionAttribution.delete(sessionId);
    };
  }

  private attributionOf(sessionId: string): UsageAttribution {
    try {
      return this.sessionAttribution.get(sessionId)?.() ?? {};
    } catch {
      return {};
    }
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

  /** Count later events carrying this request id toward an agent's budget. */
  bindAgent(requestId: string, agentId: string): void {
    this.requestAgents.set(requestId, agentId);
    if (this.requestAgents.size > 5_000) {
      const oldest = this.requestAgents.keys().next().value;
      if (oldest !== undefined) this.requestAgents.delete(oldest);
    }
  }

  /** An agent's spend today and this month (a copy). */
  agentTotals(ownerId: string, agentId: string, now = this.now()): AgentSpend {
    return { ...this.agentSpend(ownerId, agentId, now) };
  }

  /** Restore an agent's spend after a restart (only the current day/month count). */
  seedAgentSpend(ownerId: string, agentId: string, saved: AgentSpend, now = this.now()): void {
    const spend = this.agentSpend(ownerId, agentId, now);
    if (saved.monthStart === spend.monthStart) spend.monthUsd = Math.max(spend.monthUsd, saved.monthUsd);
    if (saved.dayStart === spend.dayStart) spend.todayUsd = Math.max(spend.todayUsd, saved.todayUsd);
  }

  /** Mean cost of the most recent replies (up to `limit`), for "what a reply really costs". */
  recentReplyAverage(limit = 50): { usd: number; samples: number } | undefined {
    const costs = [...this.requestCosts.values()].slice(-limit).map((c) => c.usd).filter((usd) => usd > 0);
    if (costs.length === 0) return undefined;
    return { usd: costs.reduce((a, b) => a + b, 0) / costs.length, samples: costs.length };
  }

  /** What one request (reply, deep-work run, deck) has cost so far. */
  requestCost(requestId: string): { usd: number; estimated: boolean } | undefined {
    return this.requestCosts.get(requestId);
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

  private agentSpend(ownerId: string, agentId: string, now: number): AgentSpend {
    const key = routineKey(ownerId, `agent:${agentId}`);
    const dayStart = startOfLocalDay(now);
    const monthStart = startOfLocalMonth(now);
    let spend = this.agentSpends.get(key);
    if (!spend) {
      spend = { dayStart, monthStart, todayUsd: 0, monthUsd: 0 };
      this.agentSpends.set(key, spend);
    }
    if (dayStart > spend.dayStart) {
      spend.dayStart = dayStart;
      spend.todayUsd = 0;
    }
    if (monthStart > spend.monthStart) {
      spend.monthStart = monthStart;
      spend.monthUsd = 0;
    }
    return spend;
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

/** Scopes of the built-in caps (usage policies write their own messages). */
type BlockedScope = Exclude<Extract<BudgetDecision, { allowed: false }>["scope"], "policy" | "credits">;

function blockedMessage(scope: BlockedScope, cap: number, spent: number, agentName = "This agent"): string {
  const used = `${formatUsd(spent)} of ${formatUsd(cap)}`;
  switch (scope) {
    case "agent_daily":
      return `${agentName} used its daily budget (${used}), so it is paused until midnight. Raise its budget in the agent's settings to keep going.`;
    case "agent_monthly":
      return `${agentName} used its monthly budget (${used}), so it is paused until the 1st. Raise its budget in the agent's settings to keep going.`;
    case "daily":
      return `Today's budget is used up (${used}), so I'm pausing model calls until midnight. An organization admin can raise it in Admin → Organization (up to SIBYL_BUDGET_DAILY_USD).`;
    case "monthly":
      return `This month's budget is used up (${used}), so I'm pausing model calls until the 1st. An organization admin can raise it in Admin → Organization (up to SIBYL_BUDGET_MONTHLY_USD).`;
    case "workspace_daily":
      return `This workspace's budget for today is used up (${used}), so I'm pausing model calls here until midnight. A workspace admin can raise it in Settings → Workspace.`;
    case "workspace_monthly":
      return `This workspace's budget for this month is used up (${used}), so I'm pausing model calls here until the 1st. A workspace admin can raise it in Settings → Workspace.`;
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
  /** false: don't rebuild totals now (each organization's runtime loads its own). */
  load?: boolean;
}): Promise<GatewayUsageMeter> {
  const log = options.log ?? (() => undefined);
  const limits = budgetLimitsFromEnv(options.env, log);
  const meter = new GatewayUsageMeter({ store: options.store, limits, log, now: options.now });
  try {
    if (options.load !== false) {
      await meter.load([options.ownerId]);
      // Budgets set in the app (organization and workspaces).
      await applyAppBudgets(meter, options.store, options.ownerId);
    }
  } catch (error) {
    log("usage.load_failed", { error: error instanceof Error ? error.message : String(error) });
  }
  log("usage.meter_ready", { ...limits });
  return meter;
}
