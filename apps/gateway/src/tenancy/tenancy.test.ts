import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type UsageEvent } from "@open-gpt-live/core";
import { createSqliteStore } from "@open-gpt-live/store";
import { describe, expect, test } from "vitest";
import { GatewayUsageMeter } from "../metering/meter.js";
import { orgOfRoom, roomName, roomSpace } from "../realtime/rooms.js";
import { CreditsService, creditsMargin } from "./credits.js";
import { checkOpenRouterKey, resolveModelAccess } from "./model-access.js";
import { deploymentMode, newOrgId, splitTenantPath, tenantPath } from "./mode.js";
import { SignupTickets } from "../identity/signup-tickets.js";
import { TenantRegistry, type TenantHandle } from "./registry.js";

const event = (orgId: string, costUsd: number, id = randomBytes(4).toString("hex")): UsageEvent => ({ id, at: Date.now(), ownerId: orgId, feature: "brain", model: "m", costUsd, estimated: false });

describe("modes and organization paths", () => {
  test("self-hosted is the default; hosted is explicit", () => {
    expect(deploymentMode({})).toBe("self-hosted");
    expect(deploymentMode({ SIBYL_MODE: "hosted" })).toBe("hosted");
    expect(() => deploymentMode({ SIBYL_MODE: "cloud" })).toThrow(/SIBYL_MODE/);
  });

  test("hosted callbacks carry the organization; the self-hosted organization's addresses don't change", () => {
    const orgId = newOrgId();
    expect(tenantPath("owner", "/api/monitors/hooks/x")).toBe("/api/monitors/hooks/x");
    expect(tenantPath(orgId, "/api/monitors/hooks/x")).toBe(`/o/${orgId}/api/monitors/hooks/x`);
    expect(splitTenantPath(`/o/${orgId}/api/presence/slack/events`)).toEqual({ orgId, path: "/api/presence/slack/events" });
    expect(splitTenantPath("/o/not-an-org/api/x")).toBeUndefined();
    expect(splitTenantPath("/api/x")).toBeUndefined();
  });

  test("LiveKit rooms of hosted organizations name their organization", () => {
    const orgId = newOrgId();
    const room = roomName("stream", roomSpace(orgId, "default"), "s1");
    expect(orgOfRoom(room)).toBe(orgId);
    expect(room).not.toBe(roomName("stream", roomSpace(newOrgId(), "default"), "s1"));
    expect(roomName("voice", roomSpace("owner", "default"), "c1")).toBe("sibyl.voice.default.c1");
    expect(orgOfRoom("sibyl.voice.default.c1")).toBeUndefined();
  });
});

