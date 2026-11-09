import type { LLMProvider, STTProvider, ToolChatEvent, ToolChatProvider } from "@open-gpt-live/adapters";
import { createMemoryStore, createToolRegistry, ownerPrincipal, type ToolDefinition } from "@open-gpt-live/core";
import {
  NOTIFICATION_EVENTS,
  ROUTINE_EVENTS,
  WS_EVENTS,
  parseClientMessage,
  parseServerMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer } from "../gateway.js";
import { installNotifications } from "../notifications/index.js";
import { createNoopMeter, createTestRuntime } from "../runtime.js";
import { RoutineService } from "./service.js";

describe("routines protocol parsers", () => {
  test("client messages are validated strictly", () => {
    expect(parseClientMessage({ type: "routines.request" }).success).toBe(true);
    expect(parseClientMessage({ type: "inbox.request" }).success).toBe(true);
    expect(parseClientMessage({ type: "routines.context", timezone: "Europe/Berlin" }).success).toBe(true);
    expect(parseClientMessage({ type: "routines.context", timezone: "<script>" }).success).toBe(false);
    expect(parseClientMessage({ type: "routine.run_now", routineId: "r1" }).success).toBe(true);
    expect(parseClientMessage({ type: "routine.delete" }).success).toBe(false);
    const update = parseClientMessage({ type: "routine.update", routineId: "r1", patch: { enabled: false, maxRunUsd: null, cron: " 0 8 * * * ", extra: 1 } });
    expect(update).toEqual({ success: true, data: { type: "routine.update", routineId: "r1", patch: { enabled: false, maxRunUsd: null, cron: "0 8 * * *" } } });
    expect(parseClientMessage({ type: "routine.update", routineId: "r1", patch: {} }).success).toBe(false);
    expect(parseClientMessage({ type: "routine.update", routineId: "r1", patch: { maxRunUsd: -1 } }).success).toBe(false);
    expect(parseClientMessage({ type: "routine.update", routineId: "r1", patch: { enabled: "yes" } }).success).toBe(false);
    expect(parseClientMessage({ type: "routine.update", routineId: "r1", patch: { name: "" } }).success).toBe(false);
    expect(parseClientMessage({ type: "nope" }).success).toBe(false);
  });

  test("server messages are validated strictly", () => {
    const view = { id: "r", name: "N", instruction: "I", cron: "0 8 * * *", timezone: "UTC", schedule: "every day", enabled: true };
    expect(parseServerMessage({ type: "routines.list", items: [view] }).success).toBe(true);
    expect(parseServerMessage({ type: "routines.list", items: [{ ...view, enabled: "yes" }] }).success).toBe(false);
    expect(parseServerMessage({ type: "routines.list", items: [{ ...view, lastRun: { id: "x", status: "weird", startedAt: 1, costUsd: 0 } }] }).success).toBe(false);
    const approval = { id: "a", runId: "r", routineId: "x", toolName: "t", title: "T", summary: "S", createdAt: 1 };
    expect(parseServerMessage({ type: "inbox.list", items: [approval] }).success).toBe(true);
    expect(parseServerMessage({ type: "inbox.list", items: [{ ...approval, createdAt: "now" }] }).success).toBe(false);
    // Routine notices are notifications now; the old wire event is gone.
    const notification = { kind: "finished", routineId: "r", routineName: "N", runId: "x", message: "done", at: 1 };
    expect(parseServerMessage({ type: "routine.notification", notification }).success).toBe(false);
  });
});

/** Model: first round calls the write tool, second round answers. */
function provider(): ToolChatProvider {
  let round = 0;
  return {
    async *streamWithTools(): AsyncIterable<ToolChatEvent> {
      round += 1;
      if (round % 2 === 1) {
        yield { type: "tool_calls", calls: [{ id: `c${round}`, name: "send_note", arguments: JSON.stringify({ text: "hi" }) }] };
      } else {
        yield { type: "text", delta: "Note sent." };
      }
      yield { type: "usage", usage: { costUsd: 0.001 } };
    }
  };
}

