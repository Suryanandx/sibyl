/**
 * Hosted Sibyl end to end: two organizations on one gateway (real runtimes
 * from createRuntime, one shared store and meter), created through
 * POST /api/orgs, each signed in with its own cookie. Every API either
 * organization can reach is tried with the other's ids: nothing is seen or
 * changed across organizations.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMProvider } from "@open-gpt-live/adapters";
import { DEFAULT_WORKSPACE_ID, randomAvatar, type MonitorRecord } from "@open-gpt-live/core";
import { AGENT_EVENTS, WS_EVENTS, IDENTITY_EVENTS, type ServerMessage } from "@open-gpt-live/protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayProviders, type GatewayServerHandle } from "../gateway.js";
import { createRuntime, openSharedRuntime, type GatewayRuntime } from "../runtime.js";
import { orgSecretKey } from "../secrets/crypto.js";
import { TestPaymentProvider } from "./credits.js";
import { createHostedRouting } from "./hosted.js";
import { OrganizationService } from "./organizations.js";
import { TenantRegistry, type TenantHandle } from "./registry.js";
import { MODEL_KEY_SECRET } from "./model-access.js";

const PLATFORM = "platform-token-for-tests";
const dataDir = mkdtempSync(join(tmpdir(), "sibyl-tenancy-"));
const env: NodeJS.ProcessEnv = {
  SIBYL_STORAGE: "memory",
  SIBYL_DATA_DIR: dataDir,
  SIBYL_SECRET_KEY: randomBytes(32).toString("base64"),
  SIBYL_COMPUTERS: "off",
  SIBYL_MODE: "hosted",
  OPENROUTER_API_KEY: "sk-or-v1-platform-key-for-tests-0000000000",
  SIBYL_PLATFORM_TOKEN: PLATFORM
};

interface Tenant extends TenantHandle {
  runtime: GatewayRuntime;
  providers: GatewayProviders;
}

/** Answers with the organization it serves and reports a provider cost, like OpenRouter's usage.cost. */
function providersFor(orgId: string): GatewayProviders {
  const llm: LLMProvider = {
    async *streamText(_messages, options) {
      yield { delta: `Hello from ${orgId}` };
      options?.onUsage?.({ costUsd: 0.25, promptTokens: 10, completionTokens: 5 });
    }
  };
  return { llm, stt: { async transcribe() { return { text: "" }; } } };
}

let gateway: GatewayServerHandle;
let registry: TenantRegistry<Tenant>;
let shared: Awaited<ReturnType<typeof openSharedRuntime>>;
let base = "";
const openrouterKeys = new Map<string, { limit: number | null; usage: number }>();
const realFetch = globalThis.fetch;

async function call(method: string, path: string, options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) } : {})
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

async function ticketFor(email: string) {
  return (await call("POST", "/api/platform/signup-tickets", { body: { email, name: "Owner", password: "correct horse battery" }, headers: { authorization: `Bearer ${PLATFORM}` } })).body.ticket as string;
}

async function createOrg(name: string, email: string) {
  const created = await call("POST", "/api/orgs", { body: { orgName: name, workspaceName: `${name} team` }, headers: { "x-sibyl-signup-ticket": await ticketFor(email) } });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ org: { name }, workspaceId: DEFAULT_WORKSPACE_ID });
  const me = await call("GET", "/api/auth/me", { cookie: created.cookie! });
  return { id: created.body.org.id as string, cookie: created.cookie!, body: me.body };
}

