/**
 * Organization admin (Admin → Organization and Admin → Users), on top of
 * the identity service and the same store records:
 *
 * - organization settings: name (workspace switcher, invitation emails),
 *   the workspace every new account joins, the default role for
 *   invitations (store.kv, ORG_SETTINGS_KV_KEY);
 * - workspaces with member counts (create/rename/delete stay the
 *   /api/workspaces routes of the identity service);
 * - everyone in the organization: organization role, workspaces, last
 *   activity, how they sign in, turned on/off, removed.
 *
 * Every call needs org.settings (organization owners and admins). Rules:
 * nobody changes someone above them or grants a role above their own (so
 * admins can't make owners); the organization always keeps an active
 * owner; you can't turn yourself off or remove yourself. Accounts the
 * identity provider manages (SCIM, Sibyl Enterprise) can't be turned off,
 * on or removed here. Every change is audited and pushed to open sessions
 * (identity onChange → `session.identity`).
 */
import {
  AUDIT_ACTIONS,
  DEFAULT_WORKSPACE_ID,
  ORG_SETTINGS_KV_KEY,
  PERMISSIONS,
  auditActor,
  authorize,
  isRole,
  readOrgSettings,
  roleRank,
  type AuditEvent,
  type ExternalUserFacts,
  type IdentityExtension,
  type MembershipRecord,
  type OrgSettings,
  type Principal,
  type Role,
  type SpendCaps,
  type Store,
  type UserRecord
} from "@open-gpt-live/core";
import { applyBudgetPatch } from "./budget-input.js";
import type { OrgLicenseSummary, OrgSettingsView, OrgUserView, OrgView, OrgWorkspaceView } from "@open-gpt-live/protocol";
import { IdentityError, type IdentityService } from "./service.js";

/** The licence as Admin → Organization summarises it. */
export type LicenseInfo = Omit<OrgLicenseSummary, "activeUsers">;

export interface OrgAdminOptions {
  store: Store;
  identity: IdentityService;
  /** Identity extensions (SSO, SCIM) that describe accounts; none in the open-source edition. */
  extensions?: () => readonly IdentityExtension[];
  /** Licence summary (edition, seats); absent: open source with no key. */
  license?: () => LicenseInfo;
  audit?: (event: AuditEvent) => void;
  /** The usage meter's side of the organization budget (absent: budgets can't be set here). */
  budgets?: {
    /** SIBYL_BUDGET_* caps: the upper bound. */
    limits(): SpendCaps;
    /** Spent today and this month. */
    spent(): { todayUsd: number; monthUsd: number };
    /** Reload the in-app budgets into the meter (after a change). */
    changed(): Promise<void>;
  };
  now?: () => number;
}

const forbidden = (message = "You don't have permission to do that.") => new IdentityError(403, "forbidden", message);

