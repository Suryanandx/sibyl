"use client";

import { useState } from "react";
import type { RoutinePatch, RoutineRunStatusView, RoutineView } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";
import { Button, Card, EmptyState, Field, Input, Notice, Textarea, Toolbar, cx } from "./ui";
import styles from "./RoutinesPanel.module.css";
import { NotificationPermissionButton, relativeTime } from "./Inbox";

interface RoutinesPanelProps {
  routines: RoutineView[];
  connected: boolean;
  /** Pending approvals per routine id. */
  waiting: Record<string, number>;
  onUpdate(id: string, patch: RoutinePatch): void;
  onRunNow(id: string): void;
  onDelete(id: string): void;
  onOpenConversation(id: string): void;
  onOpenInbox(): void;
}

const STATUS_LABEL: Record<RoutineRunStatusView, string> = {
  running: "Running",
  awaiting_approval: "Waiting for approval",
  succeeded: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  budget_blocked: "Stopped at budget"
};

export function RoutinesIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5.5 5.5h13a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V7a1.5 1.5 0 0 1 1.5-1.5Z M4 9.5h16 M8.5 3.5v3.5 M15.5 3.5v3.5 M12 12.5v2.5l1.8 1.2" />
    </svg>
  );
}

/**
 * Scheduled routines: when they run next, how the last run went, and controls.
 * The body of the Routines screen (/routines).
 */
