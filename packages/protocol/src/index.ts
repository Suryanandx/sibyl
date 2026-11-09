export const WS_EVENTS = {
  SESSION_START: "session.start",
  USER_TEXT: "user.text",
  LLM_DELTA: "llm.delta",
  LLM_DONE: "llm.done",
  INTERRUPT: "interrupt",
  AUDIO_CHUNK: "audio.chunk",
  VAD_SPEECH_START: "vad.speech_start",
  VAD_SPEECH_END: "vad.speech_end",
  TRANSCRIPT_PARTIAL: "transcript.partial",
  TRANSCRIPT_FINAL: "transcript.final",
  TTS_START: "tts.start",
  TTS_CHUNK: "tts.chunk",
  TTS_END: "tts.end",
  PLAYBACK_ACK: "playback.ack",
  SESSION_UPDATE: "session.update",
  SESSION_CONFIG: "session.config",
  UI_DELTA: "ui.delta",
  TRANSCRIPT_UPDATE: "transcript.update",
  BRAIN_START: "brain.start",
  BRAIN_DELTA: "brain.delta",
  BRAIN_DONE: "brain.done",
  TURN_MERGED: "turn.merged",
  // Tools & approvals (deep-brain tool loop)
  TOOL_STARTED: "tool.started",
  TOOL_FINISHED: "tool.finished",
  APPROVAL_REQUEST: "approval.request",
  APPROVAL_DECISION: "approval.decision",
  APPROVAL_RESOLVED: "approval.resolved",
  // Cost metering
  USAGE_REQUEST: "usage.request",
  USAGE_UPDATE: "usage.update",
  BUDGET_BLOCKED: "budget.blocked",
  // Server-side conversations
  CONVERSATIONS_REQUEST: "conversations.request",
  CONVERSATIONS_LIST: "conversations.list",
  CONVERSATION_OPEN: "conversation.open",
  CONVERSATION_STATE: "conversation.state",
  CONVERSATION_DELETE: "conversation.delete"
} as const;

/* ───────────── Tools, approvals, usage, conversations (v0.3) ───────────── */

export interface ToolStartedMessage {
  type: typeof WS_EVENTS.TOOL_STARTED;
  /** Brain request id (deep-work id) the call belongs to. */
  requestId: string;
  callId: string;
  toolName: string;
  /** Human label, e.g. "Searching the web". */
  title: string;
}

export interface ToolFinishedMessage {
  type: typeof WS_EVENTS.TOOL_FINISHED;
  requestId: string;
  callId: string;
  status: "ok" | "error" | "declined";
  /** Short human summary of the result. */
  summary?: string;
  /** Deck or file the tool produced (e.g. create_slides), for a preview card. */
  artifact?: ToolArtifactView;
  /** Public web page the tool read (read_webpage), for the chat's side panel. */
  link?: ToolLinkView;
}

/** A public http(s) page a tool read: shown as a link card, never framed. */
export interface ToolLinkView {
  url: string;
  title?: string;
}

/** Browser-safe view of an artifact a tool produced. URLs never point at internal services. */
export interface ToolArtifactView {
  id: string;
  kind: "slides" | "file" | "media";
  title: string;
  version: number;
  /** kind "media": the generated image, video or audio (create_image / create_video / create_audio). */
  media?: MediaItemView;
  parentId?: string;
  spaceId?: string;
  slideCount?: number;
  /** Web-app path of the editor, e.g. /slides/presentation?id=… */
  editUrl?: string;
  /** Gateway-relative thumbnail path (needs the owner token). */
  thumbnailUrl?: string;
  /** Gateway-relative download paths (need the owner token). */
  downloads?: { pptx?: string; pdf?: string };
  createdAt?: number;
}

export interface ApprovalView {
  id: string;
  /** Brain request or routine run waiting on the decision. */
  runId: string;
  conversationId?: string;
  routineId?: string;
  /** "high": hard to undo (send, delete, share, move money). */
  risk?: "high";
  toolName: string;
  title: string;
  /** Exactly what will happen, in one or two sentences. */
  summary: string;
  /** Key inputs for review (already redacted/truncated by the server). */
  details?: Array<{ label: string; value: string }>;
  createdAt: number;
  expiresAt?: number;
}

export interface ApprovalRequestMessage {
  type: typeof WS_EVENTS.APPROVAL_REQUEST;
  approval: ApprovalView;
}

export interface ApprovalDecisionMessage {
  type: typeof WS_EVENTS.APPROVAL_DECISION;
  id: string;
  decision: "approve" | "decline";
  /** Optionally stop asking for this tool for the rest of the conversation. */
  remember?: "conversation";
}

export interface ApprovalResolvedMessage {
  type: typeof WS_EVENTS.APPROVAL_RESOLVED;
  id: string;
  status: "approved" | "declined" | "expired";
}

export interface UsageView {
  todayUsd: number;
  monthUsd: number;
  sessionUsd: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  byFeature: Record<string, number>;
  /** The current workspace's spend and its own budget (Settings → Workspace). */
  workspace?: { id: string; todayUsd: number; monthUsd: number; dailyBudgetUsd?: number; monthlyBudgetUsd?: number };
  /** True when close to a cap and cheaper models are being used. */
  economyMode: boolean;
  /** What recent replies in this session cost, by request id (actual unless estimated). */
  requestCosts?: Record<string, { usd: number; estimated: boolean }>;
  /** Average cost of a reply over the most recent replies (all sessions since the gateway started). */
  averageReplyUsd?: number;
  averageReplySamples?: number;
}

export interface UsageRequestMessage {
  type: typeof WS_EVENTS.USAGE_REQUEST;
}

export interface UsageUpdateMessage {
  type: typeof WS_EVENTS.USAGE_UPDATE;
  usage: UsageView;
}

export interface BudgetBlockedMessage {
  type: typeof WS_EVENTS.BUDGET_BLOCKED;
  requestId?: string;
  /** "policy": an Enterprise usage control (per-user budget, request cap, rate limit, …). */
  scope: "daily" | "monthly" | "routine_run" | "routine_daily" | "policy" | "credits";
  message: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ConversationMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  requestId: string;
  source?: "text" | "audio" | "ui";
  ui?: string;
  kind?: "brain";
  task?: string;
  model?: string;
  steps?: Array<{ callId: string; toolName: string; title: string; status: "ok" | "error" | "declined" }>;
  /** Files attached to a user message (wave 2). */
  attachments?: AttachmentRef[];
  createdAt: number;
}

export interface ConversationsRequestMessage {
  type: typeof WS_EVENTS.CONVERSATIONS_REQUEST;
}

export interface ConversationsListMessage {
  type: typeof WS_EVENTS.CONVERSATIONS_LIST;
  items: ConversationSummary[];
}

/** Start a new conversation (no id) or resume one; the gateway restores its context. */
export interface ConversationOpenMessage {
  type: typeof WS_EVENTS.CONVERSATION_OPEN;
  conversationId?: string;
}

export interface ConversationStateMessage {
  type: typeof WS_EVENTS.CONVERSATION_STATE;
  conversationId: string;
  title: string;
  messages: ConversationMessageView[];
}

export interface ConversationDeleteMessage {
  type: typeof WS_EVENTS.CONVERSATION_DELETE;
  conversationId: string;
}

/** A selectable model entry exposed to the browser. */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  /** Estimated USD per 100 conversational turns (from OpenRouter pricing). */
  costPer100Turns?: number;
  /** Measured time to first token / first audio byte. */
  latencyMs?: number;
  /** OpenRouter Design Arena Elo (quality signal). */
  elo?: number;
}

/** One-click model set chosen by the model scout. */
export interface ModelPreset {
  id: string;
  label: string;
  settings: Partial<SessionSettings>;
  /** Estimated USD per 100 spoken turns (voice brain + transcription + speech, deep work on ~1 in 3). */
  costPer100Turns?: number;
  /** Estimated USD per 100 typed messages (the chat model on every message, no speech). */
  costPer100Messages?: number;
}

export interface TtsModelOption extends ModelOption {
  voices?: string[];
  defaultVoice?: string;
  /** Audio format to request (default TTS_FORMAT). "pcm" is wrapped as WAV by the Gateway. */
  format?: string;
  /** Sample rate of raw PCM output (default 24000). */
  sampleRate?: number;
  /** The voice can perform cues like [laughs] / [whispers]; otherwise they are stripped. */
  emotionTags?: boolean;
}

export interface ModelCatalog {
  /** Audio-native models that hear the user and talk (the "voice brain"). */
  voice?: ModelOption[];
  /** Deep-brain models (reasoning + generative UI). */
  llm: ModelOption[];
  stt: ModelOption[];
  tts: TtsModelOption[];
  presets?: ModelPreset[];
}

export interface SessionSettings {
  /** Voice brain: hears the user's audio and replies conversationally. */
  voiceModel?: string;
  /** Deep brain (or the only model when no voice brain is configured). */
  llmModel: string;
  sttModel: string;
  ttsModel?: string;
  ttsVoice?: string;
  /** Ask the LLM for OpenUI generative UI alongside the spoken answer. */
  genUi: boolean;
  /** Synthesize spoken replies (TTS). */
  speak: boolean;
}

export interface SessionCapabilities {
  provider: string;
  genUi: boolean;
  tts: boolean;
  realtimeStt: boolean;
  /** LiveKit is configured: voice runs over WebRTC (see RealtimeCapability). */
  realtime?: RealtimeCapability;
}

export type WsEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];

export interface ClientSessionStartMessage {
  type: typeof WS_EVENTS.SESSION_START;
  sessionId?: string;
}

export interface ClientSessionUpdateMessage {
  type: typeof WS_EVENTS.SESSION_UPDATE;
  settings: Partial<SessionSettings>;
}

export interface ServerSessionConfigMessage {
  type: typeof WS_EVENTS.SESSION_CONFIG;
  catalog: ModelCatalog;
  settings: SessionSettings;
  capabilities: SessionCapabilities;
}

/** Streamed OpenUI Lang source for the assistant's generative UI. */
export interface UiDeltaMessage {
  type: typeof WS_EVENTS.UI_DELTA;
  requestId: string;
  delta: string;
}

export interface ServerSessionStartMessage {
  type: typeof WS_EVENTS.SESSION_START;
  sessionId: string;
  status: "ready";
}

export interface UserTextMessage {
  type: typeof WS_EVENTS.USER_TEXT;
  requestId?: string;
  text: string;
  /** Uploaded files sent with the message (wave 2; text may then be empty). */
  attachments?: AttachmentRef[];
  /** Answer as this agent (v0.4); an "@Name" at the start of the text also selects one. */
  agentId?: string;
  /** Composer Create mode: make an image, video or audio from the text (see MediaCreateSpec). */
  media?: MediaCreateSpec;
}

export interface AudioChunkMessage {
  type: typeof WS_EVENTS.AUDIO_CHUNK;
  requestId: string;
  chunk?: string;
  mimeType: string;
  sequence: number;
  isFinal?: boolean;
  turnMode?: "ptt" | "live";
}

export interface VadSpeechStartMessage {
  type: typeof WS_EVENTS.VAD_SPEECH_START;
  requestId: string;
  turnMode: "live";
  startedAt: number;
  rms?: number;
  /** Talk to this agent (v0.4); same as agent.select. */
  agentId?: string;
}

export interface VadSpeechEndMessage {
  type: typeof WS_EVENTS.VAD_SPEECH_END;
  requestId: string;
  endedAt: number;
  durationMs?: number;
  reason: "silence" | "manual" | "cancelled";
  /** Instant on-device caption of what was said (display hint, may be inaccurate). */
  caption?: string;
}

export interface InterruptMessage {
  type: typeof WS_EVENTS.INTERRUPT;
  requestId?: string;
  reason?: string;
}

export interface PlaybackAckMessage {
  type: typeof WS_EVENTS.PLAYBACK_ACK;
  requestId: string;
  sequence?: number;
}

export interface LlmDeltaMessage {
  type: typeof WS_EVENTS.LLM_DELTA;
  requestId: string;
  delta: string;
}

export interface LlmDoneMessage {
  type: typeof WS_EVENTS.LLM_DONE;
  requestId: string;
  /** "ignored": the turn had no real speech for the assistant (noise, silence). */
  reason: "stop" | "interrupted" | "error" | "ignored";
}

/** Accurate transcript of a user turn that arrived after the turn started. */
export interface TranscriptUpdateMessage {
  type: typeof WS_EVENTS.TRANSCRIPT_UPDATE;
  requestId: string;
  text: string;
}

/**
 * The user kept talking after a pause before the assistant replied: the
 * earlier fragment is folded into this turn (one thought, one answer).
 */
export interface TurnMergedMessage {
  type: typeof WS_EVENTS.TURN_MERGED;
  requestId: string;
  mergedRequestId: string;
}

/** The voice brain handed a task to the deep brain. */
export interface BrainStartMessage {
  type: typeof WS_EVENTS.BRAIN_START;
  /** Id of the deep-brain result (used by brain.delta, ui.delta and tts.*). */
  requestId: string;
  parentRequestId: string;
  task: string;
  model: string;
}

export interface BrainDeltaMessage {
  type: typeof WS_EVENTS.BRAIN_DELTA;
  requestId: string;
  delta: string;
}

export interface BrainDoneMessage {
  type: typeof WS_EVENTS.BRAIN_DONE;
  requestId: string;
  reason: "stop" | "interrupted" | "error";
}

export interface TranscriptFinalMessage {
  type: typeof WS_EVENTS.TRANSCRIPT_FINAL;
  requestId: string;
  text: string;
}

export interface TranscriptPartialMessage {
  type: typeof WS_EVENTS.TRANSCRIPT_PARTIAL;
  requestId: string;
  text: string;
  sequence: number;
  isStable?: boolean;
}

export interface ErrorMessage {
  type: "error";
  requestId?: string;
  message: string;
  /**
   * What failed. "tts" errors are non-fatal: text and UI keep streaming,
   * only the spoken reply stops.
   */
  scope?: "tts" | "stt" | "llm";
}

export interface TtsStartMessage {
  type: typeof WS_EVENTS.TTS_START;
  requestId: string;
  voice?: string;
  format: string;
  mimeType: string;
}

export interface TtsChunkMessage {
  type: typeof WS_EVENTS.TTS_CHUNK;
  requestId: string;
  sequence: number;
  chunk: string;
  mimeType: string;
  segmentIndex?: number;
  isFinal?: boolean;
}

export interface TtsEndMessage {
  type: typeof WS_EVENTS.TTS_END;
  requestId: string;
  reason: "stop" | "interrupted" | "error";
}

export type ClientMessage =
  | ClientSessionStartMessage
  | UserTextMessage
  | AudioChunkMessage
  | VadSpeechStartMessage
  | VadSpeechEndMessage
  | InterruptMessage
  | PlaybackAckMessage
  | ClientSessionUpdateMessage
  | ApprovalDecisionMessage
  | UsageRequestMessage
  | ConversationsRequestMessage
  | ConversationOpenMessage
  | ConversationDeleteMessage
  | ConnectionsClientMessage
  | RoutinesClientMessage
  | SecretsClientMessage
  | IdentityClientMessage
  | MonitorsClientMessage
  | IntegrationsClientMessage
  | AgentsClientMessage
  | NotificationsClientMessage
  | ComputersClientMessage
  | RealtimeClientMessage
  | MeetingsClientMessage;

export type ServerMessage =
  | ServerSessionStartMessage
  | LlmDeltaMessage
  | LlmDoneMessage
  | TranscriptPartialMessage
  | TranscriptFinalMessage
  | TtsStartMessage
  | TtsChunkMessage
  | TtsEndMessage
  | ServerSessionConfigMessage
  | UiDeltaMessage
  | TranscriptUpdateMessage
  | TurnMergedMessage
  | BrainStartMessage
  | BrainDeltaMessage
  | BrainDoneMessage
  | ToolStartedMessage
  | ToolFinishedMessage
  | ApprovalRequestMessage
  | ApprovalResolvedMessage
  | UsageUpdateMessage
  | BudgetBlockedMessage
  | ConversationsListMessage
  | ConversationStateMessage
  | ConnectionsServerMessage
  | RoutinesServerMessage
  | SecretsServerMessage
  | LicenseStateMessage
  | IdentityServerMessage
  | MonitorsServerMessage
  | ErrorMessage
  | IntegrationsServerMessage
  | AgentsServerMessage
  | NotificationsServerMessage
  | ComputersServerMessage
  | RealtimeServerMessage
  | MeetingsServerMessage;

export type ReservedMessage = never;

/**
 * The one result shape of every parser in this file: `{ success: true, data }`
 * or `{ success: false, error }` (a short, human-readable reason). Parsers for
 * one area's messages return `undefined` when the message type isn't theirs.
 */
export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

function ok<T>(data: T): ParseResult<T> {
  return { success: true, data };
}

function fail<T = never>(error: string): ParseResult<T> {
  return { success: false, error };
}

export type ClientMessageValidationResult = ParseResult<ClientMessage>;

export type ServerMessageValidationResult = ParseResult<ServerMessage>;

/**
 * Validate an untrusted value before it enters the gateway message handler.
 * TypeScript types disappear at runtime, so every WebSocket payload must pass
 * through this boundary instead of being cast directly to ClientMessage.
 */
export function parseClientMessage(input: unknown): ClientMessageValidationResult {
  if (!isRecord(input)) {
    return invalid("message must be a JSON object");
  }

  if (typeof input.type !== "string" || input.type.length === 0) {
    return invalid("type must be a non-empty string");
  }

  switch (input.type) {
    case WS_EVENTS.SESSION_START:
      if (!isOptionalNonEmptyString(input.sessionId)) {
        return invalid("session.start sessionId must be a non-empty string");
      }
      return valid({
        type: WS_EVENTS.SESSION_START,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
      });

    case WS_EVENTS.USER_TEXT:
      if (typeof input.text !== "string") {
        return invalid("user.text text must be a string");
      }
      if (!isOptionalNonEmptyString(input.requestId)) {
        return invalid("user.text requestId must be a non-empty string");
      }
      {
        const attachments = parseAttachments(input.attachments);
        if (!attachments.success) {
          return invalid(`user.text ${attachments.error}`);
        }
        if (input.agentId !== undefined && !isAgentId(input.agentId)) {
          return invalid("user.text agentId must be an agent id");
        }
        const media = input.media === undefined ? undefined : parseMediaCreateSpec(input.media);
        if (media && !media.success) {
          return invalid(`user.text ${media.error}`);
        }
        return valid({
          type: WS_EVENTS.USER_TEXT,
          text: input.text,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          ...(attachments.data?.length ? { attachments: attachments.data } : {}),
          ...(isAgentId(input.agentId) ? { agentId: input.agentId } : {}),
          ...(media?.success ? { media: media.data } : {})
        });
      }

    case WS_EVENTS.AUDIO_CHUNK:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("audio.chunk requestId must be a non-empty string");
      }
      if (!isOptionalString(input.chunk)) {
        return invalid("audio.chunk chunk must be a string");
      }
      if (!isNonEmptyString(input.mimeType)) {
        return invalid("audio.chunk mimeType must be a non-empty string");
      }
      if (!isNonNegativeInteger(input.sequence)) {
        return invalid("audio.chunk sequence must be a non-negative integer");
      }
      if (!isOptionalBoolean(input.isFinal)) {
        return invalid("audio.chunk isFinal must be a boolean");
      }
      if (!isOptionalEnum(input.turnMode, ["ptt", "live"] as const)) {
        return invalid("audio.chunk turnMode must be ptt or live");
      }
      return valid({
        type: WS_EVENTS.AUDIO_CHUNK,
        requestId: input.requestId,
        mimeType: input.mimeType,
        sequence: input.sequence,
        ...(input.chunk === undefined ? {} : { chunk: input.chunk }),
        ...(input.isFinal === undefined ? {} : { isFinal: input.isFinal }),
        ...(input.turnMode === undefined ? {} : { turnMode: input.turnMode })
      });

    case WS_EVENTS.VAD_SPEECH_START:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("vad.speech_start requestId must be a non-empty string");
      }
      if (input.turnMode !== "live") {
        return invalid("vad.speech_start turnMode must be live");
      }
      if (!isFiniteNumber(input.startedAt)) {
        return invalid("vad.speech_start startedAt must be a finite number");
      }
      if (!isOptionalFiniteNumber(input.rms)) {
        return invalid("vad.speech_start rms must be a finite number");
      }
      if (input.agentId !== undefined && !isAgentId(input.agentId)) {
        return invalid("vad.speech_start agentId must be an agent id");
      }
      return valid({
        type: WS_EVENTS.VAD_SPEECH_START,
        requestId: input.requestId,
        turnMode: "live",
        startedAt: input.startedAt,
        ...(input.rms === undefined ? {} : { rms: input.rms }),
        ...(isAgentId(input.agentId) ? { agentId: input.agentId } : {})
      });

    case WS_EVENTS.VAD_SPEECH_END:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("vad.speech_end requestId must be a non-empty string");
      }
      if (!isFiniteNumber(input.endedAt)) {
        return invalid("vad.speech_end endedAt must be a finite number");
      }
      if (!isOptionalFiniteNumber(input.durationMs)) {
        return invalid("vad.speech_end durationMs must be a finite number");
      }
      if (!isEnum(input.reason, ["silence", "manual", "cancelled"] as const)) {
        return invalid("vad.speech_end reason must be silence, manual, or cancelled");
      }
      if (
        input.caption !== undefined &&
        (typeof input.caption !== "string" || input.caption.length > 4000)
      ) {
        return invalid("vad.speech_end caption must be a string");
      }
      return valid({
        type: WS_EVENTS.VAD_SPEECH_END,
        requestId: input.requestId,
        endedAt: input.endedAt,
        reason: input.reason,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.caption === undefined ? {} : { caption: input.caption })
      });

    case WS_EVENTS.INTERRUPT:
      if (!isOptionalNonEmptyString(input.requestId)) {
        return invalid("interrupt requestId must be a non-empty string");
      }
      if (!isOptionalString(input.reason)) {
        return invalid("interrupt reason must be a string");
      }
      return valid({
        type: WS_EVENTS.INTERRUPT,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        ...(input.reason === undefined ? {} : { reason: input.reason })
      });

    case WS_EVENTS.PLAYBACK_ACK:
      if (!isNonEmptyString(input.requestId)) {
        return invalid("playback.ack requestId must be a non-empty string");
      }
      if (input.sequence !== undefined && !isNonNegativeInteger(input.sequence)) {
        return invalid("playback.ack sequence must be a non-negative integer");
      }
      return valid({
        type: WS_EVENTS.PLAYBACK_ACK,
        requestId: input.requestId,
        ...(input.sequence === undefined ? {} : { sequence: input.sequence })
      });

    case WS_EVENTS.APPROVAL_DECISION:
      if (!isNonEmptyString(input.id) || input.id.length > 100) {
        return invalid("approval.decision id must be a non-empty string");
      }
      if (!isEnum(input.decision, ["approve", "decline"] as const)) {
        return invalid("approval.decision decision must be approve or decline");
      }
      if (input.remember !== undefined && input.remember !== "conversation") {
        return invalid("approval.decision remember must be conversation");
      }
      return valid({
        type: WS_EVENTS.APPROVAL_DECISION,
        id: input.id,
        decision: input.decision,
        ...(input.remember === undefined ? {} : { remember: "conversation" as const })
      });

    case WS_EVENTS.USAGE_REQUEST:
      return valid({ type: WS_EVENTS.USAGE_REQUEST });

    case WS_EVENTS.CONVERSATIONS_REQUEST:
      return valid({ type: WS_EVENTS.CONVERSATIONS_REQUEST });

    case WS_EVENTS.CONVERSATION_OPEN:
      if (input.conversationId !== undefined && (!isNonEmptyString(input.conversationId) || input.conversationId.length > 100)) {
        return invalid("conversation.open conversationId must be a non-empty string");
      }
      return valid({
        type: WS_EVENTS.CONVERSATION_OPEN,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId })
      });

    case WS_EVENTS.CONVERSATION_DELETE:
      if (!isNonEmptyString(input.conversationId) || input.conversationId.length > 100) {
        return invalid("conversation.delete conversationId must be a non-empty string");
      }
      return valid({ type: WS_EVENTS.CONVERSATION_DELETE, conversationId: input.conversationId });

    case WS_EVENTS.SESSION_UPDATE: {
      const parsed = parseSettingsPatch(input.settings);
      if (!parsed.success) {
        return invalid(`session.update ${parsed.error}`);
      }
      return valid({ type: WS_EVENTS.SESSION_UPDATE, settings: parsed.data });
    }

    default:
      return parseConnectionsClientMessage(input) ?? parseRoutinesClientMessage(input) ?? parseSecretsClientMessage(input) ?? parseIdentityClientMessage(input) ?? parseMonitorsClientMessage(input) ?? parseIntegrationsClientMessage(input) ?? parseAgentsClientMessage(input) ?? parseNotificationsClientMessage(input) ?? parseComputersClientMessage(input) ?? parseRealtimeClientMessage(input) ?? parseMeetingsClientMessage(input) ?? invalid(`unsupported message type: ${input.type}`);
  }
}

