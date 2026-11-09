import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@open-gpt-live/core";
import { protectedRoutePermission } from "../identity/http.js";
import { afterName, pickBinding, RecentIds, type InboundMessage } from "./inbound.js";
import { parseSlackEnvelope, slackEscape, slackInbound, slackSignature, verifySlackSignature } from "./slack.js";
import type { PresenceBinding } from "./store.js";
import { clientStateMatches, newClientState, parseGraphNotifications, parseMessageResource, teamsHtml, teamsInbound } from "./teams.js";
import { channelPrincipal } from "./turn.js";

const NOW = 1_700_000_000_000;

describe("Slack request signing", () => {
  const body = Buffer.from('{"type":"event_callback"}');
  const ts = String(NOW / 1000);
  it("accepts the v0 signature and refuses stale, missing or wrong ones", () => {
    const signature = slackSignature("secret", ts, body);
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(verifySlackSignature({ secret: "secret", timestamp: ts, signature, body, nowMs: NOW })).toBe("ok");
    expect(verifySlackSignature({ secret: "secret", timestamp: ts, signature, body, nowMs: NOW + 6 * 60_000 })).toBe("stale");
    expect(verifySlackSignature({ secret: "other", timestamp: ts, signature, body, nowMs: NOW })).toBe("mismatch");
    expect(verifySlackSignature({ secret: "secret", timestamp: ts, signature, body: Buffer.from(`${body} `), nowMs: NOW })).toBe("mismatch");
    expect(verifySlackSignature({ secret: "secret", timestamp: undefined, signature, body, nowMs: NOW })).toBe("missing");
    expect(verifySlackSignature({ secret: "secret", timestamp: ts, signature: "v1=abc", body, nowMs: NOW })).toBe("missing");
  });

  it("matches Slack's documented example", () => {
    // https://api.slack.com/authentication/verifying-requests-from-slack
    const example =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    expect(slackSignature("8f742231b10e8888abcd99yyyzzz85a5", "1531420618", example)).toBe("v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503");
  });
});

