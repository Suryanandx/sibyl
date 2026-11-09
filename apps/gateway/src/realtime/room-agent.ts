/**
 * The room agent: Sibyl (and any of the workspace's agents) as participants
 * of a LiveKit room, running the SAME session pipeline as the WebSocket path.
 *
 * In:  each person's microphone track → 24 kHz PCM → the shared speech
 *      detector (@open-gpt-live/core/vad) → the session's own client
 *      messages (vad.speech_start, audio.chunk, vad.speech_end, interrupt),
 *      delivered through VoiceSessionPort with the same permission checks.
 * Out: the session's spoken segments (VoiceMediaSink) → decoded PCM → the
 *      answering agent's own audio track; its transcripts and replies →
 *      live captions (text streams on "lk.transcription").
 *
 * Modes:
 * - conversation, one person in the room (voice in a chat, a phone call):
 *   every turn goes to the session, like the browser's live mode.
 * - conversation, several people (group call): note-taker. Each utterance
 *   is transcribed; the session answers only when an agent is addressed
 *   (floor.ts); everything else is kept as a note in the conversation.
 * - listen (a stream): note-taker only, never speaks.
 *
 * Meetings (options.meeting): every utterance is transcribed first and kept
 * as a transcript segment (agents' replies too). Each agent has a role:
 * "participant" (speaks when addressed, as above) or "notetaker" (never
 * publishes audio and is never answered by; shown with a badge). Sibyl
 * always listens, so the room has a transcript whatever her role.
 */
import { randomUUID } from "node:crypto";
import type { AudioFrame, AudioSource, RemoteParticipant, RemoteTrack, Room } from "@livekit/rtc-node";
import type { LocalTrackPublication } from "@livekit/rtc-node";
import { AGENT_EVENTS, MEETING_SIGNAL_TOPIC, REALTIME_EVENTS, WS_EVENTS, type ServerMessage } from "@open-gpt-live/protocol";
import { AdaptiveVadEngine, DEFAULT_VAD_CONFIG, type AvatarSpec, type MeetingAgentRole, type MeetingParticipantKind, type VadConfig } from "@open-gpt-live/core";
import type { SpeechSegment, VoiceSessionPort } from "../session-port.js";
import { LISTEN_MIME_TYPE, LISTEN_SAMPLE_RATE, SpeechDecoder, pcmBytes, resample, rmsOf } from "./audio.js";
import type { RealtimeConfig } from "./config.js";
import { decide, type FloorCandidate, type FloorState } from "./floor.js";
import { SIBYL_IDENTITY, agentIdentity, isAgentIdentity } from "./rooms.js";
import { issueToken } from "./token.js";

type Rtc = typeof import("@livekit/rtc-node");

export type RoomAgentMode = "conversation" | "listen";

/** An agent who can speak in the room ("sibyl" or an agent id). */
export interface RoomVoiceProfile extends FloorCandidate {
  avatar?: AvatarSpec;
}

/** What was said in a meeting room (a person's utterance or an agent's reply). */
export interface RoomSegment {
  speaker: string;
  speakerName: string;
  kind: MeetingParticipantKind;
  agentId?: string;
  text: string;
  startedAt: number;
  endedAt: number;
}

/** Someone (or an agent) entered the meeting room. */
export interface RoomArrival {
  identity: string;
  name: string;
  kind: MeetingParticipantKind;
  agentId?: string;
  role?: MeetingAgentRole;
}

export interface RoomMeetingHooks {
  /** Roles at the start ("sibyl" / agent id → role; absent: participant). */
  roles: Record<string, MeetingAgentRole>;
  onSegment(segment: RoomSegment): void;
  onArrival(arrival: RoomArrival): void;
}

