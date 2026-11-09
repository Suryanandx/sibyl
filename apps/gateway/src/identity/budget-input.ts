/**
 * Reading a budget change from a request (Admin → Organization, Settings →
 * Workspace): `{ dailyUsd?, monthlyUsd? }`, each a non-negative number or
 * null (no cap). Fields left out keep their current value. `bounds` are caps
 * the value may not exceed (the SIBYL_BUDGET_* env caps for the organization).
 */
import type { SpendCaps } from "@open-gpt-live/core";
import { IdentityError } from "./service.js";

const LABEL = { dailyUsd: "daily", monthlyUsd: "monthly" } as const;
const ENV = { dailyUsd: "SIBYL_BUDGET_DAILY_USD", monthlyUsd: "SIBYL_BUDGET_MONTHLY_USD" } as const;

export function applyBudgetPatch(current: SpendCaps | undefined, input: unknown, bounds: SpendCaps = {}): SpendCaps | undefined {
  if (input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new IdentityError(400, "invalid_budget", "A budget is { dailyUsd, monthlyUsd }.");
  const next: SpendCaps = { ...(current ?? {}) };
  for (const key of ["dailyUsd", "monthlyUsd"] as const) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value === null || value === "") {
      delete next[key];
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
      throw new IdentityError(400, "invalid_budget", `The ${LABEL[key]} budget must be an amount in USD (0 or more).`);
    }
    const bound = bounds[key];
    if (bound !== undefined && value > bound) {
      throw new IdentityError(400, "budget_above_limit", `The ${LABEL[key]} budget can be at most $${bound} (${ENV[key]} on the server).`);
    }
    next[key] = Math.round(value * 100) / 100;
  }
  return next.dailyUsd !== undefined || next.monthlyUsd !== undefined ? next : undefined;
}
