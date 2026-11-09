/**
 * The realtime layer: rooms, tokens, phone calls (SIP) and streams (ingress)
 * over a LiveKit server. One instance per gateway, created only when
 * LIVEKIT_* is configured (see config.ts); without it nothing here runs and
 * the native WebRTC module is never loaded.
 *
 * Sessions: the room agent always drives a gateway session (VoiceSessionPort).
 * - Voice and group calls use the browser's own session (visuals, approvals
 *   and history stay in that chat).
 * - Phone calls and streams have no browser: the gateway opens a headless
 *   session for them (bindSessions). Those run with a restricted, viewer-level
 *   principal: the person on the phone can talk and use read-only tools, but
 *   nothing that writes, whoever placed the call.
 */
import { randomBytes } from "node:crypto";
import { DataPacket_Kind, ParticipantInfo_Kind, TrackSource } from "@livekit/protocol";
import {
  IngressClient,
  IngressInput,
  RoomServiceClient,
  SipClient,
  WebhookReceiver,
  type IngressInfo,
  type WebhookEvent
} from "livekit-server-sdk";
import {
  MEETING_SIGNAL_TOPIC,
  REALTIME_EVENTS,
  type RealtimeCapability,
  type RealtimeJoinedMessage
} from "@open-gpt-live/protocol";
import {
  PERMISSIONS,
  authorize,
  type CallRecorder,
  type CallRecordingHost,
  type CallRoomInfo,
  type MeetingAgentRole,
  type Principal,
  type Store
} from "@open-gpt-live/core";
import type { AgentRuntime } from "../agents/runtime.js";
import { conversationVisible } from "../conversations.js";
import type { Authenticated } from "../identity/index.js";
import type { SecretVault } from "../secrets/vault.js";
import type { VoiceSessionPort } from "../session-port.js";
import type { RealtimeConfig } from "./config.js";
import { PhoneLine, PhoneError } from "./phone.js";
import { RoomAgent, type RoomAgentMode, type RoomMeetingHooks, type RoomPresent, type RoomSegment, type RoomVoiceProfile } from "./room-agent.js";
import { parseRoomName, roomName, roomPrefix, roomSpace, userIdentity, type RoomKind } from "./rooms.js";
import { issueToken } from "./token.js";

type Rtc = typeof import("@livekit/rtc-node");

/** A message the person may see (bad input, not set up, not allowed). */
export class RealtimeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type SessionOpener = (auth: Authenticated, workspaceId: string) => VoiceSessionPort;

/**
 * Meetings plug in here (apps/gateway/src/meetings): they own call records
 * (the meeting id is the call id) and what happens in the room.
 */
export interface CallHooks {
  /** The call (meeting) by id, if it exists. */
  find(callId: string): Promise<{ workspaceId: string; host: string; ended: boolean; title?: string } | undefined>;
  /** The host's session brings Sibyl in: throws a RealtimeError unless the caller may host it. */
  open(input: { callId: string; principal: Principal; workspaceId: string; conversationId: string }): Promise<RoomMeetingHooks>;
  /**
   * Sibyl left the call room (ended, emptied, host gone). `present`: who was
   * still in the room, so the meeting can pass the host role on instead of ending.
   */
  closed(callId: string, reason: string, present: RoomPresent[]): void;
  /** A recording of the call started (Enterprise): the meeting page plays it. */
  recorded?(callId: string, recordingId: string): Promise<void>;
}

export interface CallRecord {
  id: string;
  workspaceId: string;
  /** Who hosts it (their session brings Sibyl in). */
  host: string;
  conversationId?: string;
  createdAt: number;
}

export interface StreamView {
  id: string;
  name: string;
  input: "url" | "rtmp" | "whip";
  room: string;
  state: string;
  /** RTMP/WHIP: where to send the stream (with streamKey); URL: the source. */
  url?: string;
  streamKey?: string;
  conversationId?: string;
}

