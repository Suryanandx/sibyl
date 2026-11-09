import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type {
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  STTProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  TTSProvider,
  ToolChatProvider
} from "@open-gpt-live/adapters";
import {
  WS_EVENTS,
  parseClientMessage,
  type AudioChunkMessage,
  type ClientMessage,
  type LlmDoneMessage,
  type ModelCatalog,
  type ServerMessage,
  type SessionCapabilities,
  type SessionSettings
} from "@open-gpt-live/protocol";
import {
  SpeechUiSplitter,
  VoiceReplyParser,
  stripEmotionTags,
  toSpeakableText
} from "@open-gpt-live/genui";
import { WebSocket, WebSocketServer } from "ws";
import { isAuthorized } from "./auth.js";
import { ConversationRecorder, historyFromMessages } from "./conversations.js";
import { ApprovalBroker } from "./brain/approvals.js";
import { runToolLoop, toolLoopStream, toolSystemPrompt, type ToolLoopInput } from "./brain/tool-loop.js";
import { hedgedStream } from "./hedge.js";
import { createTestRuntime, type GatewayRuntime } from "./runtime.js";
import { routeSlidesRequest, takeSlidesArtifact } from "./slides/index.js";
import { buildUsageView, checkTurnBudget, meterProviders } from "./metering/index.js";

export const DEFAULT_MAX_AUDIO_TURN_BYTES = 25 * 1024 * 1024;

const defaultSystemPrompt =
  "You are Sibyl, a concise realtime AI assistant. Answer clearly and keep context from the conversation.";

export interface GatewayProviders {
  llm: LLMProvider;
  stt: STTProvider;
  streamingStt?: StreamingSTTProvider;
  tts?: TTSProvider;
  /** Tool-calling chat stream for the deep brain (enables the tool loop). */
  toolLlm?: ToolChatProvider;
}

export interface GatewayServerOptions {
  providers: GatewayProviders;
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  /** Single-owner login: WebSocket upgrades must carry `?token=<ownerToken>`. */
  ownerToken?: string;
  maxAudioTurnBytes?: number;
  livePartialInitialIntervalMs?: number;
  livePartialLongTurnIntervalMs?: number;
  livePartialLongTurnAfterMs?: number;
  streamingSttFinalTimeoutMs?: number;
  ttsSegmentMinLength?: number;
  ttsSegmentMaxLength?: number;
  ttsFormat?: string;
  ttsVoice?: string;
  systemPrompt?: string;
  /**
   * System prompt used when generative UI is on. When omitted, generative UI
   * is unavailable and replies are plain text.
   */
  genUiSystemPrompt?: string;
  /** Models the browser may pick from. When omitted, provider defaults are used. */
  modelCatalog?: ModelCatalog;
  /** Extra LLM request fields per model id (e.g. reasoning effort). */
  llmParams?: Record<string, Record<string, unknown>>;
  /** Initial per-session settings (models, voice, genUi, speak). */
  defaultSettings?: Partial<SessionSettings>;
  providerName?: string;
  realtimeSttEnabled?: boolean;
  /**
   * Live conversation mode: an audio-native voice brain hears the user and
   * talks; it can hand work to a deep brain. Active when the session has a
   * voiceModel (from modelCatalog.voice).
   */
  live?: LiveConversationConfig;
  /** Continued speech within this window (before the reply is spoken) merges turns. */
  turnMergeWindowMs?: number;
  /**
   * Hedged requests against slow providers: if the voice brain hasn't started
   * after voiceAfterMs, also ask the next-best voice model; if TTS hasn't
   * produced audio after ttsAfterMs, send a duplicate request. First wins.
   */
  hedge?: { voiceAfterMs: number; ttsAfterMs: number };
  /** Store, tool registry and usage meter (defaults to an in-memory runtime). */
  runtime?: GatewayRuntime;
  createId?: () => string;
  now?: () => number;
  logger?: GatewayLogger;
  healthDetails?: Record<string, string | number | boolean>;
}

export interface LiveConversationConfig {
  voicePrompt: string;
  brainPrompt: (genUi: boolean) => string;
  /** Send a tiny request when a session starts so the first reply isn't cold. */
  warmUp?: boolean;
}

export interface GatewayServerHandle {
  readonly webSocketServer: WebSocketServer;
  readonly httpServer: HttpServer;
  readonly port: number;
  close(): Promise<void>;
  /**
   * Swap in a new model catalog (e.g. from the background model scout).
   * Connected sessions keep choices the user made and adopt new defaults
   * for everything else.
   */
  updateModels(update: ModelUpdate): void;
}

export interface ModelUpdate {
  catalog: ModelCatalog;
  defaults: Partial<SessionSettings>;
  llmParams?: Record<string, Record<string, unknown>>;
}

export interface GatewayLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

interface GatewayConfig {
  maxAudioTurnBytes: number;
  livePartialInitialIntervalMs: number;
  livePartialLongTurnIntervalMs: number;
  livePartialLongTurnAfterMs: number;
  streamingSttFinalTimeoutMs: number;
  ttsSegmentMinLength: number;
  ttsSegmentMaxLength: number;
  ttsFormat: string;
  ttsVoice?: string;
  systemPrompt: string;
  genUiSystemPrompt?: string;
  modelCatalog?: ModelCatalog;
  llmParams: Record<string, Record<string, unknown>>;
  defaultSettings: Partial<SessionSettings>;
  providerName: string;
  realtimeSttEnabled: boolean;
  live?: LiveConversationConfig;
  turnMergeWindowMs: number;
  hedge?: { voiceAfterMs: number; ttsAfterMs: number };
  runtime: GatewayRuntime;
  /** Rolling first-token latency per voice model, learned from live turns. */
  voiceLatency: Map<string, number>;
  createId: () => string;
  now: () => number;
  logger: GatewayLogger;
}

const noopLogger: GatewayLogger = {
  info() {},
  warn() {},
  error() {}
};

interface ActiveRun {
  requestId: string;
  controller: AbortController;
  stage: "llm_streaming" | "tts_streaming" | "done" | "interrupted" | "error";
  text: string;
  interrupted: boolean;
  llmDoneSent: boolean;
  ttsStarted: boolean;
  ttsEnded: boolean;
  ttsSequence: number;
  ttsSegmentIndex: number;
  timing: RequestTiming;
  /** False for typed chat replies: text (and visuals) only, never spoken. */
  speak: boolean;
}

interface RequestTiming {
  kind: "text" | "ptt" | "live";
  sttPath?: "batch" | "realtime" | "batch_fallback";
  requestStartedAt: number;
  speechStartedAt?: number;
  speechEndedAt?: number;
  firstPartialAt?: number;
  finalTranscriptAt?: number;
  llmStartedAt?: number;
  firstLlmDeltaAt?: number;
  ttsStartedAt?: number;
  firstTtsChunkAt?: number;
}

interface SessionState {
  sessionId: string;
  history: LLMMessage[];
  settings: Partial<SessionSettings> & { genUi: boolean; speak: boolean };
  /** Background deep-brain runs, keyed by brain request id. */
  brainRuns: Map<string, AbortController>;
  /** Increments whenever the user starts a new turn. */
  turnCounter: number;
  /** Deep-brain gist waiting to be spoken once the conversation is idle. */
  pendingSpeech?: { requestId: string; text: string; turn: number };
  /** Settings the user picked explicitly (kept when the catalog changes). */
  userChosen: Set<keyof SessionSettings>;
  /** Last live utterance, kept so a quick continuation can be merged into it. */
  lastUtterance?: {
    requestId: string;
    audio: Buffer;
    mimeType: string;
    caption: string;
    userEntry: LLMMessage;
    endedAt: number;
    /** The assistant started speaking its reply (too late to merge). */
    answered: boolean;
  };
  /** Resolves when the accurate transcript of the latest turn is in. */
  transcriptReady?: Promise<void>;
  current?: ActiveRun;
  audioTurns: Map<string, ActiveAudioTurn>;
}

interface ActiveAudioTurn {
  requestId: string;
  turnMode: "ptt" | "live";
  state: "recording" | "transcribing" | "done" | "error";
  mimeType: string;
  chunks: Buffer[];
  byteLength: number;
  lastSequence: number;
  startedAt: number;
  partialSequence: number;
  lastPartialAt: number;
  partialInFlight: boolean;
  controllers: Set<AbortController>;
  streaming?: ActiveStreamingTranscription;
  timing: RequestTiming;
  latencyLogged: boolean;
  /** Instant browser caption sent with vad.speech_end (live mode). */
  caption?: string;
  /** Earlier fragment of the same thought (turn merging). */
  prefix?: { requestId: string; audio: Buffer; caption: string };
}

/** How a run gets its text and what it does with it. */
interface ResponsePlan {
  messages: LLMMessage[];
  model?: string;
  extraBody?: Record<string, unknown>;
  /** voice: speech + @brain; genui: speech + OpenUI; plain: text only. */
  parser: "voice" | "genui" | "plain";
  /** Pre-written text to speak instead of calling the LLM. */
  speakOnly?: string;
  /** Model for a hedged backup request if the primary is slow. */
  backupModel?: string;
  /** Called after the text finished streaming (before TTS completes). */
  onText?: (result: { speech: string; ui: string; brainTask?: string; silent: boolean }) => void;
}

interface ActiveStreamingTranscription {
  controller: AbortController;
  ready: Promise<void>;
  session?: StreamingSTTSession;
  pendingAudio: Buffer[];
  transcript: string;
  finalTranscript?: string;
  error?: Error;
  waiters: Array<{
    resolve: (transcript: string) => void;
    reject: (error: Error) => void;
  }>;
}

