"use client";

/**
 * Meetings (/meetings): live now, upcoming, past; search; "New meeting"
 * (start now, or schedule — optionally from a Google or Microsoft calendar
 * event when one is connected).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MeetingAgentRoleView, MeetingCalendarEventView, MeetingView } from "@open-gpt-live/protocol";
import { ScreenFrame } from "../../components/ScreenFrame";
import { Icon } from "../../components/Icon";
import { Button, Dialog, EmptyState, Field, Input, Notice, Select } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { useGateway } from "../../lib/gateway";
import { errorText } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import { meetingsApi } from "./api";
import { speakerColor, initials } from "./speakers";
import styles from "./meetings.module.css";

export function MeetingsScreen() {
  const gateway = useGateway();
  const [items, setItems] = useState<MeetingView[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const live = Boolean(gateway.capabilities?.realtime);

  const load = useCallback(async (q: string) => {
    try {
      setItems(await meetingsApi.list(q));
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const groups = useMemo(() => {
    const all = items ?? [];
    const now = Date.now();
    return [
      { id: "live", label: "Live now", items: all.filter((m) => m.status === "live") },
      { id: "upcoming", label: "Upcoming", items: all.filter((m) => m.status === "scheduled" && (m.scheduledAt ?? now) >= now - 60 * 60_000).reverse() },
      { id: "past", label: "Past", items: all.filter((m) => m.status === "ended" || (m.status === "scheduled" && (m.scheduledAt ?? now) < now - 60 * 60_000)) }
    ].filter((group) => group.items.length > 0);
  }, [items]);

  return (
    <ScreenFrame
      title="Meetings"
      subtitle="Calls with people and agents. Sibyl keeps the transcript, writes the notes and finds the action items."
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} />
          New meeting
        </Button>
      }
    >
      {!live && gateway.capabilities ? (
        <Notice>Calls need the realtime layer (LiveKit; see docs/realtime.md). You can still schedule meetings and read notes here.</Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings, notes and people" aria-label="Search meetings" />
        </label>
      </div>
      {items === null && !error ? <p className={styles.muted}>Loading…</p> : null}
      {items !== null && groups.length === 0 ? (
        <EmptyState icon={<Icon name="video" size={22} />} title={query ? "No meeting matches" : "No meetings yet"} action={query ? undefined : <Button onClick={() => setCreating(true)}>New meeting</Button>}>
          <p>{query ? "Try another word." : "Start one now, or schedule one for later. Agents can join as participants or as silent note-takers."}</p>
        </EmptyState>
      ) : null}
      <div className={styles.groups}>
        {groups.map((group) => (
          <section key={group.id} className={styles.group} aria-labelledby={`meetings-${group.id}`}>
            <h2 id={`meetings-${group.id}`}>{group.label}</h2>
            <ul className={styles.rows}>
              {group.items.map((meeting) => (
                <li key={meeting.id}>
                  <Row meeting={meeting} live={live} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {creating ? <NewMeeting live={live} onClose={() => setCreating(false)} onCreated={() => void load(query)} /> : null}
    </ScreenFrame>
  );
}

function Row({ meeting, live }: { meeting: MeetingView; live: boolean }) {
  const at = meeting.startedAt ?? meeting.scheduledAt;
  const date = at ? new Date(at) : undefined;
  const people = meeting.participants.slice(0, 4);
  return (
    <Link href={paths.meeting(meeting.id)} className={styles.row}>
      <span className={styles.when}>
        {date ? (
          <>
            <span>{date.toLocaleDateString([], { month: "short" })}</span>
            <strong>{date.getDate()}</strong>
          </>
        ) : (
          <Icon name="calendar" size={18} />
        )}
      </span>
      <span className={styles.rowTitle}>
        <strong>{meeting.title}</strong>
        <span>
          {date ? `${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ` : ""}
          {meeting.notes?.overview || (meeting.status === "scheduled" ? `Hosted by ${meeting.hostName}` : `${meeting.segmentCount} transcript lines`)}
        </span>
      </span>
      <span className={styles.rowSide}>
        {people.map((person) => (
          <span key={person.identity} className={styles.chipFace} title={person.name} style={{ ["--speaker" as string]: speakerColor(person.color) }}>
            {initials(person.name)}
          </span>
        ))}
        {meeting.status === "live" ? <span className={styles.liveBadge}>Live</span> : null}
        {meeting.notes?.actions.length ? <span className={styles.badge}>{meeting.notes.actions.length} actions</span> : null}
        {live && meeting.status === "live" ? <span className={styles.badge}>Join</span> : null}
      </span>
    </Link>
  );
}

function NewMeeting({ live, onClose, onCreated }: { live: boolean; onClose(): void; onCreated(): void }) {
  const router = useRouter();
  const session = useAppSession();
  const [when, setWhen] = useState<"now" | "later">(live ? "now" : "later");
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(() => localInput(Date.now() + 60 * 60_000));
  const [minutes, setMinutes] = useState("30");
  const [sibylRole, setSibylRole] = useState<MeetingAgentRoleView>("participant");
  const [events, setEvents] = useState<{ connected: string[]; items: MeetingCalendarEventView[] } | null>(null);
  const [picked, setPicked] = useState<MeetingCalendarEventView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (when !== "later" || events || !session.can("integrations.use")) return;
    meetingsApi
      .calendar()
      .then(setEvents)
      .catch(() => setEvents({ connected: [], items: [] }));
  }, [when, events, session]);

  function pick(event: MeetingCalendarEventView): void {
    const same = picked?.eventId === event.eventId;
    setPicked(same ? null : event);
    if (same) return;
    setTitle(event.title);
    setStart(localInput(event.start));
    if (event.end) setMinutes(String(Math.max(5, Math.round((event.end - event.start) / 60_000))));
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const scheduledAt = when === "later" ? new Date(start).getTime() : undefined;
      const meeting = await meetingsApi.create({
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(scheduledAt ? { scheduledAt, scheduledEndAt: scheduledAt + Number(minutes || "30") * 60_000 } : {}),
        sibylRole,
        ...(picked ? { calendar: { provider: picked.provider, eventId: picked.eventId } } : {})
      });
      onCreated();
      router.push(when === "now" ? paths.call(meeting.id, true) : paths.meeting(meeting.id));
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="New meeting"
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : when === "now" ? "Start now" : "Schedule"}
          </Button>
        </>
      }
    >
      <div className={styles.formGrid}>
        <div className={styles.tabBar} role="tablist" aria-label="When">
          <button type="button" role="tab" aria-selected={when === "now"} onClick={() => setWhen("now")} disabled={!live}>
            Start now
          </button>
          <button type="button" role="tab" aria-selected={when === "later"} onClick={() => setWhen("later")}>
            Schedule
          </button>
        </div>
        <Field label="Title">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly product sync" maxLength={140} />
        </Field>
        {when === "later" ? (
          <>
            {events && events.items.length > 0 ? (
              <Field label="From your calendar" hint="Pick an event to fill in its title and time.">
                <div className={styles.events}>
                  {events.items.map((event) => (
                    <button key={`${event.provider}:${event.eventId}`} type="button" className={styles.event} aria-pressed={picked?.eventId === event.eventId} onClick={() => pick(event)}>
                      <span>{event.title}</span>
                      <span className={styles.small}>{new Date(event.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
                    </button>
                  ))}
                </div>
              </Field>
            ) : null}
            <div className={styles.twoCol}>
              <Field label="Starts">
                <Input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} required />
              </Field>
              <Field label="Length (minutes)">
                <Input type="number" min={5} max={600} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
              </Field>
            </div>
          </>
        ) : null}
        <Field label="Sibyl joins as" hint={sibylRole === "notetaker" ? "Listens and keeps the notes; never speaks." : "Keeps the notes and answers when someone says “Sibyl”."}>
          <Select value={sibylRole} onChange={(event) => setSibylRole(event.target.value as MeetingAgentRoleView)}>
            <option value="participant">Participant</option>
            <option value="notetaker">Silent note-taker</option>
          </Select>
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Dialog>
  );
}

/** A timestamp as the value of <input type="datetime-local"> (local time). */
function localInput(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