export interface RealtimeServiceOptions {
  config: RealtimeConfig;
  store: Store;
  ownerId: string;
  agents?: AgentRuntime;
  /** The vault (the phone line's SIP trunk password); filled in once secrets are installed. */
  vault?: () => SecretVault | undefined;
  /** Inbox notices (voicemail). */
  notify?: (input: { kind: "voicemail"; workspaceId: string; title: string; body: string; links: { conversationId?: string } }) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Tests: replace the native module and the clock the speech detector runs on. */
  loadRtc?: () => Promise<Rtc>;
  now?: () => number;
}

const CALLS_KEY = "realtime.calls";
const CALL_TTL_MS = 24 * 60 * 60 * 1000;
/** Why an agent left that doesn't end a meeting (the host's session brought Sibyl back, or handed the room on). */
const NOT_THE_END = new Set(["replaced"]);

export class RealtimeService {
  readonly config: RealtimeConfig;
  private openSession: SessionOpener | undefined;
  private rtc: Promise<Rtc> | undefined;
  /** Room agents by room name. */
  private readonly rooms = new Map<string, RoomAgent>();
  /** The room a browser session brought Sibyl into. */
  private readonly attached = new Map<VoiceSessionPort, RoomAgent>();
  /** Streams started from this gateway (ingress id → view details). */
  private readonly streams = new Map<string, { id: string; workspaceId: string; conversationId: string; input: StreamView["input"] }>();
  private readonly webhooks: WebhookReceiver;
  private clients: { rooms: RoomServiceClient; sip: SipClient; ingress: IngressClient } | undefined;
  private callHooks: CallHooks | undefined;
  private recorder: CallRecorder | undefined;
  /** The organization's phone line (Settings → Phone): set up, test, answer, call out, call log. */
  readonly phone: PhoneLine;

  /** A room of this organization's workspace (see rooms.ts: hosted rooms carry the organization). */
  roomFor(kind: RoomKind, workspaceId: string, id: string): string {
    return roomName(kind, roomSpace(this.options.ownerId, workspaceId), id);
  }

  private prefixFor(kind: RoomKind, workspaceId: string): string {
    return roomPrefix(kind, roomSpace(this.options.ownerId, workspaceId));
  }

  constructor(private readonly options: RealtimeServiceOptions) {
    this.config = options.config;
    this.webhooks = new WebhookReceiver(options.config.apiKey, options.config.apiSecret);
    this.phone = new PhoneLine({
      config: options.config,
      store: options.store,
      ownerId: options.ownerId,
      api: () => this.api(),
      prefixFor: (workspaceId) => this.prefixFor("phone", workspaceId),
      roomFor: (workspaceId, id) => this.roomFor("phone", workspaceId, id),
      headless: (principal, workspaceId) => this.headless(principal, workspaceId),
      startAgent: (input) => this.startAgent(input),
      candidates: (principal, workspaceId) => this.candidates(principal, workspaceId),
      ...(options.vault ? { vault: options.vault } : {}),
      recorder: () => this.recorder,
      ...(options.notify ? { notify: options.notify } : {}),
      log: options.log,
      ...(options.now ? { now: options.now } : {})
    });
  }

  /** What session.config advertises to the web app. */
  capability(phone = this.phone.canCallOut): RealtimeCapability {
    return { url: this.config.publicUrl, phone };
  }

  /** Meetings own call records and the room's transcript (see CallHooks). */
  useCalls(hooks: CallHooks): void {
    this.callHooks = hooks;
  }

  /** The gateway hands over how to open a session without a browser. */
  bindSessions(open: SessionOpener): void {
    this.openSession = open;
    void this.phone.settings().catch(() => undefined);
  }

  api(): { rooms: RoomServiceClient; sip: SipClient; ingress: IngressClient } {
    const { apiUrl, apiKey, apiSecret } = this.config;
    this.clients ??= {
      rooms: new RoomServiceClient(apiUrl, apiKey, apiSecret),
      sip: new SipClient(apiUrl, apiKey, apiSecret),
      ingress: new IngressClient(apiUrl, apiKey, apiSecret)
    };
    return this.clients;
  }

  /* ───────────── voice and group calls (a browser session) ───────────── */

