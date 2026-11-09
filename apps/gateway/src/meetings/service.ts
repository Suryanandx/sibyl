/**
 * Meetings (docs/meetings.md): records, the live transcript, AI notes, Ask AI,
 * comments, the guest lobby, host moderation and tasks from action items.
 *
 * The room itself is the realtime layer's call room (the meeting id is the
 * call id). This service plugs into it through CallHooks: when the host's
 * session brings Sibyl in, the room agent reports every utterance (and each
 * agent's reply) here as a transcript segment, and who arrived.
 *
 * Access: everyone in the meeting's workspace with chat.use may see a meeting,
 * its notes and transcript, and comment; the host (the person who created it)
 * runs it: admits guests, mutes or removes people, changes agent roles and
 * ends it for everyone. Guests (no account) only ever get a room token after
 * the host admitted them; they never see the notes.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import {
  MEETING_SPEAKER_COLORS,
  PERMISSIONS,
  authorize,
  type MeetingAgentRole,
  type MeetingComment,
  type MeetingNotes,
  type MeetingParticipant,
  type MeetingRecord,
  type MeetingSegment,
  type ModelUsage,
  type Principal,
  type Store,
  type UsageMeter
} from "@open-gpt-live/core";
import type {
  MeetingCommentView,
  ModelCatalog,
  MeetingLobbyEntryView,
  MeetingLobbyStatusView,
  MeetingSegmentView,
  MeetingView
} from "@open-gpt-live/protocol";
import { economyModel, estimateTurnUsd } from "../metering/budget.js";
import { GatewayUsageMeter } from "../metering/meter.js";
import { CostEstimator } from "../metering/pricing.js";
import type { NotificationService } from "../notifications/service.js";
import type { RoomArrival, RoomMeetingHooks, RoomSegment } from "../realtime/room-agent.js";
import { RealtimeError, displayName, hostKey, type CallHooks, type RealtimeService } from "../realtime/service.js";
import { userIdentity } from "../realtime/rooms.js";
import { Lobby, LobbyError } from "./lobby.js";
import { askAboutMeeting, clock, writeNotes, type ModelCall } from "./notes.js";

type Log = (event: string, fields?: Record<string, unknown>) => void;

/** A person or an outsider-safe message (bad input, not allowed, not found). */
export class MeetingError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "bad_request") {
    super(message);
  }
}

export interface MeetingCaller {
  principal: Principal;
  workspaceId: string;
}

export interface MeetingBrain {
  provider: ToolChatProvider | undefined;
  /** The deep brain's model (Ask AI). */
  model(): string | undefined;
  /** A fast, cheap model for notes when the catalog has no "cheapest" preset yet (the voice model). */
  fastModel?(): string | undefined;
  extraBody?(model: string): Record<string, unknown> | undefined;
  catalog?(): ModelCatalog | undefined;
}

export interface MeetingServiceOptions {
  store: Store;
  ownerId: string;
  meter: UsageMeter;
  notifications?: NotificationService;
  env: NodeJS.ProcessEnv;
  log: Log;
  now?(): number;
}

/** Notes refresh at most this often while a meeting runs (SIBYL_MEETING_NOTES_INTERVAL_SECONDS). */
const DEFAULT_NOTES_INTERVAL_MS = 3 * 60 * 1000;
/** New transcript needed before a refresh is worth a model call. */
const MIN_NEW_CHARS = 200;
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const REACTIONS = new Set(["👍", "❤️", "🎉", "😄", "🤔", "👀"]);

export interface NewMeetingInput {
  title?: unknown;
  description?: unknown;
  scheduledAt?: unknown;
  scheduledEndAt?: unknown;
  sibylRole?: unknown;
  calendar?: unknown;
}

export class MeetingService {
  private brain: MeetingBrain | undefined;
  private realtime: RealtimeService | undefined;
  readonly lobby: Lobby;
  private readonly now: () => number;
  /** One notes refresh at a time per meeting; when the last one ran. */
  private readonly summarizing = new Map<string, Promise<void>>();
  private readonly lastNotesAt = new Map<string, number>();
  /** Segment writes per meeting run in order (seq follows speech order). */
  private readonly writes = new Map<string, Promise<unknown>>();
  /** Record writes per meeting, in order (see mutate). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** A meeting being wrapped up (the room closing and "end for everyone" wait for the same work). */
  private readonly finishing = new Map<string, Promise<MeetingRecord | undefined>>();

  constructor(private readonly options: MeetingServiceOptions) {
    this.now = options.now ?? Date.now;
    this.lobby = new Lobby(this.now);
  }

  /** Models for notes and Ask AI (called by the server once they are known). */
  configure(brain: MeetingBrain): void {
    this.brain = brain;
  }

  /** The realtime layer (LiveKit): meetings own its call records and transcripts. */
  attach(realtime: RealtimeService): void {
    this.realtime = realtime;
    realtime.useCalls(this.callHooks());
  }

  get live(): boolean {
    return Boolean(this.realtime);
  }

  /* ───────────── records ───────────── */

