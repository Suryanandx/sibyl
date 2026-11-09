/**
 * The enterprise directory — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * What SSO and SCIM share: creating accounts for people the identity
 * provider vouches for, linking provider identities to accounts, turning
 * accounts off, groups, and group → workspace role mapping. Users,
 * memberships and sessions stay the open-source identity records
 * (store.identity); this only adds what enterprise needs on top, in one
 * `store.kv` entry (`ee.directory.v1`):
 *
 * - settings: where new people land (workspace + role), just-in-time
 *   creation at SSO sign-in, and group → role rules. Workspace and role are
 *   kept only when set here explicitly; otherwise they follow Admin →
 *   Organization ("New people also join" / "Default role"), read live, so a
 *   later change there reaches SSO and SCIM accounts too;
 * - per user: SCIM externalId, provider links (provider id + subject), the
 *   groups the last SSO sign-in reported, and the workspace roles group
 *   rules granted (so a later change can take exactly those back);
 * - SCIM groups (display name, members).
 *
 * Accounts created here have no password (`passwordHash` "!external"); they
 * sign in through SSO. Someone removed from the organization (Admin → Users)
 * who comes back through SSO or SCIM gets their old account id back as a
 * fresh account — nothing of the old access, links or groups — exactly like
 * an invitation does.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  isRole,
  normalizeEmail,
  readOrgSettings,
  roleRank,
  type Role,
  type Store,
  type UserRecord
} from "../../../packages/core/src/index";
import type { DirectorySettingsView, GroupRoleRule } from "../../../packages/protocol/src/index";

export const DIRECTORY_KV_KEY = "ee.directory.v1";
/** No password: the account signs in through SSO. verifyPassword() never accepts it. */
export const EXTERNAL_PASSWORD_HASH = "!external";
const MAX_RULES = 200;
const MAX_GROUPS = 5_000;

export interface DirectorySettings {
  defaultWorkspaceId: string;
  defaultRole: Role;
  jitProvisioning: boolean;
  groupRoles: GroupRoleRule[];
}

export interface DirectoryUser {
  externalId?: string;
  /** Who created the account ("scim" or an SSO provider id). */
  createdBy?: string;
  givenName?: string;
  familyName?: string;
  /** Provider identities linked to this account. */
  links?: Array<{ providerId: string; subject: string }>;
  /** Groups from the last SSO sign-in. */
  ssoGroups?: string[];
  /** Workspace roles granted by group rules (taken back when the rules stop matching). */
  granted?: Array<{ workspaceId: string; role: Role }>;
}

export interface DirectoryGroup {
  id: string;
  displayName: string;
  externalId?: string;
  members: string[];
  createdAt: number;
  updatedAt: number;
}

/** What is stored: the explicit choices only (workspace and role absent: follow the organization's defaults). */
interface StoredSettings {
  version?: 2;
  defaultWorkspaceId?: string;
  defaultRole?: Role;
  jitProvisioning: boolean;
  groupRoles: GroupRoleRule[];
}

interface DirectoryData {
  settings: StoredSettings;
  users: Record<string, DirectoryUser>;
  groups: Record<string, DirectoryGroup>;
}

/** An expected failure with an HTTP status (mapped by the routes). */
export class DirectoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DirectoryError";
  }
}

const DEFAULT_SETTINGS: DirectorySettings = { defaultWorkspaceId: DEFAULT_WORKSPACE_ID, defaultRole: "member", jitProvisioning: true, groupRoles: [] };

/**
 * Stored settings from before version 2 saved the workspace and role every
 * time, also when they only repeated the defaults. Keep a value only when it
 * differs from both the built-in default and the organization's default:
 * that one was chosen here.
 */
function migrateSettings(stored: Partial<DirectorySettings> & { version?: number }, org: { defaultWorkspaceId?: string; defaultRole: Role }): StoredSettings {
  const out: StoredSettings = {
    version: 2,
    jitProvisioning: stored.jitProvisioning ?? DEFAULT_SETTINGS.jitProvisioning,
    groupRoles: Array.isArray(stored.groupRoles) ? stored.groupRoles : []
  };
  const explicit = stored.version === 2;
  const workspace = stored.defaultWorkspaceId;
  if (typeof workspace === "string" && (explicit || (workspace !== DEFAULT_SETTINGS.defaultWorkspaceId && workspace !== org.defaultWorkspaceId))) out.defaultWorkspaceId = workspace;
  const role = stored.defaultRole;
  if (isRole(role) && role !== "owner" && (explicit || (role !== DEFAULT_SETTINGS.defaultRole && role !== org.defaultRole))) out.defaultRole = role;
  return out;
}

