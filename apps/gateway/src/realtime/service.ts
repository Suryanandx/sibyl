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
import { ParticipantInfo_Kind, SIPTransport, TrackSource } from "@livekit/protocol";
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
  AGENT_EVENTS,
  REALTIME_EVENTS,
  type RealtimeCapability,
  type RealtimeJoinedMessage
} from "@open-gpt-live/protocol";
import { PERMISSIONS, authorize, type MeetingAgentRole, type Principal, type Store } from "@open-gpt-live/core";
import type { AgentRuntime } from "../agents/runtime.js";
import { conversationVisible } from "../conversations.js";
import type { Authenticated } from "../identity/index.js";
import type { VoiceSessionPort } from "../session-port.js";
import type { RealtimeConfig } from "./config.js";
import { RoomAgent, type RoomAgentMode, type RoomMeetingHooks, type RoomVoiceProfile } from "./room-agent.js";
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
  find(callId: string): Promise<{ workspaceId: string; host: string; ended: boolean } | undefined>;
  /** The host's session brings Sibyl in: throws a RealtimeError unless the caller may host it. */
  open(input: { callId: string; principal: Principal; workspaceId: string; conversationId: string }): Promise<RoomMeetingHooks>;
  /** Sibyl left the call room (ended, emptied, host gone). */
  closed(callId: string, reason: string): void;
}

export interface CallRecord {
  id: string;
  workspaceId: string;
  /** Who hosts it (their session brings Sibyl in). */
  host: string;
  conversationId?: string;
  createdAt: number;
}

/** Phone line set up from Settings (one number per organization). */
export interface PhoneSettings {
  provider: "twilio" | "other";
  /** E.164 number of the line. */
  number: string;
  workspaceId: string;
  /** Agent that answers (absent: Sibyl). */
  agentId?: string;
  greeting?: string;
  outboundTrunkId?: string;
  inboundTrunkId?: string;
  dispatchRuleId?: string;
  updatedAt: number;
}

export interface PhoneSetupInput {
  provider: "twilio" | "other";
  /** SIP host of the provider, e.g. "example.pstn.twilio.com". */
  address: string;
  number: string;
  username?: string;
  password?: string;
  workspaceId: string;
  agentId?: string;
  greeting?: string;
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
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Tests: replace the native module and the clock the speech detector runs on. */
  loadRtc?: () => Promise<Rtc>;
  now?: () => number;
}