export interface RoomAgentOptions {
  rtc: Rtc;
  config: RealtimeConfig;
  room: string;
  port: VoiceSessionPort;
  mode: RoomAgentMode;
  /** The person whose browser drives this session (gets realtime.turn), if any. */
  hostIdentity?: string;
  /** Agents people may address in a group call (Sibyl is always one). */
  candidates: () => Promise<RoomVoiceProfile[]>;
  /** Leave after this long without a person (or stream) in the room. */
  idleTimeoutMs: number;
  /** Once someone was here and everyone left (hung up): leave after this long (default idleTimeoutMs). */
  emptyAfterLeaveMs?: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  onStop?: (reason: string) => void;
  now?: () => number;
  /** A meeting room: transcript segments, agent roles, arrivals. */
  meeting?: RoomMeetingHooks;
}

/**
 * Speech detection for server-side audio. Fixed thresholds instead of the
 * browser's one-second room calibration: a phone callee says "Hello?" and a
 * stream starts talking at once, and calibrating on speech would deafen the
 * detector. Browsers already normalise the microphone (noise suppression,
 * gain control), phones and streams arrive normalised.
 */
const SERVER_VAD: VadConfig = { ...DEFAULT_VAD_CONFIG, adaptiveEnabled: false, hangoverMs: 500 };
const FRAME_MS = 20;
const OUT_FRAME_SAMPLES = (LISTEN_SAMPLE_RATE * FRAME_MS) / 1000;
const CAPTION_TOPIC = "lk.transcription";

/** One speaking participant of ours (Sibyl or an agent) with its own audio track. */
interface Voice {
  id: string;
  identity: string;
  room: Room;
  source: AudioSource;
  /** Published voice track (absent while a note-taker). */
  publication?: LocalTrackPublication;
  track: ReturnType<Rtc["LocalAudioTrack"]["createAudioTrack"]>;
  decoder: SpeechDecoder;
  /** Segments play one after another. */
  chain: Promise<void>;
  /** Bumped to cancel what is queued (barge-in). */
  generation: number;
  playing: number;
  /** Request currently speaking (for captions). */
  requestId?: string;
}

/** One person's microphone. */
interface Listener {
  identity: string;
  name: string;
  vad: AdaptiveVadEngine;
  preRoll: Int16Array[];
  turn?: { requestId: string; startedAt: number; frames: Int16Array[]; sequence: number; streamed: boolean };
  stop(): void;
}

export class RoomAgent {
  readonly room: string;
  private readonly voices = new Map<string, Promise<Voice>>();
  private readonly listeners = new Map<string, Listener>();
  /** Which agent answers a request (from agent.turn), and who asked. */
  private readonly speakerOf = new Map<string, string>();
  private readonly askedBy = new Map<string, string>();
  /** Display names of the people heard (identity → name) and the last caption per segment. */
  private readonly speakerNames = new Map<string, string>();
  private readonly captionText = new Map<string, string>();
  private readonly captions = new Map<string, string>();
  private readonly floor: FloorState = {};
  /** Meeting roles ("sibyl" / agent id → role). */
  private readonly roles = new Map<string, MeetingAgentRole>();
  /** The last addressed turn went to an agent other than Sibyl (the session then answers as that agent). */
  private routedToAgent = false;
  /** When each reply started playing (meeting transcript). */
  private readonly replyStartedAt = new Map<string, number>();
  /** Segments being played or queued, across our voices. */
  private activeSpeakers = 0;
  private primary: Room | undefined;
  private stopped = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private hadPeople = false;
  private unobserve: (() => void) | undefined;
  private unclose: (() => void) | undefined;
  private readonly now: () => number;

  constructor(private readonly options: RoomAgentOptions) {
    this.room = options.room;
    this.now = options.now ?? Date.now;
    for (const [id, role] of Object.entries(options.meeting?.roles ?? {})) this.roles.set(id, role);
  }

  /** How an agent takes part ("sibyl" or an agent id). */
  roleOf(id: string): MeetingAgentRole {
    return this.roles.get(id) ?? "participant";
  }

  get mode(): RoomAgentMode {
    return this.options.mode;
  }

