import type { LLMProvider } from "@open-gpt-live/adapters";
import { AUDIT_ACTIONS, DEFAULT_WORKSPACE_ID, createMemoryStore, type AuditEvent, type IdentityExtension, type Store } from "@open-gpt-live/core";
import { IDENTITY_EVENTS, type OrgUsersResponse, type OrgView, type ServerMessage } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayServerHandle } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import { GatewayUsageMeter } from "../metering/index.js";
import { OrgAdmin } from "./org.js";
import { IdentityService, type IdentityChange } from "./service.js";

const PASSWORD = "correct horse battery";

async function setupOrg(options: { extensions?: IdentityExtension[] } = {}) {
  const store: Store = createMemoryStore();
  const events: AuditEvent[] = [];
  const changes: IdentityChange[] = [];
  let n = 0;
  let clock = 1_000;
  const now = () => clock;
  const identity = new IdentityService({ store, orgId: "owner", createId: () => `id${++n}`, now, audit: (e) => events.push(e), extensions: () => options.extensions ?? [] });
  identity.onChange((change) => changes.push(change));
  const org = new OrgAdmin({ store, identity, now, audit: (e) => events.push(e), extensions: () => options.extensions ?? [] });
  const owner = await identity.setup({ email: "owner@example.com", name: "Olive", password: PASSWORD }, { ownerTokenOk: false });
  const ownerAuth = (await identity.resolveSession(owner.token))!;
  /** Invite someone into `workspaceId` and accept as a new account. */
  const join = async (email: string, role: "admin" | "member" | "viewer" = "member", workspaceId = DEFAULT_WORKSPACE_ID) => {
    const { url } = await identity.createInvite(ownerAuth.principal, { workspaceId, role, email }, "http://app");
    const joined = await identity.acceptInvite(url.split("/invite/")[1]!, { name: email.split("@")[0], email, password: PASSWORD }, undefined);
    return { user: joined.user, auth: (await identity.resolveSession(joined.token!))!, token: joined.token! };
  };
  return { store, identity, org, owner, ownerAuth, events, changes, join, tick: (ms: number) => (clock += ms) };
}

describe("OrgAdmin: organization settings", () => {
  it("saves the name and defaults, counts members per workspace and audits the change", async () => {
    const { org, identity, ownerAuth, events, changes, join } = await setupOrg();
    const sales = await identity.createWorkspace(ownerAuth.principal, { name: "Sales" });
    await join("max@example.com", "member", sales.id);
    const updated = await org.update(ownerAuth.principal, { name: "  Acme   Ltd ", defaultWorkspaceId: sales.id, defaultRole: "viewer" });
    expect(updated.settings).toMatchObject({ name: "Acme Ltd", defaultWorkspaceId: sales.id, defaultRole: "viewer" });
    // Owner reaches both workspaces (org owner); Max only Sales.
    expect(updated.workspaces.map((w) => [w.name, w.memberCount])).toEqual([
      ["Personal", 1],
      ["Sales", 2]
    ]);
    expect(updated.license).toEqual({ edition: "oss", status: "none", activeUsers: 2 });
    expect(events.filter((e) => e.action === AUDIT_ACTIONS.ORG_SETTINGS_CHANGED)).toHaveLength(1);
    expect(changes.some((c) => c.kind === "org")).toBe(true);
    // /api/auth/me carries the name and the invitation default.
    expect((await identity.me(ownerAuth)).org).toEqual({ name: "Acme Ltd", defaultRole: "viewer" });

    await expect(org.update(ownerAuth.principal, { defaultRole: "owner" })).rejects.toMatchObject({ code: "invalid_role" });
    await expect(org.update(ownerAuth.principal, { defaultWorkspaceId: "nope" })).rejects.toMatchObject({ code: "invalid_workspace" });
    const cleared = await org.update(ownerAuth.principal, { name: "", defaultWorkspaceId: null });
    expect(cleared.settings).toMatchObject({ name: "", defaultWorkspaceId: null });
  });

  it("only organization owners and admins may read or change it", async () => {
    const { org, join } = await setupOrg();
    const max = await join("max@example.com", "admin");
    // A workspace admin is still an organization member.
    await expect(org.view(max.auth.principal)).rejects.toMatchObject({ status: 403 });
    await expect(org.listUsers(max.auth.principal)).rejects.toMatchObject({ status: 403 });
  });

  it("new people also join the default workspace with the default role", async () => {
    const { org, identity, ownerAuth, store, join } = await setupOrg();
    const sales = await identity.createWorkspace(ownerAuth.principal, { name: "Sales" });
    await org.update(ownerAuth.principal, { defaultWorkspaceId: DEFAULT_WORKSPACE_ID, defaultRole: "viewer" });
    const max = await join("max@example.com", "admin", sales.id);
    const roles = (await store.identity.memberships.listForUser("owner", max.user.id)).map((m) => [m.scope === "org" ? "org" : m.scope.workspaceId, m.role]);
    expect(roles).toEqual([
      ["org", "member"],
      [sales.id, "admin"],
      [DEFAULT_WORKSPACE_ID, "viewer"]
    ]);
  });
});

