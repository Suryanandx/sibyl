import { randomBytes } from "node:crypto";
import { createMemoryStore, createToolRegistry, ownerPrincipal } from "@open-gpt-live/core";
import { afterEach, describe, expect, it } from "vitest";
import { SecretVault } from "../../secrets/vault.js";
import { ConnectorService } from "../service.js";
import { authorizeParams, startFakeVendor } from "../testing.js";
import { slackConnector } from "./index.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(tokenPath = "/api/oauth.v2.access") {
  const store = createMemoryStore();
  const key = randomBytes(32);
  const tools = createToolRegistry();
  const vault = new SecretVault({ store, key });
  const slack = await startFakeVendor({
    clientId: "cid",
    clientSecret: "csecret",
    tokenPath,
    scope: "channels:read,groups:read,channels:history,groups:history,users:read,chat:write",
    tokenExtra: () => ({ ok: true, team: { id: "T1", name: "Acme" }, bot_user_id: "UBOT", app_id: "A1", authed_user: { id: "U1", scope: "search:read", access_token: "xoxp-user-token", token_type: "user" } })
  });
  slack.validTokens.add("xoxp-user-token");
  slack.route("GET", "/api/auth.test", () => ({ json: { ok: true, team: "Acme", url: "https://acme.slack.com/", user: "sibyl" } }));
  const service = await new ConnectorService({
    store,
    ownerId: "owner",
    key,
    vault,
    tools,
    builtins: [slackConnector],
    env: {},
    log: () => undefined,
    endpoints: { slack: { authorizeUrl: `${slack.url}/oauth/v2/authorize`, tokenUrl: `${slack.url}/api/oauth.v2.access`, revokeUrl: `${slack.url}/api/auth.revoke`, apiBases: { slack: `${slack.url}/api` } } }
  }).init();
  cleanup.push(() => service.close(), () => vault.close(), () => slack.close());
  const owner = ownerPrincipal("owner", "local");
  await service.setApp(owner, "slack", { clientId: "cid", clientSecret: "csecret", secrets: { SIGNING_SECRET: "sign-me" } });
  return { service, slack, tools, owner, vault };
}

async function connect(env: Awaited<ReturnType<typeof setup>>, groups: string[]) {
  const { authorizeUrl } = await env.service.beginOAuth({ principal: env.owner, binding: "b" }, { connectorId: "slack", scope: "workspace", groups, workspaceId: "default" }, "https://gw.test/cb");
  const params = authorizeParams(authorizeUrl);
  const { connection } = await env.service.completeOAuth({ state: params.state, code: env.slack.approve("") }, async () => ({ ok: true }));
  return { connection, url: new URL(authorizeUrl) };
}

const context = { signal: new AbortController().signal, principal: ownerPrincipal("owner", "local"), workspaceId: "default", ownerId: "owner" } as never;

describe("Slack connector", () => {
  it("installs with comma-separated bot scopes, asks for user scopes only for search, and keeps the team in metadata", async () => {
    const env = await setup();
    const { connection, url } = await connect(env, ["read", "write", "search"]);
    expect(url.searchParams.get("scope")).toBe("channels:read,groups:read,channels:history,groups:history,users:read,chat:write");
    expect(url.searchParams.get("user_scope")).toBe("search:read");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(connection).toMatchObject({ account: "Acme (acme.slack.com)", metadata: { teamId: "T1", teamName: "Acme", botUserId: "UBOT", appId: "A1" } });
    expect(connection.grantedScopes).toEqual(expect.arrayContaining(["chat:write", "user:search:read"]));
    // The signing secret is in the vault, only for local use, and readable by the gateway.
    expect((await env.vault.get("owner", "SLACK_SIGNING_SECRET"))?.allowedHosts).toEqual(["local"]);
    expect(await env.service.appSecret("slack", "SIGNING_SECRET")).toBe("sign-me");
  });

  it("searches with the person's user token and posts with the bot token", async () => {
    const env = await setup();
    const { connection } = await connect(env, ["read", "write", "search"]);
    const botToken = env.slack.issued.at(-1)!.access;
    env.slack.route("GET", "/api/search.messages", () => ({ json: { ok: true, messages: { total: 1, matches: [{ ts: "1.1", text: "budget", channel: { id: "C1", name: "finance" }, permalink: "https://x" }] } } }));
    env.slack.route("POST", "/api/chat.postMessage", () => ({ json: { ok: true, ts: "2.2", channel: "C1" } }));
    const search = await env.tools.get("slack_search_messages")!.run({ query: "budget" }, context);
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain("finance");
    expect(env.slack.requests.find((r) => r.path === "/api/search.messages")!.headers.authorization).toBe("Bearer xoxp-user-token");
    const posted = await env.tools.get("slack_post_message")!.run({ channel: "C1", text: "hi" }, context);
    expect(posted.isError).toBeFalsy();
    expect(env.slack.requests.find((r) => r.path === "/api/chat.postMessage")!.headers.authorization).toBe(`Bearer ${botToken}`);
    expect(connection.id).toBeTruthy();
  });

  it("maps Slack's ok:false answers: not in channel, missing scope, revoked token → reconnect", async () => {
    const env = await setup();
    const { connection } = await connect(env, ["read", "write"]);
    let answer: Record<string, unknown> = { ok: false, error: "not_in_channel" };
    env.slack.route("GET", "/api/conversations.history", () => ({ json: answer }));
    const read = () => env.tools.get("slack_read_channel")!.run({ channel: "C1" }, context);
    expect((await read()).content).toMatch(/isn't in that channel/);
    answer = { ok: false, error: "missing_scope", needed: "channels:history" };
    expect((await read()).content).toMatch(/refused.*missing_scope: channels:history/);
    answer = { ok: false, error: "token_revoked" };
    expect((await read()).content).toMatch(/reconnect Slack/);
    expect(env.service.store.get(connection.id)!.status).toBe("reconnect");
    // Search was not granted: the tool is not offered.
    expect(env.service.usableConnection(slackConnector, "search", ownerPrincipal("owner", "local"), "default")).toBeUndefined();
  });

  it("refuses a token answer of ok:false as a failed sign-in", async () => {
    // The fake's built-in token endpoint moves aside; Slack's real one answers 200 with ok:false.
    const env = await setup("/unused-token-path");
    env.slack.route("POST", "/api/oauth.v2.access", () => ({ public: true, json: { ok: false, error: "invalid_code" } }));
    const { authorizeUrl } = await env.service.beginOAuth({ principal: env.owner, binding: "b" }, { connectorId: "slack", scope: "workspace", workspaceId: "default" }, "https://gw.test/cb");
    const params = authorizeParams(authorizeUrl);
    await expect(env.service.completeOAuth({ state: params.state, code: "some-code" }, async () => ({ ok: true }))).rejects.toMatchObject({
      code: "token_exchange_failed",
      message: expect.stringContaining("invalid_code")
    });
  });
});
