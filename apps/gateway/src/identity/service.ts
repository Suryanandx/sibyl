/**
 * Identity service: first-run setup, sign-in sessions, principals,
 * workspaces, members and invitations. HTTP routes (http.ts) and the
 * WebSocket wiring (gateway.ts) call into this; every check goes through
 * `authorize()` from @open-gpt-live/core.
 *
 * Modes:
 * - local:  no users yet and no SIBYL_OWNER_TOKEN — everything works like a
 *           single-owner install (owner principal); setup is open.
 * - setup:  no users yet but SIBYL_OWNER_TOKEN is set — the API token still
 *           works; people are sent to /setup, which needs the token.
 * - signin: users exist — people sign in; the owner token stays an API key.
 *
 * Hosted Sibyl (`hosted: true`) is always "signin": an organization is
 * created with its owner (createOwner) and there is no local mode, no
 * first-run setup and no owner token.
 */
import type { MfaChallengeView } from "@open-gpt-live/protocol";
import { randomUUID } from "node:crypto";
import {
  AUDIT_ACTIONS,
  DEFAULT_WORKSPACE_ID,
  DuplicateEmailError,
  PERMISSIONS,
  auditActor,
  authorize,
  canAccessWorkspace,
  effectiveWorkspaceRole,
  isRole,
  normalizeEmail,
  ownerPrincipal,
  permissionsFor,
  readOrgSettings,
  roleRank,
  type AuditActor,
  type AuditEvent,
  type ExternalLogin,
  type IdentityExtension,
  type InviteRecord,
  type MembershipRecord,
  type OrgSettings,
  type Principal,
  type Role,
  type SessionRecord,
  type SignInMethod,
  type SignInProvider,
  type Store,
  type UserRecord,
  type WorkspaceRecord
} from "@open-gpt-live/core";
import type {
  AuthMeResponse,
  IdentityUserView,
  InvitePreview,
  InviteView,
  MemberView,
  OrgSummary,
  WorkspaceView
} from "@open-gpt-live/protocol";
import { tokensMatch } from "../auth.js";
import { dummyPasswordHash, hashPassword, hashToken, passwordProblem, randomToken, verifyPassword } from "./crypto.js";
import type { InviteMailer } from "./mail.js";
import { MFA_ISSUER, MfaService, MfaUnavailableError } from "./mfa.js";
import { otpauthUrl } from "./totp.js";
import { LoginRateLimiter } from "./rate-limit.js";
import { applyBudgetPatch } from "./budget-input.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is written at most this often per session. */
const SESSION_TOUCH_MS = 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_WORKSPACE_NAME = "Personal";

export type IdentityMode = "local" | "setup" | "signin";

/** Expected failures, mapped to HTTP status codes by http.ts. */
export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

const forbidden = (message = "You don't have permission to do that.") => new IdentityError(403, "forbidden", message);

export interface IdentityServiceOptions {
  store: Store;
  /** Organization id (the runtime's ownerId). */
  orgId: string;
  ownerToken?: string;
  mailer?: InviteMailer;
  /** An invitation was accepted (the notifications module tells the inviter). */
  onInviteAccepted?(event: { invite: InviteRecord; user: UserRecord; workspaceName: string }): void;
  /** Public URL of the web app, used for invite links when the request has no allowed Origin. */
  appUrl?: string;
  now?: () => number;
  createId?: () => string;
  rateLimiter?: LoginRateLimiter;
  /**
   * Enterprise sign-in providers and session rules (SSO, session policies),
   * registered through @open-gpt-live/core's IdentityExtension hook. None in
   * the open-source edition.
   */
  extensions?: () => readonly IdentityExtension[];
  /** Master key for two-step verification secrets (the secrets vault key); undefined: two-step verification unavailable. */
  secretKey?: () => Buffer | undefined;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** The runtime's audit path: sign-ins, member and role changes, invitations, workspaces. */
  audit?: (event: AuditEvent) => void;
  /** A workspace budget changed: reload the usage meter's in-app budgets (metering/app-budgets.ts). */
  onBudgetsChanged?: () => Promise<void>;
  /** Hosted Sibyl: no local mode or first-run setup (organizations are created with their owner). */
  hosted?: boolean;
}

/** A signed-in browser: the principal plus the session it came from. */
export interface Authenticated {
  principal: Principal;
  session?: SessionRecord;
  user?: UserRecord;
}

/** "org": organization settings changed (every connection re-sends its identity). */
export type IdentityChange = { kind: "memberships" | "session" | "user" | "org"; userId?: string; sessionId?: string };

/** Result of a password check: signed in, or a second step (two-step verification) is needed first. */
export type SignInResult = { user: UserRecord; token: string } | { user: UserRecord; mfa: MfaChallenge };

/** The second sign-in step, exactly as the browser receives it. */
export type MfaChallenge = MfaChallengeView;

export class IdentityService {
  readonly orgId: string;
  readonly ownerToken: string | undefined;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly limiter: LoginRateLimiter;
  private readonly listeners = new Set<(change: IdentityChange) => void>();
  /** Users are never deleted (only disabled), so once true this stays true. */
  private hasUsers = false;
  private setupInFlight: Promise<unknown> | undefined;
  /** Two-step verification (TOTP + recovery codes). */
  readonly mfa: MfaService;

  constructor(private readonly options: IdentityServiceOptions) {
    this.store = options.store;
    this.orgId = options.orgId;
    this.ownerToken = options.ownerToken || undefined;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.limiter = options.rateLimiter ?? new LoginRateLimiter({ now: this.now });
    let key: Buffer | undefined | null = null;
    this.mfa = new MfaService({
      store: this.store,
      orgId: this.orgId,
      // Loaded on first use only (installs that never use it don't touch the key file).
      key: () => (key === null ? (key = options.secretKey?.() ?? undefined) : key),
      now: this.now
    });
  }

  private extensions(): readonly IdentityExtension[] {
    return this.options.extensions?.() ?? [];
  }

  /** Sign-in providers for the sign-in screen (none in the open-source edition). */
  async signInProviders(): Promise<SignInProvider[]> {
    const providers: SignInProvider[] = [];
    for (const extension of this.extensions()) if (extension.signInProviders) providers.push(...(await extension.signInProviders()));
    return providers;
  }