const CALLS_KEY = "realtime.calls";
const PHONE_KEY = "realtime.phone";
const CALL_TTL_MS = 24 * 60 * 60 * 1000;
const E164 = /^\+[1-9]\d{6,14}$/;
const SIP_HOST = /^[A-Za-z0-9.-]{3,253}(:\d{1,5})?$/;

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
  }

  /** What session.config advertises to the web app. */
  capability(phone = Boolean(this.config.sipOutboundTrunkId || this.phoneCache?.outboundTrunkId)): RealtimeCapability {
    return { url: this.config.publicUrl, phone };
  }

  /** Meetings own call records and the room's transcript (see CallHooks). */
  useCalls(hooks: CallHooks): void {
    this.callHooks = hooks;
  }

  /** The gateway hands over how to open a session without a browser. */
  bindSessions(open: SessionOpener): void {
    this.openSession = open;
    void this.phoneSettings().catch(() => undefined);
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
      ...(callId && this.callHooks ? { onStop: (reason: string) => this.callHooks?.closed(callId, reason) } : {})
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

  /* ───────────── phone (SIP) ───────────── */

  private phoneCache: PhoneSettings | undefined;

  async phoneSettings(): Promise<PhoneSettings | undefined> {
    this.phoneCache = await this.options.store.kv.get<PhoneSettings>(this.options.ownerId, PHONE_KEY);
    return this.phoneCache;
  }

  /** Create the SIP trunks and the inbound dispatch rule for one number (Twilio documented first). */
  async setupPhone(input: PhoneSetupInput): Promise<PhoneSettings> {
    if (!E164.test(input.number)) throw new RealtimeError("The number must be in E.164 form, like +15551234567.");
    if (!SIP_HOST.test(input.address)) throw new RealtimeError("The SIP address must be a host name, like example.pstn.twilio.com.");
    const { sip } = this.api();
    await this.removePhone();
    const auth = input.username && input.password ? { authUsername: input.username, authPassword: input.password } : {};
    const outbound = await sip.createSipOutboundTrunk("Sibyl outbound", input.address, [input.number], { transport: SIPTransport.SIP_TRANSPORT_AUTO, ...auth });
    const inbound = await sip.createSipInboundTrunk("Sibyl inbound", [input.number], {});
    // Rooms are named after the called line (never the caller): sibyl.phone.<ws>.<line>_<random>.
    const rule = await sip.createSipDispatchRule(
      { type: "callee", roomPrefix: this.prefixFor("phone", input.workspaceId), randomize: true },
      { name: "Sibyl inbound", trunkIds: [inbound.sipTrunkId] }
    );
    const settings: PhoneSettings = {
      provider: input.provider,
      number: input.number,
      workspaceId: input.workspaceId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.greeting?.trim() ? { greeting: input.greeting.trim().slice(0, 300) } : {}),
      outboundTrunkId: outbound.sipTrunkId,
      inboundTrunkId: inbound.sipTrunkId,
      dispatchRuleId: rule.sipDispatchRuleId,
      updatedAt: Date.now()
    };
    await this.options.store.kv.set(this.options.ownerId, PHONE_KEY, settings);
    this.phoneCache = settings;
    this.options.log("realtime.phone_setup", { workspaceId: input.workspaceId, provider: input.provider });
    return settings;
  }

  async removePhone(): Promise<void> {
    const current = await this.phoneSettings();
    if (!current) return;
    const { sip } = this.api();
    if (current.dispatchRuleId) await sip.deleteSipDispatchRule(current.dispatchRuleId).catch(() => undefined);
    for (const trunk of [current.inboundTrunkId, current.outboundTrunkId]) {
      if (trunk) await sip.deleteSipTrunk(trunk).catch(() => undefined);
    }
    await this.options.store.kv.delete(this.options.ownerId, PHONE_KEY);
    this.phoneCache = undefined;
  }

  /**
   * Place a phone call: Sibyl (or an agent) joins a new room, then LiveKit
   * dials the number into it. Only reached through the place_phone_call tool,
   * which always needs the person's approval.
   */
  async placeCall(input: { principal: Principal; workspaceId: string; to: string; purpose: string; agentId?: string }): Promise<{ callId: string; room: string; conversationId: string }> {
    const settings = this.phoneCache ?? (await this.phoneSettings());
    const trunk = this.config.sipOutboundTrunkId ?? settings?.outboundTrunkId;
    if (!trunk) throw new RealtimeError("Phone calls aren't set up on this Sibyl (see docs/realtime.md#phone-calls).", 409);
    if (!E164.test(input.to)) throw new RealtimeError("The number must be in E.164 form, like +15551234567.");
    const id = randomId();
    const room = this.roomFor("phone", input.workspaceId, id);
    const session = this.headless(input.principal, input.workspaceId);
    if (input.agentId) session.deliver({ type: AGENT_EVENTS.SELECT, agentId: input.agentId });
    const caller = input.principal.name ?? input.principal.email ?? "the person you work for";
    session.addNote(
      "Call brief",
      `You are on a phone call you placed for ${caller}. Purpose: ${input.purpose.slice(0, 1_000)} ` +
        "When they answer, greet them, say who you are calling for, handle the purpose briefly and politely, and end the call when done."
    );
    const agent = await this.startAgent({
      room,
      port: session,
      mode: "conversation",
      principal: input.principal,
      workspaceId: input.workspaceId,
      idleTimeoutMs: 60_000,
      emptyAfterLeaveMs: 2_000,
      onStop: () => session.close("call ended")
    });
    try {
      await this.api().sip.createSipParticipant(trunk, input.to, room, {
        participantIdentity: `phone:${id}`,
        participantName: "Phone",
        ...((this.config.sipFromNumber ?? settings?.number) ? { fromNumber: this.config.sipFromNumber ?? settings?.number } : {}),
        ringingTimeout: 45,
        maxCallDuration: 30 * 60,
        playDialtone: false
      });
    } catch (error) {
      await agent.stop("dial failed");
      throw error;
    }
    this.options.log("realtime.phone_call", { room, workspaceId: input.workspaceId });
    return { callId: id, room, conversationId: session.conversationId };
  }

  /** LiveKit webhooks: inbound calls, rooms closing. */
  async receiveWebhook(body: string, authorization: string | undefined): Promise<void> {
    const event = await this.webhooks.receive(body, authorization);
    await this.onEvent(event);
  }

  private async onEvent(event: WebhookEvent): Promise<void> {
    const name = event.room?.name ?? "";
    if (event.event === "room_finished") {
      await this.rooms.get(name)?.stop("room finished");
      return;
    }
    if (event.event !== "participant_joined" || event.participant?.kind !== ParticipantInfo_Kind.SIP) return;
    const parsed = parseRoomName(name);
    // Outbound calls already have their agent in the room.
    if (!parsed || parsed.kind !== "phone" || this.rooms.has(name)) return;
    const line = await this.phoneSettings();
    if (!line || roomSpace(this.options.ownerId, line.workspaceId) !== parsed.workspaceId) {
      this.options.log("realtime.phone_unrouted", { room: name });
      return;
    }
    // The caller is a stranger: a viewer-level session with no person behind it.
    const principal: Principal = { kind: "user", orgId: this.options.ownerId, name: "Phone caller", workspaceRoles: { [line.workspaceId]: "viewer" } };
    const session = this.headless(principal, line.workspaceId);
    if (line.agentId) session.deliver({ type: AGENT_EVENTS.SELECT, agentId: line.agentId });
    await this.startAgent({
      room: name,
      port: session,
      mode: "conversation",
      principal,
      workspaceId: line.workspaceId,
      idleTimeoutMs: 30_000,
      emptyAfterLeaveMs: 2_000,
      onStop: () => session.close("call ended")
    });
    session.say(line.greeting ?? "Hello, this is Sibyl. How can I help?");
    this.options.log("realtime.phone_answered", { room: name, workspaceId: line.workspaceId });
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
    onStop?: (reason: string) => void;
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
      log: this.options.log,
      ...(this.options.now ? { now: this.options.now } : {}),
      onStop: (reason) => {
        if (this.rooms.get(input.room) === agent) this.rooms.delete(input.room);
        input.onStop?.(reason);
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
