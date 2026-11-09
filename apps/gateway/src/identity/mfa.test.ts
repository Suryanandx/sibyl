import { randomBytes } from "node:crypto";
import { createMemoryStore, type IdentityExtension } from "@open-gpt-live/core";
import { describe, expect, it } from "vitest";
import { MFA_KV_KEY } from "./mfa.js";
import { IdentityService, type SignInResult } from "./service.js";
import { base32Decode, base32Encode, hotp, totpCode, verifyTotp } from "./totp.js";

const PASSWORD = "correct horse battery";

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vectors (SHA-1)", () => {
    // RFC 6238 appendix B: secret "12345678901234567890", 8 digits.
    const secret = Buffer.from("12345678901234567890");
    expect(hotp(secret, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(hotp(secret, Math.floor(20000000000 / 30), 8)).toBe("65353130");
    // RFC 4226 appendix D (HOTP, 6 digits).
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(["755224", "287082", "359152", "520489"]);
  });

  it("round-trips base32 and accepts ±1 step, never the same step twice", () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    const secret = base32Encode(bytes);
    const now = 1_700_000_000_000;
    const step = verifyTotp(secret, totpCode(secret, now), now);
    expect(step).toBeDefined();
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(step! - 1);
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBeUndefined();
    expect(verifyTotp(secret, totpCode(secret, now), now, step)).toBeUndefined();
    expect(verifyTotp(secret, "12345", now)).toBeUndefined();
  });
});

function service(options: { extensions?: IdentityExtension[]; now?: () => number } = {}) {
  const store = createMemoryStore();
  const key = randomBytes(32);
  let n = 0;
  const identity = new IdentityService({
    store,
    orgId: "owner",
    createId: () => `id${++n}`,
    secretKey: () => key,
    ...(options.now ? { now: options.now } : {}),
    ...(options.extensions ? { extensions: () => options.extensions! } : {})
  });
  return { store, identity };
}

const tokenOf = (result: SignInResult) => {
  if (!("token" in result)) throw new Error("expected a session");
  return result.token;
};

describe("two-step verification", () => {
  it("is off by default and, once on, needs a code (once) or a recovery code (once)", async () => {
    let now = 1_700_000_000_000;
    const { store, identity } = service({ now: () => now });
    const { user } = await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false });
    tokenOf(await identity.login({ email: "o@example.com", password: PASSWORD }, "ip"));

    const setup = identity.mfa.beginSetup(user);
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Sibyl:o%40example\.com\?secret=/);
    expect(await identity.mfa.enable(user.id, setup.setupToken, "000000")).toBeUndefined();
    const codes = await identity.mfa.enable(user.id, setup.setupToken, totpCode(setup.secret, now));
    expect(codes).toHaveLength(10);
    // The secret is stored encrypted, never in clear.
    expect(JSON.stringify(await store.kv.get("owner", MFA_KV_KEY))).not.toContain(setup.secret);

    now += 60_000;
    const first = await identity.login({ email: "o@example.com", password: PASSWORD }, "ip");
    expect("mfa" in first && first.mfa.step).toBe("verify");
    const challenge = (first as { mfa: { challenge: string } }).mfa.challenge;
    await expect(identity.completeMfa(challenge, { code: "111111" }, "ip")).rejects.toMatchObject({ code: "invalid_code" });
    const done = await identity.completeMfa(challenge, { code: totpCode(setup.secret, now) }, "ip");
    expect((await identity.resolveSession(done.token))?.user?.id).toBe(user.id);
    // The challenge is used up.
    await expect(identity.completeMfa(challenge, { code: totpCode(setup.secret, now) }, "ip")).rejects.toMatchObject({ code: "challenge_expired" });
    // The same code can't sign in twice.
    const again = (await identity.login({ email: "o@example.com", password: PASSWORD }, "ip")) as { mfa: { challenge: string } };
    await expect(identity.completeMfa(again.mfa.challenge, { code: totpCode(setup.secret, now) }, "ip")).rejects.toMatchObject({ code: "invalid_code" });
    // A recovery code works once.
    await identity.completeMfa(again.mfa.challenge, { recoveryCode: codes![0]!.toUpperCase() }, "ip");
    const third = (await identity.login({ email: "o@example.com", password: PASSWORD }, "ip")) as { mfa: { challenge: string } };
    await expect(identity.completeMfa(third.mfa.challenge, { recoveryCode: codes![0]! }, "ip")).rejects.toMatchObject({ code: "invalid_code" });
    expect((await identity.mfa.status(user.id)).recoveryCodesLeft).toBe(9);
  });

  it("challenges allow five wrong codes", async () => {
    const { identity } = service();
    const { user } = await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false });
    const setup = identity.mfa.beginSetup(user);
    await identity.mfa.enable(user.id, setup.setupToken, totpCode(setup.secret, Date.now()));
    const login = (await identity.login({ email: "o@example.com", password: PASSWORD }, "ip")) as { mfa: { challenge: string } };
    for (let i = 0; i < 5; i += 1) await expect(identity.completeMfa(login.mfa.challenge, { code: "000000" }, "ip")).rejects.toBeTruthy();
    await expect(identity.completeMfa(login.mfa.challenge, { code: totpCode(setup.secret, Date.now() + 30_000) }, "ip")).rejects.toMatchObject({ code: "challenge_expired" });
  });
});

