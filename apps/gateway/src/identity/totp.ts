/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP), the codes
 * authenticator apps show: HMAC-SHA1, 6 digits, 30-second steps — the
 * defaults every app supports.
 *
 * - Secrets are 20 random bytes, shown to people as base32 (RFC 4648).
 * - A code is accepted one step either side of now (clock drift), and never
 *   twice: callers keep the last accepted step and pass it back.
 * - Recovery codes are 10 one-time codes; only their SHA-256 is stored.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hashToken } from "./crypto.js";

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** Steps accepted either side of the current one. */
const DRIFT_STEPS = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP value for one counter (RFC 4226 §5.3), zero-padded. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCode(secretBase32: string, nowMs: number): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/**
 * The step a code matches (now ± 1 step), or undefined. Steps at or before
 * `lastStep` are refused, so a code works once.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastStep?: number): number | undefined {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return undefined;
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (lastStep !== undefined && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(digits))) return step;
  }
  return undefined;
}

/** otpauth:// URL for authenticator apps (QR code or tap-to-add). */
export function otpauthUrl(input: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten recovery codes like `k7rq-2m9x-p4tw` (shown once; store hashRecoveryCode of each). */
export function newRecoveryCodes(count = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return hashToken(code.trim().toLowerCase().replace(/[\s-]/g, ""));
}