  async create(caller: MeetingCaller, input: NewMeetingInput & { conversationId?: string }): Promise<MeetingView> {
    this.requireUse(caller);
    const record = this.newRecord(caller, input, randomBytes(12).toString("base64url"));
    await this.options.store.meetings.upsert(record);
    this.options.log("meeting.created", { meetingId: record.id, workspaceId: record.workspaceId, scheduled: record.scheduledAt !== undefined });
    return this.view(record, caller.principal);
  }

  private newRecord(caller: MeetingCaller, input: NewMeetingInput & { conversationId?: string }, id: string): MeetingRecord {
    const now = this.now();
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 140) : defaultTitle(now);
    const scheduledAt = timeOf(input.scheduledAt);
    const scheduledEndAt = timeOf(input.scheduledEndAt);
    if (scheduledAt !== undefined && scheduledEndAt !== undefined && scheduledEndAt < scheduledAt) throw new MeetingError("The end must be after the start.");
    const calendar = calendarRef(input.calendar);
    return {
      id,
      ownerId: this.options.ownerId,
      workspaceId: caller.workspaceId,
      title,
      ...(typeof input.description === "string" && input.description.trim() ? { description: input.description.trim().slice(0, 2_000) } : {}),
      host: hostKey(caller.principal),
      hostName: displayName(caller.principal),
      status: "scheduled",
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      ...(scheduledEndAt !== undefined ? { scheduledEndAt } : {}),
      participants: [],
      sibylRole: input.sibylRole === "notetaker" ? "notetaker" : "participant",
      inviteKey: randomBytes(18).toString("base64url"),
      ...(calendar ? { calendar } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      segmentCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  async list(caller: MeetingCaller, query = ""): Promise<MeetingView[]> {
    this.requireUse(caller);
    const records = await this.options.store.meetings.list(this.options.ownerId, { workspaceId: caller.workspaceId, limit: 200 });
    const needle = query.trim().toLowerCase();
    return records
      .filter((record) => !needle || searchText(record).includes(needle))
      .map((record) => this.view(record, caller.principal));
  }

  async get(caller: MeetingCaller, id: string): Promise<MeetingView> {
    return this.view(await this.load(caller, id), caller.principal);
  }

  async update(caller: MeetingCaller, id: string, patch: Record<string, unknown>): Promise<MeetingView> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record, true);
    const next: MeetingRecord = { ...record, updatedAt: this.now() };
    if (typeof patch.title === "string") {
      const title = patch.title.trim().slice(0, 140);
      if (!title) throw new MeetingError("The title can't be empty.");
      next.title = title;
    }
    if (patch.description === null) delete next.description;
    else if (typeof patch.description === "string") next.description = patch.description.trim().slice(0, 2_000);
    if (patch.scheduledAt !== undefined) {
      const at = timeOf(patch.scheduledAt);
      if (at === undefined) delete next.scheduledAt;
      else next.scheduledAt = at;
    }
    if (patch.scheduledEndAt !== undefined) {
      const at = timeOf(patch.scheduledEndAt);
      if (at === undefined) delete next.scheduledEndAt;
      else next.scheduledEndAt = at;
    }
    if (patch.recordingId === null) delete next.recordingId;
    else if (typeof patch.recordingId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(patch.recordingId)) next.recordingId = patch.recordingId;
    await this.options.store.meetings.upsert(next);
    return this.view(next, caller.principal);
  }

