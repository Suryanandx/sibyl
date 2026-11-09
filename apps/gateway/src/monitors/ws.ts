/**
 * WebSocket side of monitors: `monitors.subscribe` starts live status
 * updates (monitors.status; fired events arrive as notifications)
 * for this connection, until the socket closes. The connection's principal
 * and workspace are read on every push, so role or workspace changes apply
 * at once.
 */
import type { Principal } from "@open-gpt-live/core";
import { isMonitorsClientMessage, type ClientMessage, type ServerMessage } from "@open-gpt-live/protocol";
import type { MonitorService } from "./service.js";

export interface MonitorsWsContext {
  monitors: MonitorService | undefined;
  send(message: ServerMessage): void;
  principal(): Principal;
  workspaceId(): string;
  socket?: { once(event: "close", listener: () => void): unknown };
}

const subscribed = new WeakMap<object, MonitorService>();

export function handleMonitorsMessage(message: ClientMessage, context: MonitorsWsContext): boolean {
  if (!isMonitorsClientMessage(message)) return false;
  const { monitors } = context;
  if (!monitors) {
    context.send({ type: "error", message: "Monitors are not available on this gateway." });
    return true;
  }
  const key = context.socket ?? context.send;
  if (subscribed.get(key) === monitors) return true;
  subscribed.set(key, monitors);
  const unsubscribe = monitors.subscribe({ send: context.send, principal: context.principal, workspaceId: context.workspaceId });
  context.socket?.once("close", () => {
    unsubscribe();
    subscribed.delete(key);
  });
  return true;
}
