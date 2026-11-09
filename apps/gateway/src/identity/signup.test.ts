/**
 * Sign-up and the sign-in methods beyond a password, end to end over HTTP:
 * hosted (codes, links, Google / Microsoft through a local OIDC provider,
 * single-use tickets, one person in two organizations) and self-hosted
 * (sign-in only, for people who have an account).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@open-gpt-live/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGatewayServer, type GatewayProviders, type GatewayServerHandle } from "../gateway.js";
import { createMailer, type MailMessage } from "../notifications/mailer.js";
import { createRuntime, createTestRuntime, openSharedRuntime, type GatewayRuntime } from "../runtime.js";
import { createHostedRouting } from "../tenancy/hosted.js";
import { totpCode } from "./totp.js";
import { OrganizationService } from "../tenancy/organizations.js";
import { TenantRegistry, type TenantHandle } from "../tenancy/registry.js";
import { IdentityService } from "./service.js";
import { SignupService, emailVouched } from "./signup.js";
import { SignupTickets } from "./signup-tickets.js";
import { startTestIdp, type TestIdp } from "./testing-idp.js";

const PASSWORD = "correct horse battery";
const providers: GatewayProviders = { llm: { async *streamText() {} }, stt: { async transcribe() { return { text: "" }; } } };

/** A tiny cookie jar + fetch for one browser. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly base: string) {}
  get cookie(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(path.startsWith("http") ? path : `${this.base}${path}`, {
      method,
      redirect: "manual",
      headers: { "content-type": "application/json", ...(this.cookies.size ? { cookie: this.cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      if (/Max-Age=0/.test(line) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, body: json, location: response.headers.get("location") ?? "" };
  }
  /** Continue with Google: start at the gateway, approve at the IdP, come back. */
  async google(next = "/") {
    const start = await this.call("GET", `/api/signup/oauth/google/start?next=${encodeURIComponent(next)}`);
    expect(start.status).toBe(302);
    const approved = await fetch(start.location, { redirect: "manual" });
    return this.call("GET", approved.headers.get("location")!);
  }
}

