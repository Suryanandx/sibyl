/**
 * GPT Realtime as a voice engine of one gateway session.
 *
 * The session keeps doing what it always does: the browser (or the LiveKit
 * room agent) sends live turns (vad.speech_start, audio.chunk, vad.speech_end,
 * interrupt), replies go out as transcript.*, llm.delta and tts.*, and the
 * conversation, budgets, agents, approvals and the deep brain are the
 * session's. Only the voice changes: instead of the voice brain + TTS, the
 * turn's audio goes to one OpenAI Realtime session (server-side; the key never
 * leaves the gateway) and its spoken answer comes back as audio.
 *
 *   speech_start ─► audio.chunk… ─► speech_end ─► commit + response.create
 *                                                     │
 *       tts.start / tts.chunk (WAV) / tts.end ◄── output audio
 *       llm.delta ◄── output transcript        transcript.update ◄── input transcript
 *       ask_sibyl(task) ─► the deep brain (tools, approvals, visuals) ─► function output ─► spoken result
 *
 * Turn-taking: "quick" commits at the end of Sibyl's own speech detection;
 * "balanced"/"patient" let OpenAI's semantic turn detection decide, fed with
 * silence after each browser turn (a pause mid-thought folds the next turn in,
 * as turn.merged).
 */
import {
  REALTIME_PCM_RATE,
  resamplePcm16,
  type OpenAIRealtimeVoiceClient,
  type RealtimeFunctionTool,
  type RealtimeResponseUsage,
  type RealtimeVoiceEvent,
  type RealtimeTranscriptionUsage,
  type LLMMessage
} from "@open-gpt-live/adapters";
import { REALTIME_HANDOFF_TOOL } from "@open-gpt-live/genui";
import { WS_EVENTS, type RealtimeTurnDetection, type ServerMessage } from "@open-gpt-live/protocol";
import { responseUsd, transcriptionUsd, realtimeTurnEstimate, type RealtimeEngineConfig } from "./config.js";

/** What the engine needs from its session (GatewayConnection implements it). */
export interface VoiceEngineHost {
  readonly sessionId: string;
  now(): number;
  createId(): string;
  log(event: string, fields?: Record<string, unknown>): void;
  send(message: ServerMessage): void;
  /** Spoken reply audio (24 kHz PCM): to the LiveKit room when it plays the voice, else tts.chunk. */
  speech(requestId: string, pcm: Buffer, segmentIndex: number, isFinal: boolean): void;
  /** The reply's speech ended. */
  speechEnd(requestId: string, reason: "stop" | "interrupted" | "error"): void;
  /** The conversation so far (no system message). */
  history(): readonly LLMMessage[];
  /** A spoken user turn: added to the history and the stored conversation. */
  beginUserTurn(requestId: string, entry: LLMMessage, transcriptReady: Promise<void>): void;
  /** The spoken reply (and the user's words, once transcribed) are saved. */
  completeReply(requestId: string, entry: LLMMessage | undefined, reply: { content: string; model: string }): void;
  /** A new user turn started (makes older deep-brain results stale). Returns the turn number. */
  newTurn(): number;
  turn(): number;
  /** Stop what Sibyl's own pipeline is saying (barge-in across engines). */
  interruptPipeline(reason: string): void;
  /** Agent, persona and voice for this turn (sends agent.turn). undefined: the requested agent can't be used. */
  prepareTurn(requestId: string): Promise<{ instructions: string; voice: string; agentId?: string } | undefined>;
  /** Budgets (organization, workspace, user, agent) before spending ~estimateUsd; sends budget.blocked when not. */
  budgetAllows(requestId: string, estimateUsd: number): boolean;
  record(input: { requestId: string; model: string; costUsd: number; promptTokens?: number; completionTokens?: number; units?: number; ownKey: boolean }): void;
  /** Hand a task to the deep brain (tools, approvals, visuals in chat). Resolves with its spoken gist. */
  deepBrain(parentRequestId: string, task: string): Promise<{ requestId: string; gist: string; visual: boolean; entry: LLMMessage } | { error: string }>;
  /** GPT Realtime couldn't take this turn: run it on Sibyl's own pipeline instead. */
  fallback(requestId: string, pcm24k: Buffer, caption: string | undefined): Promise<void>;
  /** Open a Realtime session with the organization's key. */
  connect(model: string, signal: AbortSignal): Promise<{ client: OpenAIRealtimeVoiceClient; ownKey: boolean }>;
}

