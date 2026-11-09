/**
 * End to end through a running gateway (real HTTP server, routes, identity
 * gate, connectors, vault, agents, approvals, notifications) with Slack's Web
 * API and Microsoft Graph replaced by local fake servers:
 * - Slack: install via OAuth, signed events in, the agent's reply posted in
 *   the right thread with the bot token; retries, bad signatures and the
 *   bot's own messages are ignored; approvals in a thread; DM notifications.
 * - Teams: the subscription handshake, clientState-checked notifications,
 *   the reply in the thread with the connection's token, renewal on the job.
 */
import { randomBytes } from "node:crypto";
import type { LLMProvider, STTProvider, ToolChatEvent, ToolChatProvider } from "@open-gpt-live/adapters";
import { createMemoryStore, randomAvatar, type AgentRecord, type Store } from "@open-gpt-live/core";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../agents/runtime.js";
import { microsoftConnector } from "../connectors/microsoft/index.js";
import { ConnectorService } from "../connectors/service.js";
import { slackConnector } from "../connectors/slack/index.js";
import { authorizeParams, startFakeVendor, type FakeVendor, type RecordedRequest } from "../connectors/testing.js";
import { createGatewayServer, type GatewayServerHandle } from "../gateway.js";
import { installNotifications } from "../notifications/index.js";
import { RoutineService } from "../routines/service.js";
import { createTestRuntime } from "../runtime.js";
import { SecretVault } from "../secrets/vault.js";
import { installPresence } from "./index.js";
import type { PresenceService } from "./service.js";
import { slackSignature } from "./slack.js";
import { PresenceStore } from "./store.js";

const SIGNING_SECRET = "test-signing-secret-0123456789abcdef";
const OWNER = "owner";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function http(base: string, path: string, init: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined || init.raw !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text, ms: Date.now() - started, type: response.headers.get("content-type") ?? "" };
}

/** A model that answers from a script and records what it was sent. */
function scriptedBrain(script: Array<ToolChatEvent[]>) {
  const calls: Array<Array<{ role: string; content: unknown }>> = [];
  const provider: ToolChatProvider = {
    async *streamWithTools(messages) {
      calls.push(messages as Array<{ role: string; content: unknown }>);
      const events = script[Math.min(calls.length - 1, script.length - 1)] ?? [];
      for (const event of events) yield event;
      yield { type: "usage", usage: { costUsd: 0.001 } };
    }
  };
  return { provider, calls };
}

const say = (text: string): ToolChatEvent[] => [{ type: "text", delta: text }];

function agent(id: string, name: string, autonomy: AgentRecord["autonomy"] = "ask_first"): AgentRecord {
  return {
    id,
    ownerId: OWNER,
    workspaceId: "default",
    createdBy: "local",
    name,
    description: "",
    avatar: randomAvatar(id),
    instructions: `You are ${name}.`,
    access: { mode: "inherit" },
    autonomy,
    learning: "off",
    visibility: "workspace",
    createdAt: 1,
    updatedAt: 1
  };
}

async function start(env: NodeJS.ProcessEnv = {}) {
  const store: Store = createMemoryStore();
  const key = randomBytes(32);
  const logs: Array<Record<string, unknown>> = [];
  const log = (event: string, fields?: Record<string, unknown>) => void logs.push({ event, ...fields });
  const vault = new SecretVault({ store, key, log });
  const runtime = createTestRuntime({ store });

  const slack = await startFakeVendor({
    clientId: "slack-client",
    clientSecret: "slack-client-secret",
    tokenPath: "/api/oauth.v2.access",
    revokePath: "/api/auth.revoke",
    scope: "channels:read,groups:read,channels:history,groups:history,users:read,chat:write,reactions:write,app_mentions:read,chat:write.customize,users:read.email,im:write",
    tokenExtra: () => ({ ok: true, team: { id: "T1", name: "Acme" }, bot_user_id: "UBOT", app_id: "A1" })
  });
  const slackOk = (extra: Record<string, unknown> = {}) => ({ json: { ok: true, ...extra } });
  slack.route("GET", "/api/auth.test", () => slackOk({ team: "Acme", url: "https://acme.slack.com/", user: "sibyl" }));
  slack.route("GET", "/api/users.info", (r) => {
    const maria = r.query.get("user") === "U1";
    return slackOk({ user: { id: r.query.get("user"), real_name: maria ? "Maria" : "Tom", profile: { email: maria ? "maria@acme.test" : "tom@acme.test" } } });
  });
  slack.route("GET", "/api/conversations.history", () =>
    slackOk({
      messages: [
        { ts: "1700000501.000100", user: "UBOT", bot_id: "B1", username: "Research", text: "Hello again." },
        { ts: "1700000500.000100", user: "U1", text: "hi" }
      ]
    })
  );
  slack.route("GET", "/api/conversations.replies", () =>
    slackOk({
      messages: [
        { ts: "1700000000.000100", user: "U1", text: "<@UBOT> what's our refund policy?" },
        { ts: "1700000001.000100", user: "UBOT", bot_id: "B1", username: "Research", text: "30 days, no questions asked." },
        { ts: "1700000002.000100", user: "U2", text: "and for gift cards?" }
      ]
    })
  );
  slack.route("POST", "/api/chat.postMessage", (r) => slackOk({ channel: JSON.parse(r.body).channel, ts: `17000000${slack.requests.length}.000200` }));
  slack.route("POST", "/api/reactions.add", () => slackOk());
  slack.route("GET", "/api/conversations.list", () => slackOk({ channels: [{ id: "C123", name: "support", is_member: true }, { id: "C999", name: "random", is_member: false }] }));
  slack.route("GET", "/api/users.lookupByEmail", (r) => (r.query.get("email") === "owner@acme.test" ? slackOk({ user: { id: "U9" } }) : { json: { ok: false, error: "users_not_found" } }));
  slack.route("POST", "/api/conversations.open", () => slackOk({ channel: { id: "D9" } }));

  const graph = await startFakeVendor({ clientId: "ms-client", clientSecret: "ms-client-secret", scope: "User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send" });
  graph.route("GET", "/v1.0/me", () => ({ json: { id: "UACC", mail: "sibyl@contoso.test", displayName: "Sibyl" } }));

  const connectors = await new ConnectorService({
    store,
    ownerId: OWNER,
    key,
    vault,
    tools: runtime.tools,
    builtins: [microsoftConnector, slackConnector],
    env,
    log,
    endpoints: {
      slack: { authorizeUrl: `${slack.url}/oauth/v2/authorize`, tokenUrl: `${slack.url}/api/oauth.v2.access`, revokeUrl: `${slack.url}/api/auth.revoke`, apiBases: { slack: `${slack.url}/api` } },
      microsoft: { authorizeUrl: `${graph.url}/authorize`, tokenUrl: `${graph.url}/token`, apiBases: { graph: graph.url } }
    }
  }).init();
  const notifications = installNotifications({ store, ownerId: OWNER, env, log });
  const routines = new RoutineService({ store, tools: runtime.tools, meter: runtime.meter, ownerId: OWNER, env, log, notifications });
  await routines.init();
  let presence: PresenceService | undefined;
  const agents = new AgentRuntime({
    store,
    ownerId: OWNER,
    tools: runtime.tools,
    meter: runtime.meter,
    log,
    notify: (input) => notifications.publish(input, { channels: presence?.channelsFor(input) ?? [] })
  });
  presence = (await installPresence({ store, ownerId: OWNER, tools: runtime.tools, meter: runtime.meter, env, log, connectors, agents, notifications, routines, allowHttpPublicUrl: true }))!;
  Object.assign(runtime, { connectors, notifications, routines, agents, presence });

  const llm: LLMProvider = { async *streamText() { yield { delta: "hi" }; } };
  const stt: STTProvider = { transcribe: async () => ({ text: "x" }) };
  const server: GatewayServerHandle = await createGatewayServer({ providers: { llm, stt }, port: 0, host: "127.0.0.1", runtime, logger: { info: log, warn: log, error: log } });
  const base = `http://127.0.0.1:${server.port}`;
  cleanup.push(
    () => server.close(),
    async () => presence!.close(),
    () => routines.stop(),
    () => connectors.close(),
    () => vault.close(),
    () => slack.close(),
    () => graph.close()
  );
  env.SIBYL_PUBLIC_GATEWAY_URL = base;
  return { base, store, slack, graph, presence, connectors, routines, notifications, logs };
}