  /** Bring the session's Sibyl into its voice room (no callId) or a call it hosts. */
  async join(port: VoiceSessionPort, callId?: string): Promise<RealtimeJoinedMessage> {
    const workspaceId = port.currentWorkspaceId;
    const principal = port.principal;
    let room: string;
    let meeting: RoomMeetingHooks | undefined;
    if (callId && this.callHooks) {
      meeting = await this.callHooks.open({ callId, principal, workspaceId, conversationId: port.conversationId });
      room = this.roomFor("call", workspaceId, callId);
    } else if (callId) {
      const call = await this.call(callId);
      if (call && (call.workspaceId !== workspaceId || call.host !== hostKey(principal))) {
        throw new RealtimeError("Only the person who started this call can bring Sibyl into it.", 403);
      }
      if (!call) await this.saveCall({ id: callId, workspaceId, host: hostKey(principal), conversationId: port.conversationId, createdAt: Date.now() });
      room = this.roomFor("call", workspaceId, callId);
    } else {
      room = this.roomFor("voice", workspaceId, port.conversationId);
    }
    await this.leave(port);
    await this.rooms.get(room)?.stop("replaced");
    const identity = userIdentity(principal.userId);
    const agent = await this.startAgent({
      room,
      port,
      mode: "conversation",
      hostIdentity: identity,
      principal,
      workspaceId,
      idleTimeoutMs: 30_000,
      emptyAfterLeaveMs: 15_000,
      ...(meeting ? { meeting } : {}),
      ...(callId && this.callHooks
        ? {
            onStop: (reason: string, present: RoomPresent[]) => {
              if (!NOT_THE_END.has(reason)) this.callHooks?.closed(callId, reason, present.filter((person) => person.identity !== identity));
            }
          }
        : {})
    });
    this.attached.set(port, agent);
    port.onClose(() => {
      if (this.attached.get(port) === agent) this.attached.delete(port);
    });
    const attributes: Record<string, string> = { "sibyl.kind": "person", ...(callId ? { "sibyl.host": "1" } : {}) };
    const token = await issueToken(this.config, { room, identity, name: displayName(principal), attributes, video: Boolean(callId) });
    return { type: REALTIME_EVENTS.JOINED, url: this.config.publicUrl, token, room, identity, kind: callId ? "call" : "voice", ...(callId ? { callId } : {}) };
  }

  async leave(port: VoiceSessionPort): Promise<void> {
    const agent = this.attached.get(port);
    this.attached.delete(port);
    await agent?.stop("left");
  }

  floor(port: VoiceSessionPort, holder: string | null): void {
    const agent = this.attached.get(port);
    if (!agent) throw new RealtimeError("Sibyl isn't in a call from this chat.");
    agent.setFloor(holder);
  }

  async invite(port: VoiceSessionPort, agentId: string): Promise<void> {
    const agent = this.attached.get(port);
    if (!agent) throw new RealtimeError("Sibyl isn't in a call from this chat.");
    await agent.invite(await this.profile(port.principal, port.currentWorkspaceId, agentId));
  }

  /* ───────────── meeting rooms (used by apps/gateway/src/meetings) ───────────── */

  /** The room agent of a call, if Sibyl is in it. */
  callAgent(workspaceId: string, callId: string): RoomAgent | undefined {
    return this.rooms.get(this.roomFor("call", workspaceId, callId));
  }

  /** Add an agent to a call, switch its role live, or (role null) send it away. */
  async setAgentRole(principal: Principal, workspaceId: string, callId: string, agentId: string, role: MeetingAgentRole | null): Promise<void> {
    const agent = this.callAgent(workspaceId, callId);
    if (!agent) throw new RealtimeError("Sibyl isn't in this meeting right now. Join it first.", 409);
    if (role === null) return agent.dismiss(agentId);
    const profile = await this.profile(principal, workspaceId, agentId);
    await agent.setRole(profile, role);
  }

  /** A token for a guest the host admitted (identity guest:<id>); never more than people get. */
  async guestToken(workspaceId: string, callId: string, guest: { id: string; name: string }): Promise<{ url: string; token: string; room: string; identity: string }> {
    const room = this.roomFor("call", workspaceId, callId);
    const identity = `guest:${guest.id}`;
    const token = await issueToken(this.config, { room, identity, name: guest.name, attributes: { "sibyl.kind": "guest" }, video: true });
    return { url: this.config.publicUrl, token, room, identity };
  }