describe("OrgAdmin: people", () => {
  it("lists everyone with org role, workspaces, sign-in method and last activity", async () => {
    const { org, ownerAuth, identity, join, tick } = await setupOrg();
    tick(5_000);
    const max = await join("max@example.com", "viewer");
    const users = await org.listUsers(ownerAuth.principal);
    expect(users.map((u) => [u.email, u.orgRole, u.status])).toEqual([
      ["owner@example.com", "owner", "active"],
      ["max@example.com", "member", "active"]
    ]);
    expect(users[0]).toMatchObject({ you: true, signIn: { password: true, twoStep: false }, lastActiveAt: 1_000 });
    expect(users[1]).toMatchObject({ workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: "Personal", role: "viewer" }], lastActiveAt: 6_000 });
    expect(users[1]!.signIn.sso).toBeUndefined();
    expect(max.user.id).toBe(users[1]!.id);
    // Pending invitations across workspaces.
    await identity.createInvite(ownerAuth.principal, { workspaceId: DEFAULT_WORKSPACE_ID, role: "member", email: "new@example.com" }, "http://app");
    expect((await identity.listAllInvites(ownerAuth.principal)).map((i) => [i.email, i.workspaceName])).toEqual([["new@example.com", "Personal"]]);
  });

  it("changes organization roles: no promotion above yourself, never without an owner", async () => {
    const { org, ownerAuth, owner, identity, events, join } = await setupOrg();
    const ada = await join("ada@example.com");
    const max = await join("max@example.com");
    // The last owner can't step down.
    await expect(org.updateUser(ownerAuth.principal, owner.user.id, { orgRole: "admin" })).rejects.toMatchObject({ code: "last_owner" });
    await org.updateUser(ownerAuth.principal, ada.user.id, { orgRole: "admin" });
    const adaAuth = (await identity.refresh(ada.auth))!;
    expect(adaAuth.principal.orgRole).toBe("admin");
    // Admins can't make owners or touch owners, but can manage members.
    await expect(org.updateUser(adaAuth.principal, max.user.id, { orgRole: "owner" })).rejects.toMatchObject({ status: 403 });
    await expect(org.updateUser(adaAuth.principal, owner.user.id, { orgRole: "member" })).rejects.toMatchObject({ status: 403 });
    await expect(org.updateUser(adaAuth.principal, owner.user.id, { active: false })).rejects.toMatchObject({ status: 403 });
    expect((await org.updateUser(adaAuth.principal, max.user.id, { orgRole: "viewer" })).orgRole).toBe("viewer");
    // With a second owner, the first may step down.
    await org.updateUser(ownerAuth.principal, ada.user.id, { orgRole: "owner" });
    expect((await org.updateUser(ownerAuth.principal, owner.user.id, { orgRole: "admin" })).orgRole).toBe("admin");
    expect(events.filter((e) => e.action === AUDIT_ACTIONS.ORG_ROLE_CHANGED).map((e) => e.details)).toEqual([
      { from: "member", to: "admin" },
      { from: "member", to: "viewer" },
      { from: "admin", to: "owner" },
      { from: "owner", to: "admin" }
    ]);
    await expect(org.updateUser(ownerAuth.principal, max.user.id, { orgRole: "boss" })).rejects.toMatchObject({ code: "invalid_role" });
  });

  it("turning an account off ends its sessions and blocks sign-in; turning it on lets them back", async () => {
    const { org, ownerAuth, owner, identity, events, join } = await setupOrg();
    const max = await join("max@example.com");
    await expect(org.updateUser(ownerAuth.principal, owner.user.id, { active: false })).rejects.toMatchObject({ code: "self" });
    const off = await org.updateUser(ownerAuth.principal, max.user.id, { active: false });
    expect(off.status).toBe("disabled");
    expect(await identity.resolveSession(max.token)).toBeUndefined();
    await expect(identity.login({ email: "max@example.com", password: PASSWORD }, "ip")).rejects.toMatchObject({ code: "invalid_credentials" });
    expect((await org.updateUser(ownerAuth.principal, max.user.id, { active: true })).status).toBe("active");
    expect("token" in (await identity.login({ email: "max@example.com", password: PASSWORD }, "ip2"))).toBe(true);
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining([AUDIT_ACTIONS.USER_DISABLED, AUDIT_ACTIONS.USER_ENABLED]));
  });

  it("removing someone drops every membership and hides them; a new invitation brings them back fresh", async () => {
    const { org, ownerAuth, owner, identity, store, events, join } = await setupOrg();
    const max = await join("max@example.com", "admin");
    await expect(org.removeUser(ownerAuth.principal, owner.user.id)).rejects.toMatchObject({ code: "self" });
    await org.removeUser(ownerAuth.principal, max.user.id);
    expect(await store.identity.memberships.listForUser("owner", max.user.id)).toEqual([]);
    expect((await org.listUsers(ownerAuth.principal)).map((u) => u.email)).toEqual(["owner@example.com"]);
    expect(await identity.resolveSession(max.token)).toBeUndefined();
    await expect(org.updateUser(ownerAuth.principal, max.user.id, { active: true })).rejects.toMatchObject({ status: 404 });
    expect(events.some((e) => e.action === AUDIT_ACTIONS.USER_REMOVED)).toBe(true);
    // Invited again: same account id, only the new access.
    const again = await join("max@example.com", "viewer");
    expect(again.user.id).toBe(max.user.id);
    const back = (await org.listUsers(ownerAuth.principal)).find((u) => u.id === max.user.id)!;
    expect(back).toMatchObject({ status: "active", orgRole: "member", workspaces: [{ id: DEFAULT_WORKSPACE_ID, role: "viewer" }] });
  });

  it("shows SSO and leaves SCIM-managed accounts read-only (Enterprise extensions)", async () => {
    const managed = new Set<string>();
    const extension: IdentityExtension = {
      id: "test-directory",
      async describeUsers(ids) {
        return Object.fromEntries(ids.filter((id) => managed.has(id)).map((id) => [id, { managedBy: "scim" as const, sso: { providers: ["Okta"] } }]));
      }
    };
    const { org, ownerAuth, join } = await setupOrg({ extensions: [extension] });
    const max = await join("max@example.com");
    managed.add(max.user.id);
    const view = (await org.listUsers(ownerAuth.principal)).find((u) => u.id === max.user.id)!;
    expect(view).toMatchObject({ managedBy: "scim", signIn: { sso: ["Okta"] } });
    await expect(org.updateUser(ownerAuth.principal, max.user.id, { active: false })).rejects.toMatchObject({ code: "managed_by_idp" });
    await expect(org.removeUser(ownerAuth.principal, max.user.id)).rejects.toMatchObject({ code: "managed_by_idp" });
    // The organization role is Sibyl's own and stays editable.
    expect((await org.updateUser(ownerAuth.principal, max.user.id, { orgRole: "admin" })).orgRole).toBe("admin");
  });

  it("resending an invitation replaces its link", async () => {
    const { identity, ownerAuth, events } = await setupOrg();
    const first = await identity.createInvite(ownerAuth.principal, { workspaceId: DEFAULT_WORKSPACE_ID, role: "member", email: "new@example.com" }, "http://app");
    const resent = await identity.resendInvite(ownerAuth.principal, first.invite.id, "http://app");
    expect(resent.url).not.toBe(first.url);
    await expect(identity.previewInvite(first.url.split("/invite/")[1]!)).rejects.toMatchObject({ code: "invite_not_found" });
    expect((await identity.previewInvite(resent.url.split("/invite/")[1]!)).status).toBe("pending");
    expect(events.find((e) => e.action === AUDIT_ACTIONS.INVITE_RESENT)?.details).toMatchObject({ replaces: first.invite.id });
  });
});

