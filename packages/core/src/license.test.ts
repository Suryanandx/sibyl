import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  SIBYL_LICENSE_PUBLIC_KEYS,
  createEnterpriseRegistry,
  createGovernance,
  createFeatureGate,
  exportLicensePublicKey,
  signLicense,
  verifyLicense,
  type LicensePayload
} from "./index";

const keys = generateKeyPairSync("ed25519");
const publicKey = exportLicensePublicKey(keys.publicKey);
const NOW = Date.parse("2026-11-09T12:00:00Z");

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    licensee: "Acme Ltd",
    edition: "enterprise",
    seats: 25,
    features: ["audit_log", "sso", "future_thing"],
    issuedAt: "2026-11-01T00:00:00Z",
    expiresAt: "2027-11-01T00:00:00Z",
    ...overrides
  };
}

describe("verifyLicense", () => {
  test("accepts a correctly signed key", () => {
    const token = signLicense(payload(), keys.privateKey);
    expect(token.startsWith("sibyl1.")).toBe(true);
    const result = verifyLicense(token, [publicKey], NOW);
    expect(result.valid).toBe(true);
    expect(result.payload?.licensee).toBe("Acme Ltd");
  });

  test("rejects missing, malformed and foreign keys", () => {
    expect(verifyLicense(undefined, [publicKey], NOW).reason).toBe("missing");
    expect(verifyLicense("  ", [publicKey], NOW).reason).toBe("missing");
    expect(verifyLicense("hello", [publicKey], NOW).reason).toBe("malformed");
    expect(verifyLicense("sibyl2.abc.def", [publicKey], NOW).reason).toBe("unsupported_version");
    const other = generateKeyPairSync("ed25519");
    const foreign = signLicense(payload(), other.privateKey);
    expect(verifyLicense(foreign, [publicKey], NOW).reason).toBe("bad_signature");
  });

  test("detects a tampered payload", () => {
    const token = signLicense(payload(), keys.privateKey);
    const [v, , sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify(payload({ seats: 9999 }))).toString("base64url");
    expect(verifyLicense(`${v}.${forged}.${sig}`, [publicKey], NOW).reason).toBe("bad_signature");
  });

  test("rejects a signed but invalid payload", () => {
    const token = signLicense({ ...payload(), edition: "basic" } as unknown as LicensePayload, keys.privateKey);
    expect(verifyLicense(token, [publicKey], NOW).reason).toBe("invalid_payload");
  });

  test("expired keys keep the payload but are not valid", () => {
    const token = signLicense(payload({ expiresAt: "2026-11-01T00:00:00Z", issuedAt: "2025-11-01T00:00:00Z" }), keys.privateKey);
    const result = verifyLicense(token, [publicKey], NOW);
    expect(result).toMatchObject({ valid: false, reason: "expired" });
    expect(result.payload?.licensee).toBe("Acme Ltd");
  });

  test("ships exactly one embedded public key, and it is not the test key", () => {
    expect(SIBYL_LICENSE_PUBLIC_KEYS).toHaveLength(1);
    expect(Buffer.from(SIBYL_LICENSE_PUBLIC_KEYS[0]!, "base64url")).toHaveLength(32);
    const token = signLicense(payload(), keys.privateKey);
    expect(verifyLicense(token, undefined, NOW).reason).toBe("bad_signature");
  });
});

describe("createFeatureGate", () => {
  test("open source without a key", () => {
    const gate = createFeatureGate();
    expect(gate).toMatchObject({ edition: "oss", status: "none", features: [] });
    expect(gate.has("audit_log")).toBe(false);
  });

  test("valid key enables only known licensed features", () => {
    const gate = createFeatureGate(verifyLicense(signLicense(payload(), keys.privateKey), [publicKey], NOW));
    expect(gate.edition).toBe("enterprise");
    expect(gate.features).toEqual(["audit_log", "sso"]);
    expect(gate.has("sso")).toBe(true);
    expect(gate.has("scim")).toBe(false);
    expect(gate.has("future_thing")).toBe(false);
    expect(gate).toMatchObject({ licensee: "Acme Ltd", seats: 25, expiresAt: "2027-11-01T00:00:00Z" });
  });

  test("expired key degrades to open source (no lock-out)", () => {
    const token = signLicense(payload({ expiresAt: "2026-11-02T00:00:00Z" }), keys.privateKey);
    const gate = createFeatureGate(verifyLicense(token, [publicKey], NOW));
    expect(gate).toMatchObject({ edition: "oss", status: "expired", features: [], licensee: "Acme Ltd" });
    expect(gate.has("audit_log")).toBe(false);
  });
});

describe("enterprise registry", () => {
  test("installs only licensed modules and collects hooks", async () => {
    const registry = createEnterpriseRegistry();
    const installed: string[] = [];
    registry.registerEnterpriseModule({
      id: "audit",
      feature: "audit_log",
      install(ctx) {
        installed.push("audit");
        ctx.registerHttpRoute(() => false);
        ctx.registerPermissionPolicy(() => undefined);
      }
    });
    registry.registerEnterpriseModule({ id: "scim", feature: "scim", install: () => void installed.push("scim") });
    registry.registerEnterpriseModule({
      id: "broken",
      feature: "sso",
      install() {
        throw new Error("boom");
      }
    });
    expect(() => registry.registerEnterpriseModule({ id: "audit", feature: "audit_log", install() {} })).toThrow();
    const gate = createFeatureGate(verifyLicense(signLicense(payload(), keys.privateKey), [publicKey], NOW));
    const result = await registry.install({
      gate,
      ownerId: "owner",
      env: {},
      store: {} as never,
      tools: {} as never,
      meter: {} as never,
      log: () => {},
      governance: createGovernance({ orgId: "owner" })
    });
    expect(installed).toEqual(["audit"]);
    expect(result.installed).toEqual(["audit"]);
    expect(result.skipped.map((s) => s.id)).toEqual(["scim"]);
    expect(result.failed).toEqual([{ id: "broken", error: "boom" }]);
    expect(result.httpRoutes).toHaveLength(1);
    expect(result.permissionPolicies).toHaveLength(1);
  });
});
