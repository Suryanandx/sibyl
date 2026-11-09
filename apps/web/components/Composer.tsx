"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ModelCatalog, ModelPreset, SessionSettings } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";
import { VoiceWave } from "./VoiceWave";
import { VOICE_LABELS, type VoiceState } from "./voice-state";
import { ATTACHMENT_ACCEPT, type ComposerAttachment } from "./AttachmentClient";
import { AttachmentIcon, AttachmentTray } from "./AttachmentChips";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  canSend: boolean;
  /** Sibyl is busy: sending adds the message to the queue instead. */
  willQueue: boolean;
  connected: boolean;
  responding: boolean;
  voiceState: VoiceState;
  level: number;
  liveMode: boolean;
  pushToTalk: boolean;
  onToggleVoice: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onStop: () => void;
  catalog: ModelCatalog | null;
  settings: SessionSettings | null;
  activePresetId: string | null;
  onChangeSettings: (patch: Partial<SessionSettings>) => void;
  onOpenSettings: () => void;
  /** Spend in this session (USAGE_UPDATE), shown in the model menu. */
  sessionUsd?: number;
  economyMode?: boolean;
  onOpenUsage?: () => void;
  /** Files attached to the next message (uploading or ready). */
  attachments?: ComposerAttachment[];
  /** Attach button, drag-and-drop and pasted images. */
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (localId: string) => void;
}

const HOLD_DELAY_MS = 320;

/**
 * Two-row composer: message on top; model pill on the left; round voice and
 * send buttons on the right. Tap the voice button for hands-free
 * conversation, press and hold it to talk once.
 */