export async function createGatewayServer(
  options: GatewayServerOptions
): Promise<GatewayServerHandle> {
  const config: GatewayConfig = {
    maxAudioTurnBytes:
      options.maxAudioTurnBytes ?? DEFAULT_MAX_AUDIO_TURN_BYTES,
    livePartialInitialIntervalMs: options.livePartialInitialIntervalMs ?? 2_000,
    livePartialLongTurnIntervalMs: options.livePartialLongTurnIntervalMs ?? 5_000,
    livePartialLongTurnAfterMs: options.livePartialLongTurnAfterMs ?? 30_000,
    streamingSttFinalTimeoutMs: options.streamingSttFinalTimeoutMs ?? 15_000,
    ttsSegmentMinLength: options.ttsSegmentMinLength ?? 24,
    ttsSegmentMaxLength: options.ttsSegmentMaxLength ?? 240,
    ttsFormat: options.ttsFormat ?? "mp3",
    ttsVoice: options.ttsVoice,
    systemPrompt: options.systemPrompt ?? defaultSystemPrompt,
    genUiSystemPrompt: options.genUiSystemPrompt,
    modelCatalog: options.modelCatalog,
    llmParams: options.llmParams ?? {},
    defaultSettings: options.defaultSettings ?? {},
    providerName: options.providerName ?? "openai-compatible",
    realtimeSttEnabled: options.realtimeSttEnabled ?? Boolean(options.providers.streamingStt),
    live: options.live,
    turnMergeWindowMs: options.turnMergeWindowMs ?? 3_000,
    hedge: options.hedge,
    runtime: options.runtime ?? createTestRuntime(),
    voiceLatency: new Map(),
    createId: options.createId ?? randomUUID,
    now: options.now ?? (() => performance.now()),
    logger: options.logger ?? noopLogger
  };

  validateConfig(config);

  const startedAt = Date.now();
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      const body = JSON.stringify({
        status: "ok",
        service: "sibyl-gateway",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        connections: webSocketServer.clients.size,
        ...options.healthDetails,
        // Lets the web app tell "sign in" apart from "gateway down".
        ownerLogin: Boolean(options.ownerToken)
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
      });
      response.end(body);
      return;
    }
    if (
      routeSlidesRequest(request, response, {
        runtime: config.runtime,
        ...(options.ownerToken ? { ownerToken: options.ownerToken } : {}),
        allowedOrigins: options.allowedOrigins ?? [],
        ...(options.providers.toolLlm ? { toolLlm: options.providers.toolLlm } : {}),
        model: () => config.defaultSettings.llmModel,
        llmParams: (model) => config.llmParams[model],
        log: (event, fields) => config.logger.info(event, fields)
      })
    ) {
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ origin, req }, done) => {
      if (!isAuthorized(options.ownerToken, req.url)) {
        done(false, 401, "Unauthorized");
        return;
      }
      if (allowedOrigins.size === 0 || !origin || allowedOrigins.has(origin)) {
        done(true);
        return;
      }
      done(false, 403, "Origin is not allowed");
    }
  });

  // Every model call through these providers is recorded on the usage meter.
  const providers = meterProviders(options.providers, {
    meter: config.runtime.meter,
    ownerId: config.runtime.ownerId,
    catalog: () => config.modelCatalog
  });
  const connections = new Set<GatewayConnection>();
  webSocketServer.on("connection", (socket) => {
    const connection = new GatewayConnection(
      socket,
      providers,
      config
    );
    connections.add(connection);
    socket.once("close", () => connections.delete(connection));
    connection.start();
  });

  await listenHttpServer(httpServer, options.port ?? 0, options.host);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeWebSocketServer(webSocketServer);
    await closeHttpServer(httpServer);
    throw new Error("Gateway did not bind to a TCP port");
  }

  return {
    webSocketServer,
    httpServer,
    port: address.port,
    updateModels: (update) => {
      config.modelCatalog = update.catalog;
      config.defaultSettings = { ...config.defaultSettings, ...update.defaults };
      if (update.llmParams) {
        config.llmParams = { ...config.llmParams, ...update.llmParams };
      }
      for (const connection of connections) {
        connection.applyCatalogUpdate();
      }
    },
    close: async () => {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await closeWebSocketServer(webSocketServer);
      await closeHttpServer(httpServer);
    }
  };
}

class GatewayConnection {
  private readonly session: SessionState;
  private disposed = false;
  /** Last budget check was close to a cap (cheaper models in use). */
  private economyMode = false;
  private messageQueue = Promise.resolve();
  private readonly conversations: ConversationRecorder;
  private readonly approvals: ApprovalBroker;

  constructor(
    private readonly socket: WebSocket,
    private readonly providers: GatewayProviders,
    private readonly config: GatewayConfig
  ) {
    this.session = {
      sessionId: config.createId(),
      audioTurns: new Map(),
      history: [{ role: "system", content: config.systemPrompt }],
      settings: initialSettings(config, Boolean(providers.tts)),
      brainRuns: new Map(),
      turnCounter: 0,
      userChosen: new Set()
    };
    this.conversations = new ConversationRecorder({
      store: config.runtime.store,
      ownerId: config.runtime.ownerId,
      createId: config.createId,
      log: (event, fields) => config.logger.warn(event, { sessionId: this.session.sessionId, ...fields }),
      onListChanged: (items) => this.send({ type: WS_EVENTS.CONVERSATIONS_LIST, items })
    });
    this.approvals = new ApprovalBroker({
      store: config.runtime.store,
      ownerId: config.runtime.ownerId,
      send: (message) => this.send(message),
      createId: config.createId,
      now: config.now,
      log: (event, fields) => config.logger.info(event, { sessionId: this.session.sessionId, ...fields })
    });
  }

  start(): void {
    this.config.logger.info("session.connected", {
      sessionId: this.session.sessionId
    });
    this.send({
      type: WS_EVENTS.SESSION_START,
      sessionId: this.session.sessionId,
      status: "ready"
    });
    this.sendSessionConfig();
    this.warmUpVoice();

    this.socket.on("message", (raw) => {
      const message = raw.toString();
      this.messageQueue = this.messageQueue
        .then(() => this.handleRawMessage(message))
        .catch((error: unknown) => {
          this.send({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unknown gateway message error"
          });
        });
    });
    this.socket.on("error", (error) => {
      this.config.logger.warn("session.socket_error", {
        sessionId: this.session.sessionId,
        error: error.message
      });
      this.dispose("websocket error");
      if (this.socket.readyState !== WebSocket.CLOSED) {
        this.socket.terminate();
      }
    });
    this.socket.once("close", () => {
      this.dispose("socket closed");
    });
  }

  private handleRawMessage(raw: string): void | Promise<void> {
    if (this.disposed) {
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      this.send({ type: "error", message: "Invalid JSON message" });
      return;
    }

    const result = parseClientMessage(input);
    if (!result.success) {
      this.send({
        type: "error",
        message: `Invalid client message: ${result.error}`
      });
      return;
    }

    return this.handleMessage(result.data);
  }

  private handleMessage(message: ClientMessage): void | Promise<void> {
    if (message.type === WS_EVENTS.SESSION_START) {
      if (message.sessionId) {
        this.session.sessionId = message.sessionId;
      }
      this.send({
        type: WS_EVENTS.SESSION_START,
        sessionId: this.session.sessionId,
        status: "ready"
      });
      this.sendSessionConfig();
      return;
    }

    if (message.type === WS_EVENTS.SESSION_UPDATE) {
      this.updateSettings(message.settings);
      return;
    }

    if (message.type === WS_EVENTS.INTERRUPT) {
      if (message.requestId) {
        this.cancelAudioTurn(
          message.requestId,
          message.reason ?? "user interrupt"
        );
      }
      this.interruptCurrentRun(
        message.reason ?? "user interrupt",
        message.requestId
      );
      return;
    }

    if (message.type === WS_EVENTS.PLAYBACK_ACK) {
      return;
    }

    if (message.type === WS_EVENTS.VAD_SPEECH_START) {
      this.startLiveAudioTurn(message.requestId);
      return;
    }

    if (message.type === WS_EVENTS.VAD_SPEECH_END) {
      if (message.reason === "cancelled") {
        this.cancelAudioTurn(message.requestId, "client cancelled live turn");
        return;
      }
      void this.finishLiveAudioTurn(message.requestId, message.caption);
      return;
    }

    if (message.type === WS_EVENTS.USER_TEXT) {
      const text = message.text.trim();
      if (!text) {
        this.send({
          type: "error",
          message: "user.text requires non-empty text"
        });
        return;
      }
      void this.handleUserText(
        message.requestId ?? this.config.createId(),
        text
      );
      return;
    }

    if (message.type !== WS_EVENTS.AUDIO_CHUNK) {
      // Awaited by the message queue: a conversation.open must restore the
      // history before the next user message is handled.
      return this.handleV03Message(message);
    }

    void this.handleAudioChunk(message);
  }

  /**
   * Extension point for v0.3 messages (approvals, usage, server-side
   * conversations). Each capability owns its own case; unhandled ones are
   * acknowledged with an error so the browser never waits silently.
   */
  private async handleV03Message(
    message: Exclude<ClientMessage, AudioChunkMessage | { type: "session.start" | "session.update" | "interrupt" | "playback.ack" | "vad.speech_start" | "vad.speech_end" | "user.text" }>
  ): Promise<void> {
    switch (message.type) {
      // ── approvals (brain tool loop) ──
      case WS_EVENTS.APPROVAL_DECISION:
        void this.approvals.decide(message.id, message.decision, message.remember).catch((error: unknown) => {
          this.send({ type: "error", message: `Approval failed: ${toError(error).message}` });
        });
        return;

      // ── metering ──
      case WS_EVENTS.USAGE_REQUEST:
        this.pushUsage();
        return;

      // ── server-side conversations ──
      case WS_EVENTS.CONVERSATIONS_REQUEST:
        this.send({ type: WS_EVENTS.CONVERSATIONS_LIST, items: await this.conversations.list() });
        return;
      case WS_EVENTS.CONVERSATION_OPEN:
        await this.openConversation(message.conversationId);
        return;
      case WS_EVENTS.CONVERSATION_DELETE:
        if (await this.conversations.remove(message.conversationId)) {
          // The live conversation is gone: continue in a fresh one.
          await this.openConversation();
        }
        this.send({ type: WS_EVENTS.CONVERSATIONS_LIST, items: await this.conversations.list() });
        return;
    }
  }

  /** Start a new conversation (no id) or resume a stored one with its context. */
  private async openConversation(conversationId?: string): Promise<void> {
    const record = conversationId ? await this.conversations.open(conversationId) : undefined;
    if (conversationId && !record) {
      this.send({ type: "error", message: "Conversation not found" });
      return;
    }
    if (!record) this.conversations.startNew();
    this.interruptCurrentRun("conversation switched");
    for (const controller of this.session.brainRuns.values()) controller.abort("conversation switched");
    this.session.brainRuns.clear();
    this.session.pendingSpeech = undefined;
    this.session.lastUtterance = undefined;
    this.session.history.splice(1, Infinity, ...historyFromMessages(record?.messages ?? []));
    this.send({
      type: WS_EVENTS.CONVERSATION_STATE,
      conversationId: this.conversations.conversationId,
      title: record?.title ?? "New conversation",
      messages: record?.messages ?? []
    });
  }

