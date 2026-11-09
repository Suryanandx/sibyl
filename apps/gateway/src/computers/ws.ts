/**
 * WebSocket side of agent computers. Every message is checked against the
 * connection's principal and workspace: only people who can see an agent
 * (agents.use, plus its visibility) get its status, frames and timeline or
 * may stop it. Watches end when the socket closes.
 */
import { PERMISSIONS, authorize, type Principal } from "@open-gpt-live/core";
import { COMPUTER_EVENTS, isComputersClientMessage, type ClientMessage, type ServerMessage } from "@open-gpt-live/protocol";
import type { AgentRuntime } from "../agents/runtime.js";
import type { ComputerService } from "./service.js";

export interface ComputersWsContext {
  computers: ComputerService | undefined;
  agents: AgentRuntime | undefined;
  send(message: ServerMessage): void;
  principal(): Principal;
  workspaceId(): string;
  socket?: { once(event: "close", listener: () => void): unknown };
}

/** Per connection: agentId → unsubscribe. */
const watching = new WeakMap<object, Map<string, () => void>>();

export async function handleComputersMessage(message: ClientMessage, context: ComputersWsContext): Promise<boolean> {
  if (!isComputersClientMessage(message)) return false;
  const { computers, agents } = context;
  const fail = (text: string): void => context.send({ type: "error", message: text });
  if (!computers || !agents) {
    if (message.type === COMPUTER_EVENTS.INFO_REQUEST) {
      context.send({ type: COMPUTER_EVENTS.INFO, available: false, reason: "Agent computers are turned off on this gateway (SIBYL_COMPUTERS=off).", defaults: { idleMinutes: 0, dailyMinutes: 0 } });
    } else fail("Agent computers are not available on this gateway.");
    return true;
  }
  if (!authorize(context.principal(), PERMISSIONS.AGENTS_USE, { workspaceId: context.workspaceId() })) {
    fail("You don't have permission to use agents in this workspace.");
    return true;
  }
  if (message.type === COMPUTER_EVENTS.INFO_REQUEST) {
    context.send({ type: COMPUTER_EVENTS.INFO, ...(await computers.info()) });
    return true;
  }
  const { agentId } = message;
  const visible = async (): Promise<boolean> => Boolean(await agents.get(context.principal(), context.workspaceId(), agentId));
  const key = context.socket ?? context.send;
  let mine = watching.get(key);

  if (message.type === COMPUTER_EVENTS.UNWATCH) {
    mine?.get(agentId)?.();
    mine?.delete(agentId);
    return true;
  }
  if (!(await visible())) {
    fail("That agent isn't available to you in this workspace.");
    return true;
  }
  switch (message.type) {
    case COMPUTER_EVENTS.WATCH: {
      if (!mine) {
        const created = new Map<string, () => void>();
        mine = created;
        watching.set(key, created);
        context.socket?.once("close", () => {
          for (const stop of created.values()) stop();
          watching.delete(key);
        });
      }
      // Watching again (another view opened) re-sends the current status and frame.
      mine.get(agentId)?.();
      mine.set(agentId, computers.watch(agentId, { send: context.send, allowed: visible }));
      return true;
    }
    case COMPUTER_EVENTS.STOP: {
      const who = context.principal().name ?? context.principal().email;
      const stopped = await computers.stop(agentId, who ? `Stopped by ${who}.` : "Stopped from the computer view.");
      if (!stopped) context.send({ type: COMPUTER_EVENTS.STATUS, status: await computers.status(agentId) });
      return true;
    }
    case COMPUTER_EVENTS.TIMELINE_REQUEST:
      context.send({ type: COMPUTER_EVENTS.TIMELINE, ...(await computers.timeline(agentId, message.runId)) });
      return true;
  }
  return true;
}