  async remove(caller: MeetingCaller, id: string): Promise<void> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record, true);
    if (record.status === "live") await this.realtime?.endCall(record.workspaceId, record.id).catch(() => undefined);
    this.lobby.close(record.id);
    await this.options.store.meetings.remove(this.options.ownerId, record.id);
  }

  async transcript(caller: MeetingCaller, id: string): Promise<MeetingSegmentView[]> {
    const record = await this.load(caller, id);
    const segments = await this.options.store.meetings.segments(this.options.ownerId, record.id);
    return segments.map(({ seq, speaker, speakerName, kind, startMs, endMs, text, at }) => ({ seq, speaker, speakerName, kind, startMs, endMs, text, at }));
  }

  /** The meeting as Markdown (export, save to knowledge). */
  async markdown(caller: MeetingCaller, id: string): Promise<{ title: string; text: string }> {
    const record = await this.load(caller, id);
    const segments = await this.options.store.meetings.segments(this.options.ownerId, record.id);
    return { title: record.title, text: meetingMarkdown(record, segments) };
  }

  /* ───────────── live room: hosting, moderation, agents ───────────── */

  /** End for everyone: the room closes, final notes are written. */
  async end(caller: MeetingCaller, id: string): Promise<MeetingView> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record);
    await this.requireRealtime().endCall(record.workspaceId, record.id);
    const ended = await this.finish(record.id, "ended by host");
    return this.view(ended ?? record, caller.principal);
  }

  async mute(caller: MeetingCaller, id: string, identity: string): Promise<boolean> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record);
    return this.requireRealtime().muteParticipant(record.workspaceId, record.id, identity);
  }

  async removeParticipant(caller: MeetingCaller, id: string, identity: string): Promise<void> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record);
    if (identity === userIdentity(record.host === "owner" ? undefined : record.host)) throw new MeetingError("The host can't be removed. End the meeting instead.");
    await this.requireRealtime().removeParticipant(record.workspaceId, record.id, identity);
  }

  /** Add an agent with a role, switch its role live, or (null) send it away. Sibyl can switch but never leaves. */
  async setAgentRole(caller: MeetingCaller, id: string, agentId: string, role: MeetingAgentRole | null): Promise<MeetingView> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record);
    if (agentId !== "sibyl" && !authorize(caller.principal, PERMISSIONS.AGENTS_USE, { workspaceId: caller.workspaceId })) {
      throw new MeetingError("You don't have permission to use agents in this workspace.", 403, "forbidden");
    }
    if (agentId === "sibyl" && role === null) throw new MeetingError("Sibyl stays in the meeting: she keeps the transcript. Make her a note-taker instead.");
    if (record.status === "live") {
      await this.requireRealtime().setAgentRole(caller.principal, record.workspaceId, record.id, agentId, role);
    } else if (agentId !== "sibyl") {
      throw new MeetingError("Agents join once the meeting has started.", 409);
    }
    const updated = await this.mutate(record.id, (latest) => {
      const participants = latest.participants.map((participant) =>
        participant.agentId === agentId && role ? { ...participant, role } : participant
      );
      return { ...latest, participants, ...(agentId === "sibyl" && role ? { sibylRole: role } : {}) };
    });
    void this.signal(record, "roles");
    return this.view(updated ?? record, caller.principal);
  }

  /* ───────────── guests ───────────── */

  /** What a guest link shows before knocking (title and whether it is on). */
  async preview(id: string, key: unknown): Promise<{ title: string; hostName: string; status: MeetingRecord["status"] }> {
    const record = await this.byKey(id, key);
    return { title: record.title, hostName: record.hostName, status: record.status };
  }

  async knock(id: string, key: unknown, name: unknown): Promise<{ ticket: string }> {
    const record = await this.byKey(id, key);
    if (record.status === "ended") throw new MeetingError("This meeting has ended.", 410, "ended");
    try {
      const knock = this.lobby.knock(record.id, typeof name === "string" ? name : "");
      this.options.log("meeting.knock", { meetingId: record.id });
      void this.signal(record, "lobby", [hostIdentity(record)]);
      return { ticket: knock.ticket };
    } catch (error) {
      if (error instanceof LobbyError) throw new MeetingError(error.message, error.status);
      throw error;
    }
  }

  /** A guest polls its place in the lobby; once admitted it gets the room token. */
  async lobbyStatus(id: string, ticket: string): Promise<MeetingLobbyStatusView> {
    const record = await this.options.store.meetings.get(this.options.ownerId, id);
    const knock = record ? this.lobby.get(record.id, ticket) : undefined;
    if (!record || !knock) throw new MeetingError("This request to join has expired. Ask again.", 404, "not_found");
    if (record.status === "ended") return { status: "ended", title: record.title };
    if (knock.status !== "admitted") return { status: knock.status, title: record.title };
    const grant = await this.requireRealtime().guestToken(record.workspaceId, record.id, { id: knock.guestId, name: knock.name });
    return { status: "admitted", title: record.title, grant };
  }

  async lobbyWaiting(caller: MeetingCaller, id: string): Promise<MeetingLobbyEntryView[]> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record);
    return this.lobby.waiting(record.id).map((knock) => ({ ticket: knock.ticket, name: knock.name, at: knock.at }));
  }

  async decideKnock(caller: MeetingCaller, id: string, ticket: string, admit: boolean): Promise<boolean> {
    const record = await this.load(caller, id);
    this.requireHost(caller, record);
    const decided = this.lobby.decide(record.id, ticket, admit);
    if (decided) this.options.log("meeting.knock_decided", { meetingId: record.id, admitted: admit });
    return Boolean(decided);
  }

  /* ───────────── AI: notes and Ask AI ───────────── */

  /** Refresh the notes now (from what's new since the last refresh). */
  async refreshNotes(caller: MeetingCaller, id: string): Promise<MeetingView> {
    const record = await this.load(caller, id);
    await this.summarize(record.id, { final: record.status === "ended", force: true, userId: caller.principal.userId });
    return this.view((await this.options.store.meetings.get(this.options.ownerId, record.id)) ?? record, caller.principal);
  }

  async ask(caller: MeetingCaller, id: string, question: unknown): Promise<string> {
    if (typeof question !== "string" || !question.trim()) throw new MeetingError("Ask a question.");
    const record = await this.load(caller, id);
    const brain = this.brain;
    const model = brain?.model();
    if (!brain?.provider || !model) throw new MeetingError("No model is set up for Ask AI.", 503, "unavailable");
    const segments = await this.options.store.meetings.segments(this.options.ownerId, record.id);
    if (segments.length === 0) return "Nothing has been said in this meeting yet.";
    this.checkBudget(model, caller.principal.userId);
    let cost = 0;
    const answer = await askAboutMeeting(this.call(model, record, caller.principal.userId, (usd) => (cost += usd)), {
      meeting: record,
      notes: record.notes,
      segments,
      question
    });
    await this.addCost(record.id, cost);
    return answer || "I couldn't find an answer in this meeting.";
  }

  /* ───────────── comments ───────────── */

  async comments(caller: MeetingCaller, id: string): Promise<MeetingCommentView[]> {
    const record = await this.load(caller, id);
    const author = hostKey(caller.principal);
    return (await this.options.store.meetings.comments(this.options.ownerId, record.id)).map((comment) => commentView(comment, author));
  }

  async addComment(caller: MeetingCaller, id: string, input: { text?: unknown; parentId?: unknown; atMs?: unknown }): Promise<MeetingCommentView> {
    const record = await this.load(caller, id);
    const text = typeof input.text === "string" ? input.text.trim().slice(0, 4_000) : "";
    if (!text) throw new MeetingError("Write something first.");
    let parentId: string | undefined;
    if (typeof input.parentId === "string") {
      const parent = await this.options.store.meetings.getComment(this.options.ownerId, input.parentId);
      if (!parent || parent.meetingId !== record.id) throw new MeetingError("That comment no longer exists.", 404, "not_found");
      // One level of replies: a reply to a reply joins the same thread.
      parentId = parent.parentId ?? parent.id;
    }
    const atMs = typeof input.atMs === "number" && Number.isFinite(input.atMs) && input.atMs >= 0 ? Math.round(input.atMs) : undefined;
    const comment: MeetingComment = {
      id: randomBytes(10).toString("base64url"),
      ownerId: this.options.ownerId,
      meetingId: record.id,
      ...(parentId ? { parentId } : {}),
      authorId: hostKey(caller.principal),
      authorName: displayName(caller.principal),
      text,
      ...(atMs !== undefined ? { atMs } : {}),
      reactions: {},
      createdAt: this.now()
    };
    await this.options.store.meetings.upsertComment(comment);
    return commentView(comment, comment.authorId);
  }

  async editComment(caller: MeetingCaller, id: string, commentId: string, text: unknown): Promise<MeetingCommentView> {
    const { comment } = await this.ownComment(caller, id, commentId);
    const body = typeof text === "string" ? text.trim().slice(0, 4_000) : "";
    if (!body) throw new MeetingError("Write something first.");
    const next = { ...comment, text: body, editedAt: this.now() };
    await this.options.store.meetings.upsertComment(next);
    return commentView(next, next.authorId);
  }

  async deleteComment(caller: MeetingCaller, id: string, commentId: string): Promise<void> {
    const { comment } = await this.ownComment(caller, id, commentId, true);
    await this.options.store.meetings.removeComment(this.options.ownerId, comment.id);
  }

  /** Toggle your reaction on a comment. */
  async react(caller: MeetingCaller, id: string, commentId: string, emoji: unknown): Promise<MeetingCommentView> {
    const record = await this.load(caller, id);
    if (typeof emoji !== "string" || !REACTIONS.has(emoji)) throw new MeetingError("Unknown reaction.");
    const comment = await this.options.store.meetings.getComment(this.options.ownerId, commentId);
    if (!comment || comment.meetingId !== record.id) throw new MeetingError("That comment no longer exists.", 404, "not_found");
    const me = hostKey(caller.principal);
    const who = new Set(comment.reactions[emoji] ?? []);
    if (who.has(me)) who.delete(me);
    else who.add(me);
    const reactions = { ...comment.reactions };
    if (who.size === 0) delete reactions[emoji];
    else reactions[emoji] = [...who];
    const next = { ...comment, reactions };
    await this.options.store.meetings.upsertComment(next);
    return commentView(next, me);
  }

  /* ───────────── tasks from action items ───────────── */

  /** The action item a task is made from, and what the create_routine tool gets (a one-time routine). */
  async taskInput(caller: MeetingCaller, id: string, actionId: string): Promise<{ record: MeetingRecord; input: Record<string, unknown> }> {
    const record = await this.load(caller, id);
    const action = record.notes?.actions.find((item) => item.id === actionId);
    if (!action) throw new MeetingError("That action item is no longer in the notes.", 404, "not_found");
    if (action.routineId) throw new MeetingError("A task was already made from this action item.", 409, "exists");
    // 09:00 on the due date (in the person's time zone), or tomorrow when none was said or it has passed.
    const tomorrow = new Date(this.now() + 24 * 60 * 60 * 1000);
    const dueAt = action.due ? Date.parse(`${action.due}T23:59:59Z`) : NaN;
    const at = Number.isFinite(dueAt) && dueAt > this.now() ? new Date(dueAt) : tomorrow;
    const [day, month] = [at.getUTCDate(), at.getUTCMonth() + 1];
    const owner = action.owner ? ` (owner: ${action.owner})` : "";
    return {
      record,
      input: {
        name: action.text.slice(0, 110),
        instruction:
          `Follow-up from the meeting “${record.title}”: ${action.text}${owner}. ` +
          "Remind the people involved and do what you can with the available tools; post a short status.",
        cron: `0 9 ${day} ${month} *`,
        once: true
      }
    };
  }

  async taskCreated(id: string, actionId: string, routineId: string): Promise<void> {
    await this.mutate(id, (latest) => {
      if (!latest.notes) return latest;
      const actions = latest.notes.actions.map((action) => (action.id === actionId ? { ...action, routineId } : action));
      return { ...latest, notes: { ...latest.notes, actions } };
    });
  }

  /* ───────────── the room (CallHooks) ───────────── */

  private callHooks(): CallHooks {
    return {
      find: async (callId) => {
        const record = await this.options.store.meetings.get(this.options.ownerId, callId);
        return record ? { workspaceId: record.workspaceId, host: record.host, ended: record.status === "ended" } : undefined;
      },
      open: async ({ callId, principal, workspaceId, conversationId }) => {
        if (!ID.test(callId)) throw new RealtimeError("That meeting link isn't valid.", 404);
        // An older chat link (/call/<id>?host=1) without a record: the meeting starts now.
        const record = (await this.options.store.meetings.get(this.options.ownerId, callId)) ?? this.newRecord({ principal, workspaceId }, { conversationId }, callId);
        if (record.workspaceId !== workspaceId) throw new RealtimeError("That meeting isn't in this workspace.", 404);
        if (record.host !== hostKey(principal)) throw new RealtimeError("Only the host can bring Sibyl into this meeting.", 403);
        const now = this.now();
        const started: MeetingRecord = {
          ...record,
          status: "live",
          startedAt: record.startedAt ?? now,
          conversationId: record.conversationId ?? conversationId,
          updatedAt: now
        };
        delete started.endedAt;
        await this.options.store.meetings.upsert(started);
        this.lastNotesAt.set(started.id, now);
        this.options.log("meeting.started", { meetingId: started.id });
        return this.roomHooks(started);
      },
      closed: (callId, reason) => {
        void this.finish(callId, reason).catch((error: unknown) => this.options.log("meeting.finish_failed", { meetingId: callId, error: errorText(error) }));
      }
    };
  }

  private roomHooks(record: MeetingRecord): RoomMeetingHooks {
    const roles: Record<string, MeetingAgentRole> = { sibyl: record.sibylRole };
    for (const participant of record.participants) if (participant.agentId && participant.role) roles[participant.agentId] = participant.role;
    return {
      roles,
      onSegment: (segment) => this.appendSegment(record.id, segment),
      onArrival: (arrival) => void this.arrive(record.id, arrival)
    };
  }

  private appendSegment(id: string, segment: RoomSegment): void {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous
      .then(async () => {
        const record = await this.options.store.meetings.get(this.options.ownerId, id);
        if (!record) return;
        const start = record.startedAt ?? segment.startedAt;
        await this.options.store.meetings.appendSegment({
          meetingId: id,
          ownerId: this.options.ownerId,
          speaker: segment.speaker,
          speakerName: segment.speakerName,
          kind: segment.kind,
          startMs: Math.max(0, segment.startedAt - start),
          endMs: Math.max(0, segment.endedAt - start),
          text: segment.text.slice(0, 4_000),
          at: segment.startedAt
        });
        await this.mutate(id, (latest) => ({ ...latest, segmentCount: (latest.segmentCount ?? 0) + 1 }));
        await this.arrive(id, { identity: segment.speaker, name: segment.speakerName, kind: segment.kind, ...(segment.agentId ? { agentId: segment.agentId } : {}) });
        if (this.now() - (this.lastNotesAt.get(id) ?? 0) >= this.notesIntervalMs()) void this.summarize(id, { final: false });
      })
      .catch((error: unknown) => this.options.log("meeting.segment_failed", { meetingId: id, error: errorText(error) }));
    this.writes.set(id, write);
    void write.finally(() => {
      if (this.writes.get(id) === write) this.writes.delete(id);
    });
  }

  private async arrive(id: string, arrival: RoomArrival): Promise<void> {
    await this.mutate(id, (latest) => {
      const existing = latest.participants.find((participant) => participant.identity === arrival.identity);
      if (existing && (!arrival.role || existing.role === arrival.role)) return latest;
      if (existing) {
        return { ...latest, participants: latest.participants.map((p) => (p === existing ? { ...p, ...(arrival.role ? { role: arrival.role } : {}) } : p)) };
      }
      const participant: MeetingParticipant = {
        identity: arrival.identity,
        name: arrival.name.slice(0, 80),
        kind: arrival.kind,
        ...(arrival.identity.startsWith("user:") && arrival.identity !== "user:owner" ? { userId: arrival.identity.slice(5) } : {}),
        ...(arrival.agentId ? { agentId: arrival.agentId } : {}),
        ...(arrival.role ? { role: arrival.role } : {}),
        joinedAt: this.now(),
        color: latest.participants.length % MEETING_SPEAKER_COLORS
      };
      return { ...latest, participants: [...latest.participants, participant] };
    });
  }

  /** The room closed (or the host ended it): final notes, then "notes ready" to the people who were there. */
  private finish(id: string, reason: string): Promise<MeetingRecord | undefined> {
    const running = this.finishing.get(id);
    if (running) return running;
    const work = this.wrapUp(id, reason).finally(() => this.finishing.delete(id));
    this.finishing.set(id, work);
    return work;
  }

  private async wrapUp(id: string, reason: string): Promise<MeetingRecord | undefined> {
    const record = await this.options.store.meetings.get(this.options.ownerId, id);
    if (!record || record.status !== "live") return record;
    this.lobby.close(id);
    await this.writes.get(id);
    const ended = await this.mutate(id, (latest) => ({ ...latest, status: "ended", endedAt: this.now() }));
    this.options.log("meeting.ended", { meetingId: id, reason, segments: ended?.segmentCount ?? 0 });
    await this.summarize(id, { final: true });
    const done = await this.options.store.meetings.get(this.options.ownerId, id);
    if (done?.notes && this.options.notifications) {
      const people = new Set(done.participants.map((p) => p.userId).filter((userId): userId is string => Boolean(userId)));
      // The host, when they have an account (the org owner without one gets the workspace-wide notice).
      if (!done.host.includes(":") && done.host !== "owner") people.add(done.host);
      const notice = {
        kind: "meeting_notes" as const,
        workspaceId: done.workspaceId,
        title: `Notes ready: ${done.title}`,
        body: done.notes.overview || `${done.segmentCount ?? 0} transcript lines.`,
        links: { meetingId: done.id }
      };
      if (people.size === 0) this.options.notifications.publish(notice);
      for (const userId of people) this.options.notifications.publish({ ...notice, recipientUserId: userId });
    }
    return done;
  }

  /**
   * Incremental notes: the notes so far + transcript since the last refresh,
   * on the cheap notes model. One at a time per meeting; skipped (and logged)
   * when over budget or when too little is new.
   */
  private summarize(id: string, options: { final: boolean; force?: boolean; userId?: string }): Promise<void> {
    const running = this.summarizing.get(id);
    if (running) return options.final || options.force ? running.then(() => this.summarize(id, options)) : running;
    const work = this.runSummary(id, options)
      .catch((error: unknown) => this.options.log("meeting.notes_failed", { meetingId: id, error: errorText(error) }))
      .finally(() => this.summarizing.delete(id));
    this.summarizing.set(id, work);
    return work;
  }

  private async runSummary(id: string, options: { final: boolean; force?: boolean; userId?: string }): Promise<void> {
    const record = await this.options.store.meetings.get(this.options.ownerId, id);
    const brain = this.brain;
    const model = this.notesModel();
    if (!record || !brain?.provider || !model) return;
    const covered = record.notes?.coveredSeq ?? 0;
    const fresh = await this.options.store.meetings.segments(this.options.ownerId, id, covered);
    const chars = fresh.reduce((total, segment) => total + segment.text.length, 0);
    const finalPass = options.final && !record.notes?.final;
    if (fresh.length === 0 && !finalPass) return;
    if (chars < MIN_NEW_CHARS && !options.final && !options.force) return;
    if (fresh.length === 0 && !record.notes) return;
    this.lastNotesAt.set(id, this.now());
    try {
      this.checkBudget(model, options.userId);
    } catch (error) {
      this.options.log("meeting.notes_skipped", { meetingId: id, reason: errorText(error) });
      return;
    }
    const noteTaker = await this.noteTaker(record);
    let cost = 0;
    const started = this.now();
    const notes = await writeNotes(this.call(model, record, options.userId, (usd) => (cost += usd)), {
      meeting: record,
      previous: record.notes,
      segments: fresh,
      ...(noteTaker ? { noteTaker } : {}),
      final: options.final,
      today: new Date(this.now()).toISOString().slice(0, 10)
    });
    await this.addCost(id, cost);
    this.options.log("meeting.notes", { meetingId: id, lines: fresh.length, final: options.final, ms: this.now() - started, costUsd: Number(cost.toFixed(6)), ok: Boolean(notes) });
    if (!notes) return;
    const updated = await this.mutate(id, (latest) => ({
      ...latest,
      notes: {
        ...notes,
        coveredSeq: Math.max(covered, fresh.at(-1)?.seq ?? covered),
        updatedAt: this.now(),
        ...(options.final ? { final: true } : {}),
        ...(noteTaker?.agentId ? { by: { agentId: noteTaker.agentId, name: noteTaker.name } } : {})
      }
    }));
    if (updated) void this.signal(updated, "notes");
  }

  /** The agent credited with the notes: a note-taker agent in the meeting (its instructions shape them). */
  private async noteTaker(record: MeetingRecord): Promise<{ agentId?: string; name: string; instructions?: string } | undefined> {
    const taker = record.participants.find((participant) => participant.kind === "agent" && participant.role === "notetaker" && participant.agentId !== "sibyl");
    if (!taker?.agentId) return undefined;
    const agent = await this.options.store.agents.get(this.options.ownerId, taker.agentId).catch(() => undefined);
    return { agentId: taker.agentId, name: taker.name, ...(agent?.instructions ? { instructions: agent.instructions } : {}) };
  }

  /* ───────────── helpers ───────────── */

  private notesModel(): string | undefined {
    return this.options.env.SIBYL_MEETING_MODEL?.trim() || economyModel("brain", this.brain?.catalog?.()) || this.brain?.fastModel?.() || this.brain?.model();
  }

  private notesIntervalMs(): number {
    const seconds = Number(this.options.env.SIBYL_MEETING_NOTES_INTERVAL_SECONDS);
    return Number.isFinite(seconds) && seconds >= 10 ? seconds * 1000 : DEFAULT_NOTES_INTERVAL_MS;
  }

  private checkBudget(model: string, userId?: string): void {
    const estimateUsd = Math.max(0.0005, estimateTurnUsd(this.options.meter, "meetings", model, this.brain?.catalog?.()) || 0);
    const decision = this.options.meter.check({ ownerId: this.options.ownerId, estimateUsd, ...(userId ? { userId } : {}) });
    if (!decision.allowed) throw new MeetingError(decision.message, 402, "budget");
  }

  /** One metered model call (feature "meetings"), attributed to the meeting's workspace. */
  private call(model: string, record: MeetingRecord, userId: string | undefined, add: (usd: number) => void): ModelCall {
    const extraBody = this.brain?.extraBody?.(model);
    return {
      provider: this.brain!.provider!,
      model,
      ...(extraBody ? { extraBody } : {}),
      onUsage: (usage: ModelUsage) => {
        const meter = this.options.meter;
        let costUsd = usage.costUsd;
        if (costUsd === undefined && meter instanceof GatewayUsageMeter && (usage.promptTokens || usage.completionTokens)) {
          costUsd = new CostEstimator(meter.pricing, () => this.brain?.catalog?.()).llm("meetings", model, usage.promptTokens ?? 0, usage.completionTokens ?? 0);
        }
        const cost = Number.isFinite(costUsd) && (costUsd ?? 0) > 0 ? costUsd! : 0;
        add(cost);
        meter.record({
          ownerId: this.options.ownerId,
          feature: "meetings",
          model,
          costUsd: cost,
          estimated: usage.costUsd === undefined,
          ...(usage.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
          ...(usage.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
          requestId: `meeting:${record.id}`,
          ...(record.conversationId ? { conversationId: record.conversationId } : {}),
          ...(userId ? { userId } : {}),
          workspaceId: record.workspaceId
        });
      }
    };
  }

  private async addCost(id: string, usd: number): Promise<void> {
    if (usd <= 0) return;
    await this.mutate(id, (latest) => ({ ...latest, costUsd: (latest.costUsd ?? 0) + usd }));
  }

  private async signal(record: MeetingRecord, type: "notes" | "lobby" | "roles", to?: string[]): Promise<void> {
    await this.realtime?.callAgent(record.workspaceId, record.id)?.signal(type, to);
  }

  /** Read-modify-write of one meeting, one at a time per meeting (arrivals, segments and notes land together). */
  private mutate(id: string, change: (latest: MeetingRecord) => MeetingRecord): Promise<MeetingRecord | undefined> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const latest = await this.options.store.meetings.get(this.options.ownerId, id);
        if (!latest) return undefined;
        const changed = change(latest);
        if (changed === latest) return latest;
        const next = { ...changed, updatedAt: this.now() };
        await this.options.store.meetings.upsert(next);
        return next;
      });
    this.locks.set(id, run);
    void run
      .finally(() => {
        if (this.locks.get(id) === run) this.locks.delete(id);
      })
      .catch(() => undefined);
    return run;
  }

  private requireUse(caller: MeetingCaller): void {
    if (!authorize(caller.principal, PERMISSIONS.CHAT_USE, { workspaceId: caller.workspaceId })) {
      throw new MeetingError("You don't have access to meetings in this workspace.", 403, "forbidden");
    }
  }

  private async load(caller: MeetingCaller, id: string): Promise<MeetingRecord> {
    this.requireUse(caller);
    const record = ID.test(id) ? await this.options.store.meetings.get(this.options.ownerId, id) : undefined;
    if (!record || record.workspaceId !== caller.workspaceId) throw new MeetingError("Meeting not found.", 404, "not_found");
    return record;
  }

  /** The host runs a meeting; workspace admins may also edit or delete it afterwards (`orAdmin`). */
  private requireHost(caller: MeetingCaller, record: MeetingRecord, orAdmin = false): void {
    if (record.host === hostKey(caller.principal)) return;
    if (orAdmin && authorize(caller.principal, PERMISSIONS.WORKSPACE_SETTINGS, { workspaceId: record.workspaceId })) return;
    throw new MeetingError("Only the host can do that.", 403, "forbidden");
  }

  private requireRealtime(): RealtimeService {
    if (!this.realtime) throw new MeetingError("Calls aren't set up on this Sibyl (the realtime layer, LiveKit).", 503, "unavailable");
    return this.realtime;
  }

  private async byKey(id: string, key: unknown): Promise<MeetingRecord> {
    const record = ID.test(id) ? await this.options.store.meetings.get(this.options.ownerId, id) : undefined;
    if (!record || typeof key !== "string" || !sameSecret(key, record.inviteKey)) throw new MeetingError("This meeting link isn't valid.", 404, "not_found");
    return record;
  }

  private async ownComment(caller: MeetingCaller, id: string, commentId: string, orHost = false): Promise<{ record: MeetingRecord; comment: MeetingComment }> {
    const record = await this.load(caller, id);
    const comment = await this.options.store.meetings.getComment(this.options.ownerId, commentId);
    if (!comment || comment.meetingId !== record.id) throw new MeetingError("That comment no longer exists.", 404, "not_found");
    const mine = comment.authorId === hostKey(caller.principal);
    if (!mine && !(orHost && record.host === hostKey(caller.principal))) throw new MeetingError("Only the author can change this comment.", 403, "forbidden");
    return { record, comment };
  }

  private view(record: MeetingRecord, principal: Principal): MeetingView {
    const isHost = record.host === hostKey(principal);
    return {
      id: record.id,
      title: record.title,
      ...(record.description ? { description: record.description } : {}),
      status: record.status,
      hostName: record.hostName,
      isHost,
      ...(record.scheduledAt !== undefined ? { scheduledAt: record.scheduledAt } : {}),
      ...(record.scheduledEndAt !== undefined ? { scheduledEndAt: record.scheduledEndAt } : {}),
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      participants: record.participants.map(({ identity, name, kind, agentId, role, color, joinedAt }) => ({
        identity,
        name,
        kind,
        ...(agentId ? { agentId } : {}),
        ...(role ? { role } : {}),
        color,
        ...(joinedAt ? { joinedAt } : {})
      })),
      sibylRole: record.sibylRole,
      ...(record.notes ? { notes: notesView(record.notes) } : {}),
      ...(record.conversationId && isHost ? { conversationId: record.conversationId } : {}),
      ...(record.recordingId ? { recordingId: record.recordingId } : {}),
      // Hosted organizations: the link names the organization (o=), so a guest without an account reaches it.
      ...(isHost ? { guestPath: `/join/${encodeURIComponent(record.id)}?k=${encodeURIComponent(record.inviteKey)}${this.options.ownerId === "owner" ? "" : `&o=${encodeURIComponent(this.options.ownerId)}`}` } : {}),
      ...(record.calendar ? { calendar: record.calendar } : {}),
      ...(record.costUsd ? { costUsd: Number(record.costUsd.toFixed(6)) } : {}),
      segmentCount: record.segmentCount ?? 0
    };
  }
}

