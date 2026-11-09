/**
 * Passwords and one-time tokens.
 *
 * - Passwords: scrypt (node:crypto) with a random 16-byte salt per user,
 *   stored as `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`, compared in
 *   constant time.
 * - Tokens (session cookies, invite links): 32 random bytes, base64url. Only
 *   their SHA-256 is stored, so a database leak can't be replayed.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LENGTH = 64;
const COST = { N: 16_384, r: 8, p: 1 };
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** A fixed hash used to keep timing equal when the email is unknown. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
  return dummyHash;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (expected.length === 0) return false;
  const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}

/** undefined when acceptable, otherwise a human message. */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return "That password is too long.";
  return undefined;
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