describe("OrgAdmin: organization budget", () => {
  it("is bounded by the env caps, reloads the meter and is audited", async () => {
    const store = createMemoryStore();
    const identity = new IdentityService({ store, orgId: "owner" });
    const events: AuditEvent[] = [];
    let reloads = 0;
    const org = new OrgAdmin({
      store,
      identity,
      audit: (e) => events.push(e),
      budgets: { limits: () => ({ dailyUsd: 10 }), spent: () => ({ todayUsd: 1, monthUsd: 2 }), changed: async () => void (reloads += 1) }
    });
    const owner = await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false });
    const principal = (await identity.resolveSession(owner.token))!.principal;
    await expect(org.update(principal, { budget: { dailyUsd: 11 } })).rejects.toMatchObject({ code: "budget_above_limit" });
    await expect(org.update(principal, { budget: { monthlyUsd: -1 } })).rejects.toMatchObject({ code: "invalid_budget" });
    const view = await org.update(principal, { budget: { dailyUsd: 4, monthlyUsd: 60 } });
    expect(view.settings).toMatchObject({ budget: { dailyUsd: 4, monthlyUsd: 60 }, budgetLimits: { dailyUsd: 10 }, spent: { todayUsd: 1, monthUsd: 2 } });
    expect(reloads).toBe(1);
    expect(events.at(-1)?.details).toMatchObject({ fields: ["budget"], dailyUsd: 4, monthlyUsd: 60 });
    // null clears one cap; the other stays.
    expect((await org.update(principal, { budget: { dailyUsd: null } })).settings.budget).toEqual({ monthlyUsd: 60 });
    expect(reloads).toBe(2);
  });
});