  /** People (and streams) in the room right now. */
  people(): RemoteParticipant[] {
    if (!this.primary) return [];
    const rtc = this.options.rtc;
    return [...this.primary.remoteParticipants.values()].filter(
      (participant) => !isAgentIdentity(participant.identity) && participant.kind !== rtc.ParticipantKind.EGRESS
    );
  }

  async start(): Promise<void> {
    const { port } = this.options;
    this.unobserve = port.observe((message) => this.onSessionMessage(message));
    this.unclose = port.onClose(() => void this.stop("session ended"));
    if (this.options.mode === "conversation") {
      port.attachMedia({
        speech: (segment) => this.play(segment),
        speechEnd: (requestId, reason) => {
          if (reason !== "stop") this.silence(requestId);
          this.finishCaption(requestId);
        }
      });
    }
    try {
      const sibyl = await this.voice("sibyl");
      this.primary = sibyl.room;
    } catch (error) {
      await this.stop("connect failed");
      throw error;
    }
    const room = this.primary;
    const rtc = this.options.rtc;
    room.on(rtc.RoomEvent.TrackSubscribed, (track, _publication, participant) => this.listen(track, participant));
    room.on(rtc.RoomEvent.TrackUnsubscribed, (_track, _publication, participant) => this.forget(participant.identity));
    room.on(rtc.RoomEvent.ParticipantConnected, (participant) => {
      this.arrived(participant);
      this.checkIdle();
    });
    room.on(rtc.RoomEvent.ParticipantDisconnected, (participant) => {
      this.forget(participant.identity);
      this.checkIdle();
    });
    room.on(rtc.RoomEvent.Disconnected, () => void this.stop("disconnected"));
    // People and tracks already there before we joined.
    for (const participant of room.remoteParticipants.values()) {
      this.arrived(participant);
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) this.listen(publication.track, participant);
      }
    }
    this.checkIdle();
    this.options.log("realtime.agent_joined", { room: this.room, mode: this.options.mode });
  }

  /** The host hands the floor to an agent ("sibyl" / agent id) or takes it back. */
  setFloor(holder: string | null): void {
    if (holder) this.floor.holder = holder;
    else delete this.floor.holder;
  }

  /** Bring an agent's own participant into the room before it is addressed. */
  async invite(profile: RoomVoiceProfile, role?: MeetingAgentRole): Promise<void> {
    if (role) this.roles.set(profile.id, role);
    const voice = await this.voice(profile.id, profile);
    if (role) await this.applyRole(voice);
  }

  /** Switch an agent (or Sibyl) between speaking participant and silent note-taker, live. */
  async setRole(profile: RoomVoiceProfile, role: MeetingAgentRole): Promise<void> {
    this.roles.set(profile.id, role);
    if (role === "notetaker") {
      if (this.floor.holder === profile.id) delete this.floor.holder;
      if (this.floor.lastReply?.agent === profile.id) delete this.floor.lastReply;
    }
    await this.applyRole(await this.voice(profile.id, profile));
  }

  /** An agent leaves the room (Sibyl stays: she keeps the transcript). */
  async dismiss(id: string): Promise<void> {
    if (id === "sibyl") return;
    const pending = this.voices.get(id);
    this.voices.delete(id);
    this.roles.delete(id);
    if (this.floor.holder === id) delete this.floor.holder;
    const voice = await pending?.catch(() => undefined);
    if (!voice) return;
    voice.generation += 1;
    voice.decoder.free();
    await voice.source.close().catch(() => undefined);
    await voice.room.disconnect().catch(() => undefined);
  }

  /** Nudge browsers in the room (they refetch over HTTP, where access is checked). */
  async signal(type: "notes" | "lobby" | "roles" | "ended", to?: string[]): Promise<void> {
    const room = this.primary;
    if (!room?.localParticipant || this.stopped) return;
    const data = new TextEncoder().encode(JSON.stringify({ type }));
    await room.localParticipant
      .publishData(data, { reliable: true, topic: MEETING_SIGNAL_TOPIC, ...(to?.length ? { destination_identities: to } : {}) })
      .catch((error: unknown) => this.options.log("realtime.signal_failed", { room: this.room, error: errorMessage(error) }));
  }

  /** Publish or withdraw the voice track to match the agent's role; the role is an attribute everyone sees. */
  private async applyRole(voice: Voice): Promise<void> {
    if (this.options.mode !== "conversation") return;
    const role = this.roleOf(voice.id);
    const participant = voice.room.localParticipant!;
    if (role === "notetaker" && voice.publication?.sid) {
      voice.generation += 1;
      voice.source.clearQueue();
      await participant.unpublishTrack(voice.publication.sid, false);
      delete voice.publication;
    } else if (role === "participant" && !voice.publication) {
      voice.publication = await participant.publishTrack(voice.track, new this.options.rtc.TrackPublishOptions({ source: this.options.rtc.TrackSource.SOURCE_MICROPHONE }));
    }
    if (this.options.meeting) await participant.setAttributes({ "sibyl.role": role }).catch(() => undefined);
  }

  /** A person or guest entered (meeting participants list). */
  private arrived(participant: RemoteParticipant): void {
    if (!this.options.meeting || isAgentIdentity(participant.identity)) return;
    if (participant.kind === this.options.rtc.ParticipantKind.EGRESS) return;
    this.options.meeting.onArrival({
      identity: participant.identity,
      name: participant.name || participant.identity,
      kind: participant.identity.startsWith("guest:") ? "guest" : "person"
    });
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.unobserve?.();
    this.unclose?.();
    if (this.options.mode === "conversation") this.options.port.attachMedia(undefined);
    for (const listener of this.listeners.values()) listener.stop();
    this.listeners.clear();
    const voices = await Promise.allSettled([...this.voices.values()]);
    this.voices.clear();
    for (const result of voices) {
      if (result.status !== "fulfilled") continue;
      const voice = result.value;
      voice.generation += 1;
      voice.decoder.free();
      await voice.source.close().catch(() => undefined);
      await voice.room.disconnect().catch(() => undefined);
    }
    this.options.log("realtime.agent_left", { room: this.room, reason });
    this.options.onStop?.(reason);
  }

  /* ───────────── voices (our participants) ───────────── */

  private voice(id: string, profile?: RoomVoiceProfile): Promise<Voice> {
    let voice = this.voices.get(id);
    if (!voice) {
      voice = this.connectVoice(id, profile);
      this.voices.set(id, voice);
      voice.catch(() => this.voices.delete(id));
    }
    return voice;
  }

  private async connectVoice(id: string, given?: RoomVoiceProfile): Promise<Voice> {
    const { rtc, config } = this.options;
    const profile = given ?? (await this.options.candidates()).find((candidate) => candidate.id === id) ?? { id, name: id === "sibyl" ? "Sibyl" : "Agent" };
    const identity = agentIdentity(id);
    const role = this.roleOf(id);
    const attributes: Record<string, string> = { "sibyl.kind": "agent", "sibyl.agent": id };
    if (this.options.meeting) attributes["sibyl.role"] = role;
    if (profile.avatar) attributes["sibyl.avatar"] = JSON.stringify(profile.avatar);
    const token = await issueToken(config, { room: this.room, identity, name: profile.name, attributes, agent: true, ttlSeconds: 6 * 60 * 60 });
    const room = new rtc.Room();
    // Only Sibyl's own connection listens; extra agent voices just speak.
    await room.connect(config.url, token, { autoSubscribe: id === "sibyl", dynacast: false });
    const source = new rtc.AudioSource(LISTEN_SAMPLE_RATE, 1, 1_000);
    const track = rtc.LocalAudioTrack.createAudioTrack(`${id}-voice`, source);
    // Silent note-takers never publish a voice.
    const publication =
      this.options.mode === "conversation" && role === "participant"
        ? await room.localParticipant!.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }))
        : undefined;
    this.options.meeting?.onArrival({ identity, name: profile.name, kind: "agent", agentId: id, role });
    return { id, identity, room, source, track, ...(publication ? { publication } : {}), decoder: new SpeechDecoder(), chain: Promise.resolve(), generation: 0, playing: 0 };
  }

  /** One of our voices is playing (or has speech queued). */
  private speaking(): boolean {
    return this.activeSpeakers > 0;
  }

  private play(segment: SpeechSegment): void {
    const id = this.speakerOf.get(segment.requestId) ?? "sibyl";
    void this.voice(id)
      .then((voice) => {
        const generation = voice.generation;
        voice.playing += 1;
        this.activeSpeakers += 1;
        voice.requestId = segment.requestId;
        if (!this.replyStartedAt.has(segment.requestId)) remember(this.replyStartedAt, segment.requestId, this.now());
        voice.chain = voice.chain
          .then(async () => {
            if (generation !== voice.generation || this.stopped) return;
            const pcm = await voice.decoder.decode(segment.audio, segment.mimeType);
            const samples = resample(pcm, LISTEN_SAMPLE_RATE);
            this.options.log("realtime.speech", { room: this.room, agent: id, ms: Math.round((samples.length / LISTEN_SAMPLE_RATE) * 1000), rate: pcm.sampleRate, rms: Number(rmsOf(samples).toFixed(3)) });
            for (let offset = 0; offset < samples.length; offset += OUT_FRAME_SAMPLES) {
              if (generation !== voice.generation || this.stopped) return;
              // A frame owns its samples (the native side reads the whole underlying buffer).
              const frame = new Int16Array(OUT_FRAME_SAMPLES);
              frame.set(samples.subarray(offset, Math.min(samples.length, offset + OUT_FRAME_SAMPLES)));
              await voice.source.captureFrame(new this.options.rtc.AudioFrame(frame, LISTEN_SAMPLE_RATE, 1, OUT_FRAME_SAMPLES));
            }
            if (segment.isFinal) await voice.source.waitForPlayout();
          })
          .catch((error: unknown) => this.options.log("realtime.play_failed", { room: this.room, error: errorMessage(error) }))
          .finally(() => {
            voice.playing -= 1;
            this.activeSpeakers -= 1;
            if (segment.isFinal && voice.playing === 0) this.repliedTo(segment.requestId, id);
          });
      })
      .catch((error: unknown) => this.options.log("realtime.voice_failed", { room: this.room, agent: id, error: errorMessage(error) }));
  }

  /** Stop speaking at once (barge-in, or the reply was interrupted). */
  private silence(requestId?: string): void {
    for (const pending of this.voices.values()) {
      void pending.then((voice) => {
        if (requestId && voice.requestId !== requestId) return;
        voice.generation += 1;
        voice.source.clearQueue();
      }).catch(() => undefined);
    }
  }

  /** The floor follows the conversation: a quick follow-up from the same person goes to the same agent. */
  private repliedTo(requestId: string, agent: string): void {
    const speaker = this.askedBy.get(requestId);
    if (speaker) this.floor.lastReply = { speaker, agent, at: this.now() };
  }

  /* ───────────── listening (people's microphones) ───────────── */

  private listen(track: RemoteTrack, participant: RemoteParticipant): void {
    const rtc = this.options.rtc;
    if (this.stopped || track.kind !== rtc.TrackKind.KIND_AUDIO) return;
    if (isAgentIdentity(participant.identity) || participant.kind === rtc.ParticipantKind.EGRESS) return;
    this.forget(participant.identity);
    const stream = new rtc.AudioStream(track, { sampleRate: LISTEN_SAMPLE_RATE, numChannels: 1, frameSizeMs: FRAME_MS });
    const reader = stream.getReader();
    const listener: Listener = {
      identity: participant.identity,
      name: participant.name || participant.identity,
      // Note-taking keeps whole sentences together; a conversation answers sooner.
      vad: new AdaptiveVadEngine(this.options.mode === "listen" ? { ...SERVER_VAD, hangoverMs: 1_000 } : SERVER_VAD),
      preRoll: [],
      stop: () => void reader.cancel().catch(() => undefined)
    };
    listener.vad.reset(this.now());
    this.options.log("realtime.listening", { room: this.room, participant: participant.identity, kind: participant.kind });
    this.listeners.set(participant.identity, listener);
    remember(this.speakerNames, participant.identity, listener.name);
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || this.stopped || this.listeners.get(listener.identity) !== listener) break;
          this.onFrame(listener, value);
        }
      } catch (error) {
        this.options.log("realtime.listen_failed", { room: this.room, error: errorMessage(error) });
      }
    })();
  }

  private forget(identity: string): void {
    const listener = this.listeners.get(identity);
    if (!listener) return;
    this.listeners.delete(identity);
    listener.stop();
    if (listener.turn) this.cancelTurn(listener);
  }

  private onFrame(listener: Listener, frame: AudioFrame): void {
    const samples = new Int16Array(frame.data);
    const now = this.now();
    if (listener.turn) this.appendToTurn(listener, samples);
    else {
      listener.preRoll.push(samples);
      while (listener.preRoll.length * FRAME_MS > SERVER_VAD.preRollMs) listener.preRoll.shift();
    }
    const result = listener.vad.processFrame({ rms: rmsOf(samples), now, playbackActive: this.speaking(), suppressStartsUntil: 0 });
    const event = result.event;
    if (event?.type === "speech_start") this.startTurn(listener, event.startedAt);
    else if (event?.type === "speech_end") void this.endTurn(listener, event.endedAt);
    else if (event?.type === "speech_cancel") this.cancelTurn(listener);
  }

  /** Several people in a conversation room: note-taker etiquette. */
  private isGroup(): boolean {
    return this.people().length > 1;
  }

  private startTurn(listener: Listener, startedAt: number): void {
    // Any person speaking interrupts an agent (barge-in).
    if (this.options.mode === "conversation" && this.speaking()) {
      this.silence();
      this.options.port.deliver({ type: WS_EVENTS.INTERRUPT, reason: "live mode barge-in" });
    }
    const requestId = randomUUID();
    // Stream audio straight into the session in a 1:1 conversation; otherwise (groups, meetings) wait for the words.
    const streamed = this.options.mode === "conversation" && !this.isGroup() && !this.options.meeting;
    listener.turn = { requestId, startedAt, frames: [], sequence: 0, streamed };
    const preRoll = listener.preRoll.splice(0);
    if (streamed) {
      remember(this.askedBy, requestId, listener.identity);
      this.notifyTurn(requestId, "start", listener.identity);
      this.options.port.deliver({ type: WS_EVENTS.VAD_SPEECH_START, requestId, turnMode: "live", startedAt });
    }
    for (const samples of preRoll) this.appendToTurn(listener, samples);
  }

  private appendToTurn(listener: Listener, samples: Int16Array): void {
    const turn = listener.turn!;
    if (!turn.streamed) {
      turn.frames.push(samples);
      return;
    }
    this.options.port.deliver({
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: turn.requestId,
      chunk: pcmBytes(samples).toString("base64"),
      mimeType: LISTEN_MIME_TYPE,
      sequence: turn.sequence++,
      turnMode: "live",
      isFinal: false
    });
  }

  private cancelTurn(listener: Listener): void {
    const turn = listener.turn;
    listener.turn = undefined;
    if (!turn?.streamed) return;
    const endedAt = this.now();
    this.options.port.deliver({ type: WS_EVENTS.VAD_SPEECH_END, requestId: turn.requestId, endedAt, durationMs: endedAt - turn.startedAt, reason: "cancelled" });
    this.notifyTurn(turn.requestId, "cancel", listener.identity);
  }

  private async endTurn(listener: Listener, endedAt: number): Promise<void> {
    const turn = listener.turn;
    listener.turn = undefined;
    if (!turn) return;
    const { port } = this.options;
    if (turn.streamed) {
      port.deliver({ type: WS_EVENTS.AUDIO_CHUNK, requestId: turn.requestId, mimeType: LISTEN_MIME_TYPE, sequence: turn.sequence, turnMode: "live", isFinal: true });
      port.deliver({ type: WS_EVENTS.VAD_SPEECH_END, requestId: turn.requestId, endedAt, durationMs: endedAt - turn.startedAt, reason: "silence" });
      this.notifyTurn(turn.requestId, "end", listener.identity);
      return;
    }
    // Group call or stream: transcribe first, then answer or keep it as a note.
    const pcm = Buffer.concat(turn.frames.map(pcmBytes));
    let text: string;
    try {
      text = await port.transcribe(pcm, LISTEN_SAMPLE_RATE, turn.requestId);
    } catch (error) {
      this.options.log("realtime.transcribe_failed", { room: this.room, error: errorMessage(error) });
      return;
    }
    if (!text || this.stopped) return;
    void this.caption(SIBYL_IDENTITY, `${turn.requestId}:user`, text, true, listener.identity, listener.name);
    this.options.meeting?.onSegment({
      speaker: listener.identity,
      speakerName: listener.name,
      kind: listener.identity.startsWith("guest:") ? "guest" : "person",
      text,
      startedAt: turn.startedAt,
      endedAt
    });
    // Note-takers are never answered by; in a meeting with one person Sibyl (a participant) still waits to be addressed.
    // Agents already in the room come first (two agents may share a name).
    const candidates = (await this.options.candidates())
      .filter((candidate) => this.roleOf(candidate.id) === "participant")
      .sort((a, b) => Number(this.voices.has(b.id)) - Number(this.voices.has(a.id)));
    const to =
      this.options.mode === "conversation" ? decide({ text, speaker: listener.identity, now: this.now(), state: this.floor, candidates }) : undefined;
    if (!to) {
      port.addNote(listener.name, text);
      return;
    }
    remember(this.askedBy, turn.requestId, listener.identity);
    this.notifyTurn(turn.requestId, "start", listener.identity);
    // A turn addressed to an agent makes it the session's agent; Sibyl takes over again when she is named.
    if (to === "sibyl" && this.routedToAgent) port.deliver({ type: AGENT_EVENTS.SELECT, agentId: null });
    this.routedToAgent = to !== "sibyl";
    port.deliver({ type: WS_EVENTS.VAD_SPEECH_START, requestId: turn.requestId, turnMode: "live", startedAt: turn.startedAt, ...(to !== "sibyl" ? { agentId: to } : {}) });
    turn.frames.forEach((samples, sequence) =>
      port.deliver({ type: WS_EVENTS.AUDIO_CHUNK, requestId: turn.requestId, chunk: pcmBytes(samples).toString("base64"), mimeType: LISTEN_MIME_TYPE, sequence, turnMode: "live", isFinal: false })
    );
    port.deliver({ type: WS_EVENTS.AUDIO_CHUNK, requestId: turn.requestId, mimeType: LISTEN_MIME_TYPE, sequence: turn.frames.length, turnMode: "live", isFinal: true });
    port.deliver({ type: WS_EVENTS.VAD_SPEECH_END, requestId: turn.requestId, endedAt, durationMs: endedAt - turn.startedAt, reason: "silence", caption: text });
    this.notifyTurn(turn.requestId, "end", listener.identity);
  }

  private notifyTurn(requestId: string, phase: "start" | "end" | "cancel", speaker: string): void {
    if (this.options.hostIdentity) this.options.port.notify({ type: REALTIME_EVENTS.TURN, requestId, phase, speaker });
  }

  /* ───────────── what the session says → speakers and captions ───────────── */

  private onSessionMessage(message: ServerMessage): void {
    switch (message.type) {
      case AGENT_EVENTS.TURN:
        remember(this.speakerOf, message.requestId, message.agentId);
        break;
      case WS_EVENTS.BRAIN_START: {
        // A deep-brain gist is spoken by whoever handed the task over.
        const speaker = this.speakerOf.get(message.parentRequestId);
        if (speaker) remember(this.speakerOf, message.requestId, speaker);
        const asked = this.askedBy.get(message.parentRequestId);
        if (asked) remember(this.askedBy, message.requestId, asked);
        break;
      }
      case WS_EVENTS.TRANSCRIPT_FINAL:
      case WS_EVENTS.TRANSCRIPT_UPDATE: {
        const speaker = this.askedBy.get(message.requestId);
        if (speaker && message.text.trim()) void this.caption(SIBYL_IDENTITY, `${message.requestId}:user`, message.text, true, speaker);
        break;
      }
      case WS_EVENTS.LLM_DELTA: {
        const text = (this.captions.get(message.requestId) ?? "") + message.delta;
        remember(this.captions, message.requestId, text);
        break;
      }
      case WS_EVENTS.LLM_DONE:
        if (message.reason !== "stop") this.captions.delete(message.requestId);
        break;
      default:
        break;
    }
  }

  /** The agent's reply as one final caption (spoken text only: visuals and cues removed). */
  private finishCaption(requestId: string): void {
    const text = this.captions.get(requestId);
    this.captions.delete(requestId);
    const spoken = text ? spokenText(text) : "";
    if (!spoken) return;
    const id = this.speakerOf.get(requestId) ?? "sibyl";
    void this.caption(agentIdentity(id), requestId, spoken, true);
    const startedAt = this.replyStartedAt.get(requestId) ?? this.now();
    this.replyStartedAt.delete(requestId);
    void this.voice(id)
      .then((voice) =>
        this.options.meeting?.onSegment({
          speaker: voice.identity,
          speakerName: voice.room.localParticipant?.name || (id === "sibyl" ? "Sibyl" : id),
          kind: "agent",
          agentId: id,
          text: spoken,
          startedAt,
          endedAt: this.now()
        })
      )
      .catch(() => undefined);
  }

  private async caption(from: string, segmentId: string, text: string, final: boolean, speaker?: string, speakerName?: string): Promise<void> {
    // The same words again (transcript.final after our own group-call caption): skip.
    if (this.captionText.get(segmentId) === text) return;
    remember(this.captionText, segmentId, text);
    const name = speakerName ?? (speaker ? this.speakerNames.get(speaker) : undefined);
    try {
      const id = from === SIBYL_IDENTITY ? "sibyl" : from.slice("agent:".length);
      const voice = await this.voice(id);
      await voice.room.localParticipant!.sendText(text, {
        topic: CAPTION_TOPIC,
        attributes: {
          "lk.segment_id": segmentId,
          "lk.transcription_final": String(final),
          "sibyl.speaker": speaker ?? from,
          ...(name ? { "sibyl.speaker_name": name } : {})
        }
      });
    } catch (error) {
      this.options.log("realtime.caption_failed", { room: this.room, error: errorMessage(error) });
    }
  }

  /* ───────────── leaving ───────────── */

  private checkIdle(): void {
    if (this.stopped) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.people().length > 0) {
      this.hadPeople = true;
      return;
    }
    const wait = this.hadPeople ? (this.options.emptyAfterLeaveMs ?? this.options.idleTimeoutMs) : this.options.idleTimeoutMs;
    this.idleTimer = setTimeout(() => void this.stop("room empty"), wait);
    this.idleTimer.unref?.();
  }
}

/** Small bounded maps: requests are forgotten after a few hundred. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 300) map.delete(map.keys().next().value as string);
}


/** What a reply sounded like: the voice text without @brain/@silence lines, visuals or emotion cues. */
export function spokenText(reply: string): string {
  return reply
    .split("\n")
    .filter((line) => !/^\s*@(brain|silence)\b/i.test(line))
    .join(" ")
    .replace(/\[[^\]\n]{1,40}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
