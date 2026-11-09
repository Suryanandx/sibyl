"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { SecretRequestView } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";

export type SecretPromptStatus = "pending" | "saved" | "cancelled" | "expired";

interface SecretPromptProps {
  request: SecretRequestView;
  status: SecretPromptStatus;
  /** True after Save, until the gateway answers. */
  submitting?: boolean;
  /** Why the last save was rejected (the box stays open). */
  error?: string;
  /** Hosts the key was saved for (after saving). */
  savedHosts?: string[];
  /** Omitted when read-only. The value goes straight to the gateway, never into chat. */
  onSave?: (value: string, allowedHosts: string[]) => void;
  onCancel?: () => void;
}

const RESOLVED_LABEL: Record<Exclude<SecretPromptStatus, "pending">, string> = {
  saved: "Saved securely",
  cancelled: "Cancelled — nothing was saved",
  expired: "Expired — nothing was saved"
};

/** Lock glyph (the shared Icon set has none). */
export function KeyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 9.5a4.5 4.5 0 1 0-3.2 4.3L13 15.5h2v2h2v2h3v-3l-5.8-5.8a4.5 4.5 0 0 0 .3-1.2Z" />
      <circle cx="9.5" cy="9" r="1.2" />
    </svg>
  );
}

/**
 * The secure box the assistant opens when an integration needs a key.
 * The value lives only in this component until Save, is sent once over the
 * socket and is then cleared; it never becomes a chat message.
 */
export function SecretPrompt({ request, status, submitting = false, error, savedHosts, onSave, onCancel }: SecretPromptProps) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [hosts, setHosts] = useState<string[]>(request.allowedHosts);
  const [newHost, setNewHost] = useState("");
  const titleId = useId();
  const inputId = useId();
  const hostInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = status === "pending";
  const interactive = pending && Boolean(onSave) && !submitting;

  useEffect(() => {
    if (pending && onSave) inputRef.current?.focus({ preventScroll: true });
    // Only when the box first appears.
  }, []);

  useEffect(() => {
    // Drop the value from memory as soon as the gateway has it.
    if (!pending) {
      setValue("");
      setReveal(false);
    }
  }, [pending]);

  function save(event: FormEvent): void {
    event.preventDefault();
    if (!interactive || !value.trim() || hosts.length === 0 || !onSave) return;
    onSave(value, hosts);
    setValue("");
    setReveal(false);
  }

  function addHost(): void {
    const host = newHost.trim().toLowerCase();
    if (!host || hosts.includes(host) || hosts.length >= 10) return;
    setHosts([...hosts, host]);
    setNewHost("");
  }

  function onHostKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      addHost();
    }
  }

  const shownHosts = status === "saved" && savedHosts ? savedHosts : hosts;

  return (
    <section className={`secretPrompt ${status}`} role="group" aria-labelledby={titleId}>
      <div className="secretHead">
        <span className="secretBadge" aria-hidden>
          <KeyIcon size={16} />
        </span>
        <div>
          <span className="secretEyebrow">{pending ? (request.replace ? "Replace a key" : "Secure key request") : "Key request"}</span>
          <h3 className="secretTitle" id={titleId}>
            Connect {request.service}
          </h3>
        </div>
      </div>

      <p className="secretWhy">{request.description}</p>

      {pending && (request.howToGet || request.docsUrl) ? (
        <div className="secretHow">
          {request.howToGet ? <p>{request.howToGet}</p> : null}
          {request.docsUrl ? (
            <a href={request.docsUrl} target="_blank" rel="noopener noreferrer">
              Get your {request.service} key ↗
            </a>
          ) : null}
        </div>
      ) : null}

      {pending && onSave ? (
        <form className="secretForm" onSubmit={save} autoComplete="off">
          <div className="secretField">
            <label className="secretLabel" htmlFor={inputId}>
              {request.name}
            </label>
            <div className="secretInputRow">
              <input
                ref={inputRef}
                id={inputId}
                className="secretInput"
                type={reveal ? "text" : "password"}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                disabled={!interactive}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                placeholder="Paste the key"
                aria-describedby={error ? `${inputId}-error` : undefined}
              />
              <button
                type="button"
                className="secretReveal"
                onClick={() => setReveal((shown) => !shown)}
                aria-pressed={reveal}
                aria-controls={inputId}
                disabled={!interactive}
              >
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <fieldset className="secretHosts">
            <legend className="secretLabel">Only sent to</legend>
            <ul className="secretHostList">
              {hosts.map((host) => (
                <li key={host} className="secretHost">
                  <span>{host}</span>
                  <button
                    type="button"
                    className="secretHostRemove"
                    aria-label={`Remove ${host}`}
                    disabled={!interactive || hosts.length === 1}
                    onClick={() => setHosts(hosts.filter((item) => item !== host))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="secretHostAdd">
              <label className="secretSrOnly" htmlFor={hostInputId}>
                Add a host
              </label>
              <input
                id={hostInputId}
                className="secretInput small"
                value={newHost}
                onChange={(event) => setNewHost(event.target.value)}
                onKeyDown={onHostKey}
                placeholder="api.example.com or *.example.com"
                disabled={!interactive}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="approvalBtn" onClick={addHost} disabled={!interactive || !newHost.trim()}>
                Add
              </button>
            </div>
          </fieldset>

          {error ? (
            <p className="secretError" id={`${inputId}-error`} role="alert">
              {error}
            </p>
          ) : null}

          <p className="secretNote">Encrypted on your Sibyl server. The assistant never sees it.</p>

          <div className="approvalButtons secretButtons">
            <button type="button" className="approvalBtn" disabled={submitting} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="approvalBtn primary" disabled={!interactive || !value.trim() || hosts.length === 0} aria-busy={submitting}>
              {submitting ? <span className="spinner" aria-hidden /> : null}
              Save key
            </button>
          </div>
        </form>
      ) : (
        <p className="secretHostsLine">
          <span className="secretLabel">{status === "saved" ? "Allowed for" : "Would be sent to"}</span>{" "}
          {shownHosts.join(", ")}
        </p>
      )}

      <p className="approvalStatus" role="status" aria-live="polite">
        {pending ? null : (
          <>
            <Icon name={status === "saved" ? "check" : "close"} size={14} className={`approvalStatusIcon ${status === "saved" ? "approved" : "expired"}`} />
            {RESOLVED_LABEL[status]}
          </>
        )}
      </p>
    </section>
  );
}
