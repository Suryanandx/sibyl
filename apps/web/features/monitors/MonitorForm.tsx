"use client";

import { useId, useMemo, useState } from "react";
import type { MonitorChannelOption, MonitorChannelView, MonitorSaveResponse, MonitorSourceOption, MonitorTestResult, MonitorView } from "@open-gpt-live/protocol";
import type { MonitorsApi } from "./api";
import { formatUsd } from "../../lib/format";
import { FREQUENCIES, OPS, emptyForm, formFromView, formToInput, schemaFields, type MonitorFormState, type SourceKind } from "./form-state";
import { Button, Card, Checkbox, Field, Input, Notice, Select, Tabs, Textarea } from "../../components/ui";
import styles from "./monitors.module.css";

export interface MonitorFormProps {
  api: MonitorsApi;
  sources: MonitorSourceOption[];
  channels: MonitorChannelOption[];
  agents?: Array<{ id: string; name: string }>;
  /** Editing this monitor (absent: a new one). */
  monitor?: MonitorView;
  onSaved(result: MonitorSaveResponse): void;
  onCancel(): void;
}

const KINDS: Array<{ kind: SourceKind; label: string; hint: string }> = [
  { kind: "tool", label: "Connected app", hint: "Results of a read action, e.g. search deals or emails." },
  { kind: "rss", label: "RSS feed", hint: "New posts in a feed." },
  { kind: "webpage", label: "Web page", hint: "Changes to a page's text." },
  { kind: "webhook", label: "Webhook", hint: "Another system tells Sibyl." }
];

const CHANNEL_LABEL: Record<MonitorChannelView, string> = { inbox: "Inbox", email: "Email", slack: "Slack", teams: "Teams" };

