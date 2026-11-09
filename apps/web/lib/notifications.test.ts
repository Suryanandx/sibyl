import type { NotificationView } from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { inboxBadgeCount, initialNotificationsState, notificationLinks, reduceNotifications, unreadFirst } from "./notifications";

const note = (id: string, createdAt: number, extra: Partial<NotificationView> = {}): NotificationView => ({
  id,
  kind: "routine_finished",
  title: id,
  body: "",
  links: {},
  createdAt,
  ...extra
});

describe("notifications state", () => {
  test("pages replace, continue, prepend live ones and apply read state", () => {
    let state = reduceNotifications(initialNotificationsState, {
      type: "notifications.list",
      items: [note("b", 2), note("a", 1)],
      unread: { total: 2, byKind: { routine_finished: 2 } },
      nextCursor: "1:a"
    });
    expect(state.items.map((n) => n.id)).toEqual(["b", "a"]);
    expect(state.nextCursor).toBe("1:a");
    state = reduceNotifications(state, { type: "notifications.list", items: [note("z", 0)], unread: state.unread, cursor: "1:a" });
    expect(state.items.map((n) => n.id)).toEqual(["b", "a", "z"]);
    expect(state.nextCursor).toBeNull();
    state = reduceNotifications(state, { type: "notification", notification: note("c", 3, { kind: "monitor_fired" }), unread: { total: 3, byKind: { routine_finished: 2, monitor_fired: 1 } } });
    expect(state.items[0]!.id).toBe("c");
    expect(state.unread.total).toBe(3);
    state = reduceNotifications(state, { type: "notifications.state", ids: ["a"], all: false, readAt: 9, unread: { total: 2, byKind: {} } });
    expect(state.items.find((n) => n.id === "a")?.readAt).toBe(9);
    state = reduceNotifications(state, { type: "notifications.state", ids: [], all: true, readAt: 10, unread: { total: 0, byKind: {} } });
    expect(state.items.every((n) => n.readAt !== undefined)).toBe(true);
  });

  test("a filtered list ignores pages and live ones of other kinds", () => {
    const filtered = { ...initialNotificationsState, kinds: ["monitor_fired" as const] };
    const stale = reduceNotifications(filtered, { type: "notifications.list", items: [note("x", 1)], unread: { total: 1, byKind: {} } });
    expect(stale.items).toEqual([]);
    const live = reduceNotifications(filtered, { type: "notification", notification: note("y", 2), unread: { total: 1, byKind: {} } });
    expect(live.items).toEqual([]);
    expect(live.unread.total).toBe(1);
  });

  test("unread first, badge without double-counting approvals, deep links", () => {
    expect(unreadFirst([note("old", 1), note("read", 5, { readAt: 6 }), note("new", 3)]).map((n) => n.id)).toEqual(["new", "old", "read"]);
    expect(inboxBadgeCount(2, { total: 5, byKind: { approval_needed: 2, routine_failed: 3 } })).toBe(5);
    expect(notificationLinks(note("n", 1, { kind: "approval_needed", links: { approvalId: "ap", routineId: "r", conversationId: "c1" } })).map((l) => l.href)).toEqual(["/inbox", "/c/c1", "/routines"]);
    expect(notificationLinks(note("n", 1, { kind: "monitor_fired", links: { monitorId: "m", agentId: "a" } })).map((l) => l.label)).toEqual(["Monitor", "Agent"]);
    expect(notificationLinks(note("n", 1, { kind: "deck_ready", links: { artifactId: "d" } }))).toEqual([{ label: "Deck", href: "/library/slides" }]);
  });
});
