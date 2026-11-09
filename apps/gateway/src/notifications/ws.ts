/**
 * WebSocket side of notifications: list a page, mark read. The live feed
 * (`notification`, `notifications.state`) is subscribed once per connection
 * by the gateway when it opens; the connection's principal and workspace are
 * read on every push.
 */
import type { Principal } from "@open-gpt-live/core";
import { NOTIFICATION_EVENTS, isNotificationsClientMessage, type ClientMessage, type ServerMessage } from "@open-gpt-live/protocol";
import type { NotificationService } from "./service.js";

export interface NotificationsWsContext {
  notifications: NotificationService | undefined;
  send(message: ServerMessage): void;
  principal(): Principal;
  workspaceId(): string;
}

/** Handles notifications.* messages; returns false for anything else. */
export async function handleNotificationsMessage(message: ClientMessage, context: NotificationsWsContext): Promise<boolean> {
  if (!isNotificationsClientMessage(message)) return false;
  const { notifications, send } = context;
  if (!notifications) {
    if (message.type === NOTIFICATION_EVENTS.REQUEST) send({ type: NOTIFICATION_EVENTS.LIST, items: [], unread: { total: 0, byKind: {} } });
    else send({ type: "error", message: "Notifications are not available on this gateway." });
    return true;
  }
  const viewer = { principal: context.principal(), workspaceId: context.workspaceId() };
  if (message.type === NOTIFICATION_EVENTS.REQUEST) {
    send({
      type: NOTIFICATION_EVENTS.LIST,
      ...(await notifications.list(viewer, {
        ...(message.cursor ? { cursor: message.cursor } : {}),
        ...(message.limit ? { limit: message.limit } : {}),
        ...(message.kinds ? { kinds: message.kinds } : {})
      }))
    });
    return true;
  }
  const ok = await notifications.markRead(viewer, "id" in message ? { id: message.id } : { all: true });
  if (!ok) send({ type: "error", message: "That notification isn't available." });
  return true;
}