export function Composer(props: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const holdTimer = useRef<number | null>(null);
  const holding = useRef(false);
  const [dragging, setDragging] = useState(false);
  const canAttach = Boolean(props.onAddFiles);
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
    input.style.overflowY = input.scrollHeight > 168 ? "auto" : "hidden";
  }, [props.value]);

  const voiceActive = props.liveMode || props.pushToTalk;
  const activePreset = props.catalog?.presets?.find((preset) => preset.id === props.activePresetId);
  const voiceModel = props.catalog?.voice?.find((model) => model.id === props.settings?.voiceModel);

  const pressStart = () => {
    if (props.liveMode || !props.connected) return;
    holding.current = false;
    holdTimer.current = window.setTimeout(() => {
      holding.current = true;
      props.onHoldStart();
    }, HOLD_DELAY_MS);
  };
  const pressEnd = (cancelled = false) => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holding.current) {
      holding.current = false;
      props.onHoldEnd();
      return;
    }
    if (!cancelled) props.onToggleVoice();
  };

  return (
    <div className={`composer${voiceActive ? " voiceOn" : ""}`}>
      <form
        className={`composerCard${dragging ? " dragging" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
        onDragOver={(event) => {
          if (!canAttach || !hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!canAttach || !hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          const files = Array.from(event.dataTransfer.files);
          if (files.length) props.onAddFiles?.(files);
        }}
      >
        {dragging ? <div className="attachmentDrop" aria-hidden>Drop files to attach</div> : null}
        <AttachmentTray items={props.attachments ?? []} onRemove={(id) => props.onRemoveAttachment?.(id)} />
        {voiceActive ? (
          <div className="voiceRow" aria-live="polite">
            <VoiceWave state={props.voiceState} level={props.level} />
            <span className="voiceLabel">{VOICE_LABELS[props.voiceState]}</span>
            <span className="voiceHint">
              {props.pushToTalk
                ? "Release to send"
                : props.voiceState === "speaking"
                  ? "Start talking to interrupt"
                  : "Talk naturally — pauses are fine"}
            </span>
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="composerInput"
          rows={1}
          aria-label="Message Sibyl"
          placeholder={props.liveMode ? "Or type a message…" : "Ask Sibyl anything…"}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onPaste={(event) => {
            if (!canAttach) return;
            const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
            if (files.length === 0) return;
            // Pasting a screenshot attaches it; pasted text still goes in the box.
            if (!event.clipboardData.getData("text/plain")) event.preventDefault();
            props.onAddFiles?.(files);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />

        <div className="composerBar">
          {canAttach ? (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="attachmentInput"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  if (files.length) props.onAddFiles?.(files);
                }}
              />
              <button
                type="button"
                className="roundBtn attachBtn"
                aria-label="Attach files"
                title="Attach images, PDFs, documents or data"
                disabled={!props.connected}
                onClick={() => fileRef.current?.click()}
              >
                <AttachmentIcon size={18} />
              </button>
            </>
          ) : null}
          <ModelMenu
            catalog={props.catalog}
            settings={props.settings}
            activePreset={activePreset}
            label={activePreset?.label ?? voiceModel?.label ?? "Models"}
            onChange={props.onChangeSettings}
            onOpenSettings={props.onOpenSettings}
            sessionUsd={props.sessionUsd}
            economyMode={props.economyMode}
            onOpenUsage={props.onOpenUsage}
          />

          <div className="composerActions">
            <button
              type="button"
              className={`roundBtn voiceBtn${props.liveMode ? " on" : ""}${props.pushToTalk ? " holding" : ""}`}
              aria-pressed={props.liveMode}
              aria-label={props.liveMode ? "End voice conversation" : "Talk to Sibyl (hold to talk once)"}
              title={props.liveMode ? "End voice" : "Tap for hands-free · hold to talk"}
              disabled={!props.connected || (props.responding && !props.liveMode && !props.pushToTalk)}
              onPointerDown={(event) => {
                event.preventDefault();
                pressStart();
              }}
              onPointerUp={(event) => {
                event.preventDefault();
                pressEnd();
              }}
              onPointerLeave={() => {
                if (holdTimer.current !== null || holding.current) pressEnd(true);
              }}
              onPointerCancel={() => pressEnd(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onToggleVoice();
                }
              }}
            >
              {voiceActive ? (
                <VoiceWave state={props.voiceState} level={props.level} />
              ) : (
                <span className="staticWave" aria-hidden>
                  <i /><i /><i /><i /><i />
                </span>
              )}
            </button>
            {props.responding && props.canSend ? (
              <button type="button" className="roundBtn" onClick={props.onStop} aria-label="Stop the reply" title="Stop the reply">
                <Icon name="stop" size={15} />
              </button>
            ) : null}
            {props.responding && !props.canSend ? (
              <button type="button" className="roundBtn primary" onClick={props.onStop} aria-label="Stop the reply" title="Stop the reply">
                <Icon name="stop" size={16} />
              </button>
            ) : (
              <button
                type="submit"
                className={`roundBtn primary${props.willQueue ? " queueMode" : ""}`}
                disabled={!props.canSend}
                aria-label={props.willQueue ? "Add to queue" : "Send"}
                title={props.willQueue ? "Add to queue — sends when Sibyl finishes" : "Send"}
              >
                <Icon name={props.willQueue ? "plus" : "arrowUp"} size={17} />
              </button>
            )}
          </div>
        </div>
      </form>
      <p className="disclaimer">Sibyl can make mistakes. Double-check important answers.</p>
    </div>
  );
}

function formatSessionSpend(value: number): string {
  if (value === 0) return "$0.00";
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function monogram(id: string): string {
  const vendor = id.split("/")[0] ?? id;
  return vendor.slice(0, 1).toUpperCase();
}

function speed(ms?: number): string | null {
  return ms === undefined ? null : `${(ms / 1000).toFixed(1)}s`;
}

/** Search + presets + voice brains, in a compact popover. */
function ModelMenu(props: {
  catalog: ModelCatalog | null;
  settings: SessionSettings | null;
  activePreset?: ModelPreset;
  label: string;
  onChange: (patch: Partial<SessionSettings>) => void;
  onOpenSettings: () => void;
  sessionUsd?: number;
  economyMode?: boolean;
  onOpenUsage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const presets = (props.catalog?.presets ?? []).filter((preset) => matches(preset.label));
  const voices = (props.catalog?.voice ?? []).filter((model) => matches(`${model.label} ${model.id}`));
  const brains = needle ? (props.catalog?.llm ?? []).filter((model) => matches(`${model.label} ${model.id}`)) : [];

  return (
    <div className="modelMenu" ref={rootRef}>
      <button
        type="button"
        className="modelPill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="modelPillIcon" aria-hidden>
          <Icon name="sparkle" size={14} />
        </span>
        <span className="modelPillLabel">{props.label}</span>
        {props.activePreset ? <span className="badge">Auto</span> : null}
        <Icon name="chevronDown" size={14} />
      </button>

      {open ? (
        <div className="popover" role="menu">
          <input
            className="popoverSearch"
            autoFocus
            placeholder="Search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {presets.length ? (
            <>
              <p className="popoverSection">Auto-picked presets</p>
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={preset.id === props.activePreset?.id}
                  className={`popoverItem${preset.id === props.activePreset?.id ? " selected" : ""}`}
                  onClick={() => {
                    props.onChange(preset.settings);
                    setOpen(false);
                  }}
                >
                  <span className="monogram preset">{preset.label[0]}</span>
                  <span className="popoverLabel">{preset.label}</span>
                  {preset.costPer100Turns !== undefined ? (
                    <span className="badge subtle">${preset.costPer100Turns.toFixed(2)}/100</span>
                  ) : null}
                  {preset.id === props.activePreset?.id ? <Icon name="check" size={16} className="popoverCheck" /> : null}
                </button>
              ))}
            </>
          ) : null}

          {voices.length ? (
            <>
              <p className="popoverSection">Voice brain</p>
              {voices.slice(0, needle ? 12 : 5).map((model) => {
                const selected = model.id === props.settings?.voiceModel;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`popoverItem${selected ? " selected" : ""}`}
                    onClick={() => {
                      props.onChange({ voiceModel: model.id });
                      setOpen(false);
                    }}
                    title={model.id}
                  >
                    <span className="monogram">{monogram(model.id)}</span>
                    <span className="popoverLabel">{model.label}</span>
                    {speed(model.latencyMs) ? <span className="badge subtle">{speed(model.latencyMs)}</span> : null}
                    {selected ? <Icon name="check" size={16} className="popoverCheck" /> : null}
                  </button>
                );
              })}
            </>
          ) : null}

          {brains.length ? (
            <>
              <p className="popoverSection">Deep work</p>
              {brains.slice(0, 8).map((model) => {
                const selected = model.id === props.settings?.llmModel;
                return (
                  <button
                    key={model.id}
                    type="button"
                    className={`popoverItem${selected ? " selected" : ""}`}
                    onClick={() => {
                      props.onChange({ llmModel: model.id });
                      setOpen(false);
                    }}
                  >
                    <span className="monogram">{monogram(model.id)}</span>
                    <span className="popoverLabel">{model.label}</span>
                    {selected ? <Icon name="check" size={16} className="popoverCheck" /> : null}
                  </button>
                );
              })}
            </>
          ) : null}

          {!presets.length && !voices.length && !brains.length ? (
            <p className="popoverEmpty">No models match “{query}”.</p>
          ) : null}

          <div className="popoverDivider" />
          <button
            type="button"
            className="popoverItem"
            onClick={() => {
              setOpen(false);
              props.onOpenSettings();
            }}
          >
            <span className="monogram ghost">
              <Icon name="sliders" size={14} />
            </span>
            <span className="popoverLabel">All models &amp; voice settings</span>
            <span className="popoverChevron" aria-hidden>›</span>
          </button>
          {props.sessionUsd !== undefined && props.onOpenUsage ? (
            <button
              type="button"
              className="popoverItem usageSpend"
              title="Usage & budgets"
              onClick={() => {
                setOpen(false);
                props.onOpenUsage?.();
              }}
            >
              <span className="popoverLabel">This session</span>
              {props.economyMode ? <span className="badge subtle">Economy</span> : null}
              <span className="usageAmount">{formatSessionSpend(props.sessionUsd)}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
