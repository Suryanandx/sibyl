"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { SECRET_NAME_PATTERN, type SecretMetaView } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";
import { KeyIcon } from "./SecretPrompt";

export { KeyIcon as SecretsIcon };

export interface SecretUpdate {
  name: string;
  value?: string;
  service?: string;
  description?: string;
  allowedHosts?: string[];
}

interface SecretsPanelProps {
  /** null while loading. */
  secrets: SecretMetaView[] | null;
  error?: string | null;
  disabled?: boolean;
  onSave(update: SecretUpdate): void;
  onDelete(name: string): void;
}

type Mode = { kind: "list" } | { kind: "add" } | { kind: "edit"; name: string } | { kind: "replace"; name: string } | { kind: "delete"; name: string };

/**
 * Stored API keys: names, services, hosts and last use. Values are never shown.
 * The body of Settings → Secrets.
 */
export function SecretsPanel({ secrets, error, disabled = false, onSave, onDelete }: SecretsPanelProps) {
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  // Back to the list once a change lands (the gateway pushes secrets.state).
  useEffect(() => {
    if (!error) setMode({ kind: "list" });
  }, [secrets, error]);

  const done = (): void => setMode({ kind: "list" });

  return (
    <div className="secretsBody">
        {error ? (
          <p className="secretError secretsPanelError" role="alert">
            {error}
          </p>
        ) : null}

        {mode.kind === "add" ? (
          <SecretForm
            kind="add"
            disabled={disabled}
            onCancel={done}
            onSubmit={(update) => onSave(update)}
          />
        ) : null}

        {mode.kind === "list" ? (
          <div className="secretsToolbar">
            <button type="button" className="approvalBtn primary" onClick={() => setMode({ kind: "add" })} disabled={disabled}>
              <Icon name="plus" size={16} /> Add secret
            </button>
          </div>
        ) : null}

        {secrets === null ? (
          <p className="muted secretsEmpty">Loading…</p>
        ) : secrets.length === 0 && mode.kind !== "add" ? (
          <p className="muted secretsEmpty">
            No secrets yet. When a task needs a key, Sibyl will ask for it in a secure box in the chat.
          </p>
        ) : (
          <ul className="secretsList">
            {secrets.map((secret) => (
              <li key={secret.name} className="secretRow">
                <div className="secretRowMain">
                  <div className="secretRowTitle">
                    <code className="secretName">{secret.name}</code>
                    <span className="secretService">{secret.service}</span>
                    {!secret.readable ? <span className="secretWarn">Needs re-entry</span> : null}
                  </div>
                  {secret.description ? <p className="secretDesc">{secret.description}</p> : null}
                  <ul className="secretHostList" aria-label="Allowed hosts">
                    {secret.allowedHosts.map((host) => (
                      <li key={host} className="secretHost">
                        <span>{host}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="secretMeta">
                    {secret.lastUsedAt ? `Last used ${formatWhen(secret.lastUsedAt)}` : "Not used yet"} · Updated {formatWhen(secret.updatedAt)}
                  </p>
                </div>

                {mode.kind === "list" ? (
                  <div className="secretRowActions">
                    <button type="button" className="approvalBtn" disabled={disabled} onClick={() => setMode({ kind: "replace", name: secret.name })}>
                      Replace value
                    </button>
                    <button type="button" className="approvalBtn" disabled={disabled} onClick={() => setMode({ kind: "edit", name: secret.name })}>
                      Edit hosts
                    </button>
                    <button
                      type="button"
                      className="approvalBtn danger"
                      disabled={disabled}
                      onClick={() => setMode({ kind: "delete", name: secret.name })}
                      aria-label={`Delete ${secret.name}`}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}

                {mode.kind === "replace" && mode.name === secret.name ? (
                  <SecretForm kind="replace" secret={secret} disabled={disabled} onCancel={done} onSubmit={onSave} />
                ) : null}
                {mode.kind === "edit" && mode.name === secret.name ? (
                  <SecretForm kind="edit" secret={secret} disabled={disabled} onCancel={done} onSubmit={onSave} />
                ) : null}
                {mode.kind === "delete" && mode.name === secret.name ? (
                  <div className="secretConfirm" role="alertdialog" aria-label={`Delete ${secret.name}?`}>
                    <p>
                      Delete <code>{secret.name}</code>? Anything using it will stop working until you add it again.
                    </p>
                    <div className="approvalButtons">
                      <button type="button" className="approvalBtn" onClick={done} autoFocus>
                        Keep it
                      </button>
                      <button type="button" className="approvalBtn danger primary" disabled={disabled} onClick={() => onDelete(secret.name)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function SecretForm({
  kind,
  secret,
  disabled,
  onCancel,
  onSubmit
}: {
  kind: "add" | "edit" | "replace";
  secret?: SecretMetaView;
  disabled: boolean;
  onCancel(): void;
  onSubmit(update: SecretUpdate): void;
}) {
  const id = useId();
  const [name, setName] = useState(secret?.name ?? "");
  const [service, setService] = useState(secret?.service ?? "");
  const [description, setDescription] = useState(secret?.description ?? "");
  const [hosts, setHosts] = useState((secret?.allowedHosts ?? []).join(", "));
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const showMeta = kind !== "replace";
  const showValue = kind !== "edit";

  function submit(event: FormEvent): void {
    event.preventDefault();
    const hostList = hosts.split(/[\s,]+/).map((host) => host.trim()).filter(Boolean);
    if (kind === "add" && !SECRET_NAME_PATTERN.test(name)) {
      setProblem("Use an UPPER_SNAKE_CASE name, e.g. SHOPIFY_TOKEN.");
      return;
    }
    if (showMeta && (hostList.length === 0 || hostList.length > 10)) {
      setProblem("List 1–10 hosts the key may be sent to.");
      return;
    }
    if (showValue && !value.trim()) {
      setProblem("Paste the key.");
      return;
    }
    setProblem(null);
    onSubmit({
      name: secret?.name ?? name,
      ...(showValue ? { value } : {}),
      ...(showMeta ? { allowedHosts: hostList, description: description.trim() } : {}),
      ...(kind === "add" ? { service: service.trim() || name } : {})
    });
    setValue("");
    setReveal(false);
  }

  return (
    <form className="secretForm secretPanelForm" onSubmit={submit} autoComplete="off">
      {kind === "add" ? (
        <div className="secretFormGrid">
          <div className="secretField">
            <label className="secretLabel" htmlFor={`${id}-name`}>
              Name
            </label>
            <input
              id={`${id}-name`}
              className="secretInput mono"
              value={name}
              onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
              placeholder="SHOPIFY_TOKEN"
              maxLength={64}
              spellCheck={false}
              autoFocus
            />
          </div>
          <div className="secretField">
            <label className="secretLabel" htmlFor={`${id}-service`}>
              Service
            </label>
            <input id={`${id}-service`} className="secretInput" value={service} onChange={(event) => setService(event.target.value)} placeholder="Shopify" maxLength={80} />
          </div>
        </div>
      ) : null}

      {showMeta ? (
        <>
          <div className="secretField">
            <label className="secretLabel" htmlFor={`${id}-hosts`}>
              Only sent to
            </label>
            <input
              id={`${id}-hosts`}
              className="secretInput"
              value={hosts}
              onChange={(event) => setHosts(event.target.value)}
              placeholder="api.example.com, *.myshopify.com, local"
              spellCheck={false}
              autoFocus={kind === "edit"}
              aria-describedby={`${id}-hosts-hint`}
            />
            <span className="fieldHint" id={`${id}-hosts-hint`}>
              Exact hosts or *.domain for subdomains. &ldquo;local&rdquo; lets local MCP servers read it from their environment.
            </span>
          </div>
          <div className="secretField">
            <label className="secretLabel" htmlFor={`${id}-desc`}>
              Description
            </label>
            <input id={`${id}-desc`} className="secretInput" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
          </div>
        </>
      ) : null}

      {showValue ? (
        <div className="secretField">
          <label className="secretLabel" htmlFor={`${id}-value`}>
            {kind === "replace" ? `New value for ${secret?.name}` : "Value"}
          </label>
          <div className="secretInputRow">
            <input
              id={`${id}-value`}
              className="secretInput"
              type={reveal ? "text" : "password"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              autoFocus={kind === "replace"}
              placeholder="Paste the key"
            />
            <button type="button" className="secretReveal" onClick={() => setReveal((shown) => !shown)} aria-pressed={reveal} aria-controls={`${id}-value`}>
              {reveal ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      ) : null}

      {problem ? (
        <p className="secretError" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="approvalButtons secretButtons">
        <button type="button" className="approvalBtn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="approvalBtn primary" disabled={disabled}>
          {kind === "add" ? "Save secret" : kind === "replace" ? "Replace" : "Save"}
        </button>
      </div>
    </form>
  );
}

function formatWhen(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString();
}