describe("identity extensions", () => {
  it("can require two-step verification: people without it enrol while signing in", async () => {
    const requireMfa: IdentityExtension = { id: "policy", checkSignIn: async () => ({ allow: true, requireMfa: true }) };
    const { identity } = service({ extensions: [requireMfa] });
    const owner = await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false });
    const login = await identity.login({ email: "o@example.com", password: PASSWORD }, "ip");
    if (!("mfa" in login)) throw new Error("expected a challenge");
    expect(login.mfa.step).toBe("enroll");
    const done = await identity.completeMfa(login.mfa.challenge, { code: totpCode(login.mfa.secret!, Date.now()) }, "ip");
    expect(done.recoveryCodes).toHaveLength(10);
    expect(await identity.mfa.enabled(owner.user.id)).toBe(true);
  });

  it("can refuse sign-in and end or refuse sessions; external sign-in uses the same session code", async () => {
    let refuseSignIn = false;
    let session: "ok" | "end" | "refuse" = "ok";
    const seen: string[] = [];
    const extension: IdentityExtension = {
      id: "policy",
      checkSignIn: async (input) => {
        seen.push(`${input.method}:${input.orgRole ?? "-"}:${input.ip}`);
        return refuseSignIn ? { allow: false, code: "sso_required", message: "Use SSO." } : { allow: true };
      },
      checkSession: async () =>
        session === "ok" ? { allow: true } : { allow: false, code: session === "end" ? "session_expired" : "ip_not_allowed", message: "no", end: session === "end" }
    };
    const { store, identity } = service({ extensions: [extension] });
    const owner = await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false });
    const token = tokenOf(await identity.login({ email: "o@example.com", password: PASSWORD }, "10.0.0.1"));
    expect(seen).toEqual(["password:owner:10.0.0.1"]);

    session = "refuse";
    expect(await identity.authenticate({ sessionToken: token, ip: "8.8.8.8" })).toBeUndefined();
    session = "ok";
    expect(await identity.authenticate({ sessionToken: token, ip: "10.0.0.1" })).toBeDefined();
    // Live connections re-check through refresh(): a refusal there closes them.
    const live = (await identity.resolveSession(token))!;
    expect(await identity.refresh(live)).toBeDefined();
    session = "end";
    expect(await identity.refresh(live)).toBeUndefined();
    session = "ok";
    expect(await identity.resolveSession(token)).toBeUndefined(); // ended for good

    refuseSignIn = true;
    await expect(identity.login({ email: "o@example.com", password: PASSWORD }, "ip")).rejects.toMatchObject({ status: 403, code: "sso_required" });
    await expect(identity.signInExternal(owner.user.id, "oidc", "ip")).rejects.toMatchObject({ code: "sso_required" });
    refuseSignIn = false;
    const external = await identity.signInExternal(owner.user.id, "saml", "ip");
    expect((await identity.resolveSession(external.token))?.user?.id).toBe(owner.user.id);
    await identity.endSessions(owner.user.id);
    expect(await identity.resolveSession(external.token)).toBeUndefined();
    await store.identity.users.upsert({ ...owner.user, disabledAt: Date.now() });
    await expect(identity.signInExternal(owner.user.id, "oidc", "ip")).rejects.toMatchObject({ code: "account_disabled" });
  });

  it("without extensions behaves exactly as before (no MFA, 30-day sessions)", async () => {
    const { identity } = service();
    await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false });
    expect(await identity.signInProviders()).toEqual([]);
    const token = tokenOf(await identity.login({ email: "o@example.com", password: PASSWORD }, "ip"));
    expect(await identity.authenticate({ sessionToken: token, ip: "203.0.113.9" })).toBeDefined();
  });
});
