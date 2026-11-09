"use client";

/**
 * Meetings → Recordings (/meetings/recordings), Sibyl Enterprise: call and
 * meeting recordings with search and filters, how long each is kept (or
 * "legal hold"), play (audio or video), download and delete. Needs a licence
 * with `recordings` and the calls.record permission; otherwise the tab is
 * hidden and this address explains where recordings come from.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { RecordingView } from "@open-gpt-live/protocol";
import { ScreenFrame, ScreenNotice } from "../../components/ScreenFrame";
import { Icon } from "../../components/Icon";
import { Badge, Button, Checkbox, EmptyState, Muted, Notice, Select, Stack } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { ENTERPRISE } from "../../lib/edition";
import { errorText, gatewayDownload, gatewayObjectUrl, gatewayRequest } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import meetingStyles from "../meetings/meetings.module.css";
import styles from "./recordings.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Filters {
  q: string;
  kind: "" | "call" | "phone";
  type: "" | "audio" | "video";
  held: boolean;
}

const recordingsApi = {
  list: (filters: Filters) => {
    const params = new URLSearchParams();
    if (filters.q.trim()) params.set("q", filters.q.trim());
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.type) params.set("type", filters.type);
    if (filters.held) params.set("held", "1");
    const search = params.toString();
    return gatewayRequest<{ items: RecordingView[]; retentionDays: number }>(`/api/recordings${search ? `?${search}` : ""}`);
  },
  hold: (id: string, legalHold: boolean) => gatewayRequest<RecordingView>(`/api/recordings/${encodeURIComponent(id)}`, { method: "PATCH", body: { legalHold } }),
  remove: (id: string) => gatewayRequest(`/api/recordings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  stop: (id: string) => gatewayRequest<RecordingView>(`/api/recordings/${encodeURIComponent(id)}/stop`, { method: "POST" })
};

export function RecordingsScreen() {
  const session = useAppSession();
  const licensed = session.hasFeature("recordings");
  const allowed = licensed && session.can("calls.record");
  return (
    <ScreenFrame title="Recordings" subtitle="Recordings of meetings and phone calls. Everyone in a recorded call sees that it is recorded; phone callers hear it.">
      {!licensed ? (
        <ScreenNotice
          icon={<Icon name="video" size={22} />}
          title={`Available with ${ENTERPRISE.name}`}
          action={
            <a className="ghostBtn" href={ENTERPRISE.url} target="_blank" rel="noreferrer">
              {ENTERPRISE.contactLabel}
            </a>
          }
        >
          <p>Audio and video recordings come with {ENTERPRISE.name}. Meeting notes and transcripts are always there.</p>
        </ScreenNotice>
      ) : !allowed ? (
        <ScreenNotice icon={<Icon name="video" size={22} />} title="Recordings are for admins">
          <p>Ask an owner or admin of this workspace if you need a recording.</p>
        </ScreenNotice>
      ) : (
        <RecordingsList />
      )}
    </ScreenFrame>
  );
}

function RecordingsList() {
  const params = useSearchParams();
  const focus = params?.get("id") ?? null;
  const [filters, setFilters] = useState<Filters>({ q: "", kind: "", type: "", held: false });
  const [items, setItems] = useState<RecordingView[] | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [playing, setPlaying] = useState<string | null>(focus);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (current: Filters) => {
    try {
      const result = await recordingsApi.list(current);
      setItems(result.items);
      setRetentionDays(result.retentionDays);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(filters), filters.q ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [filters, load]);

  // Still recording: refresh until it is ready.
  useEffect(() => {
    if (!items?.some((item) => item.status === "recording")) return;
    const timer = window.setInterval(() => void load(filters), 5_000);
    return () => window.clearInterval(timer);
  }, [items, filters, load]);

  async function run(id: string, work: () => Promise<unknown>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await work();
      await load(filters);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((current) => ({ ...current, [key]: value }));

  return (
    <Stack gap={12}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className={styles.toolbar}>
        <label className={meetingStyles.search}>
          <Icon name="search" size={16} />
          <input type="search" value={filters.q} onChange={(event) => set("q", event.target.value)} placeholder="Search recordings" aria-label="Search recordings" />
        </label>
        <Select aria-label="Kind" value={filters.kind} onChange={(event) => set("kind", event.target.value as Filters["kind"])}>
          <option value="">Meetings and calls</option>
          <option value="call">Meetings</option>
          <option value="phone">Phone calls</option>
        </Select>
        <Select aria-label="Type" value={filters.type} onChange={(event) => set("type", event.target.value as Filters["type"])}>
          <option value="">Audio and video</option>
          <option value="audio">Audio</option>
          <option value="video">Video</option>
        </Select>
        <Checkbox label="Legal hold" checked={filters.held} onChange={(event) => set("held", event.target.checked)} />
      </div>
      <Muted>
        Recordings are deleted {retentionDays} days after they start, unless they are on legal hold.
      </Muted>
      {items === null && !error ? <Muted>Loading…</Muted> : null}
      {items !== null && items.length === 0 ? (
        <EmptyState icon={<Icon name="video" size={22} />} title={filters.q || filters.kind || filters.type || filters.held ? "No recording matches" : "No recordings yet"}>
          <p>Start one in a meeting (Invite → Record) or turn on “Record every call” for the phone line.</p>
        </EmptyState>
      ) : null}
      <ul className={styles.list} aria-label="Recordings">
        {(items ?? []).map((item) => (
          <li key={item.id} className={styles.item} data-focus={item.id === focus || undefined}>
            <div className={styles.head}>
              <span className={styles.icon} aria-hidden>
                <Icon name={item.type === "video" ? "video" : item.kind === "phone" ? "phoneOff" : "volume"} size={18} />
              </span>
              <div className={styles.main}>
                <div className={styles.title}>
                  {item.meetingId ? <Link href={paths.meeting(item.meetingId)}>{item.title}</Link> : item.title}
                  <Badge>{item.kind === "phone" ? "Phone call" : "Meeting"}</Badge>
                  <Badge tone="outline">{item.type === "video" ? "Video" : "Audio"}</Badge>
                  {item.status === "recording" ? <Badge tone="danger">Recording</Badge> : item.status === "failed" ? <Badge tone="danger">Failed</Badge> : null}
                </div>
                <div className={styles.meta}>
                  {new Date(item.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  {item.durationMs ? ` · ${clock(item.durationMs)}` : ""}
                  {item.sizeBytes ? ` · ${size(item.sizeBytes)}` : ""}
                  {" · "}
                  {retention(item)}
                </div>
                {item.error ? <div className={styles.error}>{item.error}</div> : null}
              </div>
              <div className={styles.actions}>
                {item.status === "ready" ? (
                  <Button size="sm" variant={playing === item.id ? "secondary" : "ghost"} onClick={() => setPlaying(playing === item.id ? null : item.id)} aria-expanded={playing === item.id}>
                    <Icon name={playing === item.id ? "pause" : "play"} size={15} />
                    {playing === item.id ? "Close" : "Play"}
                  </Button>
                ) : null}
                {item.status === "recording" ? (
                  <Button size="sm" onClick={() => void run(item.id, () => recordingsApi.stop(item.id))} disabled={busy === item.id}>
                    Stop
                  </Button>
                ) : null}
                {item.status === "ready" ? (
                  <Button size="sm" variant="ghost" iconOnly aria-label="Download" title="Download" onClick={() => void run(item.id, () => gatewayDownload(`/api/recordings/${encodeURIComponent(item.id)}/file`, `recording-${item.id}`))}>
                    <Icon name="download" size={16} />
                  </Button>
                ) : null}
                <Checkbox
                  label="Legal hold"
                  checked={item.legalHold}
                  disabled={busy === item.id}
                  onChange={(event) => void run(item.id, () => recordingsApi.hold(item.id, event.target.checked))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  aria-label="Delete"
                  title={item.legalHold ? "On legal hold: lift the hold to delete" : "Delete"}
                  disabled={busy === item.id || item.legalHold}
                  onClick={() => {
                    if (window.confirm(`Delete the recording “${item.title}”? This can't be undone.`)) void run(item.id, () => recordingsApi.remove(item.id));
                  }}
                >
                  <Icon name="trash" size={16} />
                </Button>
              </div>
            </div>
            {playing === item.id && item.status === "ready" ? <Player recording={item} /> : null}
          </li>
        ))}
      </ul>
    </Stack>
  );
}

/** The recording, fetched with the session (auth stays in headers) and played from memory. */
export function Player({ recording }: { recording: Pick<RecordingView, "id" | "type"> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    gatewayObjectUrl(`/api/recordings/${encodeURIComponent(recording.id)}/file?inline=1`, controller.signal)
      .then((next) => {
        urlRef.current = next;
        setUrl(next);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught));
      });
    return () => {
      controller.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [recording.id]);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!url) return <Muted>Loading the recording…</Muted>;
  return recording.type === "video" ? (
    <video className={styles.video} src={url} controls autoPlay playsInline aria-label="Recording" />
  ) : (
    <audio className={styles.audio} src={url} controls autoPlay aria-label="Recording" />
  );
}

function retention(item: RecordingView): string {
  if (item.legalHold) return "Kept: legal hold";
  const days = Math.ceil((item.expiresAt - Date.now()) / DAY_MS);
  return days <= 0 ? "Deleted soon" : days === 1 ? "Deleted tomorrow" : `Deleted in ${days} days`;
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function size(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} kB`;
}