  /** Remember a user turn so it is saved with its reply. */
  private beginStoredTurn(requestId: string, entry: LLMMessage, timing: RequestTiming): void {
    this.conversations.beginTurn(requestId, entry, timing.kind === "text" ? "text" : "audio", (item) =>
      this.session.history.includes(item)
    );
  }

  private notAvailable(type: string): void {
    this.send({ type: "error", message: `${type} is not available on this gateway yet` });
  }

  private pushUsage(): void {
    this.send({
      type: WS_EVENTS.USAGE_UPDATE,
      usage: buildUsageView({
        meter: this.config.runtime.meter,
        ownerId: this.config.runtime.ownerId,
        sessionId: this.session.sessionId,
        economyMode: this.economyMode
      })
    });
  }

  /** Labels for metered provider calls. */
  private usageMeta(feature: string, requestId?: string): Record<string, string | undefined> {
    return { feature, requestId, sessionId: this.session.sessionId };
  }

  /**
   * Budget check before a voice turn or deep-brain run. Returns the model to
   * use (the Cheapest preset's when close to a cap), or undefined when blocked
   * (BUDGET_BLOCKED has been sent).
   */
  private budgetFor(
    feature: "voice" | "brain",
    model: string | undefined,
    requestId: string
  ): { model: string | undefined } | undefined {
    const budget = checkTurnBudget({
      meter: this.config.runtime.meter,
      ownerId: this.config.runtime.ownerId,
      feature,
      model,
      catalog: this.config.modelCatalog,
      sessionId: this.session.sessionId,
      requestId
    });
    if (!budget.allowed) {
      this.config.logger.warn("budget.blocked", {
        sessionId: this.session.sessionId,
        requestId,
        feature,
        scope: budget.scope
      });
      this.send({ type: WS_EVENTS.BUDGET_BLOCKED, requestId, scope: budget.scope, message: budget.message });
      return undefined;
    }
    if (budget.economy !== this.economyMode) {
      this.economyMode = budget.economy;
      this.pushUsage();
    }
    return { model: budget.model ?? model };
  }

  /** Re-resolve settings against a new catalog and tell the browser. */
  applyCatalogUpdate(): void {
    if (this.disposed) return;
    const fresh = initialSettings(this.config, Boolean(this.providers.tts));
    const catalog = this.config.modelCatalog;
    const allowed = (key: keyof SessionSettings, value: unknown): boolean => {
      if (!catalog || typeof value !== "string") return true;
      const list =
        key === "voiceModel" ? catalog.voice :
        key === "llmModel" ? catalog.llm :
        key === "sttModel" ? catalog.stt :
        key === "ttsModel" ? catalog.tts : undefined;
      return !list || list.some((model) => model.id === value);
    };
    const next = { ...this.session.settings };
    for (const key of ["voiceModel", "llmModel", "sttModel", "ttsModel", "ttsVoice"] as const) {
      const keep = this.session.userChosen.has(key) && allowed(key, next[key]);
      if (!keep) {
        if (fresh[key] === undefined) delete next[key];
        else next[key] = fresh[key];
      }
    }
    this.session.settings = next;
    this.sendSessionConfig();
    this.warmUpVoice();
  }

  private sendSessionConfig(): void {
    const catalog = this.config.modelCatalog;
    const settings = this.session.settings;
    if (!catalog || !settings.llmModel || !settings.sttModel) {
      return;
    }
    this.send({
      type: WS_EVENTS.SESSION_CONFIG,
      catalog,
      settings: settings as SessionSettings,
      capabilities: this.capabilities()
    });
  }

  private capabilities(): SessionCapabilities {
    return {
      provider: this.config.providerName,
      genUi: Boolean(this.config.genUiSystemPrompt),
      tts: Boolean(this.providers.tts),
      realtimeStt: this.config.realtimeSttEnabled
    };
  }

  private updateSettings(patch: Partial<SessionSettings>): void {
    const catalog = this.config.modelCatalog;
    const next = { ...this.session.settings };
    const reject = (message: string): void => {
      this.send({ type: "error", message });
    };

    if (patch.voiceModel !== undefined) {
      if (!catalog?.voice?.some((model) => model.id === patch.voiceModel)) {
        return reject(`Voice model is not allowed: ${patch.voiceModel}`);
      }
      next.voiceModel = patch.voiceModel;
      queueMicrotask(() => this.warmUpVoice());
    }
    if (patch.llmModel !== undefined) {
      if (catalog && !catalog.llm.some((model) => model.id === patch.llmModel)) {
        return reject(`LLM model is not allowed: ${patch.llmModel}`);
      }
      next.llmModel = patch.llmModel;
    }
    if (patch.sttModel !== undefined) {
      if (catalog && !catalog.stt.some((model) => model.id === patch.sttModel)) {
        return reject(`Speech-to-text model is not allowed: ${patch.sttModel}`);
      }
      next.sttModel = patch.sttModel;
    }
    if (patch.ttsModel !== undefined) {
      const ttsModel = catalog?.tts.find((model) => model.id === patch.ttsModel);
      if (catalog && !ttsModel) {
        return reject(`Text-to-speech model is not allowed: ${patch.ttsModel}`);
      }
      next.ttsModel = patch.ttsModel;
      // Keep the voice only when the new model supports it.
      if (ttsModel?.voices?.length && (!next.ttsVoice || !ttsModel.voices.includes(next.ttsVoice))) {
        next.ttsVoice = ttsModel.defaultVoice ?? ttsModel.voices[0];
      }
    }
    if (patch.ttsVoice !== undefined) {
      const ttsModel = catalog?.tts.find((model) => model.id === next.ttsModel);
      if (ttsModel?.voices?.length && !ttsModel.voices.includes(patch.ttsVoice)) {
        return reject(`Voice ${patch.ttsVoice} is not available for ${ttsModel.id}`);
      }
      next.ttsVoice = patch.ttsVoice;
    }
    if (patch.genUi !== undefined) {
      next.genUi = patch.genUi && Boolean(this.config.genUiSystemPrompt);
    }
    if (patch.speak !== undefined) {
      next.speak = patch.speak && Boolean(this.providers.tts);
    }

    this.session.settings = next;
    for (const key of Object.keys(patch) as Array<keyof SessionSettings>) {
      this.session.userChosen.add(key);
    }
    this.config.logger.info("session.settings_updated", {
      sessionId: this.session.sessionId,
      ...next
    });
    this.sendSessionConfig();
  }

  private async handleUserText(
    requestId: string,
    text: string,
    timing: RequestTiming = {
      kind: "text",
      requestStartedAt: this.config.now()
    }
  ): Promise<void> {
    if (this.session.current) {
      this.interruptCurrentRun("new user message");
    }

    if (this.isLive() && timing.kind !== "text") {
      this.session.turnCounter += 1;
      await this.runVoiceTurn(requestId, timing, { role: "user", content: text });
      return;
    }

    // Typed chat (or a gateway without live voice): one normal reply from the
    // llm model, with tools when enabled. In live mode it is never spoken.
    const typed = this.isLive() && timing.kind === "text";
    if (typed) this.session.turnCounter += 1;
    const entry: LLMMessage = { role: "user", content: text };
    this.session.history.push(entry);
    this.beginStoredTurn(requestId, entry, timing);
    await this.streamAssistantResponse(requestId, timing, undefined, { typed });
  }

  private async handleAudioChunk(message: AudioChunkMessage): Promise<void> {
    const turn = this.getOrCreateAudioTurn(message);

    if (message.chunk) {
      const chunk = Buffer.from(message.chunk, "base64");
      if (
        turn.byteLength + chunk.byteLength >
        this.config.maxAudioTurnBytes
      ) {
        this.config.logger.warn("audio.rejected", {
          sessionId: this.session.sessionId,
          requestId: message.requestId,
          reason: "size_limit"
        });
        turn.state = "error";
        this.deleteAudioTurn(turn, "audio limit exceeded");
        this.send({
          type: "error",
          requestId: message.requestId,
          message: "Audio turn is too large to transcribe"
        });
        this.send({
          type: WS_EVENTS.LLM_DONE,
          requestId: message.requestId,
          reason: "error"
        });
        return;
      }

      turn.chunks.push(chunk);
      turn.byteLength += chunk.byteLength;
      turn.lastSequence = Math.max(turn.lastSequence, message.sequence);
      this.appendStreamingAudio(turn, chunk);
    }

    if (!message.isFinal) {
      this.maybeSchedulePartialTranscription(turn);
      return;
    }

    turn.timing.speechEndedAt ??= this.config.now();

    if (turn.turnMode === "live") {
      return;
    }

    await this.finishAudioTurn(turn);
  }

  private startLiveAudioTurn(requestId: string): void {
    if (this.session.audioTurns.has(requestId)) {
      return;
    }

    const startedAt = this.config.now();
    const turn: ActiveAudioTurn = {
      requestId,
      turnMode: "live",
      state: "recording",
      mimeType: "audio/pcm;rate=24000",
      chunks: [],
      byteLength: 0,
      lastSequence: -1,
      startedAt,
      partialSequence: 0,
      lastPartialAt: startedAt,
      partialInFlight: false,
      controllers: new Set(),
      timing: {
        kind: "live",
        sttPath: this.providers.streamingStt ? "realtime" : "batch",
        requestStartedAt: startedAt,
        speechStartedAt: startedAt
      },
      latencyLogged: false
    };
    this.session.audioTurns.set(requestId, turn);
    this.session.turnCounter += 1;
    this.maybeMergeWithPreviousUtterance(turn);
    this.beginStreamingTranscription(turn);
  }

  /**
   * People pause mid-thought. If the user speaks again shortly after a pause
   * and the assistant hasn't started answering out loud yet, treat it as one
   * utterance: drop the pending reply and answer the whole thing together.
   */
  private maybeMergeWithPreviousUtterance(turn: ActiveAudioTurn): void {
    const last = this.session.lastUtterance;
    if (
      !this.isLive() ||
      !last ||
      last.answered ||
      this.config.now() - last.endedAt > this.config.turnMergeWindowMs ||
      !/pcm/i.test(last.mimeType)
    ) {
      return;
    }
    this.session.lastUtterance = undefined;
    if (this.session.current?.requestId === last.requestId) {
      this.interruptCurrentRun("merged into continued speech");
    }
    const index = this.session.history.lastIndexOf(last.userEntry);
    if (index >= 0) this.session.history.splice(index, index === this.session.history.length - 1 ? 1 : 2);
    this.conversations.retract(last.requestId);
    // ~250 ms of silence between the fragments keeps the pause audible.
    const rate = sampleRateFromMime(last.mimeType);
    const gap = Buffer.alloc(Math.round(rate * 0.25) * 2);
    turn.prefix = {
      requestId: last.requestId,
      audio: Buffer.concat([last.audio, gap]),
      caption: last.caption
    };
    this.send({
      type: WS_EVENTS.TURN_MERGED,
      requestId: turn.requestId,
      mergedRequestId: last.requestId
    });
    this.config.logger.info("turn.merged", {
      sessionId: this.session.sessionId,
      requestId: turn.requestId,
      mergedRequestId: last.requestId
    });
  }

