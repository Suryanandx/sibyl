import { createFeatureGate, createMemoryStore, createToolRegistry, DEFAULT_WORKSPACE_ID, type EnterpriseModuleContext, type IdentityBridge, type IdentityExtension, type Store } from "../../../packages/core/src/index";
import { describe, expect, it } from "vitest";
import { identityContext } from "../directory/context";
import { EXTERNAL_PASSWORD_HASH } from "../directory/directory";
import { SsoStore, type SsoProviderRecord } from "./config";
import { ssoModule } from "./index";
import { SessionPolicyStore, ipAllowed, parseCidr } from "./session-policy";
import { resolveAccount, safeNext } from "./signin";

const ORG = "owner";

/** A module context with every hook as a no-op; tests override what they watch. */
function moduleContext(store: Store, overrides: Partial<EnterpriseModuleContext> = {}): EnterpriseModuleContext {
  return {
    gate: createFeatureGate(),
    ownerId: ORG,
    env: {},
    store,
    tools: createToolRegistry(),
    meter: { record() {}, totals: () => ({ todayUsd: 0, monthUsd: 0, sessionUsd: 0, byFeature: {} }), check: () => ({ allowed: true }), limits: () => ({}) },
    log: () => undefined,
    registerHttpRoute: () => undefined,
    registerPermissionPolicy: () => undefined,
    audit: () => undefined,
    registerAuditSink: () => undefined,
    registerToolPolicy: () => undefined,
    registerSecondApprover: () => undefined,
    registerIdentityExtension: () => undefined,
    registerUsagePolicy: () => undefined,
    ...overrides
  };
}

async function install(store: Store = createMemoryStore()) {
  const extensions: IdentityExtension[] = [];
  const changes: unknown[] = [];
  const ended: string[] = [];
  const handle = await ssoModule.install(moduleContext(store, { registerIdentityExtension: (extension) => void extensions.push(extension) }));
  const bridge = {
    orgId: ORG,
    allowedOrigins: [],
    changed: (change: unknown) => changes.push(change),
    endSessions: async (userId: string) => void ended.push(userId)
  } as unknown as IdentityBridge;
  for (const extension of extensions) extension.attach?.(bridge);
  if (handle && typeof handle === "object" && "close" in handle) handle.close?.();
  return { store, extension: extensions[0]!, context: identityContext({ store, ownerId: ORG, log: () => undefined, env: {} }), changes, ended };
}

const provider = (domains: string[], extra: Partial<SsoProviderRecord> = {}): SsoProviderRecord => ({
  id: "abcdef0123",
  kind: "oidc",
  label: "Okta",
  enabled: true,
  domains,
  oidc: { issuer: "https://idp.example.com", clientId: "x", scopes: ["openid"], groupsClaim: "groups" },
  createdAt: 0,
  updatedAt: 0,
  ...extra
});

async function user(store: Store, id: string, email: string, orgRole: "owner" | "member" = "member") {
  await store.identity.users.upsert({ id, orgId: ORG, email, name: id, passwordHash: "scrypt$x", createdAt: 0 });
  await store.identity.memberships.upsert(ORG, { userId: id, scope: "org", role: orgRole });
}

describe("CIDR allowlist", () => {
  it("parses v4/v6 ranges and matches mapped addresses", () => {
    expect(parseCidr("10.0.0.0/8")).toMatchObject({ prefix: 8, family: "ipv4" });
    expect(parseCidr("2001:db8::/32")).toMatchObject({ prefix: 32, family: "ipv6" });
    expect(parseCidr("203.0.113.9")).toMatchObject({ prefix: 32 });
    expect(parseCidr("10.0.0.0/33")).toBeUndefined();
    expect(parseCidr("example.com")).toBeUndefined();
    expect(ipAllowed([], "1.2.3.4")).toBe(true);
    expect(ipAllowed(["10.0.0.0/8"], "::ffff:10.1.2.3")).toBe(true);
    expect(ipAllowed(["10.0.0.0/8"], "11.0.0.1")).toBe(false);
    expect(ipAllowed(["2001:db8::/32"], "2001:db8::1")).toBe(true);
    expect(ipAllowed(["10.0.0.0/8"], undefined)).toBe(false);
  });
});

