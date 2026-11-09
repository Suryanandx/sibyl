"use client";

/**
 * Daily and monthly spending caps: the organization's (Admin → Organization)
 * and a workspace's (Settings → Workspace). Empty means no cap. The usage
 * meter enforces them; near 85% Sibyl switches to the Cheapest preset.
 */
import { useEffect, useState, type FormEvent } from "react";
import settings from "../../components/settings/settings.module.css";
import { Button, Card, CardHeader, Field, Input, Muted, Notice, Row } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";

export interface Caps {
  dailyUsd?: number;
  monthlyUsd?: number;
}

const text = (value: number | undefined) => (value === undefined ? "" : String(value));
const usd = (value: number) => (value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);

export function BudgetCard(props: {
  title: string;
  meta: string;
  budget: Caps;
  /** Upper bounds (the server's env caps). */
  limits?: Caps;
  spent?: { todayUsd: number; monthUsd: number };
  canEdit: boolean;
  onSave(patch: { dailyUsd: number | null; monthlyUsd: number | null }): Promise<void>;
}) {
  const [daily, setDaily] = useState(text(props.budget.dailyUsd));
  const [monthly, setMonthly] = useState(text(props.budget.monthlyUsd));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDaily(text(props.budget.dailyUsd));
    setMonthly(text(props.budget.monthlyUsd));
  }, [props.budget.dailyUsd, props.budget.monthlyUsd]);

  const dirty = daily.trim() !== text(props.budget.dailyUsd) || monthly.trim() !== text(props.budget.monthlyUsd);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parse = (value: string) => (value.trim() === "" ? null : Number(value));
    const patch = { dailyUsd: parse(daily), monthlyUsd: parse(monthly) };
    if ([patch.dailyUsd, patch.monthlyUsd].some((v) => v !== null && (!Number.isFinite(v) || v < 0))) {
      setError("Enter an amount in USD, or leave it empty for no budget.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await props.onSave(patch);
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const hint = (limit: number | undefined, envName: string, spent: number | undefined, period: string) =>
    [
      spent !== undefined ? `${usd(spent)} spent ${period}.` : null,
      limit !== undefined ? `Up to $${limit} (${envName}); empty uses $${limit}.` : "Empty: no budget."
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <Card as="form" onSubmit={(event) => void save(event)}>
      <CardHeader title={props.title} meta={props.meta} />
      <div className={settings.fieldRow}>
        <Field label="Daily budget (USD)" hint={hint(props.limits?.dailyUsd, "SIBYL_BUDGET_DAILY_USD", props.spent?.todayUsd, "today")}>
          <Input inputMode="decimal" value={daily} placeholder="No budget" disabled={!props.canEdit} onChange={(event) => setDaily(event.target.value)} />
        </Field>
        <Field label="Monthly budget (USD)" hint={hint(props.limits?.monthlyUsd, "SIBYL_BUDGET_MONTHLY_USD", props.spent?.monthUsd, "this month")}>
          <Input inputMode="decimal" value={monthly} placeholder="No budget" disabled={!props.canEdit} onChange={(event) => setMonthly(event.target.value)} />
        </Field>
      </div>
      <Muted>When spending gets close to a budget (85%), Sibyl switches to cheaper models; at the budget, model calls pause until the next day or month.</Muted>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {props.canEdit ? (
        <Row>
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save budget"}
          </Button>
          {saved && !dirty ? (
            <Muted as="span">
              <span role="status">Saved</span>
            </Muted>
          ) : null}
        </Row>
      ) : null}
    </Card>
  );
}
