"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ROUTINE_EVENTS,
  WS_EVENTS,
  type ApprovalView,
  type ClientMessage,
  type NotificationView,
  type RoutinePatch,
  type RoutineView,
  type ServerMessage
} from "@open-gpt-live/protocol";
import {
  ACTIVITY_FILTERS,
  notificationLinks,
  notificationPermission,
  notificationTone,
  unreadFirst,
  type NotificationsApi
} from "../lib/notifications";
import { ApprovalCard } from "./ApprovalCard";
import { Icon } from "./Icon";
import { Button, EmptyState, Toolbar, buttonClass, cx } from "./ui";
import { paths } from "../lib/routes";
import styles from "./Inbox.module.css";

/* ───────────── state: routines + pending approvals ───────────── */

export interface RoutinesInbox {
  routines: RoutineView[];
  inbox: ApprovalView[];
  /** Approvals the user decided, until the gateway confirms. */
  submitting: Set<string>;
  /** Handles routines/inbox messages; returns true when fully consumed. */
  handleMessage(message: ServerMessage): boolean;
  /** Socket (re)opened: send the time zone, ask for lists. */
  onConnected(): void;
  decide(id: string, decision: "approve" | "decline"): void;
  updateRoutine(id: string, patch: RoutinePatch): void;
  runNow(id: string): void;
  deleteRoutine(id: string): void;
}

/**
 * Keeps the routines list and the approval inbox in sync with the gateway.
 * The returned object is stable (safe in socket listeners registered once).
 */