describe("AI credits", () => {
  test("charges cost plus margin once per usage event, and blocks at an empty balance", async () => {
    const store = createMemoryStore();
    const credits = await new CreditsService({ store, orgId: "o1", active: true, margin: creditsMargin({ SIBYL_CREDITS_MARGIN: "0.2" }) }).load();
    const meter = new GatewayUsageMeter({ store, limits: {} });
    meter.addPolicy(credits.policy());
    const policy = credits.policy();
    expect(policy.check({ ownerId: "o1", estimateUsd: 0.01, now: Date.now() })).toMatchObject({ allowed: false, scope: "credits" });
    expect(await credits.add({ kind: "grant", amountUsd: 1, idempotencyKey: "g1" })).toBe(true);
    expect(await credits.add({ kind: "grant", amountUsd: 1, idempotencyKey: "g1" })).toBe(false);
    expect(policy.check({ ownerId: "o1", estimateUsd: 0.01, now: Date.now() })).toBeUndefined();
    meter.record({ ownerId: "o1", feature: "brain", model: "m", costUsd: 0.5, estimated: false });
    meter.record({ ownerId: "o2", feature: "brain", model: "m", costUsd: 5, estimated: false });
    await meter.flush();
    const view = await credits.view();
    expect(view.balanceUsd).toBeCloseTo(0.4);
    expect(await store.credits.balance("o1")).toBe(400_000);
    expect(view.entries.map((e) => e.kind)).toEqual(["charge", "grant"]);
    // The same usage event can't be charged twice (its idempotency key).
    const entry = credits.chargeFor(event("o1", 0.5, "e1"))!;
    expect(await store.credits.append(entry)).toBe(true);
    expect(await store.credits.append(entry)).toBe(false);
    meter.record({ ownerId: "o1", feature: "brain", model: "m", costUsd: 0.5, estimated: false });
    expect(policy.check({ ownerId: "o1", estimateUsd: 0, now: Date.now() })).toMatchObject({ allowed: false, scope: "credits" });
    // Other organizations' checks are not this ledger's business.
    expect(policy.check({ ownerId: "o2", estimateUsd: 0, now: Date.now() })).toBeUndefined();
  });

  test("a charge commits with its usage event: a restart right after a call neither loses nor double-counts it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sibyl-credits-"));
    const file = join(dir, "sibyl.db");
    try {
      const first = createSqliteStore({ file });
      const credits = await new CreditsService({ store: first, orgId: "o1", active: true, margin: 0 }).load();
      await credits.add({ kind: "grant", amountUsd: 2, idempotencyKey: "welcome" });
      const meter = new GatewayUsageMeter({ store: first, limits: {} });
      meter.addPolicy(credits.policy());
      meter.record({ ownerId: "o1", feature: "brain", model: "m", costUsd: 0.25, estimated: false });
      meter.record({ ownerId: "o1", feature: "brain", model: "m", costUsd: 0.5, estimated: false });
      // No flush, no waiting: the process "stops" right after the calls.
      expect(credits.balanceUsd()).toBeCloseTo(1.25);
      await first.close();

      const second = createSqliteStore({ file });
      const reloaded = await new CreditsService({ store: second, orgId: "o1", active: true, margin: 0 }).load();
      expect(reloaded.balanceUsd()).toBeCloseTo(1.25);
      const events = await second.usage.list("o1", 0, Date.now() + 1);
      const charges = (await second.credits.list("o1")).filter((e) => e.kind === "charge");
      expect(charges.map((c) => c.reference).sort()).toEqual(events.map((e) => e.id).sort());
      // A bad charge rolls back its event too (nothing half-written).
      await expect(second.usage.insert({ ...events[0]!, id: "again" }, { ...charges[0]!, idempotencyKey: "usage:again", amountMicros: 0.5 })).rejects.toThrow();
      expect(await second.usage.list("o1", 0, Date.now() + 1)).toHaveLength(2);
      expect(await second.credits.balance("o1")).toBe(1_250_000);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an organization with its own key is never charged; buying needs a payment provider", async () => {
    const store = createMemoryStore();
    const credits = await new CreditsService({ store, orgId: "o1", active: false, margin: 0 }).load();
    const policy = credits.policy();
    expect(policy.charge!(event("o1", 3))).toBeUndefined();
    policy.recorded!(event("o1", 3));
    expect((await credits.view()).balanceUsd).toBe(0);
    expect(credits.policy().check({ ownerId: "o1", estimateUsd: 1, now: Date.now() })).toBeUndefined();
    await expect(credits.purchase(5, "u1")).rejects.toMatchObject({ status: 501 });
    expect(() => creditsMargin({ SIBYL_CREDITS_MARGIN: "-1" })).toThrow();
  });
});