export interface DirectoryOptions {
  store: Store;
  orgId: string;
  now?: () => number;
  createId?: () => string;
  /** Users or memberships changed: open connections re-check (bridge.changed). */
  changed(change: { kind: "memberships" | "user"; userId?: string }): void;
  /** End a user's sessions (bridge.endSessions). */
  endSessions(userId: string): Promise<void>;
  log(event: string, fields?: Record<string, unknown>): void;
}

export class Directory {
  private data: DirectoryData | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: DirectoryOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  private get identity() {
    return this.options.store.identity;
  }

  /* ───────────── storage ───────────── */

  private async load(): Promise<DirectoryData> {
    if (!this.data) {
      const stored = await this.options.store.kv.get<{ settings?: Partial<DirectorySettings> & { version?: number }; users?: DirectoryData["users"]; groups?: DirectoryData["groups"] }>(
        this.options.orgId,
        DIRECTORY_KV_KEY
      );
      this.data = {
        settings: migrateSettings(stored?.settings ?? { version: 2 }, await readOrgSettings(this.options.store, this.options.orgId)),
        users: stored?.users ?? {},
        groups: stored?.groups ?? {}
      };
    }
    return this.data;
  }

  /** Read-modify-write, one at a time (this process is the only writer). */
  private mutate<T>(change: (data: DirectoryData) => T | Promise<T>): Promise<T> {
    const run = this.writes.catch(() => undefined).then(async () => {
      const data = await this.load();
      const result = await change(data);
      await this.options.store.kv.set(this.options.orgId, DIRECTORY_KV_KEY, data);
      return result;
    });
    this.writes = run;
    return run;
  }

  /* ───────────── settings ───────────── */

  /** The settings in force: what was chosen here, else the organization's defaults (read now), else the built-in ones. */
  async settings(): Promise<DirectorySettings> {
    const stored = (await this.load()).settings;
    const org = await this.orgDefaults();
    return {
      defaultWorkspaceId: stored.defaultWorkspaceId ?? org.defaultWorkspaceId,
      defaultRole: stored.defaultRole ?? org.defaultRole,
      jitProvisioning: stored.jitProvisioning,
      groupRoles: structuredClone(stored.groupRoles)
    };
  }

  private async orgDefaults(): Promise<{ defaultWorkspaceId: string; defaultRole: Role }> {
    const org = await readOrgSettings(this.options.store, this.options.orgId);
    return { defaultWorkspaceId: org.defaultWorkspaceId ?? DEFAULT_SETTINGS.defaultWorkspaceId, defaultRole: org.defaultRole };
  }

  async settingsView(): Promise<DirectorySettingsView> {
    const settings = await this.settings();
    const stored = (await this.load()).settings;
    const workspaces = (await this.options.store.workspaces.list(this.options.orgId)).map((w) => ({ id: w.id, name: w.name }));
    return {
      ...settings,
      workspaces,
      followsOrganization: { workspace: stored.defaultWorkspaceId === undefined, role: stored.defaultRole === undefined },
      organizationDefaults: await this.orgDefaults()
    };
  }

  async updateSettings(input: Record<string, unknown>): Promise<DirectorySettingsView> {
    const workspaces = new Set((await this.options.store.workspaces.list(this.options.orgId)).map((w) => w.id));
    workspaces.add(DEFAULT_WORKSPACE_ID);
    await this.mutate((data) => {
      const next: StoredSettings = { ...data.settings, version: 2 };
      // null: follow Admin → Organization again.
      if (input.defaultWorkspaceId === null) delete next.defaultWorkspaceId;
      else if (input.defaultWorkspaceId !== undefined) {
        if (typeof input.defaultWorkspaceId !== "string" || !workspaces.has(input.defaultWorkspaceId)) throw new DirectoryError(400, "invalid_workspace", "Choose an existing workspace.");
        next.defaultWorkspaceId = input.defaultWorkspaceId;
      }
      if (input.defaultRole === null) delete next.defaultRole;
      else if (input.defaultRole !== undefined) {
        // New people never start as owners.
        if (!isRole(input.defaultRole) || input.defaultRole === "owner") throw new DirectoryError(400, "invalid_role", "Choose admin, member or viewer.");
        next.defaultRole = input.defaultRole;
      }
      if (input.jitProvisioning !== undefined) next.jitProvisioning = input.jitProvisioning === true;
      if (input.groupRoles !== undefined) next.groupRoles = parseRules(input.groupRoles, workspaces);
      data.settings = next;
    });
    this.options.log("directory.settings_changed", {});
    // Rules changed: re-apply them to everyone they could touch.
    for (const userId of Object.keys((await this.load()).users)) await this.syncRoles(userId);
    return this.settingsView();
  }

