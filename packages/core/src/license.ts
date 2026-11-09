/**
 * Sibyl Enterprise licence keys — offline verification.
 *
 * This file is open source (MIT) on purpose: the open-source core has to be
 * able to read a key to know which enterprise modules may switch on. It only
 * verifies; issuing keys needs the private signing key, which never lives in
 * this repository (see ee/README.md and ee/tools/issue-license.mjs).
 *
 * Token format:
 *
 *   sibyl1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
 *
 * The signature covers the ASCII bytes of `sibyl1.<payload part>`.
 *
 * Rules:
 * - Pure functions, no network, no phone-home.
 * - An expired key never locks anyone out: enterprise features turn off and
 *   Sibyl keeps working as the open-source edition with all data intact.
 */
import { createPublicKey, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";

export const LICENSE_TOKEN_PREFIX = "sibyl1";

/** Longest token we try to parse (keeps junk input cheap). */
export const LICENSE_TOKEN_MAX_CHARS = 8192;

export interface LicensePayload {
  /** Organisation the key was issued to. */
  licensee: string;
  edition: "enterprise";
  /** Licensed seats (informational until seat counting lands). */
  seats: number;
  /** Feature ids from FEATURES (unknown ids are kept but ignored). */
  features: string[];
  /** ISO 8601 timestamps. */
  issuedAt: string;
  expiresAt: string;
}

export type LicenseFailure =
  | "missing"
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "invalid_payload"
  | "not_yet_valid"
  | "expired";

export interface LicenseVerification {
  valid: boolean;
  /** Why the key is not valid (absent when valid). */
  reason?: LicenseFailure;
  /**
   * The signed payload, present when the signature checked out — also for an
   * expired key, so the UI can say whose key expired and when.
   */
  payload?: LicensePayload;
}

/**
 * Public keys (raw 32-byte Ed25519, base64url) that licence keys are checked
 * against. The first one is a development key generated for this repository;
 * replace it with the public half of the production signing key before the
 * first enterprise release. Never put a private key here.
 */
export const SIBYL_LICENSE_PUBLIC_KEYS: readonly string[] = [
  // dev-2026-11 (development signing key; private half kept outside the repo)
  "E1-VK5dWtb14zIngk58gTEeReDtvt5mDt1kKjJHwRDk"
];

/** Verify a licence token against the given public keys (default: the embedded ones). */
export function verifyLicense(
  token: string | undefined | null,
  publicKeys: readonly string[] = SIBYL_LICENSE_PUBLIC_KEYS,
  now: number = Date.now()
): LicenseVerification {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) return { valid: false, reason: "missing" };
  if (trimmed.length > LICENSE_TOKEN_MAX_CHARS) return { valid: false, reason: "malformed" };
  const parts = trimmed.split(".");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return { valid: false, reason: "malformed" };
  const [version, payloadPart, signaturePart] = parts as [string, string, string];
  if (version !== LICENSE_TOKEN_PREFIX) return { valid: false, reason: "unsupported_version" };
  if (!isBase64Url(payloadPart) || !isBase64Url(signaturePart)) return { valid: false, reason: "malformed" };

  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64) return { valid: false, reason: "malformed" };
  const message = Buffer.from(`${version}.${payloadPart}`, "ascii");
  const signed = publicKeys.some((key) => {
    const publicKey = toPublicKey(key);
    if (!publicKey) return false;
    try {
      return verifyBytes(null, message, publicKey, signature);
    } catch {
      return false;
    }
  });
  if (!signed) return { valid: false, reason: "bad_signature" };

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "invalid_payload" };
  }
  const payload = parseLicensePayload(decoded);
  if (!payload) return { valid: false, reason: "invalid_payload" };

  if (Date.parse(payload.issuedAt) > now + 24 * 60 * 60 * 1000) {
    // A day of clock skew is tolerated.
    return { valid: false, reason: "not_yet_valid", payload };
  }
  if (Date.parse(payload.expiresAt) <= now) return { valid: false, reason: "expired", payload };
  return { valid: true, payload };
}

/** Strict payload check; returns a normalised copy or undefined. */
export function parseLicensePayload(input: unknown): LicensePayload | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const r = input as Record<string, unknown>;
  if (typeof r.licensee !== "string" || !r.licensee.trim() || r.licensee.length > 200) return undefined;
  if (r.edition !== "enterprise") return undefined;
  if (typeof r.seats !== "number" || !Number.isInteger(r.seats) || r.seats < 0) return undefined;
  if (!Array.isArray(r.features) || r.features.length > 100 || !r.features.every((f) => typeof f === "string" && f.length <= 64)) return undefined;
  if (typeof r.issuedAt !== "string" || !Number.isFinite(Date.parse(r.issuedAt))) return undefined;
  if (typeof r.expiresAt !== "string" || !Number.isFinite(Date.parse(r.expiresAt))) return undefined;
  return {
    licensee: r.licensee.trim(),
    edition: "enterprise",
    seats: r.seats,
    features: [...new Set(r.features as string[])],
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt
  };
}

/**
 * Sign a payload into a token. Used by tests and by tooling that holds a
 * private key; the gateway never calls it. `privateKey` is a PEM (PKCS#8)
 * string or a KeyObject.
 */
export function signLicense(payload: LicensePayload, privateKey: string | KeyObject): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const message = Buffer.from(`${LICENSE_TOKEN_PREFIX}.${payloadPart}`, "ascii");
  const signature = signBytes(null, message, privateKey);
  return `${LICENSE_TOKEN_PREFIX}.${payloadPart}.${signature.toString("base64url")}`;
}

/** Raw base64url public key of an Ed25519 KeyObject (for SIBYL_LICENSE_PUBLIC_KEYS). */
export function exportLicensePublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 public key");
  return jwk.x;
}

function toPublicKey(raw: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
  } catch {
    return undefined;
  }
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
