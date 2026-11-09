/**
 * Live integrations status on the WebSocket: `integrations.request` →
 * `integrations.state`, and a fresh `integrations.state` whenever a
 * connection changes (connected, refreshed, needs reconnect, removed).
 * Each socket gets only what its person may see; never a token.
 */
import type { Principal } from "@open-gpt-live/core";
import { INTEGRATIONS_EVENTS, type IntegrationsStateMessage } from "@open-gpt-live/protocol";
import type { ConnectorService } from "./service.js";

export interface IntegrationsSession {
  /** Send the current state now. */
  push(): Promise<void>;
  dispose(): void;
}

export function connectIntegrations(input: {
  connectors: ConnectorService | undefined;
  principal(): Principal;
  workspaceId(): string;
  send(message: IntegrationsStateMessage): void;
}): IntegrationsSession {
  const { connectors } = input;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = async (): Promise<void> => {
    if (disposed) return;
    if (!connectors) {
      input.send({
        type: INTEGRATIONS_EVENTS.STATE,
        connectors: [],
        connections: [],
        can: { use: false, connectPersonal: false, connectShared: false, manageApps: false },
        unavailableReason: "Integrations need the secrets vault (set SIBYL_SECRET_KEY or keep data/secret.key)."
      });
      return;
    }
    const state = await connectors.stateFor(input.principal(), input.workspaceId());
    if (!disposed) input.send({ type: INTEGRATIONS_EVENTS.STATE, ...state });
  };
  // Coalesce bursts of changes into one push.
  const unsubscribe = connectors?.onChange(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void push().catch(() => undefined);
    }, 50);
  });
  return {
    push,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    }
  };
}
