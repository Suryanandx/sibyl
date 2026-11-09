"use client";

/**
 * Integrations: connect Google Workspace and Microsoft 365 (and, with
 * Sibyl Enterprise, HubSpot and Salesforce) so the assistant can use them.
 *
 * Mount it on the Integrations screen (`/integrations`). Optional props:
 * - `live`: the gateway socket, for pushed status (`integrations.state`);
 *   without it the screen reloads on focus and after each change.
 * - `mcp`: the socket hooks the existing ConnectionsPanel needs; shown
 *   under "Advanced: custom connector (MCP)".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INTEGRATIONS_EVENTS,
  type IntegrationConnectionView,
  type IntegrationConnectorView,
  type IntegrationsClientMessage,
  type IntegrationsServerMessage,
  type IntegrationsState
} from "@open-gpt-live/protocol";
import { ConnectionsPanel, type ConnectionsListener } from "../../components/ConnectionsPanel";
import type { ConnectionsClientMessage } from "@open-gpt-live/protocol";
import { fetchIntegrations, isConsentMessage } from "./api";
import { ConnectorPanel } from "./ConnectorPanel";
import { ConnectorGlyph } from "./glyphs";
import { relativeTime } from "../../lib/format";
import { Badge, Button, Card, Muted, Notice, Stack } from "../../components/ui";
import styles from "./integrations.module.css";
import { ENTERPRISE } from "../../lib/edition";

export interface IntegrationsLiveSocket {
  connected: boolean;
  send(message: IntegrationsClientMessage): boolean;
  subscribe(listener: (message: IntegrationsServerMessage) => void): () => void;
}

export interface IntegrationsMcpHooks {
  connected: boolean;
  send(message: ConnectionsClientMessage): boolean;
  subscribe(listener: ConnectionsListener): () => void;
}

export interface IntegrationsScreenProps {
  live?: IntegrationsLiveSocket;
  mcp?: IntegrationsMcpHooks;
}

export function IntegrationsScreen({ live, mcp }: IntegrationsScreenProps) {
  const [state, setState] = useState<IntegrationsState | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  // ?connector=<id> opens that connector's panel (links from onboarding and the checklist).
  const [openId, setOpenId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("connector")
  );
  const [mcpOpen, setMcpOpen] = useState(false);
  const loading = useRef(false);

  const reload = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      setState(await fetchIntegrations());
      setError(null);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      setError({ status, message: err instanceof Error ? err.message : "Couldn't load integrations." });
    } finally {
      loading.current = false;
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

  // Live status from the socket, when the shell passes it in.
  useEffect(() => {
    if (!live) return;
    const unsubscribe = live.subscribe((message) => {
      if (message.type !== INTEGRATIONS_EVENTS.STATE) return;
      const { type: _type, ...next } = message;
      setState(next);
    });
    if (live.connected) live.send({ type: INTEGRATIONS_EVENTS.REQUEST });
    return unsubscribe;
  }, [live, live?.connected]);

  const connectors = state?.connectors ?? [];
  const oss = connectors.filter((c) => c.edition === "oss");
  const enterprise = connectors.filter((c) => c.edition === "enterprise");
  const open = connectors.find((c) => c.id === openId);
  const byConnector = useMemo(() => {
    const map = new Map<string, IntegrationConnectionView[]>();
    for (const connection of state?.connections ?? []) map.set(connection.connectorId, [...(map.get(connection.connectorId) ?? []), connection]);
    return map;
  }, [state?.connections]);

  return (
    <Stack gap={20}>
      {error ? <Notice tone="danger">{error.status === 403 ? "You don't have access to integrations in this workspace." : error.message}</Notice> : null}
      {state?.unavailableReason ? <Notice>{state.unavailableReason}</Notice> : null}

      {!state && !error ? <Muted>Loading…</Muted> : null}

      {state ? (
        <>
          <section className={styles.grid} aria-label="Connectors">
            {oss.map((connector) => (
              <ConnectorCard key={connector.id} connector={connector} connections={byConnector.get(connector.id) ?? []} onOpen={() => setOpenId(connector.id)} />
            ))}
          </section>

          <h2 className={styles.sectionTitle}>Business apps</h2>
          <section className={styles.grid} aria-label="Business connectors">
            {enterprise.map((connector) => (
              <ConnectorCard key={connector.id} connector={connector} connections={byConnector.get(connector.id) ?? []} onOpen={() => setOpenId(connector.id)} />
            ))}
          </section>

          <section className={styles.advanced} aria-labelledby="integrations-advanced">
            <h2 id="integrations-advanced" className={styles.sectionTitle}>
              Advanced: custom connector (MCP)
            </h2>
            <Muted>
              Anything else can be connected through the Model Context Protocol: add an MCP server and choose which of its tools Sibyl may use.
            </Muted>
            {mcp ? (
              mcpOpen ? null : (
                <div>
                  <Button size="sm" onClick={() => setMcpOpen(true)}>
                    Manage custom connectors
                  </Button>
                </div>
              )
            ) : (
              <Muted>Custom connectors are managed by workspace owners and admins. Ask one if you need an MCP server added.</Muted>
            )}
          </section>
        </>
      ) : null}

      {open && state ? (
        <ConnectorPanel
          connector={open}
          connections={byConnector.get(open.id) ?? []}
          can={state.can}
          onState={setState}
          onChanged={() => void reload()}
          onClose={() => setOpenId(null)}
        />
      ) : null}

      {mcp && mcpOpen ? (
        // Advanced: custom connectors (MCP) shown inline on this screen, not in a dialog.
        <section aria-label="Custom connectors (MCP)">
          <ConnectionsPanel connected={mcp.connected} send={mcp.send} subscribe={mcp.subscribe} />
        </section>
      ) : null}
    </Stack>
  );
}

function ConnectorCard(props: { connector: IntegrationConnectorView; connections: IntegrationConnectionView[]; onOpen: () => void }) {
  const { connector, connections } = props;
  const locked = connector.edition === "enterprise" && !connector.available;
  const needsSetup = connector.available && connector.app && !connector.app.configured && !connector.authKinds.includes("apiKey");
  const problem = connections.find((c) => c.status !== "connected");
  return (
    <Card as="article" className={locked ? styles.cardLocked : undefined}>
      <div className={styles.cardHead}>
        <span className={styles.glyph}>
          <ConnectorGlyph id={connector.id} />
        </span>
        <div className={styles.cardTitle}>
          <h3>{connector.name}</h3>
        </div>
        {locked ? (
          <Badge tone="accent">Enterprise</Badge>
        ) : problem ? (
          <Badge tone="warning">{problem.status === "reconnect" ? "Reconnect" : "Problem"}</Badge>
        ) : connections.length ? (
          <Badge tone="positive">Connected</Badge>
        ) : needsSetup ? (
          <Badge tone="outline">Not set up</Badge>
        ) : null}
      </div>
      <p className={styles.description}>{connector.description}</p>

      {locked ? (
        <p className={styles.small}>
          Comes with {ENTERPRISE.name} by {ENTERPRISE.by}. A licence with <code>{connector.feature}</code> turns it on (Settings → Licence).
        </p>
      ) : connections.length ? (
        <ul className={styles.connList}>
          {connections.map((connection) => (
            <li key={connection.id}>
              <span className={`${styles.dot} ${connection.status === "connected" ? styles.dotOk : styles.dotWarn}`} aria-hidden />
              <span>
                {connection.scope === "personal" ? "You" : "Workspace"}
                {connection.account ? ` · ${connection.account}` : ""}
              </span>
              {connection.lastUsedAt ? <span className={styles.muted}> · used {relativeTime(connection.lastUsedAt)}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.small}>{needsSetup ? "An organization admin needs to add the app credentials first." : "Not connected yet."}</p>
      )}

      <div className={styles.cardActions}>
        <Button size="sm" variant={locked || connections.length ? "secondary" : "primary"} onClick={props.onOpen}>
          {locked ? "Learn more" : connections.length ? "Manage" : needsSetup ? "Set up" : "Connect"}
        </Button>
      </div>
    </Card>
  );
}