class Client {
  readonly messages: ServerMessage[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.messages.push(JSON.parse(raw.toString()) as ServerMessage));
  }
  static open(cookie: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/`, { headers: { cookie } });
      const client = new Client(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    });
  }
  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
  async waitFor<T extends ServerMessage>(match: (message: ServerMessage) => boolean, timeoutMs = 5_000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found as T;
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for a message");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  close(): void {
    this.socket.close();
  }
}

beforeAll(async () => {
  // OpenRouter's key endpoint, answered locally; everything else goes through.
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    if (href === "https://openrouter.ai/api/v1/key") {
      const key = String((init?.headers as Record<string, string>)?.authorization ?? "").replace(/^Bearer /, "");
      const known = openrouterKeys.get(key);
      if (!known) return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
      return new Response(JSON.stringify({ data: { label: "test key", limit: known.limit, usage: known.usage, limit_remaining: known.limit === null ? null : known.limit - known.usage, is_free_tier: false } }), { status: 200 });
    }
    return realFetch(url as string, init);
  });
  shared = await openSharedRuntime(env, () => undefined);
  registry = new TenantRegistry<Tenant>({
    hosted: true,
    idleMs: 60_000,
    build: async (orgId) => {
      const runtime = await createRuntime({ env, log: () => undefined, orgId, shared, hosted: true, payments: new TestPaymentProvider() });
      runtime.modelAccess?.onChange(() => void registry.reload(orgId));
      await runtime.routines?.startScheduler({ provider: { async *streamChat() {} } as never, model: () => "test", systemPrompt: "", scheduler: { selfTick: false } });
      return { orgId, runtime, providers: providersFor(orgId), busy: () => runtime.routines?.scheduler?.busy() ?? false, tick: () => runtime.routines?.scheduler?.tick() ?? Promise.resolve(), close: () => runtime.close() };
    },
    dueOrganizations: async (now) => (await shared.store.routines.due(now)).map((routine) => routine.ownerId)
  });
  const routing = createHostedRouting({
    store: shared.store,
    organizations: new OrganizationService({ store: shared.store, env }),
    loaded: () => registry.loaded(),
    platformToken: PLATFORM
  });
  gateway = await createGatewayServer({
    providers: providersFor("server"),
    host: "127.0.0.1",
    env,
    tenants: {
      hosted: true,
      acquire: (orgId) => registry.get(orgId),
      orgFor: routing.orgFor,
      hold: (orgId) => registry.hold(orgId),
      touch: (orgId) => registry.touch(orgId),
      onUnload: (listener) => registry.onUnload(listener),
      handleHosted: routing.handleHosted
    }
  });
  base = `http://127.0.0.1:${gateway.port}`;
}, 30_000);