/* ───────────── pure helpers ───────────── */

function notesView(notes: MeetingNotes): NonNullable<MeetingView["notes"]> {
  return {
    overview: notes.overview,
    keyPoints: notes.keyPoints,
    insights: notes.insights,
    actions: notes.actions,
    updatedAt: notes.updatedAt,
    ...(notes.final ? { final: true } : {}),
    ...(notes.by ? { by: notes.by } : {})
  };
}

function commentView(comment: MeetingComment, me: string): MeetingCommentView {
  return {
    id: comment.id,
    ...(comment.parentId ? { parentId: comment.parentId } : {}),
    authorName: comment.authorName,
    mine: comment.authorId === me,
    text: comment.text,
    ...(comment.atMs !== undefined ? { atMs: comment.atMs } : {}),
    reactions: Object.entries(comment.reactions).map(([emoji, who]) => ({ emoji, count: who.length, mine: who.includes(me) })),
    createdAt: comment.createdAt,
    ...(comment.editedAt ? { editedAt: comment.editedAt } : {})
  };
}

function hostIdentity(record: MeetingRecord): string {
  return userIdentity(record.host === "owner" || record.host.includes(":") ? undefined : record.host);
}

function searchText(record: MeetingRecord): string {
  return [record.title, record.description ?? "", record.notes?.overview ?? "", ...record.participants.map((p) => p.name)].join(" ").toLowerCase();
}