/** Create or edit a monitor, with a dry run ("Test now"). */
export function MonitorForm(props: MonitorFormProps) {
  const id = useId();
  const [form, setForm] = useState<MonitorFormState>(() => (props.monitor ? formFromView(props.monitor) : { ...emptyForm(), kind: props.sources.length ? "tool" : "rss", toolName: props.sources[0]?.toolName ?? "" }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<MonitorTestResult | null>(null);
  const set = <K extends keyof MonitorFormState>(key: K, value: MonitorFormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const tool = useMemo(() => props.sources.find((s) => s.toolName === form.toolName), [props.sources, form.toolName]);
  const fields = schemaFields(tool?.inputSchema);

  const run = async (what: "save" | "test") => {
    const input = formToInput(form);
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setError(null);
    setBusy(what);
    try {
      if (what === "test") {
        setTest(await props.api.test({ input }));
      } else {
        props.onSaved(props.monitor ? await props.api.update(props.monitor.id, input) : await props.api.create(input));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const toggleChannel = (channel: MonitorChannelView, on: boolean) =>
    set("channels", on ? [...new Set([...form.channels, channel])] : form.channels.filter((c) => c !== channel));

  return (
    <Card
      as="form"
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void run("save");
      }}
    >
      <Field label="Name">
        <Input value={form.name} maxLength={120} placeholder="Big deals in Negotiation" onChange={(e) => set("name", e.target.value)} />
      </Field>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>Watch</legend>
        <Tabs
          label="Source"
          value={form.kind}
          onChange={(kind) => set("kind", kind)}
          options={KINDS.filter((option) => option.kind !== "tool" || props.sources.length > 0 || form.kind === "tool").map((option) => ({ value: option.kind, label: option.label }))}
        />
        <p className={styles.hint}>{KINDS.find((k) => k.kind === form.kind)?.hint}</p>
        {form.kind === "tool" && (
          <>
            <Select aria-label="Read action" value={form.toolName} onChange={(e) => set("toolName", e.target.value)}>
              {props.sources.map((source) => (
                <option key={source.toolName} value={source.toolName}>
                  {source.title}
                  {source.provider ? ` · ${source.provider}` : ""}
                </option>
              ))}
            </Select>
            {tool && <p className={styles.hint}>{tool.description}</p>}
            <label htmlFor={`${id}-input`} className={styles.subLabel}>
              Input (JSON){fields.length ? ` — fields: ${fields.join(", ")}` : ""}
            </label>
            <Textarea id={`${id}-input`} mono className={styles.short} rows={3} value={form.toolInput} onChange={(e) => set("toolInput", e.target.value)} spellCheck={false} />
          </>
        )}
        {(form.kind === "rss" || form.kind === "webpage") && (
          <Input
            type="url"
            inputMode="url"
            aria-label="Address"
            placeholder={form.kind === "rss" ? "https://example.com/feed.xml" : "https://example.com/pricing"}
            value={form.url}
            onChange={(e) => set("url", e.target.value)}
          />
        )}
        {form.kind === "webhook" && (
          <p className={styles.hint}>When you save, Sibyl creates a signing secret and shows the address to POST to. Each delivery is checked right away.</p>
        )}
      </fieldset>

      {form.kind !== "webhook" && (
        <Field label="How often">
          <Select value={form.everyMinutes} onChange={(e) => set("everyMinutes", Number(e.target.value))}>
            {FREQUENCIES.map((f) => (
              <option key={f.minutes} value={f.minutes}>{f.label}</option>
            ))}
          </Select>
        </Field>
      )}

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>When</legend>
        <p className={styles.hint}>Filters are free and run first. Fields are paths into each item, like <code>amount</code> or <code>properties.dealstage</code>.</p>
        {form.filters.map((row, index) => (
          <div key={index} className={styles.filterRow}>
            <Input aria-label="Field" placeholder="amount" value={row.path} onChange={(e) => set("filters", form.filters.map((r, i) => (i === index ? { ...r, path: e.target.value } : r)))} />
            <Select aria-label="Test" value={row.op} onChange={(e) => set("filters", form.filters.map((r, i) => (i === index ? { ...r, op: e.target.value as typeof row.op } : r)))}>
              {OPS.map((o) => (
                <option key={o.op} value={o.op}>{o.label}</option>
              ))}
            </Select>
            <Input aria-label="Value" placeholder={row.op === "changed" ? "(any)" : "50000"} value={row.value} disabled={row.op === "exists"} onChange={(e) => set("filters", form.filters.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))} />
            <Button variant="ghost" size="sm" aria-label="Remove filter" onClick={() => set("filters", form.filters.filter((_, i) => i !== index))}>
              Remove
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => set("filters", [...form.filters, { path: "", op: "eq", value: "" }])}>
            Add filter
          </Button>
        </div>
        <label htmlFor={`${id}-ask`} className={styles.subLabel}>In plain words (optional)</label>
        <Textarea
          id={`${id}-ask`}
          className={styles.short}
          rows={2}
          maxLength={1000}
          placeholder="A deal over $50k moves to Negotiation"
          value={form.ask}
          onChange={(e) => set("ask", e.target.value)}
        />
        <p className={styles.hint}>A small model checks only new items that passed the filters. It costs a little per check with new items.</p>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>Then</legend>
        <div className={styles.checks}>
          {props.channels.map((option) => (
            <Checkbox
              key={option.channel}
              title={option.available ? undefined : option.reason}
              checked={form.channels.includes(option.channel)}
              disabled={!option.available && !form.channels.includes(option.channel)}
              onChange={(e) => toggleChannel(option.channel, e.target.checked)}
              label={
                <>
                  {CHANNEL_LABEL[option.channel]}
                  {!option.available && <span className={styles.muted}> — {option.reason}</span>}
                </>
              }
            />
          ))}
        </div>
        <Checkbox checked={form.taskOn} onChange={(e) => set("taskOn", e.target.checked)} label="Start a task" />
        {form.taskOn && (
          <>
            <Textarea
              className={styles.short}
              rows={2}
              aria-label="Task"
              maxLength={4000}
              placeholder="Draft a follow-up email for each deal"
              value={form.task}
              onChange={(e) => set("task", e.target.value)}
            />
            {props.agents && props.agents.length > 0 && (
              <Select aria-label="Run as agent" value={form.agentId} onChange={(e) => set("agentId", e.target.value)}>
                <option value="">Run as Sibyl</option>
                {props.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>Run as {agent.name}</option>
                ))}
              </Select>
            )}
            <p className={styles.hint}>Actions that change things still need your approval, unless the agent is allowed to act on its own.</p>
          </>
        )}
      </fieldset>

      <details className={styles.details}>
        <summary>Budget and advanced</summary>
        <Field label="Daily budget (USD)">
          <Input inputMode="decimal" value={form.dailyBudget} placeholder="No cap" onChange={(e) => set("dailyBudget", e.target.value)} />
        </Field>
        <Field label="Item id field">
          <Input value={form.keyPath} placeholder="Automatic (id, guid, link)" onChange={(e) => set("keyPath", e.target.value)} />
        </Field>
      </details>

      {error && <Notice tone="danger">{error}</Notice>}

      {test && <TestResult result={test} />}

      <div className={styles.formActions}>
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button disabled={busy !== null || form.kind === "webhook"} onClick={() => void run("test")}>
          {busy === "test" ? "Testing…" : "Test now"}
        </Button>
        <Button type="submit" variant="primary" disabled={busy !== null}>
          {busy === "save" ? "Saving…" : props.monitor ? "Save changes" : "Create monitor"}
        </Button>
      </div>
    </Card>
  );
}

export function TestResult({ result }: { result: MonitorTestResult }) {
  return (
    <section className={styles.testResult} aria-live="polite">
      <p className={styles.testSummary}>
        <strong>{result.ok ? result.summary : result.error ?? result.summary}</strong>
        {result.costUsd > 0 && <span className={styles.muted}> · cost {formatUsd(result.costUsd)}</span>}
      </p>
      {result.ok && (
        <p className={styles.muted}>
          {result.fetched} fetched · {result.candidates} passed the filters · {result.matches.length} would fire
        </p>
      )}
      {result.matches.length > 0 && (
        <ul className={styles.matchList}>
          {result.matches.map((match) => (
            <li key={match.key}>
              {match.url ? (
                <a href={match.url} target="_blank" rel="noreferrer noopener">
                  {match.title}
                </a>
              ) : (
                match.title
              )}
              {match.reason && <span className={styles.muted}> — {match.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {result.note && <p className={styles.hint}>{result.note}</p>}
    </section>
  );
}