  private async finishLiveAudioTurn(
    requestId: string,
    caption?: string
  ): Promise<void> {
    const turn = this.session.audioTurns.get(requestId);
    if (!turn || turn.turnMode !== "live" || turn.state !== "recording") {
      return;
    }
    turn.timing.speechEndedAt ??= this.config.now();
    turn.caption = caption;
    if (this.isLive()) {
      await this.finishLiveTurnWithVoiceBrain(turn);
      return;
    }
    if (turn.streaming) {
      try {
        const transcript = await this.finishStreamingTranscription(turn);
        if (
          transcript &&
          !this.disposed &&
          this.session.audioTurns.get(turn.requestId) === turn
        ) {
          turn.state = "done";
          turn.timing.finalTranscriptAt = this.config.now();
          this.deleteAudioTurn(turn, "streaming transcription completed");
          this.send({
            type: WS_EVENTS.TRANSCRIPT_FINAL,
            requestId: turn.requestId,
            text: transcript
          });
          await this.handleUserText(turn.requestId, transcript, turn.timing);
          return;
        }
        if (
          !transcript &&
          !this.disposed &&
          this.session.audioTurns.get(turn.requestId) === turn
        ) {
          turn.streaming.session?.close(1000, "empty realtime transcript");
          turn.streaming = undefined;
          turn.timing.sttPath = "batch_fallback";
          turn.state = "recording";
        }
      } catch (error) {
        if (
          this.disposed ||
          this.session.audioTurns.get(turn.requestId) !== turn
        ) {
          return;
        }
        // Realtime transcription is optional. Fall back to the batch STT
        // adapter with the PCM audio already accumulated for this turn.
        this.config.logger.warn("stt.realtime_fallback", {
          sessionId: this.session.sessionId,
          requestId: turn.requestId,
          error: toError(error).message
        });
        turn.streaming?.session?.close(1011, "using batch STT fallback");
        turn.streaming = undefined;
        turn.timing.sttPath = "batch_fallback";
        turn.state = "recording";
      }
    }
    await this.finishAudioTurn(turn);
  }

