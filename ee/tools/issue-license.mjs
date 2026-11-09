#!/usr/bin/env node
/**
 * Sibyl Enterprise — licence key issuer (Sibyl Enterprise License, ee/LICENSE).
 *
 * Generate the signing keypair (once, OFFLINE, on a trusted machine; keep the
 * private key out of every repository and backup it like a root credential):
 *
 *   node ee/tools/issue-license.mjs keygen --out /secure/dir
 *     → writes /secure/dir/sibyl-license-signing.pem (mode 0600)
 *     → prints ONLY the public key; put it in SIBYL_LICENSE_PUBLIC_KEYS
 *       (packages/core/src/license.ts)
 *
 * Issue a key:
 *
 *   SIBYL_LICENSE_PRIVATE_KEY_FILE=/secure/dir/sibyl-license-signing.pem \
 *   node ee/tools/issue-license.mjs issue \
 *     --licensee "Acme Ltd" --seats 50 --days 365 \
 *     --features custom_roles,policies,sso,scim,audit_log,usage_advanced
 *     (or --features all)
 *
 * The key (sibyl1.<payload>.<signature>) is printed to stdout. Nothing secret
 * is printed. The format matches packages/core/src/license.ts.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FEATURES = [
  "custom_roles",
  "policies",
  "sso",
  "scim",
  "audit_log",
  "usage_advanced",
  "connector_hubspot",
  "connector_salesforce",
  "recordings"
];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(arg);
  }
  return args;
}

function fail(message) {
  console.error(`issue-license: ${message}`);
  process.exit(1);
}

function keygen(args) {
  if (typeof args.out !== "string") fail("keygen needs --out <directory outside the repository>");
  const dir = resolve(args.out);
  const file = join(dir, "sibyl-license-signing.pem");
  if (existsSync(file)) fail(`${file} already exists; refusing to overwrite a signing key`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`Private key written to ${file} (keep it secret, never commit it).`);
  console.log(`Public key (add to SIBYL_LICENSE_PUBLIC_KEYS): ${publicKey.export({ format: "jwk" }).x}`);
}

function issue(args) {
  const keyFile = process.env.SIBYL_LICENSE_PRIVATE_KEY_FILE;
  if (!keyFile) fail("set SIBYL_LICENSE_PRIVATE_KEY_FILE to the signing key (PEM, PKCS#8)");
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(keyFile));
  } catch (error) {
    fail(`cannot read the signing key: ${error.message}`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("the signing key must be Ed25519");

  const licensee = typeof args.licensee === "string" ? args.licensee.trim() : "";
  if (!licensee) fail("--licensee is required");
  const seats = Number(args.seats ?? 0);
  if (!Number.isInteger(seats) || seats < 0) fail("--seats must be a whole number");
  const days = Number(args.days ?? 365);
  if (!Number.isFinite(days) || days <= 0) fail("--days must be positive");
  const featureArg = typeof args.features === "string" ? args.features : "";
  const features = featureArg === "all" ? FEATURES : featureArg.split(",").map((f) => f.trim()).filter(Boolean);
  if (features.length === 0) fail(`--features is required (comma-separated, or "all"): ${FEATURES.join(", ")}`);
  const unknown = features.filter((f) => !FEATURES.includes(f));
  if (unknown.length) fail(`unknown features: ${unknown.join(", ")}`);

  const issuedAt = new Date();
  const payload = {
    licensee,
    edition: "enterprise",
    seats,
    features: [...new Set(features)],
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(`sibyl1.${payloadPart}`, "ascii"), privateKey);
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
  console.error(`Signed for ${licensee} (${seats} seats, ${payload.features.join(", ")}), expires ${payload.expiresAt}; public key ${publicKey}`);
  console.log(`sibyl1.${payloadPart}.${signature.toString("base64url")}`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (command === "keygen") keygen(args);
else if (command === "issue") issue(args);
else {
  console.error("usage: issue-license.mjs keygen --out <dir> | issue --licensee <name> --seats <n> --days <n> --features <list|all>");
  process.exit(command ? 1 : 0);
}
