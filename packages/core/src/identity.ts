/**
 * People and sign-in: users, memberships, invitations and sessions.
 *
 * - The organization is today's `ownerId` (default "owner"); every user
 *   belongs to exactly one organization (`orgId`).
 * - A membership gives a user a role either in the whole organization
 *   (`scope: "org"`) or in one workspace (`scope: { workspaceId }`).
 * - Invitations and sessions only ever store a SHA-256 hash of their token;
 *   the token itself is shown once (invite link, session cookie).
 *
 * Permission rules live in ./permissions.ts; the gateway's identity service
 * (apps/gateway/src/identity) owns hashing, cookies and the HTTP routes.
 */

import type { AvatarSpec } from "./avatar";
import type { SpendCaps } from "./workspace";

export type Role = "owner" | "admin" | "member" | "viewer";

export const ROLES: readonly Role[] = ["owner", "admin", "member", "viewer"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface UserRecord {
  id: string;
  /** Organization (the store's ownerId). */
  orgId: string;
  /** Lower-cased; unique within the organization. */
  email: string;
  name: string;
  /** scrypt hash string produced by the gateway (never the password). */
  passwordHash: string;
  createdAt: number;
  /** Set when the account is turned off (or removed); they can't sign in. */
  disabledAt?: number;
  /** Set when the user was removed from the organization (memberships gone; left out of the people list). */
  removedAt?: number;
  /** Last sign-in or activity (written at most hourly per session; see users.touch). */
  lastActiveAt?: number;
  /** When this address was proven to belong to them (hosted sign-up, email-bound invite). */
  emailVerifiedAt?: number;
  /** Accounts at Google / Microsoft this person signs in with ("Continue with …"), by the provider's subject. */
  links?: ExternalLogin[];
  /** The face they chose (onboarding, Settings); absent: none chosen yet. */
  avatar?: AvatarSpec;
}

/** A Google or Microsoft account linked to a Sibyl account. */
export interface ExternalLogin {
  provider: "google" | "microsoft";
  subject: string;
  linkedAt: number;
}

export type MembershipScope = "org" | { workspaceId: string };

export interface MembershipRecord {
  userId: string;
  scope: MembershipScope;
  role: Role;
}

export interface InviteRecord {
  id: string;
  orgId: string;
  /** SHA-256 (hex) of the one-time invite token. */
  tokenHash: string;
  /** Optional: when set, only this address may accept. Lower-cased. */
  email?: string;
  workspaceId: string;
  role: Role;
  /** User id of the inviter (or "token" for the API owner token). */
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  acceptedBy?: string;
}

export interface SessionRecord {
  id: string;
  /** SHA-256 (hex) of the session cookie value. */
  tokenHash: string;
  userId: string;
  orgId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

/** What a sign-up ticket proves: who verified their address, and how. */
export interface SignupTicket {
  email: string;
  name?: string;
  provider: "password" | "magic_link" | "google" | "microsoft";
  /** The identity provider's subject (Google / Microsoft sign-up). */
  subject?: string;
  /** scrypt hash of the password chosen at sign-up (password sign-up). */
  passwordHash?: string;
}

/**
 * Hosted sign-up: the sign-up layer issues a ticket once the address is
 * verified (link, code, Google or Microsoft); creating an organization
 * (POST /api/orgs) redeems it. undefined: not a valid ticket.
 */
export interface SignupTicketVerifier {
  verify(ticket: string): Promise<SignupTicket | undefined>;
  /**
   * The organization was created: the ticket can't be used again (tickets
   * are single-use). Called only after a successful POST /api/orgs, so a
   * rejected organization name doesn't burn the ticket.
   */
  redeem?(ticket: string): Promise<void>;
}

/** Stable key for a membership scope ("org" or "ws:<id>"). */
export function membershipScopeKey(scope: MembershipScope): string {
  return scope === "org" ? "org" : `ws:${scope.workspaceId}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/* ───────────── Store collections ───────────── */

export interface IdentityStore {
  users: {
    count(orgId: string): Promise<number>;
    list(orgId: string): Promise<UserRecord[]>;
    get(orgId: string, id: string): Promise<UserRecord | undefined>;
    /** Email is matched lower-cased. */
    getByEmail(orgId: string, email: string): Promise<UserRecord | undefined>;
    /** Insert or replace. Throws when another user of the org has the same email. */
    upsert(record: UserRecord): Promise<void>;
    /** Record activity: sets lastActiveAt (only moves forward; no-op for unknown users). */
    touch(orgId: string, id: string, at: number): Promise<void>;
    /** Every organization's user with this email (lower-cased match): a person's organizations. */
    listByEmail(email: string): Promise<UserRecord[]>;
  };
  memberships: {
    /** Every membership in the organization (the admin people list). */
    list(orgId: string): Promise<MembershipRecord[]>;
    /** All memberships of one user. */
    listForUser(orgId: string, userId: string): Promise<MembershipRecord[]>;
    /** All memberships with this scope (org-wide, or one workspace). */
    listForScope(orgId: string, scope: MembershipScope): Promise<MembershipRecord[]>;
    /** Insert or replace the user's membership for record.scope. */
    upsert(orgId: string, record: MembershipRecord): Promise<void>;
    remove(orgId: string, userId: string, scope: MembershipScope): Promise<void>;
    /** Remove every membership of a workspace (workspace deleted). */
    removeScope(orgId: string, scope: MembershipScope): Promise<void>;
  };
  invites: {
    create(record: InviteRecord): Promise<void>;
    getByTokenHash(tokenHash: string): Promise<InviteRecord | undefined>;
    get(orgId: string, id: string): Promise<InviteRecord | undefined>;
    /** Newest first; optionally only one workspace's invites. */
    list(orgId: string, filter?: { workspaceId?: string; pendingAt?: number }): Promise<InviteRecord[]>;
    /** Marks a pending invite accepted; undefined when it was already used or doesn't exist. */
    accept(orgId: string, id: string, userId: string, at: number): Promise<InviteRecord | undefined>;
    remove(orgId: string, id: string): Promise<void>;
  };
  sessions: {
    create(record: SessionRecord): Promise<void>;
    getByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
    /** Slide the expiry (and lastSeenAt). */
    touch(id: string, lastSeenAt: number, expiresAt: number): Promise<void>;
    remove(id: string): Promise<void>;
    removeForUser(userId: string): Promise<void>;
    /** Delete expired sessions; returns how many were removed. */
    prune(now: number): Promise<number>;
  };
}

/* ───────────── In-memory implementation (createMemoryStore) ───────────── */

export class DuplicateEmailError extends Error {
  constructor() {
    super("A user with this email already exists.");
    this.name = "DuplicateEmailError";
  }
}

/** In-memory IdentityStore used by createMemoryStore(); semantics match the SQLite store. */
export function createMemoryIdentityStore(): IdentityStore {
  const clone = <T>(value: T): T => structuredClone(value);
  const users = new Map<string, UserRecord>();
  // key: orgId \0 userId \0 scopeKey (insertion order = list order)
  const memberships = new Map<string, { orgId: string; record: MembershipRecord }>();
  const invites = new Map<string, InviteRecord>();
  const sessions = new Map<string, SessionRecord>();
  const mKey = (orgId: string, userId: string, scope: MembershipScope) => `${orgId}\u0000${userId}\u0000${membershipScopeKey(scope)}`;

  return {
    users: {
      async count(orgId) {
        return [...users.values()].filter((u) => u.orgId === orgId).length;
      },
      async list(orgId) {
        return [...users.values()].filter((u) => u.orgId === orgId).sort((a, b) => a.createdAt - b.createdAt).map(clone);
      },
      async get(orgId, id) {
        const found = users.get(id);
        return found && found.orgId === orgId ? clone(found) : undefined;
      },
      async getByEmail(orgId, email) {
        const wanted = normalizeEmail(email);
        const found = [...users.values()].find((u) => u.orgId === orgId && u.email === wanted);
        return found ? clone(found) : undefined;
      },
      async upsert(record) {
        const email = normalizeEmail(record.email);
        const clash = [...users.values()].find((u) => u.orgId === record.orgId && u.email === email && u.id !== record.id);
        if (clash) throw new DuplicateEmailError();
        users.set(record.id, clone({ ...record, email }));
      },
      async touch(orgId, id, at) {
        const found = users.get(id);
        if (found && found.orgId === orgId && (found.lastActiveAt ?? 0) < at) found.lastActiveAt = at;
      },
      async listByEmail(email) {
        const wanted = normalizeEmail(email);
        return [...users.values()].filter((u) => u.email === wanted).sort((a, b) => a.createdAt - b.createdAt).map(clone);
      }
    },
    memberships: {
      async list(orgId) {
        return [...memberships.values()].filter((m) => m.orgId === orgId).map((m) => clone(m.record));
      },
      async listForUser(orgId, userId) {
        return [...memberships.values()].filter((m) => m.orgId === orgId && m.record.userId === userId).map((m) => clone(m.record));
      },
      async listForScope(orgId, scope) {
        const key = membershipScopeKey(scope);
        return [...memberships.values()]
          .filter((m) => m.orgId === orgId && membershipScopeKey(m.record.scope) === key)
          .map((m) => clone(m.record));
      },
      async upsert(orgId, record) {
        const key = mKey(orgId, record.userId, record.scope);
        const existing = memberships.get(key);
        if (existing) existing.record = clone(record);
        else memberships.set(key, { orgId, record: clone(record) });
      },
      async remove(orgId, userId, scope) {
        memberships.delete(mKey(orgId, userId, scope));
      },
      async removeScope(orgId, scope) {
        const key = membershipScopeKey(scope);
        for (const [k, m] of memberships) if (m.orgId === orgId && membershipScopeKey(m.record.scope) === key) memberships.delete(k);
      }
    },
    invites: {
      async create(record) {
        invites.set(record.id, clone(record));
      },
      async getByTokenHash(tokenHash) {
        const found = [...invites.values()].find((i) => i.tokenHash === tokenHash);
        return found ? clone(found) : undefined;
      },
      async get(orgId, id) {
        const found = invites.get(id);
        return found && found.orgId === orgId ? clone(found) : undefined;
      },
      async list(orgId, filter = {}) {
        return [...invites.values()]
          .filter(
            (i) =>
              i.orgId === orgId &&
              (!filter.workspaceId || i.workspaceId === filter.workspaceId) &&
              (filter.pendingAt === undefined || (i.acceptedAt === undefined && i.expiresAt > filter.pendingAt))
          )
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(clone);
      },
      async accept(orgId, id, userId, at) {
        const found = invites.get(id);
        if (!found || found.orgId !== orgId || found.acceptedAt !== undefined) return undefined;
        found.acceptedAt = at;
        found.acceptedBy = userId;
        return clone(found);
      },
      async remove(orgId, id) {
        if (invites.get(id)?.orgId === orgId) invites.delete(id);
      }
    },
    sessions: {
      async create(record) {
        sessions.set(record.id, clone(record));
      },
      async getByTokenHash(tokenHash) {
        const found = [...sessions.values()].find((s) => s.tokenHash === tokenHash);
        return found ? clone(found) : undefined;
      },
      async touch(id, lastSeenAt, expiresAt) {
        const found = sessions.get(id);
        if (found) {
          found.lastSeenAt = lastSeenAt;
          found.expiresAt = expiresAt;
        }
      },
      async remove(id) {
        sessions.delete(id);
      },
      async removeForUser(userId) {
        for (const [id, s] of sessions) if (s.userId === userId) sessions.delete(id);
      },
      async prune(now) {
        let removed = 0;
        for (const [id, s] of sessions) {
          if (s.expiresAt <= now) {
            sessions.delete(id);
            removed += 1;
          }
        }
        return removed;
      }
    }
  };
}

/* ───────────── Organization settings ───────────── */

/**
 * Organization-wide settings (Admin → Organization), kept in the store's
 * key-value collection under ORG_SETTINGS_KV_KEY for the organization.
 * - name: shown in the workspace switcher and in invitation emails.
 * - defaultWorkspaceId: every new account also joins this workspace (unset:
 *   only the workspace they were invited to).
 * - defaultRole: preselected for invitations, and the role new people get in
 *   the default workspace. Never owner.
 * - budget: the organization's daily/monthly spending caps set in the app;
 *   SIBYL_BUDGET_DAILY_USD / SIBYL_BUDGET_MONTHLY_USD stay an upper bound
 *   (and the cap when nothing is set here).
 */
export interface OrgSettings {
  name?: string;
  defaultWorkspaceId?: string;
  defaultRole: Exclude<Role, "owner">;
  budget?: SpendCaps;
  updatedAt?: number;
}

/** Keep only finite, non-negative caps. */
export function cleanSpendCaps(value: unknown): SpendCaps | undefined {
  if (!value || typeof value !== "object") return undefined;
  const caps: SpendCaps = {};
  for (const key of ["dailyUsd", "monthlyUsd"] as const) {
    const n = (value as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) caps[key] = n;
  }
  return caps.dailyUsd !== undefined || caps.monthlyUsd !== undefined ? caps : undefined;
}

export const ORG_SETTINGS_KV_KEY = "org.settings.v1";

export const DEFAULT_ORG_SETTINGS: Readonly<OrgSettings> = { defaultRole: "member" };

/** The organization's settings, defaults filled in. */
export async function readOrgSettings(store: { kv: { get<T>(ownerId: string, key: string): Promise<T | undefined> } }, orgId: string): Promise<OrgSettings> {
  const stored = await store.kv.get<Partial<OrgSettings>>(orgId, ORG_SETTINGS_KV_KEY);
  const role: unknown = stored?.defaultRole;
  const budget = cleanSpendCaps(stored?.budget);
  return {
    ...(budget ? { budget } : {}),
    ...(typeof stored?.name === "string" && stored.name ? { name: stored.name } : {}),
    ...(typeof stored?.defaultWorkspaceId === "string" && stored.defaultWorkspaceId ? { defaultWorkspaceId: stored.defaultWorkspaceId } : {}),
    defaultRole: isRole(role) && role !== "owner" ? role : DEFAULT_ORG_SETTINGS.defaultRole,
    ...(typeof stored?.updatedAt === "number" ? { updatedAt: stored.updatedAt } : {})
  };
}
