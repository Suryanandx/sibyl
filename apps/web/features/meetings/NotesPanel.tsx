"use client";

/**
 * The meeting's AI notes as tabs: Summary (overview, key points, AI insight),
 * Transcript (speaker-labelled, searchable, jump to a moment) and Actions
 * (owner, due date, "Create task"). The same component runs in the room's
 * side panel and on the meeting page.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { MeetingSegmentView, MeetingView } from "@open-gpt-live/protocol";
import { Icon, type IconName } from "../../components/Icon";
import { Button, EmptyState } from "../../components/ui";
import { paths } from "../../lib/routes";
import { colorOf } from "./api";
import { clock, speakerColor } from "./speakers";
import styles from "./meetings.module.css";

export type NotesTab = "summary" | "transcript" | "actions";

export interface NotesPanelProps {
  meeting: MeetingView;
  segments: MeetingSegmentView[];
  tab: NotesTab;
  onTab(tab: NotesTab): void;
  /** Highlight this text in the transcript (Keyword). */
  query: string;
  onQuery(query: string): void;
  /** Playback position (ms from the start): the line being said is marked and kept in view. */
  positionMs?: number;
  onSeek?(ms: number): void;
  /** Make a task from an action item (through the approval card). */
  onCreateTask?(actionId: string): void;
  /** Action ids whose task is being asked for. */
  pendingTasks?: ReadonlySet<string>;
  onRefresh?(): void;
  refreshing?: boolean;
  /** Extra buttons in the tab bar (search, more…). */
  extra?: ReactNode;
}

export function NotesPanel(props: NotesPanelProps) {
  const { meeting, tab } = props;
  const actions = meeting.notes?.actions ?? [];
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.tabBar} role="tablist" aria-label="Meeting notes">
          <TabButton selected={tab === "summary"} onClick={() => props.onTab("summary")}>
            Summary
          </TabButton>
          <TabButton selected={tab === "transcript"} onClick={() => props.onTab("transcript")}>
            Transcript
          </TabButton>
          <TabButton selected={tab === "actions"} onClick={() => props.onTab("actions")}>
            Actions{actions.length > 0 ? <span className={styles.count}>{actions.length}</span> : null}
          </TabButton>
        </div>
        {props.extra}
      </div>
      {tab === "summary" ? <Summary {...props} /> : null}
      {tab === "transcript" ? <Transcript {...props} /> : null}
      {tab === "actions" ? <Actions {...props} /> : null}
    </div>
  );
}

function TabButton({ selected, onClick, children }: { selected: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={selected} onClick={onClick}>
      {children}
    </button>
  );
}

export function Section({ icon, title, children, defaultOpen = true }: { icon: IconName; title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.section} data-open={open}>
      <button type="button" className={styles.sectionHead} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={styles.sectionIcon}>
          <Icon name={icon} size={14} />
        </span>
        <span>{title}</span>
        <Icon name="chevronDown" size={16} className={styles.chevron} />
      </button>
      {open ? <div className={styles.sectionBody}>{children}</div> : null}
    </section>
  );
}

