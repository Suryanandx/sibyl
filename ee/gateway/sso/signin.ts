/**
 * SSO sign-in state and account resolution — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Login CSRF / swapping protection: starting a sign-in sets a random
 * `sibyl_sso` cookie (HttpOnly, SameSite=Lax, 10 minutes) whose hash is kept
 * with the pending sign-in; the callback (OIDC) or the completion step after
 * the SAML POST must come from the same browser. A SAML response arrives as
 * a cross-site POST (no Lax cookies), so the ACS validates it, parks the
 * result under a one-time ticket and 303-redirects the browser to
 * /api/sso/complete, a top-level GET where the cookie is sent.
 *
 * Accounts: a provider signs in people whose email domain it claims.
 * 1. An account already linked to the provider's subject → that account.
 * 2. Else an account with the same email → linked (OIDC: only when the
 *    provider doesn't say the email is unverified).
 * 3. Else, with just-in-time creation on, a new account (directory
 *    defaults); otherwise refused.
 * Then the groups the provider reported are applied (group → role rules).
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { normalizeEmail, type UserRecord } from "../../../packages/core/src/index";
import { browserBindingMatches, newBrowserBinding, safeNext } from "../../../apps/gateway/src/identity/oidc";
import type { Directory } from "../directory/directory";
import type { SsoProviderRecord } from "./config";

export const BINDING_COOKIE = "sibyl_sso";
const PENDING_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 2 * 60_000;
const MAX_PENDING = 10_000;

/** An expected SSO failure; `code` is shown on the sign-in screen (?sso_error=). */
export class SsoError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SsoError";
  }
}

export interface ExternalIdentity {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  groups: string[];
}

export interface PendingSignIn {
  providerId: string;
  bindingHash: string;
  next: string;
  oidc?: { state: string; nonce: string; verifier: string };
  expiresAt: number;
}

interface Ticket {
  providerId: string;
  bindingHash: string;
  next: string;
  identity: ExternalIdentity;
  expiresAt: number;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class SignInState {
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly tickets = new Map<string, Ticket>();

  /** New browser binding (cookie value) for a sign-in. */
  newBinding(): string {
    return newBrowserBinding().binding;
  }

  /** Remember a started sign-in under `key` (OIDC state or SAML RelayState). */
  remember(key: string, entry: Omit<PendingSignIn, "expiresAt" | "bindingHash"> & { binding: string }): void {
    this.sweep();
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const { binding, ...rest } = entry;
    this.pending.set(key, { ...rest, bindingHash: sha256(binding), expiresAt: Date.now() + PENDING_TTL_MS });
  }

  /** Take (once) the sign-in started under `key`. */
  take(key: string | undefined, providerId: string): PendingSignIn {
    const entry = key ? this.pending.get(key) : undefined;
    if (key) this.pending.delete(key);
    if (!entry || entry.providerId !== providerId || entry.expiresAt <= Date.now()) {
      throw new SsoError("sso_expired", "This sign-in expired or was already used. Start again.");
    }
    return entry;
  }

  /** The browser finishing a sign-in must be the one that started it. */
  assertBinding(request: IncomingMessage, bindingHash: string): void {
    if (!browserBindingMatches(request, BINDING_COOKIE, bindingHash)) {
      throw new SsoError("sso_browser_mismatch", "Finish signing in in the same browser you started in.");
    }
  }

  /** Park a validated SAML result until the browser comes back to /api/sso/complete. */
  issueTicket(pending: PendingSignIn, identity: ExternalIdentity): string {
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(sha256(ticket), { providerId: pending.providerId, bindingHash: pending.bindingHash, next: pending.next, identity, expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  redeemTicket(ticket: string | undefined): Ticket {
    const key = ticket ? sha256(ticket) : "";
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    if (!entry || entry.expiresAt <= Date.now()) throw new SsoError("sso_expired", "This sign-in expired. Start again.");
    return entry;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(key);
    for (const [key, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(key);
  }
}

/** The account a provider's identity signs in to (see the rules above). */
export async function resolveAccount(
  directory: Directory,
  findByEmail: (email: string) => Promise<UserRecord | undefined>,
  provider: SsoProviderRecord,
  identity: ExternalIdentity
): Promise<UserRecord> {
  const email = identity.email ? normalizeEmail(identity.email) : "";
  if (!email || !email.includes("@")) throw new SsoError("sso_no_email", `${provider.label} didn't send an email address.`);
  const domain = email.split("@")[1]!;
  if (!provider.domains.includes(domain)) {
    throw new SsoError("sso_domain_not_allowed", `${provider.label} can't sign in ${domain} addresses here.`);
  }
  let user = await directory.findByLink(provider.id, identity.subject);
  if (!user) {
    // Someone removed from the organization isn't an account to sign in to: just-in-time creation gives them a fresh one.
    const found = await findByEmail(email);
    const existing = found && found.removedAt === undefined ? found : undefined;
    if (existing) {
      if (identity.emailVerified === false) throw new SsoError("sso_email_unverified", `${provider.label} says this email address isn't verified.`);
      await directory.link(existing.id, provider.id, identity.subject);
      user = existing;
    } else if ((await directory.settings()).jitProvisioning) {
      user = await directory.provision({ email, ...(identity.name ? { name: identity.name } : {}), createdBy: provider.id });
      await directory.link(user.id, provider.id, identity.subject);
    } else {
      throw new SsoError("sso_no_account", "There's no Sibyl account for you yet. Ask an admin to add you.");
    }
  }
  if (user.disabledAt !== undefined) throw new SsoError("account_disabled", "This account is turned off. Ask an admin.");
  await directory.setSsoGroups(user.id, identity.groups);
  return user;
}

/** A safe same-site path for after sign-in (from ?next=); shared with the open-source sign-in. */
export { safeNext };
