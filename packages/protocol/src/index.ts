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
}

/** Browser-safe view of an artifact a tool produced. URLs never point at internal services. */
export interface ToolArtifactView {
  id: string;
  kind: "slides" | "file";
  title: string;
  version: number;
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
  /** True when close to a cap and cheaper models are being used. */
  economyMode: boolean;
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
  scope: "daily" | "monthly" | "routine_run" | "routine_daily";
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
  /** Estimated USD per 100 turns for the whole set. */
  costPer100Turns?: number;
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
  | ConnectionsClientMessage;

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
  | ErrorMessage;

export type ReservedMessage = never;

export type ClientMessageValidationResult =
  | { success: true; data: ClientMessage }
  | { success: false; error: string };

export type ServerMessageValidationResult =
  | { success: true; data: ServerMessage }
  | { success: false; error: string };

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
      return valid({
        type: WS_EVENTS.USER_TEXT,
        text: input.text,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId })
      });

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
      return valid({
        type: WS_EVENTS.VAD_SPEECH_START,
        requestId: input.requestId,
        turnMode: "live",
        startedAt: input.startedAt,
        ...(input.rms === undefined ? {} : { rms: input.rms })
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
      if (typeof parsed === "string") {
        return invalid(`session.update ${parsed}`);
      }
      return valid({ type: WS_EVENTS.SESSION_UPDATE, settings: parsed });
    }

    default:
      return parseConnectionsClientMessage(input) ?? invalid(`unsupported message type: ${input.type}`);
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
    [WS_EVENTS.BUDGET_BLOCKED]: (v) => isEnum(v.scope, ["daily", "monthly", "routine_run", "routine_daily"] as const) && typeof v.message === "string",
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
    const settings = parseSettingsPatch(input.settings);
    if (
      typeof settings === "string" ||
      !isNonEmptyString(settings.llmModel) ||
      !isNonEmptyString(settings.sttModel) ||
      typeof settings.genUi !== "boolean" ||
      typeof settings.speak !== "boolean"
    ) {
      return invalidServer("session.config requires complete settings");
    }
    const catalog = parseCatalog(input.catalog);
    if (!catalog) {
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
      catalog,
      settings: settings as SessionSettings,
      capabilities: {
        provider: caps.provider,
        genUi: caps.genUi,
        tts: caps.tts,
        realtimeStt: caps.realtimeStt
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

  return parseConnectionsServerMessage(input) ?? invalidServer(`unsupported message type: ${input.type}`);
}

const MAX_MODEL_ID_LENGTH = 200;

function parseSettingsPatch(
  input: unknown
): Partial<SessionSettings> | string {
  if (!isRecord(input)) return "settings must be an object";
  const out: Partial<SessionSettings> = {};
  for (const key of ["voiceModel", "llmModel", "sttModel", "ttsModel", "ttsVoice"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!isNonEmptyString(value) || value.length > MAX_MODEL_ID_LENGTH) {
      return `${key} must be a non-empty string`;
    }
    out[key] = value;
  }
  for (const key of ["genUi", "speak"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return `${key} must be a boolean`;
    out[key] = value;
  }
  return out;
}

function parseModelOptions(input: unknown): TtsModelOption[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: TtsModelOption[] = [];
  for (const item of input) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.label)) {
      return undefined;
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
  return out;
}

function parseCatalog(input: unknown): ModelCatalog | undefined {
  if (!isRecord(input)) return undefined;
  const llm = parseModelOptions(input.llm);
  const stt = parseModelOptions(input.stt);
  const tts = parseModelOptions(input.tts);
  if (!llm || !stt || !tts) return undefined;
  const voice = input.voice === undefined ? undefined : parseModelOptions(input.voice);
  if (input.voice !== undefined && !voice) return undefined;
  const presets: ModelPreset[] = [];
  if (Array.isArray(input.presets)) {
    for (const preset of input.presets) {
      if (!isRecord(preset) || !isNonEmptyString(preset.id) || !isNonEmptyString(preset.label)) continue;
      const settings = parseSettingsPatch(preset.settings);
      if (typeof settings === "string") continue;
      presets.push({
        id: preset.id,
        label: preset.label,
        settings,
        ...(isFiniteNumber(preset.costPer100Turns) ? { costPer100Turns: preset.costPer100Turns } : {})
      });
    }
  }
  return {
    ...(voice ? { voice } : {}),
    llm,
    stt,
    tts,
    ...(presets.length ? { presets } : {})
  };
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
      if (typeof server === "string") return invalid(`${type} ${server}`);
      return valid({
        type: CONNECTIONS_EVENTS.SERVER_SAVE,
        requestId: id,
        server,
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
        if (typeof parsed === "string") return invalid(`${type} ${parsed}`);
        server = parsed;
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

/** Validate a server from the form; returns an error string when invalid. */
export function parseConnectionServerInput(input: unknown): ConnectionServerInput | string {
  if (!isRecord(input)) return "server must be an object";
  if (typeof input.name !== "string" || !CONNECTION_SERVER_NAME.test(input.name)) {
    return "server name must be 1-32 letters, digits, _ or -";
  }
  const catalogId =
    typeof input.catalogId === "string" && /^[a-z0-9-]{1,64}$/.test(input.catalogId) ? { catalogId: input.catalogId } : {};
  if (input.transport === "stdio") {
    if (!isNonEmptyString(input.command) || input.command.trim().length === 0 || input.command.length > 500) {
      return "command is required (≤ 500 characters)";
    }
    if (!Array.isArray(input.args) || input.args.length > MAX_CONNECTION_ENTRIES) return "args must be a list of up to 64 strings";
    if (!input.args.every((arg) => typeof arg === "string" && arg.length <= 2_000)) return "args must be strings (≤ 2000 characters)";
    const env = parseSecretRecord(input.env, CONNECTION_ENV_KEY, "env");
    if (typeof env === "string") return env;
    if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length > 1_000)) return "cwd must be a string";
    return {
      name: input.name,
      transport: "stdio",
      command: input.command.trim(),
      args: input.args as string[],
      env,
      ...(typeof input.cwd === "string" && input.cwd.trim() ? { cwd: input.cwd.trim() } : {}),
      ...catalogId
    };
  }
  if (input.transport === "http") {
    if (!isNonEmptyString(input.url) || input.url.length > 2_000) return "url is required";
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      return "url is not a valid URL";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "url must start with http:// or https://";
    const headers = parseSecretRecord(input.headers, CONNECTION_HEADER_KEY, "headers");
    if (typeof headers === "string") return headers;
    return { name: input.name, transport: "http", url: input.url.trim(), headers, ...catalogId };
  }
  return 'transport must be "stdio" or "http"';
}

function parseSecretRecord(value: unknown, keyPattern: RegExp, label: string): Record<string, string | null> | string {
  if (value === undefined) return {};
  if (!isRecord(value)) return `${label} must be an object`;
  const entries = Object.entries(value);
  if (entries.length > MAX_CONNECTION_ENTRIES) return `${label} has too many entries`;
  const out: Record<string, string | null> = {};
  for (const [key, item] of entries) {
    if (!keyPattern.test(key)) return `${label} key "${key.slice(0, 40)}" is not allowed`;
    if (item !== null && (typeof item !== "string" || item.length > MAX_CONNECTION_VALUE)) {
      return `${label}.${key} must be a string or null`;
    }
    out[key] = item;
  }
  return out;
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
