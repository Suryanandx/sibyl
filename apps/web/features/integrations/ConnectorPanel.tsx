"use client";

/**
 * One connector in detail: its connections (status, action groups, last
 * used, reconnect, test, disconnect), connecting a new account (personal or
 * for the workspace) and, for organization admins, the app setup (client ID
 * and secret, settings, which action groups may be used).
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { IntegrationConnectionView, IntegrationConnectorView, IntegrationsState } from "@open-gpt-live/protocol";
import {
  disconnect,
  openConsent,
  reconnect,
  removeApp,
  saveApp,
  startConnect,
  testConnection,
  updateConnection
} from "./api";
import { ConnectorGlyph } from "./glyphs";
import { NotificationsChannel, presenceProviderOf } from "../presence";
import { relativeTime } from "../../lib/format";
import { Badge, Button, Field, Input, Notice as NoticeBox, Row, Tabs } from "../../components/ui";
import styles from "./integrations.module.css";
import { ENTERPRISE } from "../../lib/edition";

interface PanelProps {
  connector: IntegrationConnectorView;
  connections: IntegrationConnectionView[];
  can: IntegrationsState["can"];
  onState(state: IntegrationsState): void;
  onChanged(): void;
  onClose(): void;
}

type Notice = { kind: "ok" | "error"; text: string } | null;

export function ConnectorPanel(props: PanelProps) {
  const { connector, connections, can } = props;
  const titleId = useId();
  const [notice, setNotice] = useState<Notice>(null);
  const locked = connector.edition === "enterprise" && !connector.available;
  // Slack and Microsoft 365 also carry agents in channels and notifications.
  const presence = presenceProviderOf(connector.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const run = async (label: string, task: () => Promise<unknown>) => {
    setNotice(null);
    try {
      await task();
      if (label) setNotice({ kind: "ok", text: label });
      props.onChanged();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "That didn't work." });
    }
  };

  return (
    <div className={styles.backdrop} onClick={props.onClose}>
      <aside className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className={styles.panelHead}>
          <span className={styles.glyph}>
            <ConnectorGlyph id={connector.id} />
          </span>
          <div className={styles.cardTitle}>
            <h2 id={titleId}>{connector.name}</h2>
            <p>{connector.description}</p>
          </div>
          <Button variant="ghost" size="sm" iconOnly onClick={props.onClose} aria-label="Close">
            ×
          </Button>
        </header>

        {notice ? (
          <NoticeBox tone={notice.kind === "error" ? "danger" : "positive"} className={styles.panelNotice}>
            {notice.text}
          </NoticeBox>
        ) : null}

        {locked ? (
          <section className={styles.section}>
            <Badge tone="accent">{ENTERPRISE.name}</Badge>
            <p>
              {connector.name} comes with {ENTERPRISE.name}, the enterprise edition by {ENTERPRISE.by}. With a licence that includes <code>{connector.feature}</code>{" "}
              (Settings → Licence, then restart), admins can set it up here and people can connect their {connector.vendor} accounts.{" "}
              <a href={ENTERPRISE.url} target="_blank" rel="noreferrer">
                {ENTERPRISE.contactLabel}
              </a>
            </p>
          </section>
        ) : (
          <>
            {connections.length ? (
              <section className={styles.section}>
                <h3>Connections</h3>
                {connections.map((connection) => (
                  <ConnectionItem key={connection.id} connector={connector} connection={connection} run={run} />
                ))}
              </section>
            ) : null}
            <ConnectForm connector={connector} connections={connections} can={can} run={run} />
            {presence && connections.some((c) => c.scope === "workspace") ? <NotificationsChannel provider={presence} /> : null}
            <SetupSection connector={connector} can={can} onState={props.onState} run={run} />
          </>
        )}
      </aside>
    </div>
  );
}

type Run = (label: string, task: () => Promise<unknown>) => Promise<void>;

function ConnectionItem({ connector, connection, run }: { connector: IntegrationConnectorView; connection: IntegrationConnectionView; run: Run }) {
  const [groups, setGroups] = useState(connection.groups);
  useEffect(() => setGroups(connection.groups), [connection.groups]);
  const dirty = groups.slice().sort().join() !== connection.groups.slice().sort().join();
  const allowed = connector.groups.filter((g) => g.allowed || connection.groups.includes(g.id));
  return (
    <div className={styles.connection}>
      <div className={styles.connectionHead}>
        <span className={`${styles.dot} ${connection.status === "connected" ? styles.dotOk : styles.dotWarn}`} aria-hidden />
        <strong>{connection.scope === "personal" ? "Just you" : "Whole workspace"}</strong>
        <span className={styles.muted}>
          {connection.account ? ` · ${connection.account}` : ""}
          {connection.scope === "workspace" && connection.createdByName ? ` · connected by ${connection.createdByName}` : ""}
        </span>
      </div>
      <p className={styles.small}>
        {connection.status === "connected" ? "Connected" : connection.statusMessage ?? "Needs attention"}
        {connection.lastUsedAt ? ` · last used ${relativeTime(connection.lastUsedAt)}` : " · not used yet"}
      </p>
      {connection.needsConsent.length ? (
        <p className={styles.warnText}>
          Reconnect to approve: {connection.needsConsent.map((id) => connector.groups.find((g) => g.id === id)?.title ?? id).join(", ")}.
        </p>
      ) : null}
      <GroupChecklist groups={allowed} selected={groups} disabled={!connection.canManage} onChange={setGroups} />
      {connection.canManage ? (
        <Row className={styles.actions}>
          {dirty ? (
            <Button size="sm" variant="primary" onClick={() => void run("Actions updated.", () => updateConnection(connection.id, groups))}>
              Save actions
            </Button>
          ) : null}
          {connection.authKind === "oauth2" ? (
            <Button
              size="sm"
              onClick={() =>
                void run("", async () => {
                  const { authorizeUrl } = await reconnect(connection.id, groups);
                  openConsent(authorizeUrl);
                })
              }
            >
              Reconnect
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void run("Connection checked.", () => testConnection(connection.id))}>
            Test
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (window.confirm(`Disconnect ${connector.name}${connection.account ? ` (${connection.account})` : ""}? Sibyl revokes its access.`)) {
                void run("Disconnected.", () => disconnect(connection.id));
              }
            }}
          >
            Disconnect
          </Button>
        </Row>
      ) : (
        <p className={styles.small}>Only workspace admins can change this connection.</p>
      )}
    </div>
  );
}

function GroupChecklist(props: { groups: IntegrationConnectorView["groups"]; selected: string[]; disabled?: boolean; onChange(next: string[]): void }) {
  return (
    <ul className={styles.groups}>
      {props.groups.map((group) => {
        const checked = props.selected.includes(group.id);
        const writes = group.actions.some((a) => a.effect === "write");
        const risky = group.actions.some((a) => a.risk === "high");
        return (
          <li key={group.id}>
            <label className={styles.groupRow}>
              <input
                type="checkbox"
                className={styles.switchInput}
                role="switch"
                checked={checked}
                disabled={props.disabled || !group.allowed}
                onChange={(event) => props.onChange(event.target.checked ? [...props.selected, group.id] : props.selected.filter((id) => id !== group.id))}
              />
              <span className={styles.switch} aria-hidden />
              <span className={styles.groupText}>
                <span className={styles.groupTitle}>
                  {group.title}
                  {risky ? <Badge tone="warning">sends</Badge> : writes ? <Badge>changes</Badge> : null}
                  {!group.allowed ? <Badge>off for your organization</Badge> : null}
                </span>
                <span className={styles.small}>{group.description}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function ConnectForm({ connector, connections, can, run }: { connector: IntegrationConnectorView; connections: IntegrationConnectionView[]; can: IntegrationsState["can"]; run: Run }) {
  const hasPersonal = connections.some((c) => c.scope === "personal" && c.mine);
  const hasShared = connections.some((c) => c.scope === "workspace");
  const scopes = [
    ...(can.connectPersonal && !hasPersonal ? (["personal"] as const) : []),
    ...(can.connectShared && !hasShared ? (["workspace"] as const) : [])
  ];
  const [scope, setScope] = useState<"personal" | "workspace">(scopes[0] ?? "personal");
  const defaults = useMemo(() => connector.groups.filter((g) => g.allowed && g.defaultEnabled).map((g) => g.id), [connector.groups]);
  const [groups, setGroups] = useState<string[]>(defaults);
  const supportsKey = connector.authKinds.includes("apiKey");
  const supportsOAuth = connector.authKinds.includes("oauth2");
  const [method, setMethod] = useState<"oauth2" | "apiKey">(supportsOAuth && connector.app?.configured ? "oauth2" : supportsKey ? "apiKey" : "oauth2");
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!scopes.includes(scope) && scopes[0]) setScope(scopes[0]);
  }, [scopes.join(), scope]);

  if (scopes.length === 0) {
    if (!can.connectPersonal) return <p className={`${styles.section} ${styles.small}`}>You can use connections shared with this workspace; ask an admin to connect {connector.name}.</p>;
    return null;
  }
  const oauthReady = Boolean(connector.app?.configured);
  return (
    <section className={styles.section}>
      <h3>Connect {connections.length ? "another account" : connector.name}</h3>
      {scopes.length > 1 ? (
        <Tabs
          label="Who can use it"
          className={styles.segmented}
          value={scope}
          onChange={setScope}
          options={scopes.map((option) => ({ value: option, label: option === "personal" ? "Just me" : "Whole workspace" }))}
        />
      ) : (
        <p className={styles.small}>{scopes[0] === "personal" ? "Only you will be able to use this connection." : "Everyone in this workspace will be able to use it."}</p>
      )}
      {scope === "workspace" ? <p className={styles.small}>Everyone in this workspace will be able to use this account through Sibyl.</p> : null}

      <h4 className={styles.subTitle}>What Sibyl may do</h4>
      <GroupChecklist groups={connector.groups.filter((g) => g.allowed)} selected={groups} onChange={setGroups} />

      {supportsKey && supportsOAuth ? (
        <Tabs
          label="How to connect"
          className={styles.segmented}
          value={method}
          onChange={setMethod}
          options={[
            { value: "oauth2", label: `Sign in with ${connector.vendor}` },
            { value: "apiKey", label: "Use a token" }
          ]}
        />
      ) : null}

      {method === "apiKey" && supportsKey ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void run(`${connector.name} connected.`, async () => {
              await startConnect(connector.id, { scope, groups, credentials: values });
              setValues({});
            });
          }}
        >
          {(connector.apiKeyFields ?? []).map((field) => (
            <Field key={field.name} label={field.label} hint={field.help}>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                value={values[field.name] ?? ""}
                onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              />
            </Field>
          ))}
          <Row>
            <Button type="submit" variant="primary" disabled={(connector.apiKeyFields ?? []).some((f) => !values[f.name]?.trim())}>
              Connect
            </Button>
          </Row>
          <p className={styles.small}>The token is stored encrypted on your Sibyl server and never shown again.</p>
        </form>
      ) : (
        <Row className={styles.actions}>
          <Button
            variant="primary"
            disabled={!oauthReady}
            onClick={() =>
              void run("", async () => {
                const result = await startConnect(connector.id, { scope, groups });
                if (result.authorizeUrl) openConsent(result.authorizeUrl);
              })
            }
          >
            Continue to {connector.vendor}
          </Button>
          {!oauthReady ? <span className={styles.small}>Needs the app set up first (below).</span> : null}
        </Row>
      )}
    </section>
  );
}

function SetupSection({ connector, can, onState, run }: { connector: IntegrationConnectorView; can: IntegrationsState["can"]; onState(state: IntegrationsState): void; run: Run }) {
  const app = connector.app;
  const setup = connector.setup;
  const [open, setOpen] = useState(Boolean(app && !app.configured && can.manageApps));
  const [clientId, setClientId] = useState(app?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>(() => Object.fromEntries((app?.settings ?? []).map((s) => [s.name, s.value])));
  const [allowed, setAllowed] = useState<string[]>(() => connector.groups.filter((g) => g.allowed).map((g) => g.id));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const newSecrets = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.trim()).map(([name, value]) => [name, value.trim()]));
  useEffect(() => setClientId(app?.clientId ?? ""), [app?.clientId]);
  if (!setup) return null;
  return (
    <section className={styles.section}>
      <button type="button" className={styles.disclosure} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Setup guide{app ? (app.configured ? " · app configured" : " · not set up") : ""}
      </button>
      {open ? (
        <div className={styles.setup}>
          <ol className={styles.steps}>
            {setup.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
          <p className={styles.small}>
            <a href={setup.consoleUrl} target="_blank" rel="noreferrer noopener">
              Open the {setup.consoleName} ↗
            </a>{" "}
            · step-by-step in <code>docs/integrations.md#{setup.docsAnchor}</code>
          </p>
          {app ? <CopyField label="Redirect URI" value={app.redirectUri} /> : null}
          {(app?.endpoints ?? []).map((endpoint) => (
            <CopyField key={endpoint.url} label={endpoint.label} value={endpoint.url} {...(endpoint.help ? { help: endpoint.help } : {})} />
          ))}
          {can.manageApps && app ? (
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                void run("App saved.", async () => {
                  const next = await saveApp(connector.id, {
                    ...(clientId.trim() && clientId.trim() !== app.clientId ? { clientId: clientId.trim() } : {}),
                    ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
                    ...(app.settings.length ? { settings } : {}),
                    ...(Object.keys(newSecrets).length ? { secrets: newSecrets } : {}),
                    allowedGroups: allowed.length === connector.groups.length ? null : allowed
                  });
                  setClientSecret("");
                  setSecrets({});
                  onState(next);
                });
              }}
            >
              <Field label="Client ID">
                <Input value={clientId} onChange={(event) => setClientId(event.target.value)} spellCheck={false} autoComplete="off" />
              </Field>
              <Field label="Client secret">
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  placeholder={app.configured ? "Stored — enter a new one to replace it" : ""}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {(app.secrets ?? []).map((field) => (
                <Field key={field.name} label={field.label} hint={field.help}>
                  <Input
                    type="password"
                    value={secrets[field.name] ?? ""}
                    onChange={(event) => setSecrets((current) => ({ ...current, [field.name]: event.target.value }))}
                    placeholder={field.configured ? "Stored — enter a new one to replace it" : ""}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              ))}
              {app.settings.map((field) => (
                <Field key={field.name} label={field.label} hint={field.help}>
                  <Input value={settings[field.name] ?? ""} onChange={(event) => setSettings((current) => ({ ...current, [field.name]: event.target.value }))} spellCheck={false} />
                </Field>
              ))}
              <h4 className={styles.subTitle}>Allowed for your organization</h4>
              <GroupChecklist groups={connector.groups.map((g) => ({ ...g, allowed: true }))} selected={allowed} onChange={setAllowed} />
              <ScopesTable connector={connector} />
              <Row>
                <Button type="submit" variant="primary" disabled={!clientId.trim() || (!app.configured && !clientSecret.trim())}>
                  Save
                </Button>
                {app.configured && app.source === "vault" ? (
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (window.confirm("Remove the app credentials? Existing connections stop refreshing until they are added again.")) {
                        void run("App credentials removed.", async () => onState(await removeApp(connector.id)));
                      }
                    }}
                  >
                    Remove credentials
                  </Button>
                ) : null}
              </Row>
              {app.source === "env" ? <p className={styles.small}>Currently set by environment variables on the server; saving here takes precedence.</p> : null}
              <p className={styles.small}>The client secret is stored encrypted in Sibyl&apos;s secrets vault and never shown again.</p>
            </form>
          ) : app && !app.configured ? (
            <p className={styles.small}>An organization owner or admin needs to paste the app&apos;s client ID and secret here.</p>
          ) : (
            <ScopesTable connector={connector} />
          )}
        </div>
      ) : null}
    </section>
  );
}

/** A value to paste into the vendor's console (redirect URI, events URL), with a copy button. */
function CopyField({ label, value, help }: { label: string; value: string; help?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.copyField}>
      <span className={styles.copyLabel}>{label}</span>
      <div className={styles.copyRow}>
        <code className={styles.code}>{value}</code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {help ? <span className={styles.small}>{help}</span> : null}
    </div>
  );
}

function ScopesTable({ connector }: { connector: IntegrationConnectorView }) {
  const rows = connector.groups.filter((g) => g.scopes.length);
  if (!rows.length) return null;
  return (
    <table className={styles.scopes}>
      <thead>
        <tr>
          <th>Action group</th>
          <th>Scopes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((group) => (
          <tr key={group.id}>
            <td>{group.title}</td>
            <td>
              {group.scopes.map((scope) => (
                <code key={scope}>{scope.replace(/^https:\/\/(www\.googleapis\.com\/auth\/|graph\.microsoft\.com\/)/, "")}</code>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