/** Install Slack for the whole workspace through the real OAuth routes. */
async function connectSlack(base: string, slack: FakeVendor) {
  const app = await http(base, "/api/connectors/apps/slack", { method: "PUT", body: { clientId: "slack-client", clientSecret: "slack-client-secret", secrets: { SIGNING_SECRET } } });
  expect(app.status).toBe(200);
  const card = app.body.connectors.find((c: { id: string }) => c.id === "slack");
  expect(card.app.secrets).toEqual([expect.objectContaining({ name: "SIGNING_SECRET", configured: true })]);
  expect(card.app.endpoints[0].url).toBe(`${base}/api/presence/slack/events`);
  expect(JSON.stringify(app.body)).not.toContain(SIGNING_SECRET);
  const begun = await http(base, "/api/connectors/slack/connect", { method: "POST", body: { scope: "workspace" } });
  expect(begun.status).toBe(200);
  const params = authorizeParams(begun.body.authorizeUrl);
  expect(params.scope.split(",")).toEqual(expect.arrayContaining(["app_mentions:read", "chat:write", "chat:write.customize"]));
  expect(new URL(begun.body.authorizeUrl).searchParams.get("user_scope")).toBeNull();
  const code = slack.approve("");
  const done = await http(base, `/api/connectors/oauth/callback?code=${code}&state=${params.state}`);
  expect(done.status).toBe(200);
  return slack.issued.at(-1)!.access;
}

async function connectMicrosoft(base: string, graph: FakeVendor, groups = ["teams_read", "teams_messages_read", "teams_post"]) {
  await http(base, "/api/connectors/apps/microsoft", { method: "PUT", body: { clientId: "ms-client", clientSecret: "ms-client-secret" } });
  const begun = await http(base, "/api/connectors/microsoft/connect", { method: "POST", body: { scope: "workspace", groups } });
  expect(begun.status).toBe(200);
  const params = authorizeParams(begun.body.authorizeUrl);
  const code = graph.approve(params.challenge);
  expect((await http(base, `/api/connectors/oauth/callback?code=${code}&state=${params.state}`)).status).toBe(200);
  return graph.issued.at(-1)!.access;
}