afterAll(async () => {
  await gateway?.close();
  await registry?.close();
  await shared?.store.close();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("hosted tenancy", () => {
  let a: Awaited<ReturnType<typeof createOrg>>;
  let b: Awaited<ReturnType<typeof createOrg>>;

  test("organizations are created only with a verified email, each with its owner and named workspace", async () => {
    expect((await call("POST", "/api/orgs", { body: { orgName: "Nope" } })).status).toBe(403);
    expect((await call("POST", "/api/orgs", { body: { orgName: "Nope" }, headers: { "x-sibyl-signup-ticket": "forged.ticket" } })).status).toBe(403);
    // The ticket also works as the sibyl_signup cookie (and is cleared once used).
    const viaCookie = await call("POST", "/api/orgs", { body: { orgName: "Cookie Co" }, cookie: `sibyl_signup=${await ticketFor("cara@cookie.test")}` });
    expect(viaCookie.status).toBe(201);
    // The platform API needs its token.
    expect((await call("POST", "/api/platform/signup-tickets", { body: { email: "x@example.com" } })).status).toBe(401);

    a = await createOrg("Acme", "ann@acme.test");
    b = await createOrg("Beta", "ben@beta.test");
    expect(a.id).not.toBe(b.id);
    expect(a.body).toMatchObject({ authenticated: true, hosted: true, organization: { id: a.id, name: "Acme" }, workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: "Acme team", role: "owner" }] });
    const meB = await call("GET", "/api/auth/me", { cookie: b.cookie });
    expect(meB.body).toMatchObject({ authenticated: true, organization: { id: b.id, name: "Beta" }, user: { email: "ben@beta.test" } });
    // Signed out: no organization, no local mode, no first-run setup.
    expect((await call("GET", "/api/auth/me")).body).toMatchObject({ authenticated: false, mode: "signin", hosted: true });
    expect((await call("POST", "/api/auth/setup", { body: { email: "e@x.test", password: "correct horse battery" } })).status).toBe(404);
    expect((await call("GET", "/api/knowledge")).status).toBe(401);
    // Browsers' CORS preflights carry no cookie: answered without an organization.
    const preflight = await realFetch(`${base}/api/model-access`, { method: "OPTIONS", headers: { origin: base, "access-control-request-method": "GET", "access-control-request-headers": "x-sibyl-workspace" } });
    expect(preflight.status).toBe(204);
  });

  test("sign-in finds the organization from the email; a session belongs to one organization", async () => {
    const signedIn = await call("POST", "/api/auth/login", { body: { email: "ann@acme.test", password: "correct horse battery" } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.organization.id).toBe(a.id);
    expect((await call("POST", "/api/auth/login", { body: { email: "ann@acme.test", password: "wrong password!!" } })).status).toBe(401);
    // Naming another organization doesn't move a session: the cookie's organization answers.
    const me = await call("GET", "/api/auth/me", { cookie: a.cookie, headers: { "x-sibyl-org": b.id } });
    expect(me.body.organization.id).toBe(a.id);
    // The same person in two organizations chooses one.
    const ann = await call("POST", "/api/orgs", { cookie: a.cookie, body: { orgName: "Acme Labs" } });
    expect(ann.status).toBe(201);
    ann.body.organization = ann.body.org;
    const choose = await call("POST", "/api/auth/login", { body: { email: "ann@acme.test", password: "correct horse battery" } });
    expect(choose.status).toBe(409);
    expect(choose.body.organizations.map((o: { id: string }) => o.id).sort()).toEqual([a.id, ann.body.organization.id].sort());
    const chosen = await call("POST", "/api/auth/login", { body: { email: "ann@acme.test", password: "correct horse battery", org: ann.body.organization.id } });
    expect(chosen.body.organization.id).toBe(ann.body.organization.id);
    const mine = await call("GET", "/api/orgs", { cookie: a.cookie });
    expect(mine.body.organizations.map((o: { id: string; current: boolean }) => [o.id, o.current])).toEqual(expect.arrayContaining([[a.id, true], [ann.body.organization.id, false]]));
    expect((await call("GET", "/api/orgs", { cookie: b.cookie })).body.organizations).toHaveLength(1);
  });

  test("HTTP APIs: uploads, knowledge, workspaces, members, monitors and connectors stay in their organization", async () => {
    const upload = await realFetch(`${base}/api/uploads`, { method: "POST", headers: { cookie: a.cookie, "x-filename": "notes.txt", "content-type": "text/plain" }, body: "Acme secret plans" });
    expect(upload.status).toBe(201);
    const uploadId = ((await upload.json()) as { upload: { id: string } }).upload.id;
    expect((await realFetch(`${base}/api/uploads/${uploadId}`, { headers: { cookie: a.cookie } })).status).toBe(200);
    expect((await realFetch(`${base}/api/uploads/${uploadId}`, { headers: { cookie: b.cookie } })).status).toBe(404);

    const kb = await call("POST", "/api/knowledge", { cookie: a.cookie, body: { name: "Acme handbook" } });
    expect(kb.status).toBe(201);
    expect((await call("GET", `/api/knowledge/${kb.body.base.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await call("DELETE", `/api/knowledge/${kb.body.base.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await call("GET", "/api/knowledge", { cookie: b.cookie })).body.bases).toEqual([]);
    expect((await call("GET", `/api/knowledge/${kb.body.base.id}`, { cookie: a.cookie })).status).toBe(200);

    const ws = await call("POST", "/api/workspaces", { cookie: a.cookie, body: { name: "Acme sales" } });
    expect(ws.status).toBe(201);
    expect((await call("GET", "/api/workspaces", { cookie: b.cookie })).body.workspaces.map((w: { name: string }) => w.name)).toEqual(["Beta team"]);
    expect((await call("PATCH", `/api/workspaces/${ws.body.workspace.id}`, { cookie: b.cookie, body: { name: "Hijacked" } })).status).toBe(404);
    expect((await call("GET", `/api/workspaces/${DEFAULT_WORKSPACE_ID}/members`, { cookie: b.cookie })).body.members.map((m: { email: string }) => m.email)).toEqual(["ben@beta.test"]);

    // Invitations: B's invite link signs the new person into B only.
    const invite = await call("POST", "/api/invites", { cookie: b.cookie, body: { workspaceId: DEFAULT_WORKSPACE_ID, role: "member" } });
    const token = new URL(invite.body.url).pathname.split("/").pop()!;
    expect((await call("GET", `/api/invites/${token}`, { cookie: a.cookie })).body.workspaceName).toBe("Beta team");
    const joined = await call("POST", `/api/invites/${token}/accept`, { body: { name: "Bea", email: "bea@beta.test", password: "correct horse battery" } });
    expect(joined.body.organization.id).toBe(b.id);
    expect((await call("GET", `/api/workspaces/${DEFAULT_WORKSPACE_ID}/members`, { cookie: a.cookie })).body.members.map((m: { email: string }) => m.email)).toEqual(["ann@acme.test"]);

    // Monitors: B can't list A's, and A's webhook address under B's prefix is unknown there.
    const tenantA = await registry.get(a.id);
    const monitor = { id: "mon-acme", ownerId: a.id, workspaceId: DEFAULT_WORKSPACE_ID, name: "Acme hook", enabled: true, createdBy: "x", createdAt: 1, updatedAt: 1, source: { kind: "webhook", secretRef: "HOOK" }, condition: { kind: "always" }, action: { kind: "notify" } } as unknown as MonitorRecord;
    await tenantA.runtime.store.monitors.upsert(monitor);
    expect((await call("GET", "/api/monitors", { cookie: b.cookie })).body.monitors).toEqual([]);
    expect((await call("POST", `/o/${b.id}/api/monitors/hooks/mon-acme`, { body: { x: 1 } })).status).toBe(404);
    expect((await call("POST", `/o/o${"0".repeat(24)}/api/monitors/hooks/mon-acme`, { body: { x: 1 } })).status).toBe(401);

    // Connectors: an organization's OAuth app is its own.
    const app = await call("PUT", "/api/connectors/apps/google", { cookie: a.cookie, body: { clientId: "acme-client.apps.googleusercontent.com", clientSecret: "acme-client-secret" } });
    expect(app.status).toBeLessThan(300);
    const catalog = (cookie: string) => call("GET", "/api/connectors", { cookie }).then((r) => JSON.stringify(r.body));
    expect(await catalog(a.cookie)).toContain("acme-client.apps.googleusercontent.com");
    expect(await catalog(b.cookie)).not.toContain("acme-client");
    expect(await (await registry.get(b.id)).runtime.connectors!.appSecret("google", "clientSecret")).toBeUndefined();
  });

  test("secrets, model keys and credits are per organization", async () => {
    const tenantA = await registry.get(a.id);
    const tenantB = await registry.get(b.id);
    await tenantA.runtime.secrets!.vault.set(a.id, { name: "ACME_TOKEN", value: "acme-only-value-123", allowedHosts: ["api.acme.test"] });
    expect(await tenantB.runtime.secrets!.vault.has(b.id, "ACME_TOKEN")).toBe(false);
    // Each organization's values are encrypted with its own derived key.
    const master = Buffer.from(env.SIBYL_SECRET_KEY!, "base64");
    expect(orgSecretKey(master, a.id).equals(orgSecretKey(master, b.id))).toBe(false);
    expect(orgSecretKey(master, "owner").equals(master)).toBe(true);
    const stored = await shared.store.kv.get<{ ACME_TOKEN?: unknown } & Record<string, unknown>>(a.id, "secrets.v1");
    expect(JSON.stringify(stored)).not.toContain("acme-only-value-123");

    // BYOK: checked with OpenRouter first, then the organization runs on it (its runtime is rebuilt).
    const rejected = await call("PUT", "/api/model-access/key", { cookie: a.cookie, body: { key: "sk-or-v1-unknown-key-000000000000000" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_key");
    openrouterKeys.set("sk-or-v1-acme-own-key-0000000000000000", { limit: 20, usage: 4.5 });
    const saved = await call("PUT", "/api/model-access/key", { cookie: a.cookie, body: { key: "sk-or-v1-acme-own-key-0000000000000000" } });
    expect(saved.body).toMatchObject({ mode: "byok", key: { last4: "0000", limitUsd: 20, usageUsd: 4.5 } });
    expect(JSON.stringify(saved.body)).not.toContain("acme-own-key");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rebuilt = await registry.get(a.id);
    expect(rebuilt).not.toBe(tenantA);
    expect(rebuilt.runtime.modelEnv?.OPENROUTER_API_KEY).toBe("sk-or-v1-acme-own-key-0000000000000000");
    expect((await call("GET", "/api/model-access", { cookie: a.cookie })).body.mode).toBe("byok");
    expect((await call("GET", "/api/model-access", { cookie: b.cookie })).body).toMatchObject({ mode: "credits", credits: { balanceUsd: 0 }, serverKey: true });
    expect(await (await registry.get(b.id)).runtime.secrets!.vault.has(b.id, MODEL_KEY_SECRET)).toBe(false);

    // Credits: granted by the platform to B only.
    expect((await call("POST", `/api/platform/orgs/${b.id}/credits`, { body: { amountUsd: 1, idempotencyKey: "grant-1" }, headers: { authorization: `Bearer ${PLATFORM}` } })).body).toMatchObject({ added: true, balanceUsd: 1 });
    expect((await call("POST", `/api/platform/orgs/${b.id}/credits`, { body: { amountUsd: 1, idempotencyKey: "grant-1" }, headers: { authorization: `Bearer ${PLATFORM}` } })).body).toMatchObject({ added: false, balanceUsd: 1 });
    expect((await call("GET", "/api/credits", { cookie: b.cookie })).body).toMatchObject({ balanceUsd: 1, active: true });
    expect((await call("GET", "/api/credits", { cookie: a.cookie })).body).toMatchObject({ balanceUsd: 0, active: false });
    // The test payment provider adds what was bought.
    expect((await call("POST", "/api/credits/purchase", { cookie: b.cookie, body: { amountUsd: 2 } })).body).toMatchObject({ status: "completed", balanceUsd: 3 });
  });

  test("chat over WebSocket in both organizations at once: replies, usage and credits stay apart", async () => {
    const [clientA, clientB] = await Promise.all([Client.open(a.cookie), Client.open(b.cookie)]);
    try {
      const idA = await clientA.waitFor((m) => m.type === IDENTITY_EVENTS.SESSION_IDENTITY);
      expect(JSON.stringify(idA)).toContain("ann@acme.test");
      clientA.send({ type: WS_EVENTS.USER_TEXT, requestId: "ra", text: "hello", speak: false });
      clientB.send({ type: WS_EVENTS.USER_TEXT, requestId: "rb", text: "hello", speak: false });
      await Promise.all([
        clientA.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && (m as { requestId?: string }).requestId === "ra"),
        clientB.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && (m as { requestId?: string }).requestId === "rb")
      ]);
      const reply = (client: Client, requestId: string) =>
        client.messages
          .filter((m) => m.type === WS_EVENTS.LLM_DELTA && (m as { requestId?: string }).requestId === requestId)
          .map((m) => (m as { delta: string }).delta)
          .join("");
      expect(reply(clientA, "ra")).toBe(`Hello from ${a.id}`);
      expect(reply(clientB, "rb")).toBe(`Hello from ${b.id}`);
      await shared.meter.flush();
      const day = [Date.now() - 60_000, Date.now() + 60_000] as const;
      expect((await shared.store.usage.list(a.id, ...day)).every((e) => e.ownerId === a.id)).toBe(true);
      expect(await shared.store.usage.sum(a.id, ...day)).toBeCloseTo(0.25);
      expect(await shared.store.usage.sum(b.id, ...day)).toBeCloseTo(0.25);
      // B runs on credits: charged; A has its own key: not charged.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await call("GET", "/api/credits", { cookie: b.cookie })).body.balanceUsd).toBeCloseTo(2.75);
      expect((await call("GET", "/api/credits", { cookie: a.cookie })).body.balanceUsd).toBe(0);

      // Agents: B can't see or open A's.
      clientA.send({ type: AGENT_EVENTS.SAVE, agent: { name: "Acme Researcher", description: "x", avatar: randomAvatar("a"), instructions: "x", access: { mode: "inherit" }, autonomy: "ask_first", learning: "ask_first", visibility: "workspace" } });
      const saved = await clientA.waitFor<ServerMessage & { agent: { id: string } }>((m) => m.type === AGENT_EVENTS.SAVED);
      clientB.send({ type: AGENT_EVENTS.REQUEST });
      const listB = await clientB.waitFor<ServerMessage & { items: unknown[] }>((m) => m.type === AGENT_EVENTS.LIST);
      expect(listB.items).toEqual([]);
      clientB.send({ type: AGENT_EVENTS.GET, agentId: saved.agent.id });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(clientB.messages.some((m) => m.type === AGENT_EVENTS.DETAIL)).toBe(false);
      expect(JSON.stringify(clientB.messages)).not.toContain("Acme Researcher");

      // Notifications published in A reach A's browser, never B's.
      await (await registry.get(a.id)).runtime.notifications!.publish({ kind: "routine_finished", title: "Acme only", body: "for Acme", workspaceId: DEFAULT_WORKSPACE_ID });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(clientA.messages.some((m) => JSON.stringify(m).includes("Acme only"))).toBe(true);
      expect(clientB.messages.some((m) => JSON.stringify(m).includes("Acme only"))).toBe(false);
      expect((await shared.store.notifications.list(a.id)).some((n) => n.title === "Acme only")).toBe(true);
      expect((await shared.store.notifications.list(b.id)).some((n) => n.title === "Acme only")).toBe(false);

      // Conversations: B's list never holds A's chat.
      clientB.send({ type: WS_EVENTS.CONVERSATIONS_REQUEST });
      const convB = await clientB.waitFor<ServerMessage & { items: Array<{ id: string }> }>((m) => m.type === WS_EVENTS.CONVERSATIONS_LIST);
      const convA = (await shared.store.conversations.list(a.id)).map((c) => c.id);
      expect(convB.items.some((c) => convA.includes(c.id))).toBe(false);
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  test("empty credits block model calls with 'Add credits'", async () => {
    const c = await createOrg("Gamma", "gil@gamma.test");
    const client = await Client.open(c.cookie);
    try {
      client.send({ type: WS_EVENTS.USER_TEXT, requestId: "rc", text: "hello", speak: false });
      const blocked = await client.waitFor<ServerMessage & { scope: string; message: string }>((m) => m.type === WS_EVENTS.BUDGET_BLOCKED);
      expect(blocked.scope).toBe("credits");
      expect(blocked.message).toMatch(/Add credits/);
    } finally {
      client.close();
    }
  });

  test("scheduled jobs carry their organization: a due routine wakes and runs only in its own", async () => {
    await registry.sweep(Date.now() + 10 * 60_000);
    expect(registry.peek(b.id)).toBeUndefined();
    await shared.store.routines.upsert({ id: "r-beta", ownerId: b.id, name: "Beta digest", instruction: "x", cron: "0 9 * * *", timezone: "UTC", enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: Date.now() - 1000 });
    await registry.tick();
    // The due routine woke B (and only B); A's scheduler never sees B's routine.
    expect(registry.peek(b.id)).toBeDefined();
    expect(await (await registry.get(a.id)).runtime.store.routines.list(a.id)).toEqual([]);
  });

  test("idle organizations unload and come back on the next request", async () => {
    const before = await registry.get(a.id);
    const unloaded = await registry.sweep(Date.now() + 10 * 60_000);
    expect(unloaded).toContain(a.id);
    expect(registry.peek(a.id)).toBeUndefined();
    const me = await call("GET", "/api/auth/me", { cookie: a.cookie });
    expect(me.body.organization.id).toBe(a.id);
    expect(registry.peek(a.id)).toBeDefined();
    expect(registry.peek(a.id)).not.toBe(before);
    // Its key is still its own after the reload.
    expect(registry.peek(a.id)!.runtime.modelEnv?.OPENROUTER_API_KEY).toBe("sk-or-v1-acme-own-key-0000000000000000");
  });

  test("Admin → Users and Organization (budget, name) stay in their organization", async () => {
    const usersA = await call("GET", "/api/admin/users", { cookie: a.cookie });
    expect(usersA.status).toBe(200);
    const emails = JSON.stringify(usersA.body);
    expect(emails).toContain("ann@acme.test");
    expect(emails).not.toContain("ben@beta.test");
    expect(emails).not.toContain("bea@beta.test");
    // A can't change B's people (unknown in A).
    const beaId = ((await call("GET", "/api/admin/users", { cookie: b.cookie })).body.users as Array<{ id: string; email: string }>).find((u) => u.email === "bea@beta.test")!.id;
    expect((await call("PATCH", `/api/admin/users/${beaId}`, { cookie: a.cookie, body: { active: false } })).status).toBe(404);
    expect((await call("DELETE", `/api/admin/users/${beaId}`, { cookie: a.cookie })).status).toBe(404);
    // Organization budgets are per organization on the one shared meter.
    expect((await call("PATCH", "/api/admin/org", { cookie: a.cookie, body: { budget: { dailyUsd: 0.01 } } })).status).toBe(200);
    expect(shared.meter.limits(a.id).dailyUsd).toBe(0.01);
    expect(shared.meter.limits(b.id).dailyUsd).toBeUndefined();
    expect((await call("GET", "/api/admin/org", { cookie: b.cookie })).body.settings.budget).toEqual({});
    // Renaming in Admin renames the organization (sign-in choices, /api/auth/me).
    expect((await call("PATCH", "/api/admin/org", { cookie: b.cookie, body: { name: "Beta Corp" } })).status).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie: b.cookie })).body.organization.name).toBe("Beta Corp");
    expect((await shared.store.organizations.get(b.id))?.name).toBe("Beta Corp");
    expect((await call("GET", "/api/auth/me", { cookie: a.cookie })).body.organization.name).toBe("Acme");
  });

  test("meetings: a meeting id from one organization is unknown in another, and guest routes go by the link's organization", async () => {
    const created = await call("POST", "/api/meetings", { cookie: a.cookie, body: { title: "Acme sync" } });
    expect(created.status).toBe(201);
    const meeting = created.body.meeting ?? created.body;
    expect(meeting.guestPath).toContain(`&o=${a.id}`);
    expect((await call("GET", `/api/meetings/${meeting.id}`, { cookie: b.cookie })).status).toBe(404);
    expect(JSON.stringify((await call("GET", "/api/meetings", { cookie: b.cookie })).body)).not.toContain(meeting.id);
    const key = new URL(meeting.guestPath, base).searchParams.get("k");
    // The guest preview answers only in the meeting's own organization, even for someone signed in elsewhere.
    expect((await call("POST", `/api/meetings/${meeting.id}/preview`, { cookie: b.cookie, body: { key }, headers: { "x-sibyl-org": a.id } })).body.title).toBe("Acme sync");
    expect((await call("POST", `/api/meetings/${meeting.id}/preview`, { body: { key }, headers: { "x-sibyl-org": b.id } })).status).toBe(404);
  });

  test("vendor callbacks: Slack events under another organization's prefix are checked with that organization's secret", async () => {
    const response = await call("POST", `/o/${b.id}/api/presence/slack/events`, { body: { type: "event_callback", team_id: "T1" } });
    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/signing secret/);
  });
});
