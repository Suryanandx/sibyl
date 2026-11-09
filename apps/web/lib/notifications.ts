"use client";

/**
 * Notifications in the browser: the Inbox's Activity feed, the unread
 * counts behind the rail badge and the toast shown on every screen. One
 * state, kept in sync with the gateway's notifications module
 * (notifications.request / notifications.list / notification /
 * notifications.read / notifications.state).
 */
import { useMemo, useRef, useState } from "react";
import {
  NOTIFICATION_EVENTS,
  type ClientMessage,
  type NotificationKindView,
  type NotificationUnreadView,
  type NotificationView,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { paths } from "./routes";

export const PAGE_SIZE = 30;

export interface NotificationsState {
  /** Loaded notifications, newest first (the filter applied). */
  items: NotificationView[];
  unread: NotificationUnreadView;
  /** Kinds the list is filtered to (null: all). */
  kinds: NotificationKindView[] | null;
  nextCursor: string | null;
  loading: boolean;
}

export const initialNotificationsState: NotificationsState = {
  items: [],
  unread: { total: 0, byKind: {} },
  kinds: null,
  nextCursor: null,
  loading: false
};

const sameKinds = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((kind) => (b ?? []).includes(kind));

/** Pure state transitions (tested on their own). */
export function reduceNotifications(state: NotificationsState, message: ServerMessage): NotificationsState {
  switch (message.type) {
    case NOTIFICATION_EVENTS.LIST: {
      // A page for an older filter (the person switched while it was on its way) is dropped.
      if (!sameKinds(message.kinds, state.kinds)) return { ...state, unread: message.unread };
      const items = message.cursor ? mergeById(state.items, message.items) : message.items;
      return { ...state, items, unread: message.unread, nextCursor: message.nextCursor ?? null, loading: false };
    }
    case NOTIFICATION_EVENTS.NOTIFICATION: {
      const shown = !state.kinds || state.kinds.includes(message.notification.kind);
      return { ...state, unread: message.unread, items: shown ? mergeById([message.notification], state.items) : state.items };
    }
    case NOTIFICATION_EVENTS.STATE: {
      const ids = new Set(message.ids);
      const items = state.items.map((item) => (item.readAt === undefined && (message.all || ids.has(item.id)) ? { ...item, readAt: message.readAt } : item));
      return { ...state, items, unread: message.unread };
    }
    default:
      return state;
  }
}

function mergeById(first: NotificationView[], second: NotificationView[]): NotificationView[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true))).sort((a, b) => b.createdAt - a.createdAt);
}

/** Unread first, then newest first (the Activity list's order). */
export function unreadFirst(items: NotificationView[]): NotificationView[] {
  return [...items].sort((a, b) => Number(a.readAt !== undefined) - Number(b.readAt !== undefined) || b.createdAt - a.createdAt);
}

/** What the rail badge counts: approvals waiting plus unread notices (an approval's own notice isn't counted twice). */
export function inboxBadgeCount(pendingApprovals: number, unread: NotificationUnreadView): number {
  return pendingApprovals + Math.max(0, unread.total - (unread.byKind.approval_needed ?? 0));
}

/* ───────────── deep links ───────────── */

export interface NotificationLink {
  label: string;
  href: string;
}

/** Where a notification leads, most specific first. */
export function notificationLinks(notification: Pick<NotificationView, "kind" | "links">): NotificationLink[] {
  const { links } = notification;
  const out: NotificationLink[] = [];
  if (notification.kind === "approval_needed" && links.approvalId) out.push({ label: "Review", href: paths.inbox });
  if (links.conversationId) out.push({ label: "Open chat", href: paths.conversation(links.conversationId) });
  if (links.monitorId) out.push({ label: "Monitor", href: paths.monitors });
  if (links.routineId && !links.routineId.includes(":")) out.push({ label: "Routine", href: paths.routines });
  if (links.agentId) out.push({ label: "Agent", href: paths.agents });
  if (links.artifactId) out.push({ label: "Deck", href: paths.slides });
  if (links.meetingId) out.push({ label: "Meeting notes", href: paths.meeting(links.meetingId) });
  return out;
}

