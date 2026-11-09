/**
 * Budget decisions for the conversation flow and the usage view sent to the
 * browser. Works with any UsageMeter; session totals and learned averages
 * need the gateway's own meter (GatewayUsageMeter).
 */
import type { UsageFeature, UsageMeter } from "@open-gpt-live/core";
import type { BudgetBlockedMessage, ModelCatalog, UsageView } from "@open-gpt-live/protocol";
import { GatewayUsageMeter } from "./meter.js";
import { CostEstimator, PricingTable } from "./pricing.js";

export type TurnBudget =
  | { allowed: false; scope: BudgetBlockedMessage["scope"]; message: string }
  | {
      allowed: true;
      /** Close to a cap: run this turn on the Cheapest preset. */
      economy: boolean;
      /** Cheaper model to use instead (only set when economy and it differs). */
      model?: string;
    };

/** Expected cost of one turn: the model's recent average, else pricing × typical usage. */
export function estimateTurnUsd(
  meter: UsageMeter,
  feature: UsageFeature,
  model: string | undefined,
  catalog: ModelCatalog | undefined
): number {
  if (meter instanceof GatewayUsageMeter) {
    const average = meter.averageCost(feature, model);
    if (average !== undefined) return average;
  }
  const pricing = meter instanceof GatewayUsageMeter ? meter.pricing : new PricingTable();
  return new CostEstimator(pricing, () => catalog).turn(feature, model);
}

/** The Cheapest preset's model for a voice or brain turn, if the catalog has one. */
export function economyModel(feature: "voice" | "brain", catalog: ModelCatalog | undefined): string | undefined {
  const preset = catalog?.presets?.find((p) => p.id === "cheapest");
  return feature === "voice" ? preset?.settings.voiceModel : preset?.settings.llmModel;
}

/**
 * Check the budget before a voice turn or deep-brain run. Binds the request to
 * the session so its spend counts toward "this session".
 */
export function checkTurnBudget(input: {
  meter: UsageMeter;
  ownerId: string;
  feature: "voice" | "brain";
  model: string | undefined;
  catalog: ModelCatalog | undefined;
  sessionId: string;
  requestId: string;
}): TurnBudget {
  const { meter } = input;
  if (meter instanceof GatewayUsageMeter) meter.bindRequest(input.requestId, input.sessionId);
  const estimateUsd = estimateTurnUsd(meter, input.feature, input.model, input.catalog);
  const decision = meter.check({ ownerId: input.ownerId, estimateUsd });
  if (!decision.allowed) return decision;
  if (!decision.downgrade) return { allowed: true, economy: false };
  const cheaper = economyModel(input.feature, input.catalog);
  return cheaper && cheaper !== input.model
    ? { allowed: true, economy: true, model: cheaper }
    : { allowed: true, economy: true };
}

export function buildUsageView(input: {
  meter: UsageMeter;
  ownerId: string;
  sessionId: string;
  economyMode: boolean;
}): UsageView {
  const totals = input.meter.totals(input.ownerId);
  const limits = input.meter.limits();
  const byFeature: Record<string, number> = {};
  for (const [feature, usd] of Object.entries(totals.byFeature)) {
    if (typeof usd === "number" && usd > 0) byFeature[feature] = roundUsd(usd);
  }
  const sessionUsd =
    input.meter instanceof GatewayUsageMeter ? input.meter.sessionUsd(input.sessionId) : totals.sessionUsd ?? 0;
  return {
    todayUsd: roundUsd(totals.todayUsd),
    monthUsd: roundUsd(totals.monthUsd),
    sessionUsd: roundUsd(sessionUsd),
    ...(limits.dailyUsd !== undefined ? { dailyBudgetUsd: limits.dailyUsd } : {}),
    ...(limits.monthlyUsd !== undefined ? { monthlyBudgetUsd: limits.monthlyUsd } : {}),
    byFeature,
    economyMode: input.economyMode
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
