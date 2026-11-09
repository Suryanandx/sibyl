import { randomBytes } from "node:crypto";
import { createMemoryStore, createToolRegistry, type Principal, type ToolContext, type ToolRegistry } from "@open-gpt-live/core";
import { afterEach, describe, expect, it } from "vitest";
import { SecretVault } from "../secrets/vault.js";
import { redactSecrets } from "../secrets/redact.js";
import { freeSlots } from "./common.js";
import { googleConnector } from "./google/index.js";
import { createConnectorHttp, retryAfterMs } from "./http-client.js";
import { microsoftConnector } from "./microsoft/index.js";
import { ConnectorService } from "./service.js";
import { authorizeParams, startFakeVendor, userPrincipal, type FakeVendor } from "./testing.js";
import { toModelText } from "./trim.js";
import { CONNECTIONS_KV_KEY, CREDENTIALS_KV_KEY } from "./store.js";

const GOOGLE_SCOPES = googleConnector.groups.flatMap((g) => g.scopes).concat(["openid", "email", "profile"]).join(" ");
const MS_SCOPES = "openid profile email User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.Read Calendars.ReadWrite Files.Read.All Sites.Read.All Files.ReadWrite Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send";

const owner = userPrincipal("u-owner", { default: "owner", sales: "owner" }, "owner");
const admin = userPrincipal("u-admin", { default: "admin" }, "member");
const member = userPrincipal("u-member", { default: "member" }, "member");
const other = userPrincipal("u-other", { default: "member" }, "member");
const viewer = userPrincipal("u-viewer", { default: "viewer" }, "member");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const store = createMemoryStore();
  const key = randomBytes(32);
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const log = (event: string, fields?: Record<string, unknown>) => void logs.push({ event, ...(fields ? { fields } : {}) });
  const vault = new SecretVault({ store, key, log });
  const tools: ToolRegistry = createToolRegistry();
  const google = await startFakeVendor({ clientId: "google-client", clientSecret: "google-secret-value", scope: GOOGLE_SCOPES });
  const microsoft = await startFakeVendor({ clientId: "ms-client", clientSecret: "ms-secret-value", scope: MS_SCOPES });
  const clock = { now: 1_800_000_000_000 };
  const sleeps: number[] = [];
  const service = await new ConnectorService({
    store,
    ownerId: "owner",
    key,
    vault,
    tools,
    builtins: [googleConnector, microsoftConnector],
    env: {},
    log,
    now: () => clock.now,
    sleep: async (ms) => void sleeps.push(ms),
    endpoints: {
      google: {
        authorizeUrl: `${google.url}/auth`,
        tokenUrl: `${google.url}/token`,
        revokeUrl: `${google.url}/revoke`,
        apiBases: { gmail: google.url, calendar: google.url, drive: google.url, docs: google.url, sheets: google.url, userinfo: google.url }
      },
      microsoft: { authorizeUrl: `${microsoft.url}/auth`, tokenUrl: `${microsoft.url}/token`, apiBases: { graph: microsoft.url } }
    }
  }).init();
  google.route("GET", "/v1/userinfo", () => ({ json: { email: "max@example.com", name: "Max" } }));
  microsoft.route("GET", "/v1.0/me", () => ({ json: { mail: "max@contoso.com", displayName: "Max M" } }));
  cleanup.push(() => service.close(), () => vault.close(), () => google.close(), () => microsoft.close());
  return { store, key, vault, tools, google, microsoft, service, logs, clock, sleeps };
}

type Env = Awaited<ReturnType<typeof setup>>;

async function configureApps(env: Env) {
  await env.service.setApp(owner, "google", { clientId: "google-client", clientSecret: "google-secret-value" });
  await env.service.setApp(owner, "microsoft", { clientId: "ms-client", clientSecret: "ms-secret-value" });
}

