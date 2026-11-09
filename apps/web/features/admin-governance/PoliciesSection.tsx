"use client";

/**
 * Admin → Policies (Sibyl Enterprise, `policies`): blocked tools, write
 * actions that need an admin's second approval (and the queue of those
 * waiting), the model allowlist and data retention. The gateway applies
 * them where tools are offered and run and where models are chosen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminPoliciesState, AdminPoliciesView, AdminSecondApprovalItem, AdminSecondApprovalMode } from "@open-gpt-live/protocol";
import { useGateway } from "../../lib/gateway";
import { errorText } from "../../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Select, Stack } from "../../components/ui";
import { governanceApi } from "./api";
import styles from "./admin-governance.module.css";

const MODES: Array<{ id: AdminSecondApprovalMode; label: string }> = [
  { id: "off", label: "Off: the person's own approval is enough" },
  { id: "high_risk", label: "High-risk actions (send, delete, share, pay)" },
  { id: "all_writes", label: "Every action that changes something" },
  { id: "listed", label: "Only the tools chosen below" }
];

const RETENTION: Array<{ key: keyof AdminPoliciesView["retention"]; label: string }> = [
  { key: "chatsDays", label: "Chats (days)" },
  { key: "uploadsDays", label: "Uploaded files (days)" },
  { key: "notificationsDays", label: "Notifications (days)" }
];

export function PoliciesSection() {
  const { catalog } = useGateway();
  const [state, setState] = useState<AdminPoliciesState | null>(null);
  const [draft, setDraft] = useState<AdminPoliciesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await governanceApi.policies();
      setState(next);
      setDraft(next.policies);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = useMemo(() => [...new Set((state?.tools ?? []).map((t) => t.provider).filter((p): p is string => Boolean(p)))].sort(), [state]);
  const models = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of [...(catalog?.llm ?? []), ...(catalog?.voice ?? [])]) seen.set(m.id, m.label);
    for (const id of draft?.modelAllowlist ?? []) if (!seen.has(id)) seen.set(id, id);
    return [...seen].map(([id, label]) => ({ id, label }));
  }, [catalog, draft?.modelAllowlist]);

  if (!state || !draft) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading policies…</Muted>;

  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));
  const shown = state.tools.filter((t) => !filter || `${t.name} ${t.title} ${t.provider ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.policies);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const policies = await governanceApi.savePolicies({
        blockedTools: draft.blockedTools,
        secondApproval: draft.secondApproval,
        modelAllowlist: draft.modelAllowlist,
        retention: draft.retention
      });
      setState({ ...state, policies });
      setDraft(policies);
      setError(null);
      setNotice("Policies saved. They apply right away.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <SecondApprovalQueue />

      <Card>
        <CardHeader title="Blocked tools" meta="Blocked tools are never offered to Sibyl or agents, and refused if called." />
        {providers.length ? (
          <fieldset className={styles.group}>
            <legend>Every tool of a source</legend>
            <div className={styles.checks}>
              {providers.map((provider) => (
                <Checkbox
                  key={provider}
                  label={<span className={styles.mono}>{provider}</span>}
                  checked={draft.blockedTools.includes(`provider:${provider}`)}
                  onChange={(e) => setDraft({ ...draft, blockedTools: toggle(draft.blockedTools, `provider:${provider}`, e.target.checked) })}
                />
              ))}
            </div>
          </fieldset>
        ) : null}
        <Field label="Find a tool">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name or source" />
        </Field>
        <div className={`${styles.checks} ${styles.scroll}`}>
          {shown.map((tool) => (
            <Checkbox
              key={tool.name}
              label={
                <span>
                  <span className={styles.mono}>{tool.name}</span> {tool.effect === "write" ? <Badge tone="warning">writes</Badge> : null}
                </span>
              }
              title={tool.title}
              checked={draft.blockedTools.includes(tool.name)}
              onChange={(e) => setDraft({ ...draft, blockedTools: toggle(draft.blockedTools, tool.name, e.target.checked) })}
            />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Second approval" meta="After the person approves an action, an organization owner or admin must approve it too (someone other than the person who asked)." />
        <Field label="Ask an admin for">
          <Select value={draft.secondApproval.mode} onChange={(e) => setDraft({ ...draft, secondApproval: { ...draft.secondApproval, mode: e.target.value as AdminSecondApprovalMode } })}>
            {MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </Select>
        </Field>
        {draft.secondApproval.mode === "listed" ? (
          <div className={`${styles.checks} ${styles.scroll}`}>
            {state.tools
              .filter((t) => t.effect === "write")
              .map((tool) => (
                <Checkbox
                  key={tool.name}
                  label={<span className={styles.mono}>{tool.name}</span>}
                  title={tool.title}
                  checked={draft.secondApproval.tools.includes(tool.name)}
                  onChange={(e) => setDraft({ ...draft, secondApproval: { ...draft.secondApproval, tools: toggle(draft.secondApproval.tools, tool.name, e.target.checked) } })}
                />
              ))}
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Model allowlist" meta="Only these models can be chosen or used. Leave all unticked to allow every model." />
        {models.length === 0 ? <Muted>The model list appears once Sibyl is connected.</Muted> : null}
        <div className={styles.checks}>
          {models.map((model) => (
            <Checkbox
              key={model.id}
              label={model.label}
              title={model.id}
              checked={draft.modelAllowlist.includes(model.id)}
              onChange={(e) => setDraft({ ...draft, modelAllowlist: toggle(draft.modelAllowlist, model.id, e.target.checked) })}
            />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Data retention" meta="Older items are deleted every hour. Leave empty to keep them." />
        <div className={styles.formGrid}>
          {RETENTION.map(({ key, label }) => (
            <Field key={key} label={label}>
              <Input
                type="number"
                min={1}
                max={3650}
                inputMode="numeric"
                value={draft.retention[key] ?? ""}
                onChange={(e) => {
                  const value = e.target.value ? Math.round(Number(e.target.value)) : undefined;
                  const retention = { ...draft.retention };
                  if (value && value > 0) retention[key] = value;
                  else delete retention[key];
                  setDraft({ ...draft, retention });
                }}
              />
            </Field>
          ))}
        </div>
        <Row>
          <Button
            size="sm"
            disabled={busy || dirty || !Object.keys(state.policies.retention).length}
            title={dirty ? "Save your changes first" : undefined}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await governanceApi.runRetention();
                setNotice(`Retention ran: ${result.chats} chats, ${result.uploads} files and ${result.notifications} notifications deleted.`);
              } catch (cause) {
                setError(errorText(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            Run now
          </Button>
        </Row>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="positive">{notice}</Notice> : null}
      <Row>
        <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
          Save policies
        </Button>
        {dirty ? (
          <Button variant="ghost" disabled={busy} onClick={() => setDraft(state.policies)}>
            Discard changes
          </Button>
        ) : null}
      </Row>
    </Stack>
  );
}

/** Actions waiting for an admin's second approval (refreshed every 10 s). */
function SecondApprovalQueue() {
  const [items, setItems] = useState<AdminSecondApprovalItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await governanceApi.approvals());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (items.length === 0 && !error) return null;
  const decide = async (id: string, decision: "approve" | "decline") => {
    setBusy(id);
    try {
      await governanceApi.decide(id, decision);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card>
      <CardHeader title="Waiting for your approval" meta="The person already approved these. They run once an admin approves." />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <ul className={styles.rows}>
        {items.map(({ approval, requestedBy }) => (
          <li key={approval.id} className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>
                {approval.title}
                {approval.risk === "high" ? <Badge tone="danger">High risk</Badge> : null}
              </span>
              <span className={styles.rowMeta}>{approval.summary}</span>
              <span className={styles.rowMeta}>Asked by {requestedBy.name ?? requestedBy.email ?? requestedBy.kind}</span>
            </span>
            <span className={styles.rowEnd}>
              <Button size="sm" disabled={busy === approval.id} onClick={() => void decide(approval.id, "approve")}>
                Approve
              </Button>
              <Button size="sm" disabled={busy === approval.id} onClick={() => void decide(approval.id, "decline")}>
                Decline
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
