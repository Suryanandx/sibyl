/**
 * The call log (docs/realtime.md#call-log): one record per phone call, in or
 * out, of an organization's phone line.
 *
 * - The other party's number is kept here only (never in room names,
 *   identities or logs: see apps/gateway/src/realtime/rooms.ts).
 * - The call's words live in its chat (`conversationId`); a voicemail's
 *   transcript is also copied here and into the Inbox.
 *
 * The gateway's phone line (apps/gateway/src/realtime/phone.ts) is the only writer.
 */

export type CallDirection = "inbound" | "outbound";

/**
 * ringing: dialling out or a caller is connecting; active: talking;
 * completed: ended after a conversation; voicemail: the caller left a message
 * (outside business hours); missed: nobody talked; failed: never connected.
 */
export type CallStatus = "ringing" | "active" | "completed" | "voicemail" | "missed" | "failed";

export interface CallLogRecord {
  id: string;
  ownerId: string;
  workspaceId: string;
  direction: CallDirection;
  status: CallStatus;
  /** LiveKit room of the call (sibyl.phone.<space>.<id>). */
  room: string;
  /** The line's own number (E.164). */
  lineNumber?: string;
  /** The other party (E.164) when the trunk passed it on. */
  remoteNumber?: string;
  /** Who answered or called: "sibyl" or an agent id, with its name at the time. */
  agentId: string;
  agentName: string;
  /** Outbound: who asked for the call (user id). */
  placedBy?: string;
  /** The call's chat (its transcript, replies and notes). */
  conversationId?: string;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** Model and speech spend of the call (USD, from the usage meter). */
  costUsd?: number;
  /** Enterprise recording of the call. */
  recordingId?: string;
  /** Voicemail: what the caller said, and the Inbox notice made from it. */
  voicemail?: { transcript: string; notificationId?: string };
  error?: string;
  updatedAt: number;
}

export interface CallLogQuery {
  workspaceId?: string;
  direction?: CallDirection;
  /** Only calls that started before this time (paging). */
  before?: number;
  limit?: number;
}

export interface CallLogStore {
  upsert(record: CallLogRecord): Promise<void>;
  get(ownerId: string, id: string): Promise<CallLogRecord | undefined>;
  /** Newest first. */
  list(ownerId: string, query?: CallLogQuery): Promise<CallLogRecord[]>;
  remove(ownerId: string, id: string): Promise<void>;
}

/** In-memory CallLogStore (part of createMemoryStore). */
export function createMemoryCallLogStore(): CallLogStore {
  const calls = new Map<string, CallLogRecord>();
  const clone = <T>(value: T): T => structuredClone(value);
  const key = (ownerId: string, id: string) => `${ownerId}\u0000${id}`;
  return {
    async upsert(record) {
      calls.set(key(record.ownerId, record.id), clone(record));
    },
    async get(ownerId, id) {
      const found = calls.get(key(ownerId, id));
      return found ? clone(found) : undefined;
    },
    async list(ownerId, query = {}) {
      return [...calls.values()]
        .filter(
          (call) =>
            call.ownerId === ownerId &&
            (query.workspaceId === undefined || call.workspaceId === query.workspaceId) &&
            (query.direction === undefined || call.direction === query.direction) &&
            (query.before === undefined || call.startedAt < query.before)
        )
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, query.limit ?? 100)
        .map(clone);
    },
    async remove(ownerId, id) {
      calls.delete(key(ownerId, id));
    }
  };
}