/** Run the whole OAuth dance for `who`. */
async function connect(env: Env, who: Principal, connectorId: "google" | "microsoft", scope: "personal" | "workspace", groups?: string[], workspaceId = "default") {
  const vendor = connectorId === "google" ? env.google : env.microsoft;
  const binding = `binding-${who.userId}`;
  const { authorizeUrl } = await env.service.beginOAuth(
    { principal: who, binding, name: who.userId! },
    { connectorId, scope, ...(groups ? { groups } : {}), workspaceId },
    "http://gateway.test/api/connectors/oauth/callback"
  );
  const params = authorizeParams(authorizeUrl);
  const code = vendor.approve(params.challenge);
  const { connection } = await env.service.completeOAuth({ state: params.state, code }, async (pending) => ({ ok: pending.binding === binding }));
  return { connection, params };
}

function toolContext(principal: Principal | undefined, workspaceId = "default"): ToolContext {
  return {
    signal: new AbortController().signal,
    ownerId: "owner",
    runId: "run-1",
    ...(principal ? { principal } : {}),
    workspaceId,
    store: createMemoryStore(),
    meter: { record() {}, totals: () => ({ todayUsd: 0, monthUsd: 0, sessionUsd: 0, byFeature: {} }), check: () => ({ allowed: true }), limits: () => ({}) },
    log() {}
  };
}

function gmailRoutes(google: FakeVendor) {
  google.route("GET", "/gmail/v1/users/me/messages", () => ({ json: { messages: [{ id: "m1" }, { id: "m2" }], resultSizeEstimate: 2 } }));
  google.route("GET", /^\/gmail\/v1\/users\/me\/messages\/m\d$/, (req) => ({
    json: {
      id: req.path.split("/").pop(),
      threadId: "t1",
      snippet: "Quarterly numbers attached",
      labelIds: ["INBOX", "UNREAD"],
      payload: { headers: [{ name: "From", value: "Anna <anna@example.com>" }, { name: "Subject", value: "Q3 report" }] }
    }
  }));
}