/** Validate an untrusted Gateway payload before it enters browser state. */
export function parseServerMessage(input: unknown): ServerMessageValidationResult {
  if (!isRecord(input)) {
    return invalidServer("message must be a JSON object");
  }
  if (typeof input.type !== "string" || input.type.length === 0) {
    return invalidServer("type must be a non-empty string");
  }

  if (input.type === WS_EVENTS.SESSION_START) {
    if (!isNonEmptyString(input.sessionId) || input.status !== "ready") {
      return invalidServer("session.start requires sessionId and ready status");
    }
    return validServer({
      type: WS_EVENTS.SESSION_START,
      sessionId: input.sessionId,
      status: "ready"
    });
  }

  if (input.type === WS_EVENTS.LLM_DELTA) {
    if (!isNonEmptyString(input.requestId) || typeof input.delta !== "string") {
      return invalidServer("llm.delta requires requestId and string delta");
    }
    return validServer({
      type: WS_EVENTS.LLM_DELTA,
      requestId: input.requestId,
      delta: input.delta
    });
  }

  if (input.type === WS_EVENTS.LLM_DONE) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isEnum(input.reason, ["stop", "interrupted", "error", "ignored"] as const)
    ) {
      return invalidServer("llm.done requires requestId and a valid reason");
    }
    return validServer({
      type: WS_EVENTS.LLM_DONE,
      requestId: input.requestId,
      reason: input.reason
    });
  }

  if (input.type === WS_EVENTS.TRANSCRIPT_PARTIAL) {
    if (
      !isNonEmptyString(input.requestId) ||
      typeof input.text !== "string" ||
      !isNonNegativeInteger(input.sequence) ||
      !isOptionalBoolean(input.isStable)
    ) {
      return invalidServer(
        "transcript.partial requires requestId, text, sequence, and optional isStable"
      );
    }
    return validServer({
      type: WS_EVENTS.TRANSCRIPT_PARTIAL,
      requestId: input.requestId,
      text: input.text,
      sequence: input.sequence,
      ...(input.isStable === undefined ? {} : { isStable: input.isStable })
    });
  }

  if (input.type === WS_EVENTS.TRANSCRIPT_FINAL) {
    if (!isNonEmptyString(input.requestId) || typeof input.text !== "string") {
      return invalidServer("transcript.final requires requestId and string text");
    }
    return validServer({
      type: WS_EVENTS.TRANSCRIPT_FINAL,
      requestId: input.requestId,
      text: input.text
    });
  }

  if (input.type === WS_EVENTS.TTS_START) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isOptionalNonEmptyString(input.voice) ||
      !isNonEmptyString(input.format) ||
      !isNonEmptyString(input.mimeType)
    ) {
      return invalidServer(
        "tts.start requires requestId, format, mimeType, and optional voice"
      );
    }
    return validServer({
      type: WS_EVENTS.TTS_START,
      requestId: input.requestId,
      format: input.format,
      mimeType: input.mimeType,
      ...(input.voice === undefined ? {} : { voice: input.voice })
    });
  }

  if (input.type === WS_EVENTS.TTS_CHUNK) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isNonNegativeInteger(input.sequence) ||
      typeof input.chunk !== "string" ||
      !isNonEmptyString(input.mimeType) ||
      (input.segmentIndex !== undefined &&
        !isNonNegativeInteger(input.segmentIndex)) ||
      !isOptionalBoolean(input.isFinal)
    ) {
      return invalidServer(
        "tts.chunk requires requestId, sequence, chunk, mimeType, and valid optional fields"
      );
    }
    return validServer({
      type: WS_EVENTS.TTS_CHUNK,
      requestId: input.requestId,
      sequence: input.sequence,
      chunk: input.chunk,
      mimeType: input.mimeType,
      ...(input.segmentIndex === undefined
        ? {}
        : { segmentIndex: input.segmentIndex }),
      ...(input.isFinal === undefined ? {} : { isFinal: input.isFinal })
    });
  }

  if (input.type === WS_EVENTS.TTS_END) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isEnum(input.reason, ["stop", "interrupted", "error"] as const)
    ) {
      return invalidServer("tts.end requires requestId and a valid reason");
    }
    return validServer({
      type: WS_EVENTS.TTS_END,
      requestId: input.requestId,
      reason: input.reason
    });
  }

  if (input.type === WS_EVENTS.TRANSCRIPT_UPDATE) {
    if (!isNonEmptyString(input.requestId) || typeof input.text !== "string") {
      return invalidServer("transcript.update requires requestId and text");
    }
    return validServer({
      type: WS_EVENTS.TRANSCRIPT_UPDATE,
      requestId: input.requestId,
      text: input.text
    });
  }

  const structural: Record<string, (value: Record<string, unknown>) => boolean> = {
    [WS_EVENTS.TOOL_STARTED]: (v) => isNonEmptyString(v.requestId) && isNonEmptyString(v.callId) && isNonEmptyString(v.toolName) && typeof v.title === "string",
    [WS_EVENTS.TOOL_FINISHED]: (v) => isNonEmptyString(v.requestId) && isNonEmptyString(v.callId) && isEnum(v.status, ["ok", "error", "declined"] as const),
    [WS_EVENTS.APPROVAL_REQUEST]: (v) => isRecord(v.approval) && isNonEmptyString(v.approval.id) && isNonEmptyString(v.approval.toolName) && typeof v.approval.summary === "string",
    [WS_EVENTS.APPROVAL_RESOLVED]: (v) => isNonEmptyString(v.id) && isEnum(v.status, ["approved", "declined", "expired"] as const),
    [WS_EVENTS.USAGE_UPDATE]: (v) => isRecord(v.usage) && isFiniteNumber(v.usage.todayUsd) && isFiniteNumber(v.usage.monthUsd),
    [WS_EVENTS.BUDGET_BLOCKED]: (v) => isEnum(v.scope, ["daily", "monthly", "routine_run", "routine_daily", "policy"] as const) && typeof v.message === "string",
    [WS_EVENTS.CONVERSATIONS_LIST]: (v) => Array.isArray(v.items),
    [WS_EVENTS.CONVERSATION_STATE]: (v) => isNonEmptyString(v.conversationId) && Array.isArray(v.messages)
  };
  const check = structural[input.type];
  if (check) {
    return check(input) ? validServer(input as unknown as ServerMessage) : invalidServer(`invalid ${input.type} message`);
  }

  if (input.type === WS_EVENTS.TURN_MERGED) {
    if (!isNonEmptyString(input.requestId) || !isNonEmptyString(input.mergedRequestId)) {
      return invalidServer("turn.merged requires requestId and mergedRequestId");
    }
    return validServer({
      type: WS_EVENTS.TURN_MERGED,
      requestId: input.requestId,
      mergedRequestId: input.mergedRequestId
    });
  }

  if (input.type === WS_EVENTS.BRAIN_START) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isNonEmptyString(input.parentRequestId) ||
      typeof input.task !== "string" ||
      !isNonEmptyString(input.model)
    ) {
      return invalidServer("brain.start requires requestId, parentRequestId, task, model");
    }
    return validServer({
      type: WS_EVENTS.BRAIN_START,
      requestId: input.requestId,
      parentRequestId: input.parentRequestId,
      task: input.task,
      model: input.model
    });
  }

  if (input.type === WS_EVENTS.BRAIN_DELTA) {
    if (!isNonEmptyString(input.requestId) || typeof input.delta !== "string") {
      return invalidServer("brain.delta requires requestId and string delta");
    }
    return validServer({
      type: WS_EVENTS.BRAIN_DELTA,
      requestId: input.requestId,
      delta: input.delta
    });
  }

  if (input.type === WS_EVENTS.BRAIN_DONE) {
    if (
      !isNonEmptyString(input.requestId) ||
      !isEnum(input.reason, ["stop", "interrupted", "error"] as const)
    ) {
      return invalidServer("brain.done requires requestId and a valid reason");
    }
    return validServer({
      type: WS_EVENTS.BRAIN_DONE,
      requestId: input.requestId,
      reason: input.reason
    });
  }

  if (input.type === WS_EVENTS.UI_DELTA) {
    if (!isNonEmptyString(input.requestId) || typeof input.delta !== "string") {
      return invalidServer("ui.delta requires requestId and string delta");
    }
    return validServer({
      type: WS_EVENTS.UI_DELTA,
      requestId: input.requestId,
      delta: input.delta
    });
  }

  if (input.type === WS_EVENTS.SESSION_CONFIG) {
    const parsedSettings = parseSettingsPatch(input.settings);
    const settings = parsedSettings.success ? parsedSettings.data : undefined;
    if (
      !settings ||
      !isNonEmptyString(settings.llmModel) ||
      !isNonEmptyString(settings.sttModel) ||
      typeof settings.genUi !== "boolean" ||
      typeof settings.speak !== "boolean"
    ) {
      return invalidServer("session.config requires complete settings");
    }
    const catalog = parseCatalog(input.catalog);
    if (!catalog.success) {
      return invalidServer("session.config requires a model catalog");
    }
    const caps = input.capabilities;
    if (
      !isRecord(caps) ||
      !isNonEmptyString(caps.provider) ||
      typeof caps.genUi !== "boolean" ||
      typeof caps.tts !== "boolean" ||
      typeof caps.realtimeStt !== "boolean"
    ) {
      return invalidServer("session.config requires capabilities");
    }
    return validServer({
      type: WS_EVENTS.SESSION_CONFIG,
      catalog: catalog.data,
      settings: settings as SessionSettings,
      capabilities: {
        provider: caps.provider,
        genUi: caps.genUi,
        tts: caps.tts,
        realtimeStt: caps.realtimeStt,
        ...(isRealtimeCapability(caps.realtime) ? { realtime: caps.realtime } : {})
      }
    });
  }

  if (input.type === "error") {
    if (
      !isOptionalNonEmptyString(input.requestId) ||
      !isNonEmptyString(input.message)
    ) {
      return invalidServer("error requires message and optional requestId");
    }
    return validServer({
      type: "error",
      message: input.message,
      ...(isEnum(input.scope, ["tts", "stt", "llm"] as const)
        ? { scope: input.scope }
        : {}),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId })
    });
  }

  return parseConnectionsServerMessage(input) ?? parseRoutinesServerMessage(input) ?? parseSecretsServerMessage(input) ?? parseLicenseServerMessage(input) ?? parseIdentityServerMessage(input) ?? parseMonitorsServerMessage(input) ?? parseIntegrationsServerMessage(input) ?? parseAgentsServerMessage(input) ?? parseNotificationsServerMessage(input) ?? parseComputersServerMessage(input) ?? parseRealtimeServerMessage(input) ?? parseMeetingsServerMessage(input) ?? invalidServer(`unsupported message type: ${input.type}`);
}

const MAX_MODEL_ID_LENGTH = 200;

function parseSettingsPatch(
  input: unknown
): ParseResult<Partial<SessionSettings>> {
  if (!isRecord(input)) return fail("settings must be an object");
  const out: Partial<SessionSettings> = {};
  for (const key of ["voiceModel", "llmModel", "sttModel", "ttsModel", "ttsVoice"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!isNonEmptyString(value) || value.length > MAX_MODEL_ID_LENGTH) {
      return fail(`${key} must be a non-empty string`);
    }
    out[key] = value;
  }
  for (const key of ["genUi", "speak"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return fail(`${key} must be a boolean`);
    out[key] = value;
  }
  return ok(out);
}

function parseModelOptions(input: unknown): ParseResult<TtsModelOption[]> {
  if (!Array.isArray(input)) return fail("model options must be an array");
  const out: TtsModelOption[] = [];
  for (const item of input) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.label)) {
      return fail("each model option needs an id and a label");
    }
    out.push({
      id: item.id,
      label: item.label,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(Array.isArray(item.voices)
        ? { voices: item.voices.filter((voice): voice is string => typeof voice === "string") }
        : {}),
      ...(typeof item.defaultVoice === "string" ? { defaultVoice: item.defaultVoice } : {}),
      ...(typeof item.emotionTags === "boolean" ? { emotionTags: item.emotionTags } : {}),
      ...(isFiniteNumber(item.costPer100Turns) ? { costPer100Turns: item.costPer100Turns } : {}),
      ...(isFiniteNumber(item.latencyMs) ? { latencyMs: item.latencyMs } : {}),
      ...(isFiniteNumber(item.elo) ? { elo: item.elo } : {})
    });
  }
  return ok(out);
}

function parseCatalog(input: unknown): ParseResult<ModelCatalog> {
  if (!isRecord(input)) return fail("catalog must be an object");
  const llm = parseModelOptions(input.llm);
  if (!llm.success) return fail(`catalog.llm: ${llm.error}`);
  const stt = parseModelOptions(input.stt);
  if (!stt.success) return fail(`catalog.stt: ${stt.error}`);
  const tts = parseModelOptions(input.tts);
  if (!tts.success) return fail(`catalog.tts: ${tts.error}`);
  const voice = input.voice === undefined ? undefined : parseModelOptions(input.voice);
  if (voice && !voice.success) return fail(`catalog.voice: ${voice.error}`);
  const presets: ModelPreset[] = [];
  if (Array.isArray(input.presets)) {
    for (const preset of input.presets) {
      if (!isRecord(preset) || !isNonEmptyString(preset.id) || !isNonEmptyString(preset.label)) continue;
      const settings = parseSettingsPatch(preset.settings);
      if (!settings.success) continue;
      presets.push({
        id: preset.id,
        label: preset.label,
        settings: settings.data,
        ...(isFiniteNumber(preset.costPer100Turns) ? { costPer100Turns: preset.costPer100Turns } : {}),
        ...(isFiniteNumber(preset.costPer100Messages) ? { costPer100Messages: preset.costPer100Messages } : {})
      });
    }
  }
  return ok({
    ...(voice ? { voice: voice.data } : {}),
    llm: llm.data,
    stt: stt.data,
    tts: tts.data,
    ...(presets.length ? { presets } : {})
  });
}

function valid(data: ClientMessage): ClientMessageValidationResult {
  return { success: true, data };
}

function invalid(error: string): ClientMessageValidationResult {
  return { success: false, error };
}

function validServer(data: ServerMessage): ServerMessageValidationResult {
  return { success: true, data };
}

function invalidServer(error: string): ServerMessageValidationResult {
  return { success: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isEnum<const T extends readonly string[]>(
  value: unknown,
  choices: T
): value is T[number] {
  return typeof value === "string" && choices.includes(value);
}

function isOptionalEnum<const T extends readonly string[]>(
  value: unknown,
  choices: T
): value is T[number] | undefined {
  return value === undefined || isEnum(value, choices);
}

export function createRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/* ── Connections (wave 2) ── */
/*
 * The Connections screen: tools grouped by source (built-in / each MCP
 * server), per-tool and per-server switches, and UI-managed MCP servers.
 * Secret env/header values never travel back to the browser in full: views
 * carry masked values ("••••last4"); a `null` value in a save means "keep
 * the stored value".
 */

export const CONNECTIONS_EVENTS = {
  REQUEST: "connections.request",
  STATE: "connections.state",
  TOOL_TOGGLE: "connections.tool_toggle",
  SERVER_TOGGLE: "connections.server_toggle",
  SERVER_SAVE: "connections.server_save",
  SERVER_REMOVE: "connections.server_remove",
  SERVER_RECONNECT: "connections.server_reconnect",
  SERVER_TEST: "connections.server_test",
  RESULT: "connections.result",
  TEST_RESULT: "connections.test_result"
} as const;

export const CONNECTION_SERVER_NAME = /^[a-zA-Z0-9_-]{1,32}$/;
const CONNECTION_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONNECTION_HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const CONNECTION_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CONNECTION_VALUE = 8_000;
const MAX_CONNECTION_ENTRIES = 64;

export type ConnectionServerStatus = "connected" | "connecting" | "failed" | "disabled";

export interface ConnectionToolView {
  name: string;
  title: string;
  description: string;
  /** "write" tools need the user's approval before they run. */
  effect: "read" | "write";
  enabled: boolean;
}

export interface ConnectionServerView {
  name: string;
  /** "file": from mcp.config.json (read-only here); "ui": added in the app. */
  origin: "file" | "ui";
  transport: "stdio" | "http";
  status: ConnectionServerStatus;
  error?: string;
  enabled: boolean;
  toolCount: number;
  tools: ConnectionToolView[];
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  /** Values are masked, except ${secret:NAME} references (not secrets). */
  env?: Record<string, string>;
  /** Values are masked, except ${secret:NAME} references (not secrets). */
  headers?: Record<string, string>;
  catalogId?: string;
}

export interface ConnectionCatalogField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  /** Header values: text put before what the user types (e.g. "Bearer "). */
  valuePrefix?: string;
}

export interface ConnectionCatalogEntry {
  id: string;
  /** Suggested server name. */
  name: string;
  title: string;
  description: string;
  category: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  argsHint?: string;
  url?: string;
  env?: ConnectionCatalogField[];
  headers?: ConnectionCatalogField[];
  docsUrl: string;
  maintainer: string;
  status: "official" | "archived" | "community";
  note?: string;
}

export interface ConnectionsState {
  builtin: ConnectionToolView[];
  servers: ConnectionServerView[];
  catalog: ConnectionCatalogEntry[];
  /** SIBYL_ALLOW_STDIO_MCP: local (stdio) servers may be added from the app. */
  allowStdio: boolean;
  configPath?: string;
  configError?: string;
}

/** A server as the form sends it; env/header values of `null` keep the stored value. */
export type ConnectionServerInput =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string | null>;
      cwd?: string;
      catalogId?: string;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers: Record<string, string | null>;
      catalogId?: string;
    };

export interface ConnectionsRequestMessage {
  type: typeof CONNECTIONS_EVENTS.REQUEST;
}
export interface ConnectionsToolToggleMessage {
  type: typeof CONNECTIONS_EVENTS.TOOL_TOGGLE;
  name: string;
  enabled: boolean;
}
export interface ConnectionsServerToggleMessage {
  type: typeof CONNECTIONS_EVENTS.SERVER_TOGGLE;
  /** "builtin" flips every built-in tool; "server" one MCP server. */
  scope: "builtin" | "server";
  name?: string;
  enabled: boolean;
}
export interface ConnectionsServerSaveMessage {
  type: typeof CONNECTIONS_EVENTS.SERVER_SAVE;
  requestId: string;
  /** Name of the server being edited (absent when adding). */
  original?: string;
  server: ConnectionServerInput;
}
export interface ConnectionsServerRemoveMessage {
  type: typeof CONNECTIONS_EVENTS.SERVER_REMOVE;
  requestId: string;
  name: string;
}
export interface ConnectionsServerReconnectMessage {
  type: typeof CONNECTIONS_EVENTS.SERVER_RECONNECT;
  requestId: string;
  name: string;
}
export interface ConnectionsServerTestMessage {
  type: typeof CONNECTIONS_EVENTS.SERVER_TEST;
  requestId: string;
  /** Test a saved server by name, or a draft from the form. */
  name?: string;
  server?: ConnectionServerInput;
  /** For drafts that edit a saved server: whose stored secrets `null` refers to. */
  original?: string;
}

export type ConnectionsClientMessage =
  | ConnectionsRequestMessage
  | ConnectionsToolToggleMessage
  | ConnectionsServerToggleMessage
  | ConnectionsServerSaveMessage
  | ConnectionsServerRemoveMessage
  | ConnectionsServerReconnectMessage
  | ConnectionsServerTestMessage;

export interface ConnectionsStateMessage extends ConnectionsState {
  type: typeof CONNECTIONS_EVENTS.STATE;
}
export interface ConnectionsResultMessage {
  type: typeof CONNECTIONS_EVENTS.RESULT;
  requestId: string;
  ok: boolean;
  error?: string;
}
export interface ConnectionsTestResultMessage {
  type: typeof CONNECTIONS_EVENTS.TEST_RESULT;
  requestId: string;
  ok: boolean;
  toolCount?: number;
  tools?: string[];
  error?: string;
  ms?: number;
}

export type ConnectionsServerMessage =
  | ConnectionsStateMessage
  | ConnectionsResultMessage
  | ConnectionsTestResultMessage;

const CONNECTIONS_CLIENT_TYPES: ReadonlySet<string> = new Set([
  CONNECTIONS_EVENTS.REQUEST,
  CONNECTIONS_EVENTS.TOOL_TOGGLE,
  CONNECTIONS_EVENTS.SERVER_TOGGLE,
  CONNECTIONS_EVENTS.SERVER_SAVE,
  CONNECTIONS_EVENTS.SERVER_REMOVE,
  CONNECTIONS_EVENTS.SERVER_RECONNECT,
  CONNECTIONS_EVENTS.SERVER_TEST
]);

export function isConnectionsClientMessage(message: { type: string }): message is ConnectionsClientMessage {
  return CONNECTIONS_CLIENT_TYPES.has(message.type);
}

export function isConnectionsServerMessage(message: { type: string }): message is ConnectionsServerMessage {
  return (
    message.type === CONNECTIONS_EVENTS.STATE ||
    message.type === CONNECTIONS_EVENTS.RESULT ||
    message.type === CONNECTIONS_EVENTS.TEST_RESULT
  );
}

/** Strict parser for Connections client messages; undefined when the type isn't ours. */
export function parseConnectionsClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  const type = input.type;
  if (typeof type !== "string" || !CONNECTIONS_CLIENT_TYPES.has(type)) return undefined;
  const requestId = (): string | undefined =>
    isNonEmptyString(input.requestId) && input.requestId.length <= 100 ? input.requestId : undefined;
  const serverName = (value: unknown): value is string => typeof value === "string" && CONNECTION_SERVER_NAME.test(value);

  switch (type) {
    case CONNECTIONS_EVENTS.REQUEST:
      return valid({ type: CONNECTIONS_EVENTS.REQUEST });
    case CONNECTIONS_EVENTS.TOOL_TOGGLE:
      if (typeof input.name !== "string" || !CONNECTION_TOOL_NAME.test(input.name)) return invalid(`${type} name must be a tool name`);
      if (typeof input.enabled !== "boolean") return invalid(`${type} enabled must be a boolean`);
      return valid({ type: CONNECTIONS_EVENTS.TOOL_TOGGLE, name: input.name, enabled: input.enabled });
    case CONNECTIONS_EVENTS.SERVER_TOGGLE:
      if (!isEnum(input.scope, ["builtin", "server"] as const)) return invalid(`${type} scope must be "builtin" or "server"`);
      if (typeof input.enabled !== "boolean") return invalid(`${type} enabled must be a boolean`);
      if (input.scope === "server" && !serverName(input.name)) return invalid(`${type} name must be a server name`);
      return valid({
        type: CONNECTIONS_EVENTS.SERVER_TOGGLE,
        scope: input.scope,
        enabled: input.enabled,
        ...(input.scope === "server" ? { name: input.name as string } : {})
      });
    case CONNECTIONS_EVENTS.SERVER_SAVE: {
      const id = requestId();
      if (!id) return invalid(`${type} requestId is required`);
      if (input.original !== undefined && !serverName(input.original)) return invalid(`${type} original must be a server name`);
      const server = parseConnectionServerInput(input.server);
      if (!server.success) return invalid(`${type} ${server.error}`);
      return valid({
        type: CONNECTIONS_EVENTS.SERVER_SAVE,
        requestId: id,
        server: server.data,
        ...(input.original !== undefined ? { original: input.original as string } : {})
      });
    }
    case CONNECTIONS_EVENTS.SERVER_REMOVE:
    case CONNECTIONS_EVENTS.SERVER_RECONNECT: {
      const id = requestId();
      if (!id) return invalid(`${type} requestId is required`);
      if (!serverName(input.name)) return invalid(`${type} name must be a server name`);
      return valid({ type, requestId: id, name: input.name });
    }
    case CONNECTIONS_EVENTS.SERVER_TEST: {
      const id = requestId();
      if (!id) return invalid(`${type} requestId is required`);
      if (input.name !== undefined && !serverName(input.name)) return invalid(`${type} name must be a server name`);
      if (input.original !== undefined && !serverName(input.original)) return invalid(`${type} original must be a server name`);
      let server: ConnectionServerInput | undefined;
      if (input.server !== undefined) {
        const parsed = parseConnectionServerInput(input.server);
        if (!parsed.success) return invalid(`${type} ${parsed.error}`);
        server = parsed.data;
      }
      if (!server && input.name === undefined) return invalid(`${type} needs a name or a server`);
      return valid({
        type: CONNECTIONS_EVENTS.SERVER_TEST,
        requestId: id,
        ...(input.name !== undefined ? { name: input.name as string } : {}),
        ...(input.original !== undefined ? { original: input.original as string } : {}),
        ...(server ? { server } : {})
      });
    }
  }
  return undefined;
}

/** Validate a server from the form. */
export function parseConnectionServerInput(input: unknown): ParseResult<ConnectionServerInput> {
  if (!isRecord(input)) return fail("server must be an object");
  if (typeof input.name !== "string" || !CONNECTION_SERVER_NAME.test(input.name)) {
    return fail("server name must be 1-32 letters, digits, _ or -");
  }
  const catalogId =
    typeof input.catalogId === "string" && /^[a-z0-9-]{1,64}$/.test(input.catalogId) ? { catalogId: input.catalogId } : {};
  if (input.transport === "stdio") {
    if (!isNonEmptyString(input.command) || input.command.trim().length === 0 || input.command.length > 500) {
      return fail("command is required (≤ 500 characters)");
    }
    if (!Array.isArray(input.args) || input.args.length > MAX_CONNECTION_ENTRIES) return fail("args must be a list of up to 64 strings");
    if (!input.args.every((arg) => typeof arg === "string" && arg.length <= 2_000)) return fail("args must be strings (≤ 2000 characters)");
    const env = parseSecretRecord(input.env, CONNECTION_ENV_KEY, "env");
    if (!env.success) return env;
    if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length > 1_000)) return fail("cwd must be a string");
    return ok({
      name: input.name,
      transport: "stdio",
      command: input.command.trim(),
      args: input.args as string[],
      env: env.data,
      ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd.trim() } : {}),
      ...catalogId
    });
  }
  if (input.transport === "http") {
    if (!isNonEmptyString(input.url) || input.url.length > 2_000) return fail("url is required");
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      return fail("url is not a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return fail("url must start with http:// or https://");
    const headers = parseSecretRecord(input.headers, CONNECTION_HEADER_KEY, "headers");
    if (!headers.success) return headers;
    return ok({ name: input.name, transport: "http", url: input.url.trim(), headers: headers.data, ...catalogId });
  }
  return fail('transport must be "stdio" or "http"');
}

function parseSecretRecord(value: unknown, keyPattern: RegExp, label: string): ParseResult<Record<string, string | null>> {
  if (value === undefined) return ok({});
  if (!isRecord(value)) return fail(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > MAX_CONNECTION_ENTRIES) return fail(`${label} has too many entries`);
  const out: Record<string, string | null> = {};
  for (const [key, item] of entries) {
    if (!keyPattern.test(key)) return fail(`${label} key "${key.slice(0, 40)}" is not allowed`);
    if (item !== null && (typeof item !== "string" || item.length > MAX_CONNECTION_VALUE)) {
      return fail(`${label}.${key} must be a string or null`);
    }
    out[key] = item;
  }
  return ok(out);
}

function isToolViewList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (tool) =>
        isRecord(tool) &&
        isNonEmptyString(tool.name) &&
        typeof tool.title === "string" &&
        typeof tool.description === "string" &&
        isEnum(tool.effect, ["read", "write"] as const) &&
        typeof tool.enabled === "boolean"
    )
  );
}

function isStringRecord(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.values(value).every((item) => typeof item === "string"));
}