export class OrgAdmin {
  private readonly store: Store;
  private readonly identity: IdentityService;
  private readonly orgId: string;
  private readonly now: () => number;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OrgAdminOptions) {
    this.store = options.store;
    this.identity = options.identity;
    this.orgId = options.identity.orgId;
    this.now = options.now ?? Date.now;
  }

  private require(principal: Principal): void {
    if (!authorize(principal, PERMISSIONS.ORG_SETTINGS)) throw forbidden("Only organization owners and admins can do that.");
  }

  private audit(event: AuditEvent): void {
    this.options.audit?.(event);
  }

  /* ───────────── organization ───────────── */

  async view(principal: Principal): Promise<OrgView> {
    this.require(principal);
    const [settings, users, memberships] = await Promise.all([
      readOrgSettings(this.store, this.orgId),
      this.store.identity.users.list(this.orgId),
      this.store.identity.memberships.list(this.orgId)
    ]);
    await this.identity.ensureDefaultWorkspace();
    const active = new Set(users.filter((u) => u.disabledAt === undefined).map((u) => u.id));
    const orgWide = new Set(memberships.filter((m) => m.scope === "org" && (m.role === "owner" || m.role === "admin") && active.has(m.userId)).map((m) => m.userId));
    const workspaces: OrgWorkspaceView[] = (await this.store.workspaces.list(this.orgId))
      .sort((a, b) => (a.id === DEFAULT_WORKSPACE_ID ? -1 : b.id === DEFAULT_WORKSPACE_ID ? 1 : a.createdAt - b.createdAt))
      .map((workspace) => {
        const people = new Set(orgWide);
        for (const m of memberships) if (m.scope !== "org" && m.scope.workspaceId === workspace.id && active.has(m.userId)) people.add(m.userId);
        return {
          id: workspace.id,
          name: workspace.name,
          ...(workspace.icon ? { icon: workspace.icon } : {}),
          isDefault: workspace.id === DEFAULT_WORKSPACE_ID,
          memberCount: people.size,
          createdAt: workspace.createdAt
        };
      });
    const license = this.options.license?.() ?? { edition: "oss" as const, status: "none" as const };
    const budgets = this.options.budgets;
    return {
      settings: {
        ...settingsView(settings),
        budgetLimits: budgets?.limits() ?? {},
        spent: budgets?.spent() ?? { todayUsd: 0, monthUsd: 0 }
      },
      workspaces,
      license: { ...license, activeUsers: active.size }
    };
  }

  async update(principal: Principal, input: Record<string, unknown>): Promise<OrgView> {
    this.require(principal);
    const changed: string[] = [];
    const run = this.writes.catch(() => undefined).then(async () => {
      const current = await readOrgSettings(this.store, this.orgId);
      const next: OrgSettings = { ...current };
      if (input.name !== undefined) {
        if (typeof input.name !== "string") throw new IdentityError(400, "invalid_name", "The name must be text.");
        const name = input.name.replace(/\s+/g, " ").trim().slice(0, 80);
        if (name) next.name = name;
        else delete next.name;
      }
      if (input.defaultWorkspaceId !== undefined) {
        if (input.defaultWorkspaceId === null || input.defaultWorkspaceId === "") delete next.defaultWorkspaceId;
        else if (typeof input.defaultWorkspaceId !== "string" || !(await this.store.workspaces.get(this.orgId, input.defaultWorkspaceId))) {
          throw new IdentityError(400, "invalid_workspace", "Choose an existing workspace.");
        } else next.defaultWorkspaceId = input.defaultWorkspaceId;
      }
      if (input.defaultRole !== undefined) {
        if (!isRole(input.defaultRole) || input.defaultRole === "owner") throw new IdentityError(400, "invalid_role", "Choose admin, member or viewer.");
        next.defaultRole = input.defaultRole;
      }
      if (input.budget !== undefined) {
        if (!this.options.budgets) throw new IdentityError(400, "budgets_unavailable", "Budgets can't be set on this server.");
        const budget = applyBudgetPatch(current.budget, input.budget, this.options.budgets.limits());
        if (budget) next.budget = budget;
        else delete next.budget;
      }
      for (const key of ["name", "defaultWorkspaceId", "defaultRole"] as const) if (next[key] !== current[key]) changed.push(key);
      if (JSON.stringify(next.budget ?? {}) !== JSON.stringify(current.budget ?? {})) changed.push("budget");
      if (changed.length === 0) return;
      next.updatedAt = this.now();
      await this.store.kv.set(this.orgId, ORG_SETTINGS_KV_KEY, next);
      // Hosted Sibyl: the organization record (sign-in choices, the organization list) carries the same name.
      const record = changed.includes("name") && next.name ? await this.store.organizations.get(this.orgId) : undefined;
      if (record && next.name) await this.store.organizations.update({ ...record, name: next.name });
    });
    this.writes = run;
    await run;
    if (changed.includes("budget")) await this.options.budgets?.changed();
    if (changed.length > 0) {
      const budget = changed.includes("budget") ? (await readOrgSettings(this.store, this.orgId)).budget : undefined;
      this.audit({
        action: AUDIT_ACTIONS.ORG_SETTINGS_CHANGED,
        actor: auditActor(principal),
        target: { kind: "organization", id: this.orgId },
        details: { fields: changed, ...(changed.includes("budget") ? { dailyUsd: budget?.dailyUsd ?? null, monthlyUsd: budget?.monthlyUsd ?? null } : {}) }
      });
      // The name shows in everyone's workspace switcher.
      this.identity.notifyChange({ kind: "org" });
    }
    return this.view(principal);
  }

  /* ───────────── people ───────────── */

  async listUsers(principal: Principal): Promise<OrgUserView[]> {
    this.require(principal);
    const users = (await this.store.identity.users.list(this.orgId)).filter((u) => u.removedAt === undefined);
    const [memberships, workspaces, twoStep, facts] = await Promise.all([
      this.store.identity.memberships.list(this.orgId),
      this.store.workspaces.list(this.orgId),
      this.identity.mfa.enabledUserIds(),
      this.describe(users.map((u) => u.id))
    ]);
    const names = new Map(workspaces.map((w) => [w.id, w.name] as const));
    const byUser = new Map<string, MembershipRecord[]>();
    for (const m of memberships) byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), m]);
    return users
      .map((user) => toView(user, byUser.get(user.id) ?? [], names, twoStep.has(user.id), facts[user.id], principal.userId))
      .sort((a, b) => Number(a.status === "disabled") - Number(b.status === "disabled") || roleRank(b.orgRole) - roleRank(a.orgRole) || a.name.localeCompare(b.name));
  }

  /** Change someone's organization role and/or turn their account off or on. */
  async updateUser(principal: Principal, userId: string, input: { orgRole?: unknown; active?: unknown }): Promise<OrgUserView> {
    this.require(principal);
    if (input.orgRole === undefined && input.active === undefined) throw new IdentityError(400, "nothing_to_change", "Send orgRole or active.");
    if (input.orgRole !== undefined && !isRole(input.orgRole)) throw new IdentityError(400, "invalid_role", "Choose owner, admin, member or viewer.");
    if (input.active !== undefined && typeof input.active !== "boolean") throw new IdentityError(400, "invalid_active", "active must be true or false.");
    const user = await this.requireUser(userId);
    const target = await this.orgRoleOf(userId);
    this.assertCanManage(principal, user, target);
    if (input.orgRole !== undefined && input.orgRole !== target) await this.setOrgRole(principal, user, target, input.orgRole as Role);
    if (input.active === false && user.disabledAt === undefined) await this.turnOff(principal, user, target);
    if (input.active === true && user.disabledAt !== undefined) await this.turnOn(principal, user);
    return (await this.listUsers(principal)).find((view) => view.id === userId)!;
  }

  /** Remove someone from the organization: every membership goes, the account is turned off and left out of the list. */
  async removeUser(principal: Principal, userId: string): Promise<void> {
    this.require(principal);
    const user = await this.requireUser(userId);
    const role = await this.orgRoleOf(userId);
    if (principal.userId === userId) throw new IdentityError(409, "self", "You can't remove yourself. Ask another owner.");
    this.assertCanManage(principal, user, role);
    await this.assertNotManaged(user);
    if (role === "owner") await this.assertAnotherOwner(userId);
    const now = this.now();
    for (const membership of await this.store.identity.memberships.listForUser(this.orgId, userId)) {
      await this.store.identity.memberships.remove(this.orgId, userId, membership.scope);
    }
    await this.store.identity.users.upsert({ ...user, disabledAt: user.disabledAt ?? now, removedAt: now });
    await this.identity.endSessions(userId);
    this.identity.notifyChange({ kind: "user", userId });
    this.audit({ action: AUDIT_ACTIONS.USER_REMOVED, actor: auditActor(principal), target: { kind: "user", id: userId, name: user.email }, details: { orgRole: role } });
  }

  private async setOrgRole(principal: Principal, user: UserRecord, from: Role, to: Role): Promise<void> {
    const actorRole = principal.orgRole ?? "member";
    // Nobody grants more than they have: admins can't make owners.
    if (roleRank(to) > roleRank(actorRole)) throw forbidden(`You can't give a role above your own (${actorRole}).`);
    if (from === "owner" && to !== "owner") await this.assertAnotherOwner(user.id);
    await this.store.identity.memberships.upsert(this.orgId, { userId: user.id, scope: "org", role: to });
    this.identity.notifyChange({ kind: "memberships", userId: user.id });
    this.audit({
      action: AUDIT_ACTIONS.ORG_ROLE_CHANGED,
      actor: auditActor(principal),
      target: { kind: "user", id: user.id, name: user.email },
      details: { from, to }
    });
  }

  private async turnOff(principal: Principal, user: UserRecord, role: Role): Promise<void> {
    if (principal.userId === user.id) throw new IdentityError(409, "self", "You can't turn off your own account.");
    await this.assertNotManaged(user);
    if (role === "owner") await this.assertAnotherOwner(user.id);
    await this.store.identity.users.upsert({ ...user, disabledAt: this.now() });
    // Every session ends now; open connections close (identity onChange).
    await this.identity.endSessions(user.id);
    this.identity.notifyChange({ kind: "user", userId: user.id });
    this.audit({ action: AUDIT_ACTIONS.USER_DISABLED, actor: auditActor(principal), target: { kind: "user", id: user.id, name: user.email } });
  }

  private async turnOn(principal: Principal, user: UserRecord): Promise<void> {
    await this.assertNotManaged(user);
    const { disabledAt: _off, ...next } = user;
    await this.store.identity.users.upsert(next);
    this.identity.notifyChange({ kind: "user", userId: user.id });
    this.audit({ action: AUDIT_ACTIONS.USER_ENABLED, actor: auditActor(principal), target: { kind: "user", id: user.id, name: user.email } });
  }

  /* ───────────── rules ───────────── */

  private async requireUser(userId: string): Promise<UserRecord> {
    const user = await this.store.identity.users.get(this.orgId, userId);
    if (!user || user.removedAt !== undefined) throw new IdentityError(404, "user_not_found", "That person isn't in this organization.");
    return user;
  }

  private async orgRoleOf(userId: string): Promise<Role> {
    return (await this.store.identity.memberships.listForUser(this.orgId, userId)).find((m) => m.scope === "org")?.role ?? "member";
  }

  /** Nobody changes someone above them. */
  private assertCanManage(principal: Principal, _user: UserRecord, targetRole: Role): void {
    const actorRole = principal.orgRole ?? "member";
    if (roleRank(targetRole) > roleRank(actorRole)) throw forbidden("You can't change someone above you.");
  }

  /** The organization keeps an active owner other than `userId`. */
  private async assertAnotherOwner(userId: string): Promise<void> {
    const active = new Set((await this.store.identity.users.list(this.orgId)).filter((u) => u.disabledAt === undefined).map((u) => u.id));
    const owners = (await this.store.identity.memberships.listForScope(this.orgId, "org")).filter((m) => m.role === "owner" && m.userId !== userId && active.has(m.userId));
    if (owners.length === 0) throw new IdentityError(409, "last_owner", "The organization needs an owner. Make someone else an owner first.");
  }

  private async assertNotManaged(user: UserRecord): Promise<void> {
    if ((await this.describe([user.id]))[user.id]?.managedBy === "scim") {
      throw new IdentityError(409, "managed_by_idp", "Managed by your identity provider. Turn this account off or remove it there.");
    }
  }

  private async describe(userIds: string[]): Promise<Record<string, ExternalUserFacts>> {
    const merged: Record<string, ExternalUserFacts> = {};
    if (userIds.length === 0) return merged;
    for (const extension of this.options.extensions?.() ?? []) {
      if (!extension.describeUsers) continue;
      const facts = await extension.describeUsers(userIds);
      for (const [id, fact] of Object.entries(facts)) {
        const current = (merged[id] ??= {});
        if (fact.sso) current.sso = { providers: [...new Set([...(current.sso?.providers ?? []), ...fact.sso.providers])] };
        if (fact.managedBy) current.managedBy = fact.managedBy;
      }
    }
    return merged;
  }
}

