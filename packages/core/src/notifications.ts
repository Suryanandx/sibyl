/**
 * Notifications: one record type for everything Sibyl tells people about
 * (a routine finished, a monitor fired, an agent acted on its own, an
 * approval is waiting, …). The gateway's notifications module is the only
 * writer: it stores the record, pushes it live and delivers it through the
 * notifier channels (inbox always; email, Slack, Teams on request).
 *
 * Visibility: `recipientUserId` set → that person only (plus the org owner
 * acting through the owner token or local mode); absent → everyone in the
 * workspace who may see the source (the permission per kind is decided by
 * the gateway).
 *
 * Read state: a record addressed to one person is read once (`readAt`). A
 * broadcast (no recipient) is read per person: queries that name a `reader`
 * see that person's own read time, and marking read with a reader only
 * marks it for them. Setting `readAt` on a broadcast (no reader, e.g. its
 * approval was decided) marks it read for everyone.
 */

export const NOTIFICATION_KINDS = [
  "approval_needed",
  "routine_finished",
  "routine_failed",
  "budget_blocked",
  "monitor_fired",
  "monitor_paused",
  "agent_action",
  "deck_ready",
  "invite_accepted",
  "meeting_notes",
  "voicemail"
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Delivery channels. The inbox always gets the record; the others are asked for per notification. */
export type NotificationChannel = "inbox" | "email" | "slack" | "teams";

/** Where a notification leads (deep links in the app). */
export interface NotificationLinks {
  conversationId?: string;
  routineId?: string;
  monitorId?: string;
  agentId?: string;
  artifactId?: string;
  approvalId?: string;
  meetingId?: string;
}

export interface NotificationRecord {
  id: string;
  ownerId: string;
  workspaceId: string;
  /** The one person it is for (absent: everyone with access to the source). */
  recipientUserId?: string;
  kind: NotificationKind;
  /** Short line (toast, list row, email subject). */
  title: string;
  /** Plain-text details (list row, email body). */
  body: string;
  links: NotificationLinks;
  createdAt: number;
  readAt?: number;
}

/** Which notifications a list, count or mark-read applies to. */
export interface NotificationQuery {
  workspaceId?: string;
  /** Records for everyone plus those addressed to this user (absent: no recipient filter). */
  recipient?: string;
  /** Only these kinds (an empty list matches nothing). */
  kinds?: readonly NotificationKind[];
  unread?: boolean;
  approvalId?: string;
  ids?: readonly string[];
  /**
   * Whose read state applies (user id, or "owner" for the owner token / local
   * mode). Broadcasts are then unread until this reader read them, and listed
   * records carry this reader's `readAt`. Absent: the record's own `readAt`.
   */
  reader?: string;
}

/** Keyset cursor: records strictly older than this one (createdAt, then id, descending). */
export interface NotificationCursor {
  createdAt: number;
  id: string;
}

export interface NotificationStore {
  insert(record: NotificationRecord): Promise<void>;
  get(ownerId: string, id: string): Promise<NotificationRecord | undefined>;
  /** Newest first (createdAt, then id, descending). */
  list(ownerId: string, query?: NotificationQuery & { before?: NotificationCursor; limit?: number }): Promise<NotificationRecord[]>;
  /** Unread records matching the query, per kind (kinds with none are left out). */
  countUnread(ownerId: string, query?: NotificationQuery): Promise<Partial<Record<NotificationKind, number>>>;
  /** Mark matching unread records read (broadcasts only for `query.reader` when given); returns the ids that changed. */
  markRead(ownerId: string, query: NotificationQuery, at: number): Promise<string[]>;
  /** Delete records created before `before` (and their read marks); returns how many were removed. */
  prune(ownerId: string, before: number): Promise<number>;
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** When this reader read the record (undefined: unread for them). `readers` holds per-reader marks of broadcasts. */
export function readAtFor(record: NotificationRecord, reader: string | undefined, readers?: ReadonlyMap<string, number>): number | undefined {
  if (record.readAt !== undefined || record.recipientUserId !== undefined || reader === undefined) return record.readAt;
  return readers?.get(reader);
}

/**
 * The shared filter of the memory store (the SQLite store implements the same
 * in SQL). `readers`: the record's per-reader marks (for `unread` with a reader).
 */
export function matchesNotificationQuery(record: NotificationRecord, query: NotificationQuery, readers?: ReadonlyMap<string, number>): boolean {
  if (query.workspaceId !== undefined && record.workspaceId !== query.workspaceId) return false;
  if (query.recipient !== undefined && record.recipientUserId !== undefined && record.recipientUserId !== query.recipient) return false;
  if (query.kinds && !query.kinds.includes(record.kind)) return false;
  if (query.unread && readAtFor(record, query.reader, readers) !== undefined) return false;
  if (query.approvalId !== undefined && record.links.approvalId !== query.approvalId) return false;
  if (query.ids && !query.ids.includes(record.id)) return false;
  return true;
}

function newerFirst(a: NotificationRecord, b: NotificationRecord): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function olderThan(record: NotificationRecord, cursor: NotificationCursor): boolean {
  return record.createdAt < cursor.createdAt || (record.createdAt === cursor.createdAt && record.id < cursor.id);
}

/** In-memory NotificationStore (used by createMemoryStore). */
export function createMemoryNotificationStore(): NotificationStore {
  const records = new Map<string, NotificationRecord>();
  /** Broadcast id → reader → when they read it. */
  const reads = new Map<string, Map<string, number>>();
  const clone = <T>(value: T): T => structuredClone(value);
  const owned = (ownerId: string, query: NotificationQuery) =>
    [...records.values()].filter((r) => r.ownerId === ownerId && matchesNotificationQuery(r, query, reads.get(r.id)));
  /** A copy carrying the reader's read time. */
  const view = (record: NotificationRecord, reader: string | undefined): NotificationRecord => {
    const copy = clone(record);
    const readAt = readAtFor(record, reader, reads.get(record.id));
    if (readAt === undefined) delete copy.readAt;
    else copy.readAt = readAt;
    return copy;
  };
  return {
    async insert(record) {
      records.set(record.id, clone(record));
    },
    async get(ownerId, id) {
      const found = records.get(id);
      return found && found.ownerId === ownerId ? clone(found) : undefined;
    },
    async list(ownerId, query = {}) {
      return owned(ownerId, query)
        .filter((r) => !query.before || olderThan(r, query.before))
        .sort(newerFirst)
        .slice(0, query.limit ?? 50)
        .map((r) => view(r, query.reader));
    },
    async countUnread(ownerId, query = {}) {
      const out: Partial<Record<NotificationKind, number>> = {};
      for (const record of owned(ownerId, { ...query, unread: true })) out[record.kind] = (out[record.kind] ?? 0) + 1;
      return out;
    },
    async markRead(ownerId, query, at) {
      const changed: string[] = [];
      for (const record of owned(ownerId, { ...query, unread: true })) {
        if (query.reader !== undefined && record.recipientUserId === undefined) {
          const marks = reads.get(record.id) ?? new Map<string, number>();
          marks.set(query.reader, at);
          reads.set(record.id, marks);
        } else {
          record.readAt = at;
        }
        changed.push(record.id);
      }
      return changed;
    },
    async prune(ownerId, before) {
      let removed = 0;
      for (const record of [...records.values()]) {
        if (record.ownerId !== ownerId || record.createdAt >= before) continue;
        records.delete(record.id);
        reads.delete(record.id);
        removed += 1;
      }
      return removed;
    }
  };
}