function signed(body: unknown, at = Math.floor(Date.now() / 1000), secret = SIGNING_SECRET) {
  const raw = JSON.stringify(body);
  const timestamp = String(at);
  return { raw, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": slackSignature(secret, timestamp, raw) } };
}

function slackEvent(id: string, event: Record<string, unknown>) {
  return { type: "event_callback", team_id: "T1", api_app_id: "A1", event_id: id, event };
}

const posts = (vendor: FakeVendor, method: string): RecordedRequest[] => vendor.requests.filter((r) => r.path === `/api/${method}`);

describe("Slack: agents answer in channels", () => {
  it("verifies events, answers @mentions and thread replies in the right thread with the bot token, and ignores the rest", async () => {
    const { base, store, slack, presence, logs } = await start();
    const botToken = await connectSlack(base, slack);
    await store.agents.upsert(agent("agent-1", "Research"));
    const brain = scriptedBrain([say("Refunds within 30 days."), say("Gift cards can't be refunded.")]);
    presence.configure({ provider: brain.provider, model: () => "test/model", systemPrompt: "SYSTEM" });

    // Channel picker lists the app's channels; the agent joins #support.
    const channels = await http(base, "/api/presence/channels?provider=slack");
    expect(channels.body.channels).toEqual([expect.objectContaining({ id: "C123", name: "support", appIsMember: true }), expect.objectContaining({ id: "C999", appIsMember: false })]);
    const bound = await http(base, "/api/presence/agents/agent-1/bindings", { method: "POST", body: { provider: "slack", channelId: "C123", channelName: "support", respond: "mentions" } });
    expect(bound.status).toBe(201);
    expect(bound.body.bindings).toEqual([expect.objectContaining({ provider: "slack", channelId: "C123", status: "active", canEdit: true })]);
    expect((await http(base, "/api/presence/agents/agent-1/bindings", { method: "POST", body: { provider: "slack", channelId: "C123", respond: "mentions" } })).status).toBe(409);

    // Slack's URL check, signed.
    const challenge = signed({ type: "url_verification", challenge: "abc123" });
    const verified = await http(base, "/api/presence/slack/events", { method: "POST", raw: challenge.raw, headers: challenge.headers });
    expect(verified).toMatchObject({ status: 200, body: { challenge: "abc123" } });

    // Wrong secret, stale timestamp, no signature: refused before parsing.
    const mention = slackEvent("Ev1", { type: "app_mention", channel: "C123", user: "U1", text: "<@UBOT> what's our refund policy?", ts: "1700000000.000100" });
    const forged = signed(mention, undefined, "wrong-secret");
    expect((await http(base, "/api/presence/slack/events", { method: "POST", raw: forged.raw, headers: forged.headers })).status).toBe(401);
    const stale = signed(mention, Math.floor(Date.now() / 1000) - 600);
    expect((await http(base, "/api/presence/slack/events", { method: "POST", raw: stale.raw, headers: stale.headers })).status).toBe(401);
    expect((await http(base, "/api/presence/slack/events", { method: "POST", raw: JSON.stringify(mention) })).status).toBe(401);

    // The @mention: acknowledged at once, answered in its thread.
    const delivery = signed(mention);
    const acked = await http(base, "/api/presence/slack/events", { method: "POST", raw: delivery.raw, headers: delivery.headers });
    expect(acked.status).toBe(200);
    expect(acked.ms).toBeLessThan(3000);
    await presence.settle();
    const [first] = posts(slack, "chat.postMessage");
    expect(first!.headers.authorization).toBe(`Bearer ${botToken}`);
    expect(JSON.parse(first!.body)).toMatchObject({ channel: "C123", thread_ts: "1700000000.000100", text: "Refunds within 30 days.", username: "Research" });
    // The model saw the asker by name, with the mention removed, and the agent's instructions.
    const firstCall = brain.calls[0]!;
    expect(String(firstCall[0]!.content)).toContain("You are Research.");
    expect(String(firstCall[0]!.content)).toContain("Slack #support");
    expect(firstCall.at(-1)).toEqual({ role: "user", content: "Maria: what's our refund policy?" });
    expect(posts(slack, "reactions.add")).toHaveLength(1);

    // Slack retries the same event (and also sends it as a plain message event): answered once.
    const retry = signed(mention);
    await http(base, "/api/presence/slack/events", { method: "POST", raw: retry.raw, headers: { ...retry.headers, "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } });
    const dup = signed(slackEvent("Ev1b", { type: "message", channel_type: "channel", channel: "C123", user: "U1", text: "<@UBOT> what's our refund policy?", ts: "1700000000.000100" }));
    await http(base, "/api/presence/slack/events", { method: "POST", raw: dup.raw, headers: dup.headers });
    await presence.settle();
    expect(posts(slack, "chat.postMessage")).toHaveLength(1);

    // A reply in that thread, without a mention: the agent follows its thread, with the thread as context.
    const followUp = signed(slackEvent("Ev2", { type: "message", channel_type: "channel", channel: "C123", user: "U2", text: "and for gift cards?", ts: "1700000002.000100", thread_ts: "1700000000.000100" }));
    await http(base, "/api/presence/slack/events", { method: "POST", raw: followUp.raw, headers: followUp.headers });
    await presence.settle();
    const second = posts(slack, "chat.postMessage")[1]!;
    expect(JSON.parse(second.body)).toMatchObject({ channel: "C123", thread_ts: "1700000000.000100", text: "Gift cards can't be refunded." });
    const secondCall = brain.calls[1]!;
    expect(secondCall.slice(1)).toEqual([
      { role: "user", content: "Maria: what's our refund policy?" },
      { role: "assistant", content: "30 days, no questions asked." },
      { role: "user", content: "Tom: and for gift cards?" }
    ]);

    // Ignored: a new top-level message without a mention ("mentions" mode), another channel, a bot, an edit.
    for (const [id, event] of [
      ["Ev3", { type: "message", channel_type: "channel", channel: "C123", user: "U2", text: "lunch?", ts: "1700000010.000100" }],
      ["Ev4", { type: "app_mention", channel: "C999", user: "U2", text: "<@UBOT> hi", ts: "1700000011.000100" }],
      ["Ev5", { type: "message", channel_type: "channel", channel: "C123", user: "UBOT", bot_id: "B1", text: "echo", ts: "1700000012.000100", thread_ts: "1700000000.000100" }],
      ["Ev6", { type: "message", subtype: "message_changed", channel: "C123", ts: "1700000013.000100" }]
    ] as const) {
      const ev = signed(slackEvent(id, event));
      expect((await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers })).status).toBe(200);
    }
    await presence.settle();
    expect(posts(slack, "chat.postMessage")).toHaveLength(2);
    expect(brain.calls).toHaveLength(2);

    // What was asked and answered is kept in the binding's conversation; logs never carry tokens or the secret.
    const binding = presence.records.bindings()[0]!;
    const conversation = await store.conversations.get(OWNER, binding.conversationId!);
    expect(conversation!.messages.map((m) => m.content)).toEqual([
      "Maria: what's our refund policy?",
      "Refunds within 30 days.",
      "Tom: and for gift cards?",
      "Gift cards can't be refunded."
    ]);
    const logText = JSON.stringify(logs);
    expect(logText).not.toContain(botToken);
    expect(logText).not.toContain(SIGNING_SECRET);
  });

  it("picks the agent named after the mention, and answers every message in an \"all\" channel", async () => {
    const { base, store, slack, presence } = await start();
    await connectSlack(base, slack);
    await store.agents.upsert(agent("agent-1", "Research"));
    await store.agents.upsert(agent("agent-2", "Sales Buddy"));
    presence.configure({ provider: scriptedBrain([say("ok")]).provider, model: () => "test/model", systemPrompt: "S" });
    await http(base, "/api/presence/agents/agent-1/bindings", { method: "POST", body: { provider: "slack", channelId: "C123", respond: "mentions" } });
    await http(base, "/api/presence/agents/agent-2/bindings", { method: "POST", body: { provider: "slack", channelId: "C123", respond: "all" } });
    // Names come from the store (as after a restart).
    const named = signed(slackEvent("Ev1", { type: "app_mention", channel: "C123", user: "U1", text: "<@UBOT> sales buddy, draft a follow-up", ts: "1700000100.000100" }));
    await http(base, "/api/presence/slack/events", { method: "POST", raw: named.raw, headers: named.headers });
    const plain = signed(slackEvent("Ev2", { type: "message", channel_type: "channel", channel: "C123", user: "U1", text: "anyone around?", ts: "1700000200.000100" }));
    await http(base, "/api/presence/slack/events", { method: "POST", raw: plain.raw, headers: plain.headers });
    await presence.settle();
    const bodies = posts(slack, "chat.postMessage").map((r) => JSON.parse(r.body));
    expect(bodies).toEqual([
      expect.objectContaining({ username: "Sales Buddy", thread_ts: "1700000100.000100" }),
      expect.objectContaining({ username: "Sales Buddy", thread_ts: "1700000200.000100" })
    ]);
  });

  it("asks for approval in the thread before a write, then finishes after the decision", async () => {
    const { base, store, slack, presence, routines } = await start();
    await connectSlack(base, slack);
    await store.agents.upsert(agent("agent-1", "Research", "ask_first"));
    await http(base, "/api/presence/agents/agent-1/bindings", { method: "POST", body: { provider: "slack", channelId: "C123", respond: "mentions" } });
    const brain = scriptedBrain([
      [{ type: "tool_calls", calls: [{ id: "c1", name: "slack_add_reaction", arguments: JSON.stringify({ channel: "C123", ts: "1700000300.000100", emoji: "tada" }) }] }],
      say("Done, I reacted.")
    ]);
    presence.configure({ provider: brain.provider, model: () => "test/model", systemPrompt: "S" });
    const ev = signed(slackEvent("Ev1", { type: "app_mention", channel: "C123", user: "U1", text: "<@UBOT> react with tada", ts: "1700000300.000100" }));
    await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers });
    let pending: Awaited<ReturnType<Store["approvals"]["listPending"]>> = [];
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pending = await store.approvals.listPending(OWNER);
    }
    expect(pending).toEqual([expect.objectContaining({ toolName: "slack_add_reaction" })]);
    expect(JSON.parse(posts(slack, "chat.postMessage")[0]!.body).text).toMatch(/I need approval to react to a slack message/i);
    expect(posts(slack, "reactions.add")).toHaveLength(1); // only the 👀 acknowledgement so far
    await routines.approvals.decide(pending[0]!.id, "approve");
    await presence.settle();
    expect(posts(slack, "reactions.add").map((r) => JSON.parse(r.body).name)).toEqual(["eyes", "tada"]);
    expect(JSON.parse(posts(slack, "chat.postMessage")[1]!.body)).toMatchObject({ text: "Done, I reacted.", thread_ts: "1700000300.000100" });
  });

  it("delivers notifications by direct message (matched by e-mail) and an agent's notices where it chose", async () => {
    const env: NodeJS.ProcessEnv = { SIBYL_NOTIFY_EMAIL: "owner@acme.test", SIBYL_APP_URL: "https://sibyl.acme.test" };
    const { base, store, slack, notifications, presence } = await start(env);
    await connectSlack(base, slack);
    await store.agents.upsert(agent("agent-1", "Research"));
    const result = await notifications.notify({ kind: "monitor_fired", recipientUserId: "owner", title: "Deal moved", body: "Acme <big> deal → Negotiation", links: { monitorId: "m1" } }, { channels: ["slack"] });
    expect(result.deliveries).toEqual([{ channel: "inbox", status: "sent" }, { channel: "slack", status: "sent" }]);
    const dm = JSON.parse(posts(slack, "chat.postMessage")[0]!.body);
    expect(dm).toMatchObject({ channel: "D9" });
    expect(dm.text).toBe("*Deal moved*\nAcme &lt;big&gt; deal → Negotiation\n<https://sibyl.acme.test/monitors|Open in Sibyl>");

    // The agent's "act, then tell me" notices also go to Slack once chosen.
    const settings = await http(base, "/api/presence/agents/agent-1/settings", { method: "PUT", body: { notify: ["slack"] } });
    expect(settings.body.notify).toEqual(["slack"]);
    expect(presence.channelsFor({ kind: "agent_action", title: "x", links: { agentId: "agent-1" } })).toEqual(["slack"]);
    expect(presence.channelsFor({ kind: "monitor_fired", title: "x", links: { agentId: "agent-1" } })).toEqual([]);

    // Without an e-mail match, the workspace's notifications channel is the fallback.
    env.SIBYL_NOTIFY_EMAIL = "nobody@acme.test";
    expect((await http(base, "/api/presence/settings", { method: "PUT", body: { slack: { channelId: "C123", channelName: "support" } } })).status).toBe(200);
    const fallback = await notifications.notify({ kind: "monitor_fired", recipientUserId: "owner", title: "Second", links: {} }, { channels: ["slack"] });
    expect(fallback.deliveries[1]).toEqual({ channel: "slack", status: "sent" });
    expect(JSON.parse(posts(slack, "chat.postMessage")[1]!.body)).toMatchObject({ channel: "C123" });
  });
});

