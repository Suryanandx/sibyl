/**
 * Meetings: records and access, the transcript the room reports, incremental
 * notes (only new lines go to the model), the guest lobby, comments, tasks
 * from action items, and the route gate. The room itself (LiveKit) is
 * verified live (docs/meetings.md, "Verified").
 */
import { describe, expect, test } from "vitest";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import { createMemoryStore, type Principal, type UsageEvent } from "@open-gpt-live/core";
import { protectedRoutePermission } from "../identity/http.js";
import { createNoopMeter } from "../runtime.js";
import type { RealtimeService, CallHooks } from "../realtime/service.js";
import type { RoomMeetingHooks } from "../realtime/room-agent.js";
import { Lobby, LOBBY_KNOCKS_PER_MINUTE, cleanName } from "./lobby.js";
import { clock, parseNotes, tail, transcriptLines } from "./notes.js";
import { isMeetingGuestRoute } from "./routes.js";
import { MeetingError, MeetingService, meetingMarkdown } from "./service.js";

const ada: Principal = { kind: "user", orgId: "owner", userId: "ada", name: "Ada", workspaceRoles: { default: "member", other: "member" } };
const bob: Principal = { kind: "user", orgId: "owner", userId: "bob", name: "Bob", workspaceRoles: { default: "member" } };
const viewerless: Principal = { kind: "user", orgId: "owner", userId: "eve", name: "Eve", workspaceRoles: {} };

/** A model that answers with canned notes and remembers what it was sent. */
function fakeModel(reply: (user: string) => string) {
  const calls: string[] = [];
  const provider: ToolChatProvider = {
    async *streamWithTools(messages) {
      const user = String(messages.at(-1)?.content ?? "");
      calls.push(user);
      yield { type: "text", delta: reply(user) } as never;
      yield { type: "usage", usage: { costUsd: 0.0002, promptTokens: 500, completionTokens: 200 } } as never;
    }
  };
  return { provider, calls };
}

function setup(options: { reply?: (user: string) => string } = {}) {
  let now = 1_000_000;
  const store = createMemoryStore();
  const recorded: UsageEvent[] = [];
  const meter = { ...createNoopMeter(), record: (event: never) => void recorded.push(event) };
  const published: Array<{ recipientUserId?: string; title: string }> = [];
  const service = new MeetingService({
    store,
    ownerId: "owner",
    meter: meter as never,
    env: { SIBYL_MEETING_MODEL: "cheap/model" },
    log: () => undefined,
    notifications: { publish: (input: { recipientUserId?: string; title: string }) => void published.push(input) } as never,
    now: () => now
  });
  const model = fakeModel(
    options.reply ??
      ((user) =>
        JSON.stringify({
          overview: "Launch review.",
          keyPoints: ["Beta on the 20th"],
          insights: ["Login is the risk"],
          // Like a well-behaved model: keep the ids it was given.
          actions: [{ id: /"id":"([\w-]+)"/.exec(user)?.[1], text: "Fix login", owner: "Bob", due: "2099-01-14" }]
        }))
  );
  service.configure({ provider: model.provider, model: () => "deep/model" });
  let hooks: CallHooks | undefined;
  const ended: string[] = [];
  const realtime = {
    useCalls: (given: CallHooks) => (hooks = given),
    callAgent: () => undefined,
    guestToken: async (_ws: string, callId: string, guest: { id: string; name: string }) => ({ url: "ws://lk", token: `token-for-${guest.name}`, room: `sibyl.call.default.${callId}`, identity: `guest:${guest.id}` }),
    endCall: async (_ws: string, callId: string) => {
      ended.push(callId);
      hooks?.closed(callId, "ended by host");
    }
  } as unknown as RealtimeService;
  service.attach(realtime);
  return {
    store,
    service,
    model,
    recorded,
    published,
    ended,
    hooks: () => hooks!,
    tick: (ms: number) => (now += ms),
    now: () => now
  };
}

