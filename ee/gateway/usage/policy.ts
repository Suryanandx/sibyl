/**
 * Advanced usage controls — the usage policy the meter asks before each call.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * The meter only asks after the organisation caps (SIBYL_BUDGET_*) allowed
 * the call, so this can only add limits. Spend without a person (background
 * work of older records) is left to the organisation caps.
 *
 * Order of checks: allowed models, the per-request cap, the person's daily and
 * monthly caps (their own, else their role's), then the rate limit — so a
 * request that is refused for another reason doesn't use up a rate slot.
 */
import type { BudgetDecision, UsageEvent, UsagePolicy, UsagePolicyCheck } from "../../../packages/core/src/usage";
import { startOfLocalDay, startOfLocalMonth, DOWNGRADE_RATIO } from "../../../apps/gateway/src/metering/meter";
import { capsFor, money, type UsageControls } from "./controls";

export type Period = "daily" | "monthly";

/** A threshold crossing (or a refusal) the alerts module reports. */
export interface UsageAlert {
  userId: string;
  workspaceId?: string;
  period: Period;
  /** Percent of the cap reached (100 when blocked). */
  thresholdPercent: number;
  spentUsd: number;
  capUsd: number;
  /** The person was refused a request because of this cap. */
  blocked: boolean;
  /** Start of the day or month the alert belongs to (dedupe key). */
  periodStart: number;
  at: number;
}

interface Spend {
  dayStart: number;
  monthStart: number;
  todayUsd: number;
  monthUsd: number;
}

/** Each person's spend today and this month (all workspaces), kept in memory. */
export class SpendLedger {
  private readonly spend = new Map<string, Spend>();

  /** Rebuild from this month's events (oldest first). */
  load(events: readonly UsageEvent[], now: number): void {
    this.spend.clear();
    for (const event of events) this.add(event, now);
  }

  add(event: Pick<UsageEvent, "userId" | "costUsd" | "at">, now = event.at): void {
    if (!event.userId || !(event.costUsd > 0)) return;
    const spend = this.of(event.userId, Math.max(now, event.at));
    if (event.at >= spend.monthStart) spend.monthUsd += event.costUsd;
    if (event.at >= spend.dayStart) spend.todayUsd += event.costUsd;
  }

  totals(userId: string, now: number): { todayUsd: number; monthUsd: number } {
    const spend = this.of(userId, now);
    return { todayUsd: spend.todayUsd, monthUsd: spend.monthUsd };
  }

  users(): string[] {
    return [...this.spend.keys()];
  }

  private of(userId: string, now: number): Spend {
    const dayStart = startOfLocalDay(now);
    const monthStart = startOfLocalMonth(now);
    let spend = this.spend.get(userId);
    if (!spend) {
      spend = { dayStart, monthStart, todayUsd: 0, monthUsd: 0 };
      this.spend.set(userId, spend);
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
}

/** Sliding one-minute window of requests per person. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Count a request when under `limit`; false when the window is full. */
  take(userId: string, limit: number, now: number): boolean {
    const recent = (this.hits.get(userId) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= limit) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }

  /** Seconds until the oldest request in the window leaves it. */
  retryAfter(userId: string, now: number): number {
    const oldest = this.hits.get(userId)?.[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
  }
}

/** Interactive requests (a chat reply, a voice turn) count toward the rate limit. */
const RATE_LIMITED = new Set(["voice", "brain"]);

export interface PolicyDeps {
  controls(): UsageControls;
  ledger: SpendLedger;
  limiter: RateLimiter;
  /** A threshold was crossed or a request refused by a cap (deduplicated by the receiver). */
  alert(alert: UsageAlert): void;
}

export function createUsageControlsPolicy(deps: PolicyDeps): UsagePolicy {
  /** The role each person last made a request under: threshold alerts on recorded spend use its caps. */
  const roles = new Map<string, string>();
  return {
    check(input: UsagePolicyCheck): BudgetDecision | undefined {
      if (!input.userId) return undefined;
      if (input.role) roles.set(input.userId, input.role);
      const controls = deps.controls();
      if (input.model && controls.allowedModels.length > 0 && !controls.allowedModels.includes(input.model)) {
        return block(`Your organisation doesn't allow the model ${input.model}. Pick one of: ${controls.allowedModels.join(", ")}.`);
      }
      if (controls.perRequestUsd !== undefined && input.estimateUsd > controls.perRequestUsd) {
        return block(
          `This request would cost about ${money(input.estimateUsd)}, over your organisation's limit of ${money(controls.perRequestUsd)} per request. Pick a cheaper model.`
        );
      }
      const caps = capsFor(controls, input.userId, input.role);
      const spent = deps.ledger.totals(input.userId, input.now);
      let downgrade = false;
      for (const [period, spentUsd, capUsd] of [
        ["monthly", spent.monthUsd, caps.monthlyUsd],
        ["daily", spent.todayUsd, caps.dailyUsd]
      ] as const) {
        if (capUsd === undefined) continue;
        if (spentUsd >= capUsd || spentUsd + input.estimateUsd > capUsd) {
          deps.alert({
            userId: input.userId,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            period,
            thresholdPercent: 100,
            spentUsd,
            capUsd,
            blocked: true,
            periodStart: period === "daily" ? startOfLocalDay(input.now) : startOfLocalMonth(input.now),
            at: input.now
          });
          return block(
            period === "daily"
              ? `You've used your daily budget (${money(spentUsd)} of ${money(capUsd)}), so model calls are paused until midnight. Ask an admin to raise it.`
              : `You've used your monthly budget (${money(spentUsd)} of ${money(capUsd)}), so model calls are paused until the 1st. Ask an admin to raise it.`
          );
        }
        if (spentUsd + input.estimateUsd >= capUsd * DOWNGRADE_RATIO) downgrade = true;
      }
      if (controls.requestsPerMinute !== undefined && input.feature && RATE_LIMITED.has(input.feature)) {
        if (!deps.limiter.take(input.userId, controls.requestsPerMinute, input.now)) {
          const wait = deps.limiter.retryAfter(input.userId, input.now);
          return block(`You've sent ${controls.requestsPerMinute} requests in the last minute, your organisation's limit. Try again in ${wait} s.`);
        }
      }
      return downgrade ? { allowed: true, downgrade: true } : undefined;
    },

    recorded(event: UsageEvent): void {
      if (!event.userId || !(event.costUsd > 0)) return;
      const before = deps.ledger.totals(event.userId, event.at);
      deps.ledger.add(event);
      const after = deps.ledger.totals(event.userId, event.at);
      const controls = deps.controls();
      const caps = capsFor(controls, event.userId, roles.get(event.userId));
      for (const [period, from, to, capUsd] of [
        ["daily", before.todayUsd, after.todayUsd, caps.dailyUsd],
        ["monthly", before.monthUsd, after.monthUsd, caps.monthlyUsd]
      ] as const) {
        if (capUsd === undefined || capUsd <= 0) continue;
        for (const percent of controls.alerts.thresholds) {
          const line = (capUsd * percent) / 100;
          if (from < line && to >= line) {
            deps.alert({
              userId: event.userId,
              ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
              period,
              thresholdPercent: percent,
              spentUsd: to,
              capUsd,
              blocked: false,
              periodStart: period === "daily" ? startOfLocalDay(event.at) : startOfLocalMonth(event.at),
              at: event.at
            });
          }
        }
      }
    }
  };
}

function block(message: string): BudgetDecision {
  return { allowed: false, scope: "policy", message };
}
