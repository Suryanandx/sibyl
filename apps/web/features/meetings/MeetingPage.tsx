"use client";

/**
 * A meeting's page (/meetings/<id>), during and after the meeting: title
 * (editable by the host), date and time, participant chips; the notes as
 * Summary / Transcript / Actions; the people and playback (the recording
 * with Sibyl Enterprise, otherwise a timeline over the transcript); and
 * Comments / Ask AI / Keyword. Export as Markdown, print to PDF, save to
 * knowledge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MEETING_EVENTS,
  type KnowledgeBaseView,
  type MeetingSegmentView,
  type MeetingView,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { ScreenFrame } from "../../components/ScreenFrame";
import { Mark } from "../../components/Brand";
import { Icon } from "../../components/Icon";
import { Button, ButtonLink, Dialog, EmptyState, Field, Notice, Select } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { useGateway } from "../../lib/gateway";
import { errorText, gatewayHeaders, gatewayRequest, gatewayUrlFor } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import { AgentAvatar } from "../agents";
import { meetingsApi } from "./api";
import { AssistPanel } from "./AssistPanel";
import { NotesPanel, type NotesTab } from "./NotesPanel";
import { Playback, type PlaybackHandle } from "./Playback";
import { initials, speakerColor } from "./speakers";
import styles from "./meetings.module.css";
import { ENTERPRISE } from "../../lib/edition";

export function MeetingPage({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const gateway = useGateway();
  const session = useAppSession();
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [segments, setSegments] = useState<MeetingSegmentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<NotesTab>("summary");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [title, setTitle] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [audio, setAudio] = useState<{ url: string; data: ArrayBuffer } | null>(null);
  const playback = useRef<PlaybackHandle | null>(null);
  const canRecordings = session.hasFeature("recordings") && session.can("calls.record");

  const load = useCallback(async () => {
    try {
      const [view, lines] = await Promise.all([meetingsApi.get(meetingId), meetingsApi.transcript(meetingId)]);
      setMeeting(view);
      setTitle((current) => current || view.title);
      setSegments(lines);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, [meetingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While it is live, keep notes and transcript fresh.
  useEffect(() => {
    if (meeting?.status !== "live") return;
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [meeting?.status, load]);

  // The recording (Enterprise): fetched with the session, played from memory.
  useEffect(() => {
    if (!meeting?.recordingId || !canRecordings) return;
    let url: string | undefined;
    let cancelled = false;
    void fetch(gatewayUrlFor(`/api/recordings/${encodeURIComponent(meeting.recordingId)}/file`), { credentials: "include", headers: gatewayHeaders() })
      .then(async (response) => {
        if (!response.ok) throw new Error("recording unavailable");
        const data = await response.arrayBuffer();
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([data], { type: response.headers.get("content-type") ?? "audio/ogg" }));
        setAudio({ url, data });
      })
      .catch(() => setAudio(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [meeting?.recordingId, canRecordings]);

  // Task results come back over the socket.
  const { subscribe, send } = gateway;
  useEffect(
    () =>
      subscribe((message: ServerMessage) => {
        if (message.type !== MEETING_EVENTS.TASK_RESULT || message.meetingId !== meetingId) return;
        setPendingTasks((current) => {
          const next = new Set(current);
          next.delete(message.actionId);
          return next;
        });
        if (message.status === "created") {
          setNotice("Task created. It's under Automations → Routines.");
          void load();
        } else if (message.status === "failed") setError(message.message ?? "Couldn't create the task.");
      }),
    [subscribe, meetingId, load]
  );

  function createTask(actionId: string): void {
    if (!send({ type: MEETING_EVENTS.TASK, meetingId, actionId })) {
      setError("Not connected to Sibyl. Try again in a moment.");
      return;
    }
    setPendingTasks((current) => new Set(current).add(actionId));
    setNotice("Approve the task in your Inbox (or the approval card) to create it.");
  }

  async function saveTitle(): Promise<void> {
    if (!meeting || !title.trim() || title.trim() === meeting.title) return setTitle(meeting?.title ?? "");
    try {
      setMeeting(await meetingsApi.update(meeting.id, { title: title.trim() }));
    } catch (reason) {
      setError(errorText(reason));
      setTitle(meeting.title);
    }
  }

  async function refreshNotes(): Promise<void> {
    setRefreshing(true);
    try {
      setMeeting(await meetingsApi.refreshNotes(meetingId));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setRefreshing(false);
    }
  }

  async function exportMarkdown(): Promise<void> {
    try {
      const text = await meetingsApi.markdown(meetingId);
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(meeting?.title ?? "meeting").replace(/[^A-Za-z0-9 _-]/g, "").trim() || "meeting"}.md`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function share(): Promise<void> {
    await navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
    setNotice("Link copied. People in this workspace can open it.");
  }

  async function remove(): Promise<void> {
    if (!meeting || !window.confirm(`Delete “${meeting.title}” with its transcript, notes and comments? This can't be undone.`)) return;
    try {
      await meetingsApi.remove(meeting.id);
      router.push(paths.meetings);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  const people = useMemo(() => (meeting?.participants ?? []).slice().sort((a, b) => speakingMs(segments, b.identity) - speakingMs(segments, a.identity)), [meeting?.participants, segments]);
  const current = useMemo(() => [...segments].reverse().find((segment) => segment.startMs <= position), [segments, position]);
  const stageMain = people.find((person) => person.identity === current?.speaker) ?? people[0];

  if (error && !meeting) {
    return (
      <ScreenFrame title="Meeting" back={{ href: paths.meetings, label: "Meetings" }}>
        <EmptyState title="This meeting isn't available">
          <p>{error}</p>
        </EmptyState>
      </ScreenFrame>
    );
  }
  if (!meeting) {
    return (
      <ScreenFrame title="Meeting" back={{ href: paths.meetings, label: "Meetings" }}>
        <p className={styles.muted}>Loading…</p>
      </ScreenFrame>
    );
  }

  const when = meeting.startedAt ?? meeting.scheduledAt;
  const end = meeting.endedAt ?? meeting.scheduledEndAt;
  const shown = people.slice(0, 3);
  const recordingNote = audio
    ? undefined
    : session.hasFeature("recordings")
      ? meeting.recordingId
        ? "The recording isn't available (it may have expired)."
        : undefined
      : `Playback follows the transcript. Audio recordings come with ${ENTERPRISE.name}.`;

  return (
    <ScreenFrame
      title="Meetings"
      back={{ href: paths.meetings, label: "Meetings" }}
      actions={
        meeting.status !== "ended" && gateway.capabilities?.realtime ? (
          <ButtonLink href={paths.call(meeting.id, meeting.isHost)} variant="primary" size="sm">
            <Icon name="video" size={16} />
            {meeting.status === "live" ? "Join" : meeting.isHost ? "Start" : "Join"}
          </ButtonLink>
        ) : undefined
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="positive">{notice}</Notice> : null}
      <div className={styles.page}>
        <div className={styles.pageMain}>
          <header className={styles.header}>
            <div className={styles.titleRow}>
              {meeting.isHost ? (
                <input
                  className={styles.titleInput}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => void saveTitle()}
                  onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                  aria-label="Meeting title"
                  maxLength={140}
                />
              ) : (
                <h2 className={styles.titleInput}>{meeting.title}</h2>
              )}
              <div className={styles.headerActions}>
          <Button size="sm" variant="ghost" iconOnly onClick={() => void share()} aria-label="Copy link" title="Copy link">
            <Icon name="share" size={16} />
          </Button>
          <Button size="sm" variant="ghost" iconOnly onClick={() => void exportMarkdown()} aria-label="Export as Markdown" title="Export as Markdown">
            <Icon name="download" size={16} />
          </Button>
          <Button size="sm" variant="ghost" iconOnly onClick={() => window.print()} aria-label="Print or save as PDF" title="Print or save as PDF">
            <Icon name="notes" size={16} />
          </Button>
          {session.can("knowledge.edit") ? (
            <Button size="sm" onClick={() => setSaving(true)}>
              Save to knowledge
            </Button>
          ) : null}
          {meeting.isHost ? (
            <Button size="sm" variant="ghost" iconOnly onClick={() => void remove()} aria-label="Delete meeting" title="Delete meeting">
              <Icon name="trash" size={16} />
            </Button>
          ) : null}
              </div>
            </div>
            <div className={styles.meta}>
              {meeting.status === "live" ? <span className={styles.liveBadge}>Live</span> : null}
              {when ? (
                <span>
                  <Icon name="calendar" size={15} />
                  {new Date(when).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}
                </span>
              ) : null}
              {when ? (
                <span>
                  <Icon name="clock" size={15} />
                  {timeOf(when)}
                  {end ? ` – ${timeOf(end)}` : ""}
                </span>
              ) : null}
              <span>Host: {meeting.hostName}</span>
            </div>
            {people.length > 0 ? (
              <div className={styles.people}>
                <span className={styles.muted}>Participants</span>
                {shown.map((person) => (
                  <span key={person.identity} className={styles.chip} style={{ ["--speaker" as string]: speakerColor(person.color) }}>
                    <span className={styles.chipFace}>{initials(person.name)}</span>
                    {person.name}
                    {person.kind === "agent" && person.role === "notetaker" ? <span className={styles.badge}>Notes</span> : null}
                  </span>
                ))}
                {people.length > shown.length ? (
                  <span className={styles.chip} title={people.slice(3).map((person) => person.name).join(", ")} style={{ paddingLeft: 10 }}>
                    +{people.length - shown.length} more
                  </span>
                ) : null}
              </div>
            ) : null}
          </header>
          <section className={styles.card}>
            <NotesPanel
              meeting={meeting}
              segments={segments}
              tab={tab}
              onTab={setTab}
              query={query}
              onQuery={setQuery}
              positionMs={position}
              onSeek={(ms) => playback.current?.seek(ms)}
              onCreateTask={createTask}
              pendingTasks={pendingTasks}
              onRefresh={() => void refreshNotes()}
              refreshing={refreshing}
            />
          </section>
        </div>
        <aside className={styles.pageSide}>
          {stageMain ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ aspectRatio: "16 / 9" }}>
                <StaticTile person={stageMain} speaking={Boolean(current && current.speaker === stageMain.identity && position > 0)} large />
              </div>
              {people.length > 1 ? (
                <div className={styles.filmstripStatic}>
                  {people
                    .filter((person) => person !== stageMain)
                    .slice(0, 6)
                    .map((person) => (
                      <div key={person.identity} style={{ aspectRatio: "16 / 10" }}>
                        <StaticTile person={person} speaking={false} />
                      </div>
                    ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <Playback
            ref={playback}
            meeting={meeting}
            segments={segments}
            {...(audio ? { audioUrl: audio.url, audioData: audio.data } : {})}
            onPosition={setPosition}
            onDownload={() => {
              if (!audio) return void exportMarkdown();
              const link = document.createElement("a");
              link.href = audio.url;
              link.download = `${meeting.title.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "meeting"}.ogg`;
              link.click();
            }}
            downloadLabel={audio ? "Download the recording" : "Download notes and transcript"}
            note={recordingNote}
          />
          <section className={styles.card}>
            <AssistPanel
              meeting={meeting}
              segments={segments}
              tabs={["comments", "ask", "keyword"]}
              onKeyword={(word) => {
                setQuery(word);
                setTab("transcript");
              }}
              positionMs={position}
              onSeek={(ms) => playback.current?.seek(ms)}
            />
          </section>
          {meeting.conversationId ? (
            <p className={styles.small}>
              Replies and approvals from the meeting are in <Link href={paths.conversation(meeting.conversationId)}>its chat</Link>.
            </p>
          ) : null}
        </aside>
      </div>
      {saving ? <SaveToKnowledge meeting={meeting} onClose={() => setSaving(false)} onSaved={(name) => setNotice(`Saved to ${name}.`)} /> : null}
    </ScreenFrame>
  );
}

/** A participant's tile on the page (no live video afterwards): avatar or initials, name pill. */
function StaticTile({ person, speaking, large = false }: { person: MeetingView["participants"][number]; speaking: boolean; large?: boolean }) {
  const { gatewayAgents } = useAgentAvatars();
  const avatar = person.agentId ? gatewayAgents.get(person.agentId) : undefined;
  return (
    <div className={styles.tile} data-speaking={speaking} style={{ ["--speaker" as string]: speakerColor(person.color) }}>
      {person.kind === "agent" && avatar ? (
        <span className={styles.agentFace}>
          <AgentAvatar avatar={avatar} mood={speaking ? "speaking" : "idle"} size={large ? 96 : 48} />
        </span>
      ) : person.agentId === "sibyl" ? (
        <span className={styles.agentFace}>
          <Mark size={large ? 72 : 32} />
        </span>
      ) : (
        <span className={styles.face}>{initials(person.name)}</span>
      )}
      <span className={styles.pill}>
        <span className={styles.dot} />
        <span>{person.name}</span>
      </span>
      {person.kind === "agent" && person.role === "notetaker" ? (
        <span className={styles.tileBadges}>
          <span className={styles.tileBadge}>Taking notes</span>
        </span>
      ) : null}
    </div>
  );
}

