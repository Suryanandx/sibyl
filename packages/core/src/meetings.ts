/**
 * Meetings (docs/meetings.md): a call with people and agents, its live
 * transcript, the AI notes written from it, and the comments people leave
 * afterwards.
 *
 * - One record per meeting (title, times, host, workspace, participants with
 *   agent roles, notes, recording id). The meeting id is also the call id:
 *   its room is `sibyl.call.<workspace>.<id>`.
 * - Transcript segments are appended as people talk (speaker + offsets from
 *   the start), numbered per meeting (`seq`), so the notes can be refreshed
 *   from "what's new since last time" only.
 * - Comments carry reactions and one level of replies.
 *
 * The gateway's meetings module is the only writer.
 */

export type MeetingStatus = "scheduled" | "live" | "ended";

/** How an agent takes part: speaks when addressed, or only listens and keeps notes. */
export type MeetingAgentRole = "participant" | "notetaker";

export const MEETING_AGENT_ROLES: readonly MeetingAgentRole[] = ["participant", "notetaker"];

export function isMeetingAgentRole(value: unknown): value is MeetingAgentRole {
  return value === "participant" || value === "notetaker";
}

export type MeetingParticipantKind = "person" | "agent" | "guest";

/** Speaker colour slots (the web app maps slot n to `--speaker-<n+1>`). */
export const MEETING_SPEAKER_COLORS = 6;

export interface MeetingParticipant {
  /** Room identity: user:<id>, agent:<id> / agent:sibyl, guest:<id>. */
  identity: string;
  name: string;
  kind: MeetingParticipantKind;
  userId?: string;
  /** "sibyl" or an agent id. */
  agentId?: string;
  /** Agents only. */
  role?: MeetingAgentRole;
  /** First time they joined. */
  joinedAt?: number;
  /** Speaker colour slot (0 … MEETING_SPEAKER_COLORS-1), stable for the meeting. */
  color: number;
}

export interface MeetingActionItem {
  id: string;
  text: string;
  /** Who should do it, as said in the meeting. */
  owner?: string;
  /** Due date as said (YYYY-MM-DD when known). */
  due?: string;
  /** The task (one-time routine) made from it. */
  routineId?: string;
}

/** The AI notes: refreshed every few minutes from new transcript only, and once at the end. */
export interface MeetingNotes {
  overview: string;
  keyPoints: string[];
  insights: string[];
  actions: MeetingActionItem[];
  /** Highest transcript `seq` these notes cover. */
  coveredSeq: number;
  updatedAt: number;
  /** Written after the meeting ended (the final pass). */
  final?: boolean;
  /** The note-taking agent credited (absent: Sibyl). */
  by?: { agentId: string; name: string };
}

export interface MeetingRecord {
  id: string;
  ownerId: string;
  workspaceId: string;
  title: string;
  description?: string;
  /** Host: a user id, or "owner" for the org owner without an account. */
  host: string;
  hostName: string;
  status: MeetingStatus;
  scheduledAt?: number;
  scheduledEndAt?: number;
  startedAt?: number;
  endedAt?: number;
  participants: MeetingParticipant[];
  /** How Sibyl takes part (she always transcribes). */
  sibylRole: MeetingAgentRole;
  notes?: MeetingNotes;
  /** The host's chat the meeting's replies and approvals land in. */
  conversationId?: string;
  /** Enterprise recording of the room (audio or video; the latest). */
  recordingId?: string;
  /** Guests asking to join, kept so a gateway restart doesn't drop them (see MeetingKnock). */
  lobby?: MeetingKnock[];
  /** Raised hands in the room: identity → when raised. */
  raisedHands?: Record<string, number>;
  /** Read-only links to the notes (summary, transcript, actions) the host shared. */
  shares?: MeetingShare[];
  /** Secret in the guest link (/join/<id>?k=…); guests knock and the host admits them. */
  inviteKey: string;
  /** Imported from a calendar event. */
  calendar?: { provider: "google" | "microsoft"; eventId: string };
  /** AI spend of this meeting (notes, Ask AI), USD. */
  costUsd?: number;
  /** Transcript segments so far. */
  segmentCount?: number;
  createdAt: number;
  updatedAt: number;
}

/** A guest's knock at the lobby (guest link → name → the host admits or denies). */
export interface MeetingKnock {
  /** Secret the guest polls with. */
  ticket: string;
  /** Guest id (room identity guest:<id>). */
  guestId: string;
  name: string;
  at: number;
  status: "waiting" | "admitted" | "denied";
}

/** A read-only link to a meeting's notes: revocable, expiring. Only a hash of its token is kept. */
export interface MeetingShare {
  id: string;
  tokenHash: string;
  /** Who made it (host key). */
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  /** Include the transcript (otherwise summary and actions only). */
  transcript: boolean;
  /** Times the link was opened. */
  views?: number;
}