  private beginStreamingTranscription(turn: ActiveAudioTurn): void {
    const provider = this.providers.streamingStt;
    // In live conversation mode the voice brain hears the audio itself.
    if (!provider || turn.turnMode !== "live" || this.isLive()) {
      return;
    }

    const controller = new AbortController();
    turn.controllers.add(controller);
    const streaming: ActiveStreamingTranscription = {
      controller,
      ready: Promise.resolve(),
      pendingAudio: [],
      transcript: "",
      waiters: []
    };
    turn.streaming = streaming;
    streaming.ready = provider
      .createSession({ signal: controller.signal })
      .then((session) => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          this.session.audioTurns.get(turn.requestId) !== turn
        ) {
          session.close(1000, "turn no longer active");
          return;
        }
        streaming.session = session;
        for (const audio of streaming.pendingAudio.splice(0)) {
          session.appendAudio(audio);
        }
        void this.consumeStreamingTranscription(turn, streaming, session);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.failStreamingTranscription(streaming, toError(error));
        }
        throw error;
      });

    // Creation may fail before the turn ends. The failure is retained on the
    // turn and handled by the batch fallback instead of becoming unhandled.
    void streaming.ready.catch(() => undefined);
  }

  private appendStreamingAudio(turn: ActiveAudioTurn, audio: Buffer): void {
    const streaming = turn.streaming;
    if (!streaming || streaming.error || streaming.controller.signal.aborted) {
      return;
    }
    try {
      if (streaming.session) {
        streaming.session.appendAudio(audio);
      } else {
        streaming.pendingAudio.push(audio);
      }
    } catch (error) {
      this.failStreamingTranscription(streaming, toError(error));
    }
  }

  private async consumeStreamingTranscription(
    turn: ActiveAudioTurn,
    streaming: ActiveStreamingTranscription,
    session: StreamingSTTSession
  ): Promise<void> {
    try {
      for await (const event of session) {
        if (
          streaming.controller.signal.aborted ||
          this.disposed ||
          this.session.audioTurns.get(turn.requestId) !== turn
        ) {
          return;
        }
        if (event.type === "delta") {
          streaming.transcript += event.delta;
          turn.timing.firstPartialAt ??= this.config.now();
          this.send({
            type: WS_EVENTS.TRANSCRIPT_PARTIAL,
            requestId: turn.requestId,
            text: streaming.transcript,
            sequence: turn.partialSequence++,
            isStable: false
          });
          continue;
        }
        if (event.type === "completed") {
          streaming.finalTranscript = event.transcript.trim();
          this.resolveStreamingWaiters(streaming);
          continue;
        }
        this.failStreamingTranscription(
          streaming,
          new Error(event.code ? `${event.code}: ${event.message}` : event.message)
        );
      }
    } catch (error) {
      if (!streaming.controller.signal.aborted) {
        this.failStreamingTranscription(streaming, toError(error));
      }
    }
  }

  private async finishStreamingTranscription(
    turn: ActiveAudioTurn
  ): Promise<string> {
    const streaming = turn.streaming;
    if (!streaming) {
      return "";
    }

    turn.state = "transcribing";
    await streaming.ready;
    if (streaming.error) {
      throw streaming.error;
    }
    const session = streaming.session;
    if (!session) {
      throw new Error("Realtime STT session did not become ready");
    }
    session.commit();

    try {
      return await this.waitForStreamingTranscript(streaming);
    } finally {
      session.close(1000, "turn transcription completed");
    }
  }

  private waitForStreamingTranscript(
    streaming: ActiveStreamingTranscription
  ): Promise<string> {
    if (streaming.controller.signal.aborted) {
      return Promise.reject(new Error("Realtime STT turn was cancelled"));
    }
    if (streaming.finalTranscript !== undefined) {
      return Promise.resolve(streaming.finalTranscript);
    }
    if (streaming.error) {
      return Promise.reject(streaming.error);
    }

    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        streaming.controller.signal.removeEventListener("abort", onAbort);
        const index = streaming.waiters.findIndex(
          (waiter) => waiter.resolve === wrappedResolve
        );
        if (index >= 0) {
          streaming.waiters.splice(index, 1);
        }
      };
      const wrappedResolve = (transcript: string): void => {
        cleanup();
        resolve(transcript);
      };
      const wrappedReject = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        wrappedReject(new Error("Realtime STT turn was cancelled"));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Realtime STT final transcript timed out"));
      }, this.config.streamingSttFinalTimeoutMs);
      streaming.controller.signal.addEventListener("abort", onAbort, {
        once: true
      });
      streaming.waiters.push({
        resolve: wrappedResolve,
        reject: wrappedReject
      });
    });
  }

  private resolveStreamingWaiters(streaming: ActiveStreamingTranscription): void {
    const transcript = streaming.finalTranscript ?? "";
    for (const waiter of streaming.waiters.splice(0)) {
      waiter.resolve(transcript);
    }
  }

  private failStreamingTranscription(
    streaming: ActiveStreamingTranscription,
    error: Error
  ): void {
    if (streaming.error) {
      return;
    }
    streaming.error = error;
    for (const waiter of streaming.waiters.splice(0)) {
      waiter.reject(error);
    }
    streaming.session?.close(1011, "realtime transcription failed");
  }

  private async finishAudioTurn(turn: ActiveAudioTurn): Promise<void> {
    if (turn.state !== "recording") {
      return;
    }
    // Push-to-talk recorded as WAV: let the voice brain hear it directly too.
    if (this.isLive() && turn.turnMode === "ptt" && /wav/i.test(turn.mimeType)) {
      await this.finishLiveTurnWithVoiceBrain(turn);
      return;
    }

    turn.state = "transcribing";
    this.abortTurnControllers(turn, "final transcription started");
    const controller = new AbortController();
    turn.controllers.add(controller);

    try {
      const transcript = await this.transcribeAudio(
        turn,
        Buffer.concat(turn.chunks),
        controller.signal
      );
      if (
        controller.signal.aborted ||
        this.disposed ||
        this.session.audioTurns.get(turn.requestId) !== turn
      ) {
        return;
      }

      if (!transcript) {
        turn.state = "error";
        this.deleteAudioTurn(turn, "empty transcription");
        this.send({
          type: "error",
          requestId: turn.requestId,
          message: "Transcription returned empty text"
        });
        this.send({
          type: WS_EVENTS.LLM_DONE,
          requestId: turn.requestId,
          reason: "error"
        });
        return;
      }

      turn.state = "done";
      turn.timing.finalTranscriptAt = this.config.now();
      this.session.audioTurns.delete(turn.requestId);
      this.logAudioLatency(turn, "completed");
      this.send({
        type: WS_EVENTS.TRANSCRIPT_FINAL,
        requestId: turn.requestId,
        text: transcript
      });
      await this.handleUserText(turn.requestId, transcript, turn.timing);
    } catch (error) {
      if (controller.signal.aborted || this.disposed) {
        return;
      }
      this.config.logger.error("stt.failed", {
        sessionId: this.session.sessionId,
        requestId: turn.requestId,
        error: toError(error).message
      });
      turn.state = "error";
      this.deleteAudioTurn(turn, "transcription error");
      this.send({
        type: "error",
        requestId: turn.requestId,
        message:
          error instanceof Error ? error.message : "Unknown transcription error"
      });
      this.send({
        type: WS_EVENTS.LLM_DONE,
        requestId: turn.requestId,
        reason: "error"
      });
    } finally {
      turn.controllers.delete(controller);
    }
  }

  private getOrCreateAudioTurn(message: AudioChunkMessage): ActiveAudioTurn {
    const existing = this.session.audioTurns.get(message.requestId);
    if (existing) {
      if (existing.byteLength === 0 || !existing.mimeType) {
        existing.mimeType = message.mimeType;
      }
      return existing;
    }

    const now = this.config.now();
    const turn: ActiveAudioTurn = {
      requestId: message.requestId,
      turnMode: message.turnMode ?? "ptt",
      state: "recording",
      mimeType: message.mimeType,
      chunks: [],
      byteLength: 0,
      lastSequence: -1,
      startedAt: now,
      partialSequence: 0,
      lastPartialAt: now,
      partialInFlight: false,
      controllers: new Set(),
      timing: {
        kind: message.turnMode ?? "ptt",
        sttPath:
          message.turnMode === "live" && this.providers.streamingStt
            ? "realtime"
            : "batch",
        requestStartedAt: now,
        speechStartedAt: now
      },
      latencyLogged: false
    };
    this.session.audioTurns.set(message.requestId, turn);
    return turn;
  }

  private maybeSchedulePartialTranscription(turn: ActiveAudioTurn): void {
    if (
      turn.turnMode !== "live" ||
      this.isLive() ||
      turn.state !== "recording" ||
      turn.partialInFlight ||
      (turn.streaming !== undefined && turn.streaming.error === undefined) ||
      turn.chunks.length === 0
    ) {
      return;
    }

    const now = this.config.now();
    const elapsed = now - turn.startedAt;
    const interval =
      elapsed > this.config.livePartialLongTurnAfterMs
        ? this.config.livePartialLongTurnIntervalMs
        : this.config.livePartialInitialIntervalMs;
    if (now - turn.lastPartialAt < interval) {
      return;
    }

    turn.lastPartialAt = now;
    turn.partialInFlight = true;
    const audio = Buffer.concat(turn.chunks);
    const partialSequence = turn.partialSequence++;
    const controller = new AbortController();
    turn.controllers.add(controller);

    void this.transcribeAudio(turn, audio, controller.signal)
      .then((text) => {
        if (
          text &&
          !controller.signal.aborted &&
          !this.disposed &&
          this.session.audioTurns.get(turn.requestId) === turn &&
          turn.state === "recording"
        ) {
          turn.timing.firstPartialAt ??= this.config.now();
          this.send({
            type: WS_EVENTS.TRANSCRIPT_PARTIAL,
            requestId: turn.requestId,
            text,
            sequence: partialSequence,
            isStable: false
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        turn.controllers.delete(controller);
        turn.partialInFlight = false;
      });
  }

  private async transcribeAudio(
    turn: ActiveAudioTurn,
    audio: Buffer,
    signal: AbortSignal
  ): Promise<string> {
    if (audio.byteLength === 0) {
      return "";
    }
    const normalized = normalizeAudioForBatchStt(turn.mimeType, audio);
    const result = await this.providers.stt.transcribe(
      {
        data: normalized.data,
        mimeType: normalized.mimeType,
        filename: filenameForMimeType(normalized.mimeType)
      },
      { signal, model: this.session.settings.sttModel, meta: this.usageMeta("stt", turn.requestId) }
    );
    return result.text.trim();
  }

  /**
   * The first request to a model pays for connection setup and provider
   * routing. A tiny request at session start makes the first real reply fast.
   */
  private warmUpVoice(): void {
    const live = this.config.live;
    const model = this.session.settings.voiceModel;
    if (!live?.warmUp || !model || this.disposed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("warm-up timeout"), 15_000);
    void (async () => {
      const startedAt = this.config.now();
      try {
        for await (const _chunk of this.providers.llm.streamText(
          [
            { role: "system", content: live.voicePrompt },
            { role: "user", content: "(connection check, reply with just: ok)" }
          ],
          {
            signal: controller.signal,
            model,
            extraBody: { ...this.llmParamsFor(model), max_tokens: 4 },
            meta: this.usageMeta("warmup")
          }
        )) {
          break;
        }
        this.config.logger.info("voice.warmed_up", {
          sessionId: this.session.sessionId,
          model,
          ms: Math.round(this.config.now() - startedAt)
        });
      } catch {
        // Warm-up is best effort.
      } finally {
        clearTimeout(timer);
      }
    })();
  }

  /** Expected first-token latency: learned from live turns, else the scout's probe. */
  private expectedVoiceLatency(id: string): number {
    return (
      this.config.voiceLatency.get(id) ??
      this.config.modelCatalog?.voice?.find((model) => model.id === id)?.latencyMs ??
      Number.POSITIVE_INFINITY
    );
  }

  /**
   * The user's explicit choice always wins. Otherwise use whichever of the
   * scout's top voice models has actually been fastest in recent turns.
   */
  private pickVoiceModel(): string | undefined {
    const chosen = this.session.settings.voiceModel;
    if (this.session.userChosen.has("voiceModel") || !this.config.hedge) return chosen;
    const top = (this.config.modelCatalog?.voice ?? []).slice(0, 3).map((model) => model.id);
    if (!top.length) return chosen;
    return [...top].sort((a, b) => this.expectedVoiceLatency(a) - this.expectedVoiceLatency(b))[0];
  }

  /** Backup for hedging: the fastest voice model from a different vendor. */
  private backupVoiceModel(current: string | undefined): string | undefined {
    const vendor = (id: string | undefined) => id?.split("/")[0];
    const voices = (this.config.modelCatalog?.voice ?? []).map((model) => model.id).filter((id) => id !== current);
    const ranked = voices.slice(0, 6).sort((a, b) => this.expectedVoiceLatency(a) - this.expectedVoiceLatency(b));
    return ranked.find((id) => vendor(id) !== vendor(current)) ?? ranked[0] ?? current;
  }

  private recordVoiceLatency(model: string | undefined, ms: number): void {
    if (!model) return;
    const previous = this.config.voiceLatency.get(model);
    this.config.voiceLatency.set(model, previous === undefined ? ms : previous * 0.6 + ms * 0.4);
  }

  private isLive(): boolean {
    return Boolean(this.config.live && this.session.settings.voiceModel);
  }

  private llmParamsFor(model: string | undefined): Record<string, unknown> | undefined {
    return model ? this.config.llmParams[model] : undefined;
  }

  /** History without the system message, for building live prompts. */
  private conversation(): LLMMessage[] {
    return this.session.history.slice(1);
  }

  /**
   * Live turn: the voice brain hears the raw audio right away. Transcription
   * runs in parallel only to keep a text history and update the transcript.
   */
  private async finishLiveTurnWithVoiceBrain(turn: ActiveAudioTurn): Promise<void> {
    if (turn.state !== "recording") {
      return;
    }
    turn.state = "done";
    this.abortTurnControllers(turn, "voice brain turn");
    turn.streaming?.session?.close(1000, "voice brain turn");
    turn.streaming = undefined;
    this.session.audioTurns.delete(turn.requestId);

    const isPcm = /pcm/i.test(turn.mimeType);
    const audio = isPcm && turn.prefix
      ? Buffer.concat([turn.prefix.audio, ...turn.chunks])
      : Buffer.concat(turn.chunks);
    const pcm = audio;
    const caption = [turn.prefix?.caption, turn.caption?.trim()].filter(Boolean).join(" ");
    turn.timing.finalTranscriptAt = this.config.now();
    this.logAudioLatency(turn, "completed");
    if (pcm.byteLength === 0) {
      this.send({ type: WS_EVENTS.LLM_DONE, requestId: turn.requestId, reason: "ignored" });
      return;
    }
    this.send({
      type: WS_EVENTS.TRANSCRIPT_FINAL,
      requestId: turn.requestId,
      text: caption
    });

    const userEntry: LLMMessage = {
      role: "user",
      content: caption || "(spoken message)"
    };
    this.session.lastUtterance = {
      requestId: turn.requestId,
      audio,
      mimeType: turn.mimeType,
      caption,
      userEntry,
      endedAt: this.config.now(),
      answered: false
    };
    const sttController = new AbortController();
    this.session.transcriptReady = this.transcribeAudio(turn, pcm, sttController.signal)
      .then((text) => {
        if (!text || this.disposed) return;
        userEntry.content = text;
        this.send({
          type: WS_EVENTS.TRANSCRIPT_UPDATE,
          requestId: turn.requestId,
          text
        });
      })
      .catch((error: unknown) => {
        this.config.logger.warn("stt.background_failed", {
          sessionId: this.session.sessionId,
          requestId: turn.requestId,
          error: toError(error).message
        });
      });

    const wav = isPcm ? pcm16MonoToWav(pcm, sampleRateFromMime(turn.mimeType)) : audio;
    const current: LLMContentPart[] = [
      { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } }
    ];
    if (caption) {
      current.push({
        type: "text",
        text: `(On-device caption of the audio above, may contain errors: "${caption}")`
      });
    }
    await this.runVoiceTurn(turn.requestId, turn.timing, userEntry, current);
  }

  private async runVoiceTurn(
    requestId: string,
    timing: RequestTiming,
    userEntry: LLMMessage,
    currentContent?: LLMContentPart[]
  ): Promise<void> {
    if (this.session.current) {
      this.interruptCurrentRun("new user turn");
    }
    // A newer turn makes any not-yet-spoken deep-brain gist stale.
    this.session.pendingSpeech = undefined;
    const previous = this.conversation();
    this.session.history.push(userEntry);
    this.beginStoredTurn(requestId, userEntry, timing);
    const voiceModel = this.pickVoiceModel();
    await this.streamAssistantResponse(requestId, timing, {
      parser: "voice",
      model: voiceModel,
      backupModel: this.backupVoiceModel(voiceModel),
      extraBody: this.llmParamsFor(voiceModel),
      messages: [
        { role: "system", content: this.config.live!.voicePrompt },
        ...previous,
        { role: "user", content: currentContent ?? userEntry.content }
      ],
      onText: ({ speech, brainTask: explicitTask, silent }) => {
        let brainTask = explicitTask;
        // Text-only replies (voice off) count as answered once shown.
        if (
          !this.session.settings.speak &&
          speech.trim() &&
          this.session.lastUtterance?.requestId === requestId
        ) {
          this.session.lastUtterance.answered = true;
        }
        if (silent && !speech.trim()) {
          // Not speech for us: drop the turn from history.
          const index = this.session.history.lastIndexOf(userEntry);
          if (index >= 0) this.session.history.splice(index, 1);
          this.conversations.dropTurn(requestId);
          return;
        }
        // Some voice models promise to look into something but forget the
        // @brain marker. Keep the promise: hand the request off anyway.
        if (!brainTask && promisesFollowUp(speech)) {
          brainTask = "Handle the user's latest request in full (the voice told them it would look into it).";
          this.config.logger.info("brain.implicit_handoff", {
            sessionId: this.session.sessionId,
            requestId
          });
        }
        const spoken = stripEmotionTags(speech);
        this.session.history.push({
          role: "assistant",
          content: brainTask
            ? `${spoken}\n(Asked the deep brain: ${brainTask})`
            : spoken
        });
        this.conversations.completeReply(
          requestId,
          { content: spoken, ...(voiceModel ? { model: voiceModel } : {}) },
          timing.kind === "text" ? undefined : this.session.transcriptReady
        );
        if (brainTask) {
          void this.runDeepBrain(requestId, brainTask);
        }
      }
    });
  }

  /** Background deep-brain run: reasoning + optional OpenUI visual, then a spoken gist. */
  private async runDeepBrain(parentRequestId: string, task: string): Promise<void> {
    const live = this.config.live;
    if (!live || !this.session.settings.llmModel) return;
    const brainId = this.config.createId();
    const budget = this.budgetFor("brain", this.session.settings.llmModel, brainId);
    if (!budget?.model) return;
    const model = budget.model;
    const controller = new AbortController();
    this.session.brainRuns.set(brainId, controller);
    const startedTurn = this.session.turnCounter;
    const genUi = this.session.settings.genUi && Boolean(this.config.genUiSystemPrompt);
    const splitter = genUi ? new SpeechUiSplitter() : undefined;
    let speech = "";
    let ui = "";
    const startedAt = this.config.now();

    this.send({ type: WS_EVENTS.BRAIN_START, requestId: brainId, parentRequestId, task, model });
    // Give the accurate transcript a moment so the deep brain sees the user's
    // real words, not just the on-device caption.
    if (this.session.transcriptReady) {
      await Promise.race([
        this.session.transcriptReady.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3_000))
      ]);
    }
    if (controller.signal.aborted || this.disposed) return;
    this.config.logger.info("brain.started", {
      sessionId: this.session.sessionId,
      requestId: brainId,
      parentRequestId,
      model
    });

    // Speak the gist as soon as it is written (the visual comes after it in
    // the stream and can take much longer), instead of after the whole run.
    let spoke = false;
    const speakGist = (): void => {
      if (spoke) return;
      spoke = true;
      const gist = speech.trim();
      if (gist) {
        this.speakWhenIdle({ requestId: brainId, text: gist, turn: startedTurn });
      }
    };
    const emit = (part: { speech: string; ui: string }): void => {
      if (part.speech) {
        speech += part.speech;
        this.send({ type: WS_EVENTS.BRAIN_DELTA, requestId: brainId, delta: part.speech });
      }
      if (part.ui) {
        ui += part.ui;
        speakGist();
        this.send({ type: WS_EVENTS.UI_DELTA, requestId: brainId, delta: part.ui });
      }
    };

    const tools = this.config.runtime.tools.list({ enabledOnly: true });
    const toolLlm = this.providers.toolLlm;
    try {
      if (toolLlm && tools.length > 0) {
        const result = await runToolLoop({
          ...this.brainToolLoop({
            runId: brainId,
            signal: controller.signal,
            model,
            tools,
            messages: [
              { role: "system", content: live.brainPrompt(genUi) + toolSystemPrompt(tools) },
              ...this.conversation(),
              { role: "user", content: `Task from the voice: ${task}` }
            ]
          }),
          onText: (delta) => {
            if (!controller.signal.aborted && !this.disposed) emit(splitter ? splitter.push(delta) : { speech: delta, ui: "" });
          }
        });
        if (result.aborted || controller.signal.aborted || this.disposed) return;
      } else {
        for await (const chunk of this.providers.llm.streamText(
          [
            { role: "system", content: live.brainPrompt(genUi) },
            ...this.conversation(),
            { role: "user", content: `Task from the voice: ${task}` }
          ],
          { signal: controller.signal, model, extraBody: this.llmParamsFor(model), meta: this.usageMeta("brain", brainId) }
        )) {
          if (controller.signal.aborted || this.disposed) return;
          emit(splitter ? splitter.push(chunk.delta) : { speech: chunk.delta, ui: "" });
        }
      }
      if (splitter) emit(splitter.finish());
      if (controller.signal.aborted || this.disposed) return;

      this.send({ type: WS_EVENTS.BRAIN_DONE, requestId: brainId, reason: "stop" });
      this.pushUsage();
      const gist = speech.trim();
      this.session.history.push({
        role: "assistant",
        content: `[deep brain] ${gist}${ui.trim() ? " (A visual with the details is on the user's screen.)" : ""}`
      });
      this.conversations.brainResult(brainId, parentRequestId, { content: gist, ui, task, model });
      this.config.logger.info("brain.finished", {
        sessionId: this.session.sessionId,
        requestId: brainId,
        durationMs: Math.round(this.config.now() - startedAt),
        uiChars: ui.length
      });
      speakGist();
    } catch (error) {
      if (controller.signal.aborted || this.disposed) return;
      this.config.logger.error("brain.failed", {
        sessionId: this.session.sessionId,
        requestId: brainId,
        error: toError(error).message
      });
      this.send({
        type: "error",
        requestId: brainId,
        scope: "llm",
        message: `Deep brain failed: ${toError(error).message}`
      });
      this.send({ type: WS_EVENTS.BRAIN_DONE, requestId: brainId, reason: "error" });
    } finally {
      this.session.brainRuns.delete(brainId);
    }
  }

  /** Tool-loop wiring shared by deep work and typed chat (tool steps + approvals). */
  private brainToolLoop(run: {
    runId: string;
    signal: AbortSignal;
    model: string;
    tools: ToolLoopInput["tools"];
    messages: ToolLoopInput["messages"];
  }): Omit<ToolLoopInput, "onText"> {
    const runtime = this.config.runtime;
    const extraBody = this.llmParamsFor(run.model);
    return {
      ...run,
      provider: this.providers.toolLlm!,
      ...(extraBody ? { extraBody } : {}),
      conversationId: this.conversations.conversationId,
      ownerId: runtime.ownerId,
      store: runtime.store,
      meter: runtime.meter,
      log: (event, fields) => this.config.logger.info(event, { sessionId: this.session.sessionId, ...fields }),
      onToolStarted: (call) => this.send({ type: WS_EVENTS.TOOL_STARTED, requestId: run.runId, ...call }),
      onToolFinished: ({ callId, toolName, status, summary }) => {
        const artifact = takeSlidesArtifact(run.runId, toolName);
        this.send({ type: WS_EVENTS.TOOL_FINISHED, requestId: run.runId, callId, status, ...(summary ? { summary } : {}), ...(artifact ? { artifact } : {}) });
      },
      approve: ({ tool, input }) => this.approvals.request({ runId: run.runId, conversationId: this.conversations.conversationId, tool, input, signal: run.signal })
    };
  }

  /** Speak a deep-brain gist now, or after the current reply finishes. */
  private speakWhenIdle(speech: { requestId: string; text: string; turn: number }): void {
    // If the user has started talking about something else, don't interrupt
    // them with an old result: it is already on screen and in the history.
    if (this.session.turnCounter !== speech.turn) return;
    const recording = [...this.session.audioTurns.values()].some(
      (turn) => turn.state === "recording" || turn.state === "transcribing"
    );
    if (this.session.current || recording) {
      this.session.pendingSpeech = speech;
      return;
    }
    void this.streamAssistantResponse(
      speech.requestId,
      { kind: "text", requestStartedAt: this.config.now() },
      { parser: "plain", messages: [], speakOnly: speech.text }
    );
  }

  private async streamAssistantResponse(
    requestId: string,
    timing: RequestTiming,
    plan?: ResponsePlan,
    chat: { typed?: boolean } = {}
  ): Promise<void> {
    const feature = plan?.parser === "voice" ? "voice" : "brain";
    let model = plan ? plan.model : this.session.settings.llmModel;
    if (plan?.speakOnly === undefined) {
      const budget = this.budgetFor(feature, model, requestId);
      if (!budget) {
        // Settle the turn in the browser; the budget notice explains why.
        this.send({ type: WS_EVENTS.LLM_DONE, requestId, reason: "error" });
        return;
      }
      model = budget.model;
    }
    timing.llmStartedAt = this.config.now();
    const run: ActiveRun = {
      speak: !chat.typed,
      requestId,
      controller: new AbortController(),
      stage: "llm_streaming",
      text: "",
      interrupted: false,
      llmDoneSent: false,
      ttsStarted: false,
      ttsEnded: false,
      ttsSequence: 0,
      ttsSegmentIndex: 0,
      timing
    };

    this.session.current = run;
    let pendingTtsText = "";
    let ttsQueue = Promise.resolve();
    let ttsError: unknown;

    const enqueueTtsSegment = (text: string, isFinalSegment: boolean): void => {
      // Start synthesizing immediately so segments overlap; deliver in order.
      const synthesis = this.synthesizeTtsSegment(run, text);
      synthesis.catch(() => undefined);
      ttsQueue = ttsQueue
        .then(async () => {
          if (
            ttsError ||
            run.interrupted ||
            run.controller.signal.aborted ||
            this.session.current !== run
          ) {
            return;
          }
          const segment = await synthesis;
          if (
            segment &&
            !run.interrupted &&
            !run.controller.signal.aborted &&
            this.session.current === run
          ) {
            this.deliverTtsSegment(run, segment, isFinalSegment);
          }
        })
        .catch((error: unknown) => {
          if (ttsError || run.interrupted || run.controller.signal.aborted) {
            return;
          }
          // Voice failed: report it, stop speaking, but keep streaming the
          // text and generative UI so the turn is still useful.
          ttsError = error;
          this.config.logger.error("tts.failed", {
            sessionId: this.session.sessionId,
            requestId,
            ttsModel: this.session.settings.ttsModel,
            error: toError(error).message
          });
          this.send({
            type: "error",
            requestId,
            scope: "tts",
            message:
              error instanceof Error ? error.message : "Unknown TTS gateway error"
          });
          this.sendTtsEnd(run, "error");
        });
    };

    const genUi =
      !plan && this.session.settings.genUi && Boolean(this.config.genUiSystemPrompt);
    const splitter =
      genUi || plan?.parser === "genui" ? new SpeechUiSplitter() : undefined;
    const voiceParser = plan?.parser === "voice" ? new VoiceReplyParser() : undefined;
    if (!plan) {
      this.session.history[0] = {
        role: "system",
        content: genUi ? this.config.genUiSystemPrompt! : this.config.systemPrompt
      };
    }
    let speechText = "";
    let uiText = "";
    const emitParts = (speech: string, ui: string): void => {
      if (speech) {
        speechText += speech;
        // Spoken-only runs (deep-brain gist) already showed their text.
        if (!plan?.speakOnly) {
          this.send({ type: WS_EVENTS.LLM_DELTA, requestId, delta: speech });
        }
        pendingTtsText += speech;
      }
      if (ui) {
        uiText += ui;
        this.send({ type: WS_EVENTS.UI_DELTA, requestId, delta: ui });
      }
    };
    const extraBody =
      plan && model === plan.model ? plan.extraBody : this.llmParamsFor(model);
    const messages = plan ? plan.messages : this.session.history;
    const hedgeAfterMs = this.config.hedge?.voiceAfterMs;
    let winningModel = model;
    const tools = plan ? [] : this.config.runtime.tools.list({ enabledOnly: true });
    const source: AsyncIterable<{ delta: string }> =
      !plan && model && this.providers.toolLlm && tools.length > 0
        ? toolLoopStream(
            this.brainToolLoop({
              runId: requestId,
              signal: run.controller.signal,
              model,
              tools,
              messages: [
                { role: "system", content: String(messages[0]?.content ?? "") + toolSystemPrompt(tools) },
                ...messages.slice(1)
              ]
            })
          )
        : plan?.speakOnly !== undefined
        ? singleChunk(plan.speakOnly)
        : plan?.parser === "voice" && hedgeAfterMs !== undefined
          ? hedgedStream(
              (signal, index) => {
                const attemptModel = index === 0 ? model : plan.backupModel ?? model;
                const params = this.llmParamsFor(attemptModel);
                return this.providers.llm.streamText(messages, {
                  signal,
                  meta: this.usageMeta(feature, requestId),
                  ...(attemptModel ? { model: attemptModel } : {}),
                  ...(params ? { extraBody: params } : {})
                });
              },
              {
                hedgeAfterMs,
                signal: run.controller.signal,
                onHedge: (reason) =>
                  this.config.logger.info("hedge.voice", {
                    sessionId: this.session.sessionId,
                    requestId,
                    reason,
                    primary: model,
                    backup: plan.backupModel ?? model
                  }),
                onWinner: (index) => {
                  winningModel = index === 0 ? model : plan.backupModel ?? model;
                  if (index > 0) {
                    this.config.logger.info("hedge.voice_won_by_backup", {
                      sessionId: this.session.sessionId,
                      requestId
                    });
                  }
                }
              }
            )
          : this.providers.llm.streamText(messages, {
              signal: run.controller.signal,
              meta: this.usageMeta(feature, requestId),
              ...(model ? { model } : {}),
              ...(extraBody ? { extraBody } : {})
            });

    try {
      for await (const chunk of source) {
        if (
          run.interrupted ||
          run.controller.signal.aborted ||
          run.llmDoneSent ||
          this.session.current !== run
        ) {
          break;
        }

        run.text += chunk.delta;
        if (run.timing.firstLlmDeltaAt === undefined) {
          run.timing.firstLlmDeltaAt = this.config.now();
          this.config.logger.info("latency.llm_first_delta", {
            sessionId: this.session.sessionId,
            requestId,
            requestKind: run.timing.kind,
            sttPath: run.timing.sttPath,
            ...requestLatencyFields(run.timing)
          });
        }
        if (voiceParser) {
          emitParts(voiceParser.push(chunk.delta).speech, "");
        } else if (splitter) {
          const parts = splitter.push(chunk.delta);
          emitParts(parts.speech, parts.ui);
        } else {
          emitParts(chunk.delta, "");
        }

        const ready = takeReadyTtsSegments(pendingTtsText, this.config);
        pendingTtsText = ready.remainder;
        for (const segment of ready.segments) {
          enqueueTtsSegment(segment, false);
        }
      }

      if (voiceParser && run.timing.firstLlmDeltaAt !== undefined && run.timing.llmStartedAt !== undefined) {
        const firstTokenMs = run.timing.firstLlmDeltaAt - run.timing.llmStartedAt;
        this.recordVoiceLatency(winningModel, firstTokenMs);
        // A primary that lost the hedge was at least this slow (plus margin).
        if (winningModel !== model) this.recordVoiceLatency(model, firstTokenMs + 1_000);
      }
      if (!run.interrupted && this.session.current === run) {
        if (voiceParser) {
          emitParts(voiceParser.finish().speech, "");
        } else if (splitter) {
          const rest = splitter.finish();
          emitParts(rest.speech, rest.ui);
        }
        if (!plan && run.text) {
          this.session.history.push({ role: "assistant", content: run.text });
          this.conversations.completeReply(requestId, {
            content: speechText,
            ui: uiText,
            ...(winningModel ? { model: winningModel } : {})
          });
        }
        const silent = Boolean(voiceParser?.isSilence) && !speechText.trim();
        plan?.onText?.({
          speech: speechText,
          ui: uiText,
          brainTask: voiceParser?.brainTask,
          silent
        });
        if (silent) {
          this.sendLlmDone(run, "ignored");
          this.finishRun(run, "done");
          return;
        }
        this.sendLlmDone(run, "stop");
        if (pendingTtsText.trim()) {
          enqueueTtsSegment(pendingTtsText, true);
        }
        await ttsQueue;
        if (
          run.interrupted ||
          run.controller.signal.aborted ||
          this.session.current !== run
        ) {
          return;
        }
        this.sendTtsEnd(run, "stop");
        this.finishRun(run, ttsError ? "error" : "done");
      }
    } catch (error) {
      if (run.controller.signal.aborted || run.interrupted) {
        this.sendLlmDone(run, "interrupted");
        this.sendTtsEnd(run, "interrupted");
        this.finishRun(run, "interrupted");
        return;
      }

      this.config.logger.error("llm.failed", {
        sessionId: this.session.sessionId,
        requestId,
        error: toError(error).message
      });

      this.send({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : "Unknown gateway error"
      });
      this.sendLlmDone(run, "error");
      this.sendTtsEnd(run, "error");
      this.finishRun(run, "error");
    }
  }

  private interruptCurrentRun(reason: string, requestId?: string): void {
    const run = this.session.current;
    if (!run || (requestId !== undefined && run.requestId !== requestId)) {
      return;
    }
    run.interrupted = true;
    run.controller.abort(reason);
    this.sendLlmDone(run, "interrupted");
    this.sendTtsEnd(run, "interrupted");
    this.finishRun(run, "interrupted");
  }

  /** Synthesize one segment (may run concurrently with others). */
  private async synthesizeTtsSegment(
    run: ActiveRun,
    text: string
  ): Promise<{ audio: Uint8Array; mimeType: string; format: string } | undefined> {
    const ttsModel = this.config.modelCatalog?.tts.find(
      (model) => model.id === this.session.settings.ttsModel
    );
    // Voices that can't perform cues like [laughs] would read them aloud.
    const performable = ttsModel?.emotionTags ? text : stripEmotionTags(text);
    const segmentText = toSpeakableText(performable);
    if (
      !run.speak ||
      !this.session.settings.speak ||
      !this.providers.tts ||
      !segmentText ||
      run.interrupted ||
      run.controller.signal.aborted
    ) {
      return undefined;
    }

    // Some voice models only emit raw PCM (e.g. Gemini TTS); browsers cannot
    // play that directly, so it is wrapped into WAV.
    const requestFormat = ttsModel?.format ?? this.config.ttsFormat;
    const wrapPcm = requestFormat === "pcm";
    if (!run.ttsStarted) {
      run.ttsStarted = true;
      const deliveredFormat = wrapPcm ? "wav" : requestFormat;
      this.send({
        type: WS_EVENTS.TTS_START,
        requestId: run.requestId,
        voice: this.session.settings.ttsVoice ?? this.config.ttsVoice,
        format: deliveredFormat,
        mimeType: mimeTypeForAudioFormat(deliveredFormat)
      });
    }
    run.timing.ttsStartedAt ??= this.config.now();
    const audioParts: Buffer[] = [];
    let mimeType = mimeTypeForAudioFormat(requestFormat);

    const tts = this.providers.tts;
    const input = {
      text: segmentText,
      voice: this.session.settings.ttsVoice ?? this.config.ttsVoice,
      format: requestFormat
    };
    const ttsModelId = this.session.settings.ttsModel;
    const ttsHedge = this.config.hedge?.ttsAfterMs;
    const chunks =
      ttsHedge !== undefined
        ? hedgedStream(
            // Same voice for the duplicate request, so the reply sounds the same.
            (signal) => tts.synthesize(input, { signal, model: ttsModelId, meta: this.usageMeta("tts", run.requestId) }),
            {
              hedgeAfterMs: ttsHedge,
              signal: run.controller.signal,
              onHedge: (reason) =>
                this.config.logger.info("hedge.tts", {
                  sessionId: this.session.sessionId,
                  requestId: run.requestId,
                  reason,
                  model: ttsModelId
                })
            }
          )
        : tts.synthesize(input, {
            signal: run.controller.signal,
            model: ttsModelId,
            meta: this.usageMeta("tts", run.requestId)
          });
    for await (const chunk of chunks) {
      if (run.interrupted || run.controller.signal.aborted) {
        return undefined;
      }
      mimeType = chunk.mimeType;
      audioParts.push(Buffer.from(chunk.audio));
    }
    if (audioParts.length === 0) return undefined;
    const audio = Buffer.concat(audioParts);
    return wrapPcm
      ? {
          audio: pcm16MonoToWav(audio, ttsModel?.sampleRate ?? 24_000),
          mimeType: "audio/wav",
          format: "wav"
        }
      : { audio, mimeType, format: requestFormat };
  }

  private deliverTtsSegment(
    run: ActiveRun,
    segment: { audio: Uint8Array; mimeType: string; format: string },
    isFinalSegment: boolean
  ): void {
    run.stage = "tts_streaming";
    if (this.session.lastUtterance?.requestId === run.requestId) {
      this.session.lastUtterance.answered = true;
    }
    this.sendTtsChunk(
      run,
      { audio: segment.audio, mimeType: segment.mimeType },
      run.ttsSegmentIndex++,
      isFinalSegment
    );
  }

  private sendTtsChunk(
    run: ActiveRun,
    chunk: { audio: Uint8Array; mimeType: string },
    segmentIndex: number,
    isFinal: boolean
  ): void {
    if (run.timing.firstTtsChunkAt === undefined) {
      run.timing.firstTtsChunkAt = this.config.now();
      this.config.logger.info("latency.tts_first_chunk", {
        sessionId: this.session.sessionId,
        requestId: run.requestId,
        requestKind: run.timing.kind,
        sttPath: run.timing.sttPath,
        ...requestLatencyFields(run.timing)
      });
    }
    this.send({
      type: WS_EVENTS.TTS_CHUNK,
      requestId: run.requestId,
      sequence: run.ttsSequence++,
      chunk: Buffer.from(chunk.audio).toString("base64"),
      mimeType: chunk.mimeType,
      segmentIndex,
      isFinal
    });
  }

  private sendLlmDone(run: ActiveRun, reason: LlmDoneMessage["reason"]): void {
    if (run.llmDoneSent) {
      return;
    }
    run.llmDoneSent = true;
    this.send({
      type: WS_EVENTS.LLM_DONE,
      requestId: run.requestId,
      reason
    });
  }

  private sendTtsEnd(
    run: ActiveRun,
    reason: "stop" | "interrupted" | "error"
  ): void {
    if (run.ttsEnded || !run.ttsStarted) {
      return;
    }
    run.ttsEnded = true;
    this.send({
      type: WS_EVENTS.TTS_END,
      requestId: run.requestId,
      reason
    });
  }

  private finishRun(
    run: ActiveRun,
    stage: "done" | "interrupted" | "error"
  ): void {
    run.stage = stage;
    if (this.session.current === run) {
      this.session.current = undefined;
    }
    if (stage !== "interrupted") this.pushUsage();
    const pending = this.session.pendingSpeech;
    if (pending && pending.requestId !== run.requestId && !this.disposed) {
      this.session.pendingSpeech = undefined;
      queueMicrotask(() => this.speakWhenIdle(pending));
    }
    this.config.logger.info("request.finished", {
      sessionId: this.session.sessionId,
      requestId: run.requestId,
      stage,
      requestKind: run.timing.kind,
      sttPath: run.timing.sttPath,
      requestTotalMs: elapsedMs(
        run.timing.requestStartedAt,
        this.config.now()
      ),
      ...requestLatencyFields(run.timing)
    });
  }

  private deleteAudioTurn(turn: ActiveAudioTurn, reason: string): void {
    this.abortTurnControllers(turn, reason);
    turn.streaming?.session?.close(1000, reason);
    if (this.session.audioTurns.get(turn.requestId) === turn) {
      this.session.audioTurns.delete(turn.requestId);
    }
    this.logAudioLatency(
      turn,
      turn.state === "done"
        ? "completed"
        : turn.state === "error"
          ? "error"
          : "interrupted"
    );
  }

  private logAudioLatency(
    turn: ActiveAudioTurn,
    outcome: "completed" | "interrupted" | "error"
  ): void {
    if (turn.latencyLogged) return;
    turn.latencyLogged = true;
    this.config.logger.info("latency.stt", {
      sessionId: this.session.sessionId,
      requestId: turn.requestId,
      requestKind: turn.timing.kind,
      sttPath: turn.timing.sttPath,
      outcome,
      ...requestLatencyFields(turn.timing)
    });
  }

  private cancelAudioTurn(requestId: string, reason: string): void {
    const turn = this.session.audioTurns.get(requestId);
    if (!turn) {
      return;
    }
    this.deleteAudioTurn(turn, reason);
    this.config.logger.info("audio.cancelled", {
      sessionId: this.session.sessionId,
      requestId,
      reason
    });
  }

  private abortTurnControllers(turn: ActiveAudioTurn, reason: string): void {
    for (const controller of turn.controllers) {
      controller.abort(reason);
    }
    turn.controllers.clear();
    turn.partialInFlight = false;
  }

  private dispose(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.config.logger.info("session.disconnected", {
      sessionId: this.session.sessionId,
      reason
    });
    this.interruptCurrentRun(reason);
    for (const turn of this.session.audioTurns.values()) {
      this.abortTurnControllers(turn, reason);
    }
    this.session.audioTurns.clear();
    for (const controller of this.session.brainRuns.values()) {
      controller.abort(reason);
    }
    this.session.brainRuns.clear();
    this.session.pendingSpeech = undefined;
    this.approvals.dispose();
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

function filenameForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) return "recording.webm";
  if (mimeType.includes("mp4")) return "recording.mp4";
  if (mimeType.includes("mpeg")) return "recording.mp3";
  if (mimeType.includes("wav")) return "recording.wav";
  return "recording.webm";
}

