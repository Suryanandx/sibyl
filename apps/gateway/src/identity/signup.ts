/**
 * Sign-up and the sign-in methods beyond a password: emailed links, emailed
 * codes, and "Continue with Google / Microsoft" (OpenID Connect).
 *
 * The sign-up layer answers before any organization exists, so it works on
 * the shared store: pending codes and links live under the `_signup` store
 * owner; accounts are found by email across organizations
 * (`users.listByEmail`; self-hosted has only one organization).
 *
 * After an address is verified:
 * - one account with it → that account is signed in (its organization's
 *   identity service creates the session, with its sign-in rules);
 * - several (hosted: one person in several organizations) → the browser
 *   chooses one (a short-lived choice bound by a cookie);
 * - none → hosted: a sign-up ticket (signup-tickets.ts) to create an
 *   organization; self-hosted: refused (people join by invitation).
 *
 * Verification:
 * - Password sign-up: a 6-digit code to the address. Only an HMAC of the
 *   code is stored (keyed from the secrets master key), it expires after 15
 *   minutes and dies after 5 wrong tries; a new code replaces the old.
 * - Magic link: a random token (only its SHA-256 is stored), 15 minutes,
 *   one use. The link opens the web app, which redeems it with a POST, so a
 *   mail scanner fetching the link doesn't use it up.
 * - Google / Microsoft: authorization code + PKCE through the platform's
 *   sign-in apps (SIBYL_SIGNIN_GOOGLE_* / SIBYL_SIGNIN_MICROSOFT_*; separate
 *   from the Google / Microsoft connectors' apps), the ID token verified by
 *   oidc.ts. The provider must vouch for the email address. A linked
 *   account (by the provider's subject) is found first; an account found by
 *   email gets linked.
 *
 * Bot protection without CAPTCHAs: sends are limited per address and per IP
 * (5 and 20 an hour), code and link checks per IP + address (10 per 15
 * minutes) and per IP (50); unknown and known addresses get the same answer.
 */