export interface RealtimeEngineSettings {
  model: string;
  voice: string;
  turn: RealtimeTurnDetection;
}

interface InputTurn {
  requestIds: string[];
  caption: string;
  /** All audio of the turn (for the fallback when GPT Realtime can't be reached). */
  audio: Buffer[];
  audioBytes: number;
  state: "recording" | "waiting" | "committed";
  /** Realtime items committed for this turn (in order) and their transcripts. */
  items: string[];
  transcripts: Map<string, string>;
  speechEndedAt?: number;
  padTimer?: NodeJS.Timeout;
  padUntil?: number;
  /** The history entry of the turn (its text becomes the transcript). */
  entry?: LLMMessage;
  resolveTranscript?: () => void;
}

interface ActiveResponse {
  requestId: string;
  /** A spoken deep-brain result (requestId is the brain run). */
  brain: boolean;
  responseId?: string;
  itemId?: string;
  pcm: Buffer[];
  bufferedBytes: number;
  segmentIndex: number;
  sentMs: number;
  firstAudioAt?: number;
  ttsStarted: boolean;
  transcript: string;
  handoff?: string;
  interrupted: boolean;
  userEntry?: LLMMessage;
  speechEndedAt?: number;
}

const HANDOFF_TOOL: RealtimeFunctionTool = {
  name: REALTIME_HANDOFF_TOOL,
  description:
    "Hand a task to Sibyl's deep brain: careful reasoning, current information (web), the user's files, apps and data, actions (with the user's approval), and visuals on the user's screen. Returns a short result to tell the user.",
  parameters: {
    type: "object",
    properties: { task: { type: "string", description: "A precise, self-contained task with every relevant detail from the conversation." } },
    required: ["task"]
  }
};

/** Bytes of 24 kHz 16-bit mono per millisecond. */
const BYTES_PER_MS = (REALTIME_PCM_RATE * 2) / 1000;
/** The first speech segment goes out after ~120 ms of audio; later ones in ~300 ms pieces. */
const FIRST_SEGMENT_BYTES = 120 * BYTES_PER_MS;
const SEGMENT_BYTES = 300 * BYTES_PER_MS;
/** Silence fed to semantic turn detection after a browser turn, per tick. */
const PAD_TICK_MS = 100;
const PAD_LIMIT_MS: Record<RealtimeTurnDetection, number> = { quick: 0, balanced: 4_500, patient: 8_500 };
const EAGERNESS: Record<Exclude<RealtimeTurnDetection, "quick">, "medium" | "low"> = { balanced: "medium", patient: "low" };
/** Wait this long for the user's transcript before the deep brain / storage go on without it. */
const TRANSCRIPT_WAIT_MS = 6_000;
/** Earlier conversation sent along when a Realtime session (re)opens. */
const CONTEXT_ENTRIES = 30;
/** After a failed connection, use Sibyl's voice for this long before trying again. */
const RETRY_AFTER_MS = 60_000;
/** Errors that only mean "nothing to do". */
const BENIGN_ERRORS = new Set(["input_audio_buffer_commit_empty", "response_cancel_not_active", "conversation_already_has_active_response"]);
/** Larger than any turn the gateway accepts (25 MB). */
const MAX_BUFFERED_BYTES = 25 * 1024 * 1024;