  /** Host moderation: mute someone's microphone (they can unmute themselves). */
  async muteParticipant(workspaceId: string, callId: string, identity: string): Promise<boolean> {
    const room = this.roomFor("call", workspaceId, callId);
    const participant = await this.api().rooms.getParticipant(room, identity).catch(() => undefined);
    const track = participant?.tracks.find((item) => item.source === TrackSource.MICROPHONE && !item.muted);
    if (!track) return false;
    await this.api().rooms.mutePublishedTrack(room, identity, track.sid, true);
    return true;
  }

  /** Host moderation: remove someone from the room (their token can't bring them back once expired). */
  async removeParticipant(workspaceId: string, callId: string, identity: string): Promise<void> {
    await this.api().rooms.removeParticipant(this.roomFor("call", workspaceId, callId), identity);
  }

  /** Tell everyone in a call room something when Sibyl isn't there to say it (server API data packet). */
  async signalRoom(workspaceId: string, callId: string, payload: Record<string, unknown>): Promise<void> {
    await this.sendSignal(this.roomFor("call", workspaceId, callId), payload);
  }

  private async sendSignal(room: string, payload: Record<string, unknown>): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    await this.api()
      .rooms.sendData(room, data, DataPacket_Kind.RELIABLE, { topic: MEETING_SIGNAL_TOPIC })
      .catch((error: unknown) => this.options.log("realtime.signal_failed", { room, error: error instanceof Error ? error.message : String(error) }));
  }

  /** End the call for everyone: Sibyl leaves and the room closes. */
  async endCall(workspaceId: string, callId: string): Promise<void> {
    const room = this.roomFor("call", workspaceId, callId);
    const agent = this.rooms.get(room);
    await agent?.signal("ended");
    await agent?.stop("ended by host");
    await this.api().rooms.deleteRoom(room).catch(() => undefined);
  }

  private async profile(principal: Principal, workspaceId: string, agentId: string): Promise<RoomVoiceProfile> {
    const profile = (await this.candidates(principal, workspaceId)).find((candidate) => candidate.id === agentId);
    if (!profile) throw new RealtimeError("That agent isn't available to you in this workspace.", 404);
    return profile;
  }

  /**
   * A token for a person: the voice room of a conversation they can see, or a
   * call in their workspace (anyone in the workspace with the link may join).
   */
  async tokenFor(principal: Principal, workspaceId: string, target: { conversationId?: string; callId?: string }): Promise<{ url: string; token: string; room: string; identity: string }> {
    let room: string;
    let host = false;
    if (target.callId) {
      const call = await this.call(target.callId);
      if (!call || call.workspaceId !== workspaceId) throw new RealtimeError("That call has ended or isn't in this workspace.", 404);
      room = this.roomFor("call", workspaceId, call.id);
      host = call.host === hostKey(principal);
    } else if (target.conversationId) {
      const record = await this.options.store.conversations.get(this.options.ownerId, target.conversationId);
      const scope = { workspaceId, ...(principal.userId ? { userId: principal.userId } : {}), viewAll: authorize(principal, PERMISSIONS.CHAT_VIEW_ALL, { workspaceId }) };
      if (record && !conversationVisible(record, scope)) throw new RealtimeError("Conversation not found.", 404);
      room = this.roomFor("voice", workspaceId, target.conversationId);
    } else {
      throw new RealtimeError("conversationId or callId is required.");
    }
    const identity = userIdentity(principal.userId);
    const attributes: Record<string, string> = { "sibyl.kind": "person", ...(host ? { "sibyl.host": "1" } : {}) };
    const token = await issueToken(this.config, { room, identity, name: displayName(principal), attributes, video: Boolean(target.callId) });
    return { url: this.config.publicUrl, token, room, identity };
  }

  async call(id: string): Promise<CallRecord | undefined> {
    if (this.callHooks) {
      const found = await this.callHooks.find(id);
      return found && !found.ended ? { id, workspaceId: found.workspaceId, host: found.host, createdAt: 0 } : undefined;
    }
    const calls = await this.loadCalls();
    return calls[id];
  }

  /* ───────────── phone and webhooks ───────────── */

  /** Place a phone call (the place_phone_call tool, always after an approval). */
  placeCall(input: { principal: Principal; workspaceId: string; to: string; purpose: string; agentId?: string }): Promise<{ callId: string; room: string; conversationId: string }> {
    return this.phone.placeCall(input).catch((error: unknown) => {
      throw error instanceof PhoneError ? new RealtimeError(error.message, error.status) : error;
    });
  }

  /** LiveKit webhooks: inbound calls, rooms closing. */
  async receiveWebhook(body: string, authorization: string | undefined): Promise<void> {
    const event = await this.webhooks.receive(body, authorization);
    await this.onEvent(event);
  }

  private async onEvent(event: WebhookEvent): Promise<void> {
    const name = event.room?.name ?? "";
    const parsed = parseRoomName(name);
    if (event.event === "room_finished") {
      const agent = this.rooms.get(name);
      if (agent) await agent.stop("room finished");
      // A meeting room closed with nobody bringing Sibyl back (the host left it to others who then left): finish it.
      else if (parsed?.kind === "call" && this.callHooks && this.ownSpace(parsed.workspaceId)) this.callHooks.closed(parsed.id, "room finished", []);
      return;
    }
    if (event.event !== "participant_joined" || event.participant?.kind !== ParticipantInfo_Kind.SIP) return;
    if (!parsed || parsed.kind !== "phone") return;
    await this.phone.answer(name, event, (workspaceId) => roomSpace(this.options.ownerId, workspaceId) === parsed.workspaceId);
  }

  /** The room-name space belongs to this organization (hosted rooms carry the organization). */
  private ownSpace(space: string): boolean {
    return this.workspaceOfSpace(space) !== undefined;
  }

  private workspaceOfSpace(space: string): string | undefined {
    const owner = this.options.ownerId;
    if (owner === "owner") return /^o[0-9a-f]{24}_/.test(space) ? undefined : space;
    return space.startsWith(`${owner}_`) ? space.slice(owner.length + 1) : undefined;
  }

  /* ───────────── recordings (Enterprise plugs in through CallRecordingHost) ───────────── */

  /** The hooks the recordings module gets (packages/core/src/features.ts). */
  recordingHost(): CallRecordingHost {
    return {
      describe: async (room) => this.describeRoom(room),
      announce: async (room, state) => {
        // Everyone in a meeting sees "Recording" (LiveKit marks the room); phone callers hear it.
        // At once, before egress has joined (LiveKit's own "recording" flag follows a few seconds later).
        if (!this.phone.announce(room, state)) await this.sendSignal(room, { type: "recording", state });
      },
      linked: async (room, recordingId) => {
        const parsed = parseRoomName(room);
        if (parsed?.kind === "call") await this.callHooks?.recorded?.(parsed.id, recordingId);
        else if (parsed?.kind === "phone") await this.phone.linkRecording(room, recordingId);
      },
      useRecorder: (recorder) => {
        this.recorder = recorder;
      }
    };
  }

  private async describeRoom(room: string): Promise<CallRoomInfo | undefined> {
    const parsed = parseRoomName(room);
    const workspaceId = parsed ? this.workspaceOfSpace(parsed.workspaceId) : undefined;
    if (!parsed || !workspaceId) return undefined;
    if (parsed.kind === "call") {
      const meeting = await this.callHooks?.find(parsed.id);
      if (this.callHooks && (!meeting || meeting.workspaceId !== workspaceId)) return undefined;
      return { kind: "call", workspaceId, title: meeting?.title ?? "Call", meetingId: parsed.id };
    }
    if (parsed.kind === "phone") {
      const call = await this.phone.callOfRoom(room);
      const who = call?.remoteNumber ? ` with ${call.remoteNumber}` : "";
      return { kind: "phone", workspaceId, title: call ? `${call.direction === "inbound" ? "Incoming" : "Outgoing"} call${who}` : "Phone call", ...(call ? { callId: call.id } : {}) };
    }
    return undefined;
  }

  /* ───────────── streams (ingress) ───────────── */

  /** Bring a stream into a room; an agent listens and keeps notes in a new chat. */
  async createStream(input: { principal: Principal; workspaceId: string; name: string; input: StreamView["input"]; url?: string }): Promise<StreamView> {
    const name = input.name.trim().slice(0, 80) || "Stream";
    if (input.input === "url") {
      if (!input.url || !/^(https?|rtmps?|srt):\/\//i.test(input.url)) throw new RealtimeError("A direct media URL (HLS, MP4, MP3, …) is required.");
    }
    const id = randomId();
    const room = this.roomFor("stream", input.workspaceId, id);
    const session = this.headless(input.principal, input.workspaceId);
    session.addNote("Notes", `Listening to "${name}". Lines below are what was said.`);
    let ingressId: string | undefined;
    const agent = await this.startAgent({
      room,
      port: session,
      mode: "listen",
      principal: input.principal,
      workspaceId: input.workspaceId,
      // RTMP/WHIP: wait for the encoder to start sending.
      idleTimeoutMs: input.input === "url" ? 2 * 60_000 : 60 * 60_000,
      emptyAfterLeaveMs: 60_000,
      onStop: () => {
        session.close("stream ended");
        if (ingressId) {
          this.streams.delete(ingressId);
          void this.api().ingress.deleteIngress(ingressId).catch(() => undefined);
        }
      }
    });
    let info: IngressInfo;
    try {
      const kind = input.input === "url" ? IngressInput.URL_INPUT : input.input === "whip" ? IngressInput.WHIP_INPUT : IngressInput.RTMP_INPUT;
      info = await this.api().ingress.createIngress(kind, {
        name,
        roomName: room,
        participantIdentity: `stream:${id}`,
        participantName: name,
        ...(input.input === "url" ? { url: input.url } : {})
      });
    } catch (error) {
      await agent.stop("ingress failed");
      throw error;
    }
    ingressId = info.ingressId;
    this.streams.set(info.ingressId, { id: info.ingressId, workspaceId: input.workspaceId, conversationId: session.conversationId, input: input.input });
    this.options.log("realtime.stream_started", { room, input: input.input });
    return this.streamView(info);
  }

  async listStreams(workspaceId: string): Promise<StreamView[]> {
    const prefix = this.prefixFor("stream", workspaceId);
    const all = await this.api().ingress.listIngress();
    return all.filter((info) => info.roomName.startsWith(prefix)).map((info) => this.streamView(info));
  }

  async deleteStream(workspaceId: string, ingressId: string): Promise<boolean> {
    const [info] = await this.api().ingress.listIngress({ ingressId });
    if (!info || !info.roomName.startsWith(this.prefixFor("stream", workspaceId))) return false;
    await this.api().ingress.deleteIngress(ingressId);
    this.streams.delete(ingressId);
    await this.rooms.get(info.roomName)?.stop("stream deleted");
    return true;
  }

  private streamView(info: IngressInfo): StreamView {
    const known = this.streams.get(info.ingressId);
    const input: StreamView["input"] = known?.input ?? (info.inputType === IngressInput.WHIP_INPUT ? "whip" : info.inputType === IngressInput.URL_INPUT ? "url" : "rtmp");
    return {
      id: info.ingressId,
      name: info.name,
      input,
      room: info.roomName,
      state: ingressState(info),
      ...(info.url ? { url: info.url } : {}),
      ...(input !== "url" && info.streamKey ? { streamKey: info.streamKey } : {}),
      ...(known ? { conversationId: known.conversationId } : {})
    };
  }

  /* ───────────── shared ───────────── */

  /** Sibyl plus the agents this person may use in the workspace (addressable in calls). */
  async candidates(principal: Principal, workspaceId: string): Promise<RoomVoiceProfile[]> {
    const agents = this.options.agents && authorize(principal, PERMISSIONS.AGENTS_USE, { workspaceId })
      ? await this.options.agents.list(principal, workspaceId).catch(() => [])
      : [];
    return [{ id: "sibyl", name: "Sibyl" }, ...agents.map((agent) => ({ id: agent.id, name: agent.name, avatar: agent.avatar }))];
  }

  /** Rooms with a Sibyl agent in them right now (diagnostics, tests). */
  activeRooms(): Array<{ room: string; kind: RoomKind | undefined; mode: RoomAgentMode; people: number }> {
    return [...this.rooms.values()].map((agent) => ({ room: agent.room, kind: parseRoomName(agent.room)?.kind, mode: agent.mode, people: agent.people().length }));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.rooms.values()].map((agent) => agent.stop("gateway closing")));
    this.rooms.clear();
    this.attached.clear();
  }

  private headless(principal: Principal, workspaceId: string): VoiceSessionPort {
    if (!this.openSession) throw new RealtimeError("The realtime layer is still starting.", 503);
    // Never more than a viewer, whoever started it (see the file comment).
    const restricted: Principal = {
      kind: "user",
      orgId: principal.orgId,
      ...(principal.userId ? { userId: principal.userId } : {}),
      ...(principal.name ? { name: principal.name } : {}),
      workspaceRoles: { [workspaceId]: "viewer" }
    };
    return this.openSession({ principal: restricted }, workspaceId);
  }

  private loadRtc(): Promise<Rtc> {
    this.rtc ??= (this.options.loadRtc ?? (() => import("@livekit/rtc-node")))();
    return this.rtc;
  }

  private async startAgent(input: {
    room: string;
    port: VoiceSessionPort;
    mode: RoomAgentMode;
    hostIdentity?: string;
    principal: Principal;
    workspaceId: string;
    idleTimeoutMs: number;
    emptyAfterLeaveMs?: number;
    onStop?: (reason: string, present: RoomPresent[]) => void;
    onUtterance?: (segment: RoomSegment) => void;
    meeting?: RoomMeetingHooks;
  }): Promise<RoomAgent> {
    const agent = new RoomAgent({
      rtc: await this.loadRtc(),
      config: this.config,
      room: input.room,
      port: input.port,
      mode: input.mode,
      ...(input.hostIdentity ? { hostIdentity: input.hostIdentity } : {}),
      candidates: () => this.candidates(input.principal, input.workspaceId),
      idleTimeoutMs: input.idleTimeoutMs,
      ...(input.emptyAfterLeaveMs !== undefined ? { emptyAfterLeaveMs: input.emptyAfterLeaveMs } : {}),
      ...(input.meeting ? { meeting: input.meeting } : {}),
      ...(input.onUtterance ? { onUtterance: input.onUtterance } : {}),
      log: this.options.log,
      ...(this.options.now ? { now: this.options.now } : {}),
      onStop: (reason, present) => {
        if (this.rooms.get(input.room) === agent) this.rooms.delete(input.room);
        input.onStop?.(reason, present);
        if (input.hostIdentity) input.port.notify({ type: REALTIME_EVENTS.LEFT, room: input.room, reason });
      }
    });
    this.rooms.set(input.room, agent);
    await agent.start();
    return agent;
  }

  private async loadCalls(): Promise<Record<string, CallRecord>> {
    const calls = (await this.options.store.kv.get<Record<string, CallRecord>>(this.options.ownerId, CALLS_KEY)) ?? {};
    const now = Date.now();
    for (const [id, call] of Object.entries(calls)) if (now - call.createdAt > CALL_TTL_MS) delete calls[id];
    return calls;
  }

  private async saveCall(call: CallRecord): Promise<void> {
    const calls = await this.loadCalls();
    calls[call.id] = call;
    await this.options.store.kv.set(this.options.ownerId, CALLS_KEY, calls);
  }
}

/** Who hosts a call: the user, or the owner in single-owner mode. */
export function hostKey(principal: Principal): string {
  return principal.userId ?? `${principal.kind}:owner`;
}

/** The name others see on your tile and captions. */
export function displayName(principal: Principal): string {
  return principal.name ?? principal.email ?? (principal.kind === "user" ? "Member" : "Owner");
}

function randomId(): string {
  return randomBytes(12).toString("base64url");
}

function ingressState(info: IngressInfo): string {
  const status = info.state?.status;
  return ["inactive", "buffering", "publishing", "error", "complete"][status ?? 0] ?? "unknown";
}