export interface MeetingSegment {
  meetingId: string;
  ownerId: string;
  /** 1, 2, 3 … per meeting (assigned by the store). */
  seq: number;
  /** Room identity of who spoke. */
  speaker: string;
  speakerName: string;
  kind: MeetingParticipantKind;
  /** Offsets from the meeting's start. */
  startMs: number;
  endMs: number;
  text: string;
  /** Wall-clock time it was said. */
  at: number;
}

export interface MeetingComment {
  id: string;
  ownerId: string;
  meetingId: string;
  /** Replies point at a top-level comment. */
  parentId?: string;
  /** User id, or "owner". */
  authorId: string;
  authorName: string;
  text: string;
  /** Moment of the meeting it is about (offset, ms). */
  atMs?: number;
  /** Emoji → who reacted (author ids). */
  reactions: Record<string, string[]>;
  createdAt: number;
  editedAt?: number;
}

export interface MeetingQuery {
  workspaceId?: string;
  limit?: number;
}

export interface MeetingStore {
  upsert(record: MeetingRecord): Promise<void>;
  get(ownerId: string, id: string): Promise<MeetingRecord | undefined>;
  /** Newest first by when it happens (started, else scheduled, else created). */
  list(ownerId: string, query?: MeetingQuery): Promise<MeetingRecord[]>;
  /** The meeting with its transcript and comments. */
  remove(ownerId: string, id: string): Promise<void>;
  /** Append one segment; the store assigns the next `seq`. */
  appendSegment(segment: Omit<MeetingSegment, "seq">): Promise<MeetingSegment>;
  /** Segments in order, optionally only those after `afterSeq`. */
  segments(ownerId: string, meetingId: string, afterSeq?: number): Promise<MeetingSegment[]>;
  upsertComment(comment: MeetingComment): Promise<void>;
  getComment(ownerId: string, id: string): Promise<MeetingComment | undefined>;
  /** Oldest first. */
  comments(ownerId: string, meetingId: string): Promise<MeetingComment[]>;
  /** A comment and its replies. */
  removeComment(ownerId: string, id: string): Promise<void>;
}

/** When a meeting happens, for ordering lists. */
export function meetingSortAt(record: Pick<MeetingRecord, "startedAt" | "scheduledAt" | "createdAt">): number {
  return record.startedAt ?? record.scheduledAt ?? record.createdAt;
}

/** In-memory MeetingStore (part of createMemoryStore). */
export function createMemoryMeetingStore(): MeetingStore {
  const meetings = new Map<string, MeetingRecord>();
  const segments = new Map<string, MeetingSegment[]>();
  const comments = new Map<string, MeetingComment>();
  const clone = <T>(value: T): T => structuredClone(value);
  // Keyed by organization + meeting id (ids can come from a link).
  const key = (ownerId: string, id: string) => `${ownerId}\u0000${id}`;
  return {
    async upsert(record) {
      meetings.set(key(record.ownerId, record.id), clone(record));
    },
    async get(ownerId, id) {
      const found = meetings.get(key(ownerId, id));
      return found ? clone(found) : undefined;
    },
    async list(ownerId, query = {}) {
      return [...meetings.values()]
        .filter((m) => m.ownerId === ownerId && (query.workspaceId === undefined || m.workspaceId === query.workspaceId))
        .sort((a, b) => meetingSortAt(b) - meetingSortAt(a))
        .slice(0, query.limit ?? 200)
        .map(clone);
    },
    async remove(ownerId, id) {
      if (!meetings.has(key(ownerId, id))) return;
      meetings.delete(key(ownerId, id));
      segments.delete(key(ownerId, id));
      for (const [commentId, comment] of comments) if (comment.meetingId === id && comment.ownerId === ownerId) comments.delete(commentId);
    },
    async appendSegment(segment) {
      const list = segments.get(key(segment.ownerId, segment.meetingId)) ?? [];
      const stored: MeetingSegment = { ...clone(segment), seq: (list.at(-1)?.seq ?? 0) + 1 };
      list.push(stored);
      segments.set(key(segment.ownerId, segment.meetingId), list);
      return clone(stored);
    },
    async segments(ownerId, meetingId, afterSeq = 0) {
      return (segments.get(key(ownerId, meetingId)) ?? []).filter((s) => s.seq > afterSeq).map(clone);
    },
    async upsertComment(comment) {
      comments.set(comment.id, clone(comment));
    },
    async getComment(ownerId, id) {
      const found = comments.get(id);
      return found && found.ownerId === ownerId ? clone(found) : undefined;
    },
    async comments(ownerId, meetingId) {
      return [...comments.values()]
        .filter((c) => c.ownerId === ownerId && c.meetingId === meetingId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone);
    },
    async removeComment(ownerId, id) {
      if (comments.get(id)?.ownerId !== ownerId) return;
      comments.delete(id);
      for (const [replyId, reply] of comments) if (reply.parentId === id) comments.delete(replyId);
    }
  };
}