/* ───────────── HTTP and WebSocket ───────────── */

const servers: GatewayServerHandle[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startGateway() {
  const runtime = createTestRuntime({ store: createMemoryStore() });
  const llm: LLMProvider = {
    async *streamText() {
      yield { delta: "hi" };
    }
  };
  const server = await createGatewayServer({ providers: { llm, stt: { transcribe: async () => ({ text: "" }) } }, port: 0, host: "127.0.0.1", runtime });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}` };
}

async function call(base: string, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, body: (await response.json()) as any, cookie: setCookie ? setCookie.split(";")[0]! : undefined };
}

describe("Admin HTTP API", () => {
  it("serves organization settings and people behind org.settings, with the last-owner and role rules", async () => {
    const { base, ws } = await startGateway();
    const owner = (await call(base, "/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password: PASSWORD } })).cookie!;
    const invite = await call(base, "/api/invites", { method: "POST", cookie: owner, body: { workspaceId: "default", role: "admin" } });
    const token = String(invite.body.url).split("/invite/")[1]!;
    const admin = (await call(base, `/api/invites/${token}/accept`, { method: "POST", body: { name: "Ada", email: "ada@example.com", password: PASSWORD } })).cookie!;

    // A workspace admin isn't an organization admin.
    expect((await call(base, "/api/admin/users", { cookie: admin })).status).toBe(403);
    expect((await call(base, "/api/admin/org", { method: "PATCH", cookie: admin, body: { name: "X" } })).status).toBe(403);
    expect((await call(base, "/api/admin/users")).status).toBe(401);

    const org = await call(base, "/api/admin/org", { method: "PATCH", cookie: owner, body: { name: "Acme" } });
    expect(org.status).toBe(200);
    expect((org.body as OrgView).settings.name).toBe("Acme");
    expect((await call(base, "/api/auth/me", { cookie: admin })).body.org).toEqual({ name: "Acme", defaultRole: "member" });

    const people = (await call(base, "/api/admin/users", { cookie: owner })).body as OrgUsersResponse;
    const olive = people.users.find((u) => u.email === "o@example.com")!;
    const ada = people.users.find((u) => u.email === "ada@example.com")!;
    expect((await call(base, `/api/admin/users/${olive.id}`, { method: "PATCH", cookie: owner, body: { orgRole: "member" } })).body).toMatchObject({ error: "last_owner" });
    expect((await call(base, `/api/admin/users/${ada.id}`, { method: "PATCH", cookie: owner, body: { orgRole: "admin" } })).status).toBe(200);
    // Now an organization admin: may list people, but can't make owners.
    expect((await call(base, "/api/admin/users", { cookie: admin })).status).toBe(200);
    expect((await call(base, `/api/admin/users/${ada.id}`, { method: "PATCH", cookie: admin, body: { orgRole: "owner" } })).status).toBe(403);
    expect((await call(base, `/api/admin/users/${olive.id}`, { method: "DELETE", cookie: admin })).status).toBe(403);

    // Turning Ada off closes her open connection at once.
    const socket = new WebSocket(ws, { headers: { cookie: admin } });
    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    await waitUntil(() => messages.some((m) => m.type === IDENTITY_EVENTS.SESSION_IDENTITY));
    expect((await call(base, `/api/admin/users/${ada.id}`, { method: "PATCH", cookie: owner, body: { active: false } })).body.user.status).toBe("disabled");
    expect(await closed).toBe(4401);
    expect((await call(base, "/api/auth/me", { cookie: admin })).body.authenticated).toBe(false);
  });

  it("pushes organization changes to open sessions", async () => {
    const { base, ws } = await startGateway();
    const owner = (await call(base, "/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password: PASSWORD } })).cookie!;
    const socket = new WebSocket(ws, { headers: { cookie: owner } });
    const identities: ServerMessage[] = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === IDENTITY_EVENTS.SESSION_IDENTITY) identities.push(message);
    });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    await waitUntil(() => identities.length === 1);
    await call(base, "/api/admin/org", { method: "PATCH", cookie: owner, body: { name: "Acme" } });
    await waitUntil(() => identities.length === 2);
    socket.close();
  });
});

describe("Workspace budgets over HTTP and WebSocket", () => {
  it("a workspace admin sets the budget; it blocks chat in that workspace only", async () => {
    const store = createMemoryStore();
    const meter = new GatewayUsageMeter({ store });
    const runtime = createTestRuntime({ store, meter });
    const llm: LLMProvider = {
      async *streamText() {
        yield { delta: "hi" };
      }
    };
    const server = await createGatewayServer({ providers: { llm, stt: { transcribe: async () => ({ text: "" }) } }, port: 0, host: "127.0.0.1", runtime });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const owner = (await call(base, "/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password: PASSWORD } })).cookie!;
    const sales = (await call(base, "/api/workspaces", { method: "POST", cookie: owner, body: { name: "Sales" } })).body.workspace;
    const invite = await call(base, "/api/invites", { method: "POST", cookie: owner, body: { workspaceId: sales.id, role: "member" } });
    const token = String(invite.body.url).split("/invite/")[1]!;
    const member = (await call(base, `/api/invites/${token}/accept`, { method: "POST", body: { name: "Max", email: "m@example.com", password: PASSWORD } })).cookie!;

    // Members can't set budgets (budgets.manage).
    expect((await call(base, `/api/workspaces/${sales.id}`, { method: "PATCH", cookie: member, body: { budget: { dailyUsd: 5 } } })).status).toBe(403);
    const set = await call(base, `/api/workspaces/${sales.id}`, { method: "PATCH", cookie: owner, body: { budget: { dailyUsd: 0 } } });
    expect(set.status).toBe(200);
    expect(set.body.workspace.budget).toEqual({ dailyUsd: 0 });

    const chat = async (workspaceId: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: { cookie: owner } });
      const messages: ServerMessage[] = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
      await new Promise<void>((resolve) => socket.once("open", () => resolve()));
      socket.send(JSON.stringify({ type: IDENTITY_EVENTS.SESSION_WORKSPACE, workspaceId }));
      await waitUntil(() => messages.some((m) => m.type === IDENTITY_EVENTS.SESSION_IDENTITY && (m as { workspaceId: string }).workspaceId === workspaceId));
      socket.send(JSON.stringify({ type: "user.text", requestId: "r1", text: "hello" }));
      await waitUntil(() => messages.some((m) => m.type === "budget.blocked" || m.type === "llm.done"));
      socket.close();
      return messages.find((m) => m.type === "budget.blocked" || m.type === "llm.done")!;
    };
    expect(await chat(sales.id)).toMatchObject({ type: "budget.blocked", scope: "daily", message: expect.stringMatching(/workspace's budget/) });
    expect((await chat("default")).type).toBe("llm.done");
  });
});

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