describe("model access", () => {
  test("a key is checked with OpenRouter's key endpoint; only its last four characters are kept", async () => {
    const seen: string[] = [];
    const fetch = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${url} ${init.headers.authorization}`);
      return { ok: true, status: 200, json: async () => ({ data: { label: "Team", limit: 10, usage: 2.5, limit_remaining: 7.5, is_free_tier: false } }) };
    };
    const info = await checkOpenRouterKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz1234", { fetch });
    expect(seen).toEqual(["https://openrouter.ai/api/v1/key Bearer sk-or-v1-abcdefghijklmnopqrstuvwxyz1234"]);
    expect(info).toMatchObject({ last4: "1234", label: "Team", limitUsd: 10, usageUsd: 2.5, remainingUsd: 7.5, freeTier: false });
    const rejected = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(checkOpenRouterKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz1234", { fetch: rejected })).rejects.toMatchObject({ code: "invalid_key" });
    await expect(checkOpenRouterKey("short", { fetch })).rejects.toMatchObject({ code: "invalid_key" });
  });

  test("the runtime's key: own key first, then the server's (self-hosted) or the platform's (hosted, credits)", () => {
    const env = { OPENROUTER_API_KEY: "server-key", STT_API_KEY: "server-stt" };
    expect(resolveModelAccess({ env, hosted: false })).toMatchObject({ mode: "server", apiKey: "server-key" });
    expect(resolveModelAccess({ env, hosted: true })).toMatchObject({ mode: "credits", apiKey: "server-key" });
    expect(resolveModelAccess({ env: {}, hosted: false }).apiKey).toBeUndefined();
    const own = resolveModelAccess({ env, hosted: true, ownKey: "own-key" });
    expect(own).toMatchObject({ mode: "byok", apiKey: "own-key" });
    expect(own.env.OPENROUTER_API_KEY).toBe("own-key");
    // Speech going to OpenRouter uses the own key too, never the server's.
    expect(own.env.STT_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBe("server-key");
  });
});

describe("sign-up tickets", () => {
  test("sealed, short-lived and single-use", async () => {
    let now = 1_000;
    const store = createMemoryStore();
    const tickets = new SignupTickets(randomBytes(32), store, () => now);
    const { ticket } = tickets.issue({ email: "Ann@Example.com", provider: "google", subject: "g-123" });
    expect(ticket).not.toContain("ann");
    expect(await tickets.verify(ticket)).toEqual({ email: "ann@example.com", provider: "google", subject: "g-123" });
    expect(await tickets.verify(`${ticket.slice(0, -2)}xx`)).toBeUndefined();
    expect(await new SignupTickets(randomBytes(32), store, () => now).verify(ticket)).toBeUndefined();
    await tickets.redeem(ticket);
    expect(await tickets.verify(ticket)).toBeUndefined();
    const second = tickets.issue({ email: "bo@example.com", provider: "magic_link" }).ticket;
    now += 2 * 60 * 60_000;
    expect(await tickets.verify(second)).toBeUndefined();
  });
});

describe("tenant registry", () => {
  const handle = (orgId: string, state: { busy?: boolean; closed: string[] }): TenantHandle => ({
    orgId,
    busy: () => Boolean(state.busy),
    close: async () => {
      state.closed.push(orgId);
    }
  });

  test("builds once on concurrent use; holds and running jobs keep a tenant loaded; idle ones unload", async () => {
    const state = { busy: false, closed: [] as string[] };
    let now = 0;
    let builds = 0;
    const registry = new TenantRegistry({ hosted: true, idleMs: 1_000, now: () => now, build: async (orgId) => (builds++, handle(orgId, state)) });
    const [x, y] = await Promise.all([registry.get("a"), registry.get("a")]);
    expect(x).toBe(y);
    expect(builds).toBe(1);
    const unloaded: string[] = [];
    registry.onUnload((orgId) => unloaded.push(orgId));
    const release = registry.hold("a");
    now = 5_000;
    expect(await registry.sweep()).toEqual([]);
    release();
    state.busy = true;
    now = 10_000;
    expect(await registry.sweep()).toEqual([]);
    state.busy = false;
    now = 20_000;
    expect(await registry.sweep()).toEqual(["a"]);
    expect(unloaded).toEqual(["a"]);
    expect(state.closed).toEqual(["a"]);
    await registry.get("a");
    expect(builds).toBe(2);
  });

  test("reloads are coalesced; the self-hosted tenant is rebuilt at once and never idles out", async () => {
    const state = { closed: [] as string[] };
    let builds = 0;
    const registry = new TenantRegistry({ hosted: false, idleMs: 1, build: async (orgId) => (builds++, handle(orgId, state)) });
    await registry.get("owner");
    await Promise.all([registry.reload("owner"), registry.reload("owner")]);
    expect(builds).toBe(2);
    expect(registry.peek("owner")).toBeDefined();
    expect(await registry.sweep(Date.now() + 60_000)).toEqual([]);
  });

  test("the scheduler loop wakes organizations with due work and ticks loaded ones", async () => {
    const ticks: string[] = [];
    const registry = new TenantRegistry({
      hosted: true,
      build: async (orgId) => ({ ...handle(orgId, { closed: [] }), tick: async () => void ticks.push(orgId) }),
      dueOrganizations: async () => ["due-org"]
    });
    await registry.tick();
    expect(registry.peek("due-org")).toBeDefined();
    expect(ticks).toEqual(["due-org"]);
    await registry.close();
  });
});
