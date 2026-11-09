"use client";

/**
 * An agent's "Presence" section in the agent editor: the Slack and Teams
 * channels it works in, how it answers there, and where its "act, then tell
 * me" notices also go. Changes save straight away (separately from the rest
 * of the agent's settings).
 */
import { useCallback, useEffect, useId, useState } from "react";
import type { PresenceAgentState, PresenceChannelRef, PresenceProvider, PresenceRespondMode } from "@open-gpt-live/protocol";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Muted, Notice, Row, Select } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { relativeTime } from "../../lib/format";
import { PROVIDER_NAMES, RESPOND_OPTIONS, addBinding, fetchAgentPresence, placeLabel, removeBinding, setAgentNotify, updateBinding } from "./api";
import { ChannelPicker } from "./ChannelPicker";
import { DirectMessages } from "./DirectMessages";
import styles from "./presence.module.css";

export function PresenceSection({ agentId, agentName }: { agentId: string; agentName: string }) {
  const id = useId();
  const [state, setState] = useState<PresenceAgentState>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<PresenceProvider>("slack");
  const [channel, setChannel] = useState<PresenceChannelRef>();
  const [respond, setRespond] = useState<PresenceRespondMode>("mentions");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchAgentPresence(agentId)
      .then((next) => {
        setState(next);
        setError(undefined);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [agentId]);
  useEffect(load, [load]);
  // A Teams channel connects in the background (Graph checks the gateway first): look again until it settles.
  const connecting = [...(state?.bindings ?? []), ...(state?.direct ?? [])].some((b) => b.status === "pending");
  useEffect(() => {
    if (!connecting) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [connecting, load]);

  const run = async (task: () => Promise<PresenceAgentState>) => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await task());
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const available = state?.providers.filter((p) => p.available) ?? [];
  const chosen = state?.providers.find((p) => p.provider === provider);

  return (
    <Card aria-label="Presence">
      <CardHeader title="Slack and Teams" meta={`Channels and direct messages where ${agentName} answers. Anyone in a channel can talk to it there.`} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!state ? (
        !error ? <Muted>Loading…</Muted> : null
      ) : (
        <>
          {state.bindings.length ? (
            <ul className={styles.list}>
              {state.bindings.map((binding) => (
                <li key={binding.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <strong>{PROVIDER_NAMES[binding.provider]}</strong>
                    <span>{placeLabel(binding)}</span>
                    <Badge tone={binding.status === "active" ? "positive" : binding.status === "pending" ? "info" : "warning"}>
                      {binding.status === "active" ? "Active" : binding.status === "pending" ? "Connecting" : "Needs attention"}
                    </Badge>
                  </div>
                  {binding.statusMessage ? <Muted className={styles.warn}>{binding.statusMessage}</Muted> : null}
                  <Muted>
                    {binding.lastActivityAt ? `Last answered ${relativeTime(binding.lastActivityAt)}` : "Hasn't answered yet"}
                    {binding.createdByName ? ` · added by ${binding.createdByName}` : ""}
                  </Muted>
                  {state.canEdit ? (
                    <Row className={styles.itemActions}>
                      <Select
                        aria-label="How it answers"
                        value={binding.respond}
                        disabled={busy}
                        onChange={(event) => void run(() => updateBinding(agentId, binding.id, event.target.value as PresenceRespondMode))}
                      >
                        {RESPOND_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <Button variant="danger" size="sm" disabled={busy} onClick={() => void run(() => removeBinding(agentId, binding.id))}>
                        Remove
                      </Button>
                    </Row>
                  ) : (
                    <Muted>{RESPOND_OPTIONS.find((o) => o.id === binding.respond)?.label}</Muted>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Muted>Not in any channel yet.</Muted>
          )}

          {state.canEdit ? (
            adding ? (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!channel) return;
                  void run(() => addBinding(agentId, { provider, ...channel, respond })).then((ok) => {
                    if (!ok) return;
                    setAdding(false);
                    setChannel(undefined);
                  });
                }}
              >
                <Field label="Where">
                  <Select
                    id={`${id}-provider`}
                    value={provider}
                    onChange={(event) => {
                      setProvider(event.target.value as PresenceProvider);
                      setChannel(undefined);
                    }}
                  >
                    {state.providers.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {PROVIDER_NAMES[p.provider]}
                        {p.available ? "" : " (not set up)"}
                      </option>
                    ))}
                  </Select>
                </Field>
                {chosen?.available ? (
                  <>
                    <ChannelPicker provider={provider} value={channel} onChange={setChannel} />
                    <Field label="Answers">
                      <Select value={respond} onChange={(event) => setRespond(event.target.value as PresenceRespondMode)}>
                        {RESPOND_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Muted>
                      {provider === "teams"
                        ? "In Teams it posts as the workspace's Microsoft 365 account; @mention that account to ask."
                        : `In Slack it replies under its own name. Start a message with “@Sibyl ${agentName}” when several agents share a channel.`}{" "}
                      In channels it only uses the workspace&apos;s shared connections, never anyone&apos;s personal accounts.
                    </Muted>
                  </>
                ) : (
                  <Notice tone="warning">{chosen?.reason ?? "Not available."}</Notice>
                )}
                <Row>
                  <Button type="submit" variant="primary" disabled={busy || !chosen?.available || !channel}>
                    Add to channel
                  </Button>
                  <Button onClick={() => setAdding(false)}>Cancel</Button>
                </Row>
              </form>
            ) : (
              <Row>
                <Button
                  onClick={() => {
                    setProvider(available[0]?.provider ?? "slack");
                    setAdding(true);
                  }}
                >
                  Add to a channel…
                </Button>
                {available.length === 0 ? <Muted as="span">Connect Slack or Microsoft 365 for the workspace in Integrations first.</Muted> : null}
              </Row>
            )
          ) : null}

          <DirectMessages agentId={agentId} agentName={agentName} state={state} busy={busy} run={run} />

          <fieldset className={styles.notify} disabled={!state.canEdit || busy}>
            <legend>When it acts on its own (“Act, then tell me”), also tell me in</legend>
            {(["slack", "teams"] as const).map((p) => (
              <Checkbox
                key={p}
                label={PROVIDER_NAMES[p]}
                checked={state.notify.includes(p)}
                onChange={(event) => {
                  const next = event.target.checked ? [...state.notify, p] : state.notify.filter((x) => x !== p);
                  void run(() => setAgentNotify(agentId, next));
                }}
              />
            ))}
          </fieldset>
        </>
      )}
    </Card>
  );
}
