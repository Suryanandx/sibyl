/**
 * Session policies — Sibyl Enterprise (licence feature `sso`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Stored in `store.kv` (`ee.session-policy.v1`):
 * - maxSessionHours: a session ends this long after sign-in, used or not;
 * - idleTimeoutMinutes: a session ends after this long without a request or
 *   WebSocket message;
 * - ipAllowlist: CIDR ranges people may sign in from and use sessions from
 *   (requests from elsewhere are refused; the session itself survives, so
 *   coming back on the office network works again);
 * - requireMfa: password sign-ins need two-step verification (TOTP; people
 *   without it add it at their next sign-in). SSO sign-ins rely on the
 *   identity provider's own MFA.
 *
 * These apply to people's sessions. The owner token (SIBYL_OWNER_TOKEN) is
 * an API key and is not limited by them — it is the way back in if a policy
 * ever locks everyone out.
 */
import { BlockList, isIP } from "node:net";
import type { SessionDecision, SignInDecision, Store } from "../../../packages/core/src/index";
import type { SessionPolicyView } from "../../../packages/protocol/src/index";
import { DirectoryError } from "../directory/directory";

export const SESSION_POLICY_KV_KEY = "ee.session-policy.v1";
const MAX_RANGES = 100;

export interface SessionPolicy {
  maxSessionHours?: number;
  idleTimeoutMinutes?: number;
  ipAllowlist: string[];
  requireMfa: boolean;
}

export interface ParsedRange {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

/** "10.0.0.0/8", "2001:db8::/32" or a single address → a range; undefined when invalid. */
export function parseCidr(value: string): ParsedRange | undefined {
  const [address = "", prefixText] = value.trim().split("/");
  const version = isIP(address);
  if (version === 0) return undefined;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) return undefined;
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

/** Normalise an address for matching (IPv4-mapped IPv6 → IPv4). */
export function normaliseIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

/** True when the list is empty or `ip` falls in one of its ranges. */
export function ipAllowed(ranges: readonly string[], ip: string | undefined): boolean {
  if (ranges.length === 0) return true;
  if (!ip) return false;
  const address = normaliseIp(ip);
  const version = isIP(address);
  if (version === 0) return false;
  const list = new BlockList();
  for (const range of ranges) {
    const parsed = parseCidr(range);
    if (parsed) list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return list.check(address, version === 4 ? "ipv4" : "ipv6");
}

export class SessionPolicyStore {
  private cache: SessionPolicy | undefined;

  constructor(private readonly options: { store: Store; orgId: string }) {}

  async get(): Promise<SessionPolicy> {
    this.cache ??= { ipAllowlist: [], requireMfa: false, ...((await this.options.store.kv.get<SessionPolicy>(this.options.orgId, SESSION_POLICY_KV_KEY)) ?? {}) };
    return structuredClone(this.cache);
  }

  /** Validate and save. `callerIp` must stay allowed (nobody locks themselves out by accident). */
  async set(input: Record<string, unknown>, callerIp: string): Promise<SessionPolicy> {
    const next: SessionPolicy = { ipAllowlist: [], requireMfa: input.requireMfa === true };
    const hours = optionalNumber(input.maxSessionHours, "Maximum session length", 1, 24 * 90);
    if (hours !== undefined) next.maxSessionHours = hours;
    const minutes = optionalNumber(input.idleTimeoutMinutes, "Idle timeout", 5, 60 * 24 * 30);
    if (minutes !== undefined) next.idleTimeoutMinutes = minutes;
    if (input.ipAllowlist !== undefined) {
      if (!Array.isArray(input.ipAllowlist) || input.ipAllowlist.length > MAX_RANGES) throw new DirectoryError(400, "invalid_ip_allowlist", `List up to ${MAX_RANGES} address ranges.`);
      const ranges: string[] = [];
      for (const raw of input.ipAllowlist) {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (!text) continue;
        const parsed = parseCidr(text);
        if (!parsed) throw new DirectoryError(400, "invalid_ip_allowlist", `${text} isn't an address or CIDR range (e.g. 203.0.113.0/24).`);
        ranges.push(`${parsed.address}/${parsed.prefix}`);
      }
      next.ipAllowlist = [...new Set(ranges)];
    }
    if (!ipAllowed(next.ipAllowlist, callerIp)) {
      throw new DirectoryError(409, "would_lock_you_out", `Your address (${normaliseIp(callerIp)}) isn't in the list. Add it first, so you can still get in.`);
    }
    await this.options.store.kv.set(this.options.orgId, SESSION_POLICY_KV_KEY, next);
    this.cache = next;
    return structuredClone(next);
  }

  async view(callerIp?: string): Promise<SessionPolicyView> {
    return { ...(await this.get()), ...(callerIp ? { yourIp: normaliseIp(callerIp) } : {}) };
  }

  /** Sign-in rule: allowed networks; two-step verification for password sign-ins. */
  async checkSignIn(input: { method: string; ip: string }): Promise<SignInDecision> {
    const policy = await this.get();
    if (!ipAllowed(policy.ipAllowlist, input.ip)) {
      return { allow: false, code: "ip_not_allowed", message: "Your organization only allows sign-in from its own networks." };
    }
    return { allow: true, ...(policy.requireMfa && input.method === "password" ? { requireMfa: true } : {}) };
  }

  /** Session rule: lifetime, idle timeout, allowed networks. */
  async checkSession(input: { createdAt: number; lastSeenAt: number; ip?: string; now: number }): Promise<SessionDecision> {
    const policy = await this.get();
    if (policy.maxSessionHours !== undefined && input.now - input.createdAt > policy.maxSessionHours * 3_600_000) {
      return { allow: false, code: "session_expired", message: "Your session has ended. Sign in again.", end: true };
    }
    const idleMs = policy.idleTimeoutMinutes !== undefined ? policy.idleTimeoutMinutes * 60_000 : undefined;
    if (idleMs !== undefined && input.now - input.lastSeenAt > idleMs) {
      return { allow: false, code: "session_idle", message: "You were signed out after a period of inactivity.", end: true };
    }
    // No address: a live connection re-checking itself (its address was checked when it opened).
    if (input.ip !== undefined && !ipAllowed(policy.ipAllowlist, input.ip)) {
      return { allow: false, code: "ip_not_allowed", message: "Your organization only allows access from its own networks.", end: false };
    }
    // Keep last-seen fresh enough for the idle timeout to be accurate (to a quarter of it).
    return { allow: true, ...(idleMs !== undefined ? { touchEveryMs: Math.floor(idleMs / 4) } : {}) };
  }

  /** True when a policy could end sessions with time (the gateway then re-checks live connections). */
  async timeLimited(): Promise<boolean> {
    const policy = await this.get();
    return policy.maxSessionHours !== undefined || policy.idleTimeoutMinutes !== undefined;
  }
}

function optionalNumber(value: unknown, what: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new DirectoryError(400, "invalid_value", `${what} must be between ${min} and ${max}.`);
  return Math.round(number);
}
