"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  CONNECTIONS_EVENTS,
  createRequestId,
  type ConnectionCatalogEntry,
  type ConnectionCatalogField,
  type ConnectionServerInput,
  type ConnectionServerView,
  type ConnectionToolView,
  type ConnectionsClientMessage,
  type ConnectionsServerMessage,
  type ConnectionsState,
  type ConnectionsTestResultMessage
} from "@open-gpt-live/protocol";
import { Icon } from "./Icon";

export type ConnectionsListener = (message: ConnectionsServerMessage) => void;

interface ConnectionsPanelProps {
  /** The socket is open. */
  connected: boolean;
  send: (message: ConnectionsClientMessage) => boolean;
  /** Receive connections.* messages; returns an unsubscribe. */
  subscribe: (listener: ConnectionsListener) => () => void;
}

/**
 * Custom connectors: built-in tools, MCP servers, and adding new data sources
 * and tools. The body of Integrations → Custom connectors (MCP).
 */
export function ConnectionsPanel(props: ConnectionsPanelProps) {
  const { connected, send, subscribe } = props;
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, ConnectionsTestResultMessage | "pending">>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const pending = useRef(new Map<string, { label: string; key: string; onOk?: () => void }>());
  const testTargets = useRef(new Map<string, string>());
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    return subscribe((message) => {
      if (message.type === CONNECTIONS_EVENTS.STATE) {
        setState(message);
        return;
      }
      if (message.type === CONNECTIONS_EVENTS.RESULT) {
        const action = pending.current.get(message.requestId);
        if (!action) return;
        pending.current.delete(message.requestId);
        setBusy((current) => omit(current, action.key));
        if (message.ok) {
          setNotice({ kind: "ok", text: action.label });
          action.onOk?.();
        } else {
          setNotice({ kind: "error", text: message.error ?? "That didn't work." });
        }
        return;
      }
      const target = testTargets.current.get(message.requestId);
      if (!target) return;
      testTargets.current.delete(message.requestId);
      setTests((current) => ({ ...current, [target]: message }));
    });
  }, [subscribe]);

  useEffect(() => {
    if (connected) sendRef.current({ type: CONNECTIONS_EVENTS.REQUEST });
  }, [connected]);

  const act = (key: string, label: string, build: (requestId: string) => ConnectionsClientMessage, onOk?: () => void) => {
    const requestId = createRequestId();
    pending.current.set(requestId, { label, key, onOk });
    setBusy((current) => ({ ...current, [key]: label }));
    setNotice(null);
    if (!send(build(requestId))) {
      pending.current.delete(requestId);
      setBusy((current) => omit(current, key));
      setNotice({ kind: "error", text: "Not connected to the gateway." });
    }
  };

  const runTest = (target: string, message: Omit<Extract<ConnectionsClientMessage, { type: "connections.server_test" }>, "type" | "requestId">) => {
    const requestId = createRequestId();
    testTargets.current.set(requestId, target);
    setTests((current) => ({ ...current, [target]: "pending" }));
    send({ type: CONNECTIONS_EVENTS.SERVER_TEST, requestId, ...message });
  };

  const toggleTool = (name: string, enabled: boolean) => send({ type: CONNECTIONS_EVENTS.TOOL_TOGGLE, name, enabled });
  const disabled = !connected;

  return (
    <div className="connBody">
        {notice ? (
          <p className={`connNotice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        ) : null}

        {!state ? (
          <p className="muted center">{connected ? "Loading connections…" : "Waiting for Sibyl to connect…"}</p>
        ) : form ? (
          <ServerForm
            form={form}
            allowStdio={state.allowStdio}
            disabled={disabled}
            busy={Boolean(busy.form)}
            test={tests.form}
            onChange={setForm}
            onCancel={() => setForm(null)}
            onTest={(input) => runTest("form", { server: input, ...(form.original ? { original: form.original } : {}) })}
            onSave={(input) =>
              act(
                "form",
                form.original ? `Saved ${input.name}.` : `Added ${input.name}.`,
                (requestId) => ({
                  type: CONNECTIONS_EVENTS.SERVER_SAVE,
                  requestId,
                  server: input,
                  ...(form.original ? { original: form.original } : {})
                }),
                () => {
                  setForm(null);
                  setTests((current) => omit(current, "form"));
                }
              )
            }
          />
        ) : (
          <div className="connSections">
            {state.configError ? (
              <p className="connNotice error" role="alert">
                mcp.config.json could not be read: {state.configError}
              </p>
            ) : null}

            <BuiltinSection tools={state.builtin} disabled={disabled} onToggleTool={toggleTool} onToggleAll={(enabled) =>
              send({ type: CONNECTIONS_EVENTS.SERVER_TOGGLE, scope: "builtin", enabled })
            } />

            <section className="connSection" aria-labelledby="conn-servers">
              <div className="connSectionHead">
                <h3 id="conn-servers">Connected servers</h3>
                <button type="button" className="ghostBtn" disabled={disabled} onClick={() => setForm(emptyForm(state.allowStdio))}>
                  <Icon name="plus" size={16} /> Custom server
                </button>
              </div>
              {state.servers.length === 0 ? (
                <div className="connEmpty">
                  <p>
                    <strong>No servers connected yet.</strong> MCP servers give Sibyl new tools: query a database, search
                    your drive, open GitHub issues, read Slack threads. Pick one below or add your own.
                  </p>
                  <p className="muted small">
                    Tools that only read run on their own; anything that changes something asks for your approval first.
                  </p>
                </div>
              ) : (
                <ul className="connServerList">
                  {state.servers.map((server) => (
                    <ServerCard
                      key={server.name}
                      server={server}
                      disabled={disabled}
                      busy={busy[`server:${server.name}`]}
                      test={tests[`server:${server.name}`]}
                      onToggle={(enabled) =>
                        send({ type: CONNECTIONS_EVENTS.SERVER_TOGGLE, scope: "server", name: server.name, enabled })
                      }
                      onToggleTool={toggleTool}
                      onTest={() => runTest(`server:${server.name}`, { name: server.name })}
                      onReconnect={() =>
                        act(`server:${server.name}`, `Reconnected ${server.name}.`, (requestId) => ({
                          type: CONNECTIONS_EVENTS.SERVER_RECONNECT,
                          requestId,
                          name: server.name
                        }))
                      }
                      onEdit={() => setForm(formFromServer(server, state.catalog))}
                      onRemove={() => {
                        if (!window.confirm(`Remove ${server.name}? Its tools will no longer be available.`)) return;
                        act(`server:${server.name}`, `Removed ${server.name}.`, (requestId) => ({
                          type: CONNECTIONS_EVENTS.SERVER_REMOVE,
                          requestId,
                          name: server.name
                        }));
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="connSection" aria-labelledby="conn-add">
              <div className="connSectionHead">
                <h3 id="conn-add">Add a connection</h3>
              </div>
              {!state.allowStdio ? (
                <p className="connHint">
                  Local servers (they run a command on the gateway host) can only be added here when the gateway sets{" "}
                  <code>SIBYL_ALLOW_STDIO_MCP=true</code>. Remote servers over HTTPS always work, and you can still list
                  local ones in <code>mcp.config.json</code>.
                </p>
              ) : (
                <p className="connHint">
                  Local servers run as programs on the gateway host with its permissions. Add only servers you trust.
                </p>
              )}
              <div className="connCatalog">
                {[...state.catalog]
                  // Entries this gateway can add come first.
                  .sort((a, b) => Number(a.transport === "stdio" && !state.allowStdio) - Number(b.transport === "stdio" && !state.allowStdio))
                  .map((entry) => (
                  <CatalogCard
                    key={entry.id}
                    entry={entry}
                    blocked={entry.transport === "stdio" && !state.allowStdio}
                    added={state.servers.some((server) => server.catalogId === entry.id)}
                    disabled={disabled}
                    onAdd={() => setForm(formFromCatalog(entry, state.servers))}
                  />
                ))}
              </div>
            </section>
          </div>
        )}
    </div>
  );
}

// ── sections ──

function BuiltinSection(props: {
  tools: ConnectionToolView[];
  disabled: boolean;
  onToggleTool: (name: string, enabled: boolean) => void;
  onToggleAll: (enabled: boolean) => void;
}) {
  const anyOn = props.tools.some((tool) => tool.enabled);
  return (
    <section className="connSection" aria-labelledby="conn-builtin">
      <div className="connSectionHead">
        <h3 id="conn-builtin">Built-in tools</h3>
        {props.tools.length ? (
          <Switch label="All built-in tools" checked={anyOn} disabled={props.disabled} onChange={props.onToggleAll} />
        ) : null}
      </div>
      {props.tools.length === 0 ? (
        <p className="muted small">Built-in tools are off on this gateway (SIBYL_BUILTIN_TOOLS=false).</p>
      ) : (
        <ToolList tools={props.tools} disabled={props.disabled} onToggle={props.onToggleTool} />
      )}
    </section>
  );
}

function ToolList(props: { tools: ConnectionToolView[]; disabled: boolean; onToggle: (name: string, enabled: boolean) => void }) {
  return (
    <ul className="connTools">
      {props.tools.map((tool) => (
        <li key={tool.name} className="connTool">
          <div className="connToolText">
            <span className="connToolTitle">
              {tool.title}
              {tool.effect === "write" ? <span className="badge connApproval">Needs approval</span> : null}
            </span>
            <span className="connToolDesc" title={tool.description}>
              {tool.description}
            </span>
          </div>
          <Switch label={`${tool.title} (${tool.name})`} checked={tool.enabled} disabled={props.disabled} onChange={(on) => props.onToggle(tool.name, on)} />
        </li>
      ))}
    </ul>
  );
}

const STATUS_LABEL: Record<ConnectionServerView["status"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  failed: "Failed",
  disabled: "Off"
};

function ServerCard(props: {
  server: ConnectionServerView;
  disabled: boolean;
  busy?: string;
  test?: ConnectionsTestResultMessage | "pending";
  onToggle: (enabled: boolean) => void;
  onToggleTool: (name: string, enabled: boolean) => void;
  onTest: () => void;
  onReconnect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { server } = props;
  const [expanded, setExpanded] = useState(false);
  const toolsId = useId();
  const target = server.transport === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ");
  return (
    <li className="connServer">
      <div className="connServerHead">
        <span className={`connDot ${server.status}`} aria-hidden />
        <div className="connServerTitle">
          <span className="connServerName">{server.name}</span>
          <span className="connServerMeta">
            {STATUS_LABEL[server.status]}
            {server.status === "connected" ? ` · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}` : ""}
            {` · ${server.transport === "http" ? "Remote" : "Local"}`}
            {server.origin === "file" ? <span className="badge connOrigin">from mcp.config.json</span> : null}
          </span>
        </div>
        <Switch label={`Use ${server.name}`} checked={server.enabled} disabled={props.disabled} onChange={props.onToggle} />
      </div>
      <p className="connServerTarget" title={target}>
        {target}
      </p>
      {server.error ? (
        <details className="connError">
          <summary>What went wrong</summary>
          <p>{server.error}</p>
        </details>
      ) : null}
      <div className="connActions">
        <button type="button" className="ghostBtn" disabled={props.disabled || props.test === "pending"} onClick={props.onTest}>
          {props.test === "pending" ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          className="ghostBtn"
          disabled={props.disabled || !server.enabled || Boolean(props.busy)}
          onClick={props.onReconnect}
        >
          {props.busy ? "Working…" : "Reconnect"}
        </button>
        {server.origin === "ui" ? (
          <>
            <button type="button" className="ghostBtn" disabled={props.disabled} onClick={props.onEdit}>
              <Icon name="pencil" size={15} /> Edit
            </button>
            <button type="button" className="ghostBtn connDanger" disabled={props.disabled || Boolean(props.busy)} onClick={props.onRemove}>
              Remove
            </button>
          </>
        ) : null}
        {server.tools.length ? (
          <button
            type="button"
            className="ghostBtn connExpand"
            aria-expanded={expanded}
            aria-controls={toolsId}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Hide tools" : "Show tools"}
            <Icon name="chevronDown" size={15} className={expanded ? "connFlip" : undefined} />
          </button>
        ) : null}
      </div>
      <TestOutcome test={props.test} />
      {expanded ? (
        <div id={toolsId}>
          <ToolList tools={server.tools} disabled={props.disabled} onToggle={props.onToggleTool} />
        </div>
      ) : null}
    </li>
  );
}

function TestOutcome({ test }: { test?: ConnectionsTestResultMessage | "pending" }) {
  if (!test || test === "pending") return null;
  return (
    <p className={`connTest ${test.ok ? "ok" : "error"}`} role="status">
      {test.ok
        ? `Works: ${test.toolCount ?? 0} tool${test.toolCount === 1 ? "" : "s"}${test.tools?.length ? ` (${test.tools.slice(0, 6).join(", ")}${test.tools.length > 6 ? ", …" : ""})` : ""}${typeof test.ms === "number" ? ` · ${test.ms} ms` : ""}.`
        : `Couldn't connect: ${test.error ?? "unknown error"}`}
    </p>
  );
}

function CatalogCard(props: {
  entry: ConnectionCatalogEntry;
  blocked: boolean;
  added: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  const { entry } = props;
  return (
    <article className="connCard">
      <div className="connCardHead">
        <h4>{entry.title}</h4>
        <span className="badge">{entry.category}</span>
      </div>
      <p className="connCardDesc">{entry.description}</p>
      <p className="connCardMeta">
        {entry.maintainer}
        {entry.status === "archived" ? <span className="badge connArchived">Archived</span> : null}
        {" · "}
        {entry.transport === "http" ? "Remote" : "Local"}
      </p>
      <div className="connCardActions">
        <button
          type="button"
          className="darkBtn"
          disabled={props.disabled || props.blocked}
          title={props.blocked ? "Needs SIBYL_ALLOW_STDIO_MCP=true on the gateway" : undefined}
          onClick={props.onAdd}
        >
          {props.added ? "Add another" : "Add"}
        </button>
        <a className="connDocs" href={entry.docsUrl} target="_blank" rel="noreferrer noopener">
          Docs
        </a>
      </div>
      {props.blocked ? <p className="connCardNote">Local server: needs SIBYL_ALLOW_STDIO_MCP=true.</p> : null}
    </article>
  );
}

// ── add / edit form ──

interface Row {
  id: number;
  key: string;
  value: string;
  /** Masked stored value (editing): leaving the field empty keeps it. */
  stored?: string;
  field?: ConnectionCatalogField;
}

interface FormState {
  original?: string;
  catalog?: ConnectionCatalogEntry;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  cwd: string;
  url: string;
  rows: Row[];
  error?: string;
}

let rowCounter = 0;
const row = (partial: Omit<Row, "id">): Row => ({ id: ++rowCounter, ...partial });

function emptyForm(allowStdio: boolean): FormState {
  return { name: "", transport: allowStdio ? "stdio" : "http", command: "", args: "", cwd: "", url: "", rows: [] };
}

function formFromCatalog(entry: ConnectionCatalogEntry, servers: ConnectionServerView[]): FormState {
  let name = entry.name;
  for (let i = 2; servers.some((server) => server.name === name); i += 1) name = `${entry.name}-${i}`;
  const fields = entry.transport === "http" ? entry.headers ?? [] : entry.env ?? [];
  return {
    catalog: entry,
    name,
    transport: entry.transport,
    command: entry.command ?? "",
    args: (entry.args ?? []).join("\n"),
    cwd: "",
    url: entry.url ?? "",
    rows: fields.map((field) => row({ key: field.key, value: field.valuePrefix ?? "", field }))
  };
}

function formFromServer(server: ConnectionServerView, catalog: ConnectionCatalogEntry[]): FormState {
  const entry = catalog.find((item) => item.id === server.catalogId);
  const values = (server.transport === "http" ? server.headers : server.env) ?? {};
  const fields = entry ? (server.transport === "http" ? entry.headers : entry.env) ?? [] : [];
  return {
    original: server.name,
    catalog: entry,
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: (server.args ?? []).join("\n"),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    rows: Object.entries(values).map(([key, stored]) =>
      isSecretRef(stored)
        ? row({ key, value: stored, field: fields.find((field) => field.key === key) })
        : row({ key, value: "", stored, field: fields.find((field) => field.key === key) })
    )
  };
}

function toInput(form: FormState): ConnectionServerInput | string {
  const name = form.name.trim();
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) return "Name: 1–32 letters, digits, - or _.";
  const values: Record<string, string | null> = {};
  for (const item of form.rows) {
    const key = item.key.trim();
    if (!key) continue;
    if (key in values) return `${key} is listed twice.`;
    const prefix = item.field?.valuePrefix ?? "";
    const typed = item.value.trim() === prefix.trim() ? "" : item.value;
    if (!typed && item.stored !== undefined) values[key] = null;
    else if (!typed && item.field?.required) return `${item.field.label} is required.`;
    else values[key] = typed;
  }
  const catalogId = form.catalog ? { catalogId: form.catalog.id } : {};
  if (form.transport === "http") {
    if (!/^https?:\/\/\S+$/i.test(form.url.trim())) return "Enter the server's http(s) URL.";
    for (const key of Object.keys(values)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key)) return `"${key}" isn't a valid header name.`;
    }
    return { name, transport: "http", url: form.url.trim(), headers: values, ...catalogId };
  }
  if (!form.command.trim()) return "Enter the command that starts the server.";
  for (const key of Object.keys(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) return `"${key}" isn't a valid variable name.`;
  }
  const args = form.args.split("\n").map((arg) => arg.trim()).filter(Boolean);
  return {
    name,
    transport: "stdio",
    command: form.command.trim(),
    args,
    env: values,
    ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
    ...catalogId
  };
}