function settingsView(settings: OrgSettings): Omit<OrgSettingsView, "budgetLimits" | "spent"> {
  return {
    name: settings.name ?? "",
    defaultWorkspaceId: settings.defaultWorkspaceId ?? null,
    defaultRole: settings.defaultRole,
    budget: { ...(settings.budget ?? {}) },
    ...(settings.updatedAt !== undefined ? { updatedAt: settings.updatedAt } : {})
  };
}

function toView(
  user: UserRecord,
  memberships: MembershipRecord[],
  workspaceNames: Map<string, string>,
  twoStep: boolean,
  facts: ExternalUserFacts | undefined,
  callerId: string | undefined
): OrgUserView {
  const workspaces: OrgUserView["workspaces"] = [];
  let orgRole: Role = "member";
  for (const m of memberships) {
    if (m.scope === "org") orgRole = m.role;
    else if (workspaceNames.has(m.scope.workspaceId)) workspaces.push({ id: m.scope.workspaceId, name: workspaceNames.get(m.scope.workspaceId)!, role: m.role });
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    orgRole,
    workspaces,
    createdAt: user.createdAt,
    ...(user.lastActiveAt !== undefined ? { lastActiveAt: user.lastActiveAt } : {}),
    signIn: {
      password: user.passwordHash.startsWith("scrypt$"),
      twoStep,
      ...(facts?.sso ? { sso: facts.sso.providers } : {})
    },
    status: user.disabledAt === undefined ? "active" : "disabled",
    ...(facts?.managedBy ? { managedBy: facts.managedBy } : {}),
    ...(callerId === user.id ? { you: true } : {})
  };
}