  /**
   * Every extension's sign-in rule (enforced SSO, allowed networks, required
   * two-step verification). Throws IdentityError(403) on the first refusal.
   */
  private async checkSignIn(input: { userId: string; email: string; method: SignInMethod; ip: string }): Promise<{ requireMfa: boolean }> {
    let requireMfa = false;
    const extensions = this.extensions();
    if (extensions.length === 0) return { requireMfa };
    const orgRole = input.userId
      ? (await this.store.identity.memberships.listForUser(this.orgId, input.userId)).find((m) => m.scope === "org")?.role
      : undefined;
    for (const extension of extensions) {
      if (!extension.checkSignIn) continue;
      const decision = await extension.checkSignIn({ ...input, ...(orgRole ? { orgRole } : {}) });
      if (!decision.allow) {
        this.options.log?.("identity.sign_in_refused", { ...(input.userId ? { userId: input.userId } : {}), method: input.method, code: decision.code });
        throw new IdentityError(403, decision.code, decision.message);
      }
      if (decision.requireMfa) requireMfa = true;
    }
    return { requireMfa };
  }

  /** Every extension's session rule: refused (and whether to end it), or how often to write last-seen. */
  private async checkSession(session: SessionRecord, ip: string | undefined): Promise<{ refused?: { end: boolean }; touchEveryMs: number }> {
    let touchEveryMs = SESSION_TOUCH_MS;
    for (const extension of this.extensions()) {
      if (!extension.checkSession) continue;
      const decision = await extension.checkSession({
        userId: session.userId,
        sessionId: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        ...(ip ? { ip } : {}),
        now: this.now()
      });
      if (!decision.allow) {
        this.options.log?.("identity.session_refused", { userId: session.userId, code: decision.code, end: decision.end });
        return { refused: { end: decision.end }, touchEveryMs };
      }
      if (decision.touchEveryMs !== undefined) touchEveryMs = Math.max(10_000, Math.min(touchEveryMs, decision.touchEveryMs));
    }
    return { touchEveryMs };
  }

  private audit(event: AuditEvent): void {
    this.options.audit?.(event);
  }

  get mailer(): InviteMailer | undefined {
    return this.options.mailer;
  }

  get appUrl(): string | undefined {
    return this.options.appUrl;
  }

  /* ───────────── modes & principals ───────────── */

  async mode(): Promise<IdentityMode> {
    if (this.options.hosted) return "signin";
    if (!this.hasUsers) this.hasUsers = (await this.store.identity.users.count(this.orgId)) > 0;
    if (this.hasUsers) return "signin";
    return this.ownerToken ? "setup" : "local";
  }

  /** Subscribe to membership / session changes (connections re-check their principal). */
  onChange(listener: (change: IdentityChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Users, memberships or organization settings changed outside this service (Admin, the enterprise directory): connections re-check. */
  notifyChange(change: { kind: "memberships" | "user" | "org"; userId?: string }): void {
    if (change.kind === "user") this.hasUsers = false; // re-count (a provisioned first user ends local mode)
    this.emit(change);
  }

  private emit(change: IdentityChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure never breaks the change itself.
      }
    }
  }

  /**
   * Resolve who is calling: a session cookie first, then the owner token,
   * then local mode (no users, no owner token). undefined: not signed in.
   */
  async authenticate(input: { sessionToken?: string; bearerToken?: string; ip?: string }): Promise<Authenticated | undefined> {
    if (input.sessionToken) {
      const signedIn = await this.resolveSession(input.sessionToken, input.ip);
      if (signedIn) return signedIn;
    }
    if (this.ownerToken && input.bearerToken !== undefined && tokensMatch(this.ownerToken, input.bearerToken)) {
      return { principal: ownerPrincipal(this.orgId, "token") };
    }
    if ((await this.mode()) === "local") return { principal: ownerPrincipal(this.orgId, "local") };
    return undefined;
  }

  /** Session cookie → user principal (sliding expiry, then the extensions' session rules). */
  async resolveSession(token: string, ip?: string): Promise<Authenticated | undefined> {
    const session = await this.store.identity.sessions.getByTokenHash(hashToken(token));
    const now = this.now();
    if (!session || session.orgId !== this.orgId) return undefined;
    if (session.expiresAt <= now) {
      await this.store.identity.sessions.remove(session.id);
      return undefined;
    }
    const user = await this.store.identity.users.get(this.orgId, session.userId);
    if (!user || user.disabledAt !== undefined) return undefined;
    const check = await this.checkSession(session, ip);
    if (check.refused) {
      if (check.refused.end) await this.endSession(session);
      return undefined;
    }
    if (now - session.lastSeenAt > check.touchEveryMs) await this.touchSession(session, now);
    return { principal: await this.principalFor(user), session, user };
  }

  private async touchSession(session: SessionRecord, now: number): Promise<void> {
    session.lastSeenAt = now;
    session.expiresAt = now + SESSION_TTL_MS;
    await this.store.identity.sessions.touch(session.id, session.lastSeenAt, session.expiresAt);
    // "Last active" in Admin → Users (as often as the session is touched: hourly by default).
    await this.store.identity.users.touch(this.orgId, session.userId, now);
  }

  private async endSession(session: SessionRecord): Promise<void> {
    await this.store.identity.sessions.remove(session.id);
    this.emit({ kind: "session", sessionId: session.id, userId: session.userId });
  }

  /**
   * A live connection did something (a WebSocket message): keep its session
   * from going idle. Written only as often as the session rules ask.
   */
  async noteActivity(current: Authenticated): Promise<void> {
    if (!current.session || this.extensions().length === 0) return;
    const now = this.now();
    if (now - current.session.lastSeenAt < 10_000) return;
    const session = await this.store.identity.sessions.getByTokenHash(current.session.tokenHash);
    if (!session) return;
    const check = await this.checkSession(session, undefined);
    if (check.refused) return;
    if (now - session.lastSeenAt > check.touchEveryMs) await this.touchSession(session, now);
    current.session.lastSeenAt = session.lastSeenAt;
  }

  /** End every session of a user (the directory turned them off). */
  async endSessions(userId: string): Promise<void> {
    await this.store.identity.sessions.removeForUser(userId);
    this.emit({ kind: "session", userId });
  }

  /**
   * External sign-in (SSO): the provider established who this is; run the
   * sign-in rules and create the session — the same session code as a
   * password sign-in.
   */
  async signInExternal(userId: string, method: Exclude<SignInMethod, "password">, ip: string): Promise<{ user: UserRecord; token: string }> {
    const user = await this.store.identity.users.get(this.orgId, userId);
    if (!user || user.disabledAt !== undefined) throw new IdentityError(403, "account_disabled", "This account is turned off. Ask an admin.");
    await this.checkSignIn({ userId: user.id, email: user.email, method, ip });
    this.hasUsers = true;
    this.options.log?.("identity.sign_in", { userId: user.id, method });
    return { user, token: await this.createSession(user) };
  }

