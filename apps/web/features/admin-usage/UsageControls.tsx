"use client";

/**
 * Admin → Usage controls (Sibyl Enterprise, feature `usage_advanced`).
 *
 * Budgets per person and per role, a per-request cap, allowed models, a rate
 * limit, alerts (email and a signed webhook) and the chargeback report with
 * CSV export. Talks to /api/usage-controls (ee/gateway/usage); the open-source
 * organisation budgets (SIBYL_BUDGET_*) still apply first.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { errorText, gatewayDownload, gatewayRequest } from "../../lib/gateway-http";
import { useGateway } from "../../lib/gateway";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Spacer, Stack, Textarea, Toolbar } from "../../components/ui";
import styles from "./usage.module.css";

interface Caps {
  dailyUsd?: number;
  monthlyUsd?: number;
}

interface Controls {
  users: Record<string, Caps>;
  roles: Record<string, Caps>;
  perRequestUsd?: number;
  allowedModels: string[];
  requestsPerMinute?: number;
  alerts: { thresholds: number[]; emails: string[]; notifyUser: boolean; webhookUrl?: string };
}

interface Person {
  userId: string;
  name: string;
  email: string;
  caps: Caps;
  todayUsd: number;
  monthUsd: number;
}

interface ControlsView {
  controls: Controls;
  people: Person[];
  roles: string[];
  email: { configured: boolean };
  webhook: { keySet: boolean; vault: boolean; privateNetwork: boolean };
  webhookKey?: string;
}

interface ReportRow {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userName: string;
  userEmail: string;
  calls: number;
  costUsd: number;
}

interface Report {
  rows: ReportRow[];
  workspaces: Array<{ workspaceId: string; workspaceName: string; calls: number; costUsd: number }>;
  totalUsd: number;
  calls: number;
}

/** Text fields as typed (numbers are parsed on save). */
interface Draft {
  users: Record<string, { daily: string; monthly: string }>;
  roles: Record<string, { daily: string; monthly: string }>;
  perRequest: string;
  models: string;
  rpm: string;
  thresholds: string;
  emails: string;
  notifyUser: boolean;
  webhookUrl: string;
}

const ROLE_LABELS: Record<string, string> = { owner: "Owners", admin: "Admins", member: "Members", viewer: "Viewers" };

