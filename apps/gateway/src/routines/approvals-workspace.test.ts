/**
 * Approvals and the inbox are workspace-scoped: an approval is listed,
 * pushed and decided only in its own workspace, by someone who may decide it
 * there.
 */
import { createMemoryStore, createToolRegistry, ownerPrincipal, type ApprovalRecord, type Principal, type Role } from "@open-gpt-live/core";
import { ROUTINE_EVENTS, WS_EVENTS, type ServerMessage } from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { approvalWorkspace, canDecideChatApproval } from "../brain/approvals.js";
import { createNoopMeter } from "../runtime.js";
import { createRoutineRecord } from "./records.js";
import { RoutineService } from "./service.js";

const person = (userId: string, roles: Record<string, Role>): Principal => ({ kind: "user", orgId: "owner", userId, orgRole: "member", workspaceRoles: roles });
const alice = person("alice", { "ws-a": "member", "ws-b": "member" });
const bob = person("bob", { "ws-b": "admin" });
const vic = person("vic", { "ws-a": "viewer" });
const ada = person("ada", { "ws-a": "admin" });

function pending(id: string, extra: Partial<ApprovalRecord>): ApprovalRecord {
  return { id, ownerId: "owner", runId: `run-${id}`, toolName: "send_note", title: "Send", summary: "s", input: {}, status: "pending", createdAt: 1, ...extra };
}

async function setup() {
  const store = createMemoryStore();
  const routines = new RoutineService({ store, tools: createToolRegistry(), meter: createNoopMeter(), ownerId: "owner", env: { TZ: "UTC" }, log: () => undefined });
  const routine = createRoutineRecord({ name: "Notes", instruction: "x", cron: "0 9 * * *", timezone: "UTC" }, { id: "r-a", ownerId: "owner", now: 1, workspaceId: "ws-a", createdBy: "alice" });
  await store.routines.upsert(routine);
  await store.approvals.create(pending("routine-ap", { routineId: "r-a", workspaceId: "ws-a", requestedBy: "alice" }));
  await store.approvals.create(pending("chat-ap", { workspaceId: "ws-a", requestedBy: "alice" }));
  // An older record without a workspace: its chat's workspace counts.
  await store.conversations.upsert({ id: "c-b", ownerId: "owner", workspaceId: "ws-b", title: "t", createdAt: 1, updatedAt: 1, messages: [] });
  await store.approvals.create(pending("old-chat-ap", { conversationId: "c-b" }));
  return { store, routines };
}

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id).sort();

describe("approvals across workspaces", () => {
  test("the inbox lists only approvals of the caller's current workspace that they may decide", async () => {
    const { routines } = await setup();
    expect(ids(await routines.inbox({ principal: alice, workspaceId: "ws-a" }))).toEqual(["chat-ap", "routine-ap"]);
    // Same person, other workspace: none of ws-a's.
    expect(ids(await routines.inbox({ principal: alice, workspaceId: "ws-b" }))).toEqual([]);
    // Not a member of ws-a, even as an admin elsewhere.
    expect(ids(await routines.inbox({ principal: bob, workspaceId: "ws-a" }))).toEqual([]);
    expect(ids(await routines.inbox({ principal: bob, workspaceId: "ws-b" }))).toEqual([]);
    // A viewer can't run write tools; an admin may decide routine approvals but not someone's chat approval.
    expect(ids(await routines.inbox({ principal: vic, workspaceId: "ws-a" }))).toEqual([]);
    expect(ids(await routines.inbox({ principal: ada, workspaceId: "ws-a" }))).toEqual(["routine-ap"]);
    // The org owner (token/local) sees older chat approvals in their chat's workspace.
    expect(ids(await routines.inbox({ principal: ownerPrincipal("owner", "local"), workspaceId: "ws-b" }))).toEqual(["old-chat-ap"]);
  });

  test("a routine approval is decided only in its workspace, by someone who may", async () => {
    const { store, routines } = await setup();
    expect(await routines.decideApproval({ principal: bob, workspaceId: "ws-b" }, "routine-ap", "approve")).toBeUndefined();
    expect(await routines.decideApproval({ principal: bob, workspaceId: "ws-a" }, "routine-ap", "approve")).toBeUndefined();
    expect(await routines.decideApproval({ principal: vic, workspaceId: "ws-a" }, "routine-ap", "approve")).toBeUndefined();
    expect((await store.approvals.get("owner", "routine-ap"))?.status).toBe("pending");
    expect(await routines.decideApproval({ principal: alice, workspaceId: "ws-a" }, "routine-ap", "decline")).toBe("declined");
    expect((await store.approvals.get("owner", "routine-ap"))?.status).toBe("declined");
  });

  test("a chat approval is decided only by the person it was asked of, in its workspace", async () => {
    const { store } = await setup();
    const chat = (await store.approvals.get("owner", "chat-ap"))!;
    expect(await approvalWorkspace(store, "owner", chat)).toBe("ws-a");
    expect(canDecideChatApproval(alice, chat, "ws-a")).toBe(true);
    expect(canDecideChatApproval(ada, chat, "ws-a")).toBe(false);
    expect(canDecideChatApproval(bob, chat, "ws-a")).toBe(false);
    const old = (await store.approvals.get("owner", "old-chat-ap"))!;
    expect(await approvalWorkspace(store, "owner", old)).toBe("ws-b");
    expect(canDecideChatApproval(bob, old, "ws-b")).toBe(false);
    expect(canDecideChatApproval(ownerPrincipal("owner", "token"), old, "ws-b")).toBe(true);
  });

  test("inbox pushes and resolutions reach only browsers in the approval's workspace", async () => {
    const { routines } = await setup();
    const tab = (principal: Principal, workspaceId: string) => {
      const messages: ServerMessage[] = [];
      routines.subscribe({ send: (m) => void messages.push(m), principal: () => principal, workspaceId: () => workspaceId });
      return messages;
    };
    const aliceA = tab(alice, "ws-a");
    const aliceB = tab(alice, "ws-b");
    const bobB = tab(bob, "ws-b");
    await routines.broadcastInbox();
    const inboxOf = (messages: ServerMessage[]) => messages.filter((m): m is Extract<ServerMessage, { type: "inbox.list" }> => m.type === ROUTINE_EVENTS.INBOX_LIST).at(-1)!;
    expect(ids(inboxOf(aliceA).items)).toEqual(["chat-ap", "routine-ap"]);
    expect(inboxOf(aliceB).items).toEqual([]);
    expect(inboxOf(bobB).items).toEqual([]);

    await routines.decideApproval({ principal: alice, workspaceId: "ws-a" }, "routine-ap", "approve");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const resolved = (messages: ServerMessage[]) => messages.filter((m) => m.type === WS_EVENTS.APPROVAL_RESOLVED);
    expect(resolved(aliceA)).toEqual([{ type: WS_EVENTS.APPROVAL_RESOLVED, id: "routine-ap", status: "approved" }]);
    expect(resolved(aliceB)).toEqual([]);
    expect(resolved(bobB)).toEqual([]);
    await routines.stop();
  });
});
