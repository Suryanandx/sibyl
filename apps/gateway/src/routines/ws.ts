/**
 * WebSocket handlers for routines and the approval inbox, called from the
 * gateway's v0.3 dispatch. Returns true when the message was handled here.
 *
 * Inbox decisions reuse `approval.decision`: approvals that belong to a
 * routine run are decided here (the run resumes); chat approvals fall through
 * to the connection's own ApprovalBroker.
 */
import { ROUTINE_EVENTS, WS_EVENTS, type ClientMessage, type ServerMessage } from "@open-gpt-live/protocol";
import type { RoutineService } from "./service.js";

export interface RoutinesWsContext {
  routines: RoutineService | undefined;
  send(message: ServerMessage): void;
  /** The connection's socket: subscriptions end when it closes. */
  socket?: { once(event: "close", listener: () => void): unknown };
}

const subscribed = new WeakMap<object, RoutineService>();
const ROUTINE_TYPES = new Set<string>(Object.values(ROUTINE_EVENTS));

export async function handleRoutinesMessage(message: ClientMessage, context: RoutinesWsContext): Promise<boolean> {
  const { routines, send } = context;
  if (message.type === WS_EVENTS.APPROVAL_DECISION) {
    if (!routines) return false;
    const record = await routines.getApproval(message.id);
    if (!record?.routineId) return false;
    const status = await routines.approvals.decide(message.id, message.decision);
    if (status === undefined) send({ type: "error", message: "That approval is no longer available." });
    else if (status !== "pending") send({ type: WS_EVENTS.APPROVAL_RESOLVED, id: message.id, status });
    return true;
  }
  if (!ROUTINE_TYPES.has(message.type)) return false;
  if (!routines) {
    send({ type: "error", message: "Routines are not available on this gateway." });
    return true;
  }
  subscribe(routines, context);

  switch (message.type) {
    case ROUTINE_EVENTS.ROUTINES_CONTEXT:
      if (!(await routines.setTimezone(message.timezone))) {
        send({ type: "error", message: `Unknown time zone: ${message.timezone}` });
      }
      return true;
    case ROUTINE_EVENTS.ROUTINES_REQUEST:
      send({ type: ROUTINE_EVENTS.ROUTINES_LIST, items: await routines.list() });
      return true;
    case ROUTINE_EVENTS.INBOX_REQUEST:
      send({ type: ROUTINE_EVENTS.INBOX_LIST, items: await routines.inbox() });
      return true;
    case ROUTINE_EVENTS.ROUTINE_UPDATE: {
      const result = await routines.update(message.routineId, message.patch);
      if (typeof result === "string") {
        send({ type: "error", message: `Could not update the routine: ${result}` });
        send({ type: ROUTINE_EVENTS.ROUTINES_LIST, items: await routines.list() });
      }
      return true;
    }
    case ROUTINE_EVENTS.ROUTINE_RUN_NOW: {
      const error = await routines.runNow(message.routineId);
      if (error) send({ type: "error", message: error });
      return true;
    }
    case ROUTINE_EVENTS.ROUTINE_DELETE:
      await routines.remove(message.routineId);
      return true;
  }
  return false;
}

function subscribe(routines: RoutineService, context: RoutinesWsContext): void {
  const key = context.socket ?? context.send;
  if (subscribed.get(key) === routines) return;
  subscribed.set(key, routines);
  const unsubscribe = routines.subscribe(context.send);
  context.socket?.once("close", () => {
    unsubscribe();
    subscribed.delete(key);
  });
}
