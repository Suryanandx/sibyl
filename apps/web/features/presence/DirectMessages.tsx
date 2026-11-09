"use client";

/**
 * Direct messages in the agent editor's "Slack and Teams" section: people
 * can message the agent in a Slack DM (or group DM with the app) and in a
 * Teams 1:1 or group chat with the workspace's account. Per provider: on or
 * off, when it answers, and who may write. Changes save straight away.
 */
import type { PresenceAgentState, PresenceDirectAllow, PresenceDirectView, PresenceProvider, PresenceRespondMode } from "@open-gpt-live/protocol";
import { Badge, Checkbox, Field, Muted, Notice, Select } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { DIRECT_ALLOW_OPTIONS, DIRECT_RESPOND_OPTIONS, PROVIDER_NAMES, removeDirect, setDirect } from "./api";
import styles from "./presence.module.css";

export function DirectMessages({
  agentId,
  agentName,
  state,
  busy,
  run
}: {
  agentId: string;
  agentName: string;
  state: PresenceAgentState;
  busy: boolean;
  run: (task: () => Promise<PresenceAgentState>) => Promise<boolean>;
}) {
  return (
    <fieldset className={styles.notify} disabled={!state.canEdit || busy}>
      <legend>Direct messages: people can also message {agentName} directly</legend>
      <div className={styles.directList}>
        {(["slack", "teams"] as const).map((provider) => {
          const current = (state.direct ?? []).find((d) => d.provider === provider);
          const status = state.providers.find((p) => p.provider === provider)?.direct;
          return (
            <DirectRow
              key={provider}
              provider={provider}
              current={current}
              available={Boolean(status?.available)}
              reason={status?.reason}
              onEnable={(on) => void run(() => (on ? setDirect(agentId, provider, { respond: "all", allow: "members" }) : removeDirect(agentId, provider)))}
              onChange={(respond, allow) => void run(() => setDirect(agentId, provider, { respond, allow }))}
            />
          );
        })}
      </div>
    </fieldset>
  );
}

function DirectRow({
  provider,
  current,
  available,
  reason,
  onEnable,
  onChange
}: {
  provider: PresenceProvider;
  current: PresenceDirectView | undefined;
  available: boolean;
  reason: string | undefined;
  onEnable(on: boolean): void;
  onChange(respond: PresenceRespondMode, allow: PresenceDirectAllow): void;
}) {
  const where = provider === "slack" ? "a DM or group DM with the Sibyl app" : "a 1:1 or group chat with the workspace's Microsoft 365 account";
  return (
    <div className={styles.item}>
      <div className={styles.itemHead}>
        <Checkbox label={`Answer in ${PROVIDER_NAMES[provider]}`} checked={Boolean(current)} disabled={!current && !available} onChange={(event) => onEnable(event.target.checked)} />
        {current ? (
          <Badge tone={current.status === "active" ? "positive" : current.status === "pending" ? "info" : "warning"}>
            {current.status === "active" ? "Active" : current.status === "pending" ? "Connecting" : "Needs attention"}
          </Badge>
        ) : null}
      </div>
      {!current && !available && reason ? <Notice tone="warning">{reason}</Notice> : null}
      {current ? (
        <>
          {current.statusMessage ? <Muted className={styles.warn}>{current.statusMessage}</Muted> : null}
          <div className={styles.pickers}>
            <Field label="Answers">
              <Select value={current.respond} onChange={(event) => onChange(event.target.value as PresenceRespondMode, current.allow)}>
                {DIRECT_RESPOND_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Who can message it">
              <Select value={current.allow} onChange={(event) => onChange(current.respond, event.target.value as PresenceDirectAllow)}>
                {DIRECT_ALLOW_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Muted>
            People write to it in {where}. It acts like in a channel: only the workspace&apos;s shared connections, its autonomy and budget.
            {current.lastActivityAt ? ` Last answered ${relativeTime(current.lastActivityAt)}.` : ""}
          </Muted>
        </>
      ) : null}
    </div>
  );
}
