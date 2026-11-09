/**
 * OAuth 2.0 authorization code flow with PKCE (RFC 6749, RFC 7636).
 *
 * The `state` parameter is 256 random bits, single use, valid for ten
 * minutes, and bound to who started the flow: the signed-in user and a hash
 * of their session cookie (or the token/local principal). The callback only
 * completes for the same person and session, so a link with someone else's
 * code can't attach their account to yours (login CSRF).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectionScope } from "./types.js";

export const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function hashBinding(value: string): string {
  return createHash("sha256").update(`sibyl.connectors.state\u0000${value}`).digest("hex");
}

export interface PendingAuthorization {
  connectorId: string;
  scope: ConnectionScope;
  workspaceId: string;
  /** "user:<id>", "token" or "local". */
  ownerKey: string;
  ownerName?: string;
  /** Hash of the session cookie (users), or of the principal kind. */
  binding: string;
  verifier?: string;
  groups: string[];
  scopes: string[];
  redirectUri: string;
  /** Reconnect an existing connection instead of creating one. */
  connectionId?: string;
  createdAt: number;
}

/** In-memory, single-use authorization states. */
export class PendingStates {
  private readonly states = new Map<string, PendingAuthorization>();

  constructor(private readonly now: () => number = Date.now) {}

  create(pending: Omit<PendingAuthorization, "createdAt">): string {
    this.sweep();
    if (this.states.size >= MAX_PENDING) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    const state = base64url(randomBytes(32));
    this.states.set(state, { ...pending, createdAt: this.now() });
    return state;
  }

  /** A flow with this state is pending here (not taken, not expired). */
  has(state: string): boolean {
    const pending = typeof state === "string" ? this.states.get(state) : undefined;
    return Boolean(pending && this.now() - pending.createdAt <= STATE_TTL_MS);
  }

  /** Remove and return the pending flow (undefined when unknown or expired). */
  take(state: string): PendingAuthorization | undefined {
    if (typeof state !== "string" || state.length < 20 || state.length > 128) return undefined;
    const pending = this.states.get(state);
    if (!pending) return undefined;
    this.states.delete(state);
    if (this.now() - pending.createdAt > STATE_TTL_MS) return undefined;
    return pending;
  }

  private sweep(): void {
    const cutoff = this.now() - STATE_TTL_MS;
    for (const [key, value] of this.states) if (value.createdAt < cutoff) this.states.delete(key);
  }
}

export function bindingMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [key: string]: unknown;
}

export function isTokenResponse(value: unknown): value is TokenResponse {
  return Boolean(value && typeof value === "object" && typeof (value as { access_token?: unknown }).access_token === "string");
}

/** Fill `{name}` placeholders (values were validated against their patterns). */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => values[key] ?? match);
}
