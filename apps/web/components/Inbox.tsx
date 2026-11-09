"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ROUTINE_EVENTS,
  WS_EVENTS,
  type ApprovalView,
  type ClientMessage,
  type RoutineNotification,
  type RoutinePatch,
  type RoutineView,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { ApprovalCard } from "./ApprovalCard";
import { Icon } from "./Icon";

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
export function useRoutinesInbox(options: {
  send(message: ClientMessage): boolean;
  onNotification?(notification: RoutineNotification): void;
}): RoutinesInbox {
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
          case ROUTINE_EVENTS.ROUTINE_NOTIFICATION:
            optionsRef.current.onNotification?.(message.notification);
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

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Show a system notification when the user allowed it (never asks by itself). */
export function showBrowserNotification(notification: RoutineNotification): void {
  if (notificationPermission() !== "granted") return;
  try {
    const title = notification.kind === "needs_approval" ? "Sibyl needs your approval" : `Routine: ${notification.routineName}`;
    new Notification(title, { body: notification.message, tag: `${notification.runId}:${notification.kind}`, icon: "/icon.png" });
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}

/** Button that asks for notification permission (only on a click). */
export function NotificationPermissionButton() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  useEffect(() => setPermission(notificationPermission()), []);
  if (permission !== "default") return null;
  return (
    <button
      type="button"
      className="ghostBtn routinesNotifyBtn"
      onClick={() => {
        void Notification.requestPermission().then(setPermission, () => setPermission(notificationPermission()));
      }}
    >
      Turn on desktop notifications
    </button>
  );
}

/* ───────────── icons ───────────── */

export function InboxIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 13.5 6.4 5.6A1.5 1.5 0 0 1 7.8 4.5h8.4a1.5 1.5 0 0 1 1.4 1.1L20 13.5 M4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5 M4 13.5h4.5l1.2 2h4.6l1.2-2H20" />
    </svg>
  );
}

/** Rail / topbar button with a pending-count badge. */
export function InboxButton({ count, className, onClick }: { count: number; className: string; onClick(): void }) {
  const label = count > 0 ? `Inbox, ${count} waiting` : "Inbox";
  return (
    <button type="button" className={`${className} inboxBtn`} aria-label={label} title={label} onClick={onClick}>
      <InboxIcon />
      {count > 0 ? <span className="inboxBadge" aria-hidden>{count > 9 ? "9+" : count}</span> : null}
    </button>
  );
}

/* ───────────── the inbox panel ───────────── */

interface InboxProps {
  open: boolean;
  items: ApprovalView[];
  routines: RoutineView[];
  submitting: Set<string>;
  connected: boolean;
  onDecide(id: string, decision: "approve" | "decline"): void;
  onOpenConversation(id: string): void;
  onOpenRoutines(): void;
  onClose(): void;
}

interface Group {
  key: string;
  label: string;
  routine?: RoutineView;
  items: ApprovalView[];
}

/** Everything waiting for a decision, from chats and routines. */
export function Inbox(props: InboxProps) {
  const groups = useMemo(() => groupApprovals(props.items, props.routines), [props.items, props.routines]);
  useEscape(props.open, props.onClose);
  if (!props.open) return null;

  return (
    <div className="dialogBackdrop" onClick={props.onClose}>
      <section
        className="dialog routinesDialog inboxPanel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="iconBtn dialogClose" onClick={props.onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <header className="dialogHeader">
          <h2 id="inbox-title">Inbox</h2>
          <p>Actions waiting for your approval, from chats and routines. Nothing happens until you approve.</p>
        </header>
        <div className="routinesToolbar">
          <NotificationPermissionButton />
          <button type="button" className="ghostBtn" onClick={props.onOpenRoutines}>
            <Icon name="history" size={16} /> Routines
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="routinesEmpty">
            <Icon name="check" size={22} />
            <p>All clear — nothing is waiting for you.</p>
          </div>
        ) : (
          groups.map((group) => (
            <section className={`inboxGroup${group.routine || group.key.startsWith("routine:") ? " routineGroup" : ""}`} key={group.key}>
              <h3 className="inboxGroupTitle">
                <span>{group.label}</span>
                {group.routine?.conversationId ? (
                  <button type="button" className="routineLink" onClick={() => props.onOpenConversation(group.routine!.conversationId!)}>
                    Open chat
                  </button>
                ) : null}
              </h3>
              {group.items.map((item) => (
                <div className="inboxItem" key={item.id}>
                  <ApprovalCard
                    approval={item}
                    status="pending"
                    submitting={props.submitting.has(item.id)}
                    {...(props.connected ? { onDecide: (decision: "approve" | "decline") => props.onDecide(item.id, decision) } : {})}
                  />
                  <p className="inboxMeta">
                    Asked {relativeTime(item.createdAt)}
                    {item.expiresAt ? ` · expires ${relativeTime(item.expiresAt)}` : ""}
                    {!group.routine && item.conversationId ? (
                      <>
                        {" · "}
                        <button type="button" className="routineLink" onClick={() => props.onOpenConversation(item.conversationId!)}>
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
      </section>
    </div>
  );
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
