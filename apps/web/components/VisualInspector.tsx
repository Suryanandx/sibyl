"use client";

/**
 * Sibyl's Visual inspector: what happened to each generated visual.
 *
 * It listens to @openuidev/observability, the in-page event bus the OpenUI
 * renderer reports to (no network). Per visual it shows parse and render
 * errors and warnings, the raw OpenUI Lang source (with copy) and timing.
 * On in development; elsewhere behind Settings → Diagnostics → Visual inspector.
 */
import { useEffect, useId, useRef, useState } from "react";
import { observability, type ObservabilityEvent } from "@openuidev/observability";
import { create } from "zustand";
import { Icon } from "./Icon";

const SETTING_KEY = "sibyl.visualInspector";
const STREAM_KIND = "react-lang:stream";
const MAX_VISUALS = 30;
const MAX_NOTES = 30;

function readSetting(): boolean {
  try {
    return window.localStorage.getItem(SETTING_KEY) === "on";
  } catch {
    return false;
  }
}

/** The Diagnostics toggle (outside development). */
export const useVisualInspectorSetting = create<{ enabled: boolean; setEnabled(enabled: boolean): void }>((set) => ({
  // Read after mount (VisualInspector), so server and first client render agree.
  enabled: false,
  setEnabled(enabled) {
    try {
      window.localStorage.setItem(SETTING_KEY, enabled ? "on" : "off");
    } catch {
      // Private mode: lasts this session.
    }
    set({ enabled });
  }
}));

export const visualInspectorInDevelopment = process.env.NODE_ENV === "development";

interface VisualRecord {
  id: string;
  level: ObservabilityEvent["level"];
  phase: string;
  message?: string;
  source: string;
  errors: unknown[];
  parser?: { incomplete?: boolean; unresolved?: unknown[]; orphaned?: unknown[]; statementCount?: number };
  startedAt?: number;
  elapsedMs?: number;
  durationMs?: number;
  model?: string;
  updatedAt: number;
}

interface Note {
  key: string;
  level: ObservabilityEvent["level"];
  kind: string;
  message: string;
  at: number;
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as { message?: unknown; type?: unknown; code?: unknown };
    if (typeof record.message === "string") {
      const prefix = typeof record.code === "string" ? `${record.code}: ` : typeof record.type === "string" ? `${record.type}: ` : "";
      return `${prefix}${record.message}`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatMs(ms?: number): string {
  if (ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function useVisualEvents(active: boolean): { visuals: VisualRecord[]; notes: Note[]; clear(): void } {
  const [visuals, setVisuals] = useState<VisualRecord[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    if (!active) return;
    return observability.listenAll((event) => {
      const detail = event.detail;
      if (detail.kind === STREAM_KIND && typeof detail.id === "string") {
        const id = detail.id;
        setVisuals((current) => {
          const previous = current.find((item) => item.id === id);
          const next: VisualRecord = {
            id,
            level: event.level,
            phase: typeof detail.phase === "string" ? detail.phase : (previous?.phase ?? "streaming"),
            message: detail.message,
            source: typeof detail.response === "string" ? detail.response : (previous?.source ?? ""),
            errors: Array.isArray(detail.errors) ? detail.errors : (previous?.errors ?? []),
            parser: (detail.parser as VisualRecord["parser"]) ?? previous?.parser,
            startedAt: typeof detail.startedAt === "number" ? detail.startedAt : previous?.startedAt,
            elapsedMs: typeof detail.elapsedMs === "number" ? detail.elapsedMs : previous?.elapsedMs,
            durationMs: typeof detail.durationMs === "number" ? detail.durationMs : previous?.durationMs,
            model: typeof detail.model === "string" ? detail.model : previous?.model,
            updatedAt: event.timestamp
          };
          return [next, ...current.filter((item) => item.id !== id)].slice(0, MAX_VISUALS);
        });
        return;
      }
      if (event.level === "info") return;
      setNotes((current) =>
        [
          {
            key: `${event.timestamp}:${current.length}`,
            level: event.level,
            kind: detail.kind,
            message: detail.message ?? detail.error?.message ?? detail.kind,
            at: event.timestamp
          },
          ...current
        ].slice(0, MAX_NOTES)
      );
    });
  }, [active]);
  return {
    visuals,
    notes,
    clear() {
      setVisuals([]);
      setNotes([]);
    }
  };
}

/** Mounted once by the app frame; renders nothing unless enabled. */
export function VisualInspector() {
  const setting = useVisualInspectorSetting((state) => state.enabled);
  const enabled = visualInspectorInDevelopment || setting;
  const [open, setOpen] = useState(false);
  const { visuals, notes, clear } = useVisualEvents(enabled);
  const panelId = useId();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    useVisualInspectorSetting.setState({ enabled: readSetting() });
  }, []);

  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!enabled) return null;

