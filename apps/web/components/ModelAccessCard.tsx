"use client";

/**
 * Settings → Models → "Model access": which OpenRouter key Sibyl uses for
 * this organization (its own key, the server's, or AI credits on hosted
 * Sibyl), what the key can still spend, and replacing or removing it.
 * Saving or removing the key reconnects the app (the gateway rebuilds the
 * organization for the new key).
 */
import { useCallback, useEffect, useState } from "react";
import type { CreditsView, ModelAccessView } from "@open-gpt-live/protocol";
import { useAppSession } from "../lib/app-session";
import { errorText, gatewayRequest } from "../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Field, Input, Muted, Notice, Row, Stack } from "./ui";

const usd = (value: number) => `$${value.toFixed(value < 10 ? 2 : 0)}`;

function keyCredit(view: ModelAccessView): string {
  const key = view.key;
  if (!key) return "";
  if (key.remainingUsd === null || key.remainingUsd === undefined) return key.usageUsd !== undefined ? `No spending limit · ${usd(key.usageUsd)} used` : "No spending limit";
  return `${usd(key.remainingUsd)} left${key.limitUsd !== null && key.limitUsd !== undefined ? ` of ${usd(key.limitUsd)}` : ""}`;
}

function modeLine(view: ModelAccessView, credits: CreditsView | null): string {
  if (view.mode === "byok") return "Every model call uses your organization's OpenRouter key.";
  if (view.mode === "credits") return `Model calls run on Sibyl AI credits${credits ? ` (${usd(credits.balanceUsd)} left)` : ""}. Add your own OpenRouter key to pay OpenRouter directly.`;
  if (view.serverKey) return "Model calls use the OpenRouter key set on this server. Add your own to use it instead.";
  return "No model key yet. Add your OpenRouter key to start.";
}

export function ModelAccessCard() {
  const { can } = useAppSession();
  const mayChange = can("org.settings");
  const mayBuy = can("org.billing");
  const [view, setView] = useState<ModelAccessView | null>(null);
  const [credits, setCredits] = useState<CreditsView | null>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      const next = await gatewayRequest<ModelAccessView>(`/api/model-access${refresh ? "?refresh=1" : ""}`);
      setView(next);
      setCredits(next.hosted ? await gatewayRequest<CreditsView>("/api/credits").catch(() => null) : null);
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const next = await gatewayRequest<ModelAccessView>("/api/model-access/key", { method: "PUT", body: { key } });
      setView(next);
      setKey("");
      setEditing(false);
      setSaved("Key saved. Sibyl reconnects to use it.");
    });

  const remove = () =>
    run(async () => {
      await gatewayRequest("/api/model-access/key", { method: "DELETE" });
      setSaved("Key removed.");
      await load();
    });

  const buy = (amountUsd: number) =>
    run(async () => {
      const result = await gatewayRequest<{ status: string; checkoutUrl?: string }>("/api/credits/purchase", { method: "POST", body: { amountUsd } });
      if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
      else await load();
    });

  if (!view) {
    return (
      <Card>
        <CardHeader title="Model access" />
        {error ? <Notice tone="danger">{error}</Notice> : <Muted>Checking…</Muted>}
      </Card>
    );
  }

  const showForm = mayChange && (editing || !view.key);
  return (
    <Card>
      <CardHeader
        title="Model access"
        meta={modeLine(view, credits)}
        actions={view.key ? <Badge tone="positive">Your key</Badge> : view.mode === "credits" ? <Badge>AI credits</Badge> : null}
      />
      <Stack gap={12}>
        {view.key ? (
          <Row>
            <span>
              OpenRouter key ••••{view.key.last4}
              {view.key.label ? ` · ${view.key.label}` : ""}
            </span>
            <Muted as="span">{keyCredit(view)}</Muted>
          </Row>
        ) : null}
        {credits && view.mode === "credits" ? (
          <Row>
            <span>AI credits: {usd(credits.balanceUsd)}</span>
            {credits.marginPercent > 0 ? <Muted as="span">OpenRouter's price + {credits.marginPercent}%</Muted> : null}
            {mayBuy && credits.purchase.available ? (
              <Button size="sm" onClick={() => void buy(10)} disabled={busy}>
                Add $10 of credits
              </Button>
            ) : null}
          </Row>
        ) : null}
        {showForm ? (
          <Field label={view.key ? "New OpenRouter key" : "Your OpenRouter key"} hint="Checked with OpenRouter before it is saved. Stored encrypted; never shown again.">
            <Input type="password" mono autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" value={key} onChange={(event) => setKey(event.target.value)} />
          </Field>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {saved ? <Notice tone="positive">{saved}</Notice> : null}
        {mayChange ? (
          <Row>
            {showForm ? (
              <Button variant="primary" onClick={() => void save()} disabled={busy || key.trim().length < 20}>
                {busy ? "Checking…" : "Save key"}
              </Button>
            ) : null}
            {view.key && !editing ? <Button onClick={() => setEditing(true)}>Replace key</Button> : null}
            {view.key && editing ? <Button variant="ghost" onClick={() => (setEditing(false), setKey(""))}>Cancel</Button> : null}
            {view.key ? <Button variant="ghost" onClick={() => void load(true)} disabled={busy}>Check credit</Button> : null}
            {view.key ? (
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                Remove key
              </Button>
            ) : null}
          </Row>
        ) : (
          <Muted>Only organization owners and admins can change the model key.</Muted>
        )}
      </Stack>
    </Card>
  );
}