function useAgentAvatars() {
  const gateway = useGateway();
  const gatewayAgents = useMemo(() => new Map(gateway.agents.agents.map((agent) => [agent.id, agent.avatar])), [gateway.agents.agents]);
  return { gatewayAgents };
}

function SaveToKnowledge({ meeting, onClose, onSaved }: { meeting: MeetingView; onClose(): void; onSaved(name: string): void }) {
  const session = useAppSession();
  const [bases, setBases] = useState<KnowledgeBaseView[] | null>(null);
  const [baseId, setBaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gatewayRequest<{ bases: KnowledgeBaseView[] }>("/api/knowledge")
      .then((result) => {
        setBases(result.bases);
        setBaseId(result.bases[0]?.id ?? "");
      })
      .catch((reason) => setError(errorText(reason)));
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      let target = bases?.find((base) => base.id === baseId);
      if (!target) {
        target = (await gatewayRequest<{ base: KnowledgeBaseView }>("/api/knowledge", { method: "POST", body: { name: "Meetings", description: "Notes and transcripts of meetings." } })).base;
      }
      const text = await meetingsApi.markdown(meeting.id);
      await gatewayRequest(`/api/knowledge/${encodeURIComponent(target.id)}/docs`, { method: "POST", body: { kind: "text", title: meeting.title.slice(0, 200), text } });
      onSaved(target.name);
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  const canCreate = session.can("knowledge.manage");
  return (
    <Dialog
      title="Save to knowledge"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || bases === null || (!baseId && !canCreate)}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <p className={styles.muted}>The notes, action items and transcript become a document agents can search.</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {bases && bases.length > 0 ? (
        <Field label="Knowledge base">
          <Select value={baseId} onChange={(event) => setBaseId(event.target.value)}>
            {bases.map((base) => (
              <option key={base.id} value={base.id}>
                {base.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : bases ? (
        <p className={styles.muted}>{canCreate ? "A knowledge base called “Meetings” will be created." : "There's no knowledge base yet. Ask an admin to create one."}</p>
      ) : null}
    </Dialog>
  );
}

function speakingMs(segments: readonly MeetingSegmentView[], identity: string): number {
  return segments.filter((segment) => segment.speaker === identity).reduce((total, segment) => total + Math.max(1_000, segment.endMs - segment.startMs), 0);
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

