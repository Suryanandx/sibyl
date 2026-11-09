/**
 * Custom roles, grants and policies tests — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  authorize,
  clearPolicies,
  createGovernance,
  createMemoryStore,
  registerPolicy,
  type AuditEntryInput,
  type EnterpriseNotice,
  type Principal,
  type Store
} from "../../../packages/core/src/index";
import { PolicyBook, SecondApprovalDesk, purgeExpired, retentionJobType } from "./policies";
import { RoleBook } from "./roles";

afterEach(() => clearPolicies());

const owner = { kind: "user" as const, userId: "boss" };
const member = (userId = "u1", extra: Partial<Principal> = {}): Principal => ({ kind: "user", orgId: "org", userId, orgRole: "member", workspaceRoles: { default: "member", ws2: "member" }, ...extra });

async function people(store: Store) {
  for (const [id, role] of [["boss", "owner"], ["u1", "member"], ["u2", "member"]] as const) {
    await store.identity.users.upsert({ id, orgId: "org", email: `${id}@x.io`, name: id, passwordHash: "x", createdAt: 1 });
    await store.identity.memberships.upsert("org", { userId: id, scope: "org", role });
  }
  await store.workspaces.upsert({ id: "default", ownerId: "org", name: "Personal", createdAt: 1, updatedAt: 1 });
  await store.workspaces.upsert({ id: "ws2", ownerId: "org", name: "Two", createdAt: 1, updatedAt: 1 });
}

describe("custom roles", () => {
  it("a workspace role replaces the built-in permissions there; an org role elsewhere; owners are never limited", async () => {
    const store = createMemoryStore();
    await people(store);
    const audit: unknown[] = [];
    const book = await new RoleBook({ store, orgId: "org", audit: (e) => void audit.push(e) }).load();
    registerPolicy(book.policy);
    const analyst = await book.saveRole(owner, undefined, { name: "Analyst", permissions: ["chat.use", "knowledge.view", "audit.view"] });
    const writer = await book.saveRole(owner, undefined, { name: "Writer", permissions: ["chat.use", "tools.write"] });
    await expect(book.saveRole(owner, undefined, { name: "admin", permissions: [] })).rejects.toThrow(/built-in/);
    await expect(book.saveRole(owner, undefined, { name: "X", permissions: ["chat.fly"] })).rejects.toThrow(/Unknown permission/);
    await expect(book.assign(owner, { userId: "boss", scope: "org", roleId: analyst.id })).rejects.toThrow(/owners/);

    // Before: a member can write and use secrets.
    expect(authorize(member(), PERMISSIONS.TOOLS_WRITE)).toBe(true);
    await book.assign(owner, { userId: "u1", scope: "org", roleId: analyst.id });
    await book.assign(owner, { userId: "u1", scope: "ws2", roleId: writer.id });
    // Default workspace: the org-level Analyst role.
    expect(authorize(member(), PERMISSIONS.TOOLS_WRITE)).toBe(false);
    expect(authorize(member(), PERMISSIONS.SECRETS_USE)).toBe(false);
    expect(authorize(member(), PERMISSIONS.KNOWLEDGE_VIEW)).toBe(true);
    expect(authorize(member(), PERMISSIONS.AUDIT_VIEW)).toBe(true); // org permission from an org assignment
    // ws2: the workspace assignment wins.
    expect(authorize(member(), PERMISSIONS.TOOLS_WRITE, { workspaceId: "ws2" })).toBe(true);
    expect(authorize(member(), PERMISSIONS.KNOWLEDGE_VIEW, { workspaceId: "ws2" })).toBe(false);
    // Others and owners are untouched.
    expect(authorize(member("u2"), PERMISSIONS.TOOLS_WRITE)).toBe(true);
    expect(authorize({ kind: "user", orgId: "org", userId: "boss", orgRole: "owner", workspaceRoles: {} }, PERMISSIONS.SECRETS_MANAGE)).toBe(true);

    // Clearing and deleting give the built-in role back.
    await book.assign(owner, { userId: "u1", scope: "org", roleId: null });
    expect(authorize(member(), PERMISSIONS.TOOLS_WRITE)).toBe(true);
    await book.deleteRole(owner, writer.id);
    expect(book.snapshot().assignments).toEqual([]);
    expect(authorize(member(), PERMISSIONS.KNOWLEDGE_VIEW, { workspaceId: "ws2" })).toBe(true);
    expect(audit.map((e) => (e as AuditEntryInput).action)).toEqual(["role.changed", "role.changed", "role.assigned", "role.assigned", "role.assigned", "role.changed"]);

    // Persisted: a fresh book reads the same data.
    expect((await new RoleBook({ store, orgId: "org", audit: () => {} }).load()).snapshot().roles.map((r) => r.name)).toEqual(["Analyst"]);
  });

  it("a grant limits a shared connection to the roles and people it names", async () => {
    const store = createMemoryStore();
    await people(store);
    const book = await new RoleBook({ store, orgId: "org", audit: () => {} }).load();
    registerPolicy(book.policy);
    const sales = await book.saveRole(owner, undefined, { name: "Sales", permissions: ["chat.use", "integrations.use", "tools.write"] });
    const resource = { kind: "connection", id: "conn1" };
    expect(authorize(member(), PERMISSIONS.INTEGRATIONS_USE, { resource })).toBe(true);
    await book.setGrant(owner, { resource: { kind: "connection", id: "conn1", name: "Salesforce" }, roles: [sales.id, "admin"], userIds: ["u2"] });
    expect(authorize(member(), PERMISSIONS.INTEGRATIONS_USE, { resource })).toBe(false);
    expect(authorize(member("u2"), PERMISSIONS.INTEGRATIONS_USE, { resource })).toBe(true);
    expect(authorize(member("u3", { orgRole: "admin" }), PERMISSIONS.INTEGRATIONS_USE, { resource })).toBe(true);
    await book.assign(owner, { userId: "u1", scope: "default", roleId: sales.id });
    expect(authorize(member(), PERMISSIONS.INTEGRATIONS_USE, { resource })).toBe(true);
    // Other resources are not affected; removing every role and person removes the grant.
    expect(authorize(member("u2"), PERMISSIONS.INTEGRATIONS_USE, { resource: { kind: "connection", id: "other" } })).toBe(true);
    await book.setGrant(owner, { resource: { kind: "connection", id: "conn1" }, roles: [], userIds: [] });
    expect(book.snapshot().grants).toEqual([]);
    await expect(book.setGrant(owner, { resource: { kind: "tool", id: "x" }, roles: ["member"] })).rejects.toThrow(/connections/);
  });
});

describe("policies", () => {
  it("blocks tools (by name or provider), marks writes for a second approval, and enforces the model allowlist", async () => {
    const store = createMemoryStore();
    const audit: AuditEntryInput[] = [];
    const governance = createGovernance({ orgId: "org" });
    governance.registerAuditSink((e) => void audit.push(e));
    const book = await new PolicyBook({ store, orgId: "org", audit: (e) => governance.audit(e) }).load();
    governance.registerToolPolicy(book.hook);
    const send = { name: "google_gmail_send", effect: "write" as const, source: "connector", provider: "google" };
    const del = { name: "delete_file", effect: "write" as const, source: "builtin" };
    expect(governance.toolDecision(send)).toEqual({ allowed: true });

    await book.save(owner, { blockedTools: ["provider:google", "web_search"], secondApproval: { mode: "high_risk" }, modelAllowlist: ["brain/ok"] });
    expect(governance.toolDecision(send).allowed).toBe(false);
    expect(governance.toolDecision({ name: "web_search", effect: "read", source: "builtin" }).allowed).toBe(false);
    expect(governance.toolDecision(del)).toEqual({ allowed: true, secondApproval: true });
    expect(governance.toolDecision({ name: "create_note", effect: "write", source: "builtin" })).toEqual({ allowed: true });
    expect(governance.modelDecision("brain/ok").allowed).toBe(true);
    expect(governance.modelDecision("brain/other")).toMatchObject({ allowed: false });

    await book.save(owner, { secondApproval: { mode: "listed", tools: ["create_note"] } });
    expect(governance.toolDecision({ name: "create_note", effect: "write", source: "builtin" }).secondApproval).toBe(true);
    expect(governance.toolDecision(del).secondApproval).toBeUndefined();
    await expect(book.save(owner, { retention: { chatsDays: 0.5 } })).rejects.toThrow(/whole number/);
    await expect(book.save(owner, { secondApproval: { mode: "sometimes" } })).rejects.toThrow();
    expect(audit.map((e) => e.action)).toEqual(["policy.changed", "policy.changed"]);
    expect(audit[0]!.details).toMatchObject({ changed: ["blockedTools", "secondApproval", "modelAllowlist"] });
    expect((await new PolicyBook({ store, orgId: "org", audit: () => {} }).load()).policies.secondApproval).toEqual({ mode: "listed", tools: ["create_note"] });
  });

  it("second approvals wait for an admin other than the requester, notify admins, and expire", async () => {
    const store = createMemoryStore();
    await people(store);
    const audit: AuditEntryInput[] = [];
    const notices: EnterpriseNotice[] = [];
    const governance = createGovernance({ orgId: "org" });
    governance.registerAuditSink((e) => void audit.push(e));
    const desk = new SecondApprovalDesk({ store, orgId: "org", audit: (e) => governance.audit(e), notify: (n) => void notices.push(n), log: () => {}, ttlMs: 50 });
    const tool = { name: "send_invoice", title: "Send invoice", effect: "write" as const, source: "builtin", description: "", inputSchema: {}, run: async () => ({ content: "" }) };
    const request = (signal = new AbortController().signal) => desk.approver({ tool, input: { to: "a@b.c", amount: 10 }, principal: member(), workspaceId: "default", runId: "r1", signal });

    const waiting = request();
    await new Promise((r) => setTimeout(r, 5));
    const [item] = desk.list();
    expect(item).toMatchObject({ requestedBy: { userId: "u1" }, workspaceId: "default", approval: { toolName: "send_invoice", title: "Send invoice" } });
    expect(notices.map((n) => n.recipientUserId)).toEqual(["boss"]);
    expect(() => desk.decide({ kind: "user", userId: "u1" }, item!.approval.id, "approve")).toThrow(/someone other/);
    expect(desk.decide(owner, item!.approval.id, "approve")).toBe("approved");
    expect(await waiting).toBe("approved");
    expect(() => desk.decide(owner, item!.approval.id, "approve")).toThrow(/no longer waiting/);

    expect(await request()).toBe("expired"); // nobody answered within the TTL
    const stopped = new AbortController();
    const pending = request(stopped.signal);
    stopped.abort();
    expect(await pending).toBe("expired");
    expect(audit.map((e) => `${e.action}:${(e.details as { decision?: string }).decision ?? ""}`)).toEqual([
      "approval.second_requested:",
      "approval.second_decided:approved",
      "approval.second_requested:",
      "approval.second_decided:expired",
      "approval.second_requested:",
      "approval.second_decided:expired"
    ]);
  });

  it("retention deletes old chats and notifications on the scheduler and is audited", async () => {
    const store = createMemoryStore();
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    for (const [id, updatedAt] of [["old", now - 40 * day], ["new", now - day]] as const) {
      await store.conversations.upsert({ id, ownerId: "org", title: id, createdAt: updatedAt, updatedAt, messages: [] });
    }
    await store.notifications.insert({ id: "n1", ownerId: "org", workspaceId: "default", kind: "deck_ready", title: "x", body: "", links: {}, createdAt: now - 10 * day });
    const audit: AuditEntryInput[] = [];
    const result = await purgeExpired({ store, orgId: "org", env: {}, retention: { chatsDays: 30, notificationsDays: 7 }, now, audit: (e) => void audit.push(e as AuditEntryInput), log: () => {} });
    expect(result).toEqual({ chats: 1, uploads: 0, notifications: 1 });
    expect((await store.conversations.list("org")).map((c) => c.id)).toEqual(["new"]);
    expect(audit[0]).toMatchObject({ action: "retention.purged", actor: { kind: "system" }, details: { chats: 1, notifications: 1 } });

    const book = await new PolicyBook({ store, orgId: "org", audit: () => {} }).load();
    let runs = 0;
    const job = retentionJobType({ book, run: async () => void (runs += 1) });
    expect(await job.due(now)).toEqual([]); // no retention rule
    await book.save(owner, { retention: { uploadsDays: 90 } });
    const [due] = await job.due(now);
    expect(await job.claim(due!, now, now + 1000)).toEqual(due);
    await job.run(due!, new AbortController().signal);
    await job.release(due!);
    expect(runs).toBe(1);
    expect(await job.due(now + 1000)).toEqual([]); // next run in an hour
    expect((await job.due(now + 60 * 60 * 1000)).length).toBe(1);
  });
});
