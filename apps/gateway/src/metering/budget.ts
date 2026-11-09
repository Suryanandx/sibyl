/**
 * Budget decisions for the conversation flow and the usage view sent to the
 * browser. Works with any UsageMeter; session totals and learned averages
 * need the gateway's own meter (GatewayUsageMeter).
 */
import type { BudgetDecision, UsageAttribution, UsageFeature, UsageMeter } from "@open-gpt-live/core";
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
  const decision = meter.check({
    ownerId: input.ownerId,
    estimateUsd,
    sessionId: input.sessionId,
    feature: input.feature,
    ...(input.model ? { model: input.model } : {})
  });
  if (!decision.allowed) return { allowed: false, scope: browserScope(decision.scope), message: decision.message };
  if (!decision.downgrade) return { allowed: true, economy: false };
  const cheaper = economyModel(input.feature, input.catalog);
  return cheaper && cheaper !== input.model
    ? { allowed: true, economy: true, model: cheaper }
    : { allowed: true, economy: true };
}

/**
 * Who spends in a WebSocket session (user, workspace, role), read live on
 * every recorded event and budget check. Returns the unbinding (call it when
 * the connection closes). Meters without attribution ignore it.
 */
export function attributeSessionUsage(meter: UsageMeter, sessionId: string, who: () => UsageAttribution): () => void {
  return meter instanceof GatewayUsageMeter ? meter.attributeSession(sessionId, who) : () => undefined;
}

/** Budget scope as the browser knows it (agent caps show as daily/monthly). */
export function browserScope(scope: Extract<BudgetDecision, { allowed: false }>["scope"]): BudgetBlockedMessage["scope"] {
  if (scope === "agent_daily" || scope === "workspace_daily") return "daily";
  if (scope === "agent_monthly" || scope === "workspace_monthly") return "monthly";
  return scope;
}

export function buildUsageView(input: {
  meter: UsageMeter;
  ownerId: string;
  sessionId: string;
  economyMode: boolean;
  /** Request ids whose cost the browser should show (recent replies). */
  requestIds?: Iterable<string>;
  /** The session's workspace: its spend and budget are shown too. */
  workspaceId?: string;
}): UsageView {
  const totals = input.meter.totals(input.ownerId);
  const limits = input.meter.limits(input.ownerId);
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
    ...workspaceUsage(input.meter, input.ownerId, input.workspaceId),
    economyMode: input.economyMode,
    ...requestCostsFor(input.meter, input.requestIds),
    ...averageReply(input.meter)
  };
}

function workspaceUsage(meter: UsageMeter, ownerId: string, workspaceId: string | undefined): { workspace?: NonNullable<UsageView["workspace"]> } {
  if (!workspaceId || !(meter instanceof GatewayUsageMeter)) return {};
  const usage = meter.workspaceUsage(ownerId, workspaceId);
  return {
    workspace: {
      id: workspaceId,
      todayUsd: roundUsd(usage.todayUsd),
      monthUsd: roundUsd(usage.monthUsd),
      ...(usage.dailyUsd !== undefined ? { dailyBudgetUsd: usage.dailyUsd } : {}),
      ...(usage.monthlyUsd !== undefined ? { monthlyBudgetUsd: usage.monthlyUsd } : {})
    }
  };
}

function averageReply(meter: UsageMeter): { averageReplyUsd?: number; averageReplySamples?: number } {
  if (!(meter instanceof GatewayUsageMeter)) return {};
  const average = meter.recentReplyAverage();
  return average ? { averageReplyUsd: roundUsd(average.usd), averageReplySamples: average.samples } : {};
}

function requestCostsFor(
  meter: UsageMeter,
  requestIds: Iterable<string> | undefined
): { requestCosts?: Record<string, { usd: number; estimated: boolean }> } {
  if (!requestIds || !(meter instanceof GatewayUsageMeter)) return {};
  const out: Record<string, { usd: number; estimated: boolean }> = {};
  for (const id of requestIds) {
    const cost = meter.requestCost(id);
    if (cost) out[id] = { usd: roundUsd(cost.usd), estimated: cost.estimated };
  }
  return Object.keys(out).length > 0 ? { requestCosts: out } : {};
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
