"use client";

/**
 * The phone line's call log: in and out, number, who answered, duration,
 * cost, the transcript (the call's chat), the recording and voicemails.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { CallLogView } from "@open-gpt-live/protocol";
import settings from "../../components/settings/settings.module.css";
import { Badge, Button, Card, CardHeader, Muted, Notice, Tabs } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { errorText } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import { formatDuration, phoneApi } from "./api";
import styles from "./phone.module.css";

type Direction = "all" | "inbound" | "outbound";

const STATUS: Record<CallLogView["status"], { label: string; tone: "positive" | "warning" | "danger" | "neutral" }> = {
  ringing: { label: "Ringing", tone: "neutral" },
  active: { label: "On the line", tone: "positive" },
  completed: { label: "Completed", tone: "neutral" },
  voicemail: { label: "Voicemail", tone: "warning" },
  missed: { label: "Missed", tone: "warning" },
  failed: { label: "Failed", tone: "danger" }
};

export function CallLog() {
  const session = useAppSession();
  const [direction, setDirection] = useState<Direction>("all");
  const [calls, setCalls] = useState<CallLogView[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSee = session.can("chat.view_all");
  const recordings = session.hasFeature("recordings") && session.can("calls.record");

  const load = useCallback(
    async (before?: number) => {
      try {
        const page = await phoneApi.calls({ ...(direction === "all" ? {} : { direction }), ...(before ? { before } : {}) });
        setCalls((current) => (before && current ? [...current, ...page] : page));
        setMore(page.length >= 50);
        setError(null);
      } catch (caught) {
        setError(errorText(caught));
      }
    },
    [direction]
  );

  useEffect(() => {
    if (canSee) void load();
  }, [canSee, load]);

  if (!canSee) return null;
  return (
    <Card>
      <CardHeader title="Call log" meta="Every call of this workspace's line. The transcript is the call's chat." />
      <Tabs
        className={styles.directionTabs}
        label="Direction"
        value={direction}
        onChange={setDirection}
        options={[
          { value: "all", label: "All" },
          { value: "inbound", label: "Incoming" },
          { value: "outbound", label: "Outgoing" }
        ]}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {calls === null ? (
        <Muted>Loading…</Muted>
      ) : calls.length === 0 ? (
        <Muted>No calls yet.</Muted>
      ) : (
        <ul className={settings.rows} aria-label="Calls">
          {calls.map((call) => (
            <li key={call.id} className={settings.row}>
              <span className={styles.direction} aria-label={call.direction === "inbound" ? "Incoming" : "Outgoing"}>
                {call.direction === "inbound" ? "↘" : "↗"}
              </span>
              <span className={settings.rowMain}>
                <span className={settings.rowTitle}>
                  <span className={styles.number}>{call.remoteNumber ?? "Unknown number"}</span>
                  <Badge tone={STATUS[call.status].tone}>{STATUS[call.status].label}</Badge>
                </span>
                <span className={settings.rowMeta}>
                  {new Date(call.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {call.agentName} · {formatDuration(call.durationMs)}
                  {call.costUsd ? ` · $${call.costUsd.toFixed(4)}` : ""}
                </span>
                {call.voicemail ? <span className={styles.voicemail}>“{call.voicemail}”</span> : null}
              </span>
              <span className={styles.callLinks}>
                {call.conversationId ? <Link href={paths.conversation(call.conversationId)}>Transcript</Link> : null}
                {call.recordingId && recordings ? <Link href={`${paths.recordings}?id=${encodeURIComponent(call.recordingId)}`}>Recording</Link> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more && calls?.length ? (
        <Button variant="ghost" onClick={() => void load(calls.at(-1)!.startedAt)}>
          Show older calls
        </Button>
      ) : null}
    </Card>
  );
}
