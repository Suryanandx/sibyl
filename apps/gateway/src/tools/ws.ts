/**
 * WebSocket handlers for the Connections screen. The gateway dispatches every
 * `connections.*` client message here (one hook in handleV03Message); the
 * socket is already owner-authenticated.
 */
import { CONNECTIONS_EVENTS, type ConnectionsClientMessage, type ConnectionsServerMessage } from "@open-gpt-live/protocol";
import type { GatewayRuntime } from "../runtime.js";
import { ConnectionsManager } from "./connections.js";

export interface ConnectionsWsContext {
  runtime: GatewayRuntime;
  send(message: ConnectionsServerMessage | { type: "error"; message: string }): void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Runtimes built without installSibylTools (tests, embedded use) get a manager on demand. */
const fallbackManagers = new WeakMap<GatewayRuntime, ConnectionsManager>();

export function connectionsFor(runtime: GatewayRuntime): ConnectionsManager {
  if (runtime.connections) return runtime.connections;
  let manager = fallbackManagers.get(runtime);
  if (!manager) {
    manager = new ConnectionsManager({
      tools: runtime.tools,
      store: runtime.store,
      ownerId: runtime.ownerId,
      env: {},
      log: () => {}
    });
    fallbackManagers.set(runtime, manager);
  }
  return manager;
}

/** Handle one `connections.*` message. Never rejects: failures become an error reply. */
export async function handleConnectionsMessage(message: ConnectionsClientMessage, context: ConnectionsWsContext): Promise<void> {
  try {
    await dispatch(message, context);
  } catch (error) {
    context.send({ type: "error", message: `Connections: ${error instanceof Error ? error.message : String(error)}` });
  }
}

async function dispatch(message: ConnectionsClientMessage, context: ConnectionsWsContext): Promise<void> {
  const manager = connectionsFor(context.runtime);
  const pushState = async () => context.send({ type: CONNECTIONS_EVENTS.STATE, ...(await manager.state()) });

  // Mutations reply with a result (when they carry a requestId) and then the fresh state.
  const mutate = async (requestId: string | undefined, work: () => Promise<void>) => {
    try {
      await work();
      if (requestId) context.send({ type: CONNECTIONS_EVENTS.RESULT, requestId, ok: true });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      context.log?.("connections.action_failed", { action: message.type, error: text });
      if (requestId) context.send({ type: CONNECTIONS_EVENTS.RESULT, requestId, ok: false, error: text });
      else context.send({ type: "error", message: text });
    }
    await pushState();
  };

  switch (message.type) {
    case CONNECTIONS_EVENTS.REQUEST:
      await pushState();
      return;
    case CONNECTIONS_EVENTS.TOOL_TOGGLE:
      await mutate(undefined, () => manager.setToolEnabled(message.name, message.enabled));
      return;
    case CONNECTIONS_EVENTS.SERVER_TOGGLE:
      await mutate(undefined, () =>
        message.scope === "builtin"
          ? manager.setBuiltinEnabled(message.enabled)
          : manager.setServerEnabled(message.name ?? "", message.enabled)
      );
      return;
    case CONNECTIONS_EVENTS.SERVER_SAVE:
      await mutate(message.requestId, () => manager.saveServer(message.server, message.original));
      return;
    case CONNECTIONS_EVENTS.SERVER_REMOVE:
      await mutate(message.requestId, () => manager.removeServer(message.name));
      return;
    case CONNECTIONS_EVENTS.SERVER_RECONNECT:
      await mutate(message.requestId, () => manager.reconnect(message.name));
      return;
    case CONNECTIONS_EVENTS.SERVER_TEST: {
      const result = await manager.test({ name: message.name, server: message.server, original: message.original });
      context.send({ type: CONNECTIONS_EVENTS.TEST_RESULT, requestId: message.requestId, ...result });
      return;
    }
  }
}
