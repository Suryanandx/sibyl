"use client";

/**
 * The workspace's notifications channel for Slack or Teams, shown in the
 * Slack and Microsoft 365 integration panels. Slack sends people direct
 * messages first (matched by e-mail) and uses this channel as the fallback;
 * Teams posts here.
 */
import { useEffect, useState } from "react";
import type { PresenceChannelRef, PresenceProvider, PresenceWorkspaceSettings } from "@open-gpt-live/protocol";
import { Button, Muted, Notice, Row } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { fetchPresenceSettings, placeLabel, savePresenceSettings } from "./api";
import { ChannelPicker } from "./ChannelPicker";
import styles from "./presence.module.css";

/** Which presence provider a connector card stands for. */
export function presenceProviderOf(connectorId: string): PresenceProvider | undefined {
  return connectorId === "slack" ? "slack" : connectorId === "microsoft" ? "teams" : undefined;
}

export function NotificationsChannel({ provider }: { provider: PresenceProvider }) {
  const [settings, setSettings] = useState<PresenceWorkspaceSettings>();
  const [choice, setChoice] = useState<PresenceChannelRef>();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "positive"; text: string }>();

  useEffect(() => {
    fetchPresenceSettings()
      .then(setSettings)
      .catch(() => setSettings(undefined));
  }, []);

  if (!settings) return null;
  const status = settings.providers.find((p) => p.provider === provider);
  const current = settings[provider];
  const save = async (value: PresenceChannelRef | null) => {
    try {
      setSettings(await savePresenceSettings({ [provider]: value }));
      setEditing(false);
      setMessage({ tone: "positive", text: value ? "Notifications channel saved." : "Notifications channel removed." });
    } catch (error) {
      setMessage({ tone: "danger", text: errorText(error) });
    }
  };

  return (
    <section className={styles.panelSection}>
      <h3>Notifications and agents</h3>
      <Muted>
        {provider === "slack"
          ? "Monitors and agents can notify people in Slack: by direct message (matched by e-mail), else in the channel below. Agents join channels from their own settings (Agents → an agent → Slack and Teams)."
          : "Monitors and agents can notify in a Teams channel (everyone in it sees the notice). Agents join channels from their own settings (Agents → an agent → Slack and Teams)."}
      </Muted>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {status && !status.available ? <Muted className={styles.warn}>{status.reason}</Muted> : null}
      <Row>
        <span>Notifications channel: {current ? <strong>{placeLabel({ provider, ...current })}</strong> : <em>none</em>}</span>
      </Row>
      {settings.canManage ? (
        editing ? (
          <div className={styles.form}>
            <ChannelPicker provider={provider} value={choice} onChange={setChoice} />
            <Row>
              <Button variant="primary" disabled={!choice} onClick={() => choice && void save(choice)}>
                Save
              </Button>
              <Button onClick={() => setEditing(false)}>Cancel</Button>
            </Row>
          </div>
        ) : (
          <Row>
            <Button size="sm" disabled={!status?.available && provider === "teams"} onClick={() => setEditing(true)}>
              {current ? "Change…" : "Choose…"}
            </Button>
            {current ? (
              <Button size="sm" variant="ghost" onClick={() => void save(null)}>
                Remove
              </Button>
            ) : null}
          </Row>
        )
      ) : null}
    </section>
  );
}