describe("session policy", () => {
  it("ends sessions past their lifetime or idle limit and refuses other networks", async () => {
    const policy = new SessionPolicyStore({ store: createMemoryStore(), orgId: ORG });
    await expect(policy.set({ ipAllowlist: ["10.0.0.0/8"] }, "192.0.2.1")).rejects.toMatchObject({ code: "would_lock_you_out" });
    await policy.set({ maxSessionHours: 8, idleTimeoutMinutes: 30, ipAllowlist: ["10.0.0.0/8"], requireMfa: true }, "10.0.0.5");
    const hour = 3_600_000;
    const now = 100 * hour;
    expect(await policy.checkSession({ createdAt: now - 9 * hour, lastSeenAt: now, now, ip: "10.0.0.5" })).toMatchObject({ allow: false, code: "session_expired", end: true });
    expect(await policy.checkSession({ createdAt: now - hour, lastSeenAt: now - 31 * 60_000, now, ip: "10.0.0.5" })).toMatchObject({ allow: false, code: "session_idle", end: true });
    expect(await policy.checkSession({ createdAt: now - hour, lastSeenAt: now, now, ip: "8.8.8.8" })).toMatchObject({ allow: false, code: "ip_not_allowed", end: false });
    expect(await policy.checkSession({ createdAt: now - hour, lastSeenAt: now, now, ip: "10.0.0.5" })).toEqual({ allow: true, touchEveryMs: 30 * 60_000 / 4 });
    expect(await policy.checkSignIn({ method: "password", ip: "10.0.0.5" })).toEqual({ allow: true, requireMfa: true });
    expect(await policy.checkSignIn({ method: "oidc", ip: "10.0.0.5" })).toEqual({ allow: true });
    expect(await policy.checkSignIn({ method: "saml", ip: "8.8.8.8" })).toMatchObject({ allow: false, code: "ip_not_allowed" });
  });
});

describe("enforced SSO", () => {
  it("refuses password sign-in for claimed domains, except the break-glass owner", async () => {
    const { store, extension } = await install();
    await user(store, "u-owner", "boss@acme.test", "owner");
    await user(store, "u-bob", "bob@acme.test");
    const sso = new SsoStore({ store, orgId: ORG });
    await sso.update((s) => {
      s.providers = [provider(["acme.test"])];
      s.enforce = true;
      s.breakGlassUserId = "u-owner";
    });
    const check = (userId: string, email: string, method: "password" | "oidc") => extension.checkSignIn!({ userId, email, method, ip: "127.0.0.1" });
    // A fresh SsoStore instance in the module: it reads the same kv.
    expect(await check("u-bob", "bob@acme.test", "password")).toMatchObject({ allow: false, code: "sso_required" });
    expect(await check("u-bob", "bob@acme.test", "oidc")).toMatchObject({ allow: true });
    expect(await check("u-owner", "boss@acme.test", "password")).toMatchObject({ allow: true });
    expect(await check("u-x", "x@elsewhere.test", "password")).toMatchObject({ allow: true });
    expect(await extension.signInProviders!()).toEqual([{ id: "abcdef0123", kind: "oidc", label: "Okta", startPath: "/api/sso/abcdef0123/start" }]);
  });
});