function ServerForm(props: {
  form: FormState;
  allowStdio: boolean;
  disabled: boolean;
  busy: boolean;
  test?: ConnectionsTestResultMessage | "pending";
  onChange: (form: FormState) => void;
  onCancel: () => void;
  onTest: (input: ConnectionServerInput) => void;
  onSave: (input: ConnectionServerInput) => void;
}) {
  const { form } = props;
  const base = useId();
  const set = (patch: Partial<FormState>) => props.onChange({ ...form, ...patch, error: undefined });
  const setRow = (id: number, patch: Partial<Row>) =>
    set({ rows: form.rows.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  const stdioBlocked = form.transport === "stdio" && !props.allowStdio;
  const submit = (then: (input: ConnectionServerInput) => void) => {
    const input = toInput(form);
    if (typeof input === "string") props.onChange({ ...form, error: input });
    else then(input);
  };
  const rowLabel = form.transport === "http" ? "Headers" : "Environment variables";

  return (
    <form
      className="connForm"
      onSubmit={(event) => {
        event.preventDefault();
        submit(props.onSave);
      }}
    >
      <div className="connFormHead">
        <button type="button" className="ghostBtn" onClick={props.onCancel}>
          ← Back
        </button>
        <h3>{form.original ? `Edit ${form.original}` : form.catalog ? `Add ${form.catalog.title}` : "Add a custom server"}</h3>
      </div>
      {form.catalog ? (
        <p className="connHint">
          {form.catalog.description}{" "}
          <a href={form.catalog.docsUrl} target="_blank" rel="noreferrer noopener">
            Setup guide
          </a>
          {form.catalog.note ? <span className="connFormNote">{form.catalog.note}</span> : null}
        </p>
      ) : null}

      <label className="field" htmlFor={`${base}-name`}>
        <span className="fieldLabel">Name</span>
        <span className="fieldHint">Tools appear as mcp_{form.name || "name"}_…</span>
        <input id={`${base}-name`} className="connInput" value={form.name} onChange={(event) => set({ name: event.target.value })} autoComplete="off" spellCheck={false} />
      </label>

      <div className="field">
        <span className="fieldLabel" id={`${base}-kind`}>Type</span>
        <div className="connSegment" role="radiogroup" aria-labelledby={`${base}-kind`}>
          {(["http", "stdio"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={form.transport === kind}
              className={form.transport === kind ? "active" : ""}
              onClick={() => set({ transport: kind })}
            >
              {kind === "http" ? "Remote (URL)" : "Local (command)"}
            </button>
          ))}
        </div>
        {stdioBlocked ? (
          <span className="connWarn" role="note">
            Local servers run a command on the gateway host. Set SIBYL_ALLOW_STDIO_MCP=true on the gateway to add them
            here, or put this server in mcp.config.json.
          </span>
        ) : null}
      </div>

      {form.transport === "http" ? (
        <label className="field" htmlFor={`${base}-url`}>
          <span className="fieldLabel">Server URL</span>
          <span className="fieldHint">Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp</span>
          <input id={`${base}-url`} className="connInput" type="url" inputMode="url" value={form.url} onChange={(event) => set({ url: event.target.value })} autoComplete="off" spellCheck={false} />
        </label>
      ) : (
        <>
          <label className="field" htmlFor={`${base}-command`}>
            <span className="fieldLabel">Command</span>
            <input id={`${base}-command`} className="connInput mono" value={form.command} onChange={(event) => set({ command: event.target.value })} placeholder="npx" autoComplete="off" spellCheck={false} />
          </label>
          <label className="field" htmlFor={`${base}-args`}>
            <span className="fieldLabel">Arguments</span>
            <span className="fieldHint">One per line.{form.catalog?.argsHint ? ` ${form.catalog.argsHint}` : ""}</span>
            <textarea id={`${base}-args`} className="connInput mono" rows={Math.min(6, Math.max(2, form.args.split("\n").length))} value={form.args} onChange={(event) => set({ args: event.target.value })} spellCheck={false} />
          </label>
          <label className="field" htmlFor={`${base}-cwd`}>
            <span className="fieldLabel">Working folder (optional)</span>
            <input id={`${base}-cwd`} className="connInput mono" value={form.cwd} onChange={(event) => set({ cwd: event.target.value })} autoComplete="off" spellCheck={false} />
          </label>
        </>
      )}

      <fieldset className="connRows">
        <legend className="fieldLabel">{rowLabel}</legend>
        <span className="fieldHint">
          Stored on the gateway only. Saved values are shown masked; leave a field empty to keep it.
        </span>
        {form.rows.map((item) => (
          <div className="connRow" key={item.id} role="group" aria-label={item.key || "New entry"}>
            <input
              className="connInput mono"
              aria-label={`${rowLabel}: name`}
              value={item.key}
              placeholder={form.transport === "http" ? "Header" : "NAME"}
              onChange={(event) => setRow(item.id, { key: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <input
              className="connInput mono"
              aria-label={`${item.field?.label ?? item.key ?? "Value"}: value`}
              type={item.field?.secret === false || isSecretRef(item.value) ? "text" : "password"}
              aria-describedby={`${base}-ref-${item.id}`}
              value={item.value}
              placeholder={item.stored ?? item.field?.placeholder ?? "value"}
              onChange={(event) => setRow(item.id, { value: event.target.value })}
              autoComplete="new-password"
              spellCheck={false}
            />
            <button type="button" className="iconBtn" aria-label={`Remove ${item.key || "row"}`} onClick={() => set({ rows: form.rows.filter((other) => other.id !== item.id) })}>
              <Icon name="close" size={16} />
            </button>
            {item.field ? (
              <span className="fieldHint connRowHint">
                {item.field.label}
                {item.field.required ? "" : " (optional)"}
                {item.field.help ? ` · ${item.field.help}` : ""}
              </span>
            ) : null}
            <span className="fieldHint connRowHint" id={`${base}-ref-${item.id}`}>
              Or write <code className="connRef">{"${secret:NAME}"}</code>
              {item.field?.valuePrefix ? ` (e.g. ${item.field.valuePrefix}\${secret:NAME})` : ""} to use a stored secret
              without pasting it here.
            </span>
          </div>
        ))}
        <button type="button" className="ghostBtn connAddRow" onClick={() => set({ rows: [...form.rows, row({ key: "", value: "" })] })}>
          <Icon name="plus" size={15} /> Add {form.transport === "http" ? "header" : "variable"}
        </button>
      </fieldset>

      {form.error ? (
        <p className="connNotice error" role="alert">
          {form.error}
        </p>
      ) : null}
      <TestOutcome test={props.test} />

      <div className="connFormActions">
        <button type="button" className="ghostBtn" disabled={props.disabled || stdioBlocked || props.test === "pending"} onClick={() => submit(props.onTest)}>
          {props.test === "pending" ? "Testing…" : "Test connection"}
        </button>
        <button type="submit" className="darkBtn" disabled={props.disabled || stdioBlocked || props.busy}>
          {props.busy ? "Connecting…" : form.original ? "Save" : "Add server"}
        </button>
      </div>
    </form>
  );
}

function Switch(props: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="connSwitch">
      <input
        type="checkbox"
        role="switch"
        aria-label={props.label}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="switch" aria-hidden />
    </label>
  );
}

/** `${secret:NAME}` references point at the secrets store; they are not secrets themselves. */
function isSecretRef(value: string | undefined): value is string {
  return typeof value === "string" && /\$\{secret:[A-Za-z0-9_.-]{1,128}\}/.test(value);
}

function omit<T extends Record<string, unknown>>(record: T, key: string): T {
  const { [key]: _removed, ...rest } = record;
  return rest as T;
}