test("routines and inbox over the gateway WebSocket", async () => {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const meter = createNoopMeter();
  const sent: unknown[] = [];
  const note: ToolDefinition<any, any> = {
    name: "send_note",
    title: "Send a note",
    description: "send",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    effect: "write",
    source: "builtin",
    run: async (input) => (sent.push(input), { content: "ok" })
  };
  tools.register(note);
  const notifications = installNotifications({ store, ownerId: "owner", env: {}, log: () => undefined });
  const routines = new RoutineService({ store, tools, meter, ownerId: "owner", env: { TZ: "UTC" }, log: () => undefined, notifications });
  await routines.init();
  await routines.startScheduler({ provider: provider(), model: () => "brain/deep", systemPrompt: "BRAIN", scheduler: { tickMs: 60_000_000 } });
  const runtime = createTestRuntime({ store, tools, meter, routines, notifications });
  const llm: LLMProvider = { async *streamText() { yield { delta: "hi" }; } };
  const stt: STTProvider = { transcribe: async () => ({ text: "" }) };
  const gateway = await createGatewayServer({ providers: { llm, stt }, host: "127.0.0.1", runtime });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => {
    const parsed = parseServerMessage(JSON.parse(raw.toString()));
    if (parsed.success) messages.push(parsed.data);
  });
  await new Promise((resolve) => socket.once("open", resolve));
  const send = (m: unknown) => socket.send(JSON.stringify(m));
  const waitFor = async <T extends ServerMessage>(predicate: (m: ServerMessage) => boolean, from = 0): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const found = messages.slice(from).find(predicate);
      if (found) return found as T;
      if (Date.now() - start > 3000) throw new Error(`timeout; got ${messages.map((m) => m.type).join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  type List = Extract<ServerMessage, { type: "routines.list" }>;
  type Inbox = Extract<ServerMessage, { type: "inbox.list" }>;

  try {
    send({ type: ROUTINE_EVENTS.ROUTINES_CONTEXT, timezone: "Europe/Paris" });
    send({ type: ROUTINE_EVENTS.ROUTINES_REQUEST });
    expect((await waitFor<List>((m) => m.type === "routines.list")).items).toEqual([]);
    expect(routines.getTimezone()).toBe("Europe/Paris");

    // Create one through the chat tool (as the brain would after approval).
    const result = await tools.get("create_routine")!.run(
      { name: "Notes", instruction: "Send me a note", cron: "0 9 * * *" },
      { signal: new AbortController().signal, ownerId: "owner", runId: "x", principal: ownerPrincipal("owner", "local"), workspaceId: "default", store, meter, log: () => undefined }
    );
    expect(result.isError).toBeFalsy();
    const created = await waitFor<List>((m) => m.type === "routines.list" && m.items.length === 1);
    const routine = created.items[0]!;
    expect(routine).toMatchObject({ name: "Notes", timezone: "Europe/Paris", schedule: "every day at 09:00 (Europe/Paris)", enabled: true });

    // Edit: pause.
    let mark = messages.length;
    send({ type: ROUTINE_EVENTS.ROUTINE_UPDATE, routineId: routine.id, patch: { enabled: false } });
    const paused = await waitFor<List>((m) => m.type === "routines.list", mark);
    expect(paused.items[0]).toMatchObject({ enabled: false });
    expect(paused.items[0]?.nextRunAt).toBeUndefined();

    // Bad edit: error, and the list is re-sent unchanged.
    mark = messages.length;
    send({ type: ROUTINE_EVENTS.ROUTINE_UPDATE, routineId: routine.id, patch: { cron: "61 * * * *" } });
    expect(await waitFor((m) => m.type === "error", mark)).toMatchObject({ message: expect.stringMatching(/minute out of range/) });

    // Run now: it needs an approval → notification + inbox entry.
    mark = messages.length;
    send({ type: ROUTINE_EVENTS.ROUTINE_RUN_NOW, routineId: routine.id });
    type Live = Extract<ServerMessage, { type: "notification" }>;
    const needs = await waitFor<Live>((m) => m.type === NOTIFICATION_EVENTS.NOTIFICATION && m.notification.kind === "approval_needed", mark);
    expect(needs.notification.links.routineId).toBe(routine.id);
    const approvalId = needs.notification.links.approvalId!;
    const request = await waitFor<Extract<ServerMessage, { type: "approval.request" }>>((m) => m.type === "approval.request", mark);
    expect(request.approval).toMatchObject({ id: approvalId, routineId: routine.id, toolName: "send_note" });
    send({ type: ROUTINE_EVENTS.INBOX_REQUEST });
    const inbox = await waitFor<Inbox>((m) => m.type === "inbox.list" && m.items.length === 1, mark);
    expect(inbox.items[0]).toMatchObject({ id: approvalId, routineId: routine.id });
    const running = await waitFor<List>((m) => m.type === "routines.list" && m.items[0]?.lastRun?.status === "awaiting_approval", mark);
    expect(running.items[0]?.lastRun?.status).toBe("awaiting_approval");

    // Decide from the inbox with the usual approval.decision.
    mark = messages.length;
    send({ type: WS_EVENTS.APPROVAL_DECISION, id: approvalId, decision: "approve" });
    expect(await waitFor((m) => m.type === "approval.resolved", mark)).toMatchObject({ id: approvalId, status: "approved" });
    // Deciding reads the approval's notification; the run's outcome is a new one.
    const read = await waitFor<Extract<ServerMessage, { type: "notifications.state" }>>((m) => m.type === NOTIFICATION_EVENTS.STATE, mark);
    expect(read.ids).toEqual([needs.notification.id]);
    const finished = await waitFor<Live>((m) => m.type === NOTIFICATION_EVENTS.NOTIFICATION && m.notification.kind === "routine_finished", mark);
    expect(finished.notification.links.conversationId).toBeTruthy();
    send({ type: NOTIFICATION_EVENTS.REQUEST });
    const feed = await waitFor<Extract<ServerMessage, { type: "notifications.list" }>>((m) => m.type === NOTIFICATION_EVENTS.LIST, mark);
    expect(feed.items.map((n) => n.kind)).toEqual(["routine_finished", "approval_needed"]);
    expect(feed.unread).toEqual({ total: 1, byKind: { routine_finished: 1 } });
    expect(sent).toEqual([{ text: "hi" }]);
    await waitFor<Inbox>((m) => m.type === "inbox.list" && m.items.length === 0, mark);
    const conversation = await store.conversations.get("owner", finished.notification.links.conversationId!);
    expect(conversation?.messages.at(-1)?.content).toBe("Note sent.");
    const done = await waitFor<List>((m) => m.type === "routines.list" && m.items[0]?.lastRun?.status === "succeeded", mark);
    expect(done.items[0]?.lastRun?.costUsd).toBeCloseTo(0.002);

    // Chat approvals (no routineId) still go to the connection's broker.
    await store.approvals.create({ id: "chat-1", ownerId: "owner", runId: "req", toolName: "send_note", title: "Send", summary: "s", input: {}, status: "pending", createdAt: Date.now() });
    mark = messages.length;
    send({ type: WS_EVENTS.APPROVAL_DECISION, id: "chat-1", decision: "decline" });
    expect(await waitFor((m) => m.type === "approval.resolved", mark)).toMatchObject({ id: "chat-1", status: "declined" });

    // Delete.
    mark = messages.length;
    send({ type: ROUTINE_EVENTS.ROUTINE_DELETE, routineId: routine.id });
    expect((await waitFor<List>((m) => m.type === "routines.list", mark)).items).toEqual([]);
  } finally {
    socket.close();
    await gateway.close();
    await routines.stop();
  }
});
