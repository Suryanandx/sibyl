"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MonitorEventView } from "@open-gpt-live/protocol";
import { createMonitorsApi, type MonitorsApi } from "./api";
import { formatUsd, relativeTime } from "../../lib/format";
import { Badge, Button, EmptyState, Muted, Notice } from "../../components/ui";
import styles from "./monitors.module.css";

export interface MonitorEventsProps {
  /** Only this monitor's events (absent: all of yours in the workspace). */
  monitorId?: string;
  api?: MonitorsApi;
  /** Events pushed live (monitors.notification); merged on top, newest first. */
  liveEvents?: MonitorEventView[];
  onOpenConversation?(conversationId: string): void;
  /** Page size (default 20). */
  limit?: number;
}

const ACTION_LABEL: Record<string, string> = {
  sent: "sent",
  started: "started",
  failed: "failed",
  unavailable: "not available",
  skipped: "skipped"
};

/** What your monitors found: newest first, with source links, reasons and cost. */
export function MonitorEvents(props: MonitorEventsProps) {
  const api = useMemo(() => props.api ?? createMonitorsApi(), [props.api]);
  const limit = props.limit ?? 20;
  const [events, setEvents] = useState<MonitorEventView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      try {
        const page = await api.events({ ...(props.monitorId ? { monitorId: props.monitorId } : {}), ...(before ? { before } : {}), limit });
        setEvents((current) => (before ? [...current, ...page] : page));
        setMore(page.length === limit);
        setState("ready");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setState("error");
      }
    },
    [api, props.monitorId, limit]
  );

  useEffect(() => {
    setState("loading");
    void load();
  }, [load]);

  const merged = useMemo(() => {
    const live = (props.liveEvents ?? []).filter((event) => !props.monitorId || event.monitorId === props.monitorId);
    const seen = new Set<string>();
    return [...live, ...events]
      .filter((event) => (seen.has(event.id) ? false : (seen.add(event.id), true)))
      .sort((a, b) => b.at - a.at);
  }, [events, props.liveEvents, props.monitorId]);

  if (state === "loading" && merged.length === 0) return <Muted>Loading…</Muted>;
  if (state === "error" && merged.length === 0) return <Notice tone="danger">{error}</Notice>;
  if (merged.length === 0) {
    return (
      <EmptyState title="Nothing yet" compact>
        <p>When a monitor finds something, it shows up here and in your inbox.</p>
      </EmptyState>
    );
  }

  return (
    <div className={styles.events}>
      <ol className={styles.eventList}>
        {merged.map((event) => (
          <li key={event.id} className={event.kind === "paused" ? `${styles.event} ${styles.eventPaused}` : styles.event}>
            <div className={styles.eventHead}>
              <span className={styles.eventSummary}>{event.summary}</span>
              <time className={styles.time} dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>
                {relativeTime(event.at)}
              </time>
            </div>
            {event.items.length > 0 && (
              <ul className={styles.eventItems}>
                {event.items.map((item) => (
                  <li key={item.key}>
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer noopener">
                        {item.title}
                      </a>
                    ) : (
                      item.title
                    )}
                    {item.reason && <span className={styles.muted}> — {item.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.chips}>
              {event.monitorName && !props.monitorId && <Badge>{event.monitorName}</Badge>}
              {event.actions.map((action, index) => (
                <Badge key={index} tone={action.status === "failed" || action.status === "unavailable" ? "warning" : "neutral"} title={action.detail}>
                  {action.kind === "task" ? "Task" : action.channel ?? "notify"} {ACTION_LABEL[action.status] ?? action.status}
                </Badge>
              ))}
              {event.costUsd > 0 && <Badge>{formatUsd(event.costUsd)}</Badge>}
              {event.conversationId && props.onOpenConversation && (
                <Button variant="link" onClick={() => props.onOpenConversation!(event.conversationId!)}>
                  Open task result
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {more && (
        <div>
          <Button onClick={() => void load(events[events.length - 1]?.at)}>Show older</Button>
        </div>
      )}
    </div>
  );
}
