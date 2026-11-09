"use client";

/**
 * A meeting's notes shared by link (/shared/meetings/<id>?t=…): read-only,
 * no account. The host chose whether the transcript is included; the link
 * expires and can be revoked (the meeting page → Share notes).
 */
import { useEffect, useMemo, useState } from "react";
import type { MeetingView, SharedMeetingView } from "@open-gpt-live/protocol";
import { Mark } from "../../components/Brand";
import { EmptyState, Muted } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { meetingsApi } from "./api";
import { NotesPanel, type NotesTab } from "./NotesPanel";
import styles from "./meetings.module.css";

export function SharedNotes({ meetingId }: { meetingId: string }) {
  const [shared, setShared] = useState<SharedMeetingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<NotesTab>("summary");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("t") ?? "";
    meetingsApi
      .shared(meetingId, token)
      .then(setShared)
      .catch((reason) => setError(errorText(reason)));
  }, [meetingId]);

  // The notes panel reads a meeting; a shared link carries only what the host shared.
  const meeting = useMemo<MeetingView | null>(
    () =>
      shared
        ? {
            id: meetingId,
            title: shared.title,
            status: "ended",
            hostName: shared.hostName,
            isHost: false,
            ...(shared.startedAt ? { startedAt: shared.startedAt } : {}),
            ...(shared.endedAt ? { endedAt: shared.endedAt } : {}),
            participants: shared.participants.map((participant, index) => ({ identity: `shared:${index}`, name: participant.name, kind: participant.kind, color: index % 6 })),
            sibylRole: "participant",
            ...(shared.notes ? { notes: shared.notes } : {}),
            segmentCount: shared.transcript?.length ?? 0
          }
        : null,
    [shared, meetingId]
  );

  if (error) {
    return (
      <div className={styles.prejoin}>
        <EmptyState title="This link doesn't work">
          <p>{error}</p>
        </EmptyState>
      </div>
    );
  }
  if (!shared || !meeting) return <div className={styles.prejoin}><Muted>Loading the notes…</Muted></div>;
  const when = shared.startedAt ? new Date(shared.startedAt).toLocaleString([], { dateStyle: "full", timeStyle: "short" }) : undefined;
  return (
    <main className={styles.shared}>
      <header className={styles.sharedHead}>
        <Mark size={22} />
        <div>
          <h1 className={styles.sharedTitle}>{shared.title}</h1>
          <p className={styles.muted}>
            {[when, `Hosted by ${shared.hostName}`, shared.participants.map((participant) => participant.name).join(", ")].filter(Boolean).join(" · ")}
          </p>
          <p className={styles.muted}>Shared with you, read-only, until {new Date(shared.expiresAt).toLocaleDateString([], { dateStyle: "medium" })}.</p>
        </div>
      </header>
      <NotesPanel
        meeting={meeting}
        segments={shared.transcript ?? []}
        tab={tab === "transcript" && !shared.transcript ? "summary" : tab}
        onTab={(next) => setTab(next === "transcript" && !shared.transcript ? "summary" : next)}
        query={query}
        onQuery={setQuery}
      />
      {!shared.transcript ? <Muted>The host shared the summary and action items, not the transcript.</Muted> : null}
    </main>
  );
}