/** Activity filters: one per source. */
export const ACTIVITY_FILTERS: ReadonlyArray<{ label: string; kinds: NotificationKindView[] }> = [
  { label: "Routines", kinds: ["routine_finished", "routine_failed", "budget_blocked"] },
  { label: "Monitors", kinds: ["monitor_fired", "monitor_paused"] },
  { label: "Agents", kinds: ["agent_action"] },
  { label: "Approvals", kinds: ["approval_needed"] },
  { label: "Decks", kinds: ["deck_ready"] },
  { label: "Members", kinds: ["invite_accepted"] },
  { label: "Meetings", kinds: ["meeting_notes"] },
  { label: "Calls", kinds: ["voicemail"] }
];

/** Tone for the toast and list dot. */
export function notificationTone(kind: NotificationKindView): "positive" | "warning" | "danger" {
  if (kind === "routine_failed" || kind === "budget_blocked") return "danger";
  if (kind === "approval_needed" || kind === "monitor_paused") return "warning";
  return "positive";
}

/* ───────────── the hook ───────────── */

export interface NotificationsApi extends NotificationsState {
  /** The latest live notification (the toast on every screen). */
  toast: NotificationView | null;
  /** Applies notifications.* messages. Returns true when consumed (the live `notification` is passed on to screens). */
  handleMessage(message: ServerMessage): boolean;
  /** Socket (re)opened or the workspace changed: reload the first page. */
  onConnected(): void;
  setFilter(kinds: NotificationKindView[] | null): void;
  loadMore(): void;
  markRead(id: string): void;
  markAllRead(): void;
  dismissToast(): void;
}

export function useNotifications(options: { send(message: ClientMessage): boolean; onLive?(notification: NotificationView): void }): NotificationsApi {
  const [state, setState] = useState<NotificationsState>(initialNotificationsState);
  const [toast, setToast] = useState<NotificationView | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;

  const actions = useMemo(() => {
    const send = (message: ClientMessage): boolean => optionsRef.current.send(message);
    const request = (kinds: NotificationKindView[] | null, cursor?: string): void => {
      if (send({ type: NOTIFICATION_EVENTS.REQUEST, limit: PAGE_SIZE, ...(kinds ? { kinds } : {}), ...(cursor ? { cursor } : {}) })) {
        setState((current) => ({ ...current, loading: true }));
      }
    };
    return {
      handleMessage(message: ServerMessage): boolean {
        if (message.type !== NOTIFICATION_EVENTS.LIST && message.type !== NOTIFICATION_EVENTS.NOTIFICATION && message.type !== NOTIFICATION_EVENTS.STATE) return false;
        setState((current) => reduceNotifications(current, message));
        if (message.type === NOTIFICATION_EVENTS.NOTIFICATION) {
          setToast(message.notification);
          optionsRef.current.onLive?.(message.notification);
          return false;
        }
        if (message.type === NOTIFICATION_EVENTS.STATE) {
          setToast((current) => (current && (message.all || message.ids.includes(current.id)) ? null : current));
        }
        return true;
      },
      onConnected() {
        request(stateRef.current.kinds);
      },
      setFilter(kinds: NotificationKindView[] | null) {
        setState((current) => ({ ...current, kinds, items: [], nextCursor: null }));
        request(kinds);
      },
      loadMore() {
        const { nextCursor, kinds, loading } = stateRef.current;
        if (nextCursor && !loading) request(kinds, nextCursor);
      },
      markRead(id: string) {
        send({ type: NOTIFICATION_EVENTS.READ, id });
      },
      markAllRead() {
        send({ type: NOTIFICATION_EVENTS.READ, all: true });
      },
      dismissToast() {
        setToast(null);
      }
    };
  }, []);

  return { ...state, toast, ...actions };
}

/* ───────────── system notifications ───────────── */

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Show a system notification when the user allowed it (never asks by itself). */
export function showBrowserNotification(notification: NotificationView): void {
  if (notificationPermission() !== "granted") return;
  try {
    new Notification(notification.title, { body: notification.body, tag: notification.id, icon: "/icon.png" });
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}