const ada0 = { principal: ada, workspaceId: "default" };
const bob0 = { principal: bob, workspaceId: "default" };

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("meeting records and access", () => {
  test("anyone in the workspace sees a meeting; only the host runs it; other workspaces don't see it", async () => {
    const { service } = setup();
    const view = await service.create(ada0, { title: "Weekly sync", scheduledAt: 2_000_000, sibylRole: "notetaker" });
    expect(view).toMatchObject({ title: "Weekly sync", isHost: true, status: "scheduled", sibylRole: "notetaker" });
    expect(view.guestPath).toMatch(/^\/join\/[\w-]+\?k=[\w-]+$/);
    const asBob = await service.get(bob0, view.id);
    expect(asBob.isHost).toBe(false);
    expect(asBob.guestPath).toBeUndefined();
    await expect(service.update(bob0, view.id, { title: "Mine now" })).rejects.toMatchObject({ status: 403 });
    await expect(service.get({ principal: ada, workspaceId: "other" }, view.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.list({ principal: viewerless, workspaceId: "default" })).rejects.toBeInstanceOf(MeetingError);
    expect((await service.update(ada0, view.id, { title: "Renamed" })).title).toBe("Renamed");
    expect((await service.list(bob0, "renam")).map((m) => m.id)).toEqual([view.id]);
  });
});

describe("the room reports the transcript; notes are incremental", () => {
  test("only the host brings Sibyl in; segments carry offsets; arrivals get stable colours", async () => {
    const t = setup();
    const view = await t.service.create(ada0, { title: "Launch" });
    await expect(t.hooks().open({ callId: view.id, principal: bob, workspaceId: "default", conversationId: "c1" })).rejects.toThrow(/host/i);
    const room: RoomMeetingHooks = await t.hooks().open({ callId: view.id, principal: ada, workspaceId: "default", conversationId: "c1" });
    expect(room.roles).toEqual({ sibyl: "participant" });
    const start = t.now();
    room.onArrival({ identity: "user:ada", name: "Ada", kind: "person" });
    room.onArrival({ identity: "agent:scribe", name: "Scribe", kind: "agent", agentId: "scribe", role: "notetaker" });
    room.onSegment({ speaker: "user:bob", speakerName: "Bob", kind: "person", text: "I will fix the login by Friday.", startedAt: start + 4_000, endedAt: start + 7_000 });
    await settle();
    const live = await t.service.get(ada0, view.id);
    expect(live.status).toBe("live");
    expect(live.participants.map((p) => [p.identity, p.color, p.role ?? ""])).toEqual([
      ["user:ada", 0, ""],
      ["agent:scribe", 1, "notetaker"],
      ["user:bob", 2, ""]
    ]);
    expect(await t.service.transcript(bob0, view.id)).toMatchObject([{ seq: 1, speakerName: "Bob", startMs: 4_000, endMs: 7_000 }]);
  });

  test("a refresh sends only lines said since the last one, keeps action ids, and the end writes final notes once", async () => {
    const t = setup();
    const view = await t.service.create(ada0, { title: "Launch" });
    const room = await t.hooks().open({ callId: view.id, principal: ada, workspaceId: "default", conversationId: "c1" });
    const say = (text: string) => room.onSegment({ speaker: "user:bob", speakerName: "Bob", kind: "person", text, startedAt: t.now(), endedAt: t.now() + 1_000 });
    say("First part of the meeting. ".repeat(10));
    t.tick(4 * 60_000);
    say("Second part: the beta is on the twentieth. ".repeat(6));
    await settle();
    expect(t.model.calls).toHaveLength(1);
    expect(t.model.calls[0]).toContain("First part");
    const first = await t.service.get(ada0, view.id);
    const actionId = first.notes!.actions[0]!.id;
    t.tick(4 * 60_000);
    say("Third part. ".repeat(30));
    await settle();
    expect(t.model.calls).toHaveLength(2);
    expect(t.model.calls[1]).not.toContain("First part");
    expect(t.model.calls[1]).toContain("Third part");
    expect(t.model.calls[1]).toContain(actionId);
    expect((await t.service.get(ada0, view.id)).notes!.actions[0]!.id).toBe(actionId);

    // "End for everyone": the room closes and the call returns once the final notes are written.
    await expect(t.service.end(bob0, view.id)).rejects.toMatchObject({ status: 403 });
    await t.service.end(ada0, view.id);
    expect(t.ended).toEqual([view.id]);
    const done = await t.service.get(ada0, view.id);
    expect(done.status).toBe("ended");
    expect(done.notes?.final).toBe(true);
    expect(t.recorded.every((event) => event.feature === "meetings" && event.model === "cheap/model")).toBe(true);
    expect(done.costUsd).toBeGreaterThan(0);
    // Notes ready → the people who were there (and the host).
    expect(t.published.map((n) => n.recipientUserId).sort()).toEqual(["ada", "bob"]);
  });

  test("Ask AI answers from the transcript with the deep model", async () => {
    const t = setup({ reply: (user) => (user.includes("Question:") ? "Bob fixes the login by Friday [00:04]." : "{}") });
    const view = await t.service.create(ada0, { title: "Launch" });
    expect(await t.service.ask(bob0, view.id, "What did Bob agree to?")).toMatch(/nothing has been said/i);
    const room = await t.hooks().open({ callId: view.id, principal: ada, workspaceId: "default", conversationId: "c1" });
    room.onSegment({ speaker: "user:bob", speakerName: "Bob", kind: "person", text: "I will fix the login by Friday.", startedAt: t.now() + 4_000, endedAt: t.now() + 6_000 });
    await settle();
    expect(await t.service.ask(bob0, view.id, "What did Bob agree to?")).toContain("Friday");
    expect(t.model.calls.at(-1)).toContain("[00:04] Bob: I will fix the login by Friday.");
    expect(t.recorded.at(-1)).toMatchObject({ feature: "meetings", model: "deep/model", userId: "bob" });
  });
});

describe("guests", () => {
  test("knock with the guest-link key; a token only after the host admits; never the notes", async () => {
    const t = setup();
    const view = await t.service.create(ada0, { title: "Customer call" });
    const key = new URLSearchParams(view.guestPath!.split("?")[1]).get("k");
    await expect(t.service.knock(view.id, "wrong-key", "Mallory")).rejects.toMatchObject({ status: 404 });
    expect(await t.service.preview(view.id, key)).toEqual({ title: "Customer call", hostName: "Ada", status: "scheduled" });
    const { ticket } = await t.service.knock(view.id, key, "  Grace <script> ");
    expect(await t.service.lobbyStatus(view.id, ticket)).toEqual({ status: "waiting", title: "Customer call" });
    await expect(t.service.lobbyWaiting(bob0, view.id)).rejects.toMatchObject({ status: 403 });
    expect((await t.service.lobbyWaiting(ada0, view.id)).map((k) => k.name)).toEqual(["Grace script"]);
    expect(await t.service.decideKnock(ada0, view.id, ticket, true)).toBe(true);
    const admitted = await t.service.lobbyStatus(view.id, ticket);
    expect(admitted.status).toBe("admitted");
    expect(admitted.grant).toMatchObject({ token: "token-for-Grace script" });
    expect(admitted.grant!.identity).toMatch(/^guest:/);
    const denied = await t.service.knock(view.id, key, "Zed");
    await t.service.decideKnock(ada0, view.id, denied.ticket, false);
    expect((await t.service.lobbyStatus(view.id, denied.ticket)).grant).toBeUndefined();
  });

  test("the lobby limits knocks and expires them", () => {
    let now = 0;
    const lobby = new Lobby(() => now);
    for (let i = 0; i < LOBBY_KNOCKS_PER_MINUTE; i += 1) lobby.knock("m", `Guest ${i}`);
    expect(() => lobby.knock("m", "One more")).toThrow(/too many/i);
    now += 61_000;
    const late = lobby.knock("m", "Late");
    now += 16 * 60_000;
    expect(lobby.get("m", late.ticket)).toBeUndefined();
    expect(() => lobby.knock("m", "   ")).toThrow(/name/i);
    expect(cleanName("A\u0000b [admin] {x}")).toBe("Ab admin x");
  });
});

describe("comments and tasks", () => {
  test("replies stay one level deep; reactions toggle per person; only the author edits", async () => {
    const t = setup();
    const view = await t.service.create(ada0, { title: "Launch" });
    const top = await t.service.addComment(ada0, view.id, { text: "Ship the login fix first.", atMs: 12_000 });
    const reply = await t.service.addComment(bob0, view.id, { text: "Agreed.", parentId: top.id });
    const nested = await t.service.addComment(ada0, view.id, { text: "Thanks", parentId: reply.id });
    expect(nested.parentId).toBe(top.id);
    expect((await t.service.react(bob0, view.id, top.id, "👍")).reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
    expect((await t.service.react(ada0, view.id, top.id, "👍")).reactions).toEqual([{ emoji: "👍", count: 2, mine: true }]);
    expect((await t.service.react(bob0, view.id, top.id, "👍")).reactions).toEqual([{ emoji: "👍", count: 1, mine: false }]);
    await expect(t.service.react(bob0, view.id, top.id, "💣")).rejects.toThrow(/reaction/i);
    await expect(t.service.editComment(bob0, view.id, top.id, "Hijack")).rejects.toMatchObject({ status: 403 });
    await t.service.deleteComment(ada0, view.id, top.id);
    expect(await t.service.comments(bob0, view.id)).toEqual([]);
  });

  test("an action item becomes a one-time routine at 09:00 on its due date", async () => {
    const t = setup();
    const view = await t.service.create(ada0, { title: "Launch" });
    const room = await t.hooks().open({ callId: view.id, principal: ada, workspaceId: "default", conversationId: "c1" });
    room.onSegment({ speaker: "user:bob", speakerName: "Bob", kind: "person", text: "I will fix the login. ".repeat(20), startedAt: t.now(), endedAt: t.now() + 1_000 });
    await settle();
    await t.service.refreshNotes(ada0, view.id);
    const action = (await t.service.get(ada0, view.id)).notes!.actions[0]!;
    const { input } = await t.service.taskInput(bob0, view.id, action.id);
    expect(input).toMatchObject({ cron: "0 9 14 1 *", once: true });
    expect(String(input.instruction)).toContain("Fix login");
    await t.service.taskCreated(view.id, action.id, "routine-1");
    await expect(t.service.taskInput(bob0, view.id, action.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("notes parsing and formatting", () => {
  test("tolerant JSON; bad replies give nothing; tasks already made are kept", () => {
    const previous = { overview: "", keyPoints: [], insights: [], actions: [{ id: "a1", text: "Old", routineId: "r1" }], coveredSeq: 1, updatedAt: 0 };
    const parsed = parseNotes('Sure!\n```json\n{"overview":"  Hi  there ","keyPoints":["x",3],"actions":[{"text":"New","due":"next week"}]}\n```', previous);
    expect(parsed).toMatchObject({ overview: "Hi there", keyPoints: ["x"], insights: [] });
    expect(parsed!.actions.map((a) => [a.text, a.due, a.routineId])).toEqual([
      ["New", undefined, undefined],
      ["Old", undefined, "r1"]
    ]);
    expect(parseNotes("no json here", undefined)).toBeUndefined();
  });

  test("transcript lines, clock and tail", () => {
    expect(clock(3_723_000)).toBe("1:02:03");
    expect(clock(65_000)).toBe("01:05");
    const lines = transcriptLines([{ meetingId: "m", ownerId: "o", seq: 1, speaker: "user:a", speakerName: "Ada", kind: "person", startMs: 5_000, endMs: 6_000, text: "Hello\n there", at: 0 }]);
    expect(lines).toEqual(["[00:05] Ada: Hello there"]);
    expect(tail(["aaaa", "bbbb", "cccc"], 10)).toBe("bbbb\ncccc");
  });

  test("Markdown export has notes, actions and the transcript", () => {
    const text = meetingMarkdown(
      {
        id: "m",
        ownerId: "o",
        workspaceId: "default",
        title: "Launch",
        host: "ada",
        hostName: "Ada",
        status: "ended",
        participants: [{ identity: "user:ada", name: "Ada", kind: "person", color: 0 }],
        sibylRole: "notetaker",
        inviteKey: "k",
        notes: { overview: "Went well.", keyPoints: ["Beta"], insights: [], actions: [{ id: "a", text: "Fix login", owner: "Bob" }], coveredSeq: 1, updatedAt: 0 },
        createdAt: 0,
        updatedAt: 0
      },
      [{ meetingId: "m", ownerId: "o", seq: 1, speaker: "user:ada", speakerName: "Ada", kind: "person", startMs: 0, endMs: 1, text: "Hi", at: 0 }]
    );
    expect(text).toContain("## Overview");
    expect(text).toContain("- [ ] Fix login — Bob");
    expect(text).toContain("**[00:00] Ada:** Hi");
  });
});

describe("route gate", () => {
  test("guests reach only knock, preview and their lobby ticket; everything else needs chat.use", () => {
    expect(isMeetingGuestRoute("POST", "/api/meetings/abcdef123/lobby")).toBe(true);
    expect(isMeetingGuestRoute("POST", "/api/meetings/abcdef123/preview")).toBe(true);
    expect(isMeetingGuestRoute("GET", "/api/meetings/abcdef123/lobby/ticket1")).toBe(true);
    expect(isMeetingGuestRoute("GET", "/api/meetings/abcdef123/lobby")).toBe(false);
    expect(isMeetingGuestRoute("POST", "/api/meetings/abcdef123/lobby/ticket1")).toBe(false);
    expect(isMeetingGuestRoute("GET", "/api/meetings/abcdef123")).toBe(false);
    expect(protectedRoutePermission("POST", "/api/meetings/abcdef123/lobby")).toBeUndefined();
    expect(protectedRoutePermission("GET", "/api/meetings/abcdef123/lobby")).toEqual({ permission: "chat.use" });
    expect(protectedRoutePermission("GET", "/api/meetings/abcdef123/transcript")).toEqual({ permission: "chat.use" });
    expect(protectedRoutePermission("POST", "/api/meetings/abcdef123/end")).toEqual({ permission: "chat.use" });
  });
});