export function RoutinesPanel(props: RoutinesPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const totalWaiting = Object.values(props.waiting).reduce((sum, n) => sum + n, 0);

  return (
    <div>
      <Toolbar
        start={
          <>
            <NotificationPermissionButton />
            <Button size="sm" onClick={props.onOpenInbox}>
              Inbox{totalWaiting > 0 ? ` (${totalWaiting})` : ""}
            </Button>
          </>
        }
      />

      {props.routines.length === 0 ? (
        <EmptyState compact icon={<RoutinesIcon size={24} />} title="No routines yet">
          <p>Ask Sibyl in chat to schedule one.</p>
        </EmptyState>
      ) : (
        <ul className={styles.list}>
          {props.routines.map((routine) => (
            <Card as="li" key={routine.id} className={cx(styles.card, !routine.enabled && styles.paused)}>
              {editing === routine.id ? (
                <RoutineEditor
                  routine={routine}
                  onCancel={() => setEditing(null)}
                  onSave={(patch) => {
                    if (Object.keys(patch).length > 0) props.onUpdate(routine.id, patch);
                    setEditing(null);
                  }}
                />
              ) : (
                <>
                  <div className={styles.head}>
                    <div className={styles.title}>
                      <h3 className={styles.name}>{routine.name}</h3>
                      <p className={styles.schedule}>{routine.schedule}</p>
                    </div>
                    <label className={styles.toggle} title={routine.enabled ? "Pause" : "Resume"}>
                      <input
                        type="checkbox"
                        role="switch"
                        className={styles.toggleInput}
                        checked={routine.enabled}
                        disabled={!props.connected}
                        aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
                        onChange={(event) => props.onUpdate(routine.id, { enabled: event.target.checked })}
                      />
                      <span className={styles.switch} aria-hidden />
                    </label>
                  </div>
                  <p className={styles.instruction}>{routine.instruction}</p>
                  <dl className={styles.facts}>
                    <div>
                      <dt>Next run</dt>
                      <dd>{routine.enabled ? formatLocal(routine.nextRunAt) : "Paused"}</dd>
                    </div>
                    <div>
                      <dt>Last run</dt>
                      <dd>
                        {routine.lastRun ? (
                          <>
                            <span className={cx(styles.status, styles[`status_${routine.lastRun.status}`])}>{STATUS_LABEL[routine.lastRun.status]}</span>
                            {" · "}
                            {relativeTime(routine.lastRun.finishedAt ?? routine.lastRun.startedAt)}
                            {routine.lastRun.costUsd > 0 ? ` · ${formatCost(routine.lastRun.costUsd)}` : ""}
                          </>
                        ) : (
                          "Never"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Cost cap</dt>
                      <dd>{routine.maxRunUsd !== undefined ? `${formatCost(routine.maxRunUsd)} per run` : "Server default"}</dd>
                    </div>
                  </dl>
                  {routine.lastRun?.error && routine.lastRun.status !== "succeeded" ? (
                    <Notice tone="danger">{routine.lastRun.error}</Notice>
                  ) : null}
                  {props.waiting[routine.id] ? (
                    <button type="button" className={styles.waiting} onClick={props.onOpenInbox}>
                      {props.waiting[routine.id]} approval{props.waiting[routine.id] === 1 ? "" : "s"} waiting — review
                    </button>
                  ) : null}
                  <div className={styles.actions}>
                    <Button
                      size="sm"
                      disabled={!props.connected || routine.lastRun?.status === "running" || routine.lastRun?.status === "awaiting_approval"}
                      onClick={() => props.onRunNow(routine.id)}
                    >
                      <Icon name="arrowUp" size={15} /> Run now
                    </Button>
                    <Button size="sm" disabled={!props.connected} onClick={() => setEditing(routine.id)}>
                      <Icon name="pencil" size={15} /> Edit
                    </Button>
                    {routine.conversationId ? (
                      <Button size="sm" onClick={() => props.onOpenConversation(routine.conversationId!)}>
                        <Icon name="chat" size={15} /> Results
                      </Button>
                    ) : null}
                    {confirmDelete === routine.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            props.onDelete(routine.id);
                            setConfirmDelete(null);
                          }}
                        >
                          Delete for good
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="danger" disabled={!props.connected} onClick={() => setConfirmDelete(routine.id)}>
                        <Icon name="close" size={15} /> Delete
                      </Button>
                    )}
                  </div>
                </>
              )}
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutineEditor({
  routine,
  onSave,
  onCancel
}: {
  routine: RoutineView;
  onSave(patch: RoutinePatch): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(routine.name);
  const [instruction, setInstruction] = useState(routine.instruction);
  const [cron, setCron] = useState(routine.cron);
  const [timezone, setTimezone] = useState(routine.timezone);
  const [cap, setCap] = useState(routine.maxRunUsd === undefined ? "" : String(routine.maxRunUsd));
  const capValue = cap.trim() === "" ? null : Number(cap);
  const capInvalid = capValue !== null && (!Number.isFinite(capValue) || capValue <= 0 || capValue > 100);
  const cronInvalid = cron.trim().split(/\s+/).length !== 5 && !cron.trim().startsWith("@");
  const invalid = !name.trim() || !instruction.trim() || !timezone.trim() || capInvalid || cronInvalid;

  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        const patch: RoutinePatch = {};
        if (name.trim() !== routine.name) patch.name = name.trim();
        if (instruction.trim() !== routine.instruction) patch.instruction = instruction.trim();
        if (cron.trim() !== routine.cron) patch.cron = cron.trim();
        if (timezone.trim() !== routine.timezone) patch.timezone = timezone.trim();
        if ((capValue ?? undefined) !== routine.maxRunUsd) patch.maxRunUsd = capValue;
        onSave(patch);
      }}
    >
      <Field label="Name">
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Instruction">
        <Textarea rows={3} value={instruction} maxLength={4000} onChange={(e) => setInstruction(e.target.value)} />
      </Field>
      <div className={styles.editorRow}>
        <Field label="Schedule (cron)" hint="minute hour day month weekday — e.g. 0 8 * * 1-5">
          <Input mono value={cron} aria-invalid={cronInvalid} onChange={(e) => setCron(e.target.value)} />
        </Field>
        <Field label="Time zone">
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Field label="Cost cap per run (USD)">
          <Input inputMode="decimal" placeholder="Server default" value={cap} aria-invalid={capInvalid} onChange={(e) => setCap(e.target.value)} />
        </Field>
      </div>
      <div className={styles.actions}>
        <Button type="submit" size="sm" variant="primary" disabled={invalid}>
          Save
        </Button>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A time in the browser's own zone, e.g. "Tue 10 Nov, 08:00". */
function formatLocal(at: number | undefined): string {
  if (at === undefined) return "Not scheduled";
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