function Summary({ meeting, onRefresh, refreshing }: NotesPanelProps) {
  const notes = meeting.notes;
  if (!notes) {
    return (
      <EmptyState compact icon={<Icon name="notes" size={22} />} title={meeting.segmentCount > 0 ? "Notes are on their way" : "No notes yet"}>
        <p>
          {meeting.status === "live"
            ? "Sibyl writes the notes from the transcript every few minutes, and once more when the meeting ends."
            : meeting.segmentCount > 0
              ? "Write them now from the transcript."
              : "Notes appear once people have talked in the meeting."}
        </p>
        {onRefresh && meeting.segmentCount > 0 ? (
          <Button size="sm" onClick={onRefresh} disabled={refreshing}>
            <Icon name="sparkle" size={14} />
            {refreshing ? "Writing…" : "Write notes now"}
          </Button>
        ) : null}
      </EmptyState>
    );
  }
  return (
    <>
      <Section icon="notes" title="Meeting overview">
        <p>{notes.overview || "No overview yet."}</p>
      </Section>
      {notes.keyPoints.length > 0 ? (
        <Section icon="check" title="Key points">
          <ul className={styles.points}>
            {notes.keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {notes.insights.length > 0 ? (
        <Section icon="sparkle" title="AI insight">
          <ul className={styles.points}>
            {notes.insights.map((insight, index) => (
              <li key={index}>{insight}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <p className={styles.small}>
        {notes.by ? `Notes by ${notes.by.name}` : "Notes by Sibyl"} · {notes.final ? "final" : "updated"} {new Date(notes.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        {onRefresh ? (
          <>
            {" · "}
            <button type="button" className={styles.time} onClick={onRefresh} disabled={refreshing}>
              {refreshing ? "refreshing…" : "refresh"}
            </button>
          </>
        ) : null}
      </p>
    </>
  );
}

function Transcript({ meeting, segments, query, onQuery, positionMs, onSeek }: NotesPanelProps) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (needle ? segments.filter((segment) => `${segment.speakerName} ${segment.text}`.toLowerCase().includes(needle)) : segments), [segments, needle]);
  const active = positionMs === undefined ? undefined : [...segments].reverse().find((segment) => segment.startMs <= positionMs)?.seq;

  useEffect(() => {
    if (active === undefined) return;
    listRef.current?.querySelector(`[data-seq="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <>
      <label className={styles.search}>
        <Icon name="search" size={16} />
        <input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search the transcript" aria-label="Search the transcript" />
        {needle ? <span className={styles.small}>{shown.length}</span> : null}
      </label>
      {segments.length === 0 ? (
        <EmptyState compact icon={<Icon name="captions" size={22} />} title="Nothing said yet">
          <p>{meeting.status === "live" ? "What people say appears here as they talk." : "This meeting has no transcript."}</p>
        </EmptyState>
      ) : shown.length === 0 ? (
        <p className={styles.muted}>No line mentions “{query}”.</p>
      ) : (
        <ol className={styles.lines} ref={listRef}>
          {shown.map((segment) => (
            <li key={segment.seq} className={styles.line} data-seq={segment.seq} data-active={segment.seq === active}>
              <span className={styles.lineWho}>
                <span className={styles.dot} style={{ ["--speaker" as string]: speakerColor(colorOf(meeting.participants, segment.speaker)) }} />
                {segment.speakerName}
                <button type="button" className={styles.time} onClick={() => onSeek?.(segment.startMs)} aria-label={`Jump to ${clock(segment.startMs)}`} disabled={!onSeek}>
                  {clock(segment.startMs)}
                </button>
              </span>
              <span className={styles.lineText}>
                <Highlight text={segment.text} needle={needle} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

export function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let found = lower.indexOf(needle); found >= 0; found = lower.indexOf(needle, at)) {
    parts.push(<Fragment key={`t${at}`}>{text.slice(at, found)}</Fragment>);
    parts.push(
      <mark key={`m${found}`} className={styles.mark}>
        {text.slice(found, found + needle.length)}
      </mark>
    );
    at = found + needle.length;
  }
  parts.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}

function Actions({ meeting, onCreateTask, pendingTasks }: NotesPanelProps) {
  const actions = meeting.notes?.actions ?? [];
  if (actions.length === 0) {
    return (
      <EmptyState compact icon={<Icon name="check" size={22} />} title="No action items yet">
        <p>When someone agrees to do something, it shows up here with who and when.</p>
      </EmptyState>
    );
  }
  return (
    <ul className={styles.actions}>
      {actions.map((action) => (
        <li key={action.id} className={styles.action}>
          <span className={styles.check} aria-hidden="true" />
          <div>
            <span>{action.text}</span>
            {action.owner || action.due ? (
              <span className={styles.actionMeta}>
                {action.owner ? <span className={styles.badge}>{action.owner}</span> : null}
                {action.due ? (
                  <span className={styles.badge}>
                    <Icon name="calendar" size={12} />
                    {action.due}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          {action.routineId ? (
            <Link className={styles.small} href={paths.routines}>
              Task created
            </Link>
          ) : onCreateTask ? (
            <Button size="sm" variant="ghost" onClick={() => onCreateTask(action.id)} disabled={pendingTasks?.has(action.id)}>
              {pendingTasks?.has(action.id) ? "Waiting for approval…" : "Create task"}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