describe("Teams: agents answer through Graph change notifications", () => {
  it("subscribes with a clientState, answers mentions in the thread, refuses forged notifications and renews on the scheduler", async () => {
    const { base, store, graph, presence } = await start();
    const graphToken = await connectMicrosoft(base, graph);
    await store.agents.upsert(agent("agent-1", "Research"));
    presence.configure({ provider: scriptedBrain([say("The roadmap is in the wiki.")]).provider, model: () => "test/model", systemPrompt: "S" });
    const channel = "19:abc@thread.tacv2";
    let clientState = "";
    graph.route("POST", "/v1.0/subscriptions", (r) => {
      const body = JSON.parse(r.body);
      clientState = body.clientState;
      expect(body).toMatchObject({ changeType: "created", resource: `/teams/T1/channels/${encodeURIComponent(channel)}/messages`, notificationUrl: `${base}/api/presence/teams/notifications`, lifecycleNotificationUrl: `${base}/api/presence/teams/lifecycle` });
      return { status: 201, json: { id: "sub-1", expirationDateTime: new Date(Date.now() + 55 * 60_000).toISOString() } };
    });
    graph.route("PATCH", "/v1.0/subscriptions/sub-1", () => ({ json: { id: "sub-1", expirationDateTime: new Date(Date.now() + 110 * 60_000).toISOString() } }));
    graph.route("GET", /\/v1\.0\/teams\/T1\/channels\/.+\/messages\/M1$/, () => ({
      json: {
        id: "M1",
        messageType: "message",
        from: { user: { id: "U-MARIA", displayName: "Maria" } },
        body: { contentType: "html", content: '<p><at id="0">Sibyl</at> where is the roadmap?</p>' },
        mentions: [{ id: 0, mentionText: "Sibyl", mentioned: { user: { id: "UACC", displayName: "Sibyl" } } }]
      }
    }));
    graph.route("POST", /\/v1\.0\/teams\/T1\/channels\/.+\/messages\/M1\/replies$/, () => ({ status: 201, json: { id: "R1" } }));

    // Graph's handshake: the token comes back as plain text.
    const handshake = await http(base, "/api/presence/teams/notifications?validationToken=Validation%3A%20abc", { method: "POST" });
    expect(handshake).toMatchObject({ status: 200, text: "Validation: abc" });
    expect(handshake.type).toContain("text/plain");

    const bound = await http(base, "/api/presence/agents/agent-1/bindings", { method: "POST", body: { provider: "teams", teamId: "T1", teamName: "Product", channelId: channel, channelName: "General", respond: "mentions" } });
    expect(bound.status).toBe(201);
    await presence.settle();
    const binding = presence.records.bindings()[0]!;
    expect(binding).toMatchObject({ status: "active", accountUserId: "UACC", subscription: { id: "sub-1" } });
    expect(JSON.stringify(binding)).not.toContain(clientState);

    const notification = (state: string) => ({
      value: [{ subscriptionId: "sub-1", clientState: state, changeType: "created", resource: `teams('T1')/channels('${channel}')/messages('M1')`, tenantId: "tenant" }]
    });
    // Forged: wrong clientState → accepted (202) but nothing is read or posted.
    expect((await http(base, "/api/presence/teams/notifications", { method: "POST", body: notification("forged") })).status).toBe(202);
    await presence.settle();
    expect(graph.requests.filter((r) => r.path.endsWith("/messages/M1"))).toHaveLength(0);

    const accepted = await http(base, "/api/presence/teams/notifications", { method: "POST", body: notification(clientState) });
    expect(accepted.status).toBe(202);
    expect(accepted.ms).toBeLessThan(3000);
    await presence.settle();
    const reply = graph.requests.find((r) => r.method === "POST" && r.path.endsWith("/messages/M1/replies"))!;
    expect(reply.headers.authorization).toBe(`Bearer ${graphToken}`);
    expect(JSON.parse(reply.body)).toEqual({ body: { contentType: "html", content: "<p><b>Research</b></p><p>The roadmap is in the wiki.</p>" } });

    // Our own reply comes back as a notification: ignored.
    graph.route("GET", /\/messages\/M1\/replies\/R1$/, () => ({ json: { id: "R1", messageType: "message", from: { user: { id: "UACC", displayName: "Sibyl" } }, body: { contentType: "html", content: "<p>x</p>" } } }));
    await http(base, "/api/presence/teams/notifications", { method: "POST", body: { value: [{ ...notification(clientState).value[0], resource: `teams('T1')/channels('${channel}')/messages('M1')/replies('R1')` }] } });
    await presence.settle();
    expect(graph.requests.filter((r) => r.method === "POST" && r.path.includes("/replies"))).toHaveLength(1);

    // The scheduler job renews before expiry.
    const due = await presence.jobType.due(Date.now() + 45 * 60_000);
    expect(due.map((b) => b.id)).toEqual([binding.id]);
    const claimed = await presence.jobType.claim(due[0]!, Date.now(), Date.now() + 60_000);
    await presence.jobType.run(claimed!, new AbortController().signal);
    await presence.jobType.release(claimed!);
    expect(graph.requests.some((r) => r.method === "PATCH" && r.path === "/v1.0/subscriptions/sub-1")).toBe(true);
    expect(presence.records.bindings()[0]!.subscription!.expiresAt).toBeGreaterThan(Date.now() + 100 * 60_000);

    // Removing the agent from the channel deletes the subscription.
    graph.route("DELETE", "/v1.0/subscriptions/sub-1", () => ({ status: 204 }));
    expect((await http(base, `/api/presence/agents/agent-1/bindings/${binding.id}`, { method: "DELETE" })).body.bindings).toEqual([]);
    await presence.settle();
    expect(graph.requests.some((r) => r.method === "DELETE" && r.path === "/v1.0/subscriptions/sub-1")).toBe(true);
  });

  it("lets only the agent's editors place it, and only admins set the notifications channel", async () => {
    const { base, store, slack, presence } = await start();
    await connectSlack(base, slack);
    await store.agents.upsert({ ...agent("agent-1", "Research"), createdBy: "alice" });
    const person = (userId: string, role: "member" | "viewer" | "admin") => ({ principal: { kind: "user" as const, orgId: OWNER, userId, workspaceRoles: { default: role } }, workspaceId: "default" });
    const input = { provider: "slack" as const, channelId: "C123", respond: "mentions" as const };
    await expect(presence.addBinding(person("bob", "member"), "agent-1", input)).rejects.toMatchObject({ status: 403 });
    await expect(presence.addBinding(person("vera", "viewer"), "agent-1", input)).rejects.toMatchObject({ status: 403 });
    const state = await presence.addBinding(person("alice", "member"), "agent-1", input);
    expect(state.bindings).toHaveLength(1);
    expect((await presence.agentState(person("bob", "member"), "agent-1")).canEdit).toBe(false);
    await expect(presence.removeBinding(person("bob", "member"), "agent-1", state.bindings[0]!.id)).rejects.toMatchObject({ status: 403 });
    await expect(presence.setWorkspaceSettings(person("alice", "member"), { slack: { channelId: "C123" } })).rejects.toMatchObject({ status: 403 });
    expect((await presence.setWorkspaceSettings(person("adam", "admin"), { slack: { channelId: "C123" } })).slack).toEqual({ channelId: "C123" });
    // Another workspace sees none of it.
    await expect(presence.agentState({ ...person("adam", "admin"), workspaceId: "other" }, "agent-1")).rejects.toMatchObject({ status: 404 });
  });

  it("explains what is missing when the workspace has no suitable connection", async () => {
    const { base, store } = await start();
    await store.agents.upsert(agent("agent-1", "Research"));
    const state = await http(base, "/api/presence/agents/agent-1");
    expect(state.body.providers).toEqual([
      { provider: "slack", available: false, reason: expect.stringContaining("Connect Slack"), direct: { available: false, reason: expect.stringContaining("Connect Slack") } },
      { provider: "teams", available: false, reason: expect.stringContaining("Connect Microsoft 365"), direct: { available: false, reason: expect.stringContaining("Connect Microsoft 365") } }
    ]);
    expect((await http(base, "/api/presence/agents/agent-1/direct/slack", { method: "PUT", body: {} })).status).toBe(409);
    const refused = await http(base, "/api/presence/agents/agent-1/bindings", { method: "POST", body: { provider: "slack", channelId: "C123", respond: "mentions" } });
    expect(refused.status).toBe(409);
    expect((await http(base, "/api/presence/agents/agent-1/bindings", { method: "POST", body: { provider: "slack", channelId: "nope!", respond: "mentions" } })).status).toBe(400);
    expect((await http(base, "/api/presence/agents/missing")).status).toBe(404);
    // Slack events without a signing secret configured: 503, nothing processed.
    const ev = signed({ type: "url_verification", challenge: "x" });
    expect((await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers })).status).toBe(503);
  });
});