describe("SSO accounts", () => {
  it("links by subject, then verified email; creates accounts just in time; respects the domain claim", async () => {
    const { store, context } = await install();
    const byEmail = (email: string) => store.identity.users.getByEmail(ORG, email);
    await store.workspaces.upsert({ id: DEFAULT_WORKSPACE_ID, ownerId: ORG, name: "Personal", createdAt: 0, updatedAt: 0 });
    const okta = provider(["acme.test"]);
    await expect(resolveAccount(context.directory, byEmail, okta, { subject: "s1", email: "x@evil.test", groups: [] })).rejects.toMatchObject({ code: "sso_domain_not_allowed" });

    const created = await resolveAccount(context.directory, byEmail, okta, { subject: "s1", email: "New@Acme.test", name: "New Person", groups: [] });
    expect(created).toMatchObject({ email: "new@acme.test", name: "New Person", passwordHash: EXTERNAL_PASSWORD_HASH });
    expect(await store.identity.memberships.listForUser(ORG, created.id)).toEqual(
      expect.arrayContaining([{ userId: created.id, scope: "org", role: "member" }, { userId: created.id, scope: { workspaceId: DEFAULT_WORKSPACE_ID }, role: "member" }])
    );
    // Same subject, changed email at the IdP: still the same account.
    expect((await resolveAccount(context.directory, byEmail, okta, { subject: "s1", email: "renamed@acme.test", groups: [] })).id).toBe(created.id);

    await user(store, "u-old", "old@acme.test");
    await expect(resolveAccount(context.directory, byEmail, okta, { subject: "s2", email: "old@acme.test", emailVerified: false, groups: [] })).rejects.toMatchObject({ code: "sso_email_unverified" });
    expect((await resolveAccount(context.directory, byEmail, okta, { subject: "s2", email: "old@acme.test", groups: [] })).id).toBe("u-old");

    await context.directory.updateSettings({ jitProvisioning: false });
    await expect(resolveAccount(context.directory, byEmail, okta, { subject: "s3", email: "nobody@acme.test", groups: [] })).rejects.toMatchObject({ code: "sso_no_account" });

    await store.identity.users.upsert({ ...(await store.identity.users.get(ORG, "u-old"))!, disabledAt: 1 });
    await expect(resolveAccount(context.directory, byEmail, okta, { subject: "s2", email: "old@acme.test", groups: [] })).rejects.toMatchObject({ code: "account_disabled" });
  });

  it("maps groups to workspace roles, takes them back, and never lowers a hand-given role", async () => {
    const { store, context, changes } = await install();
    for (const id of [DEFAULT_WORKSPACE_ID, "ws_eng", "ws_sales"]) await store.workspaces.upsert({ id, ownerId: ORG, name: id, createdAt: 0, updatedAt: 0 });
    await user(store, "u1", "u1@acme.test");
    await context.directory.updateSettings({
      groupRoles: [
        { group: "Engineering", workspaceId: "ws_eng", role: "admin" },
        { group: "everyone", workspaceId: "ws_eng", role: "viewer" },
        { group: "sales", workspaceId: "ws_sales", role: "member" }
      ]
    });
    await expect(context.directory.updateSettings({ groupRoles: [{ group: "x", workspaceId: "ws_eng", role: "owner" }] })).rejects.toMatchObject({ code: "invalid_rules" });
    const roles = async () =>
      Object.fromEntries((await store.identity.memberships.listForUser(ORG, "u1")).filter((m) => m.scope !== "org").map((m) => [(m.scope as { workspaceId: string }).workspaceId, m.role]));

    await context.directory.setSsoGroups("u1", ["engineering", "everyone", "sales"]);
    expect(await roles()).toEqual({ ws_eng: "admin", ws_sales: "member" });
    expect(changes).toContainEqual({ kind: "memberships", userId: "u1" });
    // Engineering membership ends: the rule's role goes down to viewer.
    await context.directory.setSsoGroups("u1", ["everyone", "sales"]);
    expect(await roles()).toEqual({ ws_eng: "viewer", ws_sales: "member" });
    // An admin raises sales by hand; the rule never lowers it, and leaving the group doesn't remove it.
    await store.identity.memberships.upsert(ORG, { userId: "u1", scope: { workspaceId: "ws_sales" }, role: "admin" });
    await context.directory.setSsoGroups("u1", ["everyone"]);
    expect(await roles()).toEqual({ ws_eng: "viewer", ws_sales: "admin" });
    await context.directory.setSsoGroups("u1", []);
    expect(await roles()).toEqual({ ws_sales: "admin" });
  });

  it("keeps the last owner and only redirects to same-site paths", async () => {
    const { store, context, ended } = await install();
    await user(store, "boss", "boss@acme.test", "owner");
    await expect(context.directory.deactivate("boss")).rejects.toMatchObject({ code: "last_owner" });
    await user(store, "u2", "u2@acme.test");
    await context.directory.deactivate("u2");
    expect(ended).toEqual(["u2"]);
    expect(safeNext("/c/abc")).toBe("/c/abc");
    expect(safeNext("//evil.test")).toBe("/");
    expect(safeNext("https://evil.test")).toBe("/");
    expect(safeNext("/\\evil.test")).toBe("/");
  });
});

describe("audit", () => {
  it("records SSO sign-ins and SCIM changes in the audit log, without error text", async () => {
    const store = createMemoryStore();
    const audited: Array<{ action: string; outcome?: string; actor?: { userId?: string }; details?: Record<string, unknown> }> = [];
    await ssoModule.install(moduleContext(store, { audit: (event) => void audited.push(event) }));
    const context = identityContext({ store, ownerId: ORG, log: () => undefined, env: {} });
    context.log("sso.signed_in", { provider: "p1", kind: "oidc", userId: "u1" });
    context.log("sso.sign_in_failed", { code: "domain", error: "secret detail" });
    context.log("scim.user_deactivated", { userId: "u2" });
    context.log("sso.start", { provider: "p1" });
    expect(audited.map((entry) => entry.action)).toEqual(["auth.sign_in", "auth.sign_in_failed", "scim.user_deactivated"]);
    expect(audited[0]?.actor?.userId).toBe("u1");
    expect(audited[1]?.outcome).toBe("failure");
    expect(JSON.stringify(audited)).not.toContain("secret detail");
  });
});