export class RealtimeVoiceEngine {
  private client: OpenAIRealtimeVoiceClient | undefined;
  private connecting: Promise<OpenAIRealtimeVoiceClient | undefined> | undefined;
  private connectController: AbortController | undefined;
  private ownKey = false;
  private connected: { model: string; voice: string; instructions: string; turn: RealtimeTurnDetection; voiceLocked: boolean } | undefined;
  /** History entries the Realtime conversation already has. */
  private known = new WeakSet<LLMMessage>();
  private input: InputTurn | undefined;
  private response: ActiveResponse | undefined;
  /** Deep-brain calls waiting for the brain (call id → turn). */
  private readonly handoffs = new Map<string, number>();
  private idleTimer: NodeJS.Timeout | undefined;
  /** Requests refused before they started (budget): their audio and end are dropped. */
  private readonly refused = new Set<string>();
  /** Answered turns whose transcripts may still arrive. */
  private readonly committedTurns: InputTurn[] = [];
  /** A deep-brain result to speak once the current reply ends (same turn only). */
  private pendingResult: { requestId: string; turn: number } | undefined;
  /** Realtime response id → Sibyl request id (usage arrives with response.done). */
  private readonly responseRequests = new Map<string, string>();
  private failedAt: number | undefined;
  private disposed = false;
  private unsubscribe: (() => void) | undefined;
  private settings: RealtimeEngineSettings;

  constructor(
    private readonly host: VoiceEngineHost,
    private readonly config: RealtimeEngineConfig,
    settings: RealtimeEngineSettings
  ) {
    this.settings = settings;
  }

  /** The last connection failed recently: Sibyl's voice takes turns for a while. */
  get coolingDown(): boolean {
    return this.failedAt !== undefined && this.host.now() - this.failedAt < RETRY_AFTER_MS;
  }

  /** The engine is working on this request (its audio and end go here). */
  owns(requestId: string): boolean {
    return this.refused.has(requestId) || Boolean(this.input?.requestIds.includes(requestId));
  }

  update(settings: RealtimeEngineSettings): void {
    this.settings = settings;
  }

  /* ───────────── live turns ───────────── */

  speechStart(requestId: string): boolean {
    if (this.disposed) return false;
    const estimate = realtimeTurnEstimate(this.prices().prices, this.config.transcriptionModel);
    if (!this.host.budgetAllows(requestId, estimate)) {
      // Spending is capped: no new Realtime turn (and no idle session kept open).
      this.closeClient("budget");
      this.refused.add(requestId);
      this.host.send({ type: WS_EVENTS.LLM_DONE, requestId, reason: "error" });
      return true;
    }
    // Talking over a reply stops it (the browser stopped playback already).
    if (this.response && !this.response.interrupted) this.interrupt(this.response.requestId, "barge-in");
    this.host.interruptPipeline("new user turn");
    clearTimeout(this.idleTimer);
    const previous = this.input;
    if (previous && previous.state === "waiting" && this.semantic()) {
      // Still within the semantic pause: the same thought continues.
      this.stopPadding(previous);
      previous.state = "recording";
      const merged = previous.requestIds.at(-1)!;
      previous.requestIds.push(requestId);
      this.host.send({ type: WS_EVENTS.TURN_MERGED, requestId, mergedRequestId: merged });
      this.host.log("realtime.turn_merged", { sessionId: this.host.sessionId, requestId, mergedRequestId: merged });
    } else {
      if (previous && previous.state !== "committed") this.abandonInput(previous);
      else if (previous) this.rememberCommitted(previous);
      this.input = { requestIds: [requestId], caption: "", audio: [], audioBytes: 0, state: "recording", items: [], transcripts: new Map() };
    }
    this.host.newTurn();
    void this.ensureConnected();
    return true;
  }

