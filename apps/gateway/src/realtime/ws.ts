/**
 * realtime.* WebSocket messages (see packages/protocol, "Realtime" block).
 * The connection has already checked chat.use (identity/ws.ts fallback);
 * inviting an agent also needs agents.use.
 */
import { PERMISSIONS, type Permission } from "@open-gpt-live/core";
import { REALTIME_EVENTS, type RealtimeClientMessage, type ServerMessage } from "@open-gpt-live/protocol";
import type { VoiceSessionPort } from "../session-port.js";
import { RealtimeError, type RealtimeService } from "./service.js";

export interface RealtimeWsContext {
  realtime: RealtimeService;
  port: VoiceSessionPort;
  can(permission: Permission): boolean;
  send(message: ServerMessage): void;
}

export async function handleRealtimeMessage(message: RealtimeClientMessage, context: RealtimeWsContext): Promise<void> {
  const { realtime, port } = context;
  try {
    switch (message.type) {
      case REALTIME_EVENTS.JOIN:
        context.send(await realtime.join(port, message.callId));
        return;
      case REALTIME_EVENTS.LEAVE:
        await realtime.leave(port);
        return;
      case REALTIME_EVENTS.FLOOR:
        realtime.floor(port, message.holder);
        return;
      case REALTIME_EVENTS.INVITE:
        if (!context.can(PERMISSIONS.AGENTS_USE)) {
          context.send({ type: "error", message: "You don't have permission to use agents in this workspace." });
          return;
        }
        await realtime.invite(port, message.agentId);
        return;
    }
  } catch (error) {
    const known = error instanceof RealtimeError;
    context.send({ type: "error", message: known ? error.message : "The call service isn't reachable right now. Voice continues without it." });
  }
}