describe("Slack events → messages", () => {
  const envelope = (event: Record<string, unknown>) => {
    const parsed = parseSlackEnvelope(Buffer.from(JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev1", event })));
    if (parsed?.type !== "event_callback") throw new Error("not an event");
    return parsed;
  };
  const inbound = (event: Record<string, unknown>) => slackInbound(envelope(event), { connectionIds: ["c1"], botUserId: "UBOT" });

  it("normalizes mentions and thread replies, and drops bots, edits, DMs and duplicate mention messages", () => {
    expect(inbound({ type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> hello  there", ts: "1.1" })).toMatchObject({
      mentioned: true,
      text: "hello there",
      threadId: "1.1",
      inThread: false,
      dedupeKey: "slack:T1:C1:1.1"
    });
    expect(inbound({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "more", ts: "2.2", thread_ts: "1.1" })).toMatchObject({ mentioned: false, threadId: "1.1", inThread: true });
    expect(inbound({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> hi", ts: "3.3" })).toBeUndefined();
    expect(inbound({ type: "message", channel: "C1", user: "UBOT", bot_id: "B1", text: "me", ts: "4.4" })).toBeUndefined();
    expect(inbound({ type: "message", subtype: "message_changed", channel: "C1", ts: "5.5" })).toBeUndefined();
    expect(inbound({ type: "message", channel: "D1", channel_type: "im", user: "U1", text: "dm", ts: "6.6" })).toBeUndefined();
    expect(inbound({ type: "reaction_added", user: "U1" })).toBeUndefined();
    expect(parseSlackEnvelope(Buffer.from("not json"))).toBeUndefined();
    expect(parseSlackEnvelope(Buffer.from('{"type":"url_verification","challenge":"c"}'))).toEqual({ type: "url_verification", challenge: "c" });
  });

  it("escapes text so a reply can't ping @channel or inject links", () => {
    expect(slackEscape("<!channel> a & b <http://x|y>")).toBe("&lt;!channel&gt; a &amp; b &lt;http://x|y&gt;");
  });
});

describe("picking the agent", () => {
  const binding = (id: string, agentId: string, respond: "mentions" | "all", createdAt: number): PresenceBinding => ({
    id,
    ownerId: "owner",
    workspaceId: "default",
    agentId,
    provider: "slack",
    connectionId: "c1",
    channelId: "C1",
    respond,
    createdBy: "local",
    createdAt,
    updatedAt: createdAt,
    status: "active"
  });
  const names: Record<string, string> = { a1: "Research", a2: "Sales Buddy" };
  const message = (over: Partial<InboundMessage>): InboundMessage => ({
    provider: "slack",
    connectionIds: ["c1"],
    spaceKey: "T1",
    channelId: "C1",
    messageId: "1",
    threadId: "1",
    inThread: false,
    authorId: "U1",
    text: "hello",
    mentioned: false,
    dedupeKey: "k",
    ...over
  });
  const candidates = [binding("b2", "a2", "all", 2), binding("b1", "a1", "mentions", 1)];
  const pick = (over: Partial<InboundMessage>, thread?: string) => pickBinding({ message: message(over), candidates, threadBindingId: thread, agentName: (id) => names[id] });

  it("follows the rules: named mention, first agent, thread member, answer-all", () => {
    expect(pick({ mentioned: true, text: "sales buddy: draft it" })).toMatchObject({ binding: { id: "b2" }, text: "draft it", reason: "mention" });
    expect(pick({ mentioned: true, text: "what's new?" })).toMatchObject({ binding: { id: "b1" }, reason: "mention" });
    expect(pick({ mentioned: true, inThread: true, text: "and now?" }, "b2")).toMatchObject({ binding: { id: "b2" } });
    expect(pick({ inThread: true }, "b1")).toMatchObject({ binding: { id: "b1" }, reason: "thread" });
    expect(pick({ inThread: true }, undefined)).toBeUndefined();
    expect(pick({})).toMatchObject({ binding: { id: "b2" }, reason: "all" });
    expect(pickBinding({ message: message({}), candidates: [binding("b1", "a1", "mentions", 1)], threadBindingId: undefined, agentName: () => "x" })).toBeUndefined();
  });

  it("matches agent names at the start only, with separators", () => {
    expect(afterName("@Research, summarize", "Research")).toBe("summarize");
    expect(afterName("researchers rule", "Research")).toBeUndefined();
    expect(afterName("sales-buddy hi", "Sales Buddy")).toBe("hi");
  });

  it("drops repeated delivery ids within the TTL", () => {
    let now = 0;
    const seen = new RecentIds(1000, 3, () => now);
    expect(seen.add("a")).toBe(true);
    expect(seen.add("a")).toBe(false);
    now = 2000;
    expect(seen.add("a")).toBe(true);
    for (const id of ["b", "c", "d", "e"]) seen.add(id);
    expect(seen.add("e")).toBe(false);
  });
});

describe("Teams notifications", () => {
  it("parses notifications and message resources, and checks clientState in constant time", () => {
    const state = newClientState();
    expect(state.value).not.toBe(state.hash);
    expect(clientStateMatches(state.hash, state.value)).toBe(true);
    expect(clientStateMatches(state.hash, "nope")).toBe(false);
    expect(clientStateMatches(state.hash, undefined)).toBe(false);
    expect(parseGraphNotifications(Buffer.from('{"value":[{"subscriptionId":"s","clientState":"c","changeType":"created","resource":"r"},{"bad":1}]}'))).toEqual([
      { subscriptionId: "s", clientState: "c", changeType: "created", resource: "r" }
    ]);
    expect(parseGraphNotifications(Buffer.from("[]"))).toBeUndefined();
    expect(parseMessageResource("teams('T1')/channels('19:a@thread.tacv2')/messages('M1')/replies('R1')")).toEqual({ teamId: "T1", channelId: "19:a@thread.tacv2", messageId: "M1", replyId: "R1" });
    expect(parseMessageResource("teams/T1/channels/19%3Aa%40thread.tacv2/messages/M1")).toEqual({ teamId: "T1", channelId: "19:a@thread.tacv2", messageId: "M1" });
    expect(parseMessageResource("users/x/messages/y")).toBeUndefined();
  });

  it("skips the connected account's own posts and strips its mention", () => {
    const base = { connectionId: "c1", teamId: "T1", channelId: "C", rootId: "M1", isReply: false, accountUserId: "UACC" };
    const message = {
      id: "M1",
      messageType: "message",
      from: { user: { id: "U1", displayName: "Maria" } },
      body: { contentType: "html" as const, content: "<p><at id=\"0\">Sibyl</at> hi <b>there</b></p>" },
      mentions: [{ id: 0, mentionText: "Sibyl", mentioned: { user: { id: "UACC" } } }]
    };
    expect(teamsInbound(message, base)).toMatchObject({ mentioned: true, text: "hi there", authorName: "Maria", inThread: false });
    expect(teamsInbound({ ...message, from: { user: { id: "UACC" } } }, base)).toBeUndefined();
    expect(teamsInbound({ ...message, messageType: "systemEventMessage" }, base)).toBeUndefined();
    expect(teamsInbound({ ...message, mentions: [] }, { ...base, isReply: true })).toMatchObject({ mentioned: false, inThread: true });
    expect(teamsHtml("R&D <bot>", "a\n<b>")).toBe("<p><b>R&amp;D &lt;bot&gt;</b></p><p>a<br>&lt;b&gt;</p>");
  });
});

describe("who a channel turn acts as", () => {
  it("keeps the creator's roles under a channel id (no personal connections)", () => {
    const principal = channelPrincipal({ kind: "user", orgId: "owner", userId: "u1", email: "u1@x", orgRole: "member", workspaceRoles: { default: "admin" } }, "b1");
    expect(principal).toEqual({ kind: "user", orgId: "owner", userId: "channel:b1", orgRole: "member", workspaceRoles: { default: "admin" } });
    const local = channelPrincipal({ kind: "local", orgId: "owner", orgRole: "owner", workspaceRoles: {} }, "b2");
    expect(local).toMatchObject({ kind: "user", userId: "channel:b2", orgRole: "owner" });
  });

  it("gates the routes: callbacks unauthenticated, settings for admins, the rest for agent users", () => {
    expect(protectedRoutePermission("POST", "/api/presence/slack/events")).toBeUndefined();
    expect(protectedRoutePermission("POST", "/api/presence/teams/notifications")).toBeUndefined();
    expect(protectedRoutePermission("POST", "/api/presence/teams/lifecycle")).toBeUndefined();
    expect(protectedRoutePermission("PUT", "/api/presence/settings")).toEqual({ permission: PERMISSIONS.INTEGRATIONS_CONNECT_SHARED });
    expect(protectedRoutePermission("GET", "/api/presence/settings")).toEqual({ permission: PERMISSIONS.INTEGRATIONS_USE });
    expect(protectedRoutePermission("GET", "/api/presence/channels")).toEqual({ permission: PERMISSIONS.INTEGRATIONS_USE });
    expect(protectedRoutePermission("POST", "/api/presence/agents/a1/bindings")).toEqual({ permission: PERMISSIONS.AGENTS_USE });
  });
});