  const problems = visuals.filter((item) => item.errors.length > 0 || item.level !== "info").length + notes.length;

  return (
    <div className="vInspector">
      {open ? (
        <section id={panelId} className="vInspectorPanel" aria-labelledby={`${panelId}-title`}>
          <header className="vInspectorHead">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="vInspectorMark" src="/brand/sibyl-mark.png" alt="" width={18} height={18} />
            <h2 id={`${panelId}-title`} ref={headingRef} tabIndex={-1}>
              Visual inspector
            </h2>
            <button type="button" className="ghostBtn vInspectorSmall" onClick={clear} disabled={!visuals.length && !notes.length}>
              Clear
            </button>
            <button
              type="button"
              className="iconBtn"
              aria-label="Close the visual inspector"
              onClick={() => {
                setOpen(false);
                launcherRef.current?.focus();
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="vInspectorBody">
            {visuals.length === 0 && notes.length === 0 ? (
              <p className="vInspectorEmpty">No visuals yet. Ask for a chart or a table; each one shows up here as it renders.</p>
            ) : null}
            {notes.length ? (
              <section className="vInspectorNotes" aria-label="Other warnings and errors">
                {notes.map((note) => (
                  <p key={note.key} className={`vInspectorNote ${note.level}`}>
                    <strong>{note.kind}</strong> {note.message}
                  </p>
                ))}
              </section>
            ) : null}
            <ol className="vInspectorList">
              {visuals.map((visual, index) => (
                <VisualEntry key={visual.id} visual={visual} number={visuals.length - index} defaultOpen={index === 0} />
              ))}
            </ol>
          </div>
        </section>
      ) : null}
      <button
        ref={launcherRef}
        type="button"
        className={`vInspectorLauncher${problems ? " hasProblems" : ""}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Visual inspector${problems ? `, ${problems} with problems` : ""}`}
        title="Visual inspector"
        onClick={() => setOpen((value) => !value)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/sibyl-mark.png" alt="" width={14} height={14} />
        <span>Visuals</span>
        {visuals.length ? <span className="vInspectorCount">{visuals.length}</span> : null}
      </button>
    </div>
  );
}

function VisualEntry({ visual, number, defaultOpen }: { visual: VisualRecord; number: number; defaultOpen: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const status = visual.errors.length
    ? `${visual.errors.length} error${visual.errors.length === 1 ? "" : "s"}`
    : visual.level === "warning"
      ? "warning"
      : visual.phase === "settled"
        ? "ok"
        : visual.phase;
  const tone = visual.errors.length || visual.level === "error" ? "error" : visual.level === "warning" ? "warning" : "ok";
  const parser = visual.parser;

  return (
    <li className="vInspectorItem">
      <button type="button" className="vInspectorItemHead" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className={`vInspectorDot ${tone}`} aria-hidden />
        <span className="vInspectorItemTitle">Visual {number}</span>
        <span className="vInspectorMeta">
          {status} · {formatMs(visual.durationMs ?? visual.elapsedMs)}
        </span>
        <Icon name="chevronDown" size={14} className={expanded ? "" : "iconRight"} />
      </button>
      {expanded ? (
        <div className="vInspectorDetail">
          <dl className="vInspectorFacts">
            <div>
              <dt>Status</dt>
              <dd>{visual.message ?? visual.phase}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{formatMs(visual.durationMs ?? visual.elapsedMs)}</dd>
            </div>
            {visual.model ? (
              <div>
                <dt>Model</dt>
                <dd>{visual.model}</dd>
              </div>
            ) : null}
            {parser?.statementCount !== undefined ? (
              <div>
                <dt>Statements</dt>
                <dd>{parser.statementCount}</dd>
              </div>
            ) : null}
          </dl>
          {visual.errors.length ? (
            <ul className="vInspectorErrors">
              {visual.errors.map((error, index) => (
                <li key={index}>{describe(error)}</li>
              ))}
            </ul>
          ) : null}
          {parser?.incomplete ? <p className="vInspectorWarn">The program was incomplete when it settled.</p> : null}
          {parser?.unresolved?.length ? (
            <p className="vInspectorWarn">Unresolved references: {parser.unresolved.map(describe).join(", ")}</p>
          ) : null}
          {parser?.orphaned?.length ? (
            <p className="vInspectorWarn">Unused statements: {parser.orphaned.map(describe).join(", ")}</p>
          ) : null}
          <div className="vInspectorSourceHead">
            <span>OpenUI Lang source</span>
            <button
              type="button"
              className="ghostBtn vInspectorSmall"
              onClick={() => {
                void navigator.clipboard?.writeText(visual.source).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                });
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="vInspectorSource">{visual.source || "(empty)"}</pre>
        </div>
      ) : null}
    </li>
  );
}
