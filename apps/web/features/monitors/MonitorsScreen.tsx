"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MonitorEventView, MonitorSaveResponse, MonitorStatusView, MonitorView, MonitorsListResponse } from "@open-gpt-live/protocol";
import { createMonitorsApi, withStatus, type MonitorsApi } from "./api";
import { formatUsd, relativeTime } from "../../lib/format";
import { MonitorEvents } from "./MonitorEvents";
import { MonitorForm } from "./MonitorForm";
import { Badge, Button, Card, EmptyState, Muted, Notice, Toolbar, type Tone } from "../../components/ui";
import styles from "./monitors.module.css";

export interface MonitorsScreenProps {
  api?: MonitorsApi;
  /** Agents the person may run tasks as (from the agents feature). Empty hides the picker. */
  agents?: Array<{ id: string; name: string }>;
  /** May create and change monitors (monitors.manage). Default true; the gateway decides either way. */
  canManage?: boolean;
  /** Latest live statuses by monitor id (monitors.status over the WebSocket). Without them the screen polls. */
  liveStatus?: Record<string, MonitorStatusView>;
  /** Events that just happened (from the shared notifications feed). */
  liveEvents?: MonitorEventView[];
  onOpenConversation?(conversationId: string): void;
}

const STATUS: Record<MonitorView["status"], { label: string; tone: Tone }> = {
  active: { label: "Watching", tone: "positive" },
  checking: { label: "Checking…", tone: "info" },
  paused: { label: "Paused", tone: "neutral" },
  error: { label: "Having trouble", tone: "warning" }
};

const POLL_MS = 30_000;

type View = { kind: "list" } | { kind: "new" } | { kind: "edit"; monitor: MonitorView } | { kind: "events"; monitor?: MonitorView };

