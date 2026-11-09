/**
 * Encryption for stored secrets: AES-256-GCM with a random 12-byte IV per
 * value, authenticated together with the owner and secret name (so a
 * ciphertext copied onto another secret fails to decrypt).
 *
 * The 32-byte master key comes from SIBYL_SECRET_KEY (base64) or is generated
 * once into $SIBYL_DATA_DIR/secret.key with mode 0600.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET_KEY_FILE = "secret.key";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretKeyError extends Error {}

export interface MasterKey {
  key: Buffer;
  source: "env" | "file" | "generated" | "ephemeral";
  file?: string;
}

/** Load (or create) the master key. Never logs key material. */
export function loadMasterKey(
  env: NodeJS.ProcessEnv,
  log: (event: string, fields?: Record<string, unknown>) => void = () => undefined
): MasterKey {
  const fromEnv = env.SIBYL_SECRET_KEY?.trim();
  if (fromEnv) return { key: decodeKey(fromEnv, "SIBYL_SECRET_KEY"), source: "env" };

  if (env.SIBYL_STORAGE?.trim().toLowerCase() === "memory") {
    // Nothing persists in memory mode, so neither should the key.
    log("secrets.key_ephemeral", { reason: "SIBYL_STORAGE=memory" });
    return { key: randomBytes(32), source: "ephemeral" };
  }

  const dataDir = env.SIBYL_DATA_DIR?.trim() || "./data";
  const file = join(dataDir, SECRET_KEY_FILE);
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      try {
        chmodSync(file, 0o600);
        log("secrets.key_permissions_fixed", { file });
      } catch {
        log("secrets.key_permissions_open", { file, mode: mode.toString(8) });
      }
    }
    return { key: decodeKey(readFileSync(file, "utf8").trim(), file), source: "file", file };
  }

  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  // "wx": never overwrite a key another process just wrote.
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  log("secrets.key_generated", {
    file,
    hint: "Back up this file (or set SIBYL_SECRET_KEY): without it, stored secrets cannot be decrypted."
  });
  return { key, source: "generated", file };
}

function decodeKey(text: string, where: string): Buffer {
  const key = Buffer.from(text, "base64");
  if (key.length !== 32 || !/^[A-Za-z0-9+/=_-]+$/.test(text)) {
    throw new SecretKeyError(`${where} must be 32 random bytes, base64-encoded (e.g. \`openssl rand -base64 32\`)`);
  }
  return key;
}

function aad(ownerId: string, name: string): Buffer {
  return Buffer.from(`sibyl.secret.${VERSION}\u0000${ownerId}\u0000${name}`, "utf8");
}

export function encryptValue(key: Buffer, ownerId: string, name: string, value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(ownerId, name));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, body]).toString("base64")}`;
}

/** Throws when the key is wrong or the ciphertext was changed. */
export function decryptValue(key: Buffer, ownerId: string, name: string, ciphertext: string): string {
  const [version, payload] = ciphertext.split(":", 2);
  if (version !== VERSION || !payload) throw new Error("unsupported secret format");
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("secret ciphertext is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(aad(ownerId, name));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}
