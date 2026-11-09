"use client";

/**
 * Admin → Audit log (Sibyl Enterprise, `audit_log`): who did what and when,
 * newest first, with filters, an integrity check of the hash chain, CSV and
 * JSONL export, and streaming to a webhook (SIEM). Reading it needs
 * audit.view (organization owners, or a custom role with it).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AdminAuditEntryView, AdminAuditStreamView, AdminAuditVerifyResponse } from "@open-gpt-live/protocol";
import { useAppSession } from "../../lib/app-session";
import { GatewayError, errorText } from "../../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Select, Stack, Toolbar } from "../../components/ui";
import { governanceApi, type AuditFilters } from "./api";
import styles from "./admin-governance.module.css";

const AREAS: Array<{ id: string; label: string }> = [
  { id: "", label: "Everything" },
  { id: "auth.", label: "Sign-ins" },
  { id: "member.", label: "Members" },
  { id: "invite.", label: "Invitations" },
  { id: "workspace.", label: "Workspaces" },
  { id: "role.", label: "Roles" },
  { id: "grant.", label: "Connection access" },
  { id: "connector.", label: "Integrations" },
  { id: "secret.", label: "Secrets" },
  { id: "approval.", label: "Approvals" },
  { id: "tool.", label: "Actions" },
  { id: "model.", label: "Models" },
  { id: "policy.", label: "Policies" },
  { id: "retention.", label: "Data retention" },
  { id: "data.", label: "Downloads" },
  { id: "license.", label: "Licence" },
  { id: "audit.", label: "Audit log" }
];

const OUTCOME_TONE = { success: "positive", failure: "danger", denied: "warning" } as const;

function who(entry: AdminAuditEntryView): string {
  const a = entry.actor;
  if (a.kind === "system") return "Sibyl";
  if (a.kind === "token") return "Owner token";
  if (a.kind === "local") return "Owner (local)";
  return a.name ?? a.email ?? a.userId ?? "Someone";
}

function details(entry: AdminAuditEntryView): string {
  if (!entry.details) return "";
  return Object.entries(entry.details)
    .filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");
}

export function AuditSection() {
  const session = useAppSession();
  const [filters, setFilters] = useState<AuditFilters>({});
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<AdminAuditEntryView[] | null>(null);
  const [next, setNext] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<AdminAuditVerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (more?: number) => {
    try {
      const page = await governanceApi.audit({ ...filters, ...(more ? { before: more } : {}) });
      setEntries((current) => (more && current ? [...current, ...page.entries] : page.entries));
      setNext(page.next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof GatewayError && cause.status === 403 ? "Reading the audit log needs the audit.view permission (organization owners, or a custom role that includes it)." : errorText(cause));
    }
  }, [filters]);

  const allowed = session.can("audit.view");
  useEffect(() => {
    if (allowed) void load();
  }, [load, allowed]);

  if (!allowed) {
    return <Notice tone="warning">Reading the audit log needs the audit.view permission (organization owners, or a custom role that includes it).</Notice>;
  }

  const search = (event: FormEvent) => {
    event.preventDefault();
    setFilters({ ...filters, q: query.trim() || undefined });
  };

  return (
    <Stack>
      <Card>
        <CardHeader
          title="Integrity"
          meta="Every entry carries the hash of the one before it, so a changed or deleted entry is detected."
        />
        <Row>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setVerify(await governanceApi.verify());
              } catch (cause) {
                setError(errorText(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            Check integrity
          </Button>
        </Row>
        {verify ? (
          verify.ok ? (
            <Notice tone="positive">All {verify.checked} entries are intact.</Notice>
          ) : (
            <Notice tone="danger">
              {verify.problem?.message} Entries 1–{verify.lastSeq} are intact.
            </Notice>
          )
        ) : null}
      </Card>

      <Toolbar
        start={
          <form className={styles.filters} onSubmit={search}>
            <Select aria-label="What" value={filters.action ?? ""} onChange={(e) => setFilters({ ...filters, action: e.target.value || undefined })}>
              {AREAS.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Outcome" value={filters.outcome ?? ""} onChange={(e) => setFilters({ ...filters, outcome: e.target.value || undefined })}>
              <option value="">Any outcome</option>
              <option value="success">Succeeded</option>
              <option value="failure">Failed</option>
              <option value="denied">Denied</option>
            </Select>
            <Input aria-label="Search" type="search" placeholder="Search (person, tool, name…)" value={query} onChange={(e) => setQuery(e.target.value)} />
          </form>
        }
        end={
          <Row>
            <Button size="sm" onClick={() => void governanceApi.exportAudit("csv", filters).catch((cause) => setError(errorText(cause)))}>
              Export CSV
            </Button>
            <Button size="sm" onClick={() => void governanceApi.exportAudit("jsonl", filters).catch((cause) => setError(errorText(cause)))}>
              Export JSONL
            </Button>
          </Row>
        }
      />

      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Card>
        {!entries ? <Muted>Loading the audit log…</Muted> : entries.length === 0 ? <Muted>Nothing recorded for these filters.</Muted> : null}
        <ul className={styles.rows}>
          {(entries ?? []).map((entry) => (
            <li key={entry.seq} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  <span className={styles.mono}>{entry.action}</span>
                  <Badge tone={OUTCOME_TONE[entry.outcome]}>{entry.outcome}</Badge>
                  {entry.target ? <span>{entry.target.name ?? entry.target.id ?? entry.target.kind}</span> : null}
                </span>
                <span className={styles.rowMeta}>
                  {who(entry)}
                  {entry.actor.email && entry.actor.name ? ` (${entry.actor.email})` : ""}
                  {entry.workspaceId ? ` · ${entry.workspaceId}` : ""}
                  {entry.ip ? ` · ${entry.ip}` : ""}
                </span>
                {entry.details ? <span className={styles.details}>{details(entry)}</span> : null}
              </span>
              <span className={styles.time} title={`#${entry.seq} · ${entry.hash}`}>
                {new Date(entry.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
        {next ? (
          <Row>
            <Button size="sm" variant="ghost" onClick={() => void load(next)}>
              Show older
            </Button>
          </Row>
        ) : null}
      </Card>

      <StreamCard />
    </Stack>
  );
}

/** Streaming to a webhook: URL, on/off, the signing secret (shown once), a test request. */
function StreamCard() {
  const [view, setView] = useState<AdminAuditStreamView | null>(null);
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void governanceApi
      .stream()
      .then((next) => {
        setView(next);
        setUrl(next.url ?? "");
        setEnabled(next.enabled ?? true);
      })
      .catch((cause) => setError(errorText(cause)));
  }, []);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = (rotateSecret = false) =>
    act(async () => {
      const next = await governanceApi.saveStream({ url, enabled, ...(rotateSecret ? { rotateSecret } : {}) });
      setView(next);
      setSecret(next.secret ?? null);
      setNotice("Streaming settings saved.");
    });

  return (
    <Card>
      <CardHeader
        title="Stream to a webhook"
        meta="New entries are POSTed in order as JSON to your SIEM, signed with HMAC-SHA256 (x-sibyl-signature) over the timestamp and body."
        actions={view?.configured ? <Badge tone={view.enabled ? (view.lastError ? "warning" : "positive") : "outline"}>{view.enabled ? (view.lastError ? "Failing" : "On") : "Off"}</Badge> : null}
      />
      <Field label="Webhook URL (https)">
        <Input type="url" value={url} placeholder="https://siem.example.com/sibyl" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Checkbox label="Send new entries" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      {view?.lastError ? <Notice tone="warning">Last delivery failed: {view.lastError}</Notice> : null}
      {view?.lastDeliveredAt ? <Muted>Delivered up to entry #{view.cursor}, last at {new Date(view.lastDeliveredAt).toLocaleString()}.</Muted> : null}
      {secret ? (
        <Notice tone="warning">
          Signing secret (shown once; it is kept in the secrets vault):
          <code className={styles.secret}>{secret}</code>
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="positive">{notice}</Notice> : null}
      <Row>
        <Button disabled={busy || !url.trim()} onClick={() => void save()}>
          Save
        </Button>
        {view?.configured ? (
          <>
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await governanceApi.testStream();
                  setNotice(result.ok ? `Test delivered (HTTP ${result.status}).` : `Test failed: ${result.error ?? `HTTP ${result.status}`}`);
                })
              }
            >
              Send a test
            </Button>
            <Button disabled={busy} onClick={() => void save(true)}>
              New secret
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await governanceApi.removeStream();
                  setView({ configured: false });
                  setUrl("");
                  setSecret(null);
                })
              }
            >
              Remove
            </Button>
          </>
        ) : null}
      </Row>
    </Card>
  );
}