/** Monitors: what Sibyl keeps an eye on, how it's doing, and what it found. */
export function MonitorsScreen(props: MonitorsScreenProps) {
  const api = useMemo(() => props.api ?? createMonitorsApi(), [props.api]);
  const canManage = props.canManage ?? true;
  const [data, setData] = useState<MonitorsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [secret, setSecret] = useState<(NonNullable<MonitorSaveResponse["webhook"]> & { name: string }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [polled, setPolled] = useState<Record<string, MonitorStatusView>>({});
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setData(await api.list());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll statuses when no live updates are wired in; re-render relative times either way.
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((n) => n + 1);
      if (props.liveStatus) return;
      api
        .statuses()
        .then((statuses) => setPolled(Object.fromEntries(statuses.map((s) => [s.id, s]))))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [api, props.liveStatus]);

  const statuses = props.liveStatus ?? polled;
  const monitors = (data?.monitors ?? []).map((monitor) => withStatus(monitor, statuses[monitor.id]));

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    await refresh();
  };

  const saved = (result: MonitorSaveResponse) => {
    if (result.webhook?.secret) setSecret({ ...result.webhook, name: result.monitor.name });
    setView({ kind: "list" });
    void refresh();
  };

  if (view.kind === "new" || view.kind === "edit") {
    return (
      <>
        <Toolbar
          start={
            <div>
              <h2 className={styles.viewTitle}>{view.kind === "new" ? "New monitor" : `Edit “${view.monitor.name}”`}</h2>
              <Muted>Sibyl checks the source, keeps only what's new, and tells you when it matters.</Muted>
            </div>
          }
        />
        <MonitorForm
          api={api}
          sources={data?.sources ?? []}
          channels={data?.channels ?? [{ channel: "inbox", available: true }]}
          {...(props.agents ? { agents: props.agents } : {})}
          {...(view.kind === "edit" ? { monitor: view.monitor } : {})}
          onSaved={saved}
          onCancel={() => setView({ kind: "list" })}
        />
      </>
    );
  }

  if (view.kind === "events") {
    return (
      <>
        <Toolbar
          start={
            <div>
              <h2 className={styles.viewTitle}>{view.monitor ? view.monitor.name : "What your monitors found"}</h2>
              {view.monitor ? <Muted>{describe(view.monitor)}</Muted> : null}
            </div>
          }
          end={<Button onClick={() => setView({ kind: "list" })}>Back</Button>}
        />
        <MonitorEvents
          api={api}
          {...(view.monitor ? { monitorId: view.monitor.id } : {})}
          {...(props.liveEvents ? { liveEvents: props.liveEvents } : {})}
          {...(props.onOpenConversation ? { onOpenConversation: props.onOpenConversation } : {})}
        />
      </>
    );
  }

  const monthTotal = monitors.filter((m) => m.mine).reduce((sum, m) => sum + m.costMonthUsd, 0);

  return (
    <>
      <Toolbar
        start={monitors.length > 0 ? <Muted>Your monitors cost {formatUsd(monthTotal)} this month.</Muted> : null}
        end={
          <>
            <Button onClick={() => setView({ kind: "events" })}>Activity</Button>
            {canManage && (
              <Button variant="primary" onClick={() => setView({ kind: "new" })} disabled={!data}>
                New monitor
              </Button>
            )}
          </>
        }
      />

      {error && <Notice tone="danger" className={styles.gapBelow}>{error}</Notice>}

      {secret && (
        <Notice
          tone="warning"
          className={styles.gapBelow}
          action={
            <Button size="sm" onClick={() => setSecret(null)}>
              Done
            </Button>
          }
        >
          <div className={styles.secretBox}>
            <p>
              <strong>Webhook for “{secret.name}”.</strong> POST JSON to <code>{secret.path}</code> on your Sibyl gateway, with the header{" "}
              <code>x-sibyl-signature: sha256=&lt;HMAC-SHA256 of the body&gt;</code>.
            </p>
            <p>
              Signing secret (shown once, saved as <code>{secret.secretRef}</code>): <code className={styles.secretValue}>{secret.secret}</code>
            </p>
          </div>
        </Notice>
      )}

      {!data && !error && <Muted>Loading…</Muted>}
      {data && monitors.length === 0 && (
        <EmptyState title="No monitors yet">
          <p>Try asking in chat: “tell me when a deal over $50k moves to Negotiation”, or create one here.</p>
        </EmptyState>
      )}

      {monitors.length > 0 && (
        <ul className={styles.list}>
          {monitors.map((monitor) => (
            <Card as="li" key={monitor.id}>
              <div className={styles.cardHead}>
                <div className={styles.cardTitle}>
                  <span className={styles.name}>{monitor.name}</span>
                  <Badge tone={STATUS[monitor.status].tone}>{STATUS[monitor.status].label}</Badge>
                </div>
                <Muted>{describe(monitor)}</Muted>
                {monitor.pausedReason && <p className={styles.warn}>{monitor.pausedReason}</p>}
                {!monitor.pausedReason && monitor.lastError && <p className={styles.warn}>{monitor.lastError}</p>}
              </div>
              <dl className={styles.stats}>
                <div>
                  <dt>Last check</dt>
                  <dd>{relativeTime(monitor.lastCheckedAt)}</dd>
                </div>
                <div>
                  <dt>Last fired</dt>
                  <dd>{relativeTime(monitor.lastFiredAt)}</dd>
                </div>
                <div>
                  <dt>This month</dt>
                  <dd>{formatUsd(monitor.costMonthUsd)}</dd>
                </div>
                <div>
                  <dt>Estimate</dt>
                  <dd title={`At most ${formatUsd(monitor.estimate.maxMonthUsd)} a month`}>~{formatUsd(monitor.estimate.typicalMonthUsd)}/mo</dd>
                </div>
              </dl>
              <div className={styles.cardActions}>
                {monitor.mine && (
                  <Button size="sm" onClick={() => setView({ kind: "events", monitor })}>
                    Activity
                  </Button>
                )}
                {canManage && monitor.mine && monitor.enabled && monitor.source.kind !== "webhook" && (
                  <Button size="sm" disabled={monitor.status === "checking"} onClick={() => void act(() => api.runNow(monitor.id))}>
                    Check now
                  </Button>
                )}
                {canManage && (monitor.mine || monitor.enabled) && (
                  <Button size="sm" onClick={() => void act(() => api.pause(monitor.id, monitor.enabled))}>
                    {monitor.enabled ? "Pause" : "Resume"}
                  </Button>
                )}
                {canManage && monitor.mine && (
                  <Button size="sm" onClick={() => setView({ kind: "edit", monitor })}>
                    Edit
                  </Button>
                )}
                {canManage &&
                  (confirmDelete === monitor.id ? (
                    <>
                      <Button size="sm" variant="danger" onClick={() => void act(() => api.remove(monitor.id)).then(() => setConfirmDelete(null))}>
                        Delete
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(monitor.id)}>
                      Delete…
                    </Button>
                  ))}
              </div>
            </Card>
          ))}
        </ul>
      )}
    </>
  );
}

function describe(monitor: MonitorView): string {
  const source =
    monitor.source.kind === "tool"
      ? monitor.source.toolName
      : monitor.source.kind === "webhook"
        ? "Webhook"
        : monitor.source.url.replace(/^https?:\/\//, "");
  const when = monitor.condition.ask ? ` · “${monitor.condition.ask}”` : monitor.condition.filter?.length ? ` · ${monitor.condition.filter.length} filter${monitor.condition.filter.length === 1 ? "" : "s"}` : "";
  const owner = monitor.mine ? "" : " · someone else's";
  return `${source} · ${monitor.frequency}${when}${owner}`;
}