  /* ───────────── users ───────────── */

  async record(userId: string): Promise<DirectoryUser | undefined> {
    const entry = (await this.load()).users[userId];
    return entry ? structuredClone(entry) : undefined;
  }

  async updateRecord(userId: string, patch: Partial<DirectoryUser>): Promise<void> {
    await this.mutate((data) => {
      const entry = { ...(data.users[userId] ?? {}), ...patch };
      for (const key of Object.keys(entry) as Array<keyof DirectoryUser>) if (entry[key] === undefined) delete entry[key];
      data.users[userId] = entry;
    });
  }

  async findByExternalId(externalId: string): Promise<string | undefined> {
    const users = (await this.load()).users;
    return Object.keys(users).find((id) => users[id]!.externalId === externalId);
  }

  async findByLink(providerId: string, subject: string): Promise<UserRecord | undefined> {
    const users = (await this.load()).users;
    const id = Object.keys(users).find((key) => users[key]!.links?.some((link) => link.providerId === providerId && link.subject === subject));
    const user = id ? await this.identity.users.get(this.options.orgId, id) : undefined;
    // A removed account is no longer anyone's: it comes back only through provisioning.
    return user && user.removedAt === undefined ? user : undefined;
  }

  async link(userId: string, providerId: string, subject: string): Promise<void> {
    await this.mutate((data) => {
      const entry = (data.users[userId] ??= {});
      const links = (entry.links ?? []).filter((link) => link.providerId !== providerId);
      entry.links = [...links, { providerId, subject }];
    });
  }