function text(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function capsText(caps: Caps | undefined): { daily: string; monthly: string } {
  return { daily: text(caps?.dailyUsd), monthly: text(caps?.monthlyUsd) };
}

function toDraft(view: ControlsView): Draft {
  const { controls } = view;
  const users: Draft["users"] = {};
  for (const person of view.people) users[person.userId] = capsText(controls.users[person.userId]);
  const roles: Draft["roles"] = {};
  for (const role of view.roles) roles[role] = capsText(controls.roles[role]);
  return {
    users,
    roles,
    perRequest: text(controls.perRequestUsd),
    models: controls.allowedModels.join("\n"),
    rpm: text(controls.requestsPerMinute),
    thresholds: controls.alerts.thresholds.join(", "),
    emails: controls.alerts.emails.join("\n"),
    notifyUser: controls.alerts.notifyUser,
    webhookUrl: controls.alerts.webhookUrl ?? ""
  };
}

function capsOut(entry: { daily: string; monthly: string }): Caps {
  return {
    ...(entry.daily.trim() ? { dailyUsd: Number(entry.daily) } : {}),
    ...(entry.monthly.trim() ? { monthlyUsd: Number(entry.monthly) } : {})
  };
}

function fromDraft(draft: Draft): Controls {
  const list = (value: string) => value.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
  return {
    users: Object.fromEntries(Object.entries(draft.users).map(([id, entry]) => [id, capsOut(entry)])),
    roles: Object.fromEntries(Object.entries(draft.roles).map(([id, entry]) => [id, capsOut(entry)])),
    ...(draft.perRequest.trim() ? { perRequestUsd: Number(draft.perRequest) } : {}),
    allowedModels: list(draft.models),
    ...(draft.rpm.trim() ? { requestsPerMinute: Number(draft.rpm) } : {}),
    alerts: {
      thresholds: list(draft.thresholds).map((t) => Number(t.replace(/%$/, ""))),
      emails: list(draft.emails),
      notifyUser: draft.notifyUser,
      ...(draft.webhookUrl.trim() ? { webhookUrl: draft.webhookUrl.trim() } : {})
    }
  };
}

function usd(value: number): string {
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function dayInput(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** Two money inputs (daily, monthly) for one person or role. */
function CapInputs({ label, value, onChange }: { label: string; value: { daily: string; monthly: string }; onChange: (next: { daily: string; monthly: string }) => void }) {
  return (
    <div className={styles.caps}>
      <Input inputMode="decimal" aria-label={`${label}: daily budget in dollars`} placeholder="No daily cap" value={value.daily} onChange={(e) => onChange({ ...value, daily: e.target.value })} />
      <Input inputMode="decimal" aria-label={`${label}: monthly budget in dollars`} placeholder="No monthly cap" value={value.monthly} onChange={(e) => onChange({ ...value, monthly: e.target.value })} />
    </div>
  );
}

export function UsageControls() {
  const { catalog } = useGateway();
  const [view, setView] = useState<ControlsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [webhookKey, setWebhookKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState(() => {
    const now = new Date();
    return { from: dayInput(new Date(now.getFullYear(), now.getMonth(), 1)), to: dayInput(now) };
  });
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  const apply = useCallback((next: ControlsView) => {
    setView(next);
    setDraft(toDraft(next));
    if (next.webhookKey) setWebhookKey(next.webhookKey);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await gatewayRequest<ControlsView>("/api/usage-controls"));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [apply]);

  const reportQuery = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const loadReport = useCallback(async () => {
    try {
      setReport(await gatewayRequest<Report>(`/api/usage-controls/report?${reportQuery}`));
      setReportError(null);
    } catch (cause) {
      setReportError(errorText(cause));
    }
  }, [reportQuery]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const knownModels = useMemo(() => {
    const ids = new Set<string>();
    for (const model of [...(catalog?.llm ?? []), ...(catalog?.voice ?? [])]) ids.add(model.id);
    return [...ids];
  }, [catalog]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    void run(async () => {
      apply(await gatewayRequest<ControlsView>("/api/usage-controls", { method: "PUT", body: { controls: fromDraft(draft) } }));
      setNotice("Usage controls saved. They apply to the next request.");
    });
  }

  if (!view || !draft) {
    return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading usage controls…</Muted>;
  }
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  return (
    <Stack className={styles.screen}>
      <form onSubmit={save} className={styles.form}>
        <Toolbar
          start={<Muted as="span">The organisation budgets set on the server still apply first.</Muted>}
          end={
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          }
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {notice ? <Notice tone="positive">{notice}</Notice> : null}

        <Card>
          <CardHeader title="Limits for everyone" meta="Checked before every chat, voice and routine request." />
          <div className={styles.grid}>
            <Field label="Cost cap per request (USD)" hint="Refuse a request expected to cost more. Empty: no cap.">
              <Input inputMode="decimal" value={draft.perRequest} onChange={(e) => set({ perRequest: e.target.value })} placeholder="No cap" />
            </Field>
            <Field label="Requests per minute, per person" hint="Chat and voice requests. Empty: no limit.">
              <Input inputMode="numeric" value={draft.rpm} onChange={(e) => set({ rpm: e.target.value })} placeholder="No limit" />
            </Field>
          </div>
          <Field label="Allowed models" hint={`One model id per line. Empty: every model this server offers.${knownModels.length ? ` Offered now: ${knownModels.join(", ")}.` : ""}`}>
            <Textarea mono rows={3} value={draft.models} onChange={(e) => set({ models: e.target.value })} placeholder="Every model" />
          </Field>
        </Card>

        <Card>
          <CardHeader title="Budgets by role" meta="Each person with the role gets this budget in the workspace they work in." />
          <ul className={styles.rows}>
            {view.roles.map((role) => (
              <li key={role} className={styles.row}>
                <span className={styles.who}>
                  <strong>{ROLE_LABELS[role] ?? role}</strong>
                </span>
                <CapInputs label={ROLE_LABELS[role] ?? role} value={draft.roles[role] ?? { daily: "", monthly: "" }} onChange={(next) => set({ roles: { ...draft.roles, [role]: next } })} />
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Budgets by person" meta="A person's own budget replaces their role's. Spend counts across every workspace." />
          <div className={styles.headRow} aria-hidden="true">
            <span>Person · spent today / this month</span>
            <span>Daily</span>
            <span>Monthly</span>
          </div>
          <ul className={styles.rows}>
            {view.people.map((person) => (
              <li key={person.userId} className={styles.row}>
                <span className={styles.who}>
                  <strong>{person.name || person.email}</strong>
                  <span className={styles.meta}>
                    {person.email ? `${person.email} · ` : ""}
                    {usd(person.todayUsd)} today · {usd(person.monthUsd)} this month
                  </span>
                </span>
                <CapInputs
                  label={person.name || person.email}
                  value={draft.users[person.userId] ?? { daily: "", monthly: "" }}
                  onChange={(next) => set({ users: { ...draft.users, [person.userId]: next } })}
                />
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Alerts" meta="Sent once per person, budget and threshold each day or month." />
          {!view.email.configured ? <Notice tone="warning">Email isn't set up on this server (SIBYL_SMTP_URL), so alerts go to the webhook only.</Notice> : null}
          <div className={styles.grid}>
            <Field label="Thresholds (% of a budget)" hint="For example: 80, 100">
              <Input value={draft.thresholds} onChange={(e) => set({ thresholds: e.target.value })} />
            </Field>
            <Field label="Email alerts to" hint="One address per line.">
              <Textarea rows={2} value={draft.emails} onChange={(e) => set({ emails: e.target.value })} />
            </Field>
          </div>
          <Checkbox label="Also email the person who reached the threshold" checked={draft.notifyUser} onChange={(e) => set({ notifyUser: e.target.checked })} />
          <Field
            label="Webhook URL"
            hint={
              view.webhook.vault
                ? "We POST a JSON alert signed with HMAC-SHA256 (x-sibyl-signature). The signing key is shown once when it's created."
                : "Webhook alerts need the secrets vault (SIBYL_SECRET_KEY) to sign deliveries."
            }
          >
            <Input type="url" mono value={draft.webhookUrl} onChange={(e) => set({ webhookUrl: e.target.value })} placeholder="https://hooks.example.com/sibyl" />
          </Field>
          {webhookKey ? (
            <Notice tone="warning" action={<Button size="sm" onClick={() => setWebhookKey(null)}>Done</Button>}>
              <p className={styles.keyLabel}>Signing key — copy it now, it won't be shown again:</p>
              <code className={styles.key}>{webhookKey}</code>
            </Notice>
          ) : null}
          <Row>
            {view.controls.alerts.webhookUrl ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { webhookKey: key } = await gatewayRequest<{ webhookKey: string }>("/api/usage-controls/webhook-key", { method: "POST" });
                    setWebhookKey(key);
                  })
                }
              >
                New signing key
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { delivery } = await gatewayRequest<{ delivery: { email: Array<{ to: string; ok: boolean }>; webhook?: { ok: boolean; status?: number; error?: string } } }>(
                    "/api/usage-controls/test-alert",
                    { method: "POST" }
                  );
                  const parts = [
                    delivery.email.length ? `email: ${delivery.email.filter((e) => e.ok).length} of ${delivery.email.length} sent` : "email: nobody to send to",
                    delivery.webhook ? `webhook: ${delivery.webhook.ok ? `delivered (${delivery.webhook.status})` : delivery.webhook.error ?? `failed (${delivery.webhook.status})`}` : "webhook: not set"
                  ];
                  setNotice(`Test alert — ${parts.join("; ")}.`);
                })
              }
            >
              Send a test alert
            </Button>
          </Row>
        </Card>
      </form>

      <Card>
        <CardHeader title="Chargeback report" meta="What each workspace and person spent, from the recorded model calls." />
        <div className={styles.reportBar}>
          <Field label="From">
            <Input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </Field>
          <Spacer />
          <Button
            onClick={() => void gatewayDownload(`/api/usage-controls/report.csv?${reportQuery}`, "sibyl-usage.csv").catch((cause: unknown) => setReportError(errorText(cause)))}
          >
            Export CSV
          </Button>
        </div>
        {reportError ? <Notice tone="danger">{reportError}</Notice> : null}
        {report ? (
          report.rows.length === 0 ? (
            <Muted>No model calls in this period.</Muted>
          ) : (
            <Stack gap={10}>
              <Row>
                <Badge tone="outline">Total {usd(report.totalUsd)}</Badge>
                <Badge tone="outline">{report.calls} calls</Badge>
                {report.workspaces.map((w) => (
                  <Badge key={w.workspaceId}>
                    {w.workspaceName}: {usd(w.costUsd)}
                  </Badge>
                ))}
              </Row>
              <ul className={styles.rows}>
                {report.rows.map((row) => (
                  <li key={`${row.workspaceId}:${row.userId}`} className={styles.reportRow}>
                    <span className={styles.who}>
                      <strong>{row.userName}</strong>
                      <span className={styles.meta}>
                        {row.workspaceName}
                        {row.userEmail ? ` · ${row.userEmail}` : ""}
                      </span>
                    </span>
                    <span className={styles.meta}>{row.calls} calls</span>
                    <strong className={styles.amount}>{usd(row.costUsd)}</strong>
                  </li>
                ))}
              </ul>
            </Stack>
          )
        ) : (
          <Muted>Loading…</Muted>
        )}
      </Card>
    </Stack>
  );
}