function mimeTypeForAudioFormat(format: string): string {
  switch (format) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/ogg; codecs=opus";
    case "pcm":
      return "audio/pcm";
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

function normalizeAudioForBatchStt(
  mimeType: string,
  audio: Buffer
): { data: Buffer; mimeType: string } {
  if (!mimeType.toLowerCase().startsWith("audio/pcm")) {
    return { data: audio, mimeType };
  }

  const rateMatch = mimeType.match(/(?:^|;)\s*rate=(\d+)/i);
  const sampleRate = Number.parseInt(rateMatch?.[1] ?? "24000", 10);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("PCM audio rate must be a positive integer");
  }
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 audio must contain an even number of bytes");
  }

  return {
    data: pcm16MonoToWav(audio, sampleRate),
    mimeType: "audio/wav"
  };
}

function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requestLatencyFields(timing: RequestTiming): Record<string, number> {
  return compactDurations({
    sttFirstPartialMs: elapsedMs(
      timing.speechStartedAt,
      timing.firstPartialAt
    ),
    sttFinalMs: elapsedMs(timing.speechEndedAt, timing.finalTranscriptAt),
    sttTotalMs: elapsedMs(timing.speechStartedAt, timing.finalTranscriptAt),
    llmFirstDeltaMs: elapsedMs(timing.llmStartedAt, timing.firstLlmDeltaAt),
    inputReadyToFirstLlmMs: elapsedMs(
      timing.finalTranscriptAt ?? timing.requestStartedAt,
      timing.firstLlmDeltaAt
    ),
    ttsFirstChunkMs: elapsedMs(timing.ttsStartedAt, timing.firstTtsChunkAt),
    llmFirstToTtsFirstChunkMs: elapsedMs(
      timing.firstLlmDeltaAt,
      timing.firstTtsChunkAt
    ),
    speechEndToFirstTtsChunkMs: elapsedMs(
      timing.speechEndedAt,
      timing.firstTtsChunkAt
    )
  });
}