export function useRoutinesInbox(options: { send(message: ClientMessage): boolean }): RoutinesInbox {
  const [routines, setRoutines] = useState<RoutineView[]>([]);
  const [inbox, setInbox] = useState<ApprovalView[]>([]);
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const actions = useMemo(() => {
    const send = (message: ClientMessage): boolean => optionsRef.current.send(message);
    const settle = (id: string): void =>
      setSubmitting((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    return {
      handleMessage(message: ServerMessage): boolean {
        switch (message.type) {
          case ROUTINE_EVENTS.ROUTINES_LIST:
            setRoutines(message.items);
            return true;
          case ROUTINE_EVENTS.INBOX_LIST:
            setInbox(message.items);
            setSubmitting((current) => {
              const pending = new Set(message.items.map((item) => item.id));
              const next = new Set([...current].filter((id) => pending.has(id)));
              return next.size === current.size ? current : next;
            });
            return true;
          case WS_EVENTS.APPROVAL_REQUEST:
            // Chat cards still render in the thread: don't consume.
            setInbox((current) => [...current.filter((item) => item.id !== message.approval.id), message.approval]);
            return false;
          case WS_EVENTS.APPROVAL_RESOLVED:
            setInbox((current) => current.filter((item) => item.id !== message.id));
            settle(message.id);
            return false;
          default:
            return false;
        }
      },
      onConnected() {
        let timezone = "";
        try {
          timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch {
          // Older browsers: the gateway keeps its own zone.
        }
        if (timezone) send({ type: ROUTINE_EVENTS.ROUTINES_CONTEXT, timezone });
        send({ type: ROUTINE_EVENTS.ROUTINES_REQUEST });
        send({ type: ROUTINE_EVENTS.INBOX_REQUEST });
      },
      decide(id: string, decision: "approve" | "decline") {
        if (send({ type: WS_EVENTS.APPROVAL_DECISION, id, decision })) {
          setSubmitting((current) => new Set(current).add(id));
        }
      },
      updateRoutine(id: string, patch: RoutinePatch) {
        // Optimistic for the toggle; the gateway answers with the real list.
        if (patch.enabled !== undefined) {
          setRoutines((current) => current.map((item) => (item.id === id ? { ...item, enabled: patch.enabled! } : item)));
        }
        send({ type: ROUTINE_EVENTS.ROUTINE_UPDATE, routineId: id, patch });
      },
      runNow(id: string) {
        send({ type: ROUTINE_EVENTS.ROUTINE_RUN_NOW, routineId: id });
      },
      deleteRoutine(id: string) {
        setRoutines((current) => current.filter((item) => item.id !== id));
        send({ type: ROUTINE_EVENTS.ROUTINE_DELETE, routineId: id });
      }
    };
  }, []);

  return { routines, inbox, submitting, ...actions };
}

/** Pending approvals per routine id (for badges in the routines list). */
export function countByRoutine(items: ApprovalView[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) if (item.routineId) out[item.routineId] = (out[item.routineId] ?? 0) + 1;
  return out;
}

/* ───────────── browser notifications ───────────── */

/** Button that asks for notification permission (only on a click). */
export function NotificationPermissionButton() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  useEffect(() => setPermission(notificationPermission()), []);
  if (permission !== "default") return null;
  return (
    <Button
      size="sm"
      onClick={() => {
        void Notification.requestPermission().then(setPermission, () => setPermission(notificationPermission()));
      }}
    >
      Turn on desktop notifications
    </Button>
  );
}

/* ───────────── icons ───────────── */

/**
 * The inbox bell (rail on desktop, the chat's top bar on phones): opens
 * /inbox; the badge counts approvals waiting plus unread notifications.
 */
export function InboxBell({ count, className, current = false }: { count: number; className: string; current?: boolean }) {
  const label = count > 0 ? `Inbox, ${count} new` : "Inbox";
  return (
    <Link
      className={`${className} inboxBtn${current ? " active" : ""}`}
      href={paths.inbox}
      aria-label={label}
      title={label}
      aria-current={current ? "page" : undefined}
    >
      <Icon name="bell" />
      {count > 0 ? <span className="inboxBadge" aria-hidden>{count > 9 ? "9+" : count}</span> : null}
    </Link>
  );
}

/* ───────────── the inbox panel ───────────── */

interface InboxProps {
  items: ApprovalView[];
  routines: RoutineView[];
  submitting: Set<string>;
  connected: boolean;
  /** Everything Sibyl told you about (the Activity section). */
  notifications: NotificationsApi;
  onDecide(id: string, decision: "approve" | "decline"): void;
  onOpenConversation(id: string): void;
  onOpenRoutines(): void;
  /** Follow a notification's deep link (an app path). */
  onOpen(href: string): void;
}

interface Group {
  key: string;
  label: string;
  routine?: RoutineView;
  items: ApprovalView[];
}

/**
 * The Inbox screen's body (/inbox): approvals waiting for a decision (from
 * chats and routines), then the activity feed of every notification.
 */
export function Inbox(props: InboxProps) {
  return (
    <div>
      <Toolbar
        start={
          <>
            <NotificationPermissionButton />
            <Button size="sm" onClick={props.onOpenRoutines}>
              <Icon name="history" size={16} /> Routines
            </Button>
          </>
        }
      />
      <section className={styles.section} aria-labelledby="inbox-approvals">
        <h2 className={styles.sectionTitle} id="inbox-approvals">
          Needs your approval{props.items.length > 0 ? <span className={styles.count}>{props.items.length}</span> : null}
        </h2>
        <Approvals {...props} />
      </section>
      <section className={styles.section} aria-labelledby="inbox-activity">
        <Activity notifications={props.notifications} connected={props.connected} onOpen={props.onOpen} />
      </section>
    </div>
  );
}

function Approvals(props: InboxProps) {
  const groups = useMemo(() => groupApprovals(props.items, props.routines), [props.items, props.routines]);
  return (
    <>
        {groups.length === 0 ? (
          <EmptyState compact icon={<Icon name="check" size={22} />} title="All clear — nothing is waiting for your approval.">
            <p>When Sibyl or an agent wants to send, change or delete something for you, it asks here first.</p>
          </EmptyState>
        ) : (
          groups.map((group) => (
            <section className={styles.group} key={group.key}>
              <h3 className={styles.groupTitle}>
                <span>{group.label}</span>
                {group.routine?.conversationId ? (
                  <button type="button" className={buttonClass({ variant: "link", size: "sm" })} onClick={() => props.onOpenConversation(group.routine!.conversationId!)}>
                    Open chat
                  </button>
                ) : null}
              </h3>
              {group.items.map((item) => (
                <div className={styles.item} key={item.id}>
                  <ApprovalCard
                    approval={item}
                    status="pending"
                    submitting={props.submitting.has(item.id)}
                    {...(props.connected ? { onDecide: (decision: "approve" | "decline") => props.onDecide(item.id, decision) } : {})}
                  />
                  <p className={styles.meta}>
                    Asked {relativeTime(item.createdAt)}
                    {item.expiresAt ? ` · expires ${relativeTime(item.expiresAt)}` : ""}
                    {!group.routine && item.conversationId ? (
                      <>
                        {" · "}
                        <button type="button" className={buttonClass({ variant: "link", size: "sm" })} onClick={() => props.onOpenConversation(item.conversationId!)}>
                          Open chat
                        </button>
                      </>
                    ) : null}
                  </p>
                </div>
              ))}
            </section>
          ))
        )}
    </>
  );
}

/* ───────────── activity ───────────── */

function Activity({ notifications, connected, onOpen }: { notifications: NotificationsApi; connected: boolean; onOpen(href: string): void }) {
  const items = useMemo(() => unreadFirst(notifications.items), [notifications.items]);
  const active = notifications.kinds;
  const unreadIn = (kinds: readonly string[]): number => kinds.reduce((sum, kind) => sum + (notifications.unread.byKind[kind as keyof typeof notifications.unread.byKind] ?? 0), 0);
  const isActive = (kinds: readonly string[] | null): boolean => (kinds === null ? active === null : active !== null && kinds.length === active.length && kinds.every((kind) => active.includes(kind as never)));
  return (
    <>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id="inbox-activity">
          Activity{notifications.unread.total > 0 ? <span className={styles.count}>{notifications.unread.total} unread</span> : null}
        </h2>
        {notifications.unread.total > 0 ? (
          <Button variant="link" size="sm" disabled={!connected} onClick={notifications.markAllRead}>
            Mark all read
          </Button>
        ) : null}
      </div>
      <div className={styles.filters} role="group" aria-label="Show">
        <button type="button" className={styles.chip} aria-pressed={isActive(null)} onClick={() => notifications.setFilter(null)}>
          All
        </button>
        {ACTIVITY_FILTERS.map((filter) => {
          const unread = unreadIn(filter.kinds);
          return (
            <button
              key={filter.label}
              type="button"
              className={styles.chip}
              aria-pressed={isActive(filter.kinds)}
              onClick={() => notifications.setFilter(filter.kinds)}
            >
              {filter.label}
              {unread > 0 ? <span className={styles.chipCount}>{unread}</span> : null}
            </button>
          );
        })}
      </div>
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<Icon name="check" size={22} />}
          title={notifications.loading ? "Loading…" : "Nothing here yet. Routines, monitors and agents report here when they act."}
        >
          {notifications.loading ? null : <p>Try asking in chat: &ldquo;Every weekday at 8, send me a summary of tech news.&rdquo;</p>}
        </EmptyState>
      ) : (
        <ul className={styles.activity}>
          {items.map((item) => (
            <ActivityItem key={item.id} item={item} connected={connected} onMarkRead={notifications.markRead} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {notifications.nextCursor ? (
        <Button size="sm" className={styles.more} disabled={!connected || notifications.loading} onClick={notifications.loadMore}>
          {notifications.loading ? "Loading…" : "Show older"}
        </Button>
      ) : null}
    </>
  );
}

function ActivityItem(props: { item: NotificationView; connected: boolean; onMarkRead(id: string): void; onOpen(href: string): void }) {
  const { item } = props;
  const unread = item.readAt === undefined;
  const open = (href: string): void => {
    if (unread && props.connected) props.onMarkRead(item.id);
    props.onOpen(href);
  };
  return (
    <li className={cx(styles.activityItem, styles[`tone_${notificationTone(item.kind)}`], unread && styles.unread)}>
      <div className={styles.activityText}>
        <p className={styles.activityTitle}>{item.title}</p>
        {item.body ? <p className={styles.activityBody}>{item.body}</p> : null}
        <p className={cx(styles.meta, styles.activityMeta)}>
          {relativeTime(item.createdAt)}
          {notificationLinks(item).map((link) => (
            <span key={link.label}>
              {" · "}
              <button type="button" className={buttonClass({ variant: "link", size: "sm" })} onClick={() => open(link.href)}>
                {link.label}
              </button>
            </span>
          ))}
        </p>
      </div>
      {unread ? (
        <Button size="sm" disabled={!props.connected} onClick={() => props.onMarkRead(item.id)}>
          Mark read
        </Button>
      ) : null}
    </li>
  );
}

/* ───────────── toast ───────────── */

/** The one toast for new notifications, on every screen. */
export function NotificationToast(props: { notification: NotificationView | null; onDismiss(): void; onOpen(href: string): void }) {
  const { notification } = props;
  if (!notification) return null;
  const [link] = notificationLinks(notification);
  return (
    <div className={`notificationToast ${notificationTone(notification.kind)}`} role="status" aria-live="polite">
      <span className="notificationToastText">
        <strong>{notification.title}</strong>
        {notification.body && notification.body !== notification.title ? <span>{firstLine(notification.body)}</span> : null}
      </span>
      {link ? (
        <button
          type="button"
          className="routineLink"
          onClick={() => {
            props.onDismiss();
            props.onOpen(link.href);
          }}
        >
          {link.label === "Review" ? "Review" : "Open"}
        </button>
      ) : null}
      <button type="button" className="iconBtn notificationToastClose" aria-label="Dismiss" onClick={props.onDismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function groupApprovals(items: ApprovalView[], routines: RoutineView[]): Group[] {
  const byId = new Map(routines.map((routine) => [routine.id, routine]));
  const groups = new Map<string, Group>();
  for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
    const routine = item.routineId ? byId.get(item.routineId) : undefined;
    const key = item.routineId ? `routine:${item.routineId}` : "chat";
    const label = item.routineId ? `Routine · ${routine?.name ?? "Deleted routine"}` : "Chat";
    const group = groups.get(key) ?? { key, label, ...(routine ? { routine } : {}), items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  // Chat first (someone is probably waiting in the conversation), then routines.
  return [...groups.values()].sort((a, b) => (a.key === "chat" ? -1 : b.key === "chat" ? 1 : a.label.localeCompare(b.label)));
}

export function relativeTime(at: number, now = Date.now()): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000]
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) return format.format(Math.round(diff / ms), unit);
  }
  return diff < 0 ? "just now" : "in a moment";
}

export function useEscape(active: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
