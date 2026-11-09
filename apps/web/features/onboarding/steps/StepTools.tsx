"use client";

import { useCallback, useEffect, useState } from "react";
import type { IntegrationConnectorView, IntegrationsState } from "@open-gpt-live/protocol";
import { Badge, Button, ButtonLink, Muted, Notice } from "../../../components/ui";
import { errorText } from "../../../lib/gateway-http";
import { paths } from "../../../lib/routes";
import { fetchIntegrations, isConsentMessage, openConsent, startConnect } from "../../integrations/api";
import { ConnectorGlyph } from "../../integrations/glyphs";
import { StepLayout } from "../OnboardingFlow";
import styles from "../onboarding.module.css";

/** The connectors offered here, in order. */
const OFFERED = ["google", "microsoft", "slack"];

/** Connect your tools (optional): one click each, shared with the workspace when allowed. */
export function StepTools() {
  const [state, setState] = useState<IntegrationsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await fetchIntegrations());
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    const onMessage = (event: MessageEvent) => {
      if (isConsentMessage(event)) void reload();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("message", onMessage);
    };
  }, [reload]);

  const connectors = OFFERED.map((id) => state?.connectors.find((c) => c.id === id)).filter((c): c is IntegrationConnectorView => Boolean(c?.available));
  const connectedIds = new Set((state?.connections ?? []).filter((c) => c.status === "connected").map((c) => c.connectorId));
  const shared = Boolean(state?.can.connectShared);

  async function connect(connector: IntegrationConnectorView): Promise<void> {
    setBusy(connector.id);
    setError(null);
    try {
      const groups = connector.groups.filter((group) => group.allowed && group.defaultEnabled).map((group) => group.id);
      const result = await startConnect(connector.id, { scope: shared ? "workspace" : "personal", groups });
      if (result.authorizeUrl) openConsent(result.authorizeUrl);
      else await reload();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <StepLayout
      title="Connect your tools"
      lead={
        shared
          ? "Let Sibyl read your calendar, email and files when you ask. Connections are shared with your workspace, and anything that sends or changes something asks you first."
          : "Let Sibyl read your calendar, email and files when you ask. Anything that sends or changes something asks you first."
      }
      hideSkip={connectedIds.size > 0}
      skipNote="You can connect these later in Integrations."
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {state?.unavailableReason ? <Notice>{state.unavailableReason}</Notice> : null}
      {!state && !error ? <Muted>Loading…</Muted> : null}
      {state && connectors.length === 0 && !state.unavailableReason ? <Muted>No tools are available on this server yet.</Muted> : null}
      <ul className={styles.tiles}>
        {connectors.map((connector) => {
          const done = connectedIds.has(connector.id);
          const needsApp = connector.app ? !connector.app.configured && !connector.authKinds.includes("apiKey") : false;
          const apiKeyOnly = !connector.authKinds.includes("oauth2");
          const canConnect = shared || Boolean(state?.can.connectPersonal);
          return (
            <li key={connector.id} className={styles.tile}>
              <span className={styles.tileGlyph}>
                <ConnectorGlyph id={connector.id} />
              </span>
              <span className={styles.tileText}>
                <strong>{connector.name}</strong>
                <span>{connector.description}</span>
              </span>
              <span className={styles.tileAction}>
                {done ? (
                  <Badge tone="positive">Connected</Badge>
                ) : needsApp || apiKeyOnly ? (
                  state?.can.manageApps ? (
                    <ButtonLink size="sm" href={`${paths.integrations}?connector=${encodeURIComponent(connector.id)}`}>
                      Set up
                    </ButtonLink>
                  ) : (
                    <Muted as="span" className={styles.small}>
                      Needs an admin
                    </Muted>
                  )
                ) : (
                  <Button size="sm" disabled={!canConnect || busy !== null} onClick={() => void connect(connector)}>
                    {busy === connector.id ? "Opening…" : "Connect"}
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </StepLayout>
  );
}
