"use client";

import { useId, useState } from "react";
import type { RoutinePatch, RoutineRunStatusView, RoutineView } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";
import { NotificationPermissionButton, relativeTime, useEscape } from "./Inbox";

interface RoutinesPanelProps {
  open: boolean;
  routines: RoutineView[];
  connected: boolean;
  /** Pending approvals per routine id. */
  waiting: Record<string, number>;
  onUpdate(id: string, patch: RoutinePatch): void;
  onRunNow(id: string): void;
  onDelete(id: string): void;
  onOpenConversation(id: string): void;
  onOpenInbox(): void;
  onClose(): void;
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

/** Scheduled routines: when they run next, how the last run went, and controls. */
export function RoutinesPanel(props: RoutinesPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEscape(props.open, props.onClose);
  if (!props.open) return null;
  const totalWaiting = Object.values(props.waiting).reduce((sum, n) => sum + n, 0);

  return (
    <div className="dialogBackdrop" onClick={props.onClose}>
      <section
        className="dialog routinesDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="routines-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="iconBtn dialogClose" onClick={props.onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <header className="dialogHeader">
          <h2 id="routines-title">Routines</h2>
          <p>
            Tasks Sibyl runs on a schedule, on its own. Create one by asking in chat, e.g. &ldquo;Every weekday at 8,
            send me a summary of tech news.&rdquo;
          </p>
        </header>
        <div className="routinesToolbar">
          <NotificationPermissionButton />
          <button type="button" className="ghostBtn" onClick={props.onOpenInbox}>
            Inbox{totalWaiting > 0 ? ` (${totalWaiting})` : ""}
          </button>
        </div>

        {props.routines.length === 0 ? (
          <div className="routinesEmpty">
            <RoutinesIcon size={24} />
            <p>No routines yet. Ask Sibyl in chat to schedule one.</p>
          </div>
        ) : (
          <ul className="routineList">
            {props.routines.map((routine) => (
              <li key={routine.id} className={`routineCard${routine.enabled ? "" : " paused"}`}>
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
                    <div className="routineHead">
                      <div className="routineTitle">
                        <h3>{routine.name}</h3>
                        <p className="routineSchedule">{routine.schedule}</p>
                      </div>
                      <label className="routineToggle" title={routine.enabled ? "Pause" : "Resume"}>
                        <input
                          type="checkbox"
                          checked={routine.enabled}
                          disabled={!props.connected}
                          aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
                          onChange={(event) => props.onUpdate(routine.id, { enabled: event.target.checked })}
                        />
                        <span className="switch" aria-hidden />
                      </label>
                    </div>
                    <p className="routineInstruction">{routine.instruction}</p>
                    <dl className="routineFacts">
                      <div>
                        <dt>Next run</dt>
                        <dd>{routine.enabled ? formatLocal(routine.nextRunAt) : "Paused"}</dd>
                      </div>
                      <div>
                        <dt>Last run</dt>
                        <dd>
                          {routine.lastRun ? (
                            <>
                              <span className={`runStatus ${routine.lastRun.status}`}>{STATUS_LABEL[routine.lastRun.status]}</span>
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
                      <p className="routineError">{routine.lastRun.error}</p>
                    ) : null}
                    {props.waiting[routine.id] ? (
                      <button type="button" className="routineWaiting" onClick={props.onOpenInbox}>
                        {props.waiting[routine.id]} approval{props.waiting[routine.id] === 1 ? "" : "s"} waiting — review
                      </button>
                    ) : null}
                    <div className="routineActions">
                      <button
                        type="button"
                        className="ghostBtn"
                        disabled={!props.connected || routine.lastRun?.status === "running" || routine.lastRun?.status === "awaiting_approval"}
                        onClick={() => props.onRunNow(routine.id)}
                      >
                        <Icon name="arrowUp" size={15} /> Run now
                      </button>
                      <button type="button" className="ghostBtn" disabled={!props.connected} onClick={() => setEditing(routine.id)}>
                        <Icon name="pencil" size={15} /> Edit
                      </button>
                      {routine.conversationId ? (
                        <button type="button" className="ghostBtn" onClick={() => props.onOpenConversation(routine.conversationId!)}>
                          <Icon name="chat" size={15} /> Results
                        </button>
                      ) : null}
                      {confirmDelete === routine.id ? (
                        <span className="routineConfirm">
                          <button
                            type="button"
                            className="ghostBtn danger"
                            onClick={() => {
                              props.onDelete(routine.id);
                              setConfirmDelete(null);
                            }}
                          >
                            Delete for good
                          </button>
                          <button type="button" className="ghostBtn" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="ghostBtn danger"
                          disabled={!props.connected}
                          onClick={() => setConfirmDelete(routine.id)}
                        >
                          <Icon name="close" size={15} /> Delete
                        </button>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
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
  const id = useId();
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
      className="routineEditor"
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
      <label className="field" htmlFor={`${id}-name`}>
        <span className="fieldLabel">Name</span>
        <input id={`${id}-name`} className="routineInput" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field" htmlFor={`${id}-instruction`}>
        <span className="fieldLabel">Instruction</span>
        <textarea
          id={`${id}-instruction`}
          className="routineInput"
          rows={3}
          value={instruction}
          maxLength={4000}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <div className="routineEditorRow">
        <label className="field" htmlFor={`${id}-cron`}>
          <span className="fieldLabel">Schedule (cron)</span>
          <input
            id={`${id}-cron`}
            className="routineInput mono"
            value={cron}
            aria-invalid={cronInvalid}
            onChange={(e) => setCron(e.target.value)}
          />
          <span className="fieldHint">minute hour day month weekday — e.g. 0 8 * * 1-5</span>
        </label>
        <label className="field" htmlFor={`${id}-tz`}>
          <span className="fieldLabel">Time zone</span>
          <input id={`${id}-tz`} className="routineInput" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
        <label className="field" htmlFor={`${id}-cap`}>
          <span className="fieldLabel">Cost cap per run (USD)</span>
          <input
            id={`${id}-cap`}
            className="routineInput"
            inputMode="decimal"
            placeholder="Server default"
            value={cap}
            aria-invalid={capInvalid}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
      </div>
      <div className="routineActions">
        <button type="submit" className="darkBtn" disabled={invalid}>
          Save
        </button>
        <button type="button" className="ghostBtn" onClick={onCancel}>
          Cancel
        </button>
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
