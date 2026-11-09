/**
 * Two-step verification (TOTP) for password sign-ins — open source: anyone
 * can turn it on for their own account. Sibyl Enterprise can additionally
 * *require* it (session policies, see docs/enterprise.md).
 *
 * Storage: `store.kv` key `identity.mfa.v1` (per organization), one entry per
 * user. The TOTP secret is AES-256-GCM encrypted with the secrets vault's
 * master key (SIBYL_SECRET_KEY / data/secret.key), bound to the user id;
 * recovery codes are stored as SHA-256 hashes only. Without a master key
 * two-step verification can't be turned on (and existing enrolments can't be
 * checked, so those sign-ins are refused rather than let through).
 *
 * Sign-in challenges (password accepted, code still needed) live in memory
 * for 5 minutes and allow 5 wrong codes.
 */
import type { Store } from "@open-gpt-live/core";
import { decryptValue, encryptValue } from "../secrets/crypto.js";
import { hashToken, randomToken } from "./crypto.js";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

export const MFA_KV_KEY = "identity.mfa.v1";
export const MFA_ISSUER = "Sibyl";
const CHALLENGE_TTL_MS = 5 * 60_000;
const SETUP_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

interface StoredMfa {
  /** Encrypted base32 TOTP secret. */
  secret: string;
  enabledAt: number;
  /** SHA-256 of each unused recovery code. */
  recovery: string[];
  /** Last accepted TOTP step (a code works once). */
  lastStep?: number;
}

export interface MfaStatus {
  enabled: boolean;
  enabledAt?: number;
  recoveryCodesLeft: number;
  /** False when the gateway has no secrets key (two-step verification can't be turned on). */
  available: boolean;
}

export class MfaUnavailableError extends Error {
  constructor() {
    super("Two-step verification needs the secrets key (SIBYL_SECRET_KEY or data/secret.key).");
    this.name = "MfaUnavailableError";
  }
}

export interface PendingChallenge {
  userId: string;
  /** Set when the person has no second factor yet and must add one to finish signing in. */
  enrollSecret?: string;
  /** What the challenge finishes: a sign-in, or an invitation (the workspace it adds). */
  workspaceId?: string;
  expiresAt: number;
  attempts: number;
}