describe("connector framework", () => {
  it("registers one tool per action with schemas, effects and risk", async () => {
    const env = await setup();
    const send = env.tools.get("google_gmail_send")!;
    expect(send).toMatchObject({ effect: "write", risk: "high", source: "connector", provider: "google" });
    expect(env.tools.get("google_gmail_search")).toMatchObject({ effect: "read" });
    expect(env.tools.get("microsoft_outlook_send")).toMatchObject({ effect: "write", risk: "high" });
    expect(env.tools.get("microsoft_teams_post_message")).toMatchObject({ effect: "write", risk: "high" });
    for (const tool of env.tools.list({ source: "connector" })) {
      expect(tool.name).toMatch(/^(google|microsoft)_[a-z_]+$/);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    // Nothing is connected yet: no connector tool is offered to anyone.
    expect(env.tools.list({ source: "connector" }).some((tool) => tool.isAvailable?.({ principal: owner, workspaceId: "default" }))).toBe(false);
  });

  it("needs the organization's app before connecting; only org admins set it up, and the secret never comes back", async () => {
    const env = await setup();
    await expect(env.service.beginOAuth({ principal: member, binding: "b" }, { connectorId: "google", scope: "personal", workspaceId: "default" }, "http://x/cb")).rejects.toMatchObject({ code: "not_configured" });
    await expect(env.service.setApp(admin, "google", { clientId: "x", clientSecret: "y" })).rejects.toMatchObject({ code: "forbidden" });
    await configureApps(env);
    expect((await env.vault.get("owner", "GOOGLE_OAUTH_CLIENT_SECRET"))?.allowedHosts).toEqual(["127.0.0.1"]);
    const state = await env.service.stateFor(owner, "default");
    const google = state.connectors.find((c) => c.id === "google")!;
    expect(google.app).toMatchObject({ configured: true, source: "vault", clientId: "google-client" });
    expect(JSON.stringify(state)).not.toContain("google-secret-value");
    // Members see that it's configured, not the client id.
    const memberView = (await env.service.stateFor(member, "default")).connectors.find((c) => c.id === "google")!;
    expect(memberView.app?.clientId).toBeUndefined();
    expect(memberView.app?.configured).toBe(true);
  });

  it("OAuth with PKCE: personal connection, minimal scopes per group, tools only for its owner", async () => {
    const env = await setup();
    await configureApps(env);
    gmailRoutes(env.google);
    const { connection, params } = await connect(env, member, "google", "personal", ["gmail_read"]);
    expect(params.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.scope.split(" ")).toEqual(["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"]);
    expect(connection).toMatchObject({ scope: "personal", status: "connected", account: "max@example.com", groups: ["gmail_read"] });

    const search = env.tools.get("google_gmail_search")!;
    expect(search.isAvailable!({ principal: member, workspaceId: "default" })).toBe(true);
    expect(search.isAvailable!({ principal: other, workspaceId: "default" })).toBe(false);
    expect(env.tools.get("google_gmail_send")!.isAvailable!({ principal: member, workspaceId: "default" })).toBe(false);
    // A personal connection isn't visible to anyone else.
    expect((await env.service.stateFor(other, "default")).connections).toEqual([]);

    const result = await search.run({ query: "is:unread" }, toolContext(member));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Q3 report");
    expect(result.content).toContain("anna@example.com");
    const listCall = env.google.requests.find((r) => r.path === "/gmail/v1/users/me/messages")!;
    expect(listCall.query.get("q")).toBe("is:unread");
    expect(listCall.headers.authorization).toBe(`Bearer ${env.google.issued[0]!.access}`);

    // Someone else running the tool gets no access to the member's mail.
    const denied = await search.run({ query: "x" }, toolContext(other));
    expect(denied.isError).toBe(true);
    expect(denied.content).toMatch(/No Google Workspace connection/);
  });

  it("stores credentials encrypted and never shows tokens in state, logs or model output", async () => {
    const env = await setup();
    await configureApps(env);
    env.google.route("GET", "/gmail/v1/users/me/messages/m1", (req) => ({
      // A misbehaving API echoing the bearer token back.
      json: { id: "m1", snippet: `debug: ${req.headers.authorization}` }
    }));
    await connect(env, member, "google", "personal");
    const token = env.google.issued[0]!;
    const rawCredentials = JSON.stringify(await env.store.kv.get("owner", CREDENTIALS_KV_KEY));
    const rawRecords = JSON.stringify(await env.store.kv.get("owner", CONNECTIONS_KV_KEY));
    for (const value of [token.access, token.refresh!]) {
      expect(rawCredentials).not.toContain(value);
      expect(rawRecords).not.toContain(value);
      expect(JSON.stringify(await env.service.stateFor(member, "default"))).not.toContain(value);
      expect(JSON.stringify(env.logs)).not.toContain(value);
    }
    const result = await env.tools.get("google_gmail_read_message")!.run({ messageId: "m1" }, toolContext(member));
    expect(result.content).toContain(token.access);
    // The tool loop runs every result through redactSecrets() before the model sees it.
    const forModel = redactSecrets("owner", result.content);
    expect(forModel).not.toContain(token.access);
    expect(forModel).toContain("[secret:connector_credential]");
    expect(JSON.stringify(env.logs)).not.toContain("google-secret-value");

    // A fresh service with the same key reads the connection back.
    const again = await new ConnectorService({ store: env.store, ownerId: "owner", key: env.key, vault: env.vault, builtins: [googleConnector], env: {}, log() {} }).init();
    expect(again.store.credentialsOf(again.store.list()[0]!.id)?.accessToken).toBe(token.access);
    again.close();
    // …and a different key can't: the connection asks for a reconnect.
    const wrong = await new ConnectorService({ store: env.store, ownerId: "owner", key: randomBytes(32), builtins: [googleConnector], env: {}, log() {} }).init();
    expect(wrong.store.list()[0]).toMatchObject({ status: "reconnect" });
    wrong.close();
  });

  it("refreshes expired tokens automatically, and asks for a reconnect when the grant is revoked", async () => {
    const env = await setup();
    await configureApps(env);
    gmailRoutes(env.google);
    const { connection } = await connect(env, member, "google", "personal");
    const first = env.google.issued[0]!.access;
    env.clock.now += 3600_000; // past expiry
    const result = await env.tools.get("google_gmail_search")!.run({}, toolContext(member));
    expect(result.isError).toBeFalsy();
    expect(env.google.requests.filter((r) => r.path === "/token" && r.body.includes("grant_type=refresh_token"))).toHaveLength(1);
    const second = env.google.issued[1]!.access;
    expect(second).not.toBe(first);
    expect(env.google.requests.at(-1)!.headers.authorization).toBe(`Bearer ${second}`);

    // A 401 from the API: refresh once and retry.
    env.google.validTokens.delete(second);
    const retried = await env.tools.get("google_gmail_search")!.run({}, toolContext(member));
    expect(retried.isError).toBeFalsy();
    expect(env.google.issued).toHaveLength(3);

    // The person revoked access at Google: the refresh fails for good.
    env.google.failRefresh = { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    env.clock.now += 3600_000;
    const failed = await env.tools.get("google_gmail_search")!.run({}, toolContext(member));
    expect(failed.isError).toBe(true);
    expect(env.service.store.get(connection.id)).toMatchObject({ status: "reconnect" });
    expect(env.tools.get("google_gmail_search")!.isAvailable!({ principal: member, workspaceId: "default" })).toBe(false);
    const view = (await env.service.stateFor(member, "default")).connections[0]!;
    expect(view).toMatchObject({ status: "reconnect" });
    expect(view.statusMessage).toMatch(/Reconnect/);
  });

  it("backs off after transient refresh failures", async () => {
    const env = await setup();
    await configureApps(env);
    gmailRoutes(env.google);
    const { connection } = await connect(env, member, "google", "personal");
    env.google.failRefresh = { status: 503, body: { error: "temporarily_unavailable" } };
    env.clock.now += 3600_000;
    const failed = await env.tools.get("google_gmail_search")!.run({}, toolContext(member));
    expect(failed.isError).toBe(true);
    expect(env.service.store.get(connection.id)).toMatchObject({ status: "error", refreshFailures: 1 });
    const tokenCalls = () => env.google.requests.filter((r) => r.path === "/token").length;
    const before = tokenCalls();
    // Within the backoff window no new refresh is attempted.
    const again = await env.tools.get("google_gmail_search")!.run({}, toolContext(member));
    expect(again.content).toMatch(/trying again in/);
    expect(tokenCalls()).toBe(before);
    // After it, a successful refresh restores the connection.
    delete env.google.failRefresh;
    env.clock.now += 60_000;
    const ok = await env.tools.get("google_gmail_search")!.run({}, toolContext(member));
    expect(ok.isError).toBeFalsy();
    expect(env.service.store.get(connection.id)).toMatchObject({ status: "connected" });
    expect(env.service.store.get(connection.id)?.refreshFailures).toBeUndefined();
  });

  it("retries 429 respecting Retry-After, and 5xx only for safe methods", async () => {
    const env = await setup();
    await configureApps(env);
    await connect(env, member, "google", "personal");
    let calls = 0;
    env.google.route("GET", "/gmail/v1/users/me/messages", () => {
      calls += 1;
      return calls === 1 ? { status: 429, headers: { "retry-after": "2" }, json: { error: { message: "slow down" } } } : { json: { messages: [] } };
    });
    const result = await env.tools.get("google_gmail_search")!.run({}, toolContext(member));
    expect(result.isError).toBeFalsy();
    expect(calls).toBe(2);
    expect(env.sleeps).toContain(2000);

    let posts = 0;
    env.google.route("POST", "/gmail/v1/users/me/drafts", () => {
      posts += 1;
      return { status: 500, json: { error: { message: "backend error" } } };
    });
    const draft = await env.tools.get("google_gmail_create_draft")!.run({ to: ["a@example.com"], subject: "Hi", body: "Hello" }, toolContext(member));
    expect(draft.isError).toBe(true);
    expect(posts).toBe(1); // a POST that may have run is never repeated
    expect(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"))).toBe(2000);
  });

  it("never sends credentials to other hosts", async () => {
    const seen: string[] = [];
    const http = createConnectorHttp({
      fetch: async (url) => {
        seen.push(String(url));
        return new Response("{}", { status: 200 });
      },
      authHeaders: async () => ({ authorization: "Bearer secret" }),
      hostAllowed: (host) => host === "graph.microsoft.com"
    });
    await expect(http.get("https://evil.example.com/steal")).rejects.toMatchObject({ code: "host_not_allowed" });
    await http.get("https://graph.microsoft.com/v1.0/me");
    expect(seen).toEqual(["https://graph.microsoft.com/v1.0/me"]);
  });
});

describe("connection permissions", () => {
  it("members connect personal accounts but not shared ones; admins share with the workspace", async () => {
    const env = await setup();
    await configureApps(env);
    await expect(env.service.beginOAuth({ principal: member, binding: "b" }, { connectorId: "google", scope: "workspace", workspaceId: "default" }, "http://x/cb")).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(env.service.beginOAuth({ principal: viewer, binding: "b" }, { connectorId: "google", scope: "personal", workspaceId: "default" }, "http://x/cb")).rejects.toMatchObject({ code: "forbidden" });

    gmailRoutes(env.google);
    const { connection } = await connect(env, admin, "google", "workspace", ["gmail_read"]);
    expect(connection).toMatchObject({ scope: "workspace", workspaceId: "default" });
    const search = env.tools.get("google_gmail_search")!;
    // Every member of the workspace may use the shared connection…
    expect(search.isAvailable!({ principal: member, workspaceId: "default" })).toBe(true);
    expect((await search.run({}, toolContext(member))).isError).toBeFalsy();
    // …not viewers (no integrations.use), and not other workspaces.
    expect(search.isAvailable!({ principal: viewer, workspaceId: "default" })).toBe(false);
    expect(search.isAvailable!({ principal: owner, workspaceId: "sales" })).toBe(false);
    // Server-side runs (routines) use shared connections of their workspace.
    expect((await search.run({}, toolContext(undefined))).isError).toBeFalsy();

    // Members see it but can't change or remove it.
    const memberView = (await env.service.stateFor(member, "default")).connections[0]!;
    expect(memberView).toMatchObject({ scope: "workspace", canManage: false, mine: false });
    await expect(env.service.disconnect(member, connection.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(env.service.updateConnection(member, connection.id, { groups: [] })).rejects.toMatchObject({ code: "forbidden" });

    // A personal connection wins over the shared one for its owner.
    await connect(env, member, "google", "personal", ["gmail_read"]);
    const personalToken = env.google.issued.at(-1)!.access;
    await search.run({}, toolContext(member));
    expect(env.google.requests.at(-1)!.headers.authorization).toBe(`Bearer ${personalToken}`);
    await search.run({}, toolContext(other));
    expect(env.google.requests.at(-1)!.headers.authorization).not.toBe(`Bearer ${personalToken}`);

    // Removing revokes the grant at the vendor.
    const refresh = env.google.issued[0]!.refresh!;
    await env.service.disconnect(admin, connection.id);
    expect(env.google.revoked).toContain(refresh);
    expect(env.service.store.get(connection.id)).toBeUndefined();
  });

  it("binds the OAuth state to the person and session, single use, with an expiry", async () => {
    const env = await setup();
    await configureApps(env);
    const { authorizeUrl } = await env.service.beginOAuth({ principal: member, binding: "mine" }, { connectorId: "google", scope: "personal", workspaceId: "default" }, "http://x/cb");
    const params = authorizeParams(authorizeUrl);
    const code = env.google.approve(params.challenge);
    await expect(env.service.completeOAuth({ state: params.state, code }, async () => ({ ok: false }))).rejects.toMatchObject({ code: "wrong_session" });
    // Used (even unsuccessfully) means gone.
    await expect(env.service.completeOAuth({ state: params.state, code }, async () => ({ ok: true }))).rejects.toMatchObject({ code: "invalid_state" });
    await expect(env.service.completeOAuth({ state: "made-up-state-value-xxxxxxxx", code }, async () => ({ ok: true }))).rejects.toMatchObject({ code: "invalid_state" });

    const late = authorizeParams((await env.service.beginOAuth({ principal: member, binding: "mine" }, { connectorId: "google", scope: "personal", workspaceId: "default" }, "http://x/cb")).authorizeUrl);
    env.clock.now += 11 * 60_000;
    await expect(env.service.completeOAuth({ state: late.state, code: env.google.approve(late.challenge) }, async () => ({ ok: true }))).rejects.toMatchObject({ code: "invalid_state" });

    const denied = authorizeParams((await env.service.beginOAuth({ principal: member, binding: "mine" }, { connectorId: "google", scope: "personal", workspaceId: "default" }, "http://x/cb")).authorizeUrl);
    await expect(env.service.completeOAuth({ state: denied.state, error: "access_denied" }, async () => ({ ok: true }))).rejects.toMatchObject({ code: "denied" });
  });

  it("admins can switch action groups off for everyone", async () => {
    const env = await setup();
    await configureApps(env);
    gmailRoutes(env.google);
    await connect(env, member, "google", "personal", ["gmail_read", "gmail_send"]);
    expect(env.tools.get("google_gmail_send")!.isAvailable!({ principal: member, workspaceId: "default" })).toBe(true);
    await env.service.setApp(owner, "google", { allowedGroups: ["gmail_read", "calendar_read"] });
    expect(env.tools.get("google_gmail_send")!.isAvailable!({ principal: member, workspaceId: "default" })).toBe(false);
    expect(env.tools.get("google_gmail_search")!.isAvailable!({ principal: member, workspaceId: "default" })).toBe(true);
    const connection = env.service.store.list()[0]!;
    await expect(env.service.updateConnection(member, connection.id, { groups: ["gmail_read", "gmail_send"] })).rejects.toMatchObject({ code: "forbidden" });
    const view = (await env.service.stateFor(member, "default")).connectors.find((c) => c.id === "google")!;
    expect(view.groups.find((g) => g.id === "gmail_send")?.allowed).toBe(false);
  });

  it("enabling a group whose scopes were not granted needs a reconnect", async () => {
    const env = await setup();
    await configureApps(env);
    const narrow = await startFakeVendor({ clientId: "google-client", clientSecret: "google-secret-value", scope: "openid email https://www.googleapis.com/auth/gmail.readonly" });
    cleanup.push(() => narrow.close());
    const service = await new ConnectorService({
      store: createMemoryStore(),
      ownerId: "owner",
      key: env.key,
      vault: env.vault,
      builtins: [googleConnector],
      env: {},
      log() {},
      endpoints: { google: { authorizeUrl: `${narrow.url}/auth`, tokenUrl: `${narrow.url}/token`, apiBases: { userinfo: narrow.url, gmail: narrow.url } } }
    }).init();
    cleanup.push(() => service.close());
    const { authorizeUrl } = await service.beginOAuth({ principal: member, binding: "b" }, { connectorId: "google", scope: "personal", groups: ["gmail_read"], workspaceId: "default" }, "http://x/cb");
    const p = authorizeParams(authorizeUrl);
    const { connection } = await service.completeOAuth({ state: p.state, code: narrow.approve(p.challenge) }, async () => ({ ok: true }));
    const updated = await service.updateConnection(member, connection.id, { groups: ["gmail_read", "calendar_write"] });
    expect(service.connectionView(member, updated).needsConsent).toEqual(["calendar_write"]);
  });
});

describe("Google and Microsoft actions against fake APIs", () => {
  it("Gmail send builds an RFC 5322 message; Calendar finds free time", async () => {
    const env = await setup();
    await configureApps(env);
    await connect(env, member, "google", "personal", ["gmail_send", "calendar_read"]);
    let raw = "";
    env.google.route("POST", "/gmail/v1/users/me/messages/send", (req) => {
      raw = Buffer.from(JSON.parse(req.body).raw, "base64url").toString("utf8");
      return { json: { id: "sent-1", threadId: "t9" } };
    });
    const sent = await env.tools.get("google_gmail_send")!.run({ to: ["Bob <bob@example.com>"], subject: "Grüße", body: "Hello Bob" }, toolContext(member));
    expect(sent.content).toContain("E-mail sent");
    expect(raw).toContain("To: bob@example.com");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe("Hello Bob");

    env.google.route("POST", "/calendar/v3/freeBusy", () => ({
      json: { calendars: { primary: { busy: [{ start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:30:00Z" }] } } }
    }));
    const free = await env.tools.get("google_calendar_find_free_time")!.run(
      { timeMin: "2026-11-10T08:00:00Z", timeMax: "2026-11-10T13:00:00Z", durationMinutes: 60, workdayStartHour: 9, workdayEndHour: 12 },
      toolContext(member)
    );
    const data = free.data as { slots: Array<{ start: string; end: string }> };
    expect(data.slots).toEqual([{ start: "2026-11-10T10:30:00Z", end: "2026-11-10T12:00:00Z" }]);
  });

  it("Microsoft: tenant setting, Outlook calendar paging, Teams post", async () => {
    const env = await setup();
    await env.service.setApp(owner, "microsoft", { clientId: "ms-client", clientSecret: "ms-secret-value", settings: { tenant: "contoso.onmicrosoft.com" } });
    await expect(env.service.setApp(owner, "microsoft", { settings: { tenant: "bad/tenant" } })).rejects.toMatchObject({ code: "bad_request" });
    const { connection } = await connect(env, member, "microsoft", "personal", ["calendar_read", "teams_read", "teams_post", "files_read"]);
    expect(connection.account).toBe("max@contoso.com");

    env.microsoft.route("GET", "/v1.0/me/calendarView", (req) =>
      req.query.get("page") === "2"
        ? { json: { value: [{ id: "e2", subject: "Review", start: { dateTime: "2026-11-10T13:00:00", timeZone: "UTC" } }] } }
        : { json: { value: [{ id: "e1", subject: "Standup" }], "@odata.nextLink": `${env.microsoft.url}/v1.0/me/calendarView?page=2` } }
    );
    const events = await env.tools.get("microsoft_outlook_list_events")!.run({ start: "2026-11-10T00:00:00Z", end: "2026-11-11T00:00:00Z" }, toolContext(member));
    expect((events.data as { events: Array<{ id: string }> }).events.map((e) => e.id)).toEqual(["e1", "e2"]);

    let posted: any;
    env.microsoft.route("POST", "/v1.0/teams/team-1/channels/19%3Achan/messages", (req) => {
      posted = JSON.parse(req.body);
      return { json: { id: "msg-1", webUrl: "https://teams.example/msg-1" } };
    });
    const post = await env.tools.get("microsoft_teams_post_message")!.run({ teamId: "team-1", channelId: "19:chan", text: "Release is out" }, toolContext(member));
    expect(post.isError).toBeFalsy();
    expect(posted).toEqual({ body: { contentType: "text", content: "Release is out" } });

    env.microsoft.route("GET", "/v1.0/me/drive/items/item-1", (req) =>
      req.query.get("$select")?.includes("downloadUrl")
        ? { json: { "@microsoft.graph.downloadUrl": undefined } }
        : { json: { id: "item-1", name: "notes.txt", file: { mimeType: "text/plain" } } }
    );
    env.microsoft.route("GET", "/v1.0/me/drive/items/item-1/content", () => ({ text: "Meeting notes: ship on Friday." }));
    const file = await env.tools.get("microsoft_onedrive_read_file")!.run({ itemId: "item-1" }, toolContext(member));
    expect(file.content).toContain("ship on Friday");
  });
});

describe("helpers", () => {
  it("trims large vendor payloads for the model", () => {
    const text = toModelText({ items: Array.from({ length: 500 }, (_, i) => ({ id: i, body: "x".repeat(3000), etag: "W/1", empty: "" })) });
    expect(text.length).toBeLessThanOrEqual(9_100);
    expect(text).not.toContain("etag");
    expect(text).not.toContain('"empty"');
  });

  it("finds free slots inside working hours", () => {
    const at = (h: number) => Date.UTC(2026, 10, 10, h);
    expect(freeSlots({ from: at(0), to: at(24), busy: [{ start: at(10), end: at(11) }], durationMinutes: 60, workdayStartHour: 9, workdayEndHour: 17 })).toEqual([
      { start: at(9), end: at(10) },
      { start: at(11), end: at(17) }
    ]);
  });
});