  /** Re-check a principal (memberships changed, session revoked); undefined: no longer allowed in. */
  async refresh(current: Authenticated): Promise<Authenticated | undefined> {
    if (current.principal.kind !== "user") {
      // Local mode ends when the first user is created: the browser must sign in.
      if (current.principal.kind === "local" && (await this.mode()) !== "local") return undefined;
      return current;
    }
    if (current.session) {
      const session = await this.store.identity.sessions.getByTokenHash(current.session.tokenHash);
      if (!session || session.expiresAt <= this.now()) return undefined;
      // Session rules (lifetime, idle timeout) end live connections too.
      const check = await this.checkSession(session, undefined);
      if (check.refused) {
        if (check.refused.end) await this.endSession(session);
        return undefined;
      }
    }
    const user = await this.store.identity.users.get(this.orgId, current.principal.userId!);
    if (!user || user.disabledAt !== undefined) return undefined;
    return { ...current, user, principal: await this.principalFor(user) };
  }

  async principalFor(user: UserRecord): Promise<Principal> {
    const memberships = await this.store.identity.memberships.listForUser(this.orgId, user.id);
    const workspaceRoles: Record<string, Role> = {};
    let orgRole: Role | undefined;
    for (const membership of memberships) {
      if (membership.scope === "org") orgRole = membership.role;
      else workspaceRoles[membership.scope.workspaceId] = membership.role;
    }
    return {
      kind: "user",
      orgId: this.orgId,
      userId: user.id,
      email: user.email,
      name: user.name,
      ...(orgRole ? { orgRole } : {}),
      workspaceRoles
    };
  }

  /* ───────────── setup, login, logout ───────────── */

  /** Create the first (owner) account. Allowed only while there are no users. */
  async setup(input: { email: unknown; name: unknown; password: unknown }, caller: { ownerTokenOk: boolean }): Promise<{ user: UserRecord; token: string }> {
    // Serialize: two concurrent setups must not both see zero users.
    const run = (this.setupInFlight ?? Promise.resolve()).catch(() => undefined).then(() => this.setupNow(input, caller));
    this.setupInFlight = run;
    return run;
  }

  private async setupNow(input: { email: unknown; name: unknown; password: unknown }, caller: { ownerTokenOk: boolean }) {
    if (this.options.hosted) throw new IdentityError(404, "not_available", "Create an organization at sign-up instead.");
    const mode = await this.mode();
    if (mode === "signin") throw new IdentityError(409, "already_set_up", "This Sibyl already has an owner. Sign in instead.");
    if (mode === "setup" && !caller.ownerTokenOk) {
      throw new IdentityError(401, "owner_token_required", "Enter the owner token (SIBYL_OWNER_TOKEN) to create the owner account.");
    }
    const { email, name, password } = this.validateAccount(input);
    return this.addOwner({ email, name, passwordHash: await hashPassword(password) });
  }

  /**
   * Hosted sign-up: the new organization's first owner and its first
   * workspace, signed in. The address was verified by the sign-up layer;
   * without a password the person signs in by link or Google/Microsoft.
   */
  async createOwner(input: {
    email: unknown;
    name: unknown;
    password?: unknown;
    passwordHash?: string;
    workspaceName?: string;
    emailVerifiedAt: number;
    /** The Google / Microsoft account they signed up with. */
    link?: Omit<ExternalLogin, "linkedAt">;
  }): Promise<{ user: UserRecord; token: string }> {
    if ((await this.store.identity.users.count(this.orgId)) > 0) throw new IdentityError(409, "already_set_up", "This organization already has an owner.");
    const hasPassword = input.password !== undefined && input.password !== null && input.password !== "";
    // No password: sign in by link or Google/Microsoft ("none" never matches a password). A signed-in person's new organization keeps their password.
    const { email, name } = this.validateAccount({ ...input, password: hasPassword ? input.password : "placeholder-not-used" });
    const passwordHash = hasPassword ? await hashPassword(input.password as string) : (input.passwordHash ?? "none");
    return this.addOwner({
      email,
      name,
      passwordHash,
      emailVerifiedAt: input.emailVerifiedAt,
      ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
      ...(input.link ? { links: [{ ...input.link, linkedAt: this.now() }] } : {})
    });
  }

  private async addOwner(input: { email: string; name: string; passwordHash: string; emailVerifiedAt?: number; workspaceName?: string; links?: ExternalLogin[] }): Promise<{ user: UserRecord; token: string }> {
    const user: UserRecord = {
      id: this.createId(),
      orgId: this.orgId,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      createdAt: this.now(),
      ...(input.emailVerifiedAt !== undefined ? { emailVerifiedAt: input.emailVerifiedAt } : {}),
      ...(input.links ? { links: input.links } : {})
    };
    await this.store.identity.users.upsert(user);
    this.hasUsers = true;
    await this.store.identity.memberships.upsert(this.orgId, { userId: user.id, scope: "org", role: "owner" });
    const workspace = await this.ensureDefaultWorkspace();
    const workspaceName = input.workspaceName?.replace(/\s+/g, " ").trim().slice(0, 80);
    if (workspaceName && workspaceName !== workspace.name) await this.store.workspaces.upsert({ ...workspace, name: workspaceName, updatedAt: this.now() });
    await this.store.identity.memberships.upsert(this.orgId, { userId: user.id, scope: { workspaceId: DEFAULT_WORKSPACE_ID }, role: "owner" });
    this.options.log?.("identity.setup", { userId: user.id });
    this.audit({ action: AUDIT_ACTIONS.OWNER_CREATED, actor: userActor(user), target: { kind: "user", id: user.id, name: user.email } });
    this.emit({ kind: "user", userId: user.id });
    return { user, token: await this.createSession(user) };
  }