export class MfaService {
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly setups = new Map<string, { userId: string; secret: string; expiresAt: number }>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      store: Store;
      orgId: string;
      key: () => Buffer | undefined;
      now: () => number;
    }
  ) {}

  get available(): boolean {
    return Boolean(this.options.key());
  }

  async status(userId: string): Promise<MfaStatus> {
    const entry = (await this.all())[userId];
    return {
      enabled: Boolean(entry),
      ...(entry ? { enabledAt: entry.enabledAt } : {}),
      recoveryCodesLeft: entry?.recovery.length ?? 0,
      available: this.available
    };
  }

  async enabled(userId: string): Promise<boolean> {
    return Boolean((await this.all())[userId]);
  }

  /** Everyone with two-step verification on (Admin → Users). */
  async enabledUserIds(): Promise<Set<string>> {
    return new Set(Object.keys(await this.all()));
  }

  /** A fresh secret to show (QR / key); nothing is saved until enable() gets a matching code. */
  beginSetup(user: { id: string; email: string }): { setupToken: string; secret: string; otpauthUrl: string } {
    if (!this.available) throw new MfaUnavailableError();
    this.sweep();
    const setupToken = randomToken();
    const secret = newTotpSecret();
    this.setups.set(hashToken(setupToken), { userId: user.id, secret, expiresAt: this.options.now() + SETUP_TTL_MS });
    return { setupToken, secret, otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: MFA_ISSUER }) };
  }

  /** Turn it on with the secret from beginSetup(); returns the recovery codes (shown once). undefined: wrong code. */
  async enable(userId: string, setupToken: string, code: string): Promise<string[] | undefined> {
    const key = hashToken(setupToken);
    const setup = this.setups.get(key);
    if (!setup || setup.userId !== userId || setup.expiresAt <= this.options.now()) return undefined;
    const step = verifyTotp(setup.secret, code, this.options.now());
    if (step === undefined) return undefined;
    this.setups.delete(key);
    return this.save(userId, setup.secret, step);
  }

  async disable(userId: string): Promise<void> {
    await this.update((all) => {
      delete all[userId];
    });
  }

  /** New recovery codes (the old ones stop working). */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = newRecoveryCodes();
    await this.update((all) => {
      const entry = all[userId];
      if (entry) entry.recovery = codes.map(hashRecoveryCode);
    });
    return codes;
  }

  /** Check a TOTP code or a recovery code (used up) for an enrolled user. */
  async verify(userId: string, input: { code?: string; recoveryCode?: string }): Promise<boolean> {
    const key = this.options.key();
    if (!key) throw new MfaUnavailableError();
    let ok = false;
    await this.update((all) => {
      const entry = all[userId];
      if (!entry) return;
      if (input.recoveryCode) {
        const hash = hashRecoveryCode(input.recoveryCode);
        const index = entry.recovery.indexOf(hash);
        if (index >= 0) {
          entry.recovery.splice(index, 1);
          ok = true;
        }
        return;
      }
      if (!input.code) return;
      let secret: string;
      try {
        secret = decryptValue(key, this.options.orgId, secretName(userId), entry.secret);
      } catch {
        // Wrong master key: refuse (never let a sign-in through unchecked).
        return;
      }
      const step = verifyTotp(secret, input.code, this.options.now(), entry.lastStep);
      if (step !== undefined) {
        entry.lastStep = step;
        ok = true;
      }
    });
    return ok;
  }

  /* ───────────── sign-in challenges ───────────── */

  /** Password accepted; a code is still needed. Returns the one-time challenge token. */
  createChallenge(userId: string, options: { enroll: boolean; workspaceId?: string }): { challenge: string; enrollSecret?: string } {
    if (!this.available) throw new MfaUnavailableError();
    this.sweep();
    const challenge = randomToken();
    const enrollSecret = options.enroll ? newTotpSecret() : undefined;
    this.challenges.set(hashToken(challenge), {
      userId,
      ...(enrollSecret ? { enrollSecret } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      expiresAt: this.options.now() + CHALLENGE_TTL_MS,
      attempts: 0
    });
    return { challenge, ...(enrollSecret ? { enrollSecret } : {}) };
  }

  /**
   * Answer a challenge. Returns the challenge (now used up) and, when the
   * person enrolled during sign-in, their recovery codes; undefined when the
   * code is wrong. Throws "expired" when the challenge is unknown, expired or
   * out of attempts.
   */
  async completeChallenge(
    challenge: string,
    input: { code?: string; recoveryCode?: string }
  ): Promise<{ pending: PendingChallenge; recoveryCodes?: string[] } | undefined> {
    const key = hashToken(challenge);
    const pending = this.challenges.get(key);
    if (!pending || pending.expiresAt <= this.options.now() || pending.attempts >= MAX_ATTEMPTS) {
      this.challenges.delete(key);
      throw new Error("expired");
    }
    pending.attempts += 1;
    if (pending.enrollSecret) {
      const step = input.code ? verifyTotp(pending.enrollSecret, input.code, this.options.now()) : undefined;
      if (step === undefined) return undefined;
      this.challenges.delete(key);
      return { pending, recoveryCodes: await this.save(pending.userId, pending.enrollSecret, step) };
    }
    if (!(await this.verify(pending.userId, input))) return undefined;
    this.challenges.delete(key);
    return { pending };
  }

  /* ───────────── storage ───────────── */

  private async save(userId: string, secret: string, step: number): Promise<string[]> {
    const key = this.options.key();
    if (!key) throw new MfaUnavailableError();
    const codes = newRecoveryCodes();
    const entry: StoredMfa = {
      secret: encryptValue(key, this.options.orgId, secretName(userId), secret),
      enabledAt: this.options.now(),
      recovery: codes.map(hashRecoveryCode),
      lastStep: step
    };
    await this.update((all) => {
      all[userId] = entry;
    });
    return codes;
  }

  private async all(): Promise<Record<string, StoredMfa>> {
    return (await this.options.store.kv.get<Record<string, StoredMfa>>(this.options.orgId, MFA_KV_KEY)) ?? {};
  }

  /** Read-modify-write, one at a time. */
  private update(change: (all: Record<string, StoredMfa>) => void): Promise<void> {
    const run = this.writes.catch(() => undefined).then(async () => {
      const all = await this.all();
      change(all);
      await this.options.store.kv.set(this.options.orgId, MFA_KV_KEY, all);
    });
    this.writes = run;
    return run;
  }

  private sweep(): void {
    const now = this.options.now();
    for (const [key, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(key);
    for (const [key, value] of this.setups) if (value.expiresAt <= now) this.setups.delete(key);
  }
}

function secretName(userId: string): string {
  return `mfa:${userId}`;
}