  /**
   * Create an account for someone the identity provider vouches for: no
   * password, organization member, and the default workspace with the
   * default role.
   */
  async provision(input: { email: string; name?: string; createdBy: string; externalId?: string; givenName?: string; familyName?: string; active?: boolean }): Promise<UserRecord> {
    const email = normalizeEmail(input.email);
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/.test(email) || email.length > 254) throw new DirectoryError(400, "invalid_email", "A valid email address is needed.");
    const existing = await this.identity.users.getByEmail(this.options.orgId, email);
    if (existing && existing.removedAt === undefined) throw new DirectoryError(409, "account_exists", "An account with this email already exists.");
    // Removed from the organization earlier: the same id comes back as a fresh account, without the old access, links or groups.
    if (existing) await this.forget(existing.id);
    const name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || email.split("@")[0]!;
    const user: UserRecord = {
      id: existing?.id ?? this.createId(),
      orgId: this.options.orgId,
      email,
      name,
      passwordHash: EXTERNAL_PASSWORD_HASH,
      createdAt: this.now(),
      ...(input.active === false ? { disabledAt: this.now() } : {})
    };
    await this.identity.users.upsert(user);
    await this.identity.memberships.upsert(this.options.orgId, { userId: user.id, scope: "org", role: "member" });
    const settings = await this.settings();
    if (await this.workspaceExists(settings.defaultWorkspaceId)) {
      await this.identity.memberships.upsert(this.options.orgId, { userId: user.id, scope: { workspaceId: settings.defaultWorkspaceId }, role: settings.defaultRole });
    }
    await this.updateRecord(user.id, {
      createdBy: input.createdBy,
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ...(input.givenName ? { givenName: input.givenName } : {}),
      ...(input.familyName ? { familyName: input.familyName } : {})
    });
    this.options.log("directory.user_created", { userId: user.id, by: input.createdBy, ...(existing ? { returning: true } : {}) });
    this.options.changed({ kind: "user", userId: user.id });
    return user;
  }

  /** A live account (not removed from the organization) with this e-mail. */
  async activeByEmail(email: string): Promise<UserRecord | undefined> {
    const user = await this.identity.users.getByEmail(this.options.orgId, normalizeEmail(email));
    return user && user.removedAt === undefined ? user : undefined;
  }

  /** Drop what the directory kept about a removed account (and any memberships left), before it is provisioned again. */
  private async forget(userId: string): Promise<void> {
    for (const membership of await this.identity.memberships.listForUser(this.options.orgId, userId)) {
      await this.identity.memberships.remove(this.options.orgId, userId, membership.scope);
    }
    await this.mutate((data) => {
      delete data.users[userId];
      for (const group of Object.values(data.groups)) {
        if (group.members.includes(userId)) group.members = group.members.filter((id) => id !== userId);
      }
    });
  }

  /** Turn an account off: no sign-in, every session ends, open connections close. */
  async deactivate(userId: string): Promise<UserRecord> {
    const user = await this.requireUser(userId);
    if (user.disabledAt !== undefined) return user;
    await this.assertNotLastOwner(userId);
    const next = { ...user, disabledAt: this.now() };
    await this.identity.users.upsert(next);
    await this.options.endSessions(userId);
    this.options.log("directory.user_deactivated", { userId });
    this.options.changed({ kind: "user", userId });
    return next;
  }

  async reactivate(userId: string): Promise<UserRecord> {
    const user = await this.requireUser(userId);
    if (user.disabledAt === undefined) return user;
    const { disabledAt: _disabled, ...next } = user;
    await this.identity.users.upsert(next);
    this.options.log("directory.user_reactivated", { userId });
    this.options.changed({ kind: "user", userId });
    return next;
  }

  async requireUser(userId: string): Promise<UserRecord> {
    const user = await this.identity.users.get(this.options.orgId, userId);
    if (!user) throw new DirectoryError(404, "not_found", "No such user.");
    return user;
  }

  private async assertNotLastOwner(userId: string): Promise<void> {
    const owners = (await this.identity.memberships.listForScope(this.options.orgId, "org")).filter((m) => m.role === "owner");
    if (!owners.some((m) => m.userId === userId)) return;
    const active = (await this.identity.users.list(this.options.orgId)).filter((u) => u.disabledAt === undefined).map((u) => u.id);
    if (!owners.some((m) => m.userId !== userId && active.includes(m.userId))) {
      throw new DirectoryError(409, "last_owner", "This is the organization's last owner; make someone else an owner first.");
    }
  }

  private async workspaceExists(workspaceId: string): Promise<boolean> {
    return Boolean(await this.options.store.workspaces.get(this.options.orgId, workspaceId));
  }

  /* ───────────── groups ───────────── */

  async listGroups(): Promise<DirectoryGroup[]> {
    return Object.values((await this.load()).groups)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((group) => structuredClone(group));
  }

  async getGroup(id: string): Promise<DirectoryGroup | undefined> {
    const group = (await this.load()).groups[id];
    return group ? structuredClone(group) : undefined;
  }

  /** Create or replace a group; members' roles are re-synced. */
  async saveGroup(input: { id?: string; displayName: string; externalId?: string; members: string[] }): Promise<DirectoryGroup> {
    const displayName = input.displayName.trim().slice(0, 200);
    if (!displayName) throw new DirectoryError(400, "invalid_value", "displayName is required.");
    const members = [...new Set(input.members)];
    for (const userId of members) await this.requireUser(userId);
    const before = input.id ? (await this.load()).groups[input.id]?.members ?? [] : [];
    const group = await this.mutate((data) => {
      const clash = Object.values(data.groups).find((g) => g.id !== input.id && g.displayName.toLowerCase() === displayName.toLowerCase());
      if (clash) throw new DirectoryError(409, "uniqueness", `A group named ${displayName} already exists.`);
      if (!input.id && Object.keys(data.groups).length >= MAX_GROUPS) throw new DirectoryError(400, "too_many", "Too many groups.");
      const existing = input.id ? data.groups[input.id] : undefined;
      if (input.id && !existing) throw new DirectoryError(404, "not_found", "No such group.");
      const now = this.now();
      const saved: DirectoryGroup = {
        id: existing?.id ?? this.createId(),
        displayName,
        ...(input.externalId ? { externalId: input.externalId } : {}),
        members,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      data.groups[saved.id] = saved;
      return saved;
    });
    for (const userId of new Set([...before, ...members])) await this.syncRoles(userId);
    return structuredClone(group);
  }

  async deleteGroup(id: string): Promise<void> {
    const removed = await this.mutate((data) => {
      const group = data.groups[id];
      if (!group) throw new DirectoryError(404, "not_found", "No such group.");
      delete data.groups[id];
      return group;
    });
    for (const userId of removed.members) await this.syncRoles(userId);
  }

  /** Groups reported by an SSO sign-in (replaces the previous ones). */
  async setSsoGroups(userId: string, groups: string[]): Promise<void> {
    await this.updateRecord(userId, { ssoGroups: [...new Set(groups.map((g) => g.trim()).filter(Boolean))].slice(0, 500) });
    await this.syncRoles(userId);
  }

  /**
   * Apply the group → role rules to one person: grant the highest matching
   * role per workspace (never lowering a higher role given by hand), and
   * take back roles the rules granted earlier that no longer match.
   */
  async syncRoles(userId: string): Promise<void> {
    // Removed from the organization: no rule gives them anything back.
    const account = await this.identity.users.get(this.options.orgId, userId);
    if (!account || account.removedAt !== undefined) return;
    const data = await this.load();
    const entry = data.users[userId] ?? {};
    const groups = new Set((entry.ssoGroups ?? []).map((g) => g.toLowerCase()));
    for (const group of Object.values(data.groups)) if (group.members.includes(userId)) groups.add(group.displayName.toLowerCase());
    const desired = new Map<string, Role>();
    for (const rule of data.settings.groupRoles) {
      if (!groups.has(rule.group.toLowerCase())) continue;
      if (!(await this.workspaceExists(rule.workspaceId))) continue;
      const current = desired.get(rule.workspaceId);
      if (!current || roleRank(rule.role) > roleRank(current)) desired.set(rule.workspaceId, rule.role);
    }
    const previous = new Map((entry.granted ?? []).map((g) => [g.workspaceId, g.role] as const));
    if (desired.size === 0 && previous.size === 0) return;
    const memberships = await this.identity.memberships.listForUser(this.options.orgId, userId);
    const roleIn = (workspaceId: string) => memberships.find((m) => m.scope !== "org" && m.scope.workspaceId === workspaceId)?.role;
    let changed = false;
    for (const [workspaceId, role] of previous) {
      // Granted by a rule that no longer matches, and not changed by hand since: take it back.
      if (!desired.has(workspaceId) && roleIn(workspaceId) === role) {
        await this.identity.memberships.remove(this.options.orgId, userId, { workspaceId });
        changed = true;
      }
    }
    for (const [workspaceId, role] of desired) {
      const current = roleIn(workspaceId);
      const ours = previous.get(workspaceId);
      const raise = !current || roleRank(role) > roleRank(current);
      // Lower a role only when the rules granted it (a rule's role went down).
      const lower = current !== undefined && ours === current && roleRank(role) < roleRank(current);
      if (raise || lower) {
        await this.identity.memberships.upsert(this.options.orgId, { userId, scope: { workspaceId }, role });
        changed = true;
      }
    }
    const granted = [...desired].map(([workspaceId, role]) => ({ workspaceId, role }));
    await this.updateRecord(userId, { granted: granted.length ? granted : undefined });
    if (changed) {
      this.options.log("directory.roles_synced", { userId, workspaces: granted.length });
      this.options.changed({ kind: "memberships", userId });
    }
  }
}

function parseRules(value: unknown, workspaces: Set<string>): GroupRoleRule[] {
  if (!Array.isArray(value) || value.length > MAX_RULES) throw new DirectoryError(400, "invalid_rules", `Send up to ${MAX_RULES} group rules.`);
  return value.map((raw) => {
    const rule = raw as Record<string, unknown>;
    const group = typeof rule.group === "string" ? rule.group.trim().slice(0, 200) : "";
    if (!group) throw new DirectoryError(400, "invalid_rules", "Each rule needs a group name.");
    if (typeof rule.workspaceId !== "string" || !workspaces.has(rule.workspaceId)) throw new DirectoryError(400, "invalid_rules", `Rule for ${group}: choose an existing workspace.`);
    // Ownership is never handed out by a group.
    if (!isRole(rule.role) || rule.role === "owner") throw new DirectoryError(400, "invalid_rules", `Rule for ${group}: choose admin, member or viewer.`);
    return { group, workspaceId: rule.workspaceId, role: rule.role };
  });
}