  async login(input: { email: unknown; password: unknown }, ip: string): Promise<SignInResult> {
    const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
    const password = typeof input.password === "string" ? input.password : "";
    const wait = this.limiter.retryAfter(ip, email);
    if (wait > 0) {
      throw new IdentityError(429, "rate_limited", `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.`, wait);
    }
    const user = email ? await this.store.identity.users.getByEmail(this.orgId, email) : undefined;
    // Always run scrypt so an unknown email takes as long as a wrong password.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok || user.disabledAt !== undefined) {
      this.limiter.fail(ip, email);
      this.audit({
        action: AUDIT_ACTIONS.SIGN_IN_FAILED,
        outcome: "failure",
        actor: user ? userActor(user) : { kind: "user", ...(email ? { email } : {}) },
        ip,
        details: { reason: !user ? "unknown_email" : user.disabledAt !== undefined ? "disabled" : "wrong_password" }
      });
      throw new IdentityError(401, "invalid_credentials", "That email and password don't match.");
    }
    this.limiter.succeed(ip, email);
    return this.finishPasswordSignIn(user, ip);
  }

  /** Password accepted: the sign-in rules, then a session or a two-step challenge. */
  private async finishPasswordSignIn(user: UserRecord, ip: string, workspaceId?: string): Promise<SignInResult> {
    const { requireMfa } = await this.checkSignIn({ userId: user.id, email: user.email, method: "password", ip });
    const enrolled = await this.mfa.enabled(user.id);
    if (!enrolled && !requireMfa) {
      this.options.log?.("identity.sign_in", { userId: user.id, method: "password" });
      this.audit({ action: AUDIT_ACTIONS.SIGN_IN, actor: userActor(user), ip, details: { method: "password" } });
      return { user, token: await this.createSession(user) };
    }
    let created: { challenge: string; enrollSecret?: string };
    try {
      created = this.mfa.createChallenge(user.id, { enroll: !enrolled, ...(workspaceId ? { workspaceId } : {}) });
    } catch (error) {
      if (error instanceof MfaUnavailableError) throw new IdentityError(503, "mfa_unavailable", error.message);
      throw error;
    }
    const secret = created.enrollSecret;
    return {
      user,
      mfa: {
        step: secret ? "enroll" : "verify",
        challenge: created.challenge,
        org: this.orgId,
        ...(secret ? { secret, otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: MFA_ISSUER }) } : {})
      }
    };
  }

  /** Second step of a password sign-in: a code from the authenticator app, or a recovery code. */
  async completeMfa(
    challenge: unknown,
    input: { code?: unknown; recoveryCode?: unknown },
    ip: string
  ): Promise<{ user: UserRecord; token: string; recoveryCodes?: string[]; workspaceId?: string }> {
    if (typeof challenge !== "string" || !challenge || challenge.length > 128) throw new IdentityError(400, "invalid_challenge", "Sign in again.");
    const code = typeof input.code === "string" ? input.code.slice(0, 16) : undefined;
    const recoveryCode = typeof input.recoveryCode === "string" ? input.recoveryCode.slice(0, 32) : undefined;
    if (!code && !recoveryCode) throw new IdentityError(400, "code_required", "Enter the 6-digit code from your authenticator app.");
    let result: Awaited<ReturnType<MfaService["completeChallenge"]>>;
    try {
      result = await this.mfa.completeChallenge(challenge, { ...(code ? { code } : {}), ...(recoveryCode ? { recoveryCode } : {}) });
    } catch (error) {
      if (error instanceof MfaUnavailableError) throw new IdentityError(503, "mfa_unavailable", error.message);
      throw new IdentityError(401, "challenge_expired", "This sign-in has expired. Enter your password again.");
    }
    if (!result) throw new IdentityError(401, "invalid_code", recoveryCode ? "That recovery code isn't valid." : "That code isn't right. Try the current one.");
    const user = await this.store.identity.users.get(this.orgId, result.pending.userId);
    if (!user || user.disabledAt !== undefined) throw new IdentityError(403, "account_disabled", "This account is turned off. Ask an admin.");
    // The rules may have changed since the password step (network, enforced SSO).
    await this.checkSignIn({ userId: user.id, email: user.email, method: "password", ip });
    this.options.log?.("identity.sign_in", { userId: user.id, method: "password", mfa: true });
    this.audit({ action: AUDIT_ACTIONS.SIGN_IN, actor: userActor(user), ip, details: { method: "password", mfa: true } });
    return {
      user,
      token: await this.createSession(user),
      ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
      ...(result.pending.workspaceId ? { workspaceId: result.pending.workspaceId } : {})
    };
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken) return;
    const session = await this.store.identity.sessions.getByTokenHash(hashToken(sessionToken));
    if (!session) return;
    await this.store.identity.sessions.remove(session.id);
    this.emit({ kind: "session", sessionId: session.id, userId: session.userId });
    this.audit({ action: AUDIT_ACTIONS.SIGN_OUT, actor: { kind: "user", userId: session.userId } });
  }

  private async createSession(user: UserRecord): Promise<string> {
    const token = randomToken();
    const now = this.now();
    await this.store.identity.sessions.create({
      id: this.createId(),
      tokenHash: hashToken(token),
      userId: user.id,
      orgId: this.orgId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: now
    });
    await this.store.identity.users.touch(this.orgId, user.id, now);
    // Opportunistic clean-up of expired sessions.
    void this.store.identity.sessions.prune(now).catch(() => undefined);
    return token;
  }

  private validateAccount(input: { email: unknown; name: unknown; password: unknown }): { email: string; name: string; password: string } {
    const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/.test(email) || email.length > 254) {
      throw new IdentityError(400, "invalid_email", "Enter a valid email address.");
    }
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const problem = passwordProblem(input.password);
    if (problem) throw new IdentityError(400, "weak_password", problem);
    return { email, name: name || email.split("@")[0]!, password: input.password as string };
  }

  /* ───────────── me ───────────── */

  private async hostedView(): Promise<Pick<AuthMeResponse, "hosted" | "organization">> {
    const [organization, settings] = await Promise.all([this.store.organizations.get(this.orgId), this.orgSettings()]);
    return { hosted: true, ...(organization ? { organization: { id: organization.id, name: settings.name || organization.name } } : {}) };
  }

  async me(auth: Authenticated | undefined): Promise<AuthMeResponse> {
    const mode = await this.mode();
    const hosted = this.options.hosted ? await this.hostedView() : {};
    if (!auth) {
      return {
        ...hosted,
        authenticated: false,
        mode,
        next: mode === "signin" ? "login" : "setup",
        setupAvailable: mode !== "signin",
        ownerTokenRequired: mode === "setup",
        smtp: Boolean(this.options.mailer),
        user: null,
        workspaces: [],
        permissions: {}
      };
    }
    const workspaces = await this.listWorkspaces(auth.principal);
    const permissions: Record<string, string[]> = {};
    for (const workspace of workspaces) permissions[workspace.id] = permissionsFor(auth.principal, workspace.id);
    return {
      authenticated: true,
      mode,
      // Owner-token browsers on a fresh install are sent to /setup to create the owner account.
      ...(mode === "setup" ? { next: "setup" as const } : {}),
      setupAvailable: mode !== "signin",
      ownerTokenRequired: mode === "setup",
      smtp: Boolean(this.options.mailer),
      principal: auth.principal.kind,
      user: auth.user ? userView(auth.user) : null,
      ...(auth.principal.orgRole ? { orgRole: auth.principal.orgRole } : {}),
      org: await this.orgSummary(),
      workspaces,
      permissions,
      ...hosted
    };
  }

  /* ───────────── organization ───────────── */

  /** Organization settings (Admin → Organization; see OrgAdmin in org.ts for changes). */
  orgSettings(): Promise<OrgSettings> {
    return readOrgSettings(this.store, this.orgId);
  }

  private async orgSummary(): Promise<OrgSummary> {
    const settings = await this.orgSettings();
    return { name: settings.name ?? "", defaultRole: settings.defaultRole };
  }

  /* ───────────── workspaces ───────────── */

  async ensureDefaultWorkspace(): Promise<WorkspaceRecord> {
    const existing = await this.store.workspaces.get(this.orgId, DEFAULT_WORKSPACE_ID);
    if (existing) return existing;
    const now = this.now();
    const record: WorkspaceRecord = { id: DEFAULT_WORKSPACE_ID, ownerId: this.orgId, name: DEFAULT_WORKSPACE_NAME, createdAt: now, updatedAt: now };
    await this.store.workspaces.upsert(record);
    return record;
  }

  /** Workspaces the principal can open, default first. */
  async listWorkspaces(principal: Principal): Promise<WorkspaceView[]> {
    await this.ensureDefaultWorkspace();
    const all = await this.store.workspaces.list(this.orgId);
    return all
      .filter((workspace) => canAccessWorkspace(principal, workspace.id))
      .sort((a, b) => (a.id === DEFAULT_WORKSPACE_ID ? -1 : b.id === DEFAULT_WORKSPACE_ID ? 1 : a.createdAt - b.createdAt))
      .map((workspace) => workspaceView(workspace, effectiveWorkspaceRole(principal, workspace.id)!));
  }

  async getWorkspace(principal: Principal, workspaceId: string): Promise<WorkspaceRecord> {
    if (workspaceId === DEFAULT_WORKSPACE_ID) await this.ensureDefaultWorkspace();
    const workspace = await this.store.workspaces.get(this.orgId, workspaceId);
    // Same answer for "doesn't exist" and "not yours": don't reveal other workspaces.
    if (!workspace || !canAccessWorkspace(principal, workspaceId)) throw new IdentityError(404, "workspace_not_found", "Workspace not found.");
    return workspace;
  }

  async createWorkspace(principal: Principal, input: { name: unknown; icon?: unknown; instructions?: unknown }): Promise<WorkspaceView> {
    // Creating a workspace is an organization decision (org Owner/Admin).
    if (!authorize(principal, PERMISSIONS.ORG_SETTINGS)) throw forbidden("Only organization owners and admins can create workspaces.");
    const name = workspaceName(input.name);
    const now = this.now();
    const record: WorkspaceRecord = {
      id: `ws_${this.createId().replace(/-/g, "").slice(0, 16)}`,
      ownerId: this.orgId,
      name,
      ...optionalText("icon", input.icon, 4),
      ...optionalText("instructions", input.instructions, 8000),
      createdAt: now,
      updatedAt: now
    };
    await this.store.workspaces.upsert(record);
    if (principal.kind === "user") {
      await this.store.identity.memberships.upsert(this.orgId, { userId: principal.userId!, scope: { workspaceId: record.id }, role: "owner" });
      this.emit({ kind: "memberships", userId: principal.userId });
    }
    this.audit({ action: AUDIT_ACTIONS.WORKSPACE_CREATED, actor: auditActor(principal), workspaceId: record.id, target: { kind: "workspace", id: record.id, name } });
    return workspaceView(record, "owner");
  }

  async updateWorkspace(
    principal: Principal,
    workspaceId: string,
    patch: { name?: unknown; icon?: unknown; instructions?: unknown; budget?: unknown }
  ): Promise<WorkspaceView> {
    const workspace = await this.getWorkspace(principal, workspaceId);
    const settingsChange = patch.name !== undefined || patch.icon !== undefined || patch.instructions !== undefined;
    if ((settingsChange || patch.budget === undefined) && !authorize(principal, PERMISSIONS.WORKSPACE_SETTINGS, { workspaceId })) {
      throw forbidden("Only workspace admins can change its settings.");
    }
    if (patch.budget !== undefined && !authorize(principal, PERMISSIONS.BUDGETS_MANAGE, { workspaceId })) throw forbidden("Only workspace admins can change its budget.");
    const next: WorkspaceRecord = { ...workspace, updatedAt: this.now() };
    if (patch.budget !== undefined) {
      const budget = applyBudgetPatch(workspace.budget, patch.budget);
      if (budget) next.budget = budget;
      else delete next.budget;
    }
    if (patch.name !== undefined) next.name = workspaceName(patch.name);
    if (patch.icon !== undefined) {
      const icon = typeof patch.icon === "string" ? patch.icon.trim().slice(0, 4) : "";
      if (icon) next.icon = icon;
      else delete next.icon;
    }
    if (patch.instructions !== undefined) {
      if (typeof patch.instructions !== "string") throw new IdentityError(400, "invalid_instructions", "Instructions must be text.");
      const instructions = patch.instructions.trim().slice(0, 8000);
      if (instructions) next.instructions = instructions;
      else delete next.instructions;
    }
    await this.store.workspaces.upsert(next);
    // The usage meter enforces workspace budgets: give it the new caps before answering.
    if (patch.budget !== undefined) await this.options.onBudgetsChanged?.();
    // Renames and icon changes show up in everyone's workspace switcher.
    if (next.name !== workspace.name || next.icon !== workspace.icon) this.emit({ kind: "org" });
    this.audit({
      action: AUDIT_ACTIONS.WORKSPACE_UPDATED,
      actor: auditActor(principal),
      workspaceId,
      target: { kind: "workspace", id: workspaceId, name: next.name },
      details: {
        fields: Object.keys(patch).filter((key) => ["name", "icon", "instructions", "budget"].includes(key)),
        ...(patch.budget !== undefined ? { dailyUsd: next.budget?.dailyUsd ?? null, monthlyUsd: next.budget?.monthlyUsd ?? null } : {})
      }
    });
    return workspaceView(next, effectiveWorkspaceRole(principal, workspaceId)!);
  }

  async deleteWorkspace(principal: Principal, workspaceId: string): Promise<void> {
    if (workspaceId === DEFAULT_WORKSPACE_ID) throw new IdentityError(409, "default_workspace", "The default workspace can't be deleted.");
    await this.getWorkspace(principal, workspaceId);
    if (effectiveWorkspaceRole(principal, workspaceId) !== "owner") throw forbidden("Only a workspace owner can delete it.");
    await this.store.workspaces.remove(this.orgId, workspaceId);
    await this.store.identity.memberships.removeScope(this.orgId, { workspaceId });
    for (const invite of await this.store.identity.invites.list(this.orgId, { workspaceId })) {
      await this.store.identity.invites.remove(this.orgId, invite.id);
    }
    this.emit({ kind: "memberships" });
    this.audit({ action: AUDIT_ACTIONS.WORKSPACE_DELETED, actor: auditActor(principal), workspaceId, target: { kind: "workspace", id: workspaceId } });
  }

  /* ───────────── members ───────────── */

  async listMembers(principal: Principal, workspaceId: string): Promise<MemberView[]> {
    await this.getWorkspace(principal, workspaceId);
    const users = new Map((await this.store.identity.users.list(this.orgId)).map((user) => [user.id, user]));
    const orgRoles = new Map(
      (await this.store.identity.memberships.listForScope(this.orgId, "org")).map((m) => [m.userId, m.role] as const)
    );
    const wsRoles = new Map(
      (await this.store.identity.memberships.listForScope(this.orgId, { workspaceId })).map((m) => [m.userId, m.role] as const)
    );
    const members: MemberView[] = [];
    for (const user of users.values()) {
      if (user.disabledAt !== undefined) continue;
      const orgRole = orgRoles.get(user.id);
      const workspaceRole = wsRoles.get(user.id);
      const fromOrg = orgRole === "owner" || orgRole === "admin" ? orgRole : undefined;
      const role = higher(fromOrg, workspaceRole);
      if (!role) continue;
      members.push({
        userId: user.id,
        name: user.name,
        email: user.email,
        role,
        ...(workspaceRole ? { workspaceRole } : {}),
        ...(orgRole ? { orgRole } : {}),
        inherited: !workspaceRole || (fromOrg !== undefined && roleRank(fromOrg) > roleRank(workspaceRole)),
        ...(principal.userId === user.id ? { you: true } : {})
      });
    }
    return members.sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.name.localeCompare(b.name));
  }

  async setMemberRole(principal: Principal, workspaceId: string, userId: string, role: unknown): Promise<MemberView[]> {
    if (!isRole(role)) throw new IdentityError(400, "invalid_role", "Choose owner, admin, member or viewer.");
    await this.getWorkspace(principal, workspaceId);
    if (!authorize(principal, PERMISSIONS.MEMBERS_MANAGE, { workspaceId })) throw forbidden("Only workspace admins can change roles.");
    const target = await this.activeUser(userId);
    const actorRole = effectiveWorkspaceRole(principal, workspaceId)!;
    const current = (await this.store.identity.memberships.listForScope(this.orgId, { workspaceId })).find((m) => m.userId === userId);
    // Nobody grants more than they have, or changes someone above them.
    if (roleRank(role) > roleRank(actorRole)) throw forbidden(`You can't give a role above your own (${actorRole}).`);
    if (current && roleRank(current.role) > roleRank(actorRole)) throw forbidden("You can't change the role of someone above you.");
    if (current?.role === "owner" && role !== "owner") await this.assertAnotherOwner(workspaceId, target.id);
    await this.store.identity.memberships.upsert(this.orgId, { userId: target.id, scope: { workspaceId }, role });
    this.emit({ kind: "memberships", userId: target.id });
    this.audit({
      action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
      actor: auditActor(principal),
      workspaceId,
      target: { kind: "user", id: target.id, name: target.email },
      details: { from: current?.role ?? null, to: role }
    });
    return this.listMembers(principal, workspaceId);
  }

  async removeMember(principal: Principal, workspaceId: string, userId: string): Promise<void> {
    await this.getWorkspace(principal, workspaceId);
    const self = principal.userId === userId;
    if (!self && !authorize(principal, PERMISSIONS.MEMBERS_MANAGE, { workspaceId })) throw forbidden("Only workspace admins can remove members.");
    const current = (await this.store.identity.memberships.listForScope(this.orgId, { workspaceId })).find((m) => m.userId === userId);
    if (!current) {
      const user = await this.store.identity.users.get(this.orgId, userId);
      const orgRole = user ? (await this.store.identity.memberships.listForUser(this.orgId, userId)).find((m) => m.scope === "org")?.role : undefined;
      if (orgRole === "owner" || orgRole === "admin") {
        throw new IdentityError(409, "org_member", "This person is an organization admin and has access to every workspace.");
      }
      throw new IdentityError(404, "member_not_found", "That person isn't a member of this workspace.");
    }
    if (!self && roleRank(current.role) > roleRank(effectiveWorkspaceRole(principal, workspaceId)!)) {
      throw forbidden("You can't remove someone above you.");
    }
    if (current.role === "owner") await this.assertAnotherOwner(workspaceId, userId);
    await this.store.identity.memberships.remove(this.orgId, userId, { workspaceId });
    this.emit({ kind: "memberships", userId });
    this.audit({ action: AUDIT_ACTIONS.MEMBER_REMOVED, actor: auditActor(principal), workspaceId, target: { kind: "user", id: userId }, details: { role: current.role, left: self } });
  }

  /** The workspace must keep an owner other than `userId` (explicit, or an org owner). */
  private async assertAnotherOwner(workspaceId: string, userId: string): Promise<void> {
    const active = new Set((await this.store.identity.users.list(this.orgId)).filter((u) => u.disabledAt === undefined).map((u) => u.id));
    const owners = [
      ...(await this.store.identity.memberships.listForScope(this.orgId, { workspaceId })),
      ...(await this.store.identity.memberships.listForScope(this.orgId, "org"))
    ].filter((m: MembershipRecord) => m.role === "owner" && m.userId !== userId && active.has(m.userId));
    if (owners.length === 0) {
      throw new IdentityError(409, "last_owner", "Every workspace needs an owner. Make someone else an owner first.");
    }
  }

  private async activeUser(userId: string): Promise<UserRecord> {
    const user = await this.store.identity.users.get(this.orgId, userId);
    if (!user || user.disabledAt !== undefined) throw new IdentityError(404, "member_not_found", "That person isn't in this organization.");
    return user;
  }

  /* ───────────── invitations ───────────── */

  async createInvite(
    principal: Principal,
    input: { workspaceId: unknown; role: unknown; email?: unknown },
    appUrl: string
  ): Promise<{ invite: InviteView; url: string; emailed: boolean }> {
    const workspaceId = typeof input.workspaceId === "string" && input.workspaceId ? input.workspaceId : DEFAULT_WORKSPACE_ID;
    const workspace = await this.getWorkspace(principal, workspaceId);
    if (!authorize(principal, PERMISSIONS.MEMBERS_INVITE, { workspaceId })) throw forbidden("Only workspace admins can invite people.");
    const role = input.role === undefined ? "member" : input.role;
    if (!isRole(role)) throw new IdentityError(400, "invalid_role", "Choose owner, admin, member or viewer.");
    if (roleRank(role) > roleRank(effectiveWorkspaceRole(principal, workspaceId)!)) throw forbidden("You can't invite someone above your own role.");
    let email: string | undefined;
    if (input.email !== undefined && input.email !== null && input.email !== "") {
      email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new IdentityError(400, "invalid_email", "Enter a valid email address.");
    }
    const { record, url, emailed } = await this.issueInvite(principal, { workspaceId, workspaceName: workspace.name, role, ...(email ? { email } : {}) }, appUrl);
    this.audit({
      action: AUDIT_ACTIONS.INVITE_CREATED,
      actor: auditActor(principal),
      workspaceId,
      target: { kind: "invite", id: record.id, ...(email ? { name: email } : {}) },
      details: { role, emailed }
    });
    return { invite: await this.inviteView(record), url, emailed };
  }

  /** Store a new invitation (fresh one-time token) and email it when there is an address and a mailer. */
  private async issueInvite(
    principal: Principal,
    input: { workspaceId: string; workspaceName: string; role: Role; email?: string },
    appUrl: string
  ): Promise<{ record: InviteRecord; url: string; emailed: boolean }> {
    const token = randomToken();
    const now = this.now();
    const record: InviteRecord = {
      id: this.createId(),
      orgId: this.orgId,
      tokenHash: hashToken(token),
      ...(input.email ? { email: input.email } : {}),
      workspaceId: input.workspaceId,
      role: input.role,
      invitedBy: principal.userId ?? principal.kind,
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS
    };
    await this.store.identity.invites.create(record);
    const url = `${appUrl.replace(/\/+$/, "")}/invite/${token}`;
    let emailed = false;
    if (input.email && this.options.mailer) {
      try {
        const orgName = (await this.orgSettings()).name;
        await this.options.mailer.sendInvite({
          to: input.email,
          inviterName: principal.name ?? "The owner",
          workspaceName: input.workspaceName,
          ...(orgName ? { orgName } : {}),
          role: input.role,
          url,
          expiresAt: record.expiresAt
        });
        emailed = true;
      } catch (error) {
        this.options.log?.("identity.invite_email_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { record, url, emailed };
  }

  /**
   * Send a pending invitation again: the old link stops working and a new
   * one (with a fresh 7-day expiry) replaces it, emailed when possible.
   */
  async resendInvite(principal: Principal, inviteId: string, appUrl: string): Promise<{ invite: InviteView; url: string; emailed: boolean }> {
    const invite = await this.store.identity.invites.get(this.orgId, inviteId);
    if (!invite || invite.acceptedAt !== undefined || !canAccessWorkspace(principal, invite.workspaceId)) {
      throw new IdentityError(404, "invite_not_found", "Invitation not found.");
    }
    if (!authorize(principal, PERMISSIONS.MEMBERS_INVITE, { workspaceId: invite.workspaceId })) throw forbidden();
    if (roleRank(invite.role) > roleRank(effectiveWorkspaceRole(principal, invite.workspaceId)!)) throw forbidden("You can't invite someone above your own role.");
    const workspace = await this.store.workspaces.get(this.orgId, invite.workspaceId);
    if (!workspace) throw new IdentityError(410, "workspace_gone", "The workspace in this invitation no longer exists.");
    const issued = await this.issueInvite(
      principal,
      { workspaceId: invite.workspaceId, workspaceName: workspace.name, role: invite.role, ...(invite.email ? { email: invite.email } : {}) },
      appUrl
    );
    await this.store.identity.invites.remove(this.orgId, invite.id);
    this.audit({
      action: AUDIT_ACTIONS.INVITE_RESENT,
      actor: auditActor(principal),
      workspaceId: invite.workspaceId,
      target: { kind: "invite", id: issued.record.id, ...(invite.email ? { name: invite.email } : {}) },
      details: { replaces: invite.id, role: invite.role, emailed: issued.emailed }
    });
    return { invite: await this.inviteView(issued.record), url: issued.url, emailed: issued.emailed };
  }

  /** Pending invitations in every workspace (Admin → Users; the caller needs org.settings). */
  async listAllInvites(principal: Principal): Promise<Array<InviteView & { workspaceName: string }>> {
    if (!authorize(principal, PERMISSIONS.ORG_SETTINGS)) throw forbidden();
    const names = new Map((await this.store.workspaces.list(this.orgId)).map((w) => [w.id, w.name] as const));
    const invites = await this.store.identity.invites.list(this.orgId, { pendingAt: this.now() });
    return Promise.all(
      invites.map(async (invite) => ({ ...(await this.inviteView(invite)), workspaceName: names.get(invite.workspaceId) ?? DEFAULT_WORKSPACE_NAME }))
    );
  }

  async listInvites(principal: Principal, workspaceId: string): Promise<InviteView[]> {
    await this.getWorkspace(principal, workspaceId);
    if (!authorize(principal, PERMISSIONS.MEMBERS_INVITE, { workspaceId })) throw forbidden();
    const invites = await this.store.identity.invites.list(this.orgId, { workspaceId, pendingAt: this.now() });
    return Promise.all(invites.map((invite) => this.inviteView(invite)));
  }

  async revokeInvite(principal: Principal, inviteId: string): Promise<void> {
    const invite = await this.store.identity.invites.get(this.orgId, inviteId);
    if (!invite || !canAccessWorkspace(principal, invite.workspaceId)) throw new IdentityError(404, "invite_not_found", "Invitation not found.");
    if (!authorize(principal, PERMISSIONS.MEMBERS_INVITE, { workspaceId: invite.workspaceId })) throw forbidden();
    await this.store.identity.invites.remove(this.orgId, inviteId);
    this.audit({ action: AUDIT_ACTIONS.INVITE_REVOKED, actor: auditActor(principal), workspaceId: invite.workspaceId, target: { kind: "invite", id: inviteId, ...(invite.email ? { name: invite.email } : {}) } });
  }

  async previewInvite(token: string): Promise<InvitePreview> {
    const invite = await this.findInvite(token);
    const workspace = await this.store.workspaces.get(this.orgId, invite.workspaceId);
    const inviter = await this.store.identity.users.get(this.orgId, invite.invitedBy);
    return {
      workspaceName: workspace?.name ?? DEFAULT_WORKSPACE_NAME,
      role: invite.role,
      ...(invite.email ? { email: invite.email } : {}),
      invitedByName: inviter?.name ?? "The owner",
      expiresAt: invite.expiresAt,
      status: invite.acceptedAt !== undefined ? "accepted" : invite.expiresAt <= this.now() ? "expired" : "pending",
      accountExists: invite.email ? Boolean(await this.store.identity.users.getByEmail(this.orgId, invite.email)) : false
    };
  }

  /**
   * Accept an invitation. With a signed-in user (and no new account
   * details) the workspace is added to that account; otherwise a new
   * account is created from name/email/password.
   */
  async acceptInvite(
    token: string,
    input: { name?: unknown; email?: unknown; password?: unknown },
    signedIn: Authenticated | undefined,
    ip = "unknown"
  ): Promise<{ user: UserRecord; token?: string; mfa?: MfaChallenge; workspaceId: string }> {
    const invite = await this.findInvite(token);
    if (invite.acceptedAt !== undefined) throw new IdentityError(410, "invite_used", "This invitation was already used.");
    if (invite.expiresAt <= this.now()) throw new IdentityError(410, "invite_expired", "This invitation has expired. Ask for a new one.");
    if (!(await this.store.workspaces.get(this.orgId, invite.workspaceId))) {
      throw new IdentityError(410, "workspace_gone", "The workspace in this invitation no longer exists.");
    }

    let user: UserRecord;
    let sessionToken: string | undefined;
    const existingUser = signedIn?.user && input.password === undefined ? signedIn.user : undefined;
    if (existingUser) {
      if (invite.email && invite.email !== existingUser.email) {
        throw new IdentityError(403, "wrong_account", `This invitation is for ${invite.email}. Sign in with that account.`);
      }
      user = existingUser;
    } else {
      const account = this.validateAccount({ email: input.email === undefined || input.email === "" ? invite.email : input.email, name: input.name, password: input.password });
      if (invite.email && account.email !== invite.email) throw new IdentityError(400, "wrong_email", `This invitation is for ${invite.email}.`);
      const existing = await this.store.identity.users.getByEmail(this.orgId, account.email);
      // Someone removed from the organization comes back as a fresh account (same id, nothing of the old access).
      if (existing && existing.removedAt === undefined) {
        throw new IdentityError(409, "account_exists", "An account with this email exists. Sign in, then open the invitation again.");
      }
      // A new password account obeys the sign-in rules too (enforced SSO, allowed networks).
      await this.checkSignIn({ userId: "", email: account.email, method: "password", ip });
      user = {
        id: existing?.id ?? this.createId(),
        orgId: this.orgId,
        email: account.email,
        name: account.name,
        passwordHash: await hashPassword(account.password),
        createdAt: this.now()
      };
      if (existing) await this.mfa.disable(existing.id);
      try {
        await this.store.identity.users.upsert(user);
      } catch (error) {
        if (error instanceof DuplicateEmailError) throw new IdentityError(409, "account_exists", error.message);
        throw error;
      }
      this.hasUsers = true;
      await this.store.identity.memberships.upsert(this.orgId, { userId: user.id, scope: "org", role: "member" });
    }
    // One-time: claim the invite before granting anything.
    const claimed = await this.store.identity.invites.accept(this.orgId, invite.id, user.id, this.now());
    if (!claimed) throw new IdentityError(410, "invite_used", "This invitation was already used.");
    const scope = { workspaceId: invite.workspaceId };
    const current = (await this.store.identity.memberships.listForUser(this.orgId, user.id)).find(
      (m) => m.scope !== "org" && m.scope.workspaceId === invite.workspaceId
    );
    // Never downgrade an existing membership.
    if (!current || roleRank(invite.role) > roleRank(current.role)) {
      await this.store.identity.memberships.upsert(this.orgId, { userId: user.id, scope, role: invite.role });
    }
    // New people also join the organization's default workspace (Admin → Organization).
    if (!existingUser) await this.joinDefaultWorkspace(user.id, invite.workspaceId);
    let mfa: MfaChallenge | undefined;
    if (!existingUser) {
      const signIn = await this.finishPasswordSignIn(user, ip, invite.workspaceId);
      if ("token" in signIn) sessionToken = signIn.token;
      else mfa = signIn.mfa;
    }
    this.emit({ kind: "memberships", userId: user.id });
    const workspace = await this.store.workspaces.get(this.orgId, invite.workspaceId);
    this.audit({
      action: AUDIT_ACTIONS.INVITE_ACCEPTED,
      actor: userActor(user),
      workspaceId: invite.workspaceId,
      target: { kind: "invite", id: invite.id },
      details: { role: invite.role, newAccount: !existingUser }
    });
    this.options.onInviteAccepted?.({ invite, user, workspaceName: workspace?.name ?? DEFAULT_WORKSPACE_NAME });
    return { user, ...(sessionToken ? { token: sessionToken } : {}), ...(mfa ? { mfa } : {}), workspaceId: invite.workspaceId };
  }

  private async joinDefaultWorkspace(userId: string, invitedTo: string): Promise<void> {
    const { defaultWorkspaceId, defaultRole } = await this.orgSettings();
    if (!defaultWorkspaceId || defaultWorkspaceId === invitedTo) return;
    if (!(await this.store.workspaces.get(this.orgId, defaultWorkspaceId))) return;
    const scope = { workspaceId: defaultWorkspaceId };
    const has = (await this.store.identity.memberships.listForUser(this.orgId, userId)).some((m) => m.scope !== "org" && m.scope.workspaceId === defaultWorkspaceId);
    if (!has) await this.store.identity.memberships.upsert(this.orgId, { userId, scope, role: defaultRole });
  }

  private async findInvite(token: string): Promise<InviteRecord> {
    const invite = token && token.length <= 128 ? await this.store.identity.invites.getByTokenHash(hashToken(token)) : undefined;
    if (!invite || invite.orgId !== this.orgId) throw new IdentityError(404, "invite_not_found", "This invitation link isn't valid.");
    return invite;
  }

  private async inviteView(invite: InviteRecord): Promise<InviteView> {
    const inviter = await this.store.identity.users.get(this.orgId, invite.invitedBy);
    return {
      id: invite.id,
      ...(invite.email ? { email: invite.email } : {}),
      workspaceId: invite.workspaceId,
      role: invite.role,
      invitedByName: inviter?.name ?? "Owner token",
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt
    };
  }
}

function higher(a: Role | undefined, b: Role | undefined): Role | undefined {
  if (!a) return b;
  if (!b) return a;
  return roleRank(a) >= roleRank(b) ? a : b;
}

/** Audit actor for a user record (sign-ins, invitations accepted). */
function userActor(user: UserRecord): AuditActor {
  return { kind: "user", userId: user.id, email: user.email, name: user.name };
}

export function userView(user: UserRecord): IdentityUserView {
  return { id: user.id, name: user.name, email: user.email, ...(user.avatar ? { avatar: user.avatar } : {}) };
}

function workspaceView(workspace: WorkspaceRecord, role: Role): WorkspaceView {
  return {
    id: workspace.id,
    name: workspace.name,
    ...(workspace.icon ? { icon: workspace.icon } : {}),
    ...(workspace.instructions ? { instructions: workspace.instructions } : {}),
    ...(workspace.budget ? { budget: { ...workspace.budget } } : {}),
    role,
    isDefault: workspace.id === DEFAULT_WORKSPACE_ID,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt
  };
}

function workspaceName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new IdentityError(400, "invalid_name", "Give the workspace a name.");
  return name.slice(0, 60);
}

function optionalText<K extends string>(key: K, value: unknown, max: number): Partial<Record<K, string>> {
  if (typeof value !== "string" || !value.trim()) return {};
  return { [key]: value.trim().slice(0, max) } as Partial<Record<K, string>>;
}