describe("hosted sign-up", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sibyl-signup-"));
  const mail: MailMessage[] = [];
  let idp: TestIdp;
  let gateway: GatewayServerHandle;
  let registry: TenantRegistry<TenantHandle & { runtime: GatewayRuntime; providers: GatewayProviders }>;
  let shared: Awaited<ReturnType<typeof openSharedRuntime>>;
  let base = "";
  const lastCode = () => /^(\d{6}) is your Sibyl code$/.exec(mail.at(-1)!.subject)![1]!;
  const lastLink = () => /token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1)!.text)![1]!;

  beforeAll(async () => {
    idp = await startTestIdp({ clientId: "sibyl-test", clientSecret: "idp-secret" });
    const env: NodeJS.ProcessEnv = {
      SIBYL_STORAGE: "memory",
      SIBYL_DATA_DIR: dataDir,
      SIBYL_SECRET_KEY: randomBytes(32).toString("base64"),
      SIBYL_COMPUTERS: "off",
      SIBYL_MODE: "hosted",
      SIBYL_SIGNIN_GOOGLE_CLIENT_ID: "sibyl-test",
      SIBYL_SIGNIN_GOOGLE_CLIENT_SECRET: "idp-secret",
      SIBYL_SIGNIN_GOOGLE_ISSUER: idp.issuer,
      SIBYL_SIGNIN_ALLOW_PRIVATE_NETWORK: "true",
      SIBYL_APP_URL: "http://app.test"
    };
    shared = await openSharedRuntime(env, () => undefined);
    registry = new TenantRegistry({
      hosted: true,
      idleMs: 60_000,
      build: async (orgId) => {
        const runtime = await createRuntime({ env, log: () => undefined, orgId, shared, hosted: true });
        return { orgId, runtime, providers, busy: () => false, tick: () => Promise.resolve(), close: () => runtime.close() };
      },
      dueOrganizations: async () => []
    });
    const organizations = new OrganizationService({ store: shared.store, env });
    const signup = new SignupService({
      store: shared.store,
      env,
      hosted: true,
      tickets: organizations.tickets,
      masterKey: randomBytes(32),
      mailer: createMailer({ env, transport: async () => ({ sendMail: async (message) => void mail.push(message) }) })!
    });
    const routing = createHostedRouting({ store: shared.store, organizations, signup, env, loaded: () => registry.loaded() });
    gateway = await createGatewayServer({
      providers,
      host: "127.0.0.1",
      env,
      tenants: {
        hosted: true,
        acquire: (orgId) => registry.get(orgId),
        orgFor: routing.orgFor,
        hold: (orgId) => registry.hold(orgId),
        touch: (orgId) => registry.touch(orgId),
        onUnload: (listener) => registry.onUnload(listener),
        handleHosted: routing.handleHosted
      }
    });
    base = `http://127.0.0.1:${gateway.port}`;
  }, 30_000);

  afterAll(async () => {
    await gateway?.close();
    await registry?.close();
    await shared?.store.close();
    await idp?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("the sign-up screen learns what this server offers", async () => {
    const options = await new Browser(base).call("GET", "/api/signup/options");
    expect(options.body).toEqual({ hosted: true, google: true, microsoft: false, email: true });
  });

  test("password sign-up: a hashed, expiring code, then one organization per ticket", async () => {
    const browser = new Browser(base);
    expect((await browser.call("POST", "/api/signup/email", { email: "ann@acme.test", method: "password", password: "short" })).status).toBe(400);
    const sent = await browser.call("POST", "/api/signup/email", { email: "Ann@Acme.test", method: "password", password: PASSWORD });
    expect(sent.body).toMatchObject({ sent: true, email: "ann@acme.test", method: "password" });
    const code = lastCode();
    // Only an HMAC of the code is stored.
    expect(JSON.stringify(await shared.store.kv.get("_signup", `signup.code.${(await import("node:crypto")).createHash("sha256").update("ann@acme.test").digest("hex")}`))).not.toContain(code);
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await browser.call("POST", "/api/signup/code", { email: "ann@acme.test", code: wrong })).body).toMatchObject({ error: "invalid_code" });
    const verified = await browser.call("POST", "/api/signup/code", { email: "ann@acme.test", code });
    expect(verified.body).toEqual({ next: "org", email: "ann@acme.test", provider: "password", expiresAt: expect.any(Number) });
    expect(browser.cookies.get("sibyl_signup")).toBeTruthy();
    // The code is used up.
    expect((await browser.call("POST", "/api/signup/code", { email: "ann@acme.test", code })).status).toBe(410);
    expect((await browser.call("GET", "/api/signup/ticket")).body).toMatchObject({ email: "ann@acme.test", provider: "password" });

    const ticket = browser.cookies.get("sibyl_signup")!;
    // A bad name doesn't burn the ticket.
    expect((await browser.call("POST", "/api/orgs", { orgName: " " })).status).toBe(400);
    const created = await browser.call("POST", "/api/orgs", { orgName: "Acme", workspaceName: "General" });
    expect(created.status).toBe(201);
    expect(browser.cookies.has("sibyl_signup")).toBe(false);
    const me = await browser.call("GET", "/api/auth/me");
    expect(me.body).toMatchObject({ authenticated: true, user: { email: "ann@acme.test" }, organization: { name: "Acme" } });
    // Single use: the same ticket can't make a second organization.
    const replay = await new Browser(base).call("POST", "/api/orgs", { orgName: "Acme again" }, { "x-sibyl-signup-ticket": ticket });
    expect(replay.status).toBe(403);
    // The password chosen at sign-up signs in.
    const login = await new Browser(base).call("POST", "/api/auth/login", { email: "ann@acme.test", password: PASSWORD });
    expect(login.body).toMatchObject({ authenticated: true });
  });

  test("two-step sign-in works in hosted mode: the challenge names its organization", async () => {
    const browser = new Browser(base);
    await browser.call("POST", "/api/signup/email", { email: "tess@two.test", method: "password", password: PASSWORD });
    expect((await browser.call("POST", "/api/signup/code", { email: "tess@two.test", code: lastCode() })).status).toBe(200);
    const created = await browser.call("POST", "/api/orgs", { orgName: "Two Step" });
    expect(created.status).toBe(201);
    const orgId = (created.body as { org: { id: string } }).org.id;
    const setup = (await browser.call("POST", "/api/auth/mfa/setup", {})).body as { secret: string; setupToken: string };
    expect((await browser.call("POST", "/api/auth/mfa/enable", { setupToken: setup.setupToken, code: totpCode(setup.secret, Date.now()) })).status).toBe(200);

    const again = new Browser(base);
    const login = await again.call("POST", "/api/auth/login", { email: "tess@two.test", password: PASSWORD });
    const mfa = (login.body as { mfa?: { challenge: string; org?: string } }).mfa!;
    expect(mfa.org).toBe(orgId);
    // The next 30-second window: the code used to enable can't be replayed.
    const code = totpCode(setup.secret, Date.now() + 30_000);
    const verified = await again.call("POST", "/api/auth/mfa/verify", { challenge: mfa.challenge, code }, { "x-sibyl-org": mfa.org! });
    expect(verified.status).toBe(200);
    expect((await again.call("GET", "/api/auth/me")).body).toMatchObject({ authenticated: true, user: { email: "tess@two.test" } });
  });

  test("five wrong codes end the code", async () => {
    const browser = new Browser(base);
    await browser.call("POST", "/api/signup/email", { email: "five@acme.test", method: "password", password: PASSWORD });
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i += 1) expect((await browser.call("POST", "/api/signup/code", { email: "five@acme.test", code: wrong })).status).toBe(400);
    expect((await browser.call("POST", "/api/signup/code", { email: "five@acme.test", code: wrong })).status).toBe(410);
    expect((await browser.call("POST", "/api/signup/code", { email: "five@acme.test", code })).status).toBe(410);
  });

  test("magic link: sign-up for a new address, sign-in for an existing one, one use each", async () => {
    const browser = new Browser(base);
    await browser.call("POST", "/api/signup/email", { email: "bo@beta.test", method: "magic_link" });
    expect(mail.at(-1)).toMatchObject({ to: "bo@beta.test", subject: "Finish signing up for Sibyl" });
    expect(mail.at(-1)!.text).toContain("http://app.test/signup/link?token=");
    const token = decodeURIComponent(lastLink());
    expect((await browser.call("POST", "/api/signup/link", { token })).body).toMatchObject({ next: "org", email: "bo@beta.test", provider: "magic_link" });
    expect((await browser.call("POST", "/api/signup/link", { token })).status).toBe(410);
    expect((await browser.call("POST", "/api/orgs", { orgName: "Beta" })).status).toBe(201);

    const later = new Browser(base);
    await later.call("POST", "/api/signup/email", { email: "bo@beta.test", method: "magic_link", next: "/agents" });
    expect(mail.at(-1)!.subject).toBe("Your Sibyl sign-in link");
    const signedIn = await later.call("POST", "/api/signup/link", { token: decodeURIComponent(lastLink()) });
    expect(signedIn.body).toEqual({ next: "app", path: "/agents" });
    expect((await later.call("GET", "/api/auth/me")).body).toMatchObject({ authenticated: true, user: { email: "bo@beta.test" }, organization: { name: "Beta" } });
  });

  test("sends are rate-limited per address", async () => {
    const browser = new Browser(base);
    for (let i = 0; i < 5; i += 1) expect((await browser.call("POST", "/api/signup/email", { email: "spam@x.test", method: "magic_link" })).status).toBe(200);
    const blocked = await browser.call("POST", "/api/signup/email", { email: "spam@x.test", method: "magic_link" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
  });

  test("Continue with Google: signs up, links the Google account, and signs the same person in later", async () => {
    idp.claims = { sub: "google-123", email: "cy@gamma.test", email_verified: true, name: "Cy Gamma" };
    const browser = new Browser(base);
    const back = await browser.google("/welcome");
    expect(back.status).toBe(302);
    expect(back.location).toBe("http://app.test/signup/org");
    expect((await browser.call("GET", "/api/signup/ticket")).body).toMatchObject({ email: "cy@gamma.test", name: "Cy Gamma", provider: "google" });
    expect((await browser.call("POST", "/api/orgs", { orgName: "Gamma" })).status).toBe(201);
    const [user] = await shared.store.identity.users.listByEmail("cy@gamma.test");
    expect(user!.links).toEqual([{ provider: "google", subject: "google-123", linkedAt: expect.any(Number) }]);

    const later = new Browser(base);
    const signedIn = await later.google("/knowledge");
    expect(signedIn.location).toBe("http://app.test/knowledge");
    expect((await later.call("GET", "/api/auth/me")).body).toMatchObject({ authenticated: true, user: { email: "cy@gamma.test" } });

    // A different Google account with the same address isn't this person.
    idp.claims = { sub: "google-999", email: "cy@gamma.test", email_verified: true };
    const other = await new Browser(base).google();
    expect(other.location).toBe("http://app.test/signup/org");
  });

  test("Google must vouch for the address, and the browser that started must finish", async () => {
    idp.claims = { sub: "google-x", email: "dee@delta.test", email_verified: false };
    const unverified = await new Browser(base).google();
    expect(unverified.location).toBe("http://app.test/signup?signin_error=email_unverified&provider=google");

    idp.claims = { sub: "google-y", email: "eve@eps.test", email_verified: true };
    const started = new Browser(base);
    const start = await started.call("GET", "/api/signup/oauth/google/start");
    const approved = await fetch(start.location, { redirect: "manual" });
    // Another browser (no binding cookie) brings the code back.
    const stolen = await new Browser(base).call("GET", approved.headers.get("location")!);
    expect(stolen.location).toBe("http://app.test/signup?signin_error=browser_mismatch&provider=google");
  });

  test("an invitation accepted with Google: the address must match; the account is created, linked and signed in", async () => {
    const ann = new Browser(base);
    await ann.call("POST", "/api/auth/login", { email: "ann@acme.test", password: PASSWORD });
    const inviteToken = (email: string) =>
      ann.call("POST", "/api/invites", { workspaceId: "default", role: "member", email }).then((r) => String(r.body.url).split("/invite/")[1]!);
    const viaGoogle = async (browser: Browser, token: string) => {
      const start = await browser.call("GET", `/api/signup/oauth/google/start?invite=${encodeURIComponent(token)}`);
      expect(start.status).toBe(302);
      const approved = await fetch(start.location, { redirect: "manual" });
      return browser.call("GET", approved.headers.get("location")!);
    };
    const token = await inviteToken("gus@acme.test");

    // Another Google account (another address): refused, the invitation stays unused.
    idp.claims = { sub: "google-mallory", email: "mallory@evil.test", email_verified: true };
    const wrong = await viaGoogle(new Browser(base), token);
    expect(wrong.location).toBe(`http://app.test/invite/${token}?signin_error=wrong_account&provider=google`);
    // Google must vouch for the address.
    idp.claims = { sub: "google-gus", email: "gus@acme.test", email_verified: false };
    expect((await viaGoogle(new Browser(base), token)).location).toBe(`http://app.test/invite/${token}?signin_error=email_unverified&provider=google`);
    // A bad token is refused before leaving for Google.
    expect((await new Browser(base).call("GET", "/api/signup/oauth/google/start?invite=bad%20token")).location).toContain("signin_error=invite_not_found");

    idp.claims = { sub: "google-gus", email: "Gus@Acme.test", email_verified: true, name: "Gus" };
    const gus = new Browser(base);
    const joined = await viaGoogle(gus, token);
    expect(joined.location).toBe(`http://app.test/invite/${token}?joined=default&new=1`);
    expect((await gus.call("GET", "/api/auth/me")).body).toMatchObject({ authenticated: true, user: { email: "gus@acme.test", name: "Gus" }, organization: { name: "Acme" } });
    const account = (await shared.store.identity.users.listByEmail("gus@acme.test"))[0]!;
    expect(account).toMatchObject({ passwordHash: "none", links: [{ provider: "google", subject: "google-gus", linkedAt: expect.any(Number) }], emailVerifiedAt: expect.any(Number) });
    // Used once.
    idp.claims = { sub: "google-gus", email: "gus@acme.test", email_verified: true };
    expect((await viaGoogle(new Browser(base), token)).location).toBe(`http://app.test/invite/${token}?signin_error=invite_used&provider=google`);

    // An existing account joins another workspace with its linked Google account; a different Google account with its address can't.
    const workspace = await ann.call("POST", "/api/workspaces", { name: "Sales" });
    const salesId = String(workspace.body.workspace?.id ?? workspace.body.id);
    const second = String((await ann.call("POST", "/api/invites", { workspaceId: salesId, role: "viewer", email: "gus@acme.test" })).body.url).split("/invite/")[1]!;
    idp.claims = { sub: "google-impostor", email: "gus@acme.test", email_verified: true };
    expect((await viaGoogle(new Browser(base), second)).location).toBe(`http://app.test/invite/${second}?signin_error=wrong_account&provider=google`);
    idp.claims = { sub: "google-gus", email: "gus@acme.test", email_verified: true };
    expect((await viaGoogle(new Browser(base), second)).location).toBe(`http://app.test/invite/${second}?joined=${salesId}`);
    const orgId = account.orgId;
    expect((await shared.store.identity.memberships.listForUser(orgId, account.id)).some((m) => m.scope !== "org" && m.scope.workspaceId === salesId && m.role === "viewer")).toBe(true);
  });

  test("one address in two organizations chooses one", async () => {
    // Fay owns one organization, and is invited into Acme.
    const fay = new Browser(base);
    await fay.call("POST", "/api/signup/email", { email: "fay@zeta.test", method: "magic_link" });
    await fay.call("POST", "/api/signup/link", { token: decodeURIComponent(lastLink()) });
    expect((await fay.call("POST", "/api/orgs", { orgName: "Zeta" })).status).toBe(201);
    const ann = new Browser(base);
    await ann.call("POST", "/api/auth/login", { email: "ann@acme.test", password: PASSWORD });
    const invite = await ann.call("POST", "/api/invites", { workspaceId: "default", role: "member", email: "fay@zeta.test" });
    const inviteToken = String(invite.body.url).split("/invite/")[1]!;
    expect((await new Browser(base).call("POST", `/api/invites/${inviteToken}/accept`, { name: "Fay", password: PASSWORD })).status).toBe(200);

    const browser = new Browser(base);
    await browser.call("POST", "/api/signup/email", { email: "fay@zeta.test", method: "magic_link" });
    const result = await browser.call("POST", "/api/signup/link", { token: decodeURIComponent(lastLink()) });
    expect(result.body.next).toBe("choose");
    expect(result.body.organizations.map((org: { name: string }) => org.name).sort()).toEqual(["Acme", "Zeta"]);
    expect((await browser.call("GET", "/api/signup/choose")).body.organizations).toHaveLength(2);
    const acme = result.body.organizations.find((org: { name: string }) => org.name === "Acme");
    expect((await browser.call("POST", "/api/signup/choose", { org: acme.id })).body).toEqual({ next: "app", path: "/" });
    expect((await browser.call("GET", "/api/auth/me")).body).toMatchObject({ authenticated: true, organization: { name: "Acme" } });
    expect((await browser.call("POST", "/api/signup/choose", { org: acme.id })).status).toBe(410);
  });
});