import { createHash, createHmac, hkdfSync, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { normalizeEmail, type EmailMessage, type ExternalLogin, type SignupTicket, type Store, type UserRecord } from "@open-gpt-live/core";
import type { SignupEmailSent, SignupOptionsView, SignupProvider, SignupTicketView } from "@open-gpt-live/protocol";
import { signInLinkEmail, signUpCodeEmail, signUpLinkEmail } from "../email/templates.js";
import type { Mailer } from "../notifications/mailer.js";
import { hashPassword, hashToken, passwordProblem, randomToken } from "./crypto.js";
import { OidcClients, browserBindingMatches, newBrowserBinding, safeNext, type OidcClientSettings, type OidcIdentity } from "./oidc.js";
import { LoginRateLimiter } from "./rate-limit.js";
import { IdentityError, type IdentityService } from "./service.js";
import { SIGNUP_OWNER, type SignupTickets } from "./signup-tickets.js";

export const CODE_TTL_MS = 15 * 60_000;
export const LINK_TTL_MS = 15 * 60_000;
const CODE_ATTEMPTS = 5;
const OAUTH_TTL_MS = 10 * 60_000;
const CHOICE_TTL_MS = 5 * 60_000;
const MAX_PENDING = 10_000;
/** Microsoft personal accounts (outlook.com, hotmail.com…): Microsoft owns and verifies these addresses. */
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

export type OAuthProvider = "google" | "microsoft";

/** The organization's identity service (hosted: the organization's runtime; self-hosted: the one). */
export type IdentityFor = (orgId: string) => Promise<IdentityService>;

/** Where a verified sign-up or sign-in goes next. */
export type SignupOutcome =
  | { kind: "ticket"; ticket: string; expiresAt: number; view: SignupTicketView }
  | { kind: "session"; token: string; orgId: string; path: string }
  | { kind: "choose"; choice: string; organizations: Array<{ id: string; name: string }> };

interface PendingCode {
  email: string;
  codeHash: string;
  passwordHash: string;
  name?: string;
  next: string;
  expiresAt: number;
  attempts: number;
}

interface PendingLink {
  email: string;
  name?: string;
  next: string;
  expiresAt: number;
}

interface PendingOAuth {
  provider: OAuthProvider;
  bindingHash: string;
  next: string;
  /** Accepting this invitation (/invite/<token>) with the provider. */
  invite?: string;
  checks: { state: string; nonce: string; verifier: string };
  expiresAt: number;
}

interface PendingChoice {
  accounts: Array<{ orgId: string; userId: string }>;
  method: Exclude<SignupProvider, "password"> | "password";
  next: string;
  expiresAt: number;
}

interface VerifiedIdentity {
  email: string;
  name?: string;
  provider: SignupProvider;
  subject?: string;
  passwordHash?: string;
}

/** The platform's Google / Microsoft sign-in apps from the environment (none: the button is hidden). */
export function signInApps(env: NodeJS.ProcessEnv): Partial<Record<OAuthProvider, OidcClientSettings & { clientSecret: string }>> {
  const apps: Partial<Record<OAuthProvider, OidcClientSettings & { clientSecret: string }>> = {};
  const read = (name: string) => env[name]?.trim() || undefined;
  const googleId = read("SIBYL_SIGNIN_GOOGLE_CLIENT_ID");
  const googleSecret = read("SIBYL_SIGNIN_GOOGLE_CLIENT_SECRET");
  if (googleId && googleSecret) {
    apps.google = { issuer: read("SIBYL_SIGNIN_GOOGLE_ISSUER") ?? "https://accounts.google.com", clientId: googleId, clientSecret: googleSecret, scopes: ["openid", "email", "profile"] };
  }
  const microsoftId = read("SIBYL_SIGNIN_MICROSOFT_CLIENT_ID");
  const microsoftSecret = read("SIBYL_SIGNIN_MICROSOFT_CLIENT_SECRET");
  if (microsoftId && microsoftSecret) {
    const tenant = read("SIBYL_SIGNIN_MICROSOFT_TENANT") ?? "common";
    apps.microsoft = {
      issuer: read("SIBYL_SIGNIN_MICROSOFT_ISSUER") ?? `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0`,
      clientId: microsoftId,
      clientSecret: microsoftSecret,
      scopes: ["openid", "email", "profile"]
    };
  }
  return apps;
}

export interface SignupServiceOptions {
  store: Store;
  env: NodeJS.ProcessEnv;
  /** SIBYL_MODE=hosted: unknown addresses may create an organization. */
  hosted: boolean;
  tickets: SignupTickets;
  /** Secret for code HMACs (the secrets master key). */
  masterKey: Buffer;
  mailer?: Mailer;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class SignupService {
  readonly tickets: SignupTickets;
  readonly hosted: boolean;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly codeKey: Buffer;
  private readonly apps: ReturnType<typeof signInApps>;
  private readonly oidc: OidcClients;
  private readonly oauth = new Map<string, PendingOAuth>();
  private readonly choices = new Map<string, PendingChoice>();
  /** Codes and links sent: 5 an hour per address, 20 per IP. */
  private readonly sends: LoginRateLimiter;
  /** Codes and links checked: 10 per 15 minutes per IP + address, 50 per IP. */
  private readonly checks: LoginRateLimiter;
  /** Google / Microsoft sign-ins started: 30 per 15 minutes per IP. */
  private readonly starts: LoginRateLimiter;

  constructor(private readonly options: SignupServiceOptions) {
    this.store = options.store;
    this.hosted = options.hosted;
    this.tickets = options.tickets;
    this.now = options.now ?? Date.now;
    this.codeKey = Buffer.from(hkdfSync("sha256", options.masterKey, Buffer.from("sibyl.signup-code.v1", "utf8"), Buffer.alloc(0), 32));
    this.apps = signInApps(options.env);
    this.oidc = new OidcClients({ allowPrivateNetwork: /^(1|true|yes)$/i.test(options.env.SIBYL_SIGNIN_ALLOW_PRIVATE_NETWORK?.trim() ?? "") });
    this.sends = new LoginRateLimiter({ windowMs: 60 * 60_000, perAccount: 5, perIp: 20, now: this.now });
    this.checks = new LoginRateLimiter({ windowMs: 15 * 60_000, perAccount: 10, perIp: 50, now: this.now });
    this.starts = new LoginRateLimiter({ windowMs: 15 * 60_000, perAccount: 30, perIp: 30, now: this.now });
  }

  available(): SignupOptionsView {
    return { hosted: this.hosted, google: Boolean(this.apps.google), microsoft: Boolean(this.apps.microsoft), email: Boolean(this.options.mailer) };
  }

  /* ───────────── email: codes and links ───────────── */

  /**
   * Send a sign-in / sign-up link, or (hosted, password sign-up) a code.
   * The answer is the same whether or not the address has an account.
   */
  async startEmail(input: { email: unknown; method: unknown; password?: unknown; name?: unknown; next?: unknown }, ip: string, appUrl: string): Promise<SignupEmailSent> {
    const mailer = this.options.mailer;
    if (!mailer) throw new IdentityError(503, "email_unavailable", "Email isn't set up on this server. Use another way to sign in.");
    const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
    if (!EMAIL.test(email) || email.length > 254) throw new IdentityError(400, "invalid_email", "Enter a valid email address.");
    const method = input.method === "password" ? "password" : input.method === "magic_link" ? "magic_link" : undefined;
    if (!method) throw new IdentityError(400, "invalid_method", "Choose a sign-in link or a password.");
    if (method === "password" && !this.hosted) throw new IdentityError(404, "not_available", "Ask an admin for an invitation.");
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const next = safeNext(typeof input.next === "string" ? input.next : undefined);
    let passwordHash = "";
    if (method === "password") {
      const problem = passwordProblem(input.password);
      if (problem) throw new IdentityError(400, "weak_password", problem);
    }
    this.limit(this.sends, ip, email, "Too many emails. Try again in");
    this.sends.fail(ip, email);
    if (method === "password") passwordHash = await hashPassword(input.password as string);
    const now = this.now();

    if (method === "password") {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const record: PendingCode = { email, codeHash: this.codeHash(email, code), passwordHash, ...(name ? { name } : {}), next, expiresAt: now + CODE_TTL_MS, attempts: 0 };
      await this.store.kv.set(SIGNUP_OWNER, codeKey(email), record);
      await this.send(mailer, { to: email, email: signUpCodeEmail({ code, minutes: Math.round(CODE_TTL_MS / 60_000) }) });
      this.options.log?.("signup.code_sent", {});
      return { sent: true, email, method, expiresAt: record.expiresAt };
    }

    // Magic link: sign in to an existing account, or (hosted) sign up.
    const exists = (await this.accounts(email)).length > 0;
    const expiresAt = now + LINK_TTL_MS;
    if (exists || this.hosted) {
      const token = randomToken();
      const record: PendingLink = { email, ...(name ? { name } : {}), next, expiresAt };
      await this.store.kv.set(SIGNUP_OWNER, linkKey(token), record);
      const url = `${appUrl.replace(/\/+$/, "")}/signup/link?token=${encodeURIComponent(token)}`;
      const link = { url, minutes: Math.round(LINK_TTL_MS / 60_000) };
      await this.send(mailer, { to: email, email: exists ? signInLinkEmail(link) : signUpLinkEmail(link) });
      this.options.log?.("signup.link_sent", { existing: exists });
    }
    return { sent: true, email, method, expiresAt };
  }

  /** The 6-digit code from a password sign-up. */
  async verifyCode(input: { email: unknown; code: unknown }, ip: string, identityFor: IdentityFor): Promise<SignupOutcome> {
    const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
    const code = typeof input.code === "string" ? input.code.replace(/\s+/g, "") : "";
    this.limit(this.checks, ip, email, "Too many tries. Try again in");
    const record = email ? await this.store.kv.get<PendingCode>(SIGNUP_OWNER, codeKey(email)) : undefined;
    if (!record || record.expiresAt <= this.now()) {
      this.checks.fail(ip, email);
      throw new IdentityError(410, "code_expired", "This code has expired. Send a new one.");
    }
    const given = Buffer.from(this.codeHash(email, code));
    const expected = Buffer.from(record.codeHash);
    if (!/^\d{6}$/.test(code) || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.checks.fail(ip, email);
      const attempts = record.attempts + 1;
      if (attempts >= CODE_ATTEMPTS) {
        await this.store.kv.delete(SIGNUP_OWNER, codeKey(email));
        throw new IdentityError(410, "code_expired", "Too many wrong codes. Send a new one.");
      }
      await this.store.kv.set(SIGNUP_OWNER, codeKey(email), { ...record, attempts });
      throw new IdentityError(400, "invalid_code", "That code isn't right. Check the latest email.");
    }
    await this.store.kv.delete(SIGNUP_OWNER, codeKey(email));
    this.checks.succeed(ip, email);
    return this.verified({ email, ...(record.name ? { name: record.name } : {}), provider: "password", passwordHash: record.passwordHash }, record.next, ip, identityFor);
  }

  /** A magic link opened in the web app. */
  async redeemLink(token: unknown, ip: string, identityFor: IdentityFor): Promise<SignupOutcome> {
    const value = typeof token === "string" && token.length <= 128 ? token : "";
    this.limit(this.checks, ip, "", "Too many tries. Try again in");
    const record = value ? await this.store.kv.get<PendingLink>(SIGNUP_OWNER, linkKey(value)) : undefined;
    if (value) await this.store.kv.delete(SIGNUP_OWNER, linkKey(value));
    if (!record || record.expiresAt <= this.now()) {
      this.checks.fail(ip, "");
      throw new IdentityError(410, "link_expired", "This link has expired or was already used. Ask for a new one.");
    }
    return this.verified({ email: record.email, ...(record.name ? { name: record.name } : {}), provider: "magic_link" }, record.next, ip, identityFor);
  }

  /* ───────────── Google / Microsoft ───────────── */

  isConfigured(provider: string): provider is OAuthProvider {
    return (provider === "google" || provider === "microsoft") && Boolean(this.apps[provider]);
  }

  /**
   * Where to send the browser, and the binding cookie value for this
   * browser. With `invite`, finishing accepts that invitation (see
   * acceptInviteExternal) instead of signing in or up.
   */
  async startOAuth(provider: OAuthProvider, next: string | undefined, redirectUri: string, ip: string, invite?: string): Promise<{ url: string; binding: string }> {
    const app = this.apps[provider];
    if (!app) throw new IdentityError(404, "not_available", "That sign-in option isn't available.");
    this.limit(this.starts, ip, "", "Too many sign-in attempts. Try again in");
    this.starts.fail(ip, "");
    const config = await this.oidc.configuration(provider, app, async () => app.clientSecret);
    // Google: always let the person pick the account; Microsoft: the same.
    const started = await this.oidc.start(config, app, redirectUri, { prompt: "select_account" });
    const { binding, hash } = newBrowserBinding();
    this.sweep();
    if (this.oauth.size >= MAX_PENDING) this.oauth.delete(this.oauth.keys().next().value!);
    this.oauth.set(started.state, {
      provider,
      bindingHash: hash,
      next: safeNext(next),
      ...(invite ? { invite } : {}),
      checks: { state: started.state, nonce: started.nonce, verifier: started.verifier },
      expiresAt: this.now() + OAUTH_TTL_MS
    });
    return { url: started.url.toString(), binding };
  }

  /** The provider sent the browser back: check everything, then sign in or sign up. */
  async finishOAuth(provider: OAuthProvider, request: IncomingMessage, callbackUrl: URL, bindingCookie: string, ip: string, identityFor: IdentityFor): Promise<SignupOutcome> {
    const state = callbackUrl.searchParams.get("state") ?? "";
    const pending = state ? this.oauth.get(state) : undefined;
    if (state) this.oauth.delete(state);
    if (!pending || pending.provider !== provider || pending.expiresAt <= this.now()) {
      throw new IdentityError(400, "signin_expired", "This sign-in expired or was already used. Start again.");
    }
    if (!browserBindingMatches(request, bindingCookie, pending.bindingHash)) {
      throw new IdentityError(400, "browser_mismatch", "Finish signing in in the same browser you started in.");
    }
    if (callbackUrl.searchParams.get("error")) throw new IdentityError(400, "denied", `${label(provider)} sign-in was cancelled.`);
    const app = this.apps[provider];
    if (!app) throw new IdentityError(404, "not_available", "That sign-in option isn't available.");
    const config = await this.oidc.configuration(provider, app, async () => app.clientSecret);
    let identity: OidcIdentity;
    try {
      identity = await this.oidc.finish(config, app, callbackUrl, pending.checks);
    } catch (error) {
      this.options.log?.("signup.oauth_failed", { provider, error: error instanceof Error ? error.message : String(error) });
      throw new IdentityError(400, "invalid_response", `${label(provider)}'s answer didn't check out. Try again.`);
    }
    const email = identity.email ? normalizeEmail(identity.email) : "";
    if (!EMAIL.test(email)) throw new IdentityError(400, "no_email", `${label(provider)} didn't share an email address.`);
    if (!emailVouched(provider, identity)) {
      throw new IdentityError(400, "email_unverified", `${label(provider)} hasn't confirmed this email address. Sign up with email instead.`);
    }
    if (pending.invite) return this.acceptInvite(pending.invite, { email, ...(identity.name ? { name: identity.name.slice(0, 80) } : {}), provider, subject: identity.subject }, ip, identityFor);
    return this.verified({ email, ...(identity.name ? { name: identity.name.slice(0, 80) } : {}), provider, subject: identity.subject }, pending.next, ip, identityFor);
  }

  /** The invitation a pending Google / Microsoft sign-in accepts (for sending errors back to its page). */
  pendingInvite(state: string | null): string | undefined {
    return state ? this.oauth.get(state)?.invite : undefined;
  }

  /** The verified address accepts the invitation in its organization; back to the invitation page, signed in. */
  private async acceptInvite(token: string, identity: { email: string; name?: string; provider: OAuthProvider; subject: string }, ip: string, identityFor: IdentityFor): Promise<SignupOutcome> {
    const invite = await this.store.identity.invites.getByTokenHash(hashToken(token));
    if (!invite) throw new IdentityError(404, "invite_not_found", "This invitation link isn't valid.");
    const accepted = await (await identityFor(invite.orgId)).acceptInviteExternal(token, identity, ip);
    this.options.log?.("signup.invite_accepted", { provider: identity.provider, newAccount: accepted.newAccount });
    const query = new URLSearchParams({ joined: accepted.workspaceId, ...(accepted.newAccount ? { new: "1" } : {}) });
    return { kind: "session", token: accepted.token, orgId: invite.orgId, path: `/invite/${encodeURIComponent(token)}?${query.toString()}` };
  }

  /* ───────────── one person, several organizations ───────────── */

  async choiceOrganizations(choice: string | undefined): Promise<Array<{ id: string; name: string }>> {
    const pending = this.pendingChoice(choice);
    return this.organizationNames(pending.accounts.map((account) => account.orgId));
  }

  async choose(choice: string | undefined, orgId: unknown, ip: string, identityFor: IdentityFor): Promise<SignupOutcome> {
    const pending = this.pendingChoice(choice);
    const account = pending.accounts.find((entry) => entry.orgId === orgId);
    if (!account) throw new IdentityError(400, "invalid_org", "Choose one of your organizations.");
    this.choices.delete(choiceKey(choice!));
    return this.signIn(account.orgId, account.userId, pending.method, pending.next, ip, identityFor);
  }

  /* ───────────── tickets ───────────── */

  async ticketView(ticket: string | undefined): Promise<SignupTicketView | undefined> {
    const opened = ticket ? await this.tickets.open(ticket) : undefined;
    if (!opened) return undefined;
    return { email: opened.ticket.email, ...(opened.ticket.name ? { name: opened.ticket.name } : {}), provider: opened.ticket.provider, expiresAt: opened.expiresAt };
  }

  /* ───────────── internals ───────────── */

  /** Active accounts with this address (every organization when hosted). */
  private async accounts(email: string): Promise<UserRecord[]> {
    return (await this.store.identity.users.listByEmail(email)).filter((user) => user.disabledAt === undefined && user.removedAt === undefined);
  }

  /** The address is proven: sign in, choose an organization, or (hosted) a sign-up ticket. */
  private async verified(identity: VerifiedIdentity, next: string, ip: string, identityFor: IdentityFor): Promise<SignupOutcome> {
    let accounts = await this.accounts(identity.email);
    const external = identity.provider === "google" || identity.provider === "microsoft" ? identity.provider : undefined;
    if (external && identity.subject) {
      // An account linked to a different Google / Microsoft account with the same address isn't this person's.
      accounts = accounts.filter((user) => !user.links?.some((link) => link.provider === external && link.subject !== identity.subject));
      for (const user of accounts) await this.markVerified(user, { provider: external, subject: identity.subject });
    } else {
      for (const user of accounts) await this.markVerified(user);
    }
    if (accounts.length === 1) return this.signIn(accounts[0]!.orgId, accounts[0]!.id, identity.provider, next, ip, identityFor);
    if (accounts.length > 1) {
      const choice = randomToken();
      this.sweep();
      if (this.choices.size >= MAX_PENDING) this.choices.delete(this.choices.keys().next().value!);
      this.choices.set(choiceKey(choice), {
        accounts: accounts.map((user) => ({ orgId: user.orgId, userId: user.id })),
        method: identity.provider,
        next,
        expiresAt: this.now() + CHOICE_TTL_MS
      });
      return { kind: "choose", choice, organizations: await this.organizationNames(accounts.map((user) => user.orgId)) };
    }
    if (!this.hosted) throw new IdentityError(403, "no_account", "There's no Sibyl account for this address here. Ask an admin for an invitation.");
    const ticket: SignupTicket = {
      email: identity.email,
      provider: identity.provider,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.subject ? { subject: identity.subject } : {}),
      ...(identity.passwordHash ? { passwordHash: identity.passwordHash } : {})
    };
    const issued = this.tickets.issue(ticket);
    this.options.log?.("signup.verified", { provider: identity.provider });
    return {
      kind: "ticket",
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      view: { email: identity.email, ...(identity.name ? { name: identity.name } : {}), provider: identity.provider, expiresAt: issued.expiresAt }
    };
  }

  private async signIn(orgId: string, userId: string, method: SignupProvider, next: string, ip: string, identityFor: IdentityFor): Promise<SignupOutcome> {
    const identity = await identityFor(orgId);
    // A password sign-up of an existing address only proves the address: it signs in like an emailed link.
    const { token } = await identity.signInExternal(userId, method === "password" ? "magic_link" : method, ip);
    return { kind: "session", token, orgId, path: next };
  }

  /** The person proved the address (and, with Google / Microsoft, which account is theirs). */
  private async markVerified(user: UserRecord, link?: Omit<ExternalLogin, "linkedAt">): Promise<void> {
    const linked = link ? user.links?.some((entry) => entry.provider === link.provider && entry.subject === link.subject) : true;
    if (user.emailVerifiedAt !== undefined && linked) return;
    await this.store.identity.users.upsert({
      ...user,
      emailVerifiedAt: user.emailVerifiedAt ?? this.now(),
      ...(link && !linked ? { links: [...(user.links ?? []), { ...link, linkedAt: this.now() }] } : {})
    });
  }

  private async organizationNames(ids: string[]): Promise<Array<{ id: string; name: string }>> {
    const records = await this.store.organizations.getMany(ids);
    const names = new Map(records.map((record) => [record.id, record.name] as const));
    return ids.map((id) => ({ id, name: names.get(id) ?? "Sibyl" }));
  }

  private pendingChoice(choice: string | undefined): PendingChoice {
    const pending = choice ? this.choices.get(choiceKey(choice)) : undefined;
    if (!pending || pending.expiresAt <= this.now()) throw new IdentityError(410, "choice_expired", "This sign-in expired. Start again.");
    return pending;
  }

  private codeHash(email: string, code: string): string {
    return createHmac("sha256", this.codeKey).update(`${email}\u0000${code}`, "utf8").digest("hex");
  }

  private limit(limiter: LoginRateLimiter, ip: string, email: string, prefix: string): void {
    const wait = limiter.retryAfter(ip, email);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      throw new IdentityError(429, "rate_limited", `${prefix} ${minutes} minute${minutes === 1 ? "" : "s"}.`, wait);
    }
  }

  private async send(mailer: Mailer, message: EmailMessage): Promise<void> {
    try {
      await mailer.send(message);
    } catch (error) {
      this.options.log?.("signup.email_failed", { error: error instanceof Error ? error.message : String(error) });
      throw new IdentityError(502, "email_failed", "We couldn't send the email. Try again in a minute.");
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.oauth) if (entry.expiresAt <= now) this.oauth.delete(key);
    for (const [key, entry] of this.choices) if (entry.expiresAt <= now) this.choices.delete(key);
  }
}

/** Did the provider vouch for the email address? */
export function emailVouched(provider: OAuthProvider, identity: Pick<OidcIdentity, "emailVerified" | "claims">): boolean {
  if (identity.emailVerified === true) return true;
  if (provider === "google") return false;
  // Microsoft: personal accounts, or an organization's domain it verified (xms_edov).
  return identity.claims.xms_edov === true || identity.claims.xms_edov === "true" || identity.claims.tid === MICROSOFT_CONSUMER_TENANT;
}

function label(provider: OAuthProvider): string {
  return provider === "google" ? "Google" : "Microsoft";
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const codeKey = (email: string) => `signup.code.${sha256(email)}`;
const linkKey = (token: string) => `signup.link.${sha256(token)}`;
const choiceKey = (choice: string) => sha256(choice);
