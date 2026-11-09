"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PluginCatalogEntryView, PluginSecretView, PluginsListResponse, PluginSourceInput, PluginSummaryView, PluginView, SecretRequestView } from "@open-gpt-live/protocol";
import { SecretPrompt } from "../../components/SecretPrompt";
import { useAppSession } from "../../lib/app-session";
import { errorText, gatewayRequest } from "../../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Muted, Notice, Row, SectionTitle, Select, Spacer, Stack } from "../../components/ui";
import styles from "./plugins.module.css";

interface Pending {
  source: PluginSourceInput;
  summary: PluginSummaryView;
  installed: boolean;
}

/** Plugins: the curated catalog, installed plugins and installs from a URL or git. */
export function PluginsScreen() {
  const session = useAppSession();
  const canInstall = session.can("plugins.install");
  const canRoutines = session.can("routines.manage");
  const [state, setState] = useState<PluginsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [keyFor, setKeyFor] = useState<{ plugin: PluginView; secret: PluginSecretView } | null>(null);
  const [keyError, setKeyError] = useState<string | undefined>();
  const [routineOffer, setRoutineOffer] = useState<PluginView | null>(null);
  const [remote, setRemote] = useState<{ kind: "url" | "git"; ref: string }>({ kind: "git", ref: "" });

  const load = useCallback(async () => {
    try {
      setState(await gatewayRequest<PluginsListResponse>("/api/plugins"));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [session.currentWorkspaceId, load]);

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function offerCatalog(entry: PluginCatalogEntryView): void {
    setScope("workspace");
    setPending({ source: { kind: "catalog", ref: entry.ref }, summary: entry.summary, installed: entry.installed });
  }

  async function previewRemote(event: FormEvent): Promise<void> {
    event.preventDefault();
    const ref = remote.ref.trim();
    if (!ref) return;
    await run(async () => {
      const source: PluginSourceInput = { kind: remote.kind, ref };
      const { summary } = await gatewayRequest<{ summary: PluginSummaryView }>("/api/plugins/preview", { method: "POST", body: { source } });
      setScope("workspace");
      setPending({ source, summary, installed: Boolean(state?.installed.some((plugin) => plugin.id === summary.id)) });
    });
  }

  async function install(): Promise<void> {
    if (!pending) return;
    const ok = await run(async () => {
      const { plugin } = await gatewayRequest<{ plugin: PluginView }>("/api/plugins/install", { method: "POST", body: { source: pending.source, scope } });
      await load();
      setPending(null);
      setRemote({ ...remote, ref: "" });
      setNotice(`Installed ${plugin.summary.name}.`);
      // Ask for the first missing key straight away, then offer routines.
      const missing = plugin.secrets.find((secret) => !secret.present && !secret.optional);
      if (plugin.status === "needs_secrets" && missing) setKeyFor({ plugin, secret: missing });
      else if (canRoutines && plugin.routines.some((routine) => !routine.routineId)) setRoutineOffer(plugin);
    });
    if (!ok) return;
  }

  async function saveKey(value: string, allowedHosts: string[]): Promise<void> {
    if (!keyFor) return;
    setBusy(true);
    setKeyError(undefined);
    try {
      const { plugin } = await gatewayRequest<{ plugin: PluginView }>(`/api/plugins/${encodeURIComponent(keyFor.plugin.id)}/secrets`, {
        method: "POST",
        body: { name: keyFor.secret.name, value, allowedHosts }
      });
      await load();
      const next = plugin.secrets.find((secret) => !secret.present && !secret.optional);
      if (next) setKeyFor({ plugin, secret: next });
      else {
        setKeyFor(null);
        setNotice(plugin.status === "ready" ? `${plugin.summary.name} is connected.` : plugin.error ?? `${plugin.summary.name} needs attention.`);
        if (canRoutines && plugin.routines.some((routine) => !routine.routineId)) setRoutineOffer(plugin);
      }
    } catch (cause) {
      setKeyError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const installed = state?.installed ?? [];

  return (
    <Stack gap={28}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="positive">{notice}</Notice> : null}

      <section className={styles.section} aria-label="Installed plugins">
        <SectionTitle>Installed</SectionTitle>
        {!state ? (
          <Muted>Loading…</Muted>
        ) : installed.length === 0 ? (
          <EmptyState compact title="No plugins installed in this workspace yet">
            <p>Install one from the catalog below{canInstall ? " or from a repository" : ""}.</p>
          </EmptyState>
        ) : (
          <Card>
            {installed.map((plugin) => (
              <InstalledPlugin
                key={plugin.id}
                plugin={plugin}
                busy={busy}
                canInstall={canInstall}
                canRoutines={canRoutines}
                onKey={(secret) => {
                  setKeyError(undefined);
                  setKeyFor({ plugin, secret });
                }}
                onRoutines={() => setRoutineOffer(plugin)}
                run={run}
                reload={load}
                setNotice={setNotice}
              />
            ))}
          </Card>
        )}
      </section>

      <section className={styles.section} aria-label="Catalog">
        <SectionTitle>Catalog</SectionTitle>
        <div className={styles.cards}>
          {(state?.catalog ?? []).map((entry) => (
            <Card as="article" key={entry.ref}>
              <CardHeader title={entry.summary.name} actions={entry.installed ? <Badge tone="positive">Installed</Badge> : null} />
              <Muted>{entry.summary.description}</Muted>
              <Contents summary={entry.summary} />
              {canInstall ? (
                <Row className={styles.cardFoot}>
                  <Spacer />
                  <Button variant={entry.installed ? "secondary" : "primary"} size="sm" disabled={busy} onClick={() => offerCatalog(entry)}>
                    {entry.installed ? "Reinstall" : "Install"}
                  </Button>
                </Row>
              ) : null}
            </Card>
          ))}
        </div>
      </section>

      {canInstall ? (
        <section className={styles.section} aria-label="Install from a URL or git">
          <SectionTitle>Install from a repository or URL</SectionTitle>
          <Card as="form" onSubmit={(event) => void previewRemote(event)}>
            <Row>
              <Select className={styles.kind} value={remote.kind} onChange={(event) => setRemote({ ...remote, kind: event.target.value as "url" | "git" })} aria-label="Source">
                <option value="git">Git repository</option>
                <option value="url">Manifest URL</option>
              </Select>
              <Input
                className={styles.address}
                placeholder={remote.kind === "git" ? "https://github.com/owner/repo" : "https://example.com/sibyl-plugin.json"}
                value={remote.ref}
                onChange={(event) => setRemote({ ...remote, ref: event.target.value })}
                aria-label="Address"
              />
              <Button type="submit" disabled={busy || !remote.ref.trim()}>
                Review
              </Button>
            </Row>
            <Muted>Only the sibyl-plugin.json file is fetched (https only). You&rsquo;ll see everything it adds before installing.</Muted>
          </Card>
        </section>
      ) : null}

      {pending ? (
        <Dialog
          title={`Install ${pending.summary.name}?`}
          onClose={() => setPending(null)}
          onSubmit={() => void install()}
          actions={
            <>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? "Installing…" : "Install"}
              </Button>
            </>
          }
        >
          <Muted>{pending.summary.description}</Muted>
          <Contents summary={pending.summary} detailed />
          {pending.summary.mcpServers.some((server) => server.transport === "stdio") ? (
            <Notice tone="warning">
              This plugin runs a local program on the gateway host.{" "}
              {state?.stdioAllowed
                ? "Only install it if you trust the author."
                : "Local programs are turned off on this Sibyl (SIBYL_ALLOW_STDIO_MCP), so that part will not start."}
            </Notice>
          ) : null}
          {pending.installed ? <Notice tone="warning">It is already installed: reinstalling replaces its skills and connections.</Notice> : null}
          <Field label="Install for">
            <Select value={scope} onChange={(event) => setScope(event.target.value as "workspace" | "all")}>
              <option value="workspace">This workspace</option>
              <option value="all">All workspaces</option>
            </Select>
          </Field>
        </Dialog>
      ) : null}

      {keyFor ? (
        <Dialog title={`Connect ${keyFor.plugin.summary.name}`} onClose={() => setKeyFor(null)}>
          <SecretPrompt
            key={`${keyFor.plugin.id}-${keyFor.secret.name}`}
            request={secretRequest(keyFor.plugin, keyFor.secret)}
            status="pending"
            submitting={busy}
            {...(keyError ? { error: keyError } : {})}
            onSave={(value, hosts) => void saveKey(value, hosts)}
            onCancel={() => setKeyFor(null)}
          />
        </Dialog>
      ) : null}

      {routineOffer ? (
        <RoutineOffer
          plugin={routineOffer}
          busy={busy}
          onClose={() => setRoutineOffer(null)}
          onCreate={(index) =>
            void run(async () => {
              const { plugin } = await gatewayRequest<{ plugin: PluginView }>(`/api/plugins/${encodeURIComponent(routineOffer.id)}/routines`, { method: "POST", body: { index } });
              setRoutineOffer(plugin.routines.some((routine) => !routine.routineId) ? plugin : null);
              setNotice(`Routine “${plugin.routines[index]?.name ?? ""}” created. Manage it under Routines.`);
              await load();
            })
          }
        />
      ) : null}
    </Stack>
  );
}

function secretRequest(plugin: PluginView, secret: PluginSecretView): SecretRequestView {
  const now = Date.now();
  return {
    id: `plugin-${plugin.id}-${secret.name}`,
    runId: `plugin-${plugin.id}`,
    name: secret.name,
    service: plugin.summary.name,
    description: secret.description,
    allowedHosts: secret.allowedHosts,
    ...(secret.howToGet ? { howToGet: secret.howToGet } : {}),
    ...(secret.docsUrl ? { docsUrl: secret.docsUrl } : {}),
    replace: secret.present,
    createdAt: now,
    expiresAt: now + 10 * 60 * 1000
  };
}

function InstalledPlugin(props: {
  plugin: PluginView;
  busy: boolean;
  canInstall: boolean;
  canRoutines: boolean;
  onKey: (secret: PluginSecretView) => void;
  onRoutines: () => void;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  reload: () => Promise<void>;
  setNotice: (text: string | null) => void;
}) {
  const { plugin, busy, canInstall } = props;
  const [confirm, setConfirm] = useState(false);
  const path = `/api/plugins/${encodeURIComponent(plugin.id)}`;
  const missing = plugin.secrets.filter((secret) => !secret.present && !secret.optional);
  const status = !plugin.enabled ? (
    <Badge>Off</Badge>
  ) : plugin.status === "ready" ? (
    <Badge tone="positive">Ready</Badge>
  ) : plugin.status === "needs_secrets" ? (
    <Badge tone="warning">Needs a key</Badge>
  ) : (
    <Badge tone="danger">Problem</Badge>
  );
  const openRoutines = plugin.routines.filter((routine) => !routine.routineId);
  return (
    <div className={styles.installedRow}>
      <Row>
        <strong>{plugin.summary.name}</strong>
        <Muted as="span">v{plugin.summary.version}</Muted>
        {status}
        <Spacer />
        {canInstall ? (
          <Checkbox
            label="On"
            checked={plugin.enabled}
            disabled={busy}
            onChange={() =>
              void props.run(async () => {
                await gatewayRequest(path, { method: "PATCH", body: { enabled: !plugin.enabled } });
                await props.reload();
              })
            }
          />
        ) : null}
      </Row>
      <Muted>{plugin.summary.description}</Muted>
      <Contents summary={plugin.summary} />
      {plugin.error ? <Notice tone="danger">{plugin.error}</Notice> : null}
      <Row>
        {canInstall && missing.length > 0 ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => props.onKey(missing[0]!)}>
            Add {missing[0]!.name}
          </Button>
        ) : null}
        {canInstall && plugin.status === "error" ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void props.run(async () => {
                await gatewayRequest(`${path}/recheck`, { method: "POST" });
                await props.reload();
              })
            }
          >
            Try again
          </Button>
        ) : null}
        {props.canRoutines && openRoutines.length > 0 ? (
          <Button size="sm" disabled={busy} onClick={props.onRoutines}>
            Routine templates ({openRoutines.length})
          </Button>
        ) : null}
        <Spacer />
        {canInstall ? (
          confirm ? (
            <>
              <Muted as="span">Remove its skills, connections and routines?</Muted>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void props.run(async () => {
                    const result = await gatewayRequest<{ keptKnowledgeBases?: string[] }>(path, { method: "DELETE" });
                    props.setNotice(
                      `Uninstalled ${plugin.summary.name}.` +
                        (result.keptKnowledgeBases?.length ? ` Kept knowledge bases with your documents: ${result.keptKnowledgeBases.join(", ")}.` : "")
                    );
                    await props.reload();
                  })
                }
              >
                Uninstall
              </Button>
              <Button size="sm" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
              Uninstall
            </Button>
          )
        ) : null}
      </Row>
    </div>
  );
}