describe("self-hosted sign-in methods", () => {
  test("links and Google only sign in people who have an account; no sign-up", async () => {
    const idp = await startTestIdp({ clientId: "self", clientSecret: "s3cret" });
    const mail: MailMessage[] = [];
    const env: NodeJS.ProcessEnv = {
      SIBYL_SIGNIN_GOOGLE_CLIENT_ID: "self",
      SIBYL_SIGNIN_GOOGLE_CLIENT_SECRET: "s3cret",
      SIBYL_SIGNIN_GOOGLE_ISSUER: idp.issuer,
      SIBYL_SIGNIN_ALLOW_PRIVATE_NETWORK: "true",
      SIBYL_APP_URL: "http://app.test"
    };
    const store = createMemoryStore();
    const runtime = createTestRuntime({ store });
    const identity = new IdentityService({ store, orgId: runtime.ownerId });
    await identity.setup({ email: "owner@home.test", name: "Olive", password: PASSWORD }, { ownerTokenOk: false });
    const signup = new SignupService({
      store,
      env,
      hosted: false,
      tickets: new SignupTickets(randomBytes(32), store),
      masterKey: randomBytes(32),
      mailer: createMailer({ env, transport: async () => ({ sendMail: async (message) => void mail.push(message) }) })!
    });
    const gateway = await createGatewayServer({ providers, host: "127.0.0.1", env, runtime, identity, signup });
    const base = `http://127.0.0.1:${gateway.port}`;
    try {
      const browser = new Browser(base);
      expect((await browser.call("GET", "/api/signup/options")).body).toEqual({ hosted: false, google: true, microsoft: false, email: true });
      // No password sign-up, and no email for an unknown address (same answer).
      expect((await browser.call("POST", "/api/signup/email", { email: "x@home.test", method: "password", password: PASSWORD })).status).toBe(404);
      expect((await browser.call("POST", "/api/signup/email", { email: "stranger@home.test", method: "magic_link" })).status).toBe(200);
      expect(mail).toHaveLength(0);
      await browser.call("POST", "/api/signup/email", { email: "owner@home.test", method: "magic_link" });
      expect(mail).toHaveLength(1);
      const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail[0]!.text)![1]!);
      expect((await browser.call("POST", "/api/signup/link", { token })).body).toEqual({ next: "app", path: "/" });
      expect((await browser.call("GET", "/api/auth/me")).body).toMatchObject({ authenticated: true, user: { email: "owner@home.test" } });

      idp.claims = { sub: "g-owner", email: "owner@home.test", email_verified: true };
      const google = new Browser(base);
      expect((await google.google("/agents")).location).toBe("http://app.test/agents");
      idp.claims = { sub: "g-stranger", email: "stranger@home.test", email_verified: true };
      expect((await new Browser(base).google()).location).toBe("http://app.test/login?signin_error=no_account&provider=google");
    } finally {
      await gateway.close();
      await idp.close();
    }
  });
});

describe("Microsoft email checks", () => {
  test("personal accounts and verified domains count; others don't", () => {
    expect(emailVouched("microsoft", { claims: { tid: "9188040d-6c67-4c5b-b112-36a304b66dad" } })).toBe(true);
    expect(emailVouched("microsoft", { claims: { xms_edov: true } })).toBe(true);
    expect(emailVouched("microsoft", { claims: { tid: "some-company" } })).toBe(false);
    expect(emailVouched("google", { claims: {} })).toBe(false);
    expect(emailVouched("google", { emailVerified: true, claims: {} })).toBe(true);
  });
});