function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function calendarRef(value: unknown): MeetingRecord["calendar"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { provider, eventId } = value as Record<string, unknown>;
  if ((provider !== "google" && provider !== "microsoft") || typeof eventId !== "string" || !eventId || eventId.length > 300) return undefined;
  return { provider, eventId };
}

function defaultTitle(now: number): string {
  return `Meeting ${new Date(now).toISOString().slice(0, 10)}`;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The meeting as Markdown: header, notes, action items, transcript. */
export function meetingMarkdown(record: MeetingRecord, segments: readonly MeetingSegment[]): string {
  const when = record.startedAt ?? record.scheduledAt;
  const lines: string[] = [`# ${record.title}`, ""];
  if (when) lines.push(`${new Date(when).toUTCString()}${record.endedAt && record.startedAt ? ` · ${Math.max(1, Math.round((record.endedAt - record.startedAt) / 60_000))} min` : ""}`, "");
  if (record.participants.length > 0) {
    lines.push(`**Participants:** ${record.participants.map((p) => (p.kind === "agent" ? `${p.name} (${p.role === "notetaker" ? "note-taker" : "agent"})` : p.kind === "guest" ? `${p.name} (guest)` : p.name)).join(", ")}`, "");
  }
  const notes = record.notes;
  if (notes) {
    if (notes.overview) lines.push("## Overview", "", notes.overview, "");
    if (notes.keyPoints.length) lines.push("## Key points", "", ...notes.keyPoints.map((point) => `- ${point}`), "");
    if (notes.insights.length) lines.push("## AI insights", "", ...notes.insights.map((insight) => `- ${insight}`), "");
    if (notes.actions.length) {
      lines.push("## Action items", "", ...notes.actions.map((a) => `- [ ] ${a.text}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (due ${a.due})` : ""}`), "");
    }
  }
  if (segments.length > 0) {
    lines.push("## Transcript", "");
    for (const segment of segments) lines.push(`**[${clock(segment.startMs)}] ${segment.speakerName}:** ${segment.text}`, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