describe("Direct messages: Slack DMs and Teams chats", () => {
  const im = (id: string, user: string, text: string, ts: string, extra: Record<string, unknown> = {}) =>
    signed(slackEvent(id, { type: "message", channel_type: "im", channel: "D1", user, text, ts, ...extra }));

  it("answers Slack DMs from workspace members (by e-mail), picks agents by name and keeps the conversation, and refuses everyone else", async () => {
    // Without accounts, the owner is reached at SIBYL_NOTIFY_EMAIL: Maria (U1) is the owner here.
    const { base, store, slack, presence } = await start({ SIBYL_NOTIFY_EMAIL: "maria@acme.test" });
    await connectSlack(base, slack);
    await store.agents.upsert(agent("agent-1", "Research"));
    await store.agents.upsert(agent("agent-2", "Sales Buddy"));
    const brain = scriptedBrain([say("Here is what's new."), say("Drafted."), say("Still me."), say("Group answer.")]);
    presence.configure({ provider: brain.provider, model: () => "test/model", systemPrompt: "S" });

    const on = await http(base, "/api/presence/agents/agent-1/direct/slack", { method: "PUT", body: { respond: "all", allow: "members" } });
    expect(on.status).toBe(200);
    expect(on.body.direct).toEqual([expect.objectContaining({ provider: "slack", respond: "all", allow: "members", status: "active", canEdit: true })]);
    expect(on.body.bindings).toEqual([]);
    expect(on.body.providers[0]).toMatchObject({ provider: "slack", direct: { available: true } });
    expect((await http(base, "/api/presence/agents/agent-2/direct/slack", { method: "PUT", body: { respond: "mentions" } })).body.direct[0]).toMatchObject({ respond: "mentions", allow: "members" });
    expect((await http(base, "/api/presence/agents/agent-2/direct/slack", { method: "PUT", body: { allow: "everyone" } })).status).toBe(400);
    expect((await http(base, "/api/presence/agents/agent-2/direct/zoom", { method: "PUT", body: {} })).status).toBe(404);

    // Maria writes to the app: the "all" agent answers in the DM itself (no thread), with the DM so far as context.
    let ev = im("Ev1", "U1", "what's new?", "1700000502.000100");
    expect((await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers })).status).toBe(200);
    await presence.settle();
    const first = JSON.parse(posts(slack, "chat.postMessage")[0]!.body);
    expect(first).toEqual(expect.objectContaining({ channel: "D1", text: "Here is what's new.", username: "Research" }));
    expect(first.thread_ts).toBeUndefined();
    expect(brain.calls[0]!.slice(1)).toEqual([
      { role: "user", content: "Maria: hi" },
      { role: "assistant", content: "Hello again." },
      { role: "user", content: "Maria: what's new?" }
    ]);

    // Tom isn't in the Sibyl workspace: a polite refusal, no model call.
    ev = im("Ev2", "U2", "hello", "1700000503.000100", { channel: "D2" });
    await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers });
    await presence.settle();
    expect(JSON.parse(posts(slack, "chat.postMessage")[1]!.body)).toMatchObject({ channel: "D2", text: expect.stringMatching(/only answer people of this Sibyl workspace/) });
    expect(brain.calls).toHaveLength(1);

    // Tom gets an account in the workspace: he may write now. Naming an agent picks it; the conversation stays with it.
    await store.identity.users.upsert({ id: "tom", orgId: OWNER, email: "tom@acme.test", name: "Tom", passwordHash: "!external", createdAt: 1 });
    await store.identity.memberships.upsert(OWNER, { userId: "tom", scope: { workspaceId: "default" }, role: "member" });
    ev = im("Ev3", "U2", "Sales Buddy, draft a follow-up", "1700000504.000100", { channel: "D2" });
    await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers });
    await presence.settle();
    ev = im("Ev4", "U2", "make it shorter", "1700000505.000100", { channel: "D2" });
    await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers });
    await presence.settle();
    expect(posts(slack, "chat.postMessage").slice(2).map((r) => JSON.parse(r.body))).toEqual([
      expect.objectContaining({ channel: "D2", username: "Sales Buddy", text: "Drafted." }),
      expect.objectContaining({ channel: "D2", username: "Sales Buddy", text: "Still me." })
    ]);
    expect(brain.calls[1]!.at(-1)).toEqual({ role: "user", content: "Tom: draft a follow-up" });

    // A group DM: plain chatter is ignored; an @mention of the app gets the default agent, in a thread.
    for (const [id, text, ts] of [["Ev5", "lunch?", "1700000600.000100"], ["Ev6", "<@UBOT> summarise this", "1700000601.000100"]] as const) {
      ev = signed(slackEvent(id, { type: "message", channel_type: "mpim", channel: "G7", user: "U1", text, ts }));
      await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers });
    }
    // Slack also sends the mention as app_mention; it must not answer twice.
    ev = signed(slackEvent("Ev6b", { type: "app_mention", channel: "G7", user: "U1", text: "<@UBOT> summarise this", ts: "1700000601.000100" }));
    await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers });
    await presence.settle();
    expect(posts(slack, "chat.postMessage").slice(4).map((r) => JSON.parse(r.body))).toEqual([
      expect.objectContaining({ channel: "G7", thread_ts: "1700000601.000100", username: "Research", text: "Group answer." })
    ]);

    // Switched off (by a workspace admin; accounts exist now): no more answers.
    const admin = { principal: { kind: "user" as const, orgId: OWNER, userId: "adam", workspaceRoles: { default: "admin" as const } }, workspaceId: "default" };
    expect((await presence.removeDirect(admin, "agent-1", "slack")).direct).toEqual([]);
    expect((await presence.removeDirect(admin, "agent-2", "slack")).direct).toEqual([]);
    await expect(presence.removeDirect(admin, "agent-2", "slack")).rejects.toMatchObject({ status: 404 });
    await expect(presence.setDirect({ ...admin, principal: { ...admin.principal, userId: "tom", workspaceRoles: { default: "member" as const } } }, "agent-1", "slack", { respond: "all", allow: "anyone" })).rejects.toMatchObject({ status: 403 });
    ev = im("Ev7", "U1", "still there?", "1700000700.000100");
    await http(base, "/api/presence/slack/events", { method: "POST", raw: ev.raw, headers: ev.headers });
    await presence.settle();
    expect(posts(slack, "chat.postMessage")).toHaveLength(5);
  });

  it("answers Teams chats through one subscription on the account's chats, sends notices 1:1, and wakes hosted organizations for renewals", async () => {
    const env: NodeJS.ProcessEnv = { SIBYL_NOTIFY_EMAIL: "maria@acme.test" };
    const { base, store, graph, presence, notifications } = await start(env);
    const graphToken = await connectMicrosoft(base, graph, ["teams_direct"]);
    await store.agents.upsert(agent("agent-1", "Research"));
    presence.configure({ provider: scriptedBrain([say("Sure, here it is.")]).provider, model: () => "test/model", systemPrompt: "S" });
    let clientState = "";
    graph.route("POST", "/v1.0/subscriptions", (r) => {
      const body = JSON.parse(r.body);
      clientState = body.clientState;
      expect(body).toMatchObject({ changeType: "created", resource: "/users/UACC/chats/getAllMessages", notificationUrl: `${base}/api/presence/teams/notifications` });
      return { status: 201, json: { id: "sub-chats", expirationDateTime: new Date(Date.now() + 55 * 60_000).toISOString() } };
    });
    graph.route("GET", "/v1.0/chats/CHAT1/messages/M1", () => ({
      json: { id: "M1", messageType: "message", from: { user: { id: "U-MARIA", displayName: "Maria" } }, body: { contentType: "html", content: "<p>Can you find the Q3 deck?</p>" } }
    }));
    graph.route("GET", "/v1.0/chats/CHAT1", () => ({ json: { id: "CHAT1", chatType: "oneOnOne" } }));
    graph.route("GET", "/v1.0/chats/CHAT1/messages", () => ({ json: { value: [] } }));
    graph.route("GET", "/v1.0/users/U-MARIA", () => ({ json: { mail: "Maria@Acme.test", userPrincipalName: "maria@acme.test" } }));
    graph.route("POST", "/v1.0/chats/CHAT1/messages", () => ({ status: 201, json: { id: "R1" } }));

    // Channels need more groups; direct messages are available with “Teams: agents in chats”.
    const state = await http(base, "/api/presence/agents/agent-1");
    expect(state.body.providers[1]).toMatchObject({ provider: "teams", available: false, direct: { available: true } });
    expect((await http(base, "/api/presence/agents/agent-1/direct/teams", { method: "PUT", body: { respond: "all", allow: "members" } })).status).toBe(200);
    await presence.settle();
    const binding = presence.records.bindings()[0]!;
    expect(binding).toMatchObject({ kind: "direct", status: "active", accountUserId: "UACC", subscription: { id: "sub-chats" } });

    // A forged notification is ignored; the real one is answered in the chat.
    const note = (state: string) => ({ value: [{ subscriptionId: "sub-chats", clientState: state, changeType: "created", resource: "chats('CHAT1')/messages('M1')" }] });
    await http(base, "/api/presence/teams/notifications", { method: "POST", body: note("forged") });
    await presence.settle();
    expect(graph.requests.some((r) => r.path === "/v1.0/chats/CHAT1/messages/M1")).toBe(false);
    expect((await http(base, "/api/presence/teams/notifications", { method: "POST", body: note(clientState) })).status).toBe(202);
    await presence.settle();
    const reply = graph.requests.find((r) => r.method === "POST" && r.path === "/v1.0/chats/CHAT1/messages")!;
    expect(reply.headers.authorization).toBe(`Bearer ${graphToken}`);
    expect(JSON.parse(reply.body)).toEqual({ body: { contentType: "html", content: "<p><b>Research</b></p><p>Sure, here it is.</p>" } });

    // Notices go to the person 1:1 (the chat is found or created by e-mail).
    graph.route("POST", "/v1.0/chats", (r) => {
      const body = JSON.parse(r.body);
      expect(body.chatType).toBe("oneOnOne");
      expect(body.members.map((m: Record<string, string>) => m["user@odata.bind"])).toEqual(["https://graph.microsoft.com/v1.0/users('UACC')", "https://graph.microsoft.com/v1.0/users('maria@acme.test')"]);
      return { status: 201, json: { id: "CHAT9" } };
    });
    graph.route("POST", "/v1.0/chats/CHAT9/messages", () => ({ status: 201, json: { id: "N1" } }));
    const sent = await notifications.notify({ kind: "monitor_fired", recipientUserId: "owner", title: "Deal moved", body: "Acme → Negotiation", links: {} }, { channels: ["teams"] });
    expect(sent.deliveries).toEqual([{ channel: "inbox", status: "sent" }, { channel: "teams", status: "sent" }]);
    expect(JSON.parse(graph.requests.find((r) => r.path === "/v1.0/chats/CHAT9/messages")!.body).body.content).toBe("<p><b>Deal moved</b></p><p>Acme → Negotiation</p>");

    // Hosted: the organization's next renewal is indexed across organizations, so an idle one is woken in time.
    await presence.records.flush();
    const renewAt = binding.subscription!.expiresAt - 20 * 60_000;
    expect(await store.kv.get(OWNER, "presence.wake")).toEqual({ at: renewAt });
    expect(await PresenceStore.dueOrganizations(store, renewAt - 1)).toEqual([]);
    expect(await PresenceStore.dueOrganizations(store, renewAt)).toEqual([OWNER]);
    graph.route("DELETE", "/v1.0/subscriptions/sub-chats", () => ({ status: 204 }));
    await http(base, "/api/presence/agents/agent-1/direct/teams", { method: "DELETE" });
    await presence.settle();
    await presence.records.flush();
    expect(await store.kv.get(OWNER, "presence.wake")).toBeUndefined();
    expect(graph.requests.some((r) => r.method === "DELETE" && r.path === "/v1.0/subscriptions/sub-chats")).toBe(true);
  });

  it("falls back to the notifications channel when the 1:1 chat can't be opened", async () => {
    const env: NodeJS.ProcessEnv = { SIBYL_NOTIFY_EMAIL: "maria@acme.test" };
    const { base, graph, notifications } = await start(env);
    await connectMicrosoft(base, graph, ["teams_read", "teams_post", "teams_direct"]);
    graph.route("POST", "/v1.0/chats", () => ({ status: 404, json: { error: { code: "NotFound", message: "no such user" } } }));
    graph.route("POST", /\/v1\.0\/teams\/T1\/channels\/.+\/messages$/, () => ({ status: 201, json: { id: "P1" } }));
    expect((await http(base, "/api/presence/settings", { method: "PUT", body: { teams: { teamId: "T1", channelId: "19:n@thread.tacv2", channelName: "Alerts" } } })).status).toBe(200);
    const sent = await notifications.notify({ kind: "monitor_fired", recipientUserId: "owner", title: "Deal moved", links: {} }, { channels: ["teams"] });
    expect(sent.deliveries[1]).toEqual({ channel: "teams", status: "sent" });
    expect(graph.requests.some((r) => r.method === "POST" && /\/teams\/T1\/channels\/.+\/messages$/.test(r.path))).toBe(true);
  });
});
