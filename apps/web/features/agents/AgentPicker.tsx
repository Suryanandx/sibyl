"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { AgentView } from "@open-gpt-live/protocol";
import { AgentAvatar } from "./AgentAvatar";
import styles from "./agents.module.css";

/**
 * Composer chip: "Ask Sibyl ▾" → choose who answers (Sibyl or one of your
 * agents). Keyboard: Enter/Space/↓ opens, ↑/↓ moves, Enter picks, Esc closes.
 */
export function AgentPicker({
  agents,
  selectedAgentId,
  onSelect,
  onManage,
  disabled
}: {
  agents: AgentView[];
  selectedAgentId: string | undefined;
  onSelect(agentId: string | null): void;
  /** "Manage agents…" (opens the Agents screen). */
  onManage?(): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [dropDown, setDropDown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = agents.find((agent) => agent.id === selectedAgentId);
  const options: Array<AgentView | null> = [null, ...agents];

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Open upwards (composer at the bottom) unless there is no room above.
    setDropDown((rootRef.current?.getBoundingClientRect().top ?? 400) < 360);
    setActive(Math.max(0, options.findIndex((o) => (o?.id ?? undefined) === selectedAgentId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (option: AgentView | null) => {
    onSelect(option?.id ?? null);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(options[active] ?? null);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={styles.picker} ref={rootRef}>
      <button
        type="button"
        className={styles.pickerChip}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        {selected ? <AgentAvatar avatar={selected.avatar} size={20} /> : <span className={styles.sibylMark} aria-hidden />}
        <span className={styles.pickerLabel}>Ask {selected ? selected.name : "Sibyl"}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M6 9.5l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className={dropDown ? `${styles.pickerMenu} ${styles.down}` : styles.pickerMenu}>
          <ul id={listId} role="listbox" aria-label="Who answers" tabIndex={-1}>
            {options.map((option, index) => {
              const isSelected = (option?.id ?? undefined) === selectedAgentId;
              return (
                <li
                  key={option?.id ?? "sibyl"}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  className={index === active ? `${styles.pickerOption} ${styles.active}` : styles.pickerOption}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                >
                  {option ? <AgentAvatar avatar={option.avatar} size={28} mood={index === active ? "happy" : "idle"} /> : <span className={`${styles.sibylMark} ${styles.large}`} aria-hidden />}
                  <span className={styles.pickerText}>
                    <strong>{option ? option.name : "Sibyl"}</strong>
                    <small>{option ? option.description || "Your agent" : "Your assistant, with everything you've set up"}</small>
                  </span>
                  {isSelected ? (
                    <svg className={styles.pickerCheck} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {onManage ? (
            <button
              type="button"
              className={styles.pickerManage}
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              {agents.length ? "Manage agents…" : "Create an agent…"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