function elapsedMs(
  start: number | undefined,
  end: number | undefined
): number | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  return Math.round(end - start);
}

function compactDurations(
  fields: Record<string, number | undefined>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, number] => entry[1] !== undefined
    )
  );
}

function initialSettings(
  config: GatewayConfig,
  ttsAvailable: boolean
): SessionState["settings"] {
  const catalog = config.modelCatalog;
  const defaults = config.defaultSettings;
  const ttsModelId = defaults.ttsModel ?? catalog?.tts[0]?.id;
  const ttsModel = catalog?.tts.find((model) => model.id === ttsModelId);
  const voiceModel = config.live
    ? defaults.voiceModel ?? catalog?.voice?.[0]?.id
    : undefined;
  return {
    ...(voiceModel ? { voiceModel } : {}),
    llmModel: defaults.llmModel ?? catalog?.llm[0]?.id,
    sttModel: defaults.sttModel ?? catalog?.stt[0]?.id,
    ttsModel: ttsModelId,
    ttsVoice: defaults.ttsVoice ?? ttsModel?.defaultVoice ?? ttsModel?.voices?.[0] ?? config.ttsVoice,
    genUi: (defaults.genUi ?? true) && Boolean(config.genUiSystemPrompt),
    speak: (defaults.speak ?? true) && ttsAvailable
  };
}