/** Strict parser for Connections server messages; undefined when the type isn't ours. */
export function parseConnectionsServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  switch (input.type) {
    case CONNECTIONS_EVENTS.STATE: {
      const serversOk =
        Array.isArray(input.servers) &&
        input.servers.every(
          (server) =>
            isRecord(server) &&
            isNonEmptyString(server.name) &&
            isEnum(server.origin, ["file", "ui"] as const) &&
            isEnum(server.transport, ["stdio", "http"] as const) &&
            isEnum(server.status, ["connected", "connecting", "failed", "disabled"] as const) &&
            typeof server.enabled === "boolean" &&
            isNonNegativeInteger(server.toolCount) &&
            isToolViewList(server.tools) &&
            isOptionalString(server.error) &&
            isStringRecord(server.env) &&
            isStringRecord(server.headers) &&
            (server.args === undefined || (Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")))
        );
      const catalogOk =
        Array.isArray(input.catalog) &&
        input.catalog.every(
          (entry) =>
            isRecord(entry) &&
            isNonEmptyString(entry.id) &&
            isNonEmptyString(entry.title) &&
            isEnum(entry.transport, ["stdio", "http"] as const)
        );
      if (!isToolViewList(input.builtin) || !serversOk || !catalogOk || typeof input.allowStdio !== "boolean") {
        return invalidServer(`invalid ${input.type} message`);
      }
      return validServer(input as unknown as ConnectionsStateMessage);
    }
    case CONNECTIONS_EVENTS.RESULT:
      if (!isNonEmptyString(input.requestId) || typeof input.ok !== "boolean" || !isOptionalString(input.error)) {
        return invalidServer(`invalid ${input.type} message`);
      }
      return validServer({
        type: CONNECTIONS_EVENTS.RESULT,
        requestId: input.requestId,
        ok: input.ok,
        ...(typeof input.error === "string" ? { error: input.error } : {})
      });
    case CONNECTIONS_EVENTS.TEST_RESULT:
      if (
        !isNonEmptyString(input.requestId) ||
        typeof input.ok !== "boolean" ||
        !isOptionalString(input.error) ||
        !(input.toolCount === undefined || isNonNegativeInteger(input.toolCount)) ||
        !(input.tools === undefined || (Array.isArray(input.tools) && input.tools.every((tool) => typeof tool === "string"))) ||
        !isOptionalFiniteNumber(input.ms)
      ) {
        return invalidServer(`invalid ${input.type} message`);
      }
      return validServer(input as unknown as ConnectionsTestResultMessage);
  }
  return undefined;
}

/* ── Memory & uploads (wave 2) ── */

/** A file uploaded with POST /api/uploads and attached to a user message. */
export interface AttachmentRef {
  /** Upload id from the gateway (`up_…`). */
  id: string;
  /** Display name. */
  name: string;
  mime: string;
  /** Bytes. */
  size?: number;
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Strict validation of `user.text` attachments (undefined when absent). */
export function parseAttachments(
  value: unknown
): ParseResult<AttachmentRef[] | undefined> {
  if (value === undefined) return { success: true, data: undefined };
  if (!Array.isArray(value)) return { success: false, error: "attachments must be an array" };
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { success: false, error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message` };
  }
  const out: AttachmentRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { success: false, error: "each attachment must be an object" };
    if (typeof item.id !== "string" || !ATTACHMENT_ID.test(item.id)) return { success: false, error: "attachment id is invalid" };
    if (!isNonEmptyString(item.name) || item.name.length > 255) return { success: false, error: "attachment name must be 1-255 characters" };
    if (!isNonEmptyString(item.mime) || item.mime.length > 127) return { success: false, error: "attachment mime must be 1-127 characters" };
    if (item.size !== undefined && !isNonNegativeInteger(item.size)) return { success: false, error: "attachment size must be a non-negative integer" };
    out.push({ id: item.id, name: item.name, mime: item.mime, ...(item.size === undefined ? {} : { size: item.size }) });
  }
  return { success: true, data: out };
}

/* ── Routines & inbox (wave 2) ── */

export const ROUTINE_EVENTS = {
  /** Client → gateway: the browser's IANA time zone (default for new routines). */
  ROUTINES_CONTEXT: "routines.context",
  ROUTINES_REQUEST: "routines.request",
  ROUTINES_LIST: "routines.list",
  ROUTINE_UPDATE: "routine.update",
  ROUTINE_RUN_NOW: "routine.run_now",
  ROUTINE_DELETE: "routine.delete",
  /** Pending approvals across chat and routines (decide with approval.decision). */
  INBOX_REQUEST: "inbox.request",
  INBOX_LIST: "inbox.list"
} as const;

export type RoutineRunStatusView = "running" | "awaiting_approval" | "succeeded" | "failed" | "interrupted" | "budget_blocked";

export interface RoutineRunView {
  id: string;
  status: RoutineRunStatusView;
  startedAt: number;
  finishedAt?: number;
  costUsd: number;
  summary?: string;
  error?: string;
}

export interface RoutineView {
  id: string;
  name: string;
  instruction: string;
  /** 5-field cron in `timezone`. */
  cron: string;
  timezone: string;
  /** The schedule in plain words, e.g. "every weekday at 08:00 (Europe/Berlin)". */
  schedule: string;
  enabled: boolean;
  conversationId?: string;
  maxRunUsd?: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRun?: RoutineRunView;
  /** Runs as this agent (v0.4). */
  agentId?: string;
  /** Workspace the routine runs in (v0.4). */
  workspaceId?: string;
  /** Creator's user id ("local"/"token" for the owner); runs act with their current rights. */
  createdBy?: string;
}

export interface RoutinePatch {
  name?: string;
  instruction?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  /** null clears the per-routine cap (SIBYL_BUDGET_ROUTINE_RUN_USD applies). */
  maxRunUsd?: number | null;
  /** Run as this agent (v0.4); null: run as Sibyl. */
  agentId?: string | null;
}

export interface RoutinesContextMessage {
  type: typeof ROUTINE_EVENTS.ROUTINES_CONTEXT;
  timezone: string;
}

export interface RoutinesRequestMessage {
  type: typeof ROUTINE_EVENTS.ROUTINES_REQUEST;
}

export interface RoutineUpdateMessage {
  type: typeof ROUTINE_EVENTS.ROUTINE_UPDATE;
  routineId: string;
  patch: RoutinePatch;
}

export interface RoutineRunNowMessage {
  type: typeof ROUTINE_EVENTS.ROUTINE_RUN_NOW;
  routineId: string;
}

export interface RoutineDeleteMessage {
  type: typeof ROUTINE_EVENTS.ROUTINE_DELETE;
  routineId: string;
}

export interface InboxRequestMessage {
  type: typeof ROUTINE_EVENTS.INBOX_REQUEST;
}

export interface RoutinesListMessage {
  type: typeof ROUTINE_EVENTS.ROUTINES_LIST;
  items: RoutineView[];
}

export interface InboxListMessage {
  type: typeof ROUTINE_EVENTS.INBOX_LIST;
  items: ApprovalView[];
}

export type RoutinesClientMessage =
  | RoutinesContextMessage
  | RoutinesRequestMessage
  | RoutineUpdateMessage
  | RoutineRunNowMessage
  | RoutineDeleteMessage
  | InboxRequestMessage;

export type RoutinesServerMessage = RoutinesListMessage | InboxListMessage;

const ROUTINE_ID_MAX = 100;
const ROUTINE_RUN_STATUSES = ["running", "awaiting_approval", "succeeded", "failed", "interrupted", "budget_blocked"] as const;

function isRoutineId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= ROUTINE_ID_MAX;
}

/** Strict parser for a routine edit from the browser. */
export function parseRoutinePatch(input: unknown): ParseResult<RoutinePatch> {
  if (!isRecord(input)) return fail("patch must be an object");
  const out: RoutinePatch = {};
  for (const [key, max] of [["name", 120], ["instruction", 4_000], ["cron", 120], ["timezone", 64]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      return fail(`${key} must be a non-empty string up to ${max} characters`);
    }
    out[key] = value.trim();
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return fail("enabled must be a boolean");
    out.enabled = input.enabled;
  }
  if (input.maxRunUsd !== undefined) {
    if (input.maxRunUsd !== null && (!isFiniteNumber(input.maxRunUsd) || input.maxRunUsd <= 0 || input.maxRunUsd > 100)) {
      return fail("maxRunUsd must be a number above 0 and up to 100, or null");
    }
    out.maxRunUsd = input.maxRunUsd;
  }
  if (input.agentId !== undefined) {
    if (input.agentId !== null && !isAgentId(input.agentId)) return fail("agentId must be an agent id or null");
    out.agentId = input.agentId as string | null;
  }
  if (Object.keys(out).length === 0) return fail("patch must change something");
  return ok(out);
}

/** Client messages of this block (called from parseClientMessage). */
function parseRoutinesClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  switch (input.type) {
    case ROUTINE_EVENTS.ROUTINES_CONTEXT:
      if (!isNonEmptyString(input.timezone) || input.timezone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(input.timezone)) {
        return invalid("routines.context timezone must be an IANA time zone");
      }
      return valid({ type: ROUTINE_EVENTS.ROUTINES_CONTEXT, timezone: input.timezone });
    case ROUTINE_EVENTS.ROUTINES_REQUEST:
      return valid({ type: ROUTINE_EVENTS.ROUTINES_REQUEST });
    case ROUTINE_EVENTS.INBOX_REQUEST:
      return valid({ type: ROUTINE_EVENTS.INBOX_REQUEST });
    case ROUTINE_EVENTS.ROUTINE_UPDATE: {
      if (!isRoutineId(input.routineId)) return invalid("routine.update routineId must be a non-empty string");
      const patch = parseRoutinePatch(input.patch);
      if (!patch.success) return invalid(`routine.update ${patch.error}`);
      return valid({ type: ROUTINE_EVENTS.ROUTINE_UPDATE, routineId: input.routineId, patch: patch.data });
    }
    case ROUTINE_EVENTS.ROUTINE_RUN_NOW:
    case ROUTINE_EVENTS.ROUTINE_DELETE:
      if (!isRoutineId(input.routineId)) return invalid(`${input.type} routineId must be a non-empty string`);
      return valid({ type: input.type, routineId: input.routineId });
    default:
      return undefined;
  }
}

function isRoutineView(value: unknown): value is RoutineView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.name === "string" &&
    typeof value.instruction === "string" &&
    typeof value.cron === "string" &&
    typeof value.timezone === "string" &&
    typeof value.schedule === "string" &&
    typeof value.enabled === "boolean" &&
    isOptionalString(value.conversationId) &&
    isOptionalFiniteNumber(value.nextRunAt) &&
    isOptionalFiniteNumber(value.lastRunAt) &&
    isOptionalFiniteNumber(value.maxRunUsd) &&
    isOptionalString(value.agentId) &&
    isOptionalString(value.workspaceId) &&
    isOptionalString(value.createdBy) &&
    (value.lastRun === undefined ||
      (isRecord(value.lastRun) &&
        isNonEmptyString(value.lastRun.id) &&
        isEnum(value.lastRun.status, ROUTINE_RUN_STATUSES) &&
        isFiniteNumber(value.lastRun.startedAt) &&
        isOptionalFiniteNumber(value.lastRun.finishedAt) &&
        isFiniteNumber(value.lastRun.costUsd) &&
        isOptionalString(value.lastRun.summary) &&
        isOptionalString(value.lastRun.error)))
  );
}

function isApprovalViewValue(value: unknown): value is ApprovalView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.toolName) &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    isFiniteNumber(value.createdAt) &&
    isOptionalString(value.routineId) &&
    isOptionalString(value.conversationId) &&
    isOptionalFiniteNumber(value.expiresAt) &&
    (value.details === undefined ||
      (Array.isArray(value.details) &&
        value.details.every((d) => isRecord(d) && typeof d.label === "string" && typeof d.value === "string")))
  );
}

/** Server messages of this block (called from parseServerMessage). */
function parseRoutinesServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  switch (input.type) {
    case ROUTINE_EVENTS.ROUTINES_LIST:
      if (!Array.isArray(input.items) || !input.items.every(isRoutineView)) return invalidServer("invalid routines.list message");
      return validServer({ type: ROUTINE_EVENTS.ROUTINES_LIST, items: input.items });
    case ROUTINE_EVENTS.INBOX_LIST:
      if (!Array.isArray(input.items) || !input.items.every(isApprovalViewValue)) return invalidServer("invalid inbox.list message");
      return validServer({ type: ROUTINE_EVENTS.INBOX_LIST, items: input.items });
    default:
      return undefined;
  }
}

/* ── Secrets (wave 2) ── */
/*
 * Secrets the user stores for integrations (API keys, tokens). The browser
 * only ever sends a value (secret.provide / secret.update); the gateway never
 * sends one back — every server message below carries metadata only.
 */

export const SECRET_EVENTS = {
  /** Server → client: ask the user for a secret in a secure box. */
  REQUEST: "secret.request",
  /** Server → client: a prompt was saved, cancelled, expired or rejected. */
  RESOLVED: "secret.resolved",
  /** Client → server: the value typed into a SecretPrompt. */
  PROVIDE: "secret.provide",
  /** Client → server: the user dismissed a SecretPrompt. */
  CANCEL: "secret.cancel",
  /** Client → server: list stored secrets (answered with secrets.state). */
  LIST: "secrets.list",
  /** Server → client: metadata of every stored secret. */
  STATE: "secrets.state",
  /** Client → server: add a secret, replace its value, or edit hosts/description. */
  UPDATE: "secret.update",
  /** Client → server: delete a secret. */
  DELETE: "secret.delete"
} as const;

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SECRET_VALUE_MAX_CHARS = 8192;

export interface SecretMetaView {
  name: string;
  service: string;
  description: string;
  allowedHosts: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  /** False when the value can't be decrypted (the master key changed). */
  readable: boolean;
}

export interface SecretRequestView {
  id: string;
  /** Brain run (reply) the prompt belongs to. */
  runId: string;
  conversationId?: string;
  name: string;
  service: string;
  /** Why it's needed, written by the assistant. */
  description: string;
  /** Hosts the value will be sent to (the user may edit them). */
  allowedHosts: string[];
  howToGet?: string;
  /** https link to where the key is created. */
  docsUrl?: string;
  /** True when this replaces a stored value. */
  replace: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface SecretRequestMessage {
  type: typeof SECRET_EVENTS.REQUEST;
  request: SecretRequestView;
}

export interface SecretResolvedMessage {
  type: typeof SECRET_EVENTS.RESOLVED;
  id: string;
  name: string;
  /** "invalid": not saved, the prompt stays open and shows `message`. */
  status: "saved" | "cancelled" | "expired" | "invalid";
  allowedHosts?: string[];
  message?: string;
}

export interface SecretsStateMessage {
  type: typeof SECRET_EVENTS.STATE;
  secrets: SecretMetaView[];
  /** Set when the last secret.update / secret.delete failed. */
  error?: string;
}

export interface SecretProvideMessage {
  type: typeof SECRET_EVENTS.PROVIDE;
  id: string;
  value: string;
  /** The hosts as the user left them (defaults to the requested ones). */
  allowedHosts?: string[];
}

export interface SecretCancelMessage {
  type: typeof SECRET_EVENTS.CANCEL;
  id: string;
}

export interface SecretsListMessage {
  type: typeof SECRET_EVENTS.LIST;
}

export interface SecretUpdateMessage {
  type: typeof SECRET_EVENTS.UPDATE;
  name: string;
  /** New value; omit to keep the stored one. */
  value?: string;
  service?: string;
  description?: string;
  allowedHosts?: string[];
}

export interface SecretDeleteMessage {
  type: typeof SECRET_EVENTS.DELETE;
  name: string;
}

export type SecretsClientMessage =
  | SecretProvideMessage
  | SecretCancelMessage
  | SecretsListMessage
  | SecretUpdateMessage
  | SecretDeleteMessage;

export type SecretsServerMessage = SecretRequestMessage | SecretResolvedMessage | SecretsStateMessage;

/** Strict parser for the secrets client messages (undefined: not a secrets message). */
export function parseSecretsClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  // Error texts never include the value.
  switch (input.type) {
    case SECRET_EVENTS.PROVIDE: {
      if (!isShortId(input.id)) return invalid("secret.provide id must be a non-empty string");
      if (!isSecretValue(input.value)) return invalid(`secret.provide value must be 1–${SECRET_VALUE_MAX_CHARS} characters`);
      const hosts = parseHostList(input.allowedHosts);
      if (!hosts.success) return invalid("secret.provide allowedHosts must be 1–10 host strings");
      return valid({ type: SECRET_EVENTS.PROVIDE, id: input.id, value: input.value, ...(hosts.data ? { allowedHosts: hosts.data } : {}) });
    }
    case SECRET_EVENTS.CANCEL:
      if (!isShortId(input.id)) return invalid("secret.cancel id must be a non-empty string");
      return valid({ type: SECRET_EVENTS.CANCEL, id: input.id });
    case SECRET_EVENTS.LIST:
      return valid({ type: SECRET_EVENTS.LIST });
    case SECRET_EVENTS.UPDATE: {
      if (typeof input.name !== "string" || !SECRET_NAME_PATTERN.test(input.name)) {
        return invalid("secret.update name must be UPPER_SNAKE_CASE (≤ 64 characters)");
      }
      if (input.value !== undefined && !isSecretValue(input.value)) {
        return invalid(`secret.update value must be 1–${SECRET_VALUE_MAX_CHARS} characters`);
      }
      if (!isOptionalBoundedString(input.service, 80)) return invalid("secret.update service must be ≤ 80 characters");
      if (!isOptionalBoundedString(input.description, 500)) return invalid("secret.update description must be ≤ 500 characters");
      const hosts = parseHostList(input.allowedHosts);
      if (!hosts.success) return invalid("secret.update allowedHosts must be 1–10 host strings");
      return valid({
        type: SECRET_EVENTS.UPDATE,
        name: input.name,
        ...(input.value === undefined ? {} : { value: input.value as string }),
        ...(input.service === undefined ? {} : { service: input.service as string }),
        ...(input.description === undefined ? {} : { description: input.description as string }),
        ...(hosts.data ? { allowedHosts: hosts.data } : {})
      });
    }
    case SECRET_EVENTS.DELETE:
      if (typeof input.name !== "string" || !SECRET_NAME_PATTERN.test(input.name)) {
        return invalid("secret.delete name must be UPPER_SNAKE_CASE (≤ 64 characters)");
      }
      return valid({ type: SECRET_EVENTS.DELETE, name: input.name });
    default:
      return undefined;
  }
}

/** Strict parser for the secrets server messages (undefined: not a secrets message). */
export function parseSecretsServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  switch (input.type) {
    case SECRET_EVENTS.REQUEST: {
      const r = input.request;
      if (
        !isRecord(r) ||
        !isNonEmptyString(r.id) ||
        !isNonEmptyString(r.runId) ||
        typeof r.name !== "string" ||
        !SECRET_NAME_PATTERN.test(r.name) ||
        typeof r.service !== "string" ||
        typeof r.description !== "string" ||
        !isStringArray(r.allowedHosts) ||
        !isOptionalString(r.howToGet) ||
        !isOptionalString(r.docsUrl) ||
        (r.docsUrl !== undefined && !/^https:\/\//i.test(r.docsUrl as string)) ||
        typeof r.replace !== "boolean" ||
        !isFiniteNumber(r.createdAt) ||
        !isFiniteNumber(r.expiresAt)
      ) {
        return invalidServer("invalid secret.request message");
      }
      return validServer(input as unknown as SecretRequestMessage);
    }
    case SECRET_EVENTS.RESOLVED:
      if (
        !isNonEmptyString(input.id) ||
        typeof input.name !== "string" ||
        !isEnum(input.status, ["saved", "cancelled", "expired", "invalid"] as const) ||
        !isOptionalString(input.message) ||
        (input.allowedHosts !== undefined && !isStringArray(input.allowedHosts))
      ) {
        return invalidServer("invalid secret.resolved message");
      }
      return validServer(input as unknown as SecretResolvedMessage);
    case SECRET_EVENTS.STATE:
      if (
        !Array.isArray(input.secrets) ||
        !input.secrets.every(
          (s) => isRecord(s) && typeof s.name === "string" && typeof s.service === "string" && isStringArray(s.allowedHosts) && !("value" in s)
        ) ||
        !isOptionalString(input.error)
      ) {
        return invalidServer("invalid secrets.state message");
      }
      return validServer(input as unknown as SecretsStateMessage);
    default:
      return undefined;
  }
}

function isShortId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 100;
}

function isSecretValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= SECRET_VALUE_MAX_CHARS;
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** An optional host list (data is undefined when absent). */
function parseHostList(value: unknown): ParseResult<string[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isStringArray(value) || value.length === 0 || value.length > 10) return fail("allowedHosts must be 1–10 host strings");
  if (!value.every((host) => host.trim().length > 0 && host.length <= 253)) return fail("allowedHosts must be 1–10 host strings");
  return ok(value.map((host) => host.trim()));
}

/* ── Licence (v0.4) ── */
/*
 * Which edition is running and which enterprise features the licence key
 * enables. Sent once per session after session.config and again whenever the
 * key changes. Never carries the key itself.
 */

export const LICENSE_EVENTS = {
  /** Server → client: edition and enabled features. */
  STATE: "license.state"
} as const;

export interface LicenseStateMessage {
  type: typeof LICENSE_EVENTS.STATE;
  edition: "oss" | "enterprise";
  /** "none": no key; "expired"/"invalid": enterprise features are off. */
  status: "none" | "valid" | "expired" | "invalid";
  /** Enabled enterprise feature ids (empty in the open-source edition). */
  features: string[];
  licensee?: string;
  seats?: number;
  /** ISO 8601. */
  expiresAt?: string;
}

function parseLicenseServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  if (input.type !== LICENSE_EVENTS.STATE) return undefined;
  if (
    !isEnum(input.edition, ["oss", "enterprise"] as const) ||
    !isEnum(input.status, ["none", "valid", "expired", "invalid"] as const) ||
    !isStringArray(input.features) ||
    !isOptionalString(input.licensee) ||
    !isOptionalString(input.expiresAt) ||
    (input.seats !== undefined && !isFiniteNumber(input.seats))
  ) {
    return invalidServer("invalid license.state message");
  }
  return validServer({
    type: LICENSE_EVENTS.STATE,
    edition: input.edition,
    status: input.status,
    features: [...input.features],
    ...(typeof input.licensee === "string" ? { licensee: input.licensee } : {}),
    ...(typeof input.seats === "number" ? { seats: input.seats } : {}),
    ...(typeof input.expiresAt === "string" ? { expiresAt: input.expiresAt } : {})
  });
}

/* ── Identity & workspaces (v0.4) ── */

/**
 * Sign-in, workspaces and members. HTTP routes (all JSON, cookie session
 * `sibyl_session`, or `Authorization: Bearer <SIBYL_OWNER_TOKEN>`):
 *
 *   GET    /api/auth/me                         → AuthMeResponse
 *   POST   /api/auth/setup   {email,name,password} (first run only)
 *   POST   /api/auth/login   {email,password}
 *   POST   /api/auth/logout
 *   GET    /api/workspaces                      → { workspaces }
 *   POST   /api/workspaces   {name,icon?,instructions?}
 *   PATCH  /api/workspaces/:id {name?,icon?,instructions?}
 *   DELETE /api/workspaces/:id
 *   GET    /api/workspaces/:id/members          → { members }
 *   PATCH  /api/workspaces/:id/members/:userId {role}
 *   DELETE /api/workspaces/:id/members/:userId
 *   POST   /api/workspaces/:id/leave
 *   GET    /api/invites?workspaceId=            → { invites } (pending)
 *   POST   /api/invites      {workspaceId,role,email?} → { invite, url, emailed }
 *   DELETE /api/invites/:id
 *   GET    /api/invites/:token                  → InvitePreview (no sign-in)
 *   POST   /api/invites/:token/accept {name?,email?,password?}
 *
 * Other HTTP routes take the workspace from the `x-sibyl-workspace` header
 * (or `?workspaceId=`); the WebSocket switches with `session.workspace`.
 */
export const IDENTITY_EVENTS = {
  /** Client → gateway: switch this connection to another workspace. */
  SESSION_WORKSPACE: "session.workspace",
  /** Gateway → client: who is connected, which workspace, what they may do. */
  SESSION_IDENTITY: "session.identity"
} as const;

export type IdentityRole = "owner" | "admin" | "member" | "viewer";

export interface IdentityUserView {
  id: string;
  name: string;
  email: string;
  /** The face the person chose during onboarding (absent: none chosen yet). */
  avatar?: AgentAvatarView;
}

export interface WorkspaceView {
  id: string;
  name: string;
  icon?: string;
  instructions?: string;
  /** The workspace's own spending caps in USD (Settings → Workspace). */
  budget?: { dailyUsd?: number; monthlyUsd?: number };
  /** The caller's role in this workspace. */
  role: IdentityRole;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  /** Effective role in the workspace. */
  role: IdentityRole;
  /** Explicit workspace role, when there is one. */
  workspaceRole?: IdentityRole;
  orgRole?: IdentityRole;
  /** The role comes from the organization (org owner/admin), not the workspace. */
  inherited: boolean;
  /** The caller. */
  you?: boolean;
}

export interface InviteView {
  id: string;
  email?: string;
  workspaceId: string;
  role: IdentityRole;
  invitedByName: string;
  createdAt: number;
  expiresAt: number;
}

export interface InvitePreview {
  workspaceName: string;
  role: IdentityRole;
  email?: string;
  invitedByName: string;
  expiresAt: number;
  status: "pending" | "accepted" | "expired";
  /** An account with the invited email already exists (sign in to accept). */
  accountExists: boolean;
}

export interface AuthMeResponse {
  authenticated: boolean;
  /** local: no accounts yet (single owner); setup: owner account still to create; signin: accounts exist. */
  mode: "local" | "setup" | "signin";
  /** Where the web app should send the browser. */
  next?: "setup" | "login";
  setupAvailable: boolean;
  /** Setup needs SIBYL_OWNER_TOKEN (sent as a Bearer header). */
  ownerTokenRequired?: boolean;
  /** Invitations can be emailed (SIBYL_SMTP_URL is set). */
  smtp: boolean;
  /** How the caller is signed in. */
  principal?: "user" | "token" | "local";
  user: IdentityUserView | null;
  orgRole?: IdentityRole;
  /** The organization (Admin → Organization); signed-in callers only. */
  org?: OrgSummary;
  workspaces: WorkspaceView[];
  /** Permissions per workspace id. */
  permissions: Record<string, string[]>;
  /** Enterprise features enabled by the licence key (empty in the open-source edition). */
  features?: string[];
  /** Hosted Sibyl: many organizations; sign-up instead of first-run setup (see docs/hosting.md). */
  hosted?: boolean;
  /** Hosted: the organization this browser is signed in to (send its id as x-sibyl-org to finish a two-step sign-in). */
  organization?: { id: string; name: string };
}

export interface SessionWorkspaceMessage {
  type: typeof IDENTITY_EVENTS.SESSION_WORKSPACE;
  workspaceId: string;
}

export interface SessionIdentityMessage {
  type: typeof IDENTITY_EVENTS.SESSION_IDENTITY;
  workspaceId: string;
  role?: IdentityRole;
  permissions: string[];
  user: IdentityUserView | null;
  principal: "user" | "token" | "local";
}

export type IdentityClientMessage = SessionWorkspaceMessage;
export type IdentityServerMessage = SessionIdentityMessage;

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Strict parser for identity client messages (undefined: not ours). */
export function parseIdentityClientMessage(input: Record<string, unknown>): ParseResult<IdentityClientMessage> | undefined {
  if (input.type !== IDENTITY_EVENTS.SESSION_WORKSPACE) return undefined;
  if (typeof input.workspaceId !== "string" || !WORKSPACE_ID.test(input.workspaceId)) {
    return { success: false, error: "session.workspace workspaceId must be a workspace id" };
  }
  return { success: true, data: { type: IDENTITY_EVENTS.SESSION_WORKSPACE, workspaceId: input.workspaceId } };
}

/** Parser for identity server messages (undefined: not ours). */
export function parseIdentityServerMessage(input: Record<string, unknown>): ParseResult<IdentityServerMessage> | undefined {
  if (input.type !== IDENTITY_EVENTS.SESSION_IDENTITY) return undefined;
  const roles = ["owner", "admin", "member", "viewer"];
  if (
    typeof input.workspaceId !== "string" ||
    !Array.isArray(input.permissions) ||
    !input.permissions.every((p) => typeof p === "string") ||
    (input.role !== undefined && !roles.includes(input.role as string)) ||
    !["user", "token", "local"].includes(input.principal as string)
  ) {
    return { success: false, error: "session.identity is malformed" };
  }
  const user = input.user;
  if (user !== null && (typeof user !== "object" || typeof (user as Record<string, unknown>).id !== "string")) {
    return { success: false, error: "session.identity user is malformed" };
  }
  return { success: true, data: input as unknown as SessionIdentityMessage };
}


/* ── Monitors (v0.4) ── */

/**
 * Monitors watch a source (a read tool, RSS, a web page or a webhook) and
 * notify or start a task when something matters. HTTP routes (JSON; session
 * cookie or owner token; workspace from `x-sibyl-workspace`):
 *
 *   GET    /api/monitors                       → MonitorsListResponse   (monitors.use)
 *   POST   /api/monitors          MonitorInput → MonitorSaveResponse    (monitors.manage)
 *   PATCH  /api/monitors/:id      MonitorInput → MonitorSaveResponse    (monitors.manage, creator)
 *   POST   /api/monitors/:id/pause {paused}    → { monitor }            (monitors.manage, creator or admin)
 *   POST   /api/monitors/:id/run               → { ok: true }           (monitors.manage, creator)
 *   POST   /api/monitors/test     MonitorInput → MonitorTestResult      (monitors.manage; dry run, nothing saved or sent)
 *   DELETE /api/monitors/:id                   → { ok: true }           (monitors.manage, creator or admin)
 *   GET    /api/monitors/events?monitorId=&before=&limit= → { events }  (monitors.use; your own monitors only)
 *   GET    /api/monitors/status                → { statuses }           (monitors.use)
 *   POST   /api/monitors/hooks/:id             (no sign-in; header `x-sibyl-signature: sha256=<hex HMAC-SHA256 of the raw body>`)
 *
 * WebSocket: the client sends `monitors.subscribe`; the gateway then pushes
 * `monitors.status` (live status). Fired and paused events reach the creator
 * as notifications (`notification`, kinds monitor_fired / monitor_paused).
 */
export const MONITOR_EVENTS = {
  /** Client → gateway: send me live monitor status. */
  SUBSCRIBE: "monitors.subscribe",
  /** Gateway → client: a monitor's status changed. */
  STATUS: "monitors.status"
} as const;

export type MonitorFilterOpView = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "in" | "exists" | "changed";
export type MonitorChannelView = "inbox" | "email" | "slack" | "teams";
export type MonitorFilterValue = string | number | boolean | null | Array<string | number | boolean | null>;

export type MonitorSourceInput =
  | { kind: "tool"; toolName: string; input: Record<string, unknown> }
  /** secretRef: a vault secret holding the HMAC key; omit to have one created. */
  | { kind: "webhook"; secretRef?: string }
  | { kind: "rss" | "webpage"; url: string };

export interface MonitorFilterInput {
  path: string;
  op: MonitorFilterOpView;
  value?: MonitorFilterValue;
}

export type MonitorActionInput = { kind: "notify"; channels: MonitorChannelView[] } | { kind: "task"; instruction: string };

/** Create or replace a monitor (same shape as the stored record's editable part). */
export interface MonitorInput {
  name: string;
  source: MonitorSourceInput;
  schedule: { everyMinutes: number };
  condition: { filter?: MonitorFilterInput[]; ask?: string };
  actions: MonitorActionInput[];
  dedupe?: { keyPath?: string };
  agentId?: string;
  budget?: { dailyUsd?: number };
  enabled?: boolean;
}

export type MonitorStatusKind = "active" | "checking" | "paused" | "error";

export interface MonitorView {
  id: string;
  name: string;
  workspaceId: string;
  createdBy: string;
  /** The caller created it (can edit, test and see its events). */
  mine: boolean;
  agentId?: string;
  source: { kind: "tool"; toolName: string; input: Record<string, unknown> } | { kind: "webhook"; secretRef: string; hookPath: string } | { kind: "rss" | "webpage"; url: string };
  schedule: { everyMinutes: number };
  /** "every 15 minutes" / "when the webhook is called". */
  frequency: string;
  condition: { filter?: MonitorFilterInput[]; ask?: string };
  actions: MonitorActionInput[];
  dedupe: { keyPath?: string };
  enabled: boolean;
  budget?: { dailyUsd?: number };
  status: MonitorStatusKind;
  pausedReason?: string;
  lastError?: string;
  lastCheckedAt?: number;
  lastFiredAt?: number;
  nextCheckAt?: number;
  costTodayUsd: number;
  costMonthUsd: number;
  /** Estimated monthly cost: typical and worst case (every check has new candidates). */
  estimate: { typicalMonthUsd: number; maxMonthUsd: number };
  createdAt: number;
  updatedAt: number;
}

/** A read tool a monitor can watch. */
export interface MonitorSourceOption {
  toolName: string;
  title: string;
  description: string;
  source: string;
  provider?: string;
  inputSchema: Record<string, unknown>;
}

export interface MonitorChannelOption {
  channel: MonitorChannelView;
  available: boolean;
  /** Why it is unavailable ("Connect Slack first"). */
  reason?: string;
}

export interface MonitorsListResponse {
  monitors: MonitorView[];
  sources: MonitorSourceOption[];
  channels: MonitorChannelOption[];
}

export interface MonitorSaveResponse {
  monitor: MonitorView;
  /** Webhook monitors: where to POST and (only when it was just created) the signing secret. */
  webhook?: { path: string; secretRef: string; secret?: string };
}

export interface MonitorEventItemView {
  key: string;
  title: string;
  url?: string;
  reason?: string;
}

export interface MonitorEventView {
  id: string;
  monitorId: string;
  monitorName?: string;
  at: number;
  kind: "fired" | "paused";
  summary: string;
  items: MonitorEventItemView[];
  links: string[];
  costUsd: number;
  actions: Array<{ kind: "notify" | "task"; channel?: MonitorChannelView; status: "sent" | "started" | "failed" | "unavailable" | "skipped"; detail?: string }>;
  runId?: string;
  conversationId?: string;
}

export interface MonitorTestResult {
  ok: boolean;
  error?: string;
  /** Items the source returned. */
  fetched: number;
  /** Items not seen before (for a saved monitor; equals fetched for a new one). */
  newItems: number;
  /** Items that passed the filters (and were sent to the model when there is an `ask`). */
  candidates: number;
  /** What would fire. */
  matches: MonitorEventItemView[];
  summary: string;
  costUsd: number;
  note?: string;
}

export interface MonitorStatusView {
  id: string;
  status: MonitorStatusKind;
  enabled: boolean;
  lastCheckedAt?: number;
  lastFiredAt?: number;
  nextCheckAt?: number;
  lastError?: string;
  pausedReason?: string;
  costMonthUsd: number;
}

export interface MonitorsSubscribeMessage {
  type: typeof MONITOR_EVENTS.SUBSCRIBE;
}

export interface MonitorsStatusMessage {
  type: typeof MONITOR_EVENTS.STATUS;
  status: MonitorStatusView;
}

export type MonitorsClientMessage = MonitorsSubscribeMessage;
export type MonitorsServerMessage = MonitorsStatusMessage;

export const MONITOR_MIN_EVERY_MINUTES = 5;
export const MONITOR_MAX_EVERY_MINUTES = 7 * 24 * 60;
export const MONITOR_MAX_FILTERS = 10;
export const MONITOR_MAX_ACTIONS = 4;
export const MONITOR_MAX_DAILY_USD = 100;
const MONITOR_FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "exists", "changed"] as const;
const MONITOR_CHANNELS = ["inbox", "email", "slack", "teams"] as const;
const MONITOR_STATUSES = ["active", "checking", "paused", "error"] as const;
const MONITOR_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MONITOR_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MONITOR_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MONITOR_PATH = /^[A-Za-z0-9_$@:\-]+(\.[A-Za-z0-9_$@:\-]+)*$/;
const MONITOR_MAX_TOOL_INPUT_CHARS = 8_000;

function monitorText(value: unknown, label: string, max: number): ParseResult<string> {
  if (typeof value !== "string" || !value.trim()) return fail(`${label} is required`);
  if (value.trim().length > max) return fail(`${label} is too long (max ${max} characters)`);
  return ok(value.trim());
}

function isMonitorFilterValue(value: unknown): value is MonitorFilterValue {
  const primitive = (v: unknown) => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 500);
  return primitive(value) || (Array.isArray(value) && value.length <= 50 && value.every(primitive));
}

function parseMonitorSource(value: unknown): ParseResult<MonitorSourceInput> {
  if (!isRecord(value)) return fail("source must be an object");
  switch (value.kind) {
    case "tool": {
      if (typeof value.toolName !== "string" || !MONITOR_TOOL_NAME.test(value.toolName)) return fail("source.toolName must be a tool name");
      const input = value.input ?? {};
      if (!isRecord(input)) return fail("source.input must be an object");
      let size: number;
      try {
        size = JSON.stringify(input).length;
      } catch {
        return fail("source.input must be JSON");
      }
      if (size > MONITOR_MAX_TOOL_INPUT_CHARS) return fail(`source.input is too large (max ${MONITOR_MAX_TOOL_INPUT_CHARS} characters)`);
      return ok({ kind: "tool", toolName: value.toolName, input: JSON.parse(JSON.stringify(input)) as Record<string, unknown> });
    }
    case "webhook":
      if (value.secretRef !== undefined && (typeof value.secretRef !== "string" || !MONITOR_SECRET_NAME.test(value.secretRef))) {
        return fail("source.secretRef must be a secret name (UPPER_SNAKE_CASE)");
      }
      return ok({ kind: "webhook", ...(typeof value.secretRef === "string" ? { secretRef: value.secretRef } : {}) });
    case "rss":
    case "webpage": {
      if (typeof value.url !== "string" || value.url.length > 2_000) return fail("source.url must be a URL");
      try {
        const url = new URL(value.url.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return fail("source.url must be http or https");
      } catch {
        return fail("source.url must be a URL");
      }
      return ok({ kind: value.kind, url: value.url.trim() });
    }
    default:
      return fail("source.kind must be tool, webhook, rss or webpage");
  }
}

function parseMonitorFilters(value: unknown): ParseResult<MonitorFilterInput[]> {
  if (!Array.isArray(value)) return fail("condition.filter must be an array");
  if (value.length > MONITOR_MAX_FILTERS) return fail(`condition.filter has too many entries (max ${MONITOR_MAX_FILTERS})`);
  const out: MonitorFilterInput[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return fail(`condition.filter[${index}] must be an object`);
    if (typeof entry.path !== "string" || entry.path.length > 200 || !MONITOR_PATH.test(entry.path)) {
      return fail(`condition.filter[${index}].path must be a dotted path like "properties.amount"`);
    }
    if (!isEnum(entry.op, MONITOR_FILTER_OPS)) return fail(`condition.filter[${index}].op must be one of ${MONITOR_FILTER_OPS.join(", ")}`);
    const needsValue = entry.op !== "exists" && entry.op !== "changed";
    if (entry.value === undefined && needsValue) return fail(`condition.filter[${index}].value is required for ${entry.op}`);
    if (entry.value !== undefined && !isMonitorFilterValue(entry.value)) return fail(`condition.filter[${index}].value must be a short string, number, boolean, null or a list of those`);
    if (entry.op === "in" && !Array.isArray(entry.value)) return fail(`condition.filter[${index}].value must be a list for "in"`);
    if ((entry.op === "gt" || entry.op === "gte" || entry.op === "lt" || entry.op === "lte") && typeof entry.value !== "number" && typeof entry.value !== "string") {
      return fail(`condition.filter[${index}].value must be a number or date for ${entry.op}`);
    }
    out.push({ path: entry.path, op: entry.op, ...(entry.value === undefined ? {} : { value: entry.value as MonitorFilterValue }) });
  }
  return ok(out);
}

function parseMonitorActions(value: unknown): ParseResult<MonitorActionInput[]> {
  if (!Array.isArray(value) || value.length === 0) return fail("actions must be a non-empty array");
  if (value.length > MONITOR_MAX_ACTIONS) return fail(`actions has too many entries (max ${MONITOR_MAX_ACTIONS})`);
  const out: MonitorActionInput[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return fail(`actions[${index}] must be an object`);
    if (entry.kind === "notify") {
      if (!Array.isArray(entry.channels) || entry.channels.length === 0 || !entry.channels.every((c) => isEnum(c, MONITOR_CHANNELS))) {
        return fail(`actions[${index}].channels must list inbox, email, slack or teams`);
      }
      out.push({ kind: "notify", channels: [...new Set(entry.channels as MonitorChannelView[])] });
    } else if (entry.kind === "task") {
      const instruction = monitorText(entry.instruction, `actions[${index}].instruction`, 4_000);
      if (!instruction.success) return instruction;
      out.push({ kind: "task", instruction: instruction.data });
    } else {
      return fail(`actions[${index}].kind must be notify or task`);
    }
  }
  return ok(out);
}

/** Strict parser for a monitor create/replace body (the error is a sentence on bad input). */
export function parseMonitorInput(input: unknown): ParseResult<MonitorInput> {
  if (!isRecord(input)) return fail("body must be a JSON object");
  const name = monitorText(input.name, "name", 120);
  if (!name.success) return name;
  const source = parseMonitorSource(input.source);
  if (!source.success) return source;
  if (!isRecord(input.schedule)) return fail("schedule must be an object");
  const every = input.schedule.everyMinutes;
  if (typeof every !== "number" || !Number.isInteger(every) || every < MONITOR_MIN_EVERY_MINUTES || every > MONITOR_MAX_EVERY_MINUTES) {
    return fail(`schedule.everyMinutes must be a whole number from ${MONITOR_MIN_EVERY_MINUTES} to ${MONITOR_MAX_EVERY_MINUTES}`);
  }
  const conditionRaw = input.condition ?? {};
  if (!isRecord(conditionRaw)) return fail("condition must be an object");
  const condition: MonitorInput["condition"] = {};
  if (conditionRaw.filter !== undefined) {
    const filter = parseMonitorFilters(conditionRaw.filter);
    if (!filter.success) return filter;
    if (filter.data.length > 0) condition.filter = filter.data;
  }
  if (conditionRaw.ask !== undefined && conditionRaw.ask !== "") {
    const ask = monitorText(conditionRaw.ask, "condition.ask", 1_000);
    if (!ask.success) return ask;
    condition.ask = ask.data;
  }
  const actions = parseMonitorActions(input.actions);
  if (!actions.success) return actions;
  const out: MonitorInput = { name: name.data, source: source.data, schedule: { everyMinutes: every }, condition, actions: actions.data };
  if (input.dedupe !== undefined) {
    if (!isRecord(input.dedupe)) return fail("dedupe must be an object");
    const keyPath = input.dedupe.keyPath;
    if (keyPath !== undefined && keyPath !== "") {
      if (typeof keyPath !== "string" || keyPath.length > 200 || !MONITOR_PATH.test(keyPath)) return fail("dedupe.keyPath must be a dotted path like \"id\"");
      out.dedupe = { keyPath };
    } else {
      out.dedupe = {};
    }
  }
  if (input.agentId !== undefined && input.agentId !== null && input.agentId !== "") {
    if (typeof input.agentId !== "string" || !MONITOR_ID.test(input.agentId)) return fail("agentId must be an agent id");
    out.agentId = input.agentId;
  }
  if (input.budget !== undefined && input.budget !== null) {
    if (!isRecord(input.budget)) return fail("budget must be an object");
    const daily = input.budget.dailyUsd;
    if (daily !== undefined && daily !== null) {
      if (typeof daily !== "number" || !Number.isFinite(daily) || daily <= 0 || daily > MONITOR_MAX_DAILY_USD) {
        return fail(`budget.dailyUsd must be above 0 and up to ${MONITOR_MAX_DAILY_USD}`);
      }
      out.budget = { dailyUsd: daily };
    } else {
      out.budget = {};
    }
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return fail("enabled must be true or false");
    out.enabled = input.enabled;
  }
  return ok(out);
}

/** Body of POST /api/monitors/:id/pause. */
export function parseMonitorPause(input: unknown): ParseResult<{ paused: boolean }> {
  if (!isRecord(input) || typeof input.paused !== "boolean") return fail("paused must be true or false");
  return ok({ paused: input.paused });
}

/** Query of GET /api/monitors/events. */
export function parseMonitorEventsQuery(params: { get(name: string): string | null }): ParseResult<{ monitorId?: string; before?: number; limit: number }> {
  const out: { monitorId?: string; before?: number; limit: number } = { limit: 50 };
  const monitorId = params.get("monitorId");
  if (monitorId) {
    if (!MONITOR_ID.test(monitorId)) return fail("monitorId must be a monitor id");
    out.monitorId = monitorId;
  }
  const before = params.get("before");
  if (before) {
    const value = Number(before);
    if (!Number.isFinite(value) || value <= 0) return fail("before must be a timestamp");
    out.before = value;
  }
  const limit = params.get("limit");
  if (limit) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 200) return fail("limit must be 1 to 200");
    out.limit = value;
  }
  return ok(out);
}

export function isMonitorsClientMessage(message: { type: string }): message is MonitorsClientMessage {
  return message.type === MONITOR_EVENTS.SUBSCRIBE;
}

function parseMonitorsClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  if (input.type !== MONITOR_EVENTS.SUBSCRIBE) return undefined;
  return valid({ type: MONITOR_EVENTS.SUBSCRIBE });
}

function isMonitorStatusView(value: unknown): value is MonitorStatusView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isEnum(value.status, MONITOR_STATUSES) &&
    typeof value.enabled === "boolean" &&
    isFiniteNumber(value.costMonthUsd) &&
    isOptionalFiniteNumber(value.lastCheckedAt) &&
    isOptionalFiniteNumber(value.lastFiredAt) &&
    isOptionalFiniteNumber(value.nextCheckAt) &&
    isOptionalString(value.lastError) &&
    isOptionalString(value.pausedReason)
  );
}

function parseMonitorsServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  if (input.type === MONITOR_EVENTS.STATUS) {
    if (!isMonitorStatusView(input.status)) return invalidServer("invalid monitors.status message");
    return validServer({ type: MONITOR_EVENTS.STATUS, status: input.status });
  }
  return undefined;
}

/* ── Knowledge, skills & plugins (v0.4) ── */
/*
 * HTTP JSON APIs behind the identity authorize() gate:
 *   /api/knowledge  (knowledge.view / knowledge.edit / knowledge.manage)
 *   /api/skills     (skills.use / skills.edit)
 *   /api/plugins    (plugins.install)
 * Indexing status is polled (GET /api/knowledge/:id) while documents index.
 * These are the response shapes and the strict parsers for request bodies.
 */

export type KnowledgeDocStatusView = "pending" | "indexing" | "ready" | "failed";

export interface KnowledgeBaseView {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  docCount: number;
  /** Documents still pending or indexing. */
  indexing: number;
  /** Searched automatically in this workspace's chats. */
  auto: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeDocView {
  id: string;
  knowledgeBaseId: string;
  title: string;
  source: { kind: "upload"; uploadId: string; fileName: string } | { kind: "url"; url: string } | { kind: "text" };
  mime?: string;
  status: KnowledgeDocStatusView;
  error?: string;
  chunkCount: number;
  size?: number;
  /** Uploaded file type (see FILE_FORMATS). */
  fileKind?: FileKind;
  /** Pages, slides, sheets or chapters, when the format has them. */
  parts?: FileParts;
  /** Text read by a vision / OCR model (images, scanned PDFs) and what it cost. */
  ocr?: KnowledgeOcrView;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeOcrView {
  model: string;
  /** PDF engine on OpenRouter's file-parser ("mistral-ocr", "native"), for scanned PDFs. */
  engine?: string;
  costUsd: number;
  /** True when the cost is an estimate (the provider reported none). */
  estimated: boolean;
}

/** POST /api/knowledge/:id/docs answer: one doc, or one per supported file of a ZIP. */
export interface KnowledgeAddDocsResponse {
  doc: KnowledgeDocView;
  docs: KnowledgeDocView[];
  /** ZIP entries that were not added, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
}

export interface KnowledgeHitView {
  knowledgeBaseId: string;
  baseName: string;
  docId: string;
  docTitle: string;
  /** Heading / page label of the chunk, when known. */
  label?: string;
  /** "Doc title › label" for citations. */
  citation: string;
  snippet: string;
  score: number;
  url?: string;
}

export interface KnowledgeListResponse {
  bases: KnowledgeBaseView[];
  autoBaseIds: string[];
  embeddings: boolean;
}

export interface KnowledgeBaseResponse {
  base: KnowledgeBaseView;
  docs: KnowledgeDocView[];
}

export interface KnowledgeSearchResponse {
  query: string;
  hits: KnowledgeHitView[];
  mode: "keyword" | "hybrid";
}

export type KnowledgeDocInput =
  | { kind: "upload"; uploadId: string; title?: string }
  | { kind: "url"; url: string; title?: string }
  | { kind: "text"; title: string; text: string };

export const KNOWLEDGE_TEXT_MAX_CHARS = 500_000;

function kspObject(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function kspUnknownKey(body: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(body).find((key) => !allowed.includes(key));
}

/** Strict parser for "add a document" bodies. */
export function parseKnowledgeDocInput(input: unknown): ParseResult<KnowledgeDocInput> {
  const body = kspObject(input);
  if (!body) return { success: false, error: "body must be an object" };
  const title = body.title;
  if (title !== undefined && (typeof title !== "string" || title.length > 200)) {
    return { success: false, error: "title must be a string of at most 200 characters" };
  }
  const titled = typeof title === "string" && title.trim() ? { title: title.trim() } : {};
  switch (body.kind) {
    case "upload": {
      const extra = kspUnknownKey(body, ["kind", "uploadId", "title"]);
      if (extra) return { success: false, error: `unknown field ${extra}` };
      if (typeof body.uploadId !== "string" || !/^up_[a-f0-9]{24}$/.test(body.uploadId)) return { success: false, error: "uploadId must be an upload id" };
      return { success: true, data: { kind: "upload", uploadId: body.uploadId, ...titled } };
    }
    case "url": {
      const extra = kspUnknownKey(body, ["kind", "url", "title"]);
      if (extra) return { success: false, error: `unknown field ${extra}` };
      if (typeof body.url !== "string" || body.url.length > 2048 || !/^https?:\/\/\S+$/i.test(body.url)) return { success: false, error: "url must be an http(s) URL" };
      return { success: true, data: { kind: "url", url: body.url, ...titled } };
    }
    case "text": {
      const extra = kspUnknownKey(body, ["kind", "text", "title"]);
      if (extra) return { success: false, error: `unknown field ${extra}` };
      if (typeof title !== "string" || !title.trim()) return { success: false, error: "title is required for pasted text" };
      if (typeof body.text !== "string" || !body.text.trim()) return { success: false, error: "text is required" };
      if (body.text.length > KNOWLEDGE_TEXT_MAX_CHARS) return { success: false, error: `text is longer than ${KNOWLEDGE_TEXT_MAX_CHARS} characters` };
      return { success: true, data: { kind: "text", title: title.trim(), text: body.text } };
    }
    default:
      return { success: false, error: "kind must be upload, url or text" };
  }
}

export interface SkillFileView {
  name: string;
  content: string;
}

export interface SkillView {
  id: string;
  /** Undefined: every workspace. */
  workspaceId?: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  tools?: string[];
  files?: SkillFileView[];
  source: "builtin" | "user" | "plugin" | "agent";
  /** The agent that learned this skill (source "agent"). */
  agentId?: string;
  pluginId?: string;
  enabled: boolean;
  version?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SkillVersionView {
  version: string;
  title: string;
  description: string;
  savedAt: number;
}

export interface SkillInput {
  name: string;
  title: string;
  description: string;
  instructions: string;
  tools?: string[];
  files?: SkillFileView[];
  enabled?: boolean;
  /** "workspace": only the current workspace; "all": every workspace. */
  scope?: "workspace" | "all";
}

export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SKILL_LIMITS = {
  titleChars: 120,
  descriptionChars: 400,
  instructionsChars: 40_000,
  files: 20,
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  tools: 30
} as const;

/** A relative POSIX path with no traversal, no absolute or drive prefix, no control characters. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Validates bundled skill files (names, count and size caps). */
export function checkSkillFiles(value: unknown): ParseResult<SkillFileView[]> {
  if (!Array.isArray(value) || value.length > SKILL_LIMITS.files) return { success: false, error: `files must be a list of at most ${SKILL_LIMITS.files}` };
  let total = 0;
  const files: SkillFileView[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const file = kspObject(item);
    if (!file || typeof file.name !== "string" || typeof file.content !== "string") return { success: false, error: "each file needs a name and content" };
    if (!isSafeRelativePath(file.name)) return { success: false, error: `unsafe file name ${file.name}` };
    if (seen.has(file.name)) return { success: false, error: `duplicate file ${file.name}` };
    seen.add(file.name);
    const bytes = new TextEncoder().encode(file.content).byteLength;
    if (bytes > SKILL_LIMITS.fileBytes) return { success: false, error: `${file.name} is larger than ${SKILL_LIMITS.fileBytes / 1024} KB` };
    total += bytes;
    files.push({ name: file.name, content: file.content });
  }
  if (total > SKILL_LIMITS.totalBytes) return { success: false, error: `files are larger than ${SKILL_LIMITS.totalBytes / 1024} KB in total` };
  return { success: true, data: files };
}

/** Strict parser for skill create (full) and update (`partial`) bodies. */
export function parseSkillInput(input: unknown, partial = false): ParseResult<Partial<SkillInput>> {
  const body = kspObject(input);
  if (!body) return { success: false, error: "body must be an object" };
  const extra = kspUnknownKey(body, ["name", "title", "description", "instructions", "tools", "files", "enabled", "scope"]);
  if (extra) return { success: false, error: `unknown field ${extra}` };
  const out: Partial<SkillInput> = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== "string" || !SKILL_NAME.test(body.name)) return { success: false, error: "name must be lowercase letters, digits and dashes (1–64)" };
    out.name = body.name;
  }
  const limits = { title: SKILL_LIMITS.titleChars, description: SKILL_LIMITS.descriptionChars, instructions: SKILL_LIMITS.instructionsChars };
  for (const key of ["title", "description", "instructions"] as const) {
    const value = body[key];
    if (value === undefined) {
      if (!partial) return { success: false, error: `${key} is required` };
      continue;
    }
    if (typeof value !== "string" || !value.trim()) return { success: false, error: `${key} must be a non-empty string` };
    if (value.length > limits[key]) return { success: false, error: `${key} is longer than ${limits[key]} characters` };
    out[key] = key === "instructions" ? value : value.trim();
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > SKILL_LIMITS.tools || !body.tools.every((t) => typeof t === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(t))) {
      return { success: false, error: "tools must be a list of tool names" };
    }
    out.tools = body.tools as string[];
  }
  if (body.files !== undefined) {
    const files = checkSkillFiles(body.files);
    if (!files.success) return files;
    out.files = files.data;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { success: false, error: "enabled must be a boolean" };
    out.enabled = body.enabled;
  }
  if (body.scope !== undefined) {
    if (body.scope !== "workspace" && body.scope !== "all") return { success: false, error: "scope must be workspace or all" };
    out.scope = body.scope;
  }
  return { success: true, data: out };
}

export type PluginStatusView = "ready" | "needs_secrets" | "error";

export interface PluginSecretView {
  name: string;
  description: string;
  allowedHosts: string[];
  howToGet?: string;
  docsUrl?: string;
  optional?: boolean;
  /** True when the vault holds it. */
  present: boolean;
}

export interface PluginRoutineTemplateView {
  index: number;
  name: string;
  instruction: string;
  cron: string;
  /** Routine created from this template (when the user accepted it). */
  routineId?: string;
}

export interface PluginSummaryView {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  license?: string;
  skills: Array<{ name: string; title: string; description: string }>;
  mcpServers: Array<{ key: string; transport: "stdio" | "http"; target: string }>;
  secrets: Array<{ name: string; description: string; optional?: boolean }>;
  routines: Array<{ name: string; cron: string }>;
  knowledgeBases: Array<{ name: string; description?: string }>;
}

export interface PluginView {
  id: string;
  workspaceId?: string;
  summary: PluginSummaryView;
  source: { kind: "catalog" | "url" | "git" | "local"; ref: string };
  enabled: boolean;
  status: PluginStatusView;
  error?: string;
  secrets: PluginSecretView[];
  routines: PluginRoutineTemplateView[];
  /** MCP server names it registered on the Connections screen. */
  servers: string[];
  installedAt: number;
  updatedAt: number;
}

export interface PluginCatalogEntryView {
  ref: string;
  summary: PluginSummaryView;
  installed: boolean;
}

export interface PluginsListResponse {
  installed: PluginView[];
  catalog: PluginCatalogEntryView[];
  /** Local (stdio) MCP servers may run (SIBYL_ALLOW_STDIO_MCP). */
  stdioAllowed: boolean;
}

export type PluginSourceInput = { kind: "catalog" | "url" | "git"; ref: string };

/** Strict parser for plugin install / preview bodies. */
export function parsePluginInstallInput(input: unknown): ParseResult<{ source: PluginSourceInput; scope: "workspace" | "all" }> {
  const body = kspObject(input);
  if (!body) return { success: false, error: "body must be an object" };
  const extra = kspUnknownKey(body, ["source", "scope"]);
  if (extra) return { success: false, error: `unknown field ${extra}` };
  const source = kspObject(body.source);
  if (!source || !["catalog", "url", "git"].includes(source.kind as string)) return { success: false, error: "source.kind must be catalog, url or git" };
  const sourceExtra = kspUnknownKey(source, ["kind", "ref"]);
  if (sourceExtra) return { success: false, error: `unknown field source.${sourceExtra}` };
  if (typeof source.ref !== "string" || !source.ref.trim() || source.ref.length > 2048) return { success: false, error: "source.ref is required" };
  const scope = body.scope ?? "workspace";
  if (scope !== "workspace" && scope !== "all") return { success: false, error: "scope must be workspace or all" };
  return { success: true, data: { source: { kind: source.kind as PluginSourceInput["kind"], ref: source.ref.trim() }, scope } };
}

/* ── Integrations (v0.4) ── */

/**
 * Native connectors (Google Workspace, Microsoft 365; HubSpot and Salesforce
 * in Sibyl Enterprise). HTTP routes (JSON, same sign-in and workspace header
 * as the other APIs):
 *
 *   GET    /api/connectors                          → IntegrationsState
 *   POST   /api/connectors/:id/connect {scope, groups?, credentials?} → { authorizeUrl } | { connection }
 *   GET    /api/connectors/oauth/callback?code&state (the vendor redirects here)
 *   PATCH  /api/connectors/connections/:id {groups}  → { connection }
 *   POST   /api/connectors/connections/:id/test      → { connection }
 *   DELETE /api/connectors/connections/:id           → { ok }
 *   PUT    /api/connectors/apps/:id {clientId?, clientSecret?, settings?, allowedGroups?, secrets?} → IntegrationsState
 *   DELETE /api/connectors/apps/:id                  → IntegrationsState
 *
 * Tokens and client secrets never appear in any of these, nor on the socket.
 */
export const INTEGRATIONS_EVENTS = {
  /** Client → gateway: send the current integrations state. */
  REQUEST: "integrations.request",
  /** Gateway → client: connectors and the connections this person can see (pushed on change). */
  STATE: "integrations.state"
} as const;

export interface IntegrationActionView {
  /** Tool name, e.g. "google_gmail_search". */
  name: string;
  title: string;
  effect: "read" | "write";
  risk?: "high";
}

export interface IntegrationGroupView {
  id: string;
  title: string;
  description: string;
  scopes: string[];
  defaultEnabled: boolean;
  /** Allowed by the organization's admins. */
  allowed: boolean;
  actions: IntegrationActionView[];
}

export interface IntegrationAppView {
  /** The organization's OAuth app (client ID + secret) is set. */
  configured: boolean;
  /** Where the credentials come from. */
  source?: "vault" | "env";
  /** Not secret; shown so admins can check it. */
  clientId?: string;
  /** Register this redirect URI with the vendor. */
  redirectUri: string;
  settings: Array<{ name: string; label: string; help?: string; value: string }>;
  /** Further app secrets (e.g. Slack's signing secret): only whether each is stored. Saved with `secrets: { NAME: value }`. */
  secrets?: Array<{ name: string; label: string; help?: string; configured: boolean }>;
  /** Addresses on this gateway to register with the vendor's app (e.g. Slack's Events URL). */
  endpoints?: Array<{ label: string; url: string; help?: string }>;
}

export interface IntegrationSetupView {
  consoleUrl: string;
  consoleName: string;
  steps: string[];
  docsAnchor: string;
}

export interface IntegrationConnectorView {
  id: string;
  name: string;
  vendor: string;
  description: string;
  edition: "oss" | "enterprise";
  /** Licence feature id for enterprise connectors. */
  feature?: string;
  /** Usable on this gateway (enterprise: licensed and installed). */
  available: boolean;
  authKinds: Array<"oauth2" | "apiKey">;
  /** API-key fields (private app tokens). */
  apiKeyFields?: Array<{ name: string; label: string; help?: string; placeholder?: string }>;
  groups: IntegrationGroupView[];
  app?: IntegrationAppView;
  setup?: IntegrationSetupView;
}

export interface IntegrationConnectionView {
  id: string;
  connectorId: string;
  scope: "personal" | "workspace";
  workspaceId: string;
  /** A personal connection of the caller. */
  mine: boolean;
  /** The caller may change or remove it. */
  canManage: boolean;
  account?: string;
  accountName?: string;
  createdByName?: string;
  status: "connected" | "reconnect" | "error";
  statusMessage?: string;
  /** Enabled action groups. */
  groups: string[];
  /** Enabled groups that need a reconnect to grant their scopes. */
  needsConsent: string[];
  authKind: "oauth2" | "apiKey";
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface IntegrationsState {
  connectors: IntegrationConnectorView[];
  connections: IntegrationConnectionView[];
  can: { use: boolean; connectPersonal: boolean; connectShared: boolean; manageApps: boolean };
  /** Connectors are unavailable (e.g. the secrets key is missing). */
  unavailableReason?: string;
}

export interface IntegrationsRequestMessage {
  type: typeof INTEGRATIONS_EVENTS.REQUEST;
}

export interface IntegrationsStateMessage extends IntegrationsState {
  type: typeof INTEGRATIONS_EVENTS.STATE;
}

export type IntegrationsClientMessage = IntegrationsRequestMessage;
export type IntegrationsServerMessage = IntegrationsStateMessage;

export function isIntegrationsClientMessage(message: { type: string }): message is IntegrationsClientMessage {
  return message.type === INTEGRATIONS_EVENTS.REQUEST;
}

function parseIntegrationsClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  if (input.type !== INTEGRATIONS_EVENTS.REQUEST) return undefined;
  return valid({ type: INTEGRATIONS_EVENTS.REQUEST });
}

function parseIntegrationsServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  if (input.type !== INTEGRATIONS_EVENTS.STATE) return undefined;
  if (!Array.isArray(input.connectors) || !Array.isArray(input.connections) || !isRecord(input.can)) {
    return invalidServer("invalid integrations.state message");
  }
  return validServer(input as unknown as IntegrationsStateMessage);
}

/* ── Agents (v0.4) ── */
/*
 * User-created agents: their own avatar, voice, instructions, access,
 * autonomy, learning and budget. All over the WebSocket; the gateway checks
 * agents.use / agents.create / agents.share per message.
 *
 * Chat: `user.text` and `vad.speech_start` take an optional `agentId`;
 * `agent.select` makes an agent the connection's default (null: Sibyl).
 * A turn answered by an agent is announced with `agent.turn` (for the avatar).
 */

export const AGENT_EVENTS = {
  /** Client → gateway: list agents (+ templates). */
  REQUEST: "agents.request",
  /** Client → gateway: one agent with its memory, proposals and spend. */
  GET: "agent.get",
  /** Client → gateway: create (no id) or update an agent. */
  SAVE: "agent.save",
  DELETE: "agent.delete",
  /** Client → gateway: default agent for this connection's turns (null: Sibyl). */
  SELECT: "agent.select",
  PROPOSALS_REQUEST: "agent.proposals.request",
  /** Client → gateway: approve / reject / roll back something an agent learned. */
  PROPOSAL_DECIDE: "agent.proposal.decide",
  MEMORY_REQUEST: "agent.memory.request",
  MEMORY_SAVE: "agent.memory.save",
  MEMORY_DELETE: "agent.memory.delete",
  /** Client → gateway: hear a voice before saving it (answered with agent.voice.sample). */
  VOICE_PREVIEW: "agent.voice.preview",
  /** Gateway → client. */
  LIST: "agents.list",
  DETAIL: "agent.detail",
  SAVED: "agent.saved",
  PROPOSALS: "agent.proposals",
  MEMORY: "agent.memory",
  /** Gateway → client: this request is answered by an agent. */
  TURN: "agent.turn",
  /** Gateway → client: a short spoken sample of a voice (base64 audio). */
  VOICE_SAMPLE: "agent.voice.sample"
} as const;

export const AGENT_KIND_VALUES = ["dot", "blob", "cat", "bird", "bot", "ghost", "custom-image"] as const;
export const AGENT_AUTONOMY_VALUES = ["ask_first", "act_then_tell", "autonomous"] as const;
export const AGENT_LEARNING_VALUES = ["ask_first", "automatic", "off"] as const;
export const AGENT_VISIBILITY_VALUES = ["private", "workspace"] as const;

/** Same shape as core's AvatarSpec (values are normalized by the gateway). */
export interface AgentAvatarView {
  seed: string;
  kind: (typeof AGENT_KIND_VALUES)[number];
  palette: string;
  eyes: string;
  mouth: string;
  accessory: string;
  imageUploadId?: string;
}

export type AgentAccessView =
  | { mode: "inherit" }
  | { mode: "controlled"; tools: string[]; connectors: string[]; knowledgeBaseIds: string[]; skillIds: string[]; secrets: string[] };

export interface AgentInput {
  /** Absent: create. */
  id?: string;
  name: string;
  description: string;
  avatar: AgentAvatarView;
  voice?: { ttsModel?: string; ttsVoice?: string; style?: string };
  instructions: string;
  modelPreset?: string;
  access: AgentAccessView;
  autonomy: (typeof AGENT_AUTONOMY_VALUES)[number];
  learning: (typeof AGENT_LEARNING_VALUES)[number];
  budget?: { dailyUsd?: number; monthlyUsd?: number };
  /** Its own sandboxed computer (see "Agent computers" below). */
  computer?: AgentComputerSettingsView;
  visibility: (typeof AGENT_VISIBILITY_VALUES)[number];
  templateId?: string;
}

export interface AgentView extends Omit<AgentInput, "id"> {
  id: string;
  workspaceId: string;
  createdBy: string;
  /** The caller created it. */
  mine: boolean;
  /** The caller may edit or delete it (creator, or agents.share). */
  canEdit: boolean;
  pendingProposals: number;
  spend?: { todayUsd: number; monthUsd: number };
  createdAt: number;
  updatedAt: number;
}

export interface AgentTemplateView {
  id: string;
  name: string;
  description: string;
  avatar: AgentAvatarView;
  instructions: string;
  /** Suggested access (shown in the editor; "inherit" by default). */
  suggestedTools: string[];
  autonomy: AgentInput["autonomy"];
  learning: AgentInput["learning"];
}

export interface AgentMemoryView {
  id: string;
  agentId: string;
  kind: "fact" | "run";
  text: string;
  source: "user" | "agent";
  createdAt: number;
  updatedAt: number;
}

export interface SkillDraftView {
  name: string;
  title: string;
  description: string;
  instructions: string;
}

export interface SkillProposalView {
  id: string;
  agentId: string;
  kind: "new" | "edit" | "memory";
  skill?: SkillDraftView;
  /** The current skill text (kind "edit"), to show what changes. */
  currentSkill?: SkillDraftView;
  skillId?: string;
  memory?: string;
  rationale: string;
  status: "pending" | "applied" | "rejected" | "rolled_back";
  createdAt: number;
  decidedAt?: number;
}

export interface AgentsRequestMessage {
  type: typeof AGENT_EVENTS.REQUEST;
}
export interface AgentGetMessage {
  type: typeof AGENT_EVENTS.GET;
  agentId: string;
}
export interface AgentSaveMessage {
  type: typeof AGENT_EVENTS.SAVE;
  agent: AgentInput;
}
export interface AgentDeleteMessage {
  type: typeof AGENT_EVENTS.DELETE;
  agentId: string;
}
export interface AgentSelectMessage {
  type: typeof AGENT_EVENTS.SELECT;
  agentId: string | null;
}
export interface AgentProposalsRequestMessage {
  type: typeof AGENT_EVENTS.PROPOSALS_REQUEST;
  agentId?: string;
}
export interface AgentProposalDecideMessage {
  type: typeof AGENT_EVENTS.PROPOSAL_DECIDE;
  proposalId: string;
  decision: "approve" | "reject" | "rollback";
  /** Edited skill draft or memory line to apply instead of the proposed one. */
  skill?: SkillDraftView;
  memory?: string;
}
export interface AgentMemoryRequestMessage {
  type: typeof AGENT_EVENTS.MEMORY_REQUEST;
  agentId: string;
}
export interface AgentMemorySaveMessage {
  type: typeof AGENT_EVENTS.MEMORY_SAVE;
  agentId: string;
  /** Absent: add a new line. */
  itemId?: string;
  text: string;
}
export interface AgentMemoryDeleteMessage {
  type: typeof AGENT_EVENTS.MEMORY_DELETE;
  agentId: string;
  itemId: string;
}

export interface AgentVoicePreviewMessage {
  type: typeof AGENT_EVENTS.VOICE_PREVIEW;
  requestId: string;
  ttsModel?: string;
  ttsVoice?: string;
  /** Who is speaking ("Hi, I'm …"). */
  name?: string;
}

export type AgentsClientMessage =
  | AgentVoicePreviewMessage
  | AgentsRequestMessage
  | AgentGetMessage
  | AgentSaveMessage
  | AgentDeleteMessage
  | AgentSelectMessage
  | AgentProposalsRequestMessage
  | AgentProposalDecideMessage
  | AgentMemoryRequestMessage
  | AgentMemorySaveMessage
  | AgentMemoryDeleteMessage;

export interface AgentsListMessage {
  type: typeof AGENT_EVENTS.LIST;
  items: AgentView[];
  templates: AgentTemplateView[];
  /** The connection's default agent (agent.select). */
  selectedAgentId?: string;
  canCreate: boolean;
  canShare: boolean;
}
export interface AgentDetailMessage {
  type: typeof AGENT_EVENTS.DETAIL;
  agent: AgentView;
  memory: AgentMemoryView[];
  proposals: SkillProposalView[];
}
export interface AgentSavedMessage {
  type: typeof AGENT_EVENTS.SAVED;
  agent: AgentView;
}
export interface AgentProposalsMessage {
  type: typeof AGENT_EVENTS.PROPOSALS;
  agentId?: string;
  items: SkillProposalView[];
}
export interface AgentMemoryMessage {
  type: typeof AGENT_EVENTS.MEMORY;
  agentId: string;
  items: AgentMemoryView[];
}
export interface AgentTurnMessage {
  type: typeof AGENT_EVENTS.TURN;
  requestId: string;
  agentId: string;
  name: string;
  avatar: AgentAvatarView;
}

export interface AgentVoiceSampleMessage {
  type: typeof AGENT_EVENTS.VOICE_SAMPLE;
  requestId: string;
  mimeType: string;
  /** Base64 audio. */
  audio: string;
}

export type AgentsServerMessage =
  | AgentVoiceSampleMessage
  | AgentsListMessage
  | AgentDetailMessage
  | AgentSavedMessage
  | AgentProposalsMessage
  | AgentMemoryMessage
  | AgentTurnMessage;

const AGENT_CLIENT_TYPES: ReadonlySet<string> = new Set([
  AGENT_EVENTS.VOICE_PREVIEW,
  AGENT_EVENTS.REQUEST,
  AGENT_EVENTS.GET,
  AGENT_EVENTS.SAVE,
  AGENT_EVENTS.DELETE,
  AGENT_EVENTS.SELECT,
  AGENT_EVENTS.PROPOSALS_REQUEST,
  AGENT_EVENTS.PROPOSAL_DECIDE,
  AGENT_EVENTS.MEMORY_REQUEST,
  AGENT_EVENTS.MEMORY_SAVE,
  AGENT_EVENTS.MEMORY_DELETE
]);

export function isAgentsClientMessage(message: { type: string }): message is AgentsClientMessage {
  return AGENT_CLIENT_TYPES.has(message.type);
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const AGENT_LIST_MAX = 200;
export const AGENT_MEMORY_TEXT_MAX = 600;

function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value);
}

function boundedText(value: unknown, max: number, label: string, required: boolean): ParseResult<string> {
  if (value === undefined && !required) return ok("");
  if (typeof value !== "string") return fail(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) return fail(`${label} must not be empty`);
  if (text.length > max) return fail(`${label} must be at most ${max} characters`);
  return ok(text);
}

function boundedList(value: unknown, label: string): ParseResult<string[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value) || value.length > AGENT_LIST_MAX || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128)) {
    return fail(`${label} must be a list of up to ${AGENT_LIST_MAX} names`);
  }
  return ok([...new Set(value as string[])]);
}

/** Strict parser for an agent from the browser (the error is a sentence on bad input). */
export function parseAgentInput(input: unknown): ParseResult<AgentInput> {
  if (!isRecord(input)) return fail("agent must be an object");
  if (input.id !== undefined && !isAgentId(input.id)) return fail("agent id is invalid");
  const name = boundedText(input.name, 60, "name", true);
  if (!name.success) return name;
  const description = boundedText(input.description, 280, "description", false);
  if (!description.success) return description;
  const instructions = boundedText(input.instructions, 8_000, "instructions", false);
  if (!instructions.success) return instructions;

  const avatar = input.avatar;
  if (!isRecord(avatar) || !isEnum(avatar.kind, AGENT_KIND_VALUES)) return fail("avatar must have a valid kind");
  for (const key of ["seed", "palette", "eyes", "mouth", "accessory"] as const) {
    if (typeof avatar[key] !== "string" || !(avatar[key] as string).length || (avatar[key] as string).length > 64) return fail(`avatar ${key} is invalid`);
  }
  if (avatar.imageUploadId !== undefined && !isAgentId(avatar.imageUploadId)) return fail("avatar imageUploadId is invalid");

  let voice: AgentInput["voice"];
  if (input.voice !== undefined && input.voice !== null) {
    if (!isRecord(input.voice)) return fail("voice must be an object");
    voice = {};
    for (const [key, max] of [["ttsModel", 200], ["ttsVoice", 100], ["style", 200]] as const) {
      const value = input.voice[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || value.length > max) return fail(`voice ${key} is invalid`);
      voice[key] = value.trim();
    }
  }
  if (input.modelPreset !== undefined && input.modelPreset !== null && (typeof input.modelPreset !== "string" || input.modelPreset.length > 200)) {
    return fail("modelPreset is invalid");
  }

  const access = input.access;
  let parsedAccess: AgentAccessView;
  if (!isRecord(access)) return fail("access must be an object");
  if (access.mode === "inherit") parsedAccess = { mode: "inherit" };
  else if (access.mode === "controlled") {
    const lists: Record<string, string[]> = {};
    for (const key of ["tools", "connectors", "knowledgeBaseIds", "skillIds", "secrets"] as const) {
      const list = boundedList(access[key], `access ${key}`);
      if (!list.success) return list;
      lists[key] = list.data;
    }
    parsedAccess = { mode: "controlled", tools: lists.tools!, connectors: lists.connectors!, knowledgeBaseIds: lists.knowledgeBaseIds!, skillIds: lists.skillIds!, secrets: lists.secrets! };
  } else return fail("access mode must be inherit or controlled");

  if (!isEnum(input.autonomy, AGENT_AUTONOMY_VALUES)) return fail("autonomy must be ask_first, act_then_tell or autonomous");
  if (!isEnum(input.learning, AGENT_LEARNING_VALUES)) return fail("learning must be ask_first, automatic or off");
  if (!isEnum(input.visibility, AGENT_VISIBILITY_VALUES)) return fail("visibility must be private or workspace");

  let budget: AgentInput["budget"];
  if (input.budget !== undefined && input.budget !== null) {
    if (!isRecord(input.budget)) return fail("budget must be an object");
    budget = {};
    for (const key of ["dailyUsd", "monthlyUsd"] as const) {
      const value = input.budget[key];
      if (value === undefined || value === null) continue;
      if (!isFiniteNumber(value) || value < 0 || value > 10_000) return fail(`budget ${key} must be between 0 and 10000`);
      budget[key] = value;
    }
  }
  if (input.templateId !== undefined && !isAgentId(input.templateId)) return fail("templateId is invalid");
  const computer = parseAgentComputerSettings(input.computer);
  if (!computer.success) return computer;

  return ok({
    ...(input.id === undefined ? {} : { id: input.id as string }),
    name: name.data,
    description: description.data,
    avatar: {
      seed: avatar.seed as string,
      kind: avatar.kind,
      palette: avatar.palette as string,
      eyes: avatar.eyes as string,
      mouth: avatar.mouth as string,
      accessory: avatar.accessory as string,
      ...(avatar.imageUploadId === undefined ? {} : { imageUploadId: avatar.imageUploadId as string })
    },
    ...(voice && Object.keys(voice).length ? { voice } : {}),
    instructions: instructions.data,
    ...(typeof input.modelPreset === "string" && input.modelPreset.trim() ? { modelPreset: input.modelPreset.trim() } : {}),
    access: parsedAccess,
    autonomy: input.autonomy,
    learning: input.learning,
    ...(budget && Object.keys(budget).length ? { budget } : {}),
    ...(computer.data ? { computer: computer.data } : {}),
    visibility: input.visibility,
    ...(input.templateId === undefined ? {} : { templateId: input.templateId as string })
  });
}

function parseSkillDraft(value: unknown): ParseResult<SkillDraftView> {
  if (!isRecord(value)) return fail("skill must be an object");
  if (typeof value.name !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.name)) return fail("skill name must be a slug (a-z, 0-9, -)");
  const title = boundedText(value.title, 120, "skill title", true);
  if (!title.success) return title;
  const description = boundedText(value.description, 500, "skill description", true);
  if (!description.success) return description;
  const instructions = boundedText(value.instructions, 12_000, "skill instructions", true);
  if (!instructions.success) return instructions;
  return ok({ name: value.name, title: title.data, description: description.data, instructions: instructions.data });
}

/** Client messages of this block (called from parseClientMessage). */
export function parseAgentsClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  switch (input.type) {
    case AGENT_EVENTS.REQUEST:
      return valid({ type: AGENT_EVENTS.REQUEST });
    case AGENT_EVENTS.VOICE_PREVIEW: {
      if (!isAgentId(input.requestId)) return invalid("agent.voice.preview requestId is invalid");
      for (const [key, max] of [["ttsModel", 200], ["ttsVoice", 100], ["name", 60]] as const) {
        if (!isOptionalBoundedString(input[key], max)) return invalid(`agent.voice.preview ${key} is invalid`);
      }
      return valid({
        type: AGENT_EVENTS.VOICE_PREVIEW,
        requestId: input.requestId,
        ...(typeof input.ttsModel === "string" && input.ttsModel ? { ttsModel: input.ttsModel } : {}),
        ...(typeof input.ttsVoice === "string" && input.ttsVoice ? { ttsVoice: input.ttsVoice } : {}),
        ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim() } : {})
      });
    }
    case AGENT_EVENTS.GET:
    case AGENT_EVENTS.DELETE:
    case AGENT_EVENTS.MEMORY_REQUEST:
      if (!isAgentId(input.agentId)) return invalid(`${input.type} agentId is invalid`);
      return valid({ type: input.type, agentId: input.agentId });
    case AGENT_EVENTS.SAVE: {
      const agent = parseAgentInput(input.agent);
      if (!agent.success) return invalid(`agent.save ${agent.error}`);
      return valid({ type: AGENT_EVENTS.SAVE, agent: agent.data });
    }
    case AGENT_EVENTS.SELECT:
      if (input.agentId !== null && !isAgentId(input.agentId)) return invalid("agent.select agentId must be an agent id or null");
      return valid({ type: AGENT_EVENTS.SELECT, agentId: input.agentId as string | null });
    case AGENT_EVENTS.PROPOSALS_REQUEST:
      if (input.agentId !== undefined && !isAgentId(input.agentId)) return invalid("agent.proposals.request agentId is invalid");
      return valid({ type: AGENT_EVENTS.PROPOSALS_REQUEST, ...(input.agentId === undefined ? {} : { agentId: input.agentId as string }) });
    case AGENT_EVENTS.PROPOSAL_DECIDE: {
      if (!isAgentId(input.proposalId)) return invalid("agent.proposal.decide proposalId is invalid");
      if (!isEnum(input.decision, ["approve", "reject", "rollback"] as const)) return invalid("agent.proposal.decide decision must be approve, reject or rollback");
      let skill: SkillDraftView | undefined;
      if (input.skill !== undefined) {
        const parsed = parseSkillDraft(input.skill);
        if (!parsed.success) return invalid(`agent.proposal.decide ${parsed.error}`);
        skill = parsed.data;
      }
      let memory: string | undefined;
      if (input.memory !== undefined) {
        const parsed = boundedText(input.memory, AGENT_MEMORY_TEXT_MAX, "memory", true);
        if (!parsed.success) return invalid(`agent.proposal.decide ${parsed.error}`);
        memory = parsed.data;
      }
      return valid({
        type: AGENT_EVENTS.PROPOSAL_DECIDE,
        proposalId: input.proposalId,
        decision: input.decision,
        ...(skill ? { skill } : {}),
        ...(memory ? { memory } : {})
      });
    }
    case AGENT_EVENTS.MEMORY_SAVE: {
      if (!isAgentId(input.agentId)) return invalid("agent.memory.save agentId is invalid");
      if (input.itemId !== undefined && !isAgentId(input.itemId)) return invalid("agent.memory.save itemId is invalid");
      const text = boundedText(input.text, AGENT_MEMORY_TEXT_MAX, "text", true);
      if (!text.success) return invalid(`agent.memory.save ${text.error}`);
      return valid({ type: AGENT_EVENTS.MEMORY_SAVE, agentId: input.agentId, ...(input.itemId === undefined ? {} : { itemId: input.itemId as string }), text: text.data });
    }
    case AGENT_EVENTS.MEMORY_DELETE:
      if (!isAgentId(input.agentId) || !isAgentId(input.itemId)) return invalid("agent.memory.delete needs agentId and itemId");
      return valid({ type: AGENT_EVENTS.MEMORY_DELETE, agentId: input.agentId, itemId: input.itemId });
    default:
      return undefined;
  }
}

function isAgentViewValue(value: unknown): value is AgentView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.instructions === "string" &&
    isRecord(value.avatar) &&
    isEnum(value.avatar.kind, AGENT_KIND_VALUES) &&
    isRecord(value.access) &&
    isEnum(value.access.mode, ["inherit", "controlled"] as const) &&
    isEnum(value.autonomy, AGENT_AUTONOMY_VALUES) &&
    isEnum(value.learning, AGENT_LEARNING_VALUES) &&
    isEnum(value.visibility, AGENT_VISIBILITY_VALUES) &&
    typeof value.mine === "boolean" &&
    typeof value.canEdit === "boolean" &&
    isFiniteNumber(value.pendingProposals) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isProposalViewValue(value: unknown): value is SkillProposalView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agentId) &&
    isEnum(value.kind, ["new", "edit", "memory"] as const) &&
    isEnum(value.status, ["pending", "applied", "rejected", "rolled_back"] as const) &&
    typeof value.rationale === "string" &&
    isFiniteNumber(value.createdAt)
  );
}

function isMemoryViewValue(value: unknown): value is AgentMemoryView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agentId) &&
    isEnum(value.kind, ["fact", "run"] as const) &&
    typeof value.text === "string" &&
    isFiniteNumber(value.updatedAt)
  );
}

/** Server messages of this block (called from parseServerMessage). */
export function parseAgentsServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  switch (input.type) {
    case AGENT_EVENTS.LIST:
      if (
        !Array.isArray(input.items) ||
        !input.items.every(isAgentViewValue) ||
        !Array.isArray(input.templates) ||
        typeof input.canCreate !== "boolean" ||
        typeof input.canShare !== "boolean" ||
        !isOptionalString(input.selectedAgentId)
      ) {
        return invalidServer("invalid agents.list message");
      }
      return validServer(input as unknown as AgentsListMessage);
    case AGENT_EVENTS.DETAIL:
      if (!isAgentViewValue(input.agent) || !Array.isArray(input.memory) || !input.memory.every(isMemoryViewValue) || !Array.isArray(input.proposals) || !input.proposals.every(isProposalViewValue)) {
        return invalidServer("invalid agent.detail message");
      }
      return validServer(input as unknown as AgentDetailMessage);
    case AGENT_EVENTS.SAVED:
      if (!isAgentViewValue(input.agent)) return invalidServer("invalid agent.saved message");
      return validServer(input as unknown as AgentSavedMessage);
    case AGENT_EVENTS.PROPOSALS:
      if (!Array.isArray(input.items) || !input.items.every(isProposalViewValue) || !isOptionalString(input.agentId)) return invalidServer("invalid agent.proposals message");
      return validServer(input as unknown as AgentProposalsMessage);
    case AGENT_EVENTS.MEMORY:
      if (!isNonEmptyString(input.agentId) || !Array.isArray(input.items) || !input.items.every(isMemoryViewValue)) return invalidServer("invalid agent.memory message");
      return validServer(input as unknown as AgentMemoryMessage);
    case AGENT_EVENTS.VOICE_SAMPLE:
      if (!isNonEmptyString(input.requestId) || !isNonEmptyString(input.mimeType) || typeof input.audio !== "string") return invalidServer("invalid agent.voice.sample message");
      return validServer(input as unknown as AgentVoiceSampleMessage);
    case AGENT_EVENTS.TURN:
      if (!isNonEmptyString(input.requestId) || !isNonEmptyString(input.agentId) || typeof input.name !== "string" || !isRecord(input.avatar)) {
        return invalidServer("invalid agent.turn message");
      }
      return validServer(input as unknown as AgentTurnMessage);
    default:
      return undefined;
  }
}

/* ── Notifications (v0.4) ── */

/**
 * One feed for everything Sibyl tells you about: routines that finished or
 * failed, budgets that stopped a run, monitors that fired or paused, agents
 * that acted on their own ("act, then tell me"), decks that are ready,
 * accepted invitations and approvals waiting for you. Pending approvals stay
 * approvals (inbox.list / approval.decision); their `approval_needed`
 * notification links to the approval and is marked read when it is decided.
 *
 * WebSocket (workspace = the connection's current workspace; you only get
 * notifications you may see: addressed to you or to everyone with access to
 * the source):
 *
 *   client `notifications.request` {cursor?, limit?, kinds?}  → `notifications.list` (newest first, paged)
 *   client `notifications.read` {id} | {all: true}             → `notifications.state` (to every tab of yours)
 *   gateway `notification`                                      (live: a new notification for you)
 */
export const NOTIFICATION_EVENTS = {
  REQUEST: "notifications.request",
  LIST: "notifications.list",
  READ: "notifications.read",
  STATE: "notifications.state",
  NOTIFICATION: "notification"
} as const;

export const NOTIFICATION_KIND_VALUES = [
  "approval_needed",
  "routine_finished",
  "routine_failed",
  "budget_blocked",
  "monitor_fired",
  "monitor_paused",
  "agent_action",
  "deck_ready",
  "invite_accepted",
  "meeting_notes"
] as const;

export type NotificationKindView = (typeof NOTIFICATION_KIND_VALUES)[number];

export interface NotificationLinksView {
  conversationId?: string;
  routineId?: string;
  monitorId?: string;
  agentId?: string;
  artifactId?: string;
  approvalId?: string;
  meetingId?: string;
}

export interface NotificationView {
  id: string;
  kind: NotificationKindView;
  title: string;
  body: string;
  links: NotificationLinksView;
  createdAt: number;
  readAt?: number;
}

/** Your unread notifications in this workspace (byKind leaves out kinds with none). */
export interface NotificationUnreadView {
  total: number;
  byKind: Partial<Record<NotificationKindView, number>>;
}

export const NOTIFICATIONS_PAGE_MAX = 100;
const NOTIFICATION_CURSOR = /^\d{1,16}:[\x21-\x7e]{1,128}$/;
const NOTIFICATION_ID_MAX = 128;

export interface NotificationsRequestMessage {
  type: typeof NOTIFICATION_EVENTS.REQUEST;
  /** `nextCursor` of the previous page (absent: the newest page). */
  cursor?: string;
  /** 1–100 (default 30). */
  limit?: number;
  /** Only these kinds (absent: all). */
  kinds?: NotificationKindView[];
}

export type NotificationsReadMessage =
  | { type: typeof NOTIFICATION_EVENTS.READ; id: string }
  | { type: typeof NOTIFICATION_EVENTS.READ; all: true };

export interface NotificationsListMessage {
  type: typeof NOTIFICATION_EVENTS.LIST;
  items: NotificationView[];
  unread: NotificationUnreadView;
  /** Echo of the request (a page with a cursor continues the list). */
  cursor?: string;
  kinds?: NotificationKindView[];
  /** Absent: no older notifications. */
  nextCursor?: string;
}

export interface NotificationMessage {
  type: typeof NOTIFICATION_EVENTS.NOTIFICATION;
  notification: NotificationView;
  unread: NotificationUnreadView;
}

export interface NotificationsStateMessage {
  type: typeof NOTIFICATION_EVENTS.STATE;
  /** Newly read notifications (all: everything you can see in this workspace is read now). */
  ids: string[];
  all: boolean;
  readAt: number;
  unread: NotificationUnreadView;
}

export type NotificationsClientMessage = NotificationsRequestMessage | NotificationsReadMessage;
export type NotificationsServerMessage = NotificationsListMessage | NotificationMessage | NotificationsStateMessage;

const NOTIFICATION_CLIENT_TYPES = new Set<string>([NOTIFICATION_EVENTS.REQUEST, NOTIFICATION_EVENTS.READ]);

export function isNotificationsClientMessage(message: { type: string }): message is NotificationsClientMessage {
  return NOTIFICATION_CLIENT_TYPES.has(message.type);
}

function isNotificationKinds(value: unknown): value is NotificationKindView[] {
  return Array.isArray(value) && value.length > 0 && value.length <= NOTIFICATION_KIND_VALUES.length && value.every((kind) => isEnum(kind, NOTIFICATION_KIND_VALUES));
}

/** Client messages of this block (called from parseClientMessage). */
function parseNotificationsClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  switch (input.type) {
    case NOTIFICATION_EVENTS.REQUEST: {
      if (input.cursor !== undefined && (typeof input.cursor !== "string" || !NOTIFICATION_CURSOR.test(input.cursor))) return invalid("notifications.request cursor is invalid");
      if (input.limit !== undefined && (!isNonNegativeInteger(input.limit) || input.limit < 1 || input.limit > NOTIFICATIONS_PAGE_MAX)) {
        return invalid(`notifications.request limit must be 1–${NOTIFICATIONS_PAGE_MAX}`);
      }
      if (input.kinds !== undefined && !isNotificationKinds(input.kinds)) return invalid("notifications.request kinds must list notification kinds");
      return valid({
        type: NOTIFICATION_EVENTS.REQUEST,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
        ...(input.limit === undefined ? {} : { limit: input.limit as number }),
        ...(input.kinds === undefined ? {} : { kinds: [...new Set(input.kinds as NotificationKindView[])] })
      });
    }
    case NOTIFICATION_EVENTS.READ:
      if (input.all === true && input.id === undefined) return valid({ type: NOTIFICATION_EVENTS.READ, all: true });
      if (input.all === undefined && isNonEmptyString(input.id) && input.id.length <= NOTIFICATION_ID_MAX) return valid({ type: NOTIFICATION_EVENTS.READ, id: input.id });
      return invalid("notifications.read needs an id or all: true");
    default:
      return undefined;
  }
}

const NOTIFICATION_LINK_KEYS = ["conversationId", "routineId", "monitorId", "agentId", "artifactId", "approvalId", "meetingId"] as const;

function isNotificationView(value: unknown): value is NotificationView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isEnum(value.kind, NOTIFICATION_KIND_VALUES) &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    isRecord(value.links) &&
    Object.keys(value.links).every((key) => (NOTIFICATION_LINK_KEYS as readonly string[]).includes(key)) &&
    NOTIFICATION_LINK_KEYS.every((key) => isOptionalString((value.links as Record<string, unknown>)[key])) &&
    isFiniteNumber(value.createdAt) &&
    isOptionalFiniteNumber(value.readAt)
  );
}

function isNotificationUnread(value: unknown): value is NotificationUnreadView {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.total) &&
    isRecord(value.byKind) &&
    Object.entries(value.byKind).every(([kind, count]) => isEnum(kind, NOTIFICATION_KIND_VALUES) && isNonNegativeInteger(count))
  );
}

/** Server messages of this block (called from parseServerMessage). */
function parseNotificationsServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  switch (input.type) {
    case NOTIFICATION_EVENTS.LIST:
      if (
        !Array.isArray(input.items) ||
        !input.items.every(isNotificationView) ||
        !isNotificationUnread(input.unread) ||
        !isOptionalString(input.cursor) ||
        !isOptionalString(input.nextCursor) ||
        (input.kinds !== undefined && !isNotificationKinds(input.kinds))
      ) {
        return invalidServer("invalid notifications.list message");
      }
      return validServer(input as unknown as NotificationsListMessage);
    case NOTIFICATION_EVENTS.NOTIFICATION:
      if (!isNotificationView(input.notification) || !isNotificationUnread(input.unread)) return invalidServer("invalid notification message");
      return validServer(input as unknown as NotificationMessage);
    case NOTIFICATION_EVENTS.STATE:
      if (
        !Array.isArray(input.ids) ||
        !input.ids.every(isNonEmptyString) ||
        typeof input.all !== "boolean" ||
        !isFiniteNumber(input.readAt) ||
        !isNotificationUnread(input.unread)
      ) {
        return invalidServer("invalid notifications.state message");
      }
      return validServer(input as unknown as NotificationsStateMessage);
    default:
      return undefined;
  }
}

/* ── Presence: agents in Slack and Microsoft Teams (wave C) ── */

/**
 * Agents answer in Slack and Teams channels (when @mentioned, in threads they
 * are part of, or every message when set so), and notifications can go to
 * Slack and Teams. HTTP routes (JSON, same sign-in and workspace header as the
 * other APIs; see docs/slack-and-teams.md):
 *
 *   GET    /api/presence/agents/:agentId                       → PresenceAgentState
 *   POST   /api/presence/agents/:agentId/bindings {PresenceBindingInput} → PresenceAgentState
 *   PATCH  /api/presence/agents/:agentId/bindings/:id {respond} → PresenceAgentState
 *   DELETE /api/presence/agents/:agentId/bindings/:id          → PresenceAgentState
 *   PUT    /api/presence/agents/:agentId/settings {notify}     → PresenceAgentState
 *   GET    /api/presence/channels?provider=slack|teams[&teamId] → PresenceChannelList
 *   GET    /api/presence/settings                              → PresenceWorkspaceSettings
 *   PUT    /api/presence/settings {slack?, teams?}             → PresenceWorkspaceSettings
 *
 * Vendor callbacks (no sign-in; checked by signature / clientState):
 *   POST   /api/presence/slack/events          Slack Events API (v0 HMAC signature)
 *   POST   /api/presence/teams/notifications   Graph change notifications (validationToken, clientState)
 *   POST   /api/presence/teams/lifecycle       Graph lifecycle notifications
 */
export type PresenceProvider = "slack" | "teams";
/** "mentions": when @mentioned, then in that thread; "all": every new message in the channel too. */
export type PresenceRespondMode = "mentions" | "all";

const PRESENCE_PROVIDERS = ["slack", "teams"] as const;
const PRESENCE_RESPOND_MODES = ["mentions", "all"] as const;
const PRESENCE_ID = /^[A-Za-z0-9_:.@-]{1,200}$/;

export interface PresenceBindingView {
  id: string;
  agentId: string;
  provider: PresenceProvider;
  connectionId: string;
  /** Slack: C…/G… id. Teams: the channel id. */
  channelId: string;
  channelName?: string;
  /** Teams only. */
  teamId?: string;
  teamName?: string;
  respond: PresenceRespondMode;
  /** "pending": waiting for its Teams subscription; "error": see statusMessage. */
  status: "active" | "pending" | "error";
  statusMessage?: string;
  createdByName?: string;
  createdAt: number;
  lastActivityAt?: number;
  /** The caller may change or remove it. */
  canEdit: boolean;
}

export interface PresenceProviderStatus {
  provider: PresenceProvider;
  /** A workspace connection that can host agents exists. */
  available: boolean;
  reason?: string;
  account?: string;
}

export interface PresenceAgentState {
  agentId: string;
  bindings: PresenceBindingView[];
  /** Where "act, then tell me" notices also go (the inbox always). */
  notify: PresenceProvider[];
  providers: PresenceProviderStatus[];
  canEdit: boolean;
}

export interface PresenceBindingInput {
  provider: PresenceProvider;
  channelId: string;
  channelName?: string;
  teamId?: string;
  teamName?: string;
  respond: PresenceRespondMode;
}

export interface PresenceChannelOption {
  id: string;
  name: string;
  private?: boolean;
  /** Slack: the app is in the channel (needed to read and answer). */
  appIsMember?: boolean;
}

export interface PresenceChannelList {
  provider: PresenceProvider;
  /** Teams: the teams to pick from (channels are listed for `teamId`). */
  teams?: Array<{ id: string; name: string }>;
  channels: PresenceChannelOption[];
}

export interface PresenceChannelRef {
  channelId: string;
  channelName?: string;
  teamId?: string;
  teamName?: string;
}

export interface PresenceWorkspaceSettings {
  /** Fallback channel for notifications (Slack DMs people by e-mail first). */
  slack?: PresenceChannelRef;
  teams?: PresenceChannelRef;
  providers: PresenceProviderStatus[];
  canManage: boolean;
}

function parseChannelRef(value: unknown, provider: PresenceProvider): PresenceChannelRef | string {
  if (!isRecord(value)) return `${provider} must be an object`;
  if (!isNonEmptyString(value.channelId) || !PRESENCE_ID.test(value.channelId)) return "channelId must be a channel id";
  if (provider === "teams" && (!isNonEmptyString(value.teamId) || !PRESENCE_ID.test(value.teamId))) return "teamId is required for Teams";
  if (provider === "slack" && value.teamId !== undefined) return "teamId is only for Teams";
  for (const key of ["channelName", "teamName"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || (value[key] as string).length > 200)) return `${key} must be text (max 200)`;
  }
  return {
    channelId: value.channelId,
    ...(typeof value.channelName === "string" && value.channelName.trim() ? { channelName: value.channelName.trim() } : {}),
    ...(typeof value.teamId === "string" ? { teamId: value.teamId } : {}),
    ...(typeof value.teamName === "string" && value.teamName.trim() ? { teamName: value.teamName.trim() } : {})
  };
}

export function parsePresenceBindingInput(input: unknown): PresenceBindingInput | string {
  if (!isRecord(input)) return "send a JSON object";
  if (!isEnum(input.provider, PRESENCE_PROVIDERS)) return 'provider must be "slack" or "teams"';
  const respond = input.respond ?? "mentions";
  if (!isEnum(respond, PRESENCE_RESPOND_MODES)) return 'respond must be "mentions" or "all"';
  const ref = parseChannelRef(input, input.provider);
  if (typeof ref === "string") return ref;
  return { provider: input.provider, ...ref, respond };
}

export function parsePresenceRespond(input: unknown): { respond: PresenceRespondMode } | string {
  if (!isRecord(input) || !isEnum(input.respond, PRESENCE_RESPOND_MODES)) return 'respond must be "mentions" or "all"';
  return { respond: input.respond };
}

export function parsePresenceAgentSettings(input: unknown): { notify: PresenceProvider[] } | string {
  if (!isRecord(input) || !Array.isArray(input.notify) || input.notify.length > 2 || !input.notify.every((p) => isEnum(p, PRESENCE_PROVIDERS))) {
    return 'notify must list "slack" and/or "teams"';
  }
  return { notify: [...new Set(input.notify as PresenceProvider[])] };
}

/** PUT /api/presence/settings: a provider set to null clears its channel; absent keeps it. */
export function parsePresenceWorkspaceSettings(input: unknown): { slack?: PresenceChannelRef | null; teams?: PresenceChannelRef | null } | string {
  if (!isRecord(input)) return "send a JSON object";
  const out: { slack?: PresenceChannelRef | null; teams?: PresenceChannelRef | null } = {};
  for (const provider of PRESENCE_PROVIDERS) {
    const value = input[provider];
    if (value === undefined) continue;
    if (value === null) {
      out[provider] = null;
      continue;
    }
    const ref = parseChannelRef(value, provider);
    if (typeof ref === "string") return ref;
    out[provider] = ref;
  }
  return out;
}

/* ── File formats (uploads & knowledge) ── */
/*
 * The one list of file types Sibyl accepts, shared by the gateway (type
 * detection, extraction) and the web app (file pickers, "supported types").
 * The gateway still decides from the bytes; the extension picks the reader.
 */

export type FileKind =
  | "image"
  | "pdf"
  | "text"
  | "markdown"
  | "csv"
  | "tsv"
  | "json"
  | "yaml"
  | "xml"
  | "toml"
  | "ini"
  | "html"
  | "rtf"
  | "eml"
  | "code"
  | "docx"
  | "xlsx"
  | "pptx"
  | "odt"
  | "ods"
  | "odp"
  | "epub"
  | "zip"
  | "video"
  | "audio";

export interface FileFormat {
  /** Lower-case extension with the dot. */
  ext: string;
  kind: FileKind;
  /** Plain name, e.g. "PowerPoint" or "Python". */
  label: string;
}

/** Countable parts of a document (pages, slides, sheets, chapters, files in an archive). */
export interface FileParts {
  unit: "page" | "slide" | "sheet" | "chapter" | "file";
  count: number;
}

const CODE_LANGUAGES: Record<string, string> = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript (JSX)",
  ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".tsx": "TypeScript (TSX)",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
  ".swift": "Swift", ".rb": "Ruby", ".php": "PHP", ".c": "C", ".h": "C header", ".cpp": "C++", ".cc": "C++",
  ".cxx": "C++", ".hpp": "C++ header", ".hh": "C++ header", ".cs": "C#", ".m": "Objective-C", ".mm": "Objective-C++",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".fish": "Shell", ".ps1": "PowerShell", ".sql": "SQL",
  ".css": "CSS", ".scss": "SCSS", ".sass": "Sass", ".less": "Less", ".vue": "Vue", ".svelte": "Svelte", ".astro": "Astro",
  ".scala": "Scala", ".dart": "Dart", ".lua": "Lua", ".r": "R", ".pl": "Perl", ".ex": "Elixir", ".exs": "Elixir",
  ".erl": "Erlang", ".hs": "Haskell", ".clj": "Clojure", ".fs": "F#", ".jl": "Julia", ".groovy": "Groovy",
  ".gradle": "Gradle", ".graphql": "GraphQL", ".gql": "GraphQL", ".proto": "Protocol Buffers", ".tf": "Terraform",
  ".zig": "Zig", ".nim": "Nim", ".sol": "Solidity"
};

export const FILE_FORMATS: readonly FileFormat[] = [
  { ext: ".png", kind: "image", label: "PNG image" },
  { ext: ".jpg", kind: "image", label: "JPEG image" },
  { ext: ".jpeg", kind: "image", label: "JPEG image" },
  { ext: ".webp", kind: "image", label: "WebP image" },
  { ext: ".gif", kind: "image", label: "GIF image" },
  { ext: ".mp4", kind: "video", label: "MP4 video" },
  { ext: ".webm", kind: "video", label: "WebM video" },
  { ext: ".mov", kind: "video", label: "QuickTime video" },
  { ext: ".mp3", kind: "audio", label: "MP3 audio" },
  { ext: ".wav", kind: "audio", label: "WAV audio" },
  { ext: ".m4a", kind: "audio", label: "M4A audio" },
  { ext: ".ogg", kind: "audio", label: "Ogg audio" },
  { ext: ".pdf", kind: "pdf", label: "PDF" },
  { ext: ".docx", kind: "docx", label: "Word" },
  { ext: ".xlsx", kind: "xlsx", label: "Excel" },
  { ext: ".pptx", kind: "pptx", label: "PowerPoint" },
  { ext: ".odt", kind: "odt", label: "OpenDocument text" },
  { ext: ".ods", kind: "ods", label: "OpenDocument spreadsheet" },
  { ext: ".odp", kind: "odp", label: "OpenDocument presentation" },
  { ext: ".epub", kind: "epub", label: "EPUB e-book" },
  { ext: ".rtf", kind: "rtf", label: "Rich Text" },
  { ext: ".html", kind: "html", label: "HTML page" },
  { ext: ".htm", kind: "html", label: "HTML page" },
  { ext: ".eml", kind: "eml", label: "Email" },
  { ext: ".txt", kind: "text", label: "Text" },
  { ext: ".text", kind: "text", label: "Text" },
  { ext: ".log", kind: "text", label: "Log" },
  { ext: ".rst", kind: "text", label: "reStructuredText" },
  { ext: ".tex", kind: "text", label: "LaTeX" },
  { ext: ".md", kind: "markdown", label: "Markdown" },
  { ext: ".markdown", kind: "markdown", label: "Markdown" },
  { ext: ".mdx", kind: "markdown", label: "MDX" },
  { ext: ".csv", kind: "csv", label: "CSV" },
  { ext: ".tsv", kind: "tsv", label: "TSV" },
  { ext: ".json", kind: "json", label: "JSON" },
  { ext: ".yaml", kind: "yaml", label: "YAML" },
  { ext: ".yml", kind: "yaml", label: "YAML" },
  { ext: ".xml", kind: "xml", label: "XML" },
  { ext: ".toml", kind: "toml", label: "TOML" },
  { ext: ".ini", kind: "ini", label: "INI" },
  { ext: ".cfg", kind: "ini", label: "Config (INI)" },
  { ext: ".zip", kind: "zip", label: "ZIP archive" },
  ...Object.entries(CODE_LANGUAGES).map(([ext, label]) => ({ ext, kind: "code" as const, label }))
];

const FORMAT_BY_EXT = new Map(FILE_FORMATS.map((format) => [format.ext, format]));

/** Every accepted extension (for `<input accept>`). */
export const ACCEPTED_FILE_EXTENSIONS: readonly string[] = FILE_FORMATS.map((format) => format.ext);

/** Lower-case extension of a file name (".tar.gz" → ".gz"), or "". */
export function fileExtension(name: string): string {
  const match = /\.[A-Za-z0-9]{1,10}$/.exec(name);
  return match ? match[0].toLowerCase() : "";
}

export function fileFormatFor(name: string): FileFormat | undefined {
  return FORMAT_BY_EXT.get(fileExtension(name));
}

/** Old binary Office files are refused with this hint (no maintained, safe parser; see docs/knowledge.md). */
export const LEGACY_OFFICE_FORMATS: Readonly<Record<string, string>> = { ".doc": ".docx", ".xls": ".xlsx", ".ppt": ".pptx" };

/** Files that usually hold secrets are never accepted, whatever their extension. */
const SECRET_FILE =
  /^(\.env(\..*)?|.+\.env|\.envrc|\.npmrc|\.pypirc|\.netrc|_netrc|\.pgpass|\.git-credentials|\.htpasswd|\.dockercfg|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml|ini)|.*service[-_]?account.*\.json|.+\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|gpg|asc))$/i;

export function isSecretFileName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return SECRET_FILE.test(base.trim());
}

/** The supported types in plain words, grouped (the add-files area and docs). */
export const FILE_FORMAT_GROUPS: ReadonlyArray<{ label: string; detail: string }> = [
  { label: "Documents", detail: "PDF (scanned pages too), Word, PowerPoint with speaker notes, OpenDocument text and slides, Rich Text, EPUB e-books" },
  { label: "Spreadsheets and data", detail: "Excel, OpenDocument spreadsheets, CSV, TSV, JSON, YAML, XML, TOML, INI" },
  { label: "Web pages and email", detail: "saved HTML pages, emails (.eml)" },
  { label: "Text and code", detail: "plain text, Markdown, and source code (JavaScript, TypeScript, Python, Go, Rust, Java, C, C#, SQL, CSS and more)" },
  { label: "Images", detail: "PNG, JPEG, WebP, GIF (in knowledge, a vision model reads the text and describes the picture)" },
  { label: "Archives", detail: "ZIP: each supported file inside becomes its own document" },
  { label: "Video and audio", detail: "MP4, WebM, MOV, MP3, WAV, M4A, Ogg (in chat and as media references; knowledge does not index them)" }
];

/* ── Enterprise governance: roles, policies, audit (v0.4) ── */

/*
 * HTTP shapes of the Sibyl Enterprise admin APIs (ee/gateway/governance,
 * ee/gateway/audit), shared by the gateway modules and the web app's Admin
 * sections. Without the licence these routes answer 404.
 *
 *   GET/POST /api/admin/roles, PATCH/DELETE /api/admin/roles/:id,
 *   PUT /api/admin/roles/assignments, PUT /api/admin/roles/grants   (org.settings)
 *   GET/PUT /api/admin/policies, POST /api/admin/policies/retention/run,
 *   GET /api/admin/approvals, POST /api/admin/approvals/:id         (org.settings)
 *   GET /api/admin/audit, /verify, /export, GET/PUT/DELETE /stream, POST /stream/test (audit.view)
 */

export interface AdminCustomRoleView {
  id: string;
  name: string;
  description?: string;
  /** Permission ids from the catalogue (packages/core/src/permissions.ts). */
  permissions: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AdminRoleAssignmentView {
  userId: string;
  roleId: string;
  /** "org" or a workspace id. */
  scope: string;
  assignedAt: number;
}

export interface AdminResourceGrantView {
  id: string;
  resource: { kind: "connection"; id: string; name?: string };
  /** Built-in role names and custom role ids. */
  roles: string[];
  userIds: string[];
  updatedAt: number;
}

export interface AdminRolesState {
  roles: AdminCustomRoleView[];
  assignments: AdminRoleAssignmentView[];
  grants: AdminResourceGrantView[];
  /** The permission catalogue; `org`: granted by organization roles only. */
  permissions: Array<{ id: string; org: boolean }>;
  builtInRoles: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string; email: string }>;
  workspaces: Array<{ id: string; name: string }>;
  /** Shared connections a grant can limit. */
  connections: Array<{ id: string; connectorId: string; workspaceId: string; name: string }>;
}

export type AdminSecondApprovalMode = "off" | "high_risk" | "all_writes" | "listed";

export interface AdminPoliciesView {
  /** Tool names, or "provider:<id>" for every tool of a provider. */
  blockedTools: string[];
  secondApproval: { mode: AdminSecondApprovalMode; tools: string[] };
  /** Empty: every model in the catalogue. */
  modelAllowlist: string[];
  retention: { chatsDays?: number; uploadsDays?: number; notificationsDays?: number };
  updatedAt?: number;
}

export interface AdminPoliciesState {
  policies: AdminPoliciesView;
  tools: Array<{ name: string; title: string; effect: "read" | "write"; source: string; provider?: string; risk?: "high" }>;
}

export interface AdminAuditActorView {
  kind: "user" | "token" | "local" | "system";
  userId?: string;
  email?: string;
  name?: string;
}

export interface AdminSecondApprovalItem {
  approval: ApprovalView;
  requestedBy: AdminAuditActorView;
  workspaceId?: string;
}

export interface AdminAuditEntryView {
  seq: number;
  id: string;
  at: number;
  action: string;
  actor: AdminAuditActorView;
  workspaceId?: string;
  target?: { kind: string; id?: string; name?: string };
  outcome: "success" | "failure" | "denied";
  details?: Record<string, string | number | boolean | null | readonly string[]>;
  ip?: string;
  prevHash: string;
  hash: string;
}

export interface AdminAuditListResponse {
  entries: AdminAuditEntryView[];
  /** Pass as `before` for the next (older) page. */
  next?: number;
}

export interface AdminAuditVerifyResponse {
  ok: boolean;
  checked: number;
  lastSeq: number;
  lastHash: string;
  problem?: { seq: number; reason: "hash_mismatch" | "chain_broken" | "gap"; message: string };
}

export interface AdminAuditStreamView {
  configured: boolean;
  url?: string;
  enabled?: boolean;
  cursor?: number;
  lastDeliveredAt?: number;
  lastError?: string;
  /** Only in the reply that created or rotated the signing secret. */
  secret?: string;
}

/* ── Sign-in providers, two-step verification, SSO, SCIM & session policies (v0.4) ── */

/**
 * Open source: two-step verification (TOTP) for password sign-ins, and the
 * sign-in provider list (password only). Sibyl Enterprise adds SSO (OIDC,
 * SAML), SCIM provisioning and session policies. HTTP routes:
 *
 *   GET    /api/auth/providers                    → SignInProvidersResponse (no sign-in)
 *   POST   /api/auth/login {email,password}       → SignInResponse (mfa set: second step needed)
 *   POST   /api/auth/mfa/verify {challenge,code?,recoveryCode?} → SignInResponse (+ recoveryCodes after enrolling)
 *   GET    /api/auth/mfa                          → MfaStatusView
 *   POST   /api/auth/mfa/setup                    → MfaSetupResponse
 *   POST   /api/auth/mfa/enable {setupToken,code} → { recoveryCodes, status }
 *   POST   /api/auth/mfa/disable {code|recoveryCode}        → { status }
 *   POST   /api/auth/mfa/recovery-codes {code|recoveryCode} → { recoveryCodes, status }
 *
 * Enterprise (org.settings unless noted):
 *   GET    /api/sso/:providerId/start?next=       browser navigation → identity provider (no sign-in)
 *   GET    /api/sso/oidc/:providerId/callback     OIDC redirect URI
 *   POST   /api/sso/saml/:providerId/acs          SAML assertion consumer service
 *   GET    /api/sso/complete?ticket=              finishes a SAML sign-in in the browser
 *   GET    /api/sso/saml/:providerId/metadata     SP metadata XML (no sign-in)
 *   GET    /api/sso/config                        → SsoConfigView
 *   PUT    /api/sso/config {enforce,breakGlassUserId}
 *   POST   /api/sso/providers SsoProviderInput    → { provider }
 *   PATCH  /api/sso/providers/:id SsoProviderInput → { provider }
 *   DELETE /api/sso/providers/:id
 *   POST   /api/sso/providers/:id/test            → { ok, message }
 *   GET|PUT /api/directory                        → DirectorySettingsView (new people, group → role)
 *   GET|PUT /api/session-policy                   → SessionPolicyView
 *   GET    /api/scim/tokens                       → { tokens, baseUrl }
 *   POST   /api/scim/tokens {label}               → { token, secret } (secret shown once)
 *   DELETE /api/scim/tokens/:id
 *   /scim/v2/{Users,Groups,ServiceProviderConfig,ResourceTypes,Schemas}  SCIM 2.0 (Bearer SCIM token)
 */
export interface SignInProviderView {
  id: string;
  kind: "oidc" | "saml";
  label: string;
  /** Gateway path that starts the sign-in (navigate the browser to gateway + path + `?next=`). */
  startPath: string;
}

export interface SignInProvidersResponse {
  /** Email + password sign-in is offered (always: SSO-enforced domains are refused per account). */
  password: boolean;
  providers: SignInProviderView[];
}

export interface MfaChallengeView {
  /** "verify": enter a code; "enroll": add an authenticator app first (the organization requires it). */
  step: "verify" | "enroll";
  challenge: string;
  /** For "enroll": base32 secret and otpauth:// URL for the authenticator app. */
  secret?: string;
  otpauthUrl?: string;
  /** The organization the challenge belongs to; send it back (x-sibyl-org) with the code. */
  org?: string;
}

/** Answer to sign-in calls: signed in (AuthMeResponse), or `mfa` when a code is still needed. */
export type SignInResponse = AuthMeResponse & {
  mfa?: MfaChallengeView;
  /** Shown once, right after enrolling during sign-in. */
  recoveryCodes?: string[];
  workspaceId?: string;
};

export interface MfaStatusView {
  enabled: boolean;
  enabledAt?: number;
  recoveryCodesLeft: number;
  /** False when the gateway has no secrets key (two-step verification can't be turned on). */
  available: boolean;
  /** The account has a password (false: it signs in through SSO only). */
  passwordSignIn?: boolean;
}

export interface MfaSetupResponse {
  setupToken: string;
  secret: string;
  otpauthUrl: string;
}

export interface SsoProviderView {
  id: string;
  kind: "oidc" | "saml";
  label: string;
  enabled: boolean;
  /** Email domains this provider signs people in for (domain claim). */
  domains: string[];
  oidc?: {
    issuer: string;
    clientId: string;
    /** A client secret is stored in the vault (never returned). */
    hasClientSecret: boolean;
    scopes: string[];
    groupsClaim: string;
    /** Register this as the redirect URI at the identity provider. */
    redirectUri: string;
  };
  saml?: {
    entryPoint: string;
    idpIssuer?: string;
    /** The IdP signing certificate's subject and expiry (the certificate itself is not returned). */
    certificate: { subject: string; expiresAt: string } | null;
    emailAttribute: string;
    nameAttribute: string;
    groupsAttribute: string;
    /** SP entity ID (audience) and assertion consumer service URL to register at the IdP. */
    spEntityId: string;
    acsUrl: string;
    metadataUrl: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface SsoProviderInput {
  kind?: "oidc" | "saml";
  label?: string;
  enabled?: boolean;
  domains?: string[];
  oidc?: { issuer?: string; clientId?: string; clientSecret?: string; scopes?: string[]; groupsClaim?: string };
  saml?: {
    entryPoint?: string;
    idpIssuer?: string;
    /** PEM (or base64 DER) signing certificate of the IdP. */
    certificate?: string;
    emailAttribute?: string;
    nameAttribute?: string;
    groupsAttribute?: string;
  };
}

export interface SsoConfigView {
  providers: SsoProviderView[];
  /** Password sign-in is refused for emails in the providers' domains. */
  enforce: boolean;
  /** Org owner who keeps password sign-in when SSO is enforced (break-glass). */
  breakGlassUserId?: string;
  owners: Array<{ id: string; name: string; email: string }>;
}

export interface GroupRoleRule {
  /** Group name (SSO groups claim/attribute, or SCIM group display name). */
  group: string;
  workspaceId: string;
  role: IdentityRole;
}

export interface DirectorySettingsView {
  /** Where people created by SSO (just-in-time) or SCIM land, and with which role. */
  defaultWorkspaceId: string;
  defaultRole: IdentityRole;
  /** Create accounts at first SSO sign-in (otherwise only existing or provisioned people sign in). */
  jitProvisioning: boolean;
  groupRoles: GroupRoleRule[];
  workspaces: Array<{ id: string; name: string }>;
}

export interface SessionPolicyView {
  /** Hours from sign-in until the session ends regardless of use (absent: 30 days, sliding). */
  maxSessionHours?: number;
  /** Minutes without activity before the session ends (absent: no idle timeout). */
  idleTimeoutMinutes?: number;
  /** CIDR ranges people may sign in and use sessions from (empty: anywhere). */
  ipAllowlist: string[];
  /** Password sign-ins need two-step verification (people without it add it at their next sign-in). */
  requireMfa: boolean;
  /** The caller's address as the gateway sees it (to avoid locking yourself out). */
  yourIp?: string;
}

export interface ScimTokenView {
  id: string;
  label: string;
  /** First characters, to recognise it. */
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
}

/* ── Agent computers (wave C) ── */
/*
 * Each agent can have its own sandboxed computer: a container with a real
 * browser and a file area (docs/agent-computers.md). Its settings live on
 * the agent (`AgentInput.computer`). Over the WebSocket:
 *
 * - `computers.info.request` → `computers.info`: is the feature available on
 *   this gateway (Docker reachable, image present) and the default limits.
 * - `computer.watch` / `computer.unwatch`: live status, actions and screen
 *   frames of one agent's computer, for people who can see that agent.
 * - `computer.stop`: stop the sandbox now.
 * - `computer.timeline.request` → `computer.timeline`: a run's actions with
 *   thumbnails, to watch afterwards.
 */

export const COMPUTER_EVENTS = {
  /** Client → gateway. */
  INFO_REQUEST: "computers.info.request",
  WATCH: "computer.watch",
  UNWATCH: "computer.unwatch",
  STOP: "computer.stop",
  TIMELINE_REQUEST: "computer.timeline.request",
  /** Gateway → client. */
  INFO: "computers.info",
  STATUS: "computer.status",
  FRAME: "computer.frame",
  ACTION: "computer.action",
  TIMELINE: "computer.timeline"
} as const;

/** Bounds for an agent's computer settings (the editor shows the same numbers). */
export const AGENT_COMPUTER_LIMITS = {
  idleMinutes: { min: 1, max: 120 },
  dailyMinutes: { min: 1, max: 1_440 }
} as const;

export interface AgentComputerSettingsView {
  enabled: boolean;
  /** Stop the sandbox after this many idle minutes (absent: the gateway's default). */
  idleMinutes?: number;
  /** Computer time per day before it pauses (absent: the gateway's default). */
  dailyMinutes?: number;
}

export const COMPUTER_STATE_VALUES = ["off", "starting", "running", "paused", "unavailable", "disabled"] as const;
export type ComputerStateView = (typeof COMPUTER_STATE_VALUES)[number];

export interface ComputerStatusView {
  agentId: string;
  /**
   * off: not running (starts on the agent's next browser action); paused: a
   * limit was reached (`reason` says which); unavailable: the gateway can't
   * run sandboxes (`reason` says why); disabled: the agent has no computer.
   */
  state: ComputerStateView;
  reason?: string;
  url?: string;
  title?: string;
  startedAt?: number;
  lastActionAt?: number;
  /** The run using it now (or last). */
  runId?: string;
  usedSecondsToday: number;
  dailyMinutes: number;
  idleMinutes: number;
}

export const COMPUTER_ACTION_STATUS_VALUES = ["ok", "error", "blocked"] as const;

export interface ComputerActionView {
  id: string;
  agentId: string;
  runId: string;
  at: number;
  /** Tool name (computer_open, computer_click, …). */
  tool: string;
  /** What happened, in a few words ("Opened example.com"). */
  label: string;
  url?: string;
  status: (typeof COMPUTER_ACTION_STATUS_VALUES)[number];
  detail?: string;
  /** Base64 JPEG thumbnail (timeline replies only). */
  thumb?: string;
}

export interface ComputerRunView {
  runId: string;
  startedAt: number;
  endedAt: number;
  actions: number;
}

export interface ComputersInfoRequestMessage {
  type: typeof COMPUTER_EVENTS.INFO_REQUEST;
}
export interface ComputerWatchMessage {
  type: typeof COMPUTER_EVENTS.WATCH;
  agentId: string;
}
export interface ComputerUnwatchMessage {
  type: typeof COMPUTER_EVENTS.UNWATCH;
  agentId: string;
}
export interface ComputerStopMessage {
  type: typeof COMPUTER_EVENTS.STOP;
  agentId: string;
}
export interface ComputerTimelineRequestMessage {
  type: typeof COMPUTER_EVENTS.TIMELINE_REQUEST;
  agentId: string;
  /** Absent: the latest run. */
  runId?: string;
}

export interface ComputersInfoMessage {
  type: typeof COMPUTER_EVENTS.INFO;
  available: boolean;
  reason?: string;
  defaults: { idleMinutes: number; dailyMinutes: number };
}
export interface ComputerStatusMessage {
  type: typeof COMPUTER_EVENTS.STATUS;
  status: ComputerStatusView;
}
export interface ComputerFrameMessage {
  type: typeof COMPUTER_EVENTS.FRAME;
  agentId: string;
  mimeType: "image/jpeg";
  /** Base64 JPEG of the browser viewport. */
  data: string;
  width: number;
  height: number;
  at: number;
}
export interface ComputerActionMessage {
  type: typeof COMPUTER_EVENTS.ACTION;
  action: ComputerActionView;
}
export interface ComputerTimelineMessage {
  type: typeof COMPUTER_EVENTS.TIMELINE;
  agentId: string;
  /** Newest first. */
  runs: ComputerRunView[];
  /** The run shown in `actions` (absent: no runs yet). */
  runId?: string;
  actions: ComputerActionView[];
}

export type ComputersClientMessage =
  | ComputersInfoRequestMessage
  | ComputerWatchMessage
  | ComputerUnwatchMessage
  | ComputerStopMessage
  | ComputerTimelineRequestMessage;
export type ComputersServerMessage = ComputersInfoMessage | ComputerStatusMessage | ComputerFrameMessage | ComputerActionMessage | ComputerTimelineMessage;

const COMPUTER_CLIENT_TYPES: ReadonlySet<string> = new Set([
  COMPUTER_EVENTS.INFO_REQUEST,
  COMPUTER_EVENTS.WATCH,
  COMPUTER_EVENTS.UNWATCH,
  COMPUTER_EVENTS.STOP,
  COMPUTER_EVENTS.TIMELINE_REQUEST
]);

export function isComputersClientMessage(message: { type: string }): message is ComputersClientMessage {
  return COMPUTER_CLIENT_TYPES.has(message.type);
}

const COMPUTER_SERVER_TYPES: ReadonlySet<string> = new Set([
  COMPUTER_EVENTS.INFO,
  COMPUTER_EVENTS.STATUS,
  COMPUTER_EVENTS.FRAME,
  COMPUTER_EVENTS.ACTION,
  COMPUTER_EVENTS.TIMELINE
]);

export function isComputersServerMessage(message: { type: string }): message is ComputersServerMessage {
  return COMPUTER_SERVER_TYPES.has(message.type);
}

/** An agent's computer settings from the browser: the settings, undefined (absent), or an error sentence. */
export function parseAgentComputerSettings(value: unknown): ParseResult<AgentComputerSettingsView | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!isRecord(value) || typeof value.enabled !== "boolean") return fail("computer must be an object with enabled true or false");
  const out: AgentComputerSettingsView = { enabled: value.enabled };
  for (const key of ["idleMinutes", "dailyMinutes"] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    const { min, max } = AGENT_COMPUTER_LIMITS[key];
    if (!isFiniteNumber(raw) || !Number.isInteger(raw) || raw < min || raw > max) return fail(`computer ${key} must be a whole number from ${min} to ${max}`);
    out[key] = raw;
  }
  return ok(out);
}

function parseComputersClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  switch (input.type) {
    case COMPUTER_EVENTS.INFO_REQUEST:
      return valid({ type: COMPUTER_EVENTS.INFO_REQUEST });
    case COMPUTER_EVENTS.WATCH:
    case COMPUTER_EVENTS.UNWATCH:
    case COMPUTER_EVENTS.STOP:
      if (!isAgentId(input.agentId)) return invalid(`${input.type} agentId is invalid`);
      return valid({ type: input.type, agentId: input.agentId });
    case COMPUTER_EVENTS.TIMELINE_REQUEST:
      if (!isAgentId(input.agentId)) return invalid("computer.timeline.request agentId is invalid");
      if (input.runId !== undefined && !isAgentId(input.runId)) return invalid("computer.timeline.request runId is invalid");
      return valid({ type: COMPUTER_EVENTS.TIMELINE_REQUEST, agentId: input.agentId, ...(input.runId === undefined ? {} : { runId: input.runId as string }) });
    default:
      return undefined;
  }
}

function isComputerStatusView(value: unknown): value is ComputerStatusView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agentId) &&
    isEnum(value.state, COMPUTER_STATE_VALUES) &&
    isOptionalString(value.reason) &&
    isOptionalString(value.url) &&
    isOptionalString(value.title) &&
    isOptionalFiniteNumber(value.startedAt) &&
    isOptionalFiniteNumber(value.lastActionAt) &&
    isOptionalString(value.runId) &&
    isFiniteNumber(value.usedSecondsToday) &&
    isFiniteNumber(value.dailyMinutes) &&
    isFiniteNumber(value.idleMinutes)
  );
}

function isComputerActionView(value: unknown): value is ComputerActionView {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.runId) &&
    isFiniteNumber(value.at) &&
    isNonEmptyString(value.tool) &&
    typeof value.label === "string" &&
    isOptionalString(value.url) &&
    isEnum(value.status, COMPUTER_ACTION_STATUS_VALUES) &&
    isOptionalString(value.detail) &&
    isOptionalString(value.thumb)
  );
}

function isComputerRunView(value: unknown): value is ComputerRunView {
  return isRecord(value) && isNonEmptyString(value.runId) && isFiniteNumber(value.startedAt) && isFiniteNumber(value.endedAt) && isFiniteNumber(value.actions);
}

function parseComputersServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  switch (input.type) {
    case COMPUTER_EVENTS.INFO:
      if (
        typeof input.available !== "boolean" ||
        !isOptionalString(input.reason) ||
        !isRecord(input.defaults) ||
        !isFiniteNumber(input.defaults.idleMinutes) ||
        !isFiniteNumber(input.defaults.dailyMinutes)
      ) {
        return invalidServer("invalid computers.info message");
      }
      return validServer(input as unknown as ComputersInfoMessage);
    case COMPUTER_EVENTS.STATUS:
      if (!isComputerStatusView(input.status)) return invalidServer("invalid computer.status message");
      return validServer(input as unknown as ComputerStatusMessage);
    case COMPUTER_EVENTS.FRAME:
      if (
        !isNonEmptyString(input.agentId) ||
        input.mimeType !== "image/jpeg" ||
        !isNonEmptyString(input.data) ||
        !isFiniteNumber(input.width) ||
        !isFiniteNumber(input.height) ||
        !isFiniteNumber(input.at)
      ) {
        return invalidServer("invalid computer.frame message");
      }
      return validServer(input as unknown as ComputerFrameMessage);
    case COMPUTER_EVENTS.ACTION:
      if (!isComputerActionView(input.action)) return invalidServer("invalid computer.action message");
      return validServer(input as unknown as ComputerActionMessage);
    case COMPUTER_EVENTS.TIMELINE:
      if (
        !isNonEmptyString(input.agentId) ||
        !Array.isArray(input.runs) ||
        !input.runs.every(isComputerRunView) ||
        !isOptionalString(input.runId) ||
        !Array.isArray(input.actions) ||
        !input.actions.every(isComputerActionView)
      ) {
        return invalidServer("invalid computer.timeline message");
      }
      return validServer(input as unknown as ComputerTimelineMessage);
    default:
      return undefined;
  }
}

/* ── Realtime (LiveKit, wave C) ── */
/*
 * Optional WebRTC media layer (docs/realtime.md). When the gateway has
 * LIVEKIT_* configured, session.config carries `capabilities.realtime` and the
 * web app runs voice through a LiveKit room instead of audio.chunk /
 * tts.chunk. Everything else (transcripts, replies, visuals, approvals,
 * history) stays on this socket.
 *
 * - `realtime.join`: bring this connection's Sibyl into a room. Without
 *   `callId` it is the private voice room of the connection's current
 *   conversation; with `callId` it is a group call the caller hosts.
 *   Answered with `realtime.joined` (server URL + an access token for the
 *   caller) or an `error`.
 * - `realtime.leave`: Sibyl leaves (the browser disconnects on its own).
 * - `realtime.floor`: the host hands the floor to Sibyl ("sibyl") or one of
 *   their agents (agent id), or takes it back (null).
 * - `realtime.invite`: an agent joins the call as a participant (own voice
 *   and avatar) before it is addressed.
 * - `realtime.turn`: the room agent detected a spoken turn (server-side VAD);
 *   the browser shows it like its own live turns.
 */

export const REALTIME_EVENTS = {
  /** Client → gateway. */
  JOIN: "realtime.join",
  LEAVE: "realtime.leave",
  FLOOR: "realtime.floor",
  INVITE: "realtime.invite",
  /** Gateway → client. */
  JOINED: "realtime.joined",
  LEFT: "realtime.left",
  TURN: "realtime.turn"
} as const;

export interface RealtimeCapability {
  /** LiveKit server URL the browser connects to (wss://…). */
  url: string;
  /** Phone calls are set up (an outbound SIP trunk is configured). */
  phone: boolean;
}

export const REALTIME_CALL_ID = /^[A-Za-z0-9_-]{6,64}$/;
/** Floor holder meaning Sibyl herself (otherwise an agent id). */
export const REALTIME_FLOOR_SIBYL = "sibyl";

export interface RealtimeJoinMessage {
  type: typeof REALTIME_EVENTS.JOIN;
  /** Absent: the voice room of the current conversation. */
  callId?: string;
}

export interface RealtimeLeaveMessage {
  type: typeof REALTIME_EVENTS.LEAVE;
}

export interface RealtimeFloorMessage {
  type: typeof REALTIME_EVENTS.FLOOR;
  /** "sibyl", an agent id, or null to take the floor back. */
  holder: string | null;
}

export interface RealtimeInviteMessage {
  type: typeof REALTIME_EVENTS.INVITE;
  agentId: string;
}

export type RealtimeClientMessage = RealtimeJoinMessage | RealtimeLeaveMessage | RealtimeFloorMessage | RealtimeInviteMessage;

export interface RealtimeJoinedMessage {
  type: typeof REALTIME_EVENTS.JOINED;
  url: string;
  token: string;
  room: string;
  /** The caller's participant identity in the room. */
  identity: string;
  kind: "voice" | "call";
  callId?: string;
}

export interface RealtimeLeftMessage {
  type: typeof REALTIME_EVENTS.LEFT;
  room: string;
  reason: string;
}

export interface RealtimeTurnMessage {
  type: typeof REALTIME_EVENTS.TURN;
  requestId: string;
  phase: "start" | "end" | "cancel";
  /** Participant identity of the speaker (user:<id>, phone:<id>, …). */
  speaker: string;
}

export type RealtimeServerMessage = RealtimeJoinedMessage | RealtimeLeftMessage | RealtimeTurnMessage;

const REALTIME_CLIENT_TYPES: ReadonlySet<string> = new Set([REALTIME_EVENTS.JOIN, REALTIME_EVENTS.LEAVE, REALTIME_EVENTS.FLOOR, REALTIME_EVENTS.INVITE]);

export function isRealtimeClientMessage(message: { type: string }): message is RealtimeClientMessage {
  return REALTIME_CLIENT_TYPES.has(message.type);
}

function isRealtimeCapability(value: unknown): value is RealtimeCapability {
  return isRecord(value) && isNonEmptyString(value.url) && typeof value.phone === "boolean";
}

/** Client messages of this block (called from parseClientMessage). */
function parseRealtimeClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  switch (input.type) {
    case REALTIME_EVENTS.JOIN:
      if (input.callId !== undefined && (typeof input.callId !== "string" || !REALTIME_CALL_ID.test(input.callId))) {
        return invalid("realtime.join callId is invalid");
      }
      return valid({ type: REALTIME_EVENTS.JOIN, ...(typeof input.callId === "string" ? { callId: input.callId } : {}) });
    case REALTIME_EVENTS.LEAVE:
      return valid({ type: REALTIME_EVENTS.LEAVE });
    case REALTIME_EVENTS.FLOOR:
      if (input.holder !== null && input.holder !== REALTIME_FLOOR_SIBYL && !isAgentId(input.holder)) {
        return invalid('realtime.floor holder must be "sibyl", an agent id or null');
      }
      return valid({ type: REALTIME_EVENTS.FLOOR, holder: input.holder as string | null });
    case REALTIME_EVENTS.INVITE:
      if (!isAgentId(input.agentId)) return invalid("realtime.invite agentId is invalid");
      return valid({ type: REALTIME_EVENTS.INVITE, agentId: input.agentId });
    default:
      return undefined;
  }
}

/** Server messages of this block (called from parseServerMessage). */
function parseRealtimeServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  switch (input.type) {
    case REALTIME_EVENTS.JOINED:
      if (
        !isNonEmptyString(input.url) ||
        !isNonEmptyString(input.token) ||
        !isNonEmptyString(input.room) ||
        !isNonEmptyString(input.identity) ||
        (input.kind !== "voice" && input.kind !== "call") ||
        !isOptionalString(input.callId)
      ) {
        return invalidServer("invalid realtime.joined message");
      }
      return validServer(input as unknown as RealtimeJoinedMessage);
    case REALTIME_EVENTS.LEFT:
      if (!isNonEmptyString(input.room) || typeof input.reason !== "string") return invalidServer("invalid realtime.left message");
      return validServer(input as unknown as RealtimeLeftMessage);
    case REALTIME_EVENTS.TURN:
      if (!isNonEmptyString(input.requestId) || !isEnum(input.phase, ["start", "end", "cancel"] as const) || !isNonEmptyString(input.speaker)) {
        return invalidServer("invalid realtime.turn message");
      }
      return validServer(input as unknown as RealtimeTurnMessage);
    default:
      return undefined;
  }
}

/* ── Admin: organization and users (wave C) ── */
/*
 * HTTP (org.settings, behind the gateway's route map):
 *   GET    /api/admin/org                     → OrgView
 *   PATCH  /api/admin/org                     { name?, defaultWorkspaceId? (null: none), defaultRole?, budget? } → OrgView
 *   GET    /api/admin/users                   → OrgUsersResponse
 *   PATCH  /api/admin/users/:id               { orgRole? , active? } → { user: OrgUserView }
 *   DELETE /api/admin/users/:id               → { ok }
 *   POST   /api/admin/invites/:id/resend      → { invite: OrgInviteView, url, emailed }
 *   DELETE /api/admin/invites/:id             → { ok }
 * Workspaces are created, renamed and deleted with the /api/workspaces routes.
 * Changes reach open sessions as `session.identity` pushes.
 */

/** Roles new people can get by default (never owner). */
export type OrgDefaultRole = "admin" | "member" | "viewer";

/** The organization in /api/auth/me: its name and the invitation default. */
export interface OrgSummary {
  /** Empty when not set. */
  name: string;
  defaultRole: OrgDefaultRole;
}

export interface OrgSettingsView extends OrgSummary {
  /** Every new account also joins this workspace; null: only the workspace they were invited to. */
  defaultWorkspaceId: string | null;
  /** The organization's spending caps set here (USD; absent: none). PATCH with `budget: { dailyUsd, monthlyUsd }` (null clears). */
  budget: { dailyUsd?: number; monthlyUsd?: number };
  /** SIBYL_BUDGET_DAILY_USD / _MONTHLY_USD: the most the budget can be, and the cap while none is set here. */
  budgetLimits: { dailyUsd?: number; monthlyUsd?: number };
  /** Spent today and this month (all workspaces). */
  spent: { todayUsd: number; monthUsd: number };
  updatedAt?: number;
}

export interface OrgWorkspaceView {
  id: string;
  name: string;
  icon?: string;
  isDefault: boolean;
  /** Active people with access (explicit members plus organization owners and admins). */
  memberCount: number;
  createdAt: number;
}

export interface OrgLicenseSummary {
  edition: "oss" | "enterprise";
  status: "none" | "valid" | "expired" | "invalid";
  licensee?: string;
  seats?: number;
  expiresAt?: string;
  /** Accounts that are on (seats in use). */
  activeUsers: number;
}

export interface OrgView {
  settings: OrgSettingsView;
  workspaces: OrgWorkspaceView[];
  license: OrgLicenseSummary;
}

export interface OrgUserView {
  id: string;
  name: string;
  email: string;
  orgRole: IdentityRole;
  /** Explicit workspace memberships (organization owners and admins also reach every workspace). */
  workspaces: Array<{ id: string; name: string; role: IdentityRole }>;
  createdAt: number;
  lastActiveAt?: number;
  signIn: {
    /** Has a Sibyl password (accounts made by SSO/SCIM don't). */
    password: boolean;
    /** Two-step verification is on. */
    twoStep: boolean;
    /** Signs in through single sign-on (Sibyl Enterprise): provider labels. */
    sso?: string[];
  };
  status: "active" | "disabled";
  /** The identity provider manages the account (SCIM): read-only here. */
  managedBy?: "scim";
  you?: boolean;
}

export interface OrgInviteView extends InviteView {
  workspaceName: string;
}

export interface OrgUsersResponse {
  users: OrgUserView[];
  /** Pending invitations in every workspace. */
  invites: OrgInviteView[];
}

/* ── Meetings (wave C) ── */
/*
 * Meetings (docs/meetings.md): a call with people and agents (the room is the
 * realtime layer's call room; the meeting id is the call id), its transcript,
 * AI notes, action items and comments. Most of it is HTTP (/api/meetings);
 * the socket carries only what needs the person's own session:
 *
 * - `meeting.task`: make a task (a one-time routine) from an action item.
 *   It goes through the session's approval card like any write tool; the
 *   outcome comes back as `meeting.task_result`.
 *
 * In the room, the gateway nudges browsers over LiveKit data on
 * MEETING_SIGNAL_TOPIC ({ type: "notes" | "lobby" | "roles" | "ended" });
 * they then refetch over HTTP (which is where access is checked). Raised
 * hands travel between browsers on MEETING_HAND_TOPIC ({ raised }).
 */

export const MEETING_EVENTS = {
  /** Client → gateway. */
  TASK: "meeting.task",
  /** Gateway → client. */
  TASK_RESULT: "meeting.task_result"
} as const;

export const MEETING_SIGNAL_TOPIC = "sibyl.meeting";
export const MEETING_HAND_TOPIC = "sibyl.hand";
export const MEETING_ID = /^[A-Za-z0-9_-]{6,64}$/;

export type MeetingStatusView = "scheduled" | "live" | "ended";
export type MeetingAgentRoleView = "participant" | "notetaker";
export type MeetingParticipantKindView = "person" | "agent" | "guest";

export interface MeetingParticipantView {
  identity: string;
  name: string;
  kind: MeetingParticipantKindView;
  /** "sibyl" or an agent id. */
  agentId?: string;
  role?: MeetingAgentRoleView;
  /** Speaker colour slot (web: `--speaker-<color + 1>`). */
  color: number;
  joinedAt?: number;
}

export interface MeetingActionView {
  id: string;
  text: string;
  owner?: string;
  due?: string;
  /** Task made from it. */
  routineId?: string;
}

export interface MeetingNotesView {
  overview: string;
  keyPoints: string[];
  insights: string[];
  actions: MeetingActionView[];
  updatedAt: number;
  final?: boolean;
  by?: { agentId: string; name: string };
}

export interface MeetingView {
  id: string;
  title: string;
  description?: string;
  status: MeetingStatusView;
  hostName: string;
  /** The caller hosts it (may admit guests, mute, remove, end, change agent roles). */
  isHost: boolean;
  scheduledAt?: number;
  scheduledEndAt?: number;
  startedAt?: number;
  endedAt?: number;
  participants: MeetingParticipantView[];
  sibylRole: MeetingAgentRoleView;
  notes?: MeetingNotesView;
  conversationId?: string;
  recordingId?: string;
  /** Host only: the guest link path (/join/<id>?k=…). */
  guestPath?: string;
  calendar?: { provider: "google" | "microsoft"; eventId: string };
  costUsd?: number;
  segmentCount: number;
}

export interface MeetingSegmentView {
  seq: number;
  speaker: string;
  speakerName: string;
  kind: MeetingParticipantKindView;
  startMs: number;
  endMs: number;
  text: string;
  at: number;
}

export interface MeetingReactionView {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface MeetingCommentView {
  id: string;
  parentId?: string;
  authorName: string;
  mine: boolean;
  text: string;
  atMs?: number;
  reactions: MeetingReactionView[];
  createdAt: number;
  editedAt?: number;
}

export interface MeetingLobbyEntryView {
  ticket: string;
  name: string;
  at: number;
}

/** A guest's place in the lobby (GET /api/meetings/<id>/lobby/<ticket>). */
export interface MeetingLobbyStatusView {
  status: "waiting" | "admitted" | "denied" | "ended";
  title?: string;
  /** Once admitted: how to join the room. */
  grant?: { url: string; token: string; room: string; identity: string };
}

export interface MeetingCalendarEventView {
  provider: "google" | "microsoft";
  eventId: string;
  title: string;
  start: number;
  end?: number;
}

export interface MeetingAskResponse {
  answer: string;
}

export interface MeetingTaskMessage {
  type: typeof MEETING_EVENTS.TASK;
  meetingId: string;
  actionId: string;
}

export type MeetingsClientMessage = MeetingTaskMessage;

export interface MeetingTaskResultMessage {
  type: typeof MEETING_EVENTS.TASK_RESULT;
  meetingId: string;
  actionId: string;
  status: "created" | "declined" | "failed";
  routineId?: string;
  message?: string;
}

export type MeetingsServerMessage = MeetingTaskResultMessage;

export function isMeetingsClientMessage(message: { type: string }): message is MeetingsClientMessage {
  return message.type === MEETING_EVENTS.TASK;
}

/** Client messages of this block (called from parseClientMessage). */
function parseMeetingsClientMessage(input: Record<string, unknown>): ClientMessageValidationResult | undefined {
  if (input.type !== MEETING_EVENTS.TASK) return undefined;
  if (typeof input.meetingId !== "string" || !MEETING_ID.test(input.meetingId)) return invalid("meeting.task meetingId is invalid");
  if (typeof input.actionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.actionId)) return invalid("meeting.task actionId is invalid");
  return valid({ type: MEETING_EVENTS.TASK, meetingId: input.meetingId, actionId: input.actionId });
}

/** Server messages of this block (called from parseServerMessage). */
function parseMeetingsServerMessage(input: Record<string, unknown>): ServerMessageValidationResult | undefined {
  if (input.type !== MEETING_EVENTS.TASK_RESULT) return undefined;
  if (
    !isNonEmptyString(input.meetingId) ||
    !isNonEmptyString(input.actionId) ||
    !isEnum(input.status, ["created", "declined", "failed"] as const) ||
    !isOptionalString(input.routineId) ||
    !isOptionalString(input.message)
  ) {
    return invalidServer("invalid meeting.task_result message");
  }
  return validServer(input as unknown as MeetingTaskResultMessage);
}

/* ── Hosted tenancy: organizations, model access, AI credits ── */
/*
 * HTTP (see docs/hosting.md):
 *   GET    /api/model-access[?refresh=1]   → ModelAccessView                          (chat.use)
 *   PUT    /api/model-access/key {key}     → ModelAccessView; 400 {error:"invalid_key"} (org.settings; checked with OpenRouter first)
 *   DELETE /api/model-access/key           → ModelAccessView                          (org.settings)
 *   GET    /api/credits                    → CreditsView                              (usage.view; hosted)
 *   POST   /api/credits/purchase {amountUsd} → { status, paymentId, checkoutUrl?, balanceUsd } (org.billing)
 *   POST   /api/orgs {orgName, workspaceName?} + sign-up ticket (x-sibyl-signup-ticket or cookie sibyl_signup)
 *          → 201 { org: { id, name }, workspaceId } and the session cookie (hosted only)
 *   GET    /api/orgs                       → { organizations: OrganizationView[] }    (hosted, signed in)
 */

/** byok: the organization's own OpenRouter key; server: OPENROUTER_API_KEY on the (self-hosted) server; credits: the platform's key, paid with AI credits (hosted). */
export type ModelAccessMode = "byok" | "credits" | "server";

export interface ModelKeyInfo {
  /** Last four characters (never more). */
  last4: string;
  label?: string;
  /** Spending limit set on the key at OpenRouter (USD); null: no limit. */
  limitUsd?: number | null;
  usageUsd?: number;
  /** What the key can still spend (USD); null: no limit. */
  remainingUsd?: number | null;
  freeTier?: boolean;
  checkedAt: number;
}

export interface ModelAccessView {
  mode: ModelAccessMode;
  /** The organization's own key, when it has one. */
  key?: ModelKeyInfo;
  /** Hosted: the organization's AI credits. */
  credits?: { balanceUsd: number };
  /** The server has OPENROUTER_API_KEY (self-hosted: used when there is no own key). */
  serverKey: boolean;
  hosted: boolean;
}

export interface CreditsView {
  balanceUsd: number;
  /** Model calls run on credits now (the organization has no own key). */
  active: boolean;
  marginPercent: number;
  /** A payment provider is set up to buy credits in the app. */
  purchase: { available: boolean; provider?: string };
  entries: Array<{ kind: "grant" | "purchase" | "charge" | "refund"; amountUsd: number; at: number; note?: string }>;
}

export interface OrganizationView {
  id: string;
  name: string;
  /** The organization this browser is signed in to. */
  current: boolean;
  role?: IdentityRole;
}

/* ── Sign-up and onboarding (hosted sign-up; onboarding in both modes) ── */
/*
 * Sign-up and the extra sign-in methods (gateway: apps/gateway/src/identity/signup*.ts):
 *
 *   GET    /api/signup/options                       → SignupOptionsView (public)
 *   POST   /api/signup/email   {email,method,password?,name?,next?} → SignupEmailSent
 *          method "magic_link": a sign-in link (existing account) or a sign-up link (hosted);
 *          method "password": a 6-digit code to the address (hosted sign-up).
 *   POST   /api/signup/code    {email,code}          → SignupResult
 *   POST   /api/signup/link    {token}               → SignupResult
 *   GET    /api/signup/oauth/:provider/start?next=  → 302 to Google / Microsoft
 *   GET    /api/signup/oauth/:provider/callback      → 302 back to the web app: /signup/org (new),
 *          the `next` path (signed in), /login?choose=1 (several organizations), or ?signin_error=<code>
 *   GET    /api/signup/choose                        → { organizations } (one person, several organizations)
 *   POST   /api/signup/choose  {org}                 → SignupResult
 *   GET    /api/signup/ticket                        → SignupTicketView (the verified sign-up in this browser)
 *   DELETE /api/signup/ticket                        → { ok } (start over)
 *
 * A verified sign-up without an account gets a short-lived ticket (cookie
 * `sibyl_signup`), which POST /api/orgs exchanges for an organization.
 *
 * Onboarding (apps/gateway/src/onboarding/):
 *
 *   GET    /api/onboarding                           → OnboardingView
 *   PATCH  /api/onboarding     OnboardingPatch       → OnboardingView
 *   PUT    /api/onboarding/profile {name?,avatar?}   → OnboardingView
 */

export type SignupProvider = "password" | "magic_link" | "google" | "microsoft";

export interface SignupOptionsView {
  /** SIBYL_MODE=hosted: anyone can create an organization. */
  hosted: boolean;
  /** Continue with Google / Microsoft (the server has the sign-in app). */
  google: boolean;
  microsoft: boolean;
  /** Email can be sent (SIBYL_SMTP_URL): magic links and sign-up codes. */
  email: boolean;
}

export interface SignupEmailSent {
  sent: true;
  email: string;
  method: "password" | "magic_link";
  /** When the code or link stops working. */
  expiresAt: number;
}

export type SignupResult =
  /** Verified, no account yet: name the organization next (ticket cookie set). */
  | { next: "org"; email: string; name?: string; provider: SignupProvider }
  /** Signed in to an existing account (session cookie set). */
  | { next: "app"; path: string }
  /** The address has accounts in several organizations: choose one (POST /api/signup/choose). */
  | { next: "choose"; organizations: Array<{ id: string; name: string }> };

/** POST /api/orgs (tenancy/hosted.ts): the new organization; the session cookie is set. */
export interface OrgCreatedResponse {
  org: { id: string; name: string };
  workspaceId: string;
}

export interface SignupTicketView {
  email: string;
  name?: string;
  provider: SignupProvider;
  expiresAt: number;
}

export const ONBOARDING_STEPS = ["profile", "model", "style", "tools", "agent", "knowledge", "team", "start"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export const CHECKLIST_ITEMS = ["model", "style", "tool", "agent", "knowledge", "team", "voice"] as const;
export type ChecklistItemId = (typeof CHECKLIST_ITEMS)[number];

export interface ChecklistItemView {
  id: ChecklistItemId;
  label: string;
  done: boolean;
  /** Where to do it (an app path). */
  href: string;
}

export interface ChecklistView {
  items: ChecklistItemView[];
  doneCount: number;
  total: number;
  dismissed: boolean;
  /** Every item is done. */
  complete: boolean;
  /** Show it in the sidebar: onboarding started, not dismissed, not complete. */
  visible: boolean;
}

export interface OnboardingView {
  /** This person's steps, in order (steps they can't do are left out). */
  steps: OnboardingStepId[];
  /** Where they are (resume here). */
  current: OnboardingStepId;
  /** Finished or skipped steps. */
  done: OnboardingStepId[];
  skipped: OnboardingStepId[];
  startedAt?: number;
  completedAt?: number;
  /** Started and not finished: the app offers to continue. */
  pending: boolean;
  /** Nobody in the organization has started onboarding (a fresh install): the app starts it. */
  fresh: boolean;
  /** The style (model preset) chosen during onboarding. */
  presetId?: string;
  profile: { name: string; avatar: AgentAvatarView };
  checklist: ChecklistView;
}

export interface OnboardingPatch {
  /** Onboarding opened (sets startedAt once). */
  start?: boolean;
  /** Where they are now. */
  current?: OnboardingStepId;
  /** A step is finished… */
  done?: OnboardingStepId;
  /** …or skipped. */
  skipped?: OnboardingStepId;
  /** The last screen: onboarding is over. */
  complete?: boolean;
  presetId?: string;
  checklistDismissed?: boolean;
}

/* ── Media generation: images, video, audio (wave C) ── */

export type MediaKind = "image" | "video" | "audio";
export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "audio"];
export type MediaStatus = "queued" | "running" | "done" | "error" | "cancelled";
/** Frame roles a video model accepts besides references. */
export type MediaFrameRole = "first_frame" | "last_frame";
export type MediaReferenceRole = "reference" | MediaFrameRole;

/** One setting a media model accepts, built from the model's listing on OpenRouter. */
export interface MediaParamSpec {
  key: string;
  label: string;
  type: "enum" | "range" | "boolean" | "text";
  values?: Array<string | number>;
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  help?: string;
}

/** What references a model takes and how its prompt names them. */
export interface MediaReferenceSupport {
  images: number;
  videos: number;
  audio: number;
  frames: MediaFrameRole[];
  /** "seedance": @Image1 / @Video1 / @Audio1 · "wan": image 1 / video 1 · "plain": image 1. */
  syntax: "seedance" | "wan" | "plain";
}

export interface MediaModelView {
  id: string;
  name: string;
  kind: MediaKind;
  /** Audio models: spoken voice-over or music. */
  audioKind?: "speech" | "music";
  description?: string;
  params: MediaParamSpec[];
  references: MediaReferenceSupport;
  /** "$0.04 / image", "$0.10 / s", "$0.04 / clip", "$15 / 1M chars". */
  priceLabel: string;
  /** The default for its kind (a tested model). */
  isDefault?: boolean;
}

export interface MediaModelsResponse {
  models: MediaModelView[];
  defaults: Partial<Record<MediaKind, string>>;
  /** Spend above this (USD) asks before a video starts from chat. */
  approveAboveUsd: number;
  updatedAt: number;
}

/** A file used as a reference: an upload (generated or not). `token` is how the prompt names it ("@image1"). */
export interface MediaReferenceInput {
  uploadId: string;
  role?: MediaReferenceRole;
  token?: string;
}

/** Composer "Create" mode: make media from this message instead of chatting. */
export interface MediaCreateSpec {
  kind: MediaKind;
  model?: string;
  settings?: Record<string, string | number | boolean>;
  references?: MediaReferenceInput[];
}

export interface MediaCreateRequest extends MediaCreateSpec {
  prompt: string;
  conversationId?: string;
}

export interface MediaOutputView {
  uploadId: string;
  mime: string;
  size: number;
  /** Gateway path of the bytes (/api/uploads/<id>). */
  url: string;
}

export interface MediaItemView {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  model: string;
  modelName?: string;
  prompt: string;
  /** The prompt as sent to the model (reference tokens in its syntax). */
  providerPrompt?: string;
  settings: Record<string, string | number | boolean>;
  references: Array<MediaReferenceInput & { name?: string; mime?: string }>;
  outputs: MediaOutputView[];
  estimateUsd: number;
  costUsd?: number;
  costEstimated?: boolean;
  error?: string;
  /** 0–100 while a video renders (estimated from the model's typical time). */
  progress?: number;
  createdBy?: string;
  agentId?: string;
  conversationId?: string;
  requestId?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** The viewer marked it as a favourite. */
  favorite?: boolean;
  /** Library collections it is in (this workspace's). */
  collectionIds?: string[];
}

export interface MediaListResponse {
  items: MediaItemView[];
}

/** A named group of media in the workspace's library (Spaces → Media). */
export interface MediaCollectionView {
  id: string;
  name: string;
  count: number;
  createdAt: number;
}

/** PATCH /api/media/:id */
export interface MediaItemPatch {
  favorite?: boolean;
  addToCollection?: string;
  removeFromCollection?: string;
}

export const MAX_MEDIA_REFERENCES = 12;
export const MAX_MEDIA_PROMPT_CHARS = 8_000;

/** Validate a Create-mode spec (from a chat message or the Media page). */
export function parseMediaCreateSpec(value: unknown): { success: true; data: MediaCreateSpec } | { success: false; error: string } {
  if (!isRecord(value)) return { success: false, error: "media must be an object" };
  if (!MEDIA_KINDS.includes(value.kind as MediaKind)) return { success: false, error: "media.kind must be image, video or audio" };
  if (value.model !== undefined && (typeof value.model !== "string" || !/^[\w.:/-]{1,120}$/.test(value.model))) {
    return { success: false, error: "media.model must be a model id" };
  }
  const settings: Record<string, string | number | boolean> = {};
  if (value.settings !== undefined) {
    if (!isRecord(value.settings)) return { success: false, error: "media.settings must be an object" };
    for (const [key, entry] of Object.entries(value.settings).slice(0, 40)) {
      if (!/^[a-z_]{1,40}$/.test(key)) continue;
      if (typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)) || (typeof entry === "string" && entry.length <= 2_000)) settings[key] = entry;
    }
  }
  const references: MediaReferenceInput[] = [];
  if (value.references !== undefined) {
    if (!Array.isArray(value.references) || value.references.length > MAX_MEDIA_REFERENCES) {
      return { success: false, error: `media.references must be a list of at most ${MAX_MEDIA_REFERENCES}` };
    }
    for (const ref of value.references) {
      if (!isRecord(ref) || typeof ref.uploadId !== "string" || !/^up_[a-f0-9]{24}$/.test(ref.uploadId)) {
        return { success: false, error: "media.references[].uploadId must be an upload id" };
      }
      const role = ref.role === "first_frame" || ref.role === "last_frame" ? ref.role : "reference";
      const token = typeof ref.token === "string" && /^@?[\w-]{1,40}$/.test(ref.token) ? ref.token : undefined;
      references.push({ uploadId: ref.uploadId, role, ...(token ? { token } : {}) });
    }
  }
  return {
    success: true,
    data: {
      kind: value.kind as MediaKind,
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(references.length ? { references } : {})
    }
  };
}
