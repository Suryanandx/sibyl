import { DEFAULT_OWNER_ID, ORG_SETTINGS_KV_KEY, createMemoryStore } from "@open-gpt-live/core";
import { describe, expect, it } from "vitest";
import { applyAppBudgets, buildUsageView, createUsageMeter, GatewayUsageMeter } from "./index.js";

const OWNER = DEFAULT_OWNER_ID;
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();

describe("in-app budgets in the usage meter", () => {
  it("a workspace budget blocks spending in that workspace only", () => {
    const meter = new GatewayUsageMeter({ store: createMemoryStore(), now: () => NOW });
    meter.configureBudgets({ workspaces: { sales: { dailyUsd: 0.5 } } });
    meter.record({ ownerId: OWNER, feature: "brain", model: "m", costUsd: 0.45, estimated: false, workspaceId: "sales" });
    // 0.45 of 0.5: close to the cap → cheaper models in Sales.
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.01, workspaceId: "sales" })).toEqual({ allowed: true, downgrade: true });
    const blocked = meter.check({ ownerId: OWNER, estimateUsd: 0.1, workspaceId: "sales" });
    expect(blocked).toMatchObject({ allowed: false, scope: "workspace_daily" });
    expect(blocked.allowed === false && blocked.message).toMatch(/workspace's budget for today/);
    // Other workspaces (and the default one) are not affected.
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.1, workspaceId: "default" })).toEqual({ allowed: true });
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.1 })).toEqual({ allowed: true });
    // The session's workspace counts when the caller doesn't say.
    meter.attributeSession("s1", () => ({ workspaceId: "sales" }));
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.1, sessionId: "s1" }).allowed).toBe(false);
    // Tomorrow it resets.
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.1, workspaceId: "sales", now: NOW + 86_400_000 })).toEqual({ allowed: true });
  });

  it("the organization budget tightens the env caps but never loosens them", () => {
    const meter = new GatewayUsageMeter({ store: createMemoryStore(), limits: { dailyUsd: 10, monthlyUsd: 100, perRoutineRunUsd: 1 }, now: () => NOW });
    expect(meter.limits()).toEqual({ dailyUsd: 10, monthlyUsd: 100, perRoutineRunUsd: 1 });
    meter.configureBudgets({ org: { dailyUsd: 2, monthlyUsd: 500 } });
    expect(meter.limits()).toEqual({ dailyUsd: 2, monthlyUsd: 100, perRoutineRunUsd: 1 });
    expect(meter.envLimits()).toEqual({ dailyUsd: 10, monthlyUsd: 100, perRoutineRunUsd: 1 });
    meter.record({ ownerId: OWNER, feature: "voice", model: "m", costUsd: 1.9, estimated: false });
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.2 })).toMatchObject({ allowed: false, scope: "daily" });
    // Without env caps the in-app value is the cap.
    const free = new GatewayUsageMeter({ store: createMemoryStore(), now: () => NOW });
    free.configureBudgets({ org: { monthlyUsd: 3 } });
    expect(free.limits()).toEqual({ monthlyUsd: 3 });
  });

  it("the economy switch follows the tightest applicable budget", () => {
    const meter = new GatewayUsageMeter({ store: createMemoryStore(), limits: { dailyUsd: 100 }, now: () => NOW });
    meter.configureBudgets({ workspaces: { w: { monthlyUsd: 1 } } });
    meter.record({ ownerId: OWNER, feature: "voice", model: "m", costUsd: 0.9, estimated: false, workspaceId: "w" });
    // 0.9 of the org's 100 is nothing; 0.9 of the workspace's 1 is 90%.
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.01, workspaceId: "w" })).toEqual({ allowed: true, downgrade: true });
    expect(meter.check({ ownerId: OWNER, estimateUsd: 0.01, workspaceId: "other" })).toEqual({ allowed: true });
  });

  it("loads budgets and workspace spend from the store on start, and shows both in the usage view", async () => {
    const store = createMemoryStore();
    await store.workspaces.upsert({ id: "w", ownerId: OWNER, name: "W", budget: { dailyUsd: 5 }, createdAt: 1, updatedAt: 1 });
    await store.kv.set(OWNER, ORG_SETTINGS_KV_KEY, { defaultRole: "member", budget: { monthlyUsd: 50 } });
    await store.usage.insert({ id: "e1", at: NOW - 1000, ownerId: OWNER, feature: "brain", model: "m", costUsd: 1.25, estimated: false, workspaceId: "w" });
    await store.usage.insert({ id: "e2", at: NOW - 1000, ownerId: OWNER, feature: "brain", model: "m", costUsd: 0.5, estimated: false });
    const meter = await createUsageMeter({ store, ownerId: OWNER, env: { SIBYL_BUDGET_MONTHLY_USD: "80" }, now: () => NOW });
    expect(meter.limits()).toEqual({ monthlyUsd: 50 });
    expect(meter.workspaceUsage(OWNER, "w")).toEqual({ todayUsd: 1.25, monthUsd: 1.25, dailyUsd: 5 });
    expect(meter.workspaceUsage(OWNER, "default")).toMatchObject({ todayUsd: 0.5 });
    const view = buildUsageView({ meter, ownerId: OWNER, sessionId: "s", economyMode: false, workspaceId: "w" });
    expect(view).toMatchObject({ todayUsd: 1.75, monthlyBudgetUsd: 50, workspace: { id: "w", todayUsd: 1.25, dailyBudgetUsd: 5 } });
    // A change in the store reaches the meter through applyAppBudgets.
    await store.workspaces.upsert({ id: "w", ownerId: OWNER, name: "W", createdAt: 1, updatedAt: 2 });
    await applyAppBudgets(meter, store, OWNER);
    expect(meter.workspaceUsage(OWNER, "w").dailyUsd).toBeUndefined();
  });
});