  audio(requestId: string, chunk: Buffer, mimeType: string): void {
    const turn = this.input;
    if (!turn || !turn.requestIds.includes(requestId) || turn.state !== "recording" || chunk.byteLength === 0) return;
    const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? REALTIME_PCM_RATE);
    const pcm = rate === REALTIME_PCM_RATE ? chunk : resamplePcm16(chunk, rate, REALTIME_PCM_RATE);
    if (turn.audioBytes + pcm.byteLength > MAX_BUFFERED_BYTES) return;
    turn.audio.push(pcm);
    turn.audioBytes += pcm.byteLength;
    if (this.client?.open) this.client.appendAudio(pcm);
  }

  speechEnd(requestId: string, caption: string | undefined, reason: "silence" | "manual" | "cancelled"): void {
    if (this.refused.delete(requestId)) return;
    const turn = this.input;
    if (!turn || !turn.requestIds.includes(requestId) || turn.state !== "recording") return;
    if (reason === "cancelled") {
      turn.requestIds = turn.requestIds.filter((id) => id !== requestId);
      if (!turn.requestIds.length) this.abandonInput(turn);
      return;
    }
    if (caption?.trim()) turn.caption = [turn.caption, caption.trim()].filter(Boolean).join(" ");
    turn.speechEndedAt = this.host.now();
    turn.state = "waiting";
    if (!this.semantic()) {
      void this.respondTo(turn);
      return;
    }
    // Semantic turn detection hears silence until it decides (or the pause is too long).
    turn.padUntil = this.host.now() + PAD_LIMIT_MS[this.settings.turn];
    const silence = Buffer.alloc(PAD_TICK_MS * BYTES_PER_MS);
    turn.padTimer = setInterval(() => {
      if (this.input !== turn || turn.state !== "waiting") return this.stopPadding(turn);
      if (this.host.now() >= (turn.padUntil ?? 0) || !this.client?.open) {
        this.stopPadding(turn);
        void this.respondTo(turn);
        return;
      }
      this.client.appendAudio(silence);
    }, PAD_TICK_MS);
  }

  /** Stop the reply to this request (or the current one). */
  interrupt(requestId: string | undefined, reason: string): void {
    const response = this.response;
    if (!response || response.interrupted || (requestId !== undefined && response.requestId !== requestId)) return;
    response.interrupted = true;
    this.response = undefined;
    this.client?.cancelResponse(response.responseId);
    if (response.itemId && response.firstAudioAt !== undefined) {
      // What the user heard: the audio sent so far, at most the time since it started playing.
      this.client?.truncate(response.itemId, Math.min(response.sentMs, this.host.now() - response.firstAudioAt));
    }
    if (response.ttsStarted) this.host.speechEnd(response.requestId, "interrupted");
    this.host.send({ type: WS_EVENTS.LLM_DONE, requestId: response.requestId, reason: "interrupted" });
    this.finishReply(response, `${response.transcript.trim()}${response.transcript.trim() ? "…" : ""}`);
    this.host.log("realtime.interrupted", { sessionId: this.host.sessionId, requestId: response.requestId, reason });
  }

  close(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.input) this.stopPadding(this.input);
    this.closeClient(reason);
  }

  /* ───────────── the Realtime session ───────────── */

  private semantic(): boolean {
    return this.settings.turn !== "quick";
  }

  private prices() {
    return this.config.prices[this.settings.model] ?? this.config.prices[this.config.defaultModel]!;
  }

  private ensureConnected(): Promise<OpenAIRealtimeVoiceClient | undefined> {
    const wanted = this.settings;
    const current = this.connected;
    if (this.client?.open && current && current.model === wanted.model && current.turn === wanted.turn && (!current.voiceLocked || current.voice === wanted.voice)) {
      return Promise.resolve(this.client);
    }
    if (this.connecting) return this.connecting;
    // A different model or turn detection, or a new voice after audio was produced: a new session.
    this.closeClient("settings changed");
    const controller = new AbortController();
    this.connectController = controller;
    const startedAt = this.host.now();
    this.connecting = this.host
      .connect(wanted.model, controller.signal)
      .then(({ client, ownKey }) => {
        if (this.disposed || controller.signal.aborted) {
          client.close(1000, "session ended");
          return undefined;
        }
        this.client = client;
        this.ownKey = ownKey;
        this.known = new WeakSet();
        this.failedAt = undefined;
        this.connected = { model: wanted.model, voice: wanted.voice, instructions: "", turn: wanted.turn, voiceLocked: false };
        this.unsubscribe = client.on((event) => this.onEvent(client, event));
        this.configure(client, "", wanted.voice);
        // Audio that arrived while connecting.
        const turn = this.input;
        if (turn && turn.state !== "committed") for (const part of turn.audio) client.appendAudio(part);
        this.host.log("realtime.connected", { sessionId: this.host.sessionId, model: wanted.model, ms: Math.round(this.host.now() - startedAt) });
        return client;
      })
      .catch((error: unknown) => {
        this.failedAt = this.host.now();
        const message = error instanceof Error ? error.message : String(error);
        this.host.log("realtime.connect_failed", { sessionId: this.host.sessionId, model: wanted.model, error: message });
        this.host.send({ type: "error", scope: "llm", message: `GPT Realtime isn't available right now (${message}). Using Sibyl voice.` });
        return undefined;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private configure(client: OpenAIRealtimeVoiceClient, instructions: string, voice: string): void {
    const connected = this.connected!;
    const voiceChange = !connected.voiceLocked || connected.voice === voice;
    connected.instructions = instructions;
    if (voiceChange) connected.voice = voice;
    client.configure(
      {
        instructions,
        voice: connected.voice,
        tools: [HANDOFF_TOOL],
        turnDetection: this.semantic() ? { type: "semantic_vad", eagerness: EAGERNESS[this.settings.turn as "balanced" | "patient"] } : null,
        transcriptionModel: this.config.transcriptionModel
      },
      { includeVoice: voiceChange }
    );
  }

  /** Earlier conversation the Realtime session doesn't have yet (typed messages, deep-brain results, a new session). */
  private syncContext(client: OpenAIRealtimeVoiceClient, except?: LLMMessage): void {
    const entries = this.host.history().filter((entry) => entry !== except && !this.known.has(entry));
    for (const entry of entries.slice(-CONTEXT_ENTRIES)) {
      const text = typeof entry.content === "string" ? entry.content.trim() : "";
      if (text && (entry.role === "user" || entry.role === "assistant")) client.addContext({ role: entry.role, text });
    }
    for (const entry of entries) this.known.add(entry);
  }

  private async respondTo(turn: InputTurn): Promise<void> {
    if (turn.state === "committed") return;
    const requestId = turn.requestIds.at(-1)!;
    const client = await (this.connecting ?? this.ensureConnected());
    // Another path (server commit, padding timeout) may have answered it meanwhile.
    if (this.input !== turn || (turn.state as InputTurn["state"]) === "committed") return;
    turn.state = "committed";
    if (!client?.open) {
      // GPT Realtime couldn't be reached: Sibyl's own voice answers this turn.
      this.input = undefined;
      await this.host.fallback(requestId, Buffer.concat(turn.audio), turn.caption || undefined);
      return;
    }
    const prepared = await this.host.prepareTurn(requestId);
    if (!prepared) {
      client.clearInput();
      this.input = undefined;
      this.host.send({ type: WS_EVENTS.LLM_DONE, requestId, reason: "error" });
      return;
    }
    if (prepared.instructions !== this.connected?.instructions || prepared.voice !== this.connected?.voice) {
      this.configure(client, prepared.instructions, prepared.voice);
    }
    const caption = turn.caption;
    const entry: LLMMessage = { role: "user", content: caption || "(spoken message)" };
    turn.entry = entry;
    const transcriptReady = new Promise<void>((resolve) => {
      turn.resolveTranscript = resolve;
      setTimeout(resolve, TRANSCRIPT_WAIT_MS).unref?.();
    });
    this.syncContext(client, entry);
    if (client.pendingAudio) client.commit();
    this.known.add(entry);
    this.host.send({ type: WS_EVENTS.TRANSCRIPT_FINAL, requestId, text: caption });
    this.host.beginUserTurn(requestId, entry, transcriptReady);
    for (const earlier of turn.requestIds.slice(0, -1)) this.host.send({ type: WS_EVENTS.LLM_DONE, requestId: earlier, reason: "ignored" });
    this.startResponse(client, { requestId, brain: false, userEntry: entry, ...(turn.speechEndedAt !== undefined ? { speechEndedAt: turn.speechEndedAt } : {}) });
  }

  private startResponse(client: OpenAIRealtimeVoiceClient, input: { requestId: string; brain: boolean; userEntry?: LLMMessage; speechEndedAt?: number }): void {
    this.response = {
      ...input,
      pcm: [],
      bufferedBytes: 0,
      segmentIndex: 0,
      sentMs: 0,
      ttsStarted: false,
      transcript: "",
      interrupted: false
    };
    client.createResponse();
  }

  private onEvent(client: OpenAIRealtimeVoiceClient, event: RealtimeVoiceEvent): void {
    if (client !== this.client || this.disposed) return;
    const response = this.response;
    const current = (responseId: string) => response && !response.interrupted && (!response.responseId || response.responseId === responseId);
    switch (event.type) {
      case "response.created":
        if (response && !response.responseId) {
          response.responseId = event.responseId;
          this.responseRequests.set(event.responseId, response.requestId);
        }
        return;
      case "audio":
        if (!current(event.responseId)) return;
        response!.itemId ??= event.itemId;
        this.pushAudio(response!, event.audio);
        return;
      case "transcript.delta":
        if (!current(event.responseId)) return;
        response!.transcript += event.delta;
        if (!response!.brain) this.host.send({ type: WS_EVENTS.LLM_DELTA, requestId: response!.requestId, delta: event.delta });
        return;
      case "function_call":
        if (event.name === REALTIME_HANDOFF_TOOL && response && !response.interrupted) this.handOff(client, response, event.callId, event.arguments);
        else if (event.name !== REALTIME_HANDOFF_TOOL) client.functionOutput(event.callId, JSON.stringify({ error: "Unknown function" }));
        return;
      case "response.done":
        this.onResponseDone(client, event);
        return;
      case "input.committed": {
        client.markCommitted();
        const turn = this.input;
        if (!turn) return;
        turn.items.push(event.itemId);
        // Semantic turn detection decided the user finished.
        if (turn.state === "waiting" && this.semantic()) {
          this.stopPadding(turn);
          void this.respondTo(turn);
        }
        return;
      }
      case "input.transcript":
        this.onInputTranscript(event.itemId, event.transcript, event.usage);
        return;
      case "input.transcript_failed":
        this.host.log("realtime.transcript_failed", { sessionId: this.host.sessionId, message: event.message });
        return;
      case "error":
        if (event.code && BENIGN_ERRORS.has(event.code)) return;
        this.host.log("realtime.error", { sessionId: this.host.sessionId, code: event.code, message: event.message });
        if (response && !response.responseId) {
          // The response never started: end the request.
          this.response = undefined;
          this.host.send({ type: "error", requestId: response.requestId, scope: "llm", message: `GPT Realtime: ${event.message}` });
          this.host.send({ type: WS_EVENTS.LLM_DONE, requestId: response.requestId, reason: "error" });
        }
        return;
      case "closed":
        this.host.log("realtime.closed", { sessionId: this.host.sessionId, code: event.code, reason: event.reason });
        this.client = undefined;
        this.connected = undefined;
        if (response && !response.interrupted) {
          this.response = undefined;
          if (response.ttsStarted) this.host.speechEnd(response.requestId, "error");
          this.host.send({ type: "error", requestId: response.requestId, scope: "llm", message: "GPT Realtime closed the connection." });
          this.host.send({ type: WS_EVENTS.LLM_DONE, requestId: response.requestId, reason: "error" });
        }
        return;
      default:
        return;
    }
  }

  private pushAudio(response: ActiveResponse, audio: Buffer): void {
    if (!this.connected) return;
    this.connected.voiceLocked = true;
    if (!response.ttsStarted) {
      response.ttsStarted = true;
      response.firstAudioAt = this.host.now();
      this.host.send({ type: WS_EVENTS.TTS_START, requestId: response.requestId, voice: this.connected.voice, format: "wav", mimeType: "audio/wav" });
      if (response.speechEndedAt !== undefined) {
        this.host.log("latency.realtime_first_audio", {
          sessionId: this.host.sessionId,
          requestId: response.requestId,
          speechEndToFirstAudioMs: Math.round(response.firstAudioAt - response.speechEndedAt),
          model: this.settings.model
        });
      }
    }
    response.pcm.push(audio);
    response.bufferedBytes += audio.byteLength;
    if (response.bufferedBytes >= (response.segmentIndex === 0 ? FIRST_SEGMENT_BYTES : SEGMENT_BYTES)) this.flushAudio(response, false);
  }

  private flushAudio(response: ActiveResponse, isFinal: boolean): void {
    if (!response.bufferedBytes && !isFinal) return;
    const pcm = Buffer.concat(response.pcm);
    response.pcm = [];
    response.bufferedBytes = 0;
    if (!pcm.byteLength && !response.ttsStarted) return;
    response.sentMs += pcm.byteLength / BYTES_PER_MS;
    this.host.speech(response.requestId, pcm, response.segmentIndex++, isFinal);
  }

  private onResponseDone(client: OpenAIRealtimeVoiceClient, event: Extract<RealtimeVoiceEvent, { type: "response.done" }>): void {
    if (event.usage) this.recordUsage(event.responseId, event.usage);
    const response = this.response;
    if (!response || response.interrupted || (response.responseId && response.responseId !== event.responseId)) return;
    this.response = undefined;
    if (event.status === "failed") {
      if (response.ttsStarted) this.host.speechEnd(response.requestId, "error");
      this.host.send({ type: "error", requestId: response.requestId, scope: "llm", message: `GPT Realtime failed: ${event.error ?? "unknown error"}` });
      this.host.send({ type: WS_EVENTS.LLM_DONE, requestId: response.requestId, reason: "error" });
      return;
    }
    if (response.ttsStarted) {
      this.flushAudio(response, true);
      this.host.speechEnd(response.requestId, "stop");
    }
    this.host.send({ type: WS_EVENTS.LLM_DONE, requestId: response.requestId, reason: "stop" });
    this.finishReply(response, response.transcript.trim());
    // Spending capped while answering: stop cleanly after this reply.
    if (!this.host.budgetAllows(response.requestId, 0)) {
      this.closeClient("budget");
      return;
    }
    const pending = this.pendingResult;
    this.pendingResult = undefined;
    if (pending && pending.turn === this.host.turn()) this.startResponse(client, { requestId: pending.requestId, brain: true });
    else this.scheduleIdleClose(client);
  }

  private finishReply(response: ActiveResponse, spoken: string): void {
    if (response.brain) {
      // The deep brain's result is in the history already; what GPT Realtime said about it is in its own conversation.
      return;
    }
    const content = response.handoff ? `${spoken}\n(Asked the deep brain: ${response.handoff})` : spoken;
    const entry: LLMMessage | undefined = content.trim() ? { role: "assistant", content } : undefined;
    if (entry) this.known.add(entry);
    this.host.completeReply(response.requestId, entry, { content: spoken, model: `openai/${this.settings.model}` });
  }

  private handOff(client: OpenAIRealtimeVoiceClient, response: ActiveResponse, callId: string, rawArguments: string): void {
    let task = "";
    try {
      const parsed = JSON.parse(rawArguments) as { task?: unknown };
      task = typeof parsed.task === "string" ? parsed.task.trim() : "";
    } catch {
      task = "";
    }
    if (!task) task = "Handle the user's latest request in full.";
    response.handoff = task;
    const turn = this.host.turn();
    this.handoffs.set(callId, turn);
    this.host.log("realtime.handoff", { sessionId: this.host.sessionId, requestId: response.requestId });
    void this.host.deepBrain(response.requestId, task).then((result) => {
      this.handoffs.delete(callId);
      if (this.client !== client || !client.open) return;
      if ("error" in result) {
        client.functionOutput(callId, JSON.stringify({ error: result.error }));
      } else {
        this.known.add(result.entry);
        client.functionOutput(callId, JSON.stringify({ result: result.gist || "Done.", visualOnScreen: result.visual }));
      }
      // Don't interrupt the user with an old result: it stays on screen and in the conversation.
      if (this.host.turn() !== turn) return;
      const spoken = { requestId: "error" in result ? this.host.createId() : result.requestId, turn };
      // Still saying "let me pull that up": speak the result right after.
      if (this.response) this.pendingResult = spoken;
      else this.startResponse(client, { requestId: spoken.requestId, brain: true });
    });
  }

  private onInputTranscript(itemId: string, transcript: string, usage: RealtimeTranscriptionUsage | undefined): void {
    const turn = this.findTurnForItem(itemId);
    const seconds = turn ? turn.audioBytes / (REALTIME_PCM_RATE * 2) : 0;
    const requestId = turn?.requestIds.at(-1) ?? this.host.createId();
    this.host.record({
      requestId,
      model: `openai/${this.config.transcriptionModel}`,
      costUsd: transcriptionUsd(this.config.transcriptionModel, usage, seconds),
      ...(usage?.type === "tokens" ? { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens } : {}),
      ...(usage?.type === "duration" ? { units: usage.seconds } : {}),
      ownKey: this.ownKey
    });
    if (!turn) return;
    turn.transcripts.set(itemId, transcript.trim());
    if (turn.items.some((item) => !turn.transcripts.has(item))) return;
    const text = turn.items.map((item) => turn.transcripts.get(item) ?? "").filter(Boolean).join(" ").trim();
    if (text && turn.entry) {
      turn.entry.content = text;
      this.host.send({ type: WS_EVENTS.TRANSCRIPT_UPDATE, requestId, text });
    }
    turn.resolveTranscript?.();
  }

  private rememberCommitted(turn: InputTurn): void {
    turn.audio = [];
    this.committedTurns.push(turn);
    if (this.committedTurns.length > 4) this.committedTurns.shift();
  }

  private findTurnForItem(itemId: string): InputTurn | undefined {
    if (this.input?.items.includes(itemId)) return this.input;
    return this.committedTurns.find((turn) => turn.items.includes(itemId));
  }

  private recordUsage(responseId: string, usage: RealtimeResponseUsage): void {
    const requestId = this.responseRequests.get(responseId) ?? responseId;
    this.responseRequests.delete(responseId);
    this.host.record({
      requestId,
      model: `openai/${this.settings.model}`,
      costUsd: responseUsd(usage, this.prices().prices),
      promptTokens: usage.inputTextTokens + usage.inputAudioTokens,
      completionTokens: usage.outputTextTokens + usage.outputAudioTokens,
      ownKey: this.ownKey
    });
  }

  private stopPadding(turn: InputTurn): void {
    if (turn.padTimer) clearInterval(turn.padTimer);
    turn.padTimer = undefined;
  }

  private abandonInput(turn: InputTurn): void {
    this.stopPadding(turn);
    if (this.input === turn) this.input = undefined;
    if (this.client?.open && this.client.pendingAudio) this.client.clearInput();
    for (const requestId of turn.requestIds) this.host.send({ type: WS_EVENTS.LLM_DONE, requestId, reason: "ignored" });
  }

  private scheduleIdleClose(client: OpenAIRealtimeVoiceClient): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.client === client && !this.response && !this.input && !this.handoffs.size) this.closeClient("idle");
    }, this.config.idleMs);
    this.idleTimer.unref?.();
  }

  private closeClient(reason: string): void {
    clearTimeout(this.idleTimer);
    this.connectController?.abort();
    this.connectController = undefined;
    this.connecting = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const client = this.client;
    this.client = undefined;
    this.connected = undefined;
    if (client) {
      client.close(1000, reason);
      this.host.log("realtime.disconnected", { sessionId: this.host.sessionId, reason });
    }
  }
}