/** "Let me pull that up", "give me a sec"... a promise to follow up. */
const FOLLOW_UP_PROMISE =
  /\b(let me (check|look|pull|think|put|find|see|get|dig|work|grab|figure|sort|map|compare|search)|give me (a|one|just a) (sec|second|moment|minute)|one (sec|second|moment)|hang on|bear with me|i'?ll (look|check|pull|put together|find|dig))\b/i;

export function promisesFollowUp(speech: string): boolean {
  return FOLLOW_UP_PROMISE.test(speech);
}

async function* singleChunk(text: string): AsyncIterable<{ delta: string }> {
  yield { delta: text };
}

function sampleRateFromMime(mimeType: string): number {
  const match = /rate=(\d+)/.exec(mimeType);
  return match ? Number(match[1]) : 24_000;
}

function takeReadyTtsSegments(
  text: string,
  config: Pick<GatewayConfig, "ttsSegmentMinLength" | "ttsSegmentMaxLength">
): { segments: string[]; remainder: string } {
  const segments: string[] = [];
  let remainder = text;

  while (remainder.length >= config.ttsSegmentMinLength) {
    const boundary = findSegmentBoundary(remainder, config);
    const splitAt =
      boundary >= config.ttsSegmentMinLength
        ? boundary
        : remainder.length >= config.ttsSegmentMaxLength
          ? config.ttsSegmentMaxLength
          : -1;
    if (splitAt === -1) {
      break;
    }
    segments.push(remainder.slice(0, splitAt).trim());
    remainder = remainder.slice(splitAt).trimStart();
  }

  return { segments: segments.filter(Boolean), remainder };
}

function findSegmentBoundary(
  text: string,
  config: Pick<GatewayConfig, "ttsSegmentMinLength" | "ttsSegmentMaxLength">
): number {
  const boundaryPattern = /[.!?。！？；;，,]\s*/g;
  let match: RegExpExecArray | null;
  let lastBoundary = -1;
  while ((match = boundaryPattern.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    if (boundary >= config.ttsSegmentMinLength) {
      lastBoundary = boundary;
    }
    if (boundary >= config.ttsSegmentMaxLength) {
      break;
    }
  }
  return lastBoundary;
}

function validateConfig(config: GatewayConfig): void {
  const positiveValues: Array<[string, number]> = [
    ["maxAudioTurnBytes", config.maxAudioTurnBytes],
    ["livePartialInitialIntervalMs", config.livePartialInitialIntervalMs],
    ["livePartialLongTurnIntervalMs", config.livePartialLongTurnIntervalMs],
    ["livePartialLongTurnAfterMs", config.livePartialLongTurnAfterMs],
    ["streamingSttFinalTimeoutMs", config.streamingSttFinalTimeoutMs],
    ["ttsSegmentMinLength", config.ttsSegmentMinLength],
    ["ttsSegmentMaxLength", config.ttsSegmentMaxLength]
  ];
  for (const [name, value] of positiveValues) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be greater than zero`);
    }
  }
  if (config.ttsSegmentMaxLength < config.ttsSegmentMinLength) {
    throw new Error("ttsSegmentMaxLength must be at least ttsSegmentMinLength");
  }
}

function listenHttpServer(
  server: HttpServer,
  port: number,
  host?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
