/**
 * Sibyl Enterprise — tests for advanced usage controls (budgets per person and
 * role, request and model caps, rate limits, alerts, chargeback reports) and
 * the meter hook they plug into. Licensed under the Sibyl Enterprise License.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createEnterpriseRegistry, createFeatureGate, type EnterpriseSecrets } from "../../../packages/core/src/features";
import { createMemoryStore, type Store } from "../../../packages/core/src/store";
import { createToolRegistry } from "../../../packages/core/src/tools";
import { createOpenGovernance } from "../../../packages/core/src/governance";
import type { Principal } from "../../../packages/core/src/permissions";
import type { EmailMessage } from "../../../packages/core/src/email";
import { GatewayUsageMeter } from "../../../apps/gateway/src/metering/meter";
import { bindCaller } from "../../../apps/gateway/src/http/index";
import { SecretVault } from "../../../apps/gateway/src/secrets/vault";
import registerEnterprise from "../index";
import { parseControls, type UsageControls } from "./controls";
import { WEBHOOK_SECRET_NAME } from "./alerts";
import { buildChargeback, chargebackCsv } from "./report";
import { createUsageControlsRoute, parseRange } from "./http";
import { UsageControlsService } from "./service";

const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function controls(patch: Record<string, unknown>): UsageControls {
  const parsed = parseControls(patch);
  if (!parsed.success) throw new Error(parsed.error);
  return parsed.data;
}

function vaultSecrets(store: Store): EnterpriseSecrets {
  const vault = new SecretVault({ store, key: randomBytes(32) });
  return {
    set: async (input) => void (await vault.set("owner", input)),
    resolve: (name, host) => vault.resolve("owner", name, { host }),
    has: (name) => vault.has("owner", name),
    delete: async (name) => void (await vault.delete("owner", name))
  };
}

async function setup(options: { orgDailyUsd?: number; env?: NodeJS.ProcessEnv; withPolicy?: boolean } = {}) {
  const store = createMemoryStore();
  let now = NOW;
  const mail: EmailMessage[] = [];
  const secrets = vaultSecrets(store);
  const meter = new GatewayUsageMeter({ store, limits: options.orgDailyUsd === undefined ? {} : { dailyUsd: options.orgDailyUsd }, now: () => now });
  const service = await new UsageControlsService({
    store,
    ownerId: "owner",
    env: options.env ?? {},
    mailer: { send: async (message) => void mail.push(message) },
    secrets,
    log() {},
    now: () => now
  }).init();
  if (options.withPolicy !== false) meter.addPolicy(service.policy);
  return { store, meter, service, mail, secrets, advance: (ms: number) => (now += ms), now: () => now };
}

describe("settings", () => {
  it("accepts a full set and drops empty rows", () => {
    const parsed = parseControls({
      users: { "u-1": { dailyUsd: 1, monthlyUsd: "20" }, "u-2": {} },
      roles: { member: { dailyUsd: 0.5 } },
      perRequestUsd: 0.2,
      allowedModels: ["openai/gpt-4o-mini", "openai/gpt-4o-mini"],
      requestsPerMinute: 10,
      alerts: { thresholds: [100, 50], emails: ["Ops@Example.com"], notifyUser: false, webhookUrl: "https://hooks.example.com/sibyl" }
    });
    expect(parsed).toEqual({
      success: true,
      data: {
        users: { "u-1": { dailyUsd: 1, monthlyUsd: 20 } },
        roles: { member: { dailyUsd: 0.5 } },
        perRequestUsd: 0.2,
        allowedModels: ["openai/gpt-4o-mini"],
        requestsPerMinute: 10,
        alerts: { thresholds: [50, 100], emails: ["ops@example.com"], notifyUser: false, webhookUrl: "https://hooks.example.com/sibyl" }
      }
    });
  });

  it("refuses bad values with a readable reason", () => {
    expect(parseControls({ users: { "u 1": { dailyUsd: 1 } } })).toMatchObject({ success: false });
    expect(parseControls({ roles: { member: { dailyUsd: -1 } } })).toMatchObject({ success: false, error: expect.stringContaining("between 0") });
    expect(parseControls({ requestsPerMinute: 0 })).toMatchObject({ success: false });
    expect(parseControls({ alerts: { thresholds: [150] } })).toMatchObject({ success: false });
    expect(parseControls({ alerts: { emails: ["not-an-email"] } })).toMatchObject({ success: false });
    expect(parseControls({ alerts: { webhookUrl: "ftp://x.example.com" } })).toMatchObject({ success: false });
    expect(parseControls({ alerts: { webhookUrl: "https://a:b@x.example.com" } })).toMatchObject({ success: false });
  });
});

describe("the meter with the usage policy", () => {
  it("attributes session spend to the person and workspace, and blocks them at their own daily cap", async () => {
    const { meter, service, store } = await setup();
    await service.update(controls({ users: { "u-ana": { dailyUsd: 0.01 } } }));
    meter.attributeSession("s-ana", () => ({ userId: "u-ana", workspaceId: "w-sales", role: "member" }));
    meter.attributeSession("s-bo", () => ({ userId: "u-bo", workspaceId: "w-sales", role: "member" }));
    meter.bindRequest("r1", "s-ana");

    expect(meter.check({ ownerId: "owner", estimateUsd: 0.002, sessionId: "s-ana", feature: "brain" })).toEqual({ allowed: true });
    meter.record({ ownerId: "owner", feature: "brain", model: "m", costUsd: 0.009, estimated: false, requestId: "r1" });
    await meter.flush();
    const [event] = await store.usage.list("owner", 0, NOW + 1);
    expect(event).toMatchObject({ userId: "u-ana", workspaceId: "w-sales", costUsd: 0.009 });

    const blocked = meter.check({ ownerId: "owner", estimateUsd: 0.002, sessionId: "s-ana", feature: "brain" });
    expect(blocked).toMatchObject({ allowed: false, scope: "policy", message: expect.stringContaining("daily budget") });
    // Someone else is unaffected, and so is spend without a person.
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.002, sessionId: "s-bo", feature: "brain" })).toEqual({ allowed: true });
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.002 })).toEqual({ allowed: true });
  });

  it("applies role caps to everyone with the role, with a person's own cap winning", async () => {
    const { meter, service } = await setup();
    await service.update(controls({ roles: { member: { dailyUsd: 0.005 } }, users: { "u-vip": { dailyUsd: 1 } } }));
    for (const userId of ["u-1", "u-vip"]) {
      meter.record({ ownerId: "owner", feature: "brain", model: "m", costUsd: 0.006, estimated: false, userId, workspaceId: "default" });
    }
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.001, userId: "u-1", role: "member" })).toMatchObject({ allowed: false, scope: "policy" });
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.001, userId: "u-1", role: "admin" })).toEqual({ allowed: true });
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.001, userId: "u-vip", role: "member" })).toEqual({ allowed: true });
  });

  it("keeps the organisation caps first and unchanged, and asks for economy at 85% of a person's cap", async () => {
    const withPolicy = await setup({ orgDailyUsd: 1 });
    const without = await setup({ orgDailyUsd: 1, withPolicy: false });
    for (const { meter } of [withPolicy, without]) {
      meter.record({ ownerId: "owner", feature: "voice", model: "m", costUsd: 0.9, estimated: false, userId: "u-1" });
    }
    // Org cap: identical decisions with and without the policy (economy at 85%, block over the cap).
    for (const estimateUsd of [0.01, 0.2]) {
      expect(withPolicy.meter.check({ ownerId: "owner", estimateUsd, userId: "u-1" })).toEqual(without.meter.check({ ownerId: "owner", estimateUsd, userId: "u-1" }));
    }
    expect(withPolicy.meter.check({ ownerId: "owner", estimateUsd: 0.2, userId: "u-1" })).toMatchObject({ allowed: false, scope: "daily" });

    const { meter, service } = await setup();
    await service.update(controls({ users: { "u-2": { monthlyUsd: 1 } } }));
    meter.record({ ownerId: "owner", feature: "voice", model: "m", costUsd: 0.8, estimated: false, userId: "u-2" });
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.06, userId: "u-2" })).toEqual({ allowed: true, downgrade: true });
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.01, userId: "u-3" })).toEqual({ allowed: true });
  });

  it("enforces the per-request cap and the allowed models", async () => {
    const { meter, service } = await setup();
    await service.update(controls({ perRequestUsd: 0.05, allowedModels: ["cheap/model"] }));
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.06, userId: "u-1", model: "cheap/model" })).toMatchObject({ allowed: false, message: expect.stringContaining("per request") });
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.01, userId: "u-1", model: "pricey/model" })).toMatchObject({ allowed: false, message: expect.stringContaining("pricey/model") });
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.01, userId: "u-1", model: "cheap/model" })).toEqual({ allowed: true });
  });

  it("limits chat and voice requests per person per minute (not routines)", async () => {
    const { meter, service, advance } = await setup();
    await service.update(controls({ requestsPerMinute: 2 }));
    const ask = (userId: string, feature: "brain" | "routine" = "brain") => meter.check({ ownerId: "owner", estimateUsd: 0.001, userId, feature }).allowed;
    expect([ask("u-1"), ask("u-1"), ask("u-1")]).toEqual([true, true, false]);
    expect(ask("u-2")).toBe(true);
    expect(ask("u-1", "routine")).toBe(true);
    advance(61_000);
    expect(ask("u-1")).toBe(true);
  });

  it("rebuilds each person's month from the stored events on start", async () => {
    const { store, meter } = await setup();
    meter.record({ ownerId: "owner", feature: "brain", model: "m", costUsd: 0.4, estimated: false, userId: "u-1", workspaceId: "default" });
    await meter.flush();
    const restarted = await new UsageControlsService({ store, ownerId: "owner", env: {}, log() {}, now: () => NOW }).init();
    expect(restarted.ledger.totals("u-1", NOW)).toEqual({ todayUsd: 0.4, monthUsd: 0.4 });
  });
});

describe("alerts", () => {
  async function receiver(): Promise<{ url: string; hits: Array<{ headers: IncomingMessage["headers"]; body: string }>; server: Server }> {
    const hits: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        hits.push({ headers: request.headers, body });
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => server.close());
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`, hits, server };
  }

  it("emails and posts a signed webhook once per threshold and period", async () => {
    const hook = await receiver();
    const { meter, service, mail, store } = await setup({ env: { SIBYL_USAGE_WEBHOOK_PRIVATE: "true" } });
    await store.identity.users.upsert({ id: "u-ana", orgId: "owner", email: "ana@example.com", name: "Ana", passwordHash: "x", createdAt: 1 });
    const { webhookKey } = await service.update(
      controls({ users: { "u-ana": { dailyUsd: 0.1 } }, alerts: { thresholds: [50, 100], emails: ["ops@example.com"], webhookUrl: hook.url } })
    );
    expect(webhookKey).toMatch(/^[0-9a-f]{64}$/);

    const spend = (costUsd: number) => meter.record({ ownerId: "owner", feature: "brain", model: "m", costUsd, estimated: false, userId: "u-ana", workspaceId: "default" });
    spend(0.04); // 40%: nothing
    spend(0.02); // 60%: the 50% alert
    spend(0.01); // 70%: nothing new
    await service.alerts.flush();
    expect(mail.map((m) => m.to).sort()).toEqual(["ana@example.com", "ops@example.com"]);
    expect(mail[0]!.email.subject).toBe("Sibyl usage: Ana used 50% of their daily budget");
    expect(hook.hits).toHaveLength(1);
    const [hit] = hook.hits;
    const expected = `sha256=${createHmac("sha256", webhookKey!).update(`${hit!.headers["x-sibyl-timestamp"]}.${hit!.body}`).digest("hex")}`;
    expect(hit!.headers["x-sibyl-signature"]).toBe(expected);
    expect(JSON.parse(hit!.body)).toMatchObject({ type: "usage.alert", user: { id: "u-ana", email: "ana@example.com" }, period: "daily", thresholdPercent: 50, capUsd: 0.1, blocked: false });

    // Blocked at the cap: the 100% alert, once.
    spend(0.03);
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.01, userId: "u-ana" }).allowed).toBe(false);
    expect(meter.check({ ownerId: "owner", estimateUsd: 0.01, userId: "u-ana" }).allowed).toBe(false);
    await service.alerts.flush();
    expect(hook.hits).toHaveLength(2);
    expect(JSON.parse(hook.hits[1]!.body)).toMatchObject({ thresholdPercent: 100 });
    expect(mail).toHaveLength(4);
  });

  it("refuses an internal webhook unless the operator allows it, and keys it to the webhook's host", async () => {
    const hook = await receiver();
    const { service, secrets } = await setup();
    await service.update(controls({ alerts: { webhookUrl: hook.url } }));
    const delivery = await service.testAlert("u-1", "default");
    expect(delivery.webhook).toMatchObject({ ok: false, error: expect.stringContaining("private") });
    expect(hook.hits).toHaveLength(0);
    await expect(secrets.resolve(WEBHOOK_SECRET_NAME, "evil.example.com")).rejects.toThrow();
  });
});

describe("chargeback", () => {
  const events = [
    { id: "1", at: NOW - 1000, ownerId: "owner", feature: "brain" as const, model: "m", costUsd: 0.25, estimated: false, userId: "u-1", workspaceId: "w-a" },
    { id: "2", at: NOW - 900, ownerId: "owner", feature: "voice" as const, model: "m", costUsd: 0.5, estimated: false, userId: "u-1", workspaceId: "w-a" },
    { id: "3", at: NOW - 800, ownerId: "owner", feature: "routine" as const, model: "m", costUsd: 1, estimated: false, userId: "u-2", workspaceId: "w-a" },
    { id: "4", at: NOW - 700, ownerId: "owner", feature: "brain" as const, model: "m", costUsd: 2, estimated: false, userId: "u-2", workspaceId: "w-b" },
    { id: "5", at: NOW - 600, ownerId: "owner", feature: "tts" as const, model: "m", costUsd: 0.125, estimated: true }
  ];
  const names = { workspace: (id: string) => ({ "w-a": "Sales", "w-b": "=Ops" })[id] ?? id, user: (id: string) => ({ name: id === "u-1" ? "Ana, Jr." : "Bo", email: `${id}@example.com` }) };

  it("sums per workspace and person, scoped to what the caller may see", () => {
    const all = buildChargeback(events, { from: 0, to: NOW }, names, { all: true });
    expect(all.totalUsd).toBe(3.875);
    expect(all.calls).toBe(5);
    expect(all.workspaces).toEqual([
      { workspaceId: "w-b", workspaceName: "=Ops", calls: 1, costUsd: 2 },
      { workspaceId: "w-a", workspaceName: "Sales", calls: 3, costUsd: 1.75 },
      { workspaceId: "unattributed", workspaceName: "Unattributed", calls: 1, costUsd: 0.125 }
    ]);
    const own = buildChargeback(events, { from: 0, to: NOW }, names, { all: false, userId: "u-1", workspaces: (id) => (id === "w-a" ? "own" : "none") });
    expect(own.rows.map((r) => [r.workspaceId, r.userId, r.costUsd])).toEqual([["w-a", "u-1", 0.75]]);
    const manager = buildChargeback(events, { from: 0, to: NOW }, names, { all: false, userId: "u-9", workspaces: (id) => (id === "w-a" ? "all" : "none") });
    expect(manager.totalUsd).toBe(1.75);
  });

  it("exports CSV with exact numbers, quoting and no spreadsheet formulas", () => {
    const csv = chargebackCsv(buildChargeback(events, { from: 0, to: NOW }, names, { all: true }));
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("workspace_id,workspace,user_id,user,email,calls,cost_usd,voice_usd,brain_usd,routine_usd,other_usd");
    expect(lines).toContain(`w-a,Sales,u-1,"Ana, Jr.",u-1@example.com,2,0.750000,0.500000,0.250000,0.000000,0.000000`);
    expect(lines).toContain(`w-b,'=Ops,u-2,Bo,u-2@example.com,1,2.000000,0.000000,2.000000,0.000000,0.000000`);
    expect(lines).toContain(`unattributed,Unattributed,unattributed,Unattributed,,1,0.125000,0.000000,0.000000,0.000000,0.125000`);
  });

  it("parses report ranges as whole local days", () => {
    expect(parseRange("2026-11-01", "2026-11-09", NOW)).toEqual({ from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 10).getTime() });
    expect(parseRange(undefined, undefined, NOW)).toEqual({ from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 10).getTime() });
    expect(parseRange("2026-02-30", undefined, NOW)).toBe("Dates must look like 2026-11-30.");
    expect(parseRange("2026-11-09", "2026-11-01", NOW)).toBe("The end date is before the start date.");
  });
});

describe("HTTP and licensing", () => {
  const owner: Principal = { kind: "user", orgId: "owner", userId: "u-owner", orgRole: "owner", workspaceRoles: {} };
  const admin: Principal = { kind: "user", orgId: "owner", userId: "u-admin", orgRole: "member", workspaceRoles: { "w-a": "admin" } };
  const member: Principal = { kind: "user", orgId: "owner", userId: "u-1", orgRole: "member", workspaceRoles: { "w-a": "member" } };

  async function serve(service: UsageControlsService) {
    const route = createUsageControlsRoute({ service, allowedOrigins: [], log() {}, now: () => NOW });
    let caller: Principal = owner;
    const server = createServer((request, response) => {
      bindCaller(request, { principal: caller });
      if (!route(request, response)) {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return {
      as: (principal: Principal) => (caller = principal),
      call: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init)
    };
  }

  it("lets only organisation admins read and change the settings; reports are scoped", async () => {
    const { service, meter } = await setup();
    meter.record({ ownerId: "owner", feature: "brain", model: "m", costUsd: 0.3, estimated: false, userId: "u-1", workspaceId: "w-a", at: NOW - 1000 });
    meter.record({ ownerId: "owner", feature: "brain", model: "m", costUsd: 0.7, estimated: false, userId: "u-2", workspaceId: "w-a", at: NOW - 900 });
    await meter.flush();
    const http = await serve(service);

    const put = await http.call("/api/usage-controls", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ controls: { users: { "u-1": { dailyUsd: 2 } } } }) });
    expect(put.status).toBe(200);
    expect((await put.json()).controls.users).toEqual({ "u-1": { dailyUsd: 2 } });

    http.as(member);
    expect((await http.call("/api/usage-controls")).status).toBe(403);
    expect((await http.call("/api/usage-controls", { method: "PUT", body: "{}" })).status).toBe(403);
    const mine = await (await http.call("/api/usage-controls/report?from=2026-11-01&to=2026-11-09")).json();
    expect(mine.rows.map((r: { userId: string }) => r.userId)).toEqual(["u-1"]);

    http.as(admin);
    const theirs = await (await http.call("/api/usage-controls/report?from=2026-11-01&to=2026-11-09")).json();
    expect(theirs.totalUsd).toBe(1);

    http.as(owner);
    const csv = await http.call("/api/usage-controls/report.csv?from=2026-11-01&to=2026-11-09");
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toContain("sibyl-usage-2026-11-01-to-2026-11-09.csv");
    expect((await csv.text()).split("\r\n").filter(Boolean)).toHaveLength(3);
    expect((await http.call("/api/usage-controls/report?from=bad")).status).toBe(400);
  });

  it("installs only with the usage_advanced feature and registers one usage policy and one route", async () => {
    const registry = createEnterpriseRegistry();
    registerEnterprise(registry);
    const base = { ownerId: "owner", env: {}, store: createMemoryStore(), tools: createToolRegistry(), meter: new GatewayUsageMeter({ store: createMemoryStore() }), governance: createOpenGovernance(), log() {} };
    const gate = (features: Array<"usage_advanced" | "audit_log">) =>
      createFeatureGate({ valid: true, payload: { licensee: "Acme", edition: "enterprise", seats: 5, features, issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" } });
    const off = await registry.install({ ...base, gate: gate(["audit_log"]) });
    expect(off.usagePolicies).toHaveLength(0);
    expect(off.skipped.map((s) => s.id)).toContain("usage-controls");
    const on = await registry.install({ ...base, gate: gate(["usage_advanced"]) });
    expect(on.installed).toContain("usage-controls");
    expect(on.usagePolicies).toHaveLength(1);
    expect(on.httpRoutes).toHaveLength(1);
    await on.close();
  });
});