function Contents({ summary, detailed = false }: { summary: PluginSummaryView; detailed?: boolean }) {
  if (!detailed) {
    const chips = [
      summary.skills.length ? `${summary.skills.length} skill${summary.skills.length === 1 ? "" : "s"}` : null,
      summary.mcpServers.length ? `${summary.mcpServers.length} connection${summary.mcpServers.length === 1 ? "" : "s"}` : null,
      summary.knowledgeBases.length ? `${summary.knowledgeBases.length} knowledge base${summary.knowledgeBases.length === 1 ? "" : "s"}` : null,
      summary.routines.length ? `${summary.routines.length} routine template${summary.routines.length === 1 ? "" : "s"}` : null,
      summary.secrets.length ? `needs ${summary.secrets.map((secret) => secret.name).join(", ")}` : null
    ].filter((chip): chip is string => Boolean(chip));
    return (
      <Row>
        {chips.map((chip) => (
          <Badge key={chip}>{chip}</Badge>
        ))}
      </Row>
    );
  }
  return (
    <ul className={styles.detailList}>
      {summary.skills.map((skill) => (
        <li key={`s-${skill.name}`}>
          Skill <strong>{skill.title}</strong> — {skill.description}
        </li>
      ))}
      {summary.mcpServers.map((server) => (
        <li key={`m-${server.key}`}>
          Connection <strong>{server.key}</strong> ({server.transport === "http" ? "remote" : "local program"}): {server.target}
        </li>
      ))}
      {summary.secrets.map((secret) => (
        <li key={`k-${secret.name}`}>
          Asks for the key <strong>{secret.name}</strong> — {secret.description}
        </li>
      ))}
      {summary.knowledgeBases.map((base) => (
        <li key={`b-${base.name}`}>
          Creates the knowledge base <strong>{base.name}</strong>
        </li>
      ))}
      {summary.routines.map((routine) => (
        <li key={`r-${routine.name}`}>
          Offers the routine <strong>{routine.name}</strong> ({routine.cron}) — only created if you accept
        </li>
      ))}
      {summary.author ? (
        <li>
          By {summary.author}
          {summary.license ? ` · ${summary.license}` : ""}
        </li>
      ) : null}
    </ul>
  );
}

function RoutineOffer({ plugin, busy, onClose, onCreate }: { plugin: PluginView; busy: boolean; onClose: () => void; onCreate: (index: number) => void }) {
  const open = plugin.routines.filter((routine) => !routine.routineId);
  return (
    <Dialog title={`Routines from ${plugin.summary.name}`} onClose={onClose} actions={<Button onClick={onClose}>Not now</Button>}>
      <Muted>These run on a schedule with the assistant. Nothing is created unless you add it.</Muted>
      {open.map((routine) => (
        <Card key={routine.index}>
          <CardHeader title={routine.name} meta={`Schedule (cron): ${routine.cron}`} />
          <Muted>{routine.instruction}</Muted>
          <Row>
            <Spacer />
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onCreate(routine.index)}>
              Add routine
            </Button>
          </Row>
        </Card>
      ))}
    </Dialog>
  );
}
