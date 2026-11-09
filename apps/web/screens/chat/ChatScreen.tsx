"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import {
  IDENTITY_EVENTS,
  SECRET_EVENTS,
  VOICE_LATENCY_EVENTS,
  WS_EVENTS,
  createRequestId,
  isConnectionsServerMessage,
  type ApprovalView,
  type ServerMessage,
  type ToolArtifactView,
  type SecretRequestView
} from "@open-gpt-live/protocol";
import { GenUiView, type GenUiAction } from "../../components/GenUiView";
import { Composer } from "../../components/Composer";
import { QueueStack, type QueuedMessage } from "../../components/QueueStack";
import { Sidebar } from "../../components/Sidebar";
import { ApprovalCard, type ApprovalCardStatus } from "../../components/ApprovalCard";
import { SlidesCard } from "../../components/SlidesCard";
import { ComputerThumbnail, isComputerTool } from "../../features/computers";
import { openSidePanel, SidePanelLayout, SidePanelToggle, sidePanelSources } from "../../features/side-panel";
import { InboxBell } from "../../components/Inbox";
import { SecretPrompt, type SecretPromptStatus } from "../../components/SecretPrompt";
import { Icon, type IconName } from "../../components/Icon";
import { SilverMark } from "../../components/Brand";
import { SibylLoader, ThinkingStatus } from "../../components/SibylLoader";
import { useShell } from "../../components/AppFrame";
import { chatPath, conversationIdOf, isChatPath, paths } from "../../lib/routes";
import { sendRaw, useGateway, type GatewayEvent } from "../../lib/gateway";
import { useAppSession } from "../../lib/app-session";
import type { VoiceState } from "../../components/voice-state";
import { titleFor, toMarkdown, type ConversationMessageView } from "../../lib/conversations";
import { SpokenText } from "../../components/SpokenText";
import { AgentAvatar, AgentPicker } from "../../features/agents";
import { useRealtimeVoice } from "../../features/realtime";
import { startMeetingFromChat } from "../../features/meetings";
import type { AttachmentRef, MediaCreateSpec, MediaItemView, MediaOutputView, ToolLinkView } from "@open-gpt-live/protocol";
import { MediaResult, useChatMedia } from "../../features/media";
import { AttachmentList } from "../../components/AttachmentChips";
import { SaveToKnowledgeButton } from "../../features/knowledge";
import {
  MAX_ATTACHMENTS,
  isImageMime,
  toAttachmentRefs,
  uploadFile,
  type ComposerAttachment
} from "../../components/AttachmentClient";
import { MemorySavedChip } from "../../components/MemoryTab";
import { StreamPlayer } from "../../lib/stream-player";
import { LiveCaptions, liveCaptionsSupported } from "../../lib/live-captions";
import { blobToWav } from "../../lib/audio-wav";
import {
  LIVE_PCM_MIME_TYPE,
  LIVE_PCM_SAMPLE_RATE,
  Pcm16FrameBuffer,
  StreamingPcm16Resampler
} from "../../lib/audio-pcm";
import { resolveVadConfig } from "../../lib/live-config";
import {
  AdaptiveVadEngine,
  type SpeechDetector,
  type VadSnapshot
} from "../../lib/vad-engine";
import {
  beginLatencyRequest,
  markLatency,
  settleLatencyRequest,
  type LatencyRegistry,
  type LatencyRequestKind,
  type LatencyRequestStatus,
  type LatencySnapshot
} from "../../lib/latency-metrics";
import {
  beginRequest,
  canAcceptRequestEvent,
  cancelActiveRequests,
  settleRequest,
  transitionRequest,
  type RequestLifecycleRegistry
} from "../../lib/request-lifecycle";
import { useVoiceDiagnostics } from "./diagnostics";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  requestId: string;
  source?: "text" | "audio" | "ui";
  transient?: boolean;
  /** OpenUI Lang source streamed alongside the spoken reply. */
  ui?: string;
  done?: boolean;
  /** Deep-brain result card (handed off by the voice). */
  kind?: "brain";
  task?: string;
  model?: string;
  failed?: boolean;
  /** Tools the deep brain called (shown as step rows). */
  tools?: ToolStep[];
  /** Approval cards for "write" tools in this run. */
  approvals?: ApprovalEntry[];
  /** Files sent with a user message. */
  attachments?: AttachmentRef[];
  /** Secure key prompts (request_secret) in this run. */
  secretPrompts?: SecretPromptEntry[];
}

interface SecretPromptEntry {
  view: SecretRequestView;
  status: SecretPromptStatus;
  submitting?: boolean;
  error?: string;
  savedHosts?: string[];
}

/** A queued message keeps the files it was sent with. */
type QueuedItem = QueuedMessage & { attachments?: AttachmentRef[]; media?: MediaCreateSpec };

interface ToolStep {
  callId: string;
  toolName?: string;
  title: string;
  status: "running" | "ok" | "error" | "declined";
  summary?: string;
  /** Deck produced by create_slides / revise_slides. */
  artifact?: ToolArtifactView;
  /** Web page the tool read (read_webpage). */
  link?: ToolLinkView;
}

interface ApprovalEntry {
  view: ApprovalView;
  status: ApprovalCardStatus;
  submitting?: boolean;
}

interface PushToTalkRecording {
  requestId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  mimeType: string;
  sequence: number;
  pendingSends: Array<Promise<void>>;
  cancelled: boolean;
  finalizing: boolean;
  /**
   * With a voice brain, the clip is buffered and sent once as WAV so the model
   * hears the actual voice (tone included) instead of a transcript.
   */
  blobs?: Blob[];
}

interface LivePcmFrame {
  samples: Int16Array;
  durationMs: number;
}

interface LivePcmTurn {
  requestId: string;
  sequence: number;
  startedAt: number;
  cancelled: boolean;
}

interface VadWorkletFrame {
  rms?: number;
  pcm?: ArrayBuffer;
  sampleRate?: number;
}

const vadConfig = resolveVadConfig({
  adaptiveEnabled: process.env.NEXT_PUBLIC_VAD_ADAPTIVE_ENABLED,
  calibrationMs: process.env.NEXT_PUBLIC_VAD_CALIBRATION_MS,
  noiseFloorSmoothing: process.env.NEXT_PUBLIC_VAD_NOISE_FLOOR_SMOOTHING,
  speechNoiseMultiplier:
    process.env.NEXT_PUBLIC_VAD_SPEECH_NOISE_MULTIPLIER,
  silenceNoiseMultiplier:
    process.env.NEXT_PUBLIC_VAD_SILENCE_NOISE_MULTIPLIER,
  dynamicSpeechMin: process.env.NEXT_PUBLIC_VAD_DYNAMIC_SPEECH_MIN,
  dynamicSpeechMax: process.env.NEXT_PUBLIC_VAD_DYNAMIC_SPEECH_MAX,
  dynamicSilenceMin: process.env.NEXT_PUBLIC_VAD_DYNAMIC_SILENCE_MIN,
  dynamicSilenceMax: process.env.NEXT_PUBLIC_VAD_DYNAMIC_SILENCE_MAX,
  speechThreshold: process.env.NEXT_PUBLIC_VAD_SPEECH_THRESHOLD,
  silenceThreshold: process.env.NEXT_PUBLIC_VAD_SILENCE_THRESHOLD,
  startDebounceMs: process.env.NEXT_PUBLIC_VAD_START_DEBOUNCE_MS,
  minimumSpeechMs: process.env.NEXT_PUBLIC_VAD_MIN_SPEECH_MS,
  hangoverMs: process.env.NEXT_PUBLIC_VAD_HANGOVER_MS,
  maxTurnMs: process.env.NEXT_PUBLIC_VAD_MAX_TURN_MS,
  preRollMs: process.env.NEXT_PUBLIC_VAD_PRE_ROLL_MS,
  playbackThresholdMultiplier:
    process.env.NEXT_PUBLIC_VAD_PLAYBACK_THRESHOLD_MULTIPLIER,
  playbackSuppressAfterEndMs:
    process.env.NEXT_PUBLIC_VAD_PLAYBACK_SUPPRESS_AFTER_END_MS
});

// MediaRecorder is retained for push-to-talk; live mode sends PCM from the worklet.
const recorderTimesliceMs = 250;

/**
 * The chat screen. It stays mounted for the whole session (hidden while
 * another screen is shown), so voice, queued messages and streaming replies
 * carry on while you look at Routines or Settings.
 */
export function ChatScreen({ active }: { active: boolean }) {
  const gateway = useGateway();
  const {
    socketRef,
    connected,
    status: connectionStatus,
    catalog,
    settings,
    usage,
    conversations,
    updateSettings,
    activePresetId
  } = gateway;
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const shell = useShell();
  const pttRecordingRef = useRef<PushToTalkRecording | null>(null);
  const pttPermissionPendingRef = useRef(false);
  const pttStartCancelledRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const liveModeGenerationRef = useRef(0);
  const livePcmTurnRef = useRef<LivePcmTurn | null>(null);
  const preRollFramesRef = useRef<LivePcmFrame[]>([]);
  const requestLifecyclesRef = useRef<RequestLifecycleRegistry>(new Map());
  const latencyRegistryRef = useRef<LatencyRegistry>(new Map());
  const activeRequestIdRef = useRef<string | null>(null);
  const playerRef = useRef<StreamPlayer | null>(null);
  const captionsRef = useRef<LiveCaptions | null>(null);
  const ignoredPlaybackRequestsRef = useRef<Set<string>>(new Set());
  const playbackVadSuppressedUntilRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const vadWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const vadScriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const vadMuteGainRef = useRef<GainNode | null>(null);
  const fallbackResamplerRef = useRef<StreamingPcm16Resampler | null>(null);
  const fallbackFrameBufferRef = useRef<Pcm16FrameBuffer | null>(null);
  const speechDetectorRef = useRef<SpeechDetector | null>(null);
  const lastVadUiUpdateAtRef = useRef(0);
  const liveModeRef = useRef(false);
  const liveListeningRef = useRef(false);
  const [input, setInput] = useState("");
  // `/?q=<text>` (onboarding's suggested prompts): type it into the composer, ready to send.
  useEffect(() => {
    if (!active || pathname !== "/") return;
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get("q");
    if (!prompt) return;
    setInput(prompt.slice(0, 4000));
    params.delete("q");
    const rest = params.toString();
    window.history.replaceState(window.history.state, "", rest ? `/?${rest}` : "/");
  }, [active, pathname]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualPlaybackRequestId, setManualPlaybackRequestId] = useState<
    string | null
  >(null);
  const [latencySnapshot, setLatencySnapshot] =
    useState<LatencySnapshot | null>(null);
  const [vadSnapshot, setVadSnapshot] = useState<VadSnapshot | null>(null);
  const [budgetNotice, setBudgetNotice] = useState<{ message: string; credits: boolean } | null>(null);
  // A budget notice belongs to the workspace it came from (workspace budgets).
  const session = useAppSession();
  const budgetWorkspaceId = session.currentWorkspaceId;
  useEffect(() => setBudgetNotice(null), [budgetWorkspaceId]);
  /** The live conversation (set by conversation.state from the Gateway). */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const conversationIdRef = useRef<string | null>(null);
  const { historyOpen: sidebarOpen, setHistoryOpen: setSidebarOpen } = shell;
  const [showJump, setShowJump] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openSources, setOpenSources] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  /** Files attached in the composer (uploading or ready). */
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  // Create mode, the @ picker and media references (features/media).
  const chatFiles = useMemo(() => messages.flatMap((message) => message.attachments ?? []), [messages]);
  const chatMedia = useChatMedia({ conversationId, agents: gateway.agents.agents, chatFiles, enabled: gateway.connected, refreshKey: activeRequestId, setInput });
  const uploadAbortsRef = useRef<Map<string, () => void>>(new Map());
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [speaking, setSpeaking] = useState(false);
  /** Requests whose voice failed (non-fatal): text + UI still complete. */
  const ttsFailedRequestsRef = useRef<Set<string>>(new Set());
  /** Deep-brain ids: their visuals keep streaming after the gist is spoken. */
  const brainRequestsRef = useRef<Set<string>>(new Set());

  if (!playerRef.current && typeof window !== "undefined") {
    playerRef.current = new StreamPlayer({
      onStart: (requestId) => markRequestLatency(requestId, "firstAudioPlaybackAt"),
      onChunkPlayed: (requestId, sequence) => sendPlaybackAck(requestId, sequence),
      onDone: (requestId) => {
        playbackVadSuppressedUntilRef.current =
          performance.now() + vadConfig.playbackSuppressAfterEndMs;
        if (canAcceptRequestEvent(requestLifecyclesRef.current, requestId)) {
          completeRequest(requestId);
        }
      },
      onBlocked: (blocked) => setManualPlaybackRequestId(blocked ? "blocked" : null)
    });
  }

  if (!speechDetectorRef.current) {
    speechDetectorRef.current = new AdaptiveVadEngine(vadConfig);
  }

  // Voice over LiveKit when the gateway offers it: Sibyl's room agent detects
  // the turns; this screen shows them like its own live turns.
  const realtime = useRealtimeVoice({
    onTurn: (turn) => {
      if (turn.phase === "start") {
        const interrupted = activeRequestIdRef.current;
        if (interrupted && interrupted !== turn.requestId) cancelRequest(interrupted);
        const now = performance.now();
        beginRequestLatency(turn.requestId, "live", now);
        markRequestLatency(turn.requestId, "speechStartedAt", now);
        beginRequest(requestLifecyclesRef.current, turn.requestId, "recording");
        setCurrentRequest(turn.requestId);
        setRecording(true);
        setRecordingStatus("Listening...");
      } else if (turn.phase === "end") {
        markRequestLatency(turn.requestId, "speechEndedAt", performance.now());
        transitionRequest(requestLifecyclesRef.current, turn.requestId, "transcribing");
        setRecording(false);
        setRecordingStatus("Thinking...");
      } else {
        cancelRequest(turn.requestId);
        setRecording(false);
        setRecordingStatus("Live mode listening...");
      }
    },
    onEnded: () => cleanupLiveMode(false)
  });

  const canSend = useMemo(
    () =>
      connected &&
      !attachments.some((item) => item.status === "uploading") &&
      (input.trim().length > 0 || attachments.some((item) => item.status === "ready")),
    [connected, input, attachments]
  );

  // The gateway owns the socket; the chat follows its lifecycle and messages.
  const handleServerMessageRef = useRef<(message: ServerMessage) => void>(() => {});
  const handleGatewayEventRef = useRef<(event: GatewayEvent) => void>(() => {});
  useEffect(() => {
    const offMessages = gateway.subscribe((message) => handleServerMessageRef.current(message));
    const offEvents = gateway.subscribeEvents((event) => handleGatewayEventRef.current(event));
    // Mounted after the socket opened (rare): catch up.
    if (socketRef.current?.readyState === WebSocket.OPEN) handleGatewayEventRef.current({ type: "open", restored: false });
    return () => {
      offMessages();
      offEvents();
      cleanupAllPlayback(false);
      cleanupLiveMode(false, false);
      cancelPushToTalkRecording(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleGatewayEvent(event: GatewayEvent): void {
    if (event.type === "error") {
      setError(event.message);
      return;
    }
    if (event.type === "close") {
      cancelRequestsAfterDisconnect();
      if (event.wasOpen) setError("Gateway disconnected. Reconnecting automatically...");
      return;
    }
    const socket = socketRef.current;
    if (!socket) return;
    setError(event.restored ? "Gateway reconnected." : null);
    // History lives on the Gateway: resume the live conversation (with its
    // full context) if it was saved. The address wins on first load
    // (/c/<id>, or the chat a redirected old link named), then the live one.
    const urlId = conversationIdRef.current ? null : conversationIdOf(shell.chatPathRef.current);
    const resumeId = conversationIdRef.current ?? urlId;
    const resume = Boolean(resumeId) && (resumeId === urlId || conversationsRef.current.some((item) => item.id === resumeId));
    if (urlId) {
      pendingRouteRef.current = chatPath(urlId);
      routeSettledRef.current = false;
    }
    sendRaw(socket, {
      type: WS_EVENTS.CONVERSATION_OPEN,
      ...(resume && resumeId ? { conversationId: resumeId } : {})
    });
  }
  handleGatewayEventRef.current = handleGatewayEvent;
  handleServerMessageRef.current = handleServerMessage;

  function handleServerMessage(message: ServerMessage): void {
    // Shared state (session, usage, conversations, routines, secrets list)
    // is kept by the gateway provider; the chat handles its own events.
    if (isConnectionsServerMessage(message)) return;
    if (handleSecretsMessage(message)) return;

    // The gateway's turn metrics (LiveKit's names) for Settings → Diagnostics.
    if (message.type === VOICE_LATENCY_EVENTS.TURN_METRICS) {
      useVoiceDiagnostics.setState({ turn: { requestId: message.requestId, ...message.metrics } });
      return;
    }

    if (message.type === WS_EVENTS.BUDGET_BLOCKED) {
      setBudgetNotice({ message: message.message, credits: message.scope === "credits" });
      return;
    }

    if (message.type === WS_EVENTS.CONVERSATION_STATE) {
      // A LiveKit voice room belongs to one conversation: leave it on a switch.
      if (realtime.activeRef.current && conversationIdRef.current !== message.conversationId) cleanupLiveMode(true);
      // The opened conversation is now the live one; earlier replies are over.
      for (const requestId of cancelActiveRequests(requestLifecyclesRef.current)) {
        ignorePlaybackRequest(requestId);
        settleRequestLatency(requestId, "interrupted");
      }
      cleanupAllPlayback();
      brainRequestsRef.current.clear();
      activeRequestIdRef.current = null;
      setActiveRequestId(null);
      conversationIdRef.current = message.conversationId;
      routeSettledRef.current = true;
      if (!routeReadyRef.current) {
        routeReadyRef.current = true;
        lastRoutedChatRef.current = message.conversationId;
      }
      if (pendingRouteRef.current) {
        // Settle the address on what the gateway actually opened (a deleted
        // chat falls back to a new one).
        pendingRouteRef.current = null;
        routeSettledRef.current = false;
        settleChatAddress(message.messages.length > 0 ? message.conversationId : null);
      }
      setConversationId(message.conversationId);
      setMessages(message.messages.map(fromStoredMessage));
      atBottomRef.current = true;
      return;
    }

    if (message.type === WS_EVENTS.TURN_MERGED) {
      // One thought spoken with a pause: fold the earlier fragment into this turn.
      settleRequest(requestLifecyclesRef.current, message.mergedRequestId, "cancelled");
      ignorePlaybackRequest(message.mergedRequestId);
      setMessages((current) => {
        const oldUser = current.find(
          (item) => item.requestId === message.mergedRequestId && item.role === "user"
        );
        const newUser = current.find(
          (item) => item.requestId === message.requestId && item.role === "user"
        );
        const withoutOld = current.filter(
          (item) => item.requestId !== message.mergedRequestId
        );
        if (!oldUser) return withoutOld;
        if (newUser) {
          return withoutOld.map((item) =>
            item.id === newUser.id
              ? { ...item, content: [oldUser.content, item.content].filter(Boolean).join(" ") }
              : item
          );
        }
        return [
          ...withoutOld,
          { ...oldUser, requestId: message.requestId, transient: true }
        ];
      });
      return;
    }

    if (message.type === WS_EVENTS.TRANSCRIPT_UPDATE) {
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.role === "user"
            ? { ...item, content: message.text, transient: false }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.BRAIN_START) {
      // The deep brain works in the background; it never blocks talking.
      beginRequest(requestLifecyclesRef.current, message.requestId, "responding");
      brainRequestsRef.current.add(message.requestId);
      setMessages((current) => {
        const card: ChatMessage = {
          id: createRequestId(),
          role: "assistant",
          kind: "brain",
          content: "",
          requestId: message.requestId,
          task: message.task,
          model: message.model
        };
        let index = -1;
        current.forEach((item, position) => {
          if (item.requestId === message.parentRequestId) index = position;
        });
        if (index < 0) return [...current, card];
        return [...current.slice(0, index + 1), card, ...current.slice(index + 1)];
      });
      return;
    }

    if (message.type === WS_EVENTS.BRAIN_DELTA) {
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.kind === "brain"
            ? { ...item, content: item.content + message.delta }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.BRAIN_DONE) {
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.kind === "brain"
            ? {
                ...item,
                done: true,
                failed: message.reason === "error",
                // A run that ended can't still be using a tool.
                tools: item.tools?.map((tool) =>
                  tool.status === "running" ? { ...tool, status: "error" as const } : tool
                )
              }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.TOOL_STARTED) {
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.role === "assistant"
            ? {
                ...item,
                tools: [
                  ...(item.tools ?? []).filter((tool) => tool.callId !== message.callId),
                  { callId: message.callId, toolName: message.toolName, title: message.title, status: "running" as const }
                ]
              }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.TOOL_FINISHED) {
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.role === "assistant"
            ? {
                ...item,
                tools: (item.tools ?? []).map((tool) =>
                  tool.callId === message.callId
                    ? {
                        ...tool,
                        status: message.status,
                        summary: message.summary,
                        ...(message.artifact ? { artifact: message.artifact } : {}),
                        ...(message.link ? { link: message.link } : {})
                      }
                    : tool
                )
              }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.APPROVAL_REQUEST) {
      const view = message.approval;
      setMessages((current) =>
        current.map((item) =>
          item.requestId === view.runId && item.role === "assistant"
            ? {
                ...item,
                approvals: [
                  ...(item.approvals ?? []).filter((entry) => entry.view.id !== view.id),
                  { view, status: "pending" as const }
                ]
              }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.APPROVAL_RESOLVED) {
      setMessages((current) =>
        current.map((item) =>
          item.approvals?.some((entry) => entry.view.id === message.id)
            ? {
                ...item,
                approvals: item.approvals.map((entry) =>
                  entry.view.id === message.id
                    ? { ...entry, status: message.status, submitting: false }
                    : entry
                )
              }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.UI_DELTA) {
      if (
        !brainRequestsRef.current.has(message.requestId) &&
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId, [
          "responding",
          "playing"
        ])
      ) {
        return;
      }
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.role === "assistant"
            ? { ...item, ui: (item.ui ?? "") + message.delta }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.LLM_DELTA) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId, [
          "responding",
          "playing"
        ])
      ) {
        return;
      }
      markRequestLatency(message.requestId, "firstLlmDeltaAt");
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId && item.role === "assistant"
            ? { ...item, content: item.content + message.delta }
            : item
        )
      );
      return;
    }

    if (message.type === WS_EVENTS.TRANSCRIPT_PARTIAL) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId, [
          "recording",
          "finalizing",
          "transcribing"
        ])
      ) {
        return;
      }
      markRequestLatency(message.requestId, "firstPartialAt");
      setRecordingStatus("Listening...");
      setMessages((current) => {
        const existing = current.find(
          (item) => item.requestId === message.requestId && item.role === "user"
        );
        if (existing) {
          return current.map((item) =>
            item.id === existing.id
              ? { ...item, content: message.text, transient: true }
              : item
          );
        }

        return [
          ...current,
          {
            id: createRequestId(),
            role: "user",
            content: message.text,
            requestId: message.requestId,
            source: "audio",
            transient: true
          }
        ];
      });
      return;
    }

    if (message.type === WS_EVENTS.TRANSCRIPT_FINAL) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId, [
          "recording",
          "finalizing",
          "transcribing"
        ])
      ) {
        return;
      }
      markRequestLatency(message.requestId, "finalTranscriptAt");
      transitionRequest(
        requestLifecyclesRef.current,
        message.requestId,
        "responding"
      );
      setRecordingStatus(null);
      setMessages((current) => {
        const hasUser = current.some(
          (item) => item.requestId === message.requestId && item.role === "user"
        );
        const hasAssistant = current.some(
          (item) =>
            item.requestId === message.requestId && item.role === "assistant"
        );
        const next = hasUser
          ? current.map((item) =>
              item.requestId === message.requestId && item.role === "user"
                ? { ...item, content: message.text || item.content, transient: false }
                : item
            )
          : [
              ...current,
              {
                id: createRequestId(),
                role: "user" as const,
                content: message.text,
                requestId: message.requestId,
                source: "audio" as const
              }
            ];

        return hasAssistant
          ? next
          : [
              ...next,
              {
                id: createRequestId(),
                role: "assistant",
                content: "",
                requestId: message.requestId
              }
            ];
      });
      return;
    }

    if (message.type === WS_EVENTS.LLM_DONE) {
      setMessages((current) =>
        current.map((item) =>
          item.requestId === message.requestId &&
          item.role === "assistant" &&
          item.kind !== "brain"
            ? { ...item, done: true }
            : item
        )
      );
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId)
      ) {
        return;
      }
      if (message.reason === "ignored") {
        // Noise or speech not meant for the assistant: drop the turn quietly.
        setMessages((current) =>
          current.filter((item) => item.requestId !== message.requestId)
        );
        setRecordingStatus(liveModeRef.current ? "Listening..." : null);
        completeRequest(message.requestId);
        return;
      }
      if (message.reason === "interrupted" || message.reason === "error") {
        cancelRequest(
          message.requestId,
          message.reason === "error" ? "error" : "interrupted"
        );
      } else {
        window.setTimeout(() => {
          if (
            canAcceptRequestEvent(
              requestLifecyclesRef.current,
              message.requestId
            ) &&
            !playerRef.current?.has(message.requestId)
          ) {
            completeRequest(message.requestId);
          }
        }, 250);
      }
      return;
    }

    if (message.type === WS_EVENTS.TTS_START) {
      if (
        ignoredPlaybackRequestsRef.current.has(message.requestId) ||
        !transitionRequest(
          requestLifecyclesRef.current,
          message.requestId,
          "playing"
        )
      ) {
        return;
      }
      setCurrentRequest(message.requestId);
      // Over LiveKit the voice plays from the room, not from tts.chunk.
      if (!realtime.activeRef.current) playerRef.current?.start(message.requestId);
      return;
    }

    if (message.type === WS_EVENTS.TTS_CHUNK) {
      if (
        ignoredPlaybackRequestsRef.current.has(message.requestId) ||
        !canAcceptRequestEvent(
          requestLifecyclesRef.current,
          message.requestId,
          ["playing"]
        )
      ) {
        return;
      }

      playerRef.current?.push(
        message.requestId,
        message.sequence,
        base64ToUint8Array(message.chunk),
        message.mimeType
      );
      return;
    }

    if (message.type === WS_EVENTS.TTS_END) {
      if (
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId)
      ) {
        return;
      }
      const playing = playerRef.current?.has(message.requestId) ?? false;
      if (
        message.reason === "error" &&
        ttsFailedRequestsRef.current.has(message.requestId)
      ) {
        ttsFailedRequestsRef.current.delete(message.requestId);
        cleanupPlaybackQueue(message.requestId);
      } else if (message.reason !== "stop") {
        cancelRequest(
          message.requestId,
          message.reason === "error" ? "error" : "interrupted"
        );
      } else if (!playing) {
        completeRequest(message.requestId);
      } else {
        playerRef.current?.end(message.requestId);
      }
      return;
    }

    if (message.type === "error") {
      if (!message.requestId && message.message === "Conversation not found") {
        setError("That conversation no longer exists.");
        const socket = socketRef.current;
        if (socket) sendRaw(socket, { type: WS_EVENTS.CONVERSATIONS_REQUEST });
        // A link to a deleted chat: drop it from the address and start fresh.
        if (conversationIdOf(shell.chatPathRef.current)) {
          pendingRouteRef.current = chatPath(null);
          routeSettledRef.current = false;
          if (socket) sendRaw(socket, { type: WS_EVENTS.CONVERSATION_OPEN });
        }
        return;
      }
      if (
        message.requestId &&
        !canAcceptRequestEvent(requestLifecyclesRef.current, message.requestId)
      ) {
        return;
      }
      if (message.scope === "tts") {
        // Voice failed but text + visuals keep streaming.
        setError(`Voice reply unavailable: ${message.message}`);
        if (message.requestId) {
          ttsFailedRequestsRef.current.add(message.requestId);
          cleanupPlaybackQueue(message.requestId);
        }
        return;
      }
      setError(message.message);
      if (message.requestId) {
        cancelRequest(message.requestId, "error");
      }
    }
  }

  /** Show the user's words as they speak (live turn in progress). */
  function showLiveCaption(text: string): void {
    const turn = livePcmTurnRef.current;
    if (!turn || turn.cancelled || !text) return;
    setMessages((current) => {
      const existing = current.find(
        (item) => item.requestId === turn.requestId && item.role === "user"
      );
      if (existing) {
        return current.map((item) =>
          item.id === existing.id ? { ...item, content: text, transient: true } : item
        );
      }
      return [
        ...current,
        {
          id: createRequestId(),
          role: "user",
          content: text,
          requestId: turn.requestId,
          source: "audio",
          transient: true
        }
      ];
    });
  }

  /** Settings live on their own screen now. */
  function openSettings(section: "models" | "usage"): void {
    router.push(paths.settings(section));
  }

  /** Secure key prompts. Values are only ever sent, never received. */
  function handleSecretsMessage(message: ServerMessage): boolean {
    // The secrets list (Settings → Secrets) is kept by the gateway provider.
    if (message.type === SECRET_EVENTS.STATE) return true;
    if (message.type === SECRET_EVENTS.REQUEST) {
      const view = message.request;
      setMessages((current) => {
        const newestFirst = [...current].reverse();
        const owner =
          newestFirst.find((item) => item.role === "assistant" && item.requestId === view.runId) ??
          newestFirst.find((item) => item.role === "assistant");
        if (!owner) return current;
        return current.map((item) =>
          item === owner
            ? { ...item, secretPrompts: [...(item.secretPrompts ?? []).filter((entry) => entry.view.id !== view.id), { view, status: "pending" as const }] }
            : item
        );
      });
      return true;
    }
    if (message.type === SECRET_EVENTS.RESOLVED) {
      setMessages((current) =>
        current.map((item) =>
          item.secretPrompts?.some((entry) => entry.view.id === message.id)
            ? {
                ...item,
                secretPrompts: item.secretPrompts.map((entry) =>
                  entry.view.id !== message.id
                    ? entry
                    : message.status === "invalid"
                      ? { ...entry, submitting: false, error: message.message ?? "That key could not be saved." }
                      : { ...entry, status: message.status, submitting: false, error: undefined, ...(message.allowedHosts ? { savedHosts: message.allowedHosts } : {}) }
                )
              }
            : item
        )
      );
      return true;
    }
    return false;
  }

  function updateSecretPrompt(id: string, patch: Partial<SecretPromptEntry>): void {
    setMessages((current) =>
      current.map((item) =>
        item.secretPrompts?.some((entry) => entry.view.id === id)
          ? { ...item, secretPrompts: item.secretPrompts.map((entry) => (entry.view.id === id ? { ...entry, ...patch } : entry)) }
          : item
      )
    );
  }

  function provideSecret(id: string, value: string, allowedHosts: string[]): void {
    const socket = socketRef.current;
    if (!socket || !sendRaw(socket, { type: SECRET_EVENTS.PROVIDE, id, value, allowedHosts })) {
      updateSecretPrompt(id, { error: "Not connected — try again in a moment." });
      return;
    }
    updateSecretPrompt(id, { submitting: true, error: undefined });
  }

  function cancelSecret(id: string): void {
    const socket = socketRef.current;
    if (socket) sendRaw(socket, { type: SECRET_EVENTS.CANCEL, id });
    updateSecretPrompt(id, { status: "cancelled", submitting: false });
  }

  function decideApproval(id: string, decision: "approve" | "decline", remember: boolean): void {
    const socket = socketRef.current;
    if (!socket) return;
    const sent = sendRaw(socket, {
      type: WS_EVENTS.APPROVAL_DECISION,
      id,
      decision,
      ...(remember ? { remember: "conversation" as const } : {})
    });
    if (!sent) return;
    setMessages((current) =>
      current.map((item) =>
        item.approvals?.some((entry) => entry.view.id === id)
          ? {
              ...item,
              approvals: item.approvals.map((entry) =>
                entry.view.id === id ? { ...entry, submitting: true } : entry
              )
            }
          : item
      )
    );
  }

  function sendUiAction(action: GenUiAction): void {
    sendMessage(action.prompt, action.display, "ui");
  }

  function sendMessage(
    overrideText?: string,
    displayText?: string,
    source: "text" | "ui" = "text",
    files?: AttachmentRef[],
    /** Create mode: make media from the text (files are then only shown, references travel in the spec). */
    mediaSpec?: MediaCreateSpec
  ): void {
    const text = (overrideText ?? input).trim();
    const socket = socketRef.current;
    if (!socket || !connected || activeRequestIdRef.current || (!text && !files?.length) || (mediaSpec && !text)) {
      return;
    }
    void playerRef.current?.unlock();

    const requestId = createRequestId();
    beginRequestLatency(requestId, "text");
    beginRequest(requestLifecyclesRef.current, requestId, "responding");
    setError(null);
    if (overrideText === undefined) setInput("");
    setCurrentRequest(requestId);
    setMessages((current) => [
      ...current,
      {
        id: createRequestId(),
        role: "user",
        content: displayText ?? text,
        requestId,
        source,
        ...(files?.length ? { attachments: files } : {})
      },
      {
        id: createRequestId(),
        role: "assistant",
        content: "",
        requestId
      }
    ]);

    if (!sendRaw(socket, {
      type: WS_EVENTS.USER_TEXT,
      requestId,
      text,
      ...(mediaSpec ? { media: mediaSpec } : files?.length ? { attachments: files } : {})
    })) {
      cancelRequest(requestId);
      setError("The message was not sent because the gateway disconnected.");
    }
  }

  async function startRecording(): Promise<void> {
    void playerRef.current?.unlock();
    const socket = socketRef.current;
    let requestedStream: MediaStream | null = null;
    if (!socket || !connected || activeRequestId || recording) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicError("This browser does not support microphone recording.");
      return;
    }

    try {
      pttPermissionPendingRef.current = true;
      pttStartCancelledRef.current = false;
      setError(null);
      setMicError(null);
      setRecordingStatus("Requesting microphone permission...");

      const stream = await getAudioInputStream();
      requestedStream = stream;
      const mimeType = selectAudioMimeType();
      const requestId = createRequestId();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
      const context: PushToTalkRecording = {
        requestId,
        recorder,
        stream,
        mimeType: recorder.mimeType || mimeType || "audio/webm",
        sequence: 0,
        pendingSends: [],
        cancelled: false,
        finalizing: false,
        ...(settings?.voiceModel ? { blobs: [] } : {})
      };

      pttPermissionPendingRef.current = false;
      if (
        pttStartCancelledRef.current ||
        !connected ||
        socketRef.current !== socket
      ) {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingStatus(null);
        return;
      }

      pttRecordingRef.current = context;
      requestedStream = null;
      beginRequestLatency(requestId, "ptt");
      beginRequest(requestLifecyclesRef.current, requestId, "recording");
      setCurrentRequest(requestId);
      setRecording(true);
      setRecordingStatus("Recording...");

      recorder.addEventListener("dataavailable", (event) => {
        if (
          context.cancelled ||
          pttRecordingRef.current !== context ||
          event.data.size === 0
        ) {
          return;
        }

        if (context.blobs) {
          context.blobs.push(event.data);
          return;
        }
        const sequence = context.sequence++;
        const sendPromise = sendAudioBlob(context, event.data, sequence);
        context.pendingSends.push(sendPromise);
      });

      recorder.addEventListener("stop", () => {
        void finalizePushToTalkRecording(context);
      });
      recorder.addEventListener(
        "start",
        () => markRequestLatency(requestId, "speechStartedAt"),
        { once: true }
      );

      recorder.start(recorderTimesliceMs);
    } catch (reason) {
      pttPermissionPendingRef.current = false;
      requestedStream?.getTracks().forEach((track) => track.stop());
      cancelPushToTalkRecording();
      setMicError(
        reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "Microphone permission was denied. Text input is still available."
          : "Could not start microphone recording. Text input is still available."
      );
      setRecordingStatus(null);
      clearCurrentRequest();
    }
  }

  function stopRecording(): void {
    if (pttPermissionPendingRef.current) {
      pttStartCancelledRef.current = true;
      setRecordingStatus(null);
      return;
    }

    const context = pttRecordingRef.current;
    if (!context || context.recorder.state === "inactive" || context.finalizing) {
      return;
    }

    context.finalizing = true;
    markRequestLatency(context.requestId, "speechEndedAt");
    transitionRequest(
      requestLifecyclesRef.current,
      context.requestId,
      "finalizing"
    );
    setRecording(false);
    setRecordingStatus(null);
    context.recorder.stop();
  }

  async function sendAudioBlob(
    context: PushToTalkRecording,
    blob: Blob,
    sequence: number
  ): Promise<void> {
    const chunk = await blobToBase64(blob);
    const socket = socketRef.current;
    if (
      context.cancelled ||
      !socket ||
      !canAcceptRequestEvent(requestLifecyclesRef.current, context.requestId)
    ) {
      return;
    }

    if (!sendRaw(socket, {
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: context.requestId,
      chunk,
      mimeType: context.mimeType,
      sequence,
      turnMode: "ptt",
      isFinal: false
    })) {
      throw new Error("gateway disconnected");
    }
  }

  async function finalizePushToTalkRecording(
    context: PushToTalkRecording
  ): Promise<void> {
    try {
      await Promise.all(context.pendingSends);
      const socket = socketRef.current;
      if (
        context.cancelled ||
        !socket ||
        !canAcceptRequestEvent(requestLifecyclesRef.current, context.requestId)
      ) {
        return;
      }

      if (context.blobs) {
        const recording = new Blob(context.blobs, { type: context.mimeType });
        let chunk: string;
        let mimeType = "audio/wav";
        try {
          chunk = uint8ArrayToBase64(await blobToWav(recording));
        } catch {
          // Could not decode locally: send the original clip (transcribed first).
          chunk = await blobToBase64(recording);
          mimeType = context.mimeType;
        }
        if (
          context.cancelled ||
          !canAcceptRequestEvent(requestLifecyclesRef.current, context.requestId)
        ) {
          return;
        }
        if (!sendRaw(socket, {
          type: WS_EVENTS.AUDIO_CHUNK,
          requestId: context.requestId,
          chunk,
          mimeType,
          sequence: 0,
          turnMode: "ptt",
          isFinal: true
        })) {
          throw new Error("gateway disconnected");
        }
      } else if (!sendRaw(socket, {
        type: WS_EVENTS.AUDIO_CHUNK,
        requestId: context.requestId,
        mimeType: context.mimeType,
        sequence: context.sequence,
        turnMode: "ptt",
        isFinal: true
      })) {
        throw new Error("gateway disconnected");
      }

      transitionRequest(
        requestLifecyclesRef.current,
        context.requestId,
        "transcribing"
      );
    } catch {
      if (!context.cancelled) {
        setError("Could not send recorded audio.");
        cancelRequest(context.requestId);
        setRecordingStatus(null);
      }
    } finally {
      cleanupPushToTalkRecording(context);
    }
  }

  function cancelPushToTalkRecording(updateUi = true): void {
    pttStartCancelledRef.current = true;
    const context = pttRecordingRef.current;
    if (!context) {
      return;
    }

    context.cancelled = true;
    settleRequest(
      requestLifecyclesRef.current,
      context.requestId,
      "cancelled"
    );
    settleRequestLatency(context.requestId, "interrupted");
    if (context.recorder.state !== "inactive") {
      context.recorder.stop();
    }
    cleanupPushToTalkRecording(context, updateUi);
  }

  function cleanupPushToTalkRecording(
    context: PushToTalkRecording,
    updateUi = true
  ): void {
    context.stream.getTracks().forEach((track) => track.stop());
    if (pttRecordingRef.current === context) {
      pttRecordingRef.current = null;
    }
    if (updateUi) {
      setRecording(false);
    }
  }

  function stopResponse(): void {
    const socket = socketRef.current;
    const requestId = activeRequestIdRef.current;
    if (!requestId) {
      return;
    }

    if (livePcmTurnRef.current?.requestId === requestId) {
      cancelLivePcmTurn(true);
    } else {
      cancelRequest(requestId);
    }
    setRecordingStatus(null);
    if (socket) {
      sendRaw(socket, {
        type: WS_EVENTS.INTERRUPT,
        requestId,
        reason: "user clicked stop"
      });
    }
  }

  async function toggleLiveMode(): Promise<void> {
    if (liveModeRef.current) {
      cleanupLiveMode(true);
      return;
    }

    if (!connected || !navigator.mediaDevices?.getUserMedia) {
      setMicError("This browser does not support microphone recording.");
      return;
    }

    if (realtime.available) {
      const generation = ++liveModeGenerationRef.current;
      setError(null);
      setMicError(null);
      setRecordingStatus("Starting live mode...");
      if (await realtime.start()) {
        if (generation !== liveModeGenerationRef.current) {
          realtime.stop();
          return;
        }
        liveModeRef.current = true;
        setLiveMode(true);
        setRecordingStatus("Live mode listening...");
        return;
      }
      // LiveKit unreachable: fall back to the WebSocket voice path below.
    }

    try {
      const generation = ++liveModeGenerationRef.current;
      setError(null);
      setMicError(null);
      setRecordingStatus("Starting live mode...");
      const stream = await getAudioInputStream();
      if (
        generation !== liveModeGenerationRef.current ||
        !socketRef.current ||
        socketRef.current.readyState !== WebSocket.OPEN
      ) {
        stream.getTracks().forEach((track) => track.stop());
        setRecordingStatus(null);
        return;
      }
      streamRef.current = stream;
      liveModeRef.current = true;
      liveListeningRef.current = true;
      const resetAt = performance.now();
      const resetSnapshot = speechDetectorRef.current?.reset(resetAt) ?? null;
      lastVadUiUpdateAtRef.current = resetAt;
      setVadSnapshot(resetSnapshot);
      await setupVadPipeline(stream);
      void playerRef.current?.unlock();
      if (liveCaptionsSupported()) {
        captionsRef.current ??= new LiveCaptions(showLiveCaption);
        captionsRef.current.start();
      }
      setLiveMode(true);
      setRecordingStatus(
        vadConfig.adaptiveEnabled
          ? "Live mode calibrating ambient noise..."
          : "Live mode listening..."
      );
    } catch {
      cleanupLiveMode(false);
      setMicError("Could not start live mode. Text input is still available.");
    }
  }

  async function setupVadPipeline(stream: MediaStream): Promise<void> {
    cleanupVadPipeline();
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    const audioContext = new AudioContextConstructor();
    const source = audioContext.createMediaStreamSource(stream);
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;

    audioContextRef.current = audioContext;
    vadSourceRef.current = source;
    vadMuteGainRef.current = muteGain;

    try {
      await audioContext.audioWorklet.addModule("/vad-worklet.js");
      if (!liveModeRef.current || streamRef.current !== stream) {
        throw new Error("live mode stopped while audio worklet was loading");
      }
      const node = new AudioWorkletNode(audioContext, "open-gpt-live-vad");
      node.port.onmessage = (event: MessageEvent<VadWorkletFrame>) => {
        if (
          typeof event.data.rms === "number" &&
          event.data.pcm instanceof ArrayBuffer &&
          event.data.sampleRate === LIVE_PCM_SAMPLE_RATE
        ) {
          handleVadFrame(event.data.rms, new Int16Array(event.data.pcm));
        }
      };
      source.connect(node);
      node.connect(muteGain);
      muteGain.connect(audioContext.destination);
      vadWorkletNodeRef.current = node;
    } catch {
      if (!liveModeRef.current || streamRef.current !== stream) {
        throw new Error("live mode stopped while audio worklet was loading");
      }
      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      const resampler = new StreamingPcm16Resampler(audioContext.sampleRate);
      const frameBuffer = new Pcm16FrameBuffer();
      fallbackResamplerRef.current = resampler;
      fallbackFrameBufferRef.current = frameBuffer;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const resampled = resampler.push(input);
        for (const frame of frameBuffer.push(resampled)) {
          handleVadFrame(calculatePcm16Rms(frame), frame);
        }
      };
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(audioContext.destination);
      vadScriptProcessorRef.current = processor;
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }

  function handleVadFrame(rms: number, samples: Int16Array): void {
    if (!liveModeRef.current || !liveListeningRef.current) {
      return;
    }

    const now = performance.now();
    const detector = speechDetectorRef.current;
    if (!detector) {
      return;
    }
    const frame: LivePcmFrame = {
      samples,
      durationMs: (samples.length / LIVE_PCM_SAMPLE_RATE) * 1_000
    };
    if (detector.isTurnActive()) {
      sendLivePcmFrame(frame);
    } else {
      appendPreRollFrame(frame);
    }

    const playbackActive = isPlaybackActive();
    const wasCalibrating = detector.getSnapshot().state === "calibrating";
    const result = detector.processFrame({
      rms,
      now,
      playbackActive,
      suppressStartsUntil: playbackVadSuppressedUntilRef.current
    });
    if (result.event || now - lastVadUiUpdateAtRef.current >= 150) {
      lastVadUiUpdateAtRef.current = now;
      setVadSnapshot(result.snapshot);
    }

    if (wasCalibrating && result.snapshot.state !== "calibrating") {
      setRecordingStatus("Live mode listening...");
    }

    if (result.event?.type === "speech_start") {
      startLiveSpeechTurn(rms, result.event.startedAt);
    } else if (result.event?.type === "speech_end") {
      endLiveSpeechTurn(
        result.event.reason === "max_duration" ? "manual" : "silence",
        result.event.silenceMs
      );
    } else if (result.event?.type === "speech_pause" || result.event?.type === "speech_resume") {
      // Preemptive generation: the gateway may start the reply during the pause.
      const turn = livePcmTurnRef.current;
      const socket = socketRef.current;
      if (turn && !turn.cancelled && socket) {
        sendRaw(
          socket,
          result.event.type === "speech_pause"
            ? { type: VOICE_LATENCY_EVENTS.SPEECH_PAUSE, requestId: turn.requestId, silenceMs: result.event.silenceMs }
            : { type: VOICE_LATENCY_EVENTS.SPEECH_RESUME, requestId: turn.requestId }
        );
      }
    } else if (result.event?.type === "speech_cancel") {
      cancelLivePcmTurn(true);
      clearPreRoll();
      setRecordingStatus("Live mode listening (short sound ignored)...");
    }
  }

  function startLiveSpeechTurn(rms: number, detectedAt: number): void {
    const socket = socketRef.current;
    if (!socket || livePcmTurnRef.current) {
      speechDetectorRef.current?.cancelTurn(performance.now());
      return;
    }

    const interruptedRequestId =
      activeRequestIdRef.current ?? getActivePlaybackRequestId();
    if (interruptedRequestId) {
      cancelRequest(interruptedRequestId);
      sendRaw(socket, {
        type: WS_EVENTS.INTERRUPT,
        requestId: interruptedRequestId,
        reason: "live mode barge-in"
      });
    }

    const requestId = createRequestId();
    const turn: LivePcmTurn = {
      requestId,
      sequence: 0,
      startedAt: detectedAt,
      cancelled: false
    };
    livePcmTurnRef.current = turn;
    captionsRef.current?.markTurnStart();
    beginRequestLatency(requestId, "live", detectedAt);
    markRequestLatency(requestId, "speechStartedAt", detectedAt);
    beginRequest(requestLifecyclesRef.current, requestId, "recording");
    setCurrentRequest(requestId);
    setRecording(true);
    setRecordingStatus("Listening...");

    if (!sendRaw(socket, {
      type: WS_EVENTS.VAD_SPEECH_START,
      requestId,
      turnMode: "live",
      startedAt: detectedAt,
      rms
    })) {
      cancelLivePcmTurn(false);
      setError("Could not start the live speech turn because the gateway disconnected.");
      return;
    }

    const preRollFrames = preRollFramesRef.current;
    preRollFramesRef.current = [];
    for (const preRollFrame of preRollFrames) {
      if (livePcmTurnRef.current !== turn) {
        break;
      }
      sendLivePcmFrame(preRollFrame);
    }
  }

  function sendLivePcmFrame(frame: LivePcmFrame): void {
    const turn = livePcmTurnRef.current;
    const socket = socketRef.current;
    if (
      !turn ||
      turn.cancelled ||
      !socket ||
      !canAcceptRequestEvent(requestLifecyclesRef.current, turn.requestId, [
        "recording"
      ])
    ) {
      return;
    }

    const bytes = new Uint8Array(
      frame.samples.buffer,
      frame.samples.byteOffset,
      frame.samples.byteLength
    );
    const sent = sendRaw(socket, {
      type: WS_EVENTS.AUDIO_CHUNK,
      requestId: turn.requestId,
      chunk: uint8ArrayToBase64(bytes),
      mimeType: LIVE_PCM_MIME_TYPE,
      sequence: turn.sequence++,
      turnMode: "live",
      isFinal: false
    });

    if (!sent) {
      cancelLivePcmTurn(false);
      setError("Live audio stopped because the gateway disconnected.");
    }
  }

  function endLiveSpeechTurn(reason: "silence" | "manual", silenceMs?: number): void {
    const turn = livePcmTurnRef.current;
    livePcmTurnRef.current = null;
    clearPreRoll();
    setRecording(false);
    setRecordingStatus("Transcribing...");

    if (!turn || turn.cancelled) {
      return;
    }

    const socket = socketRef.current;
    const endedAt = performance.now();
    const caption = captionsRef.current?.text() ?? "";
    markRequestLatency(turn.requestId, "speechEndedAt", endedAt);
    if (
      !socket ||
      !sendRaw(socket, {
        type: WS_EVENTS.AUDIO_CHUNK,
        requestId: turn.requestId,
        mimeType: LIVE_PCM_MIME_TYPE,
        sequence: turn.sequence,
        turnMode: "live",
        isFinal: true
      })
    ) {
      cancelRequest(turn.requestId);
      setError("Could not finalize live audio after the gateway disconnected.");
      return;
    }

    sendRaw(socket, {
      type: WS_EVENTS.VAD_SPEECH_END,
      requestId: turn.requestId,
      endedAt,
      durationMs: endedAt - turn.startedAt,
      reason,
      ...(caption ? { caption } : {}),
      ...(silenceMs !== undefined ? { silenceMs } : {})
    });
    transitionRequest(
      requestLifecyclesRef.current,
      turn.requestId,
      "transcribing"
    );
  }

  function appendPreRollFrame(frame: LivePcmFrame): void {
    const frames = preRollFramesRef.current;
    frames.push(frame);
    let durationMs = frames.reduce((sum, item) => sum + item.durationMs, 0);
    while (frames.length > 0 && durationMs > vadConfig.preRollMs) {
      durationMs -= frames.shift()?.durationMs ?? 0;
    }
  }

  function clearPreRoll(): void {
    preRollFramesRef.current = [];
  }

  async function getAudioInputStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  }

  function cleanupLiveMode(notifyGateway = true, updateUi = true): void {
    liveModeGenerationRef.current += 1;
    liveModeRef.current = false;
    liveListeningRef.current = false;
    if (notifyGateway) realtime.stop();
    cancelLivePcmTurn(notifyGateway);
    captionsRef.current?.stop();
    cleanupVadPipeline();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    clearPreRoll();
    speechDetectorRef.current?.reset(performance.now());
    lastVadUiUpdateAtRef.current = 0;
    if (updateUi) {
      setLiveMode(false);
      setRecording(false);
      setRecordingStatus(null);
      setVadSnapshot(null);
    }
  }

  function cancelLivePcmTurn(notifyGateway: boolean): void {
    const turn = livePcmTurnRef.current;
    if (!turn) {
      return;
    }

    turn.cancelled = true;
    const socket = socketRef.current;
    if (notifyGateway && socket) {
      const cancelledAt = performance.now();
      sendRaw(socket, {
        type: WS_EVENTS.VAD_SPEECH_END,
        requestId: turn.requestId,
        endedAt: cancelledAt,
        durationMs: cancelledAt - turn.startedAt,
        reason: "cancelled"
      });
      sendRaw(socket, {
        type: WS_EVENTS.INTERRUPT,
        requestId: turn.requestId,
        reason: "live mode stopped"
      });
    }
    cancelRequest(turn.requestId);
    setRecordingStatus(null);
  }

  function cleanupVadPipeline(): void {
    vadWorkletNodeRef.current?.port.close();
    vadWorkletNodeRef.current?.disconnect();
    vadWorkletNodeRef.current = null;
    if (vadScriptProcessorRef.current) {
      vadScriptProcessorRef.current.onaudioprocess = null;
      vadScriptProcessorRef.current.disconnect();
      vadScriptProcessorRef.current = null;
    }
    vadSourceRef.current?.disconnect();
    vadSourceRef.current = null;
    vadMuteGainRef.current?.disconnect();
    vadMuteGainRef.current = null;
    fallbackResamplerRef.current = null;
    fallbackFrameBufferRef.current?.clear();
    fallbackFrameBufferRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }

  function isPlaybackActive(): boolean {
    return playerRef.current?.isActive() ?? false;
  }

  function getActivePlaybackRequestId(): string | null {
    return playerRef.current?.activeRequestId() ?? null;
  }

  async function playBlockedAudio(): Promise<void> {
    setManualPlaybackRequestId(null);
    await playerRef.current?.unlock();
  }

  function ignorePlaybackRequest(requestId: string): void {
    ignoredPlaybackRequestsRef.current.add(requestId);
    if (ignoredPlaybackRequestsRef.current.size > 400) {
      const oldest = ignoredPlaybackRequestsRef.current.values().next().value as
        | string
        | undefined;
      if (oldest) {
        ignoredPlaybackRequestsRef.current.delete(oldest);
      }
    }
    cleanupPlaybackQueue(requestId);
  }

  function cleanupPlaybackQueue(requestId: string): void {
    playerRef.current?.stop(requestId);
  }

  function cleanupAllPlayback(updateUi = true): void {
    playerRef.current?.stopAll();
    if (updateUi) {
      setManualPlaybackRequestId(null);
    }
  }

  function sendPlaybackAck(requestId: string, sequence: number): void {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendRaw(socket, {
      type: WS_EVENTS.PLAYBACK_ACK,
      requestId,
      sequence
    });
  }

  function setCurrentRequest(requestId: string): void {
    activeRequestIdRef.current = requestId;
    setActiveRequestId(requestId);
  }

  function clearCurrentRequest(requestId?: string): void {
    if (requestId && activeRequestIdRef.current !== requestId) {
      return;
    }
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
  }

  function completeRequest(requestId: string): void {
    settleRequest(requestLifecyclesRef.current, requestId, "completed");
    settleRequestLatency(requestId, "completed");
    clearCurrentRequest(requestId);
  }

  function cancelRequest(
    requestId: string,
    latencyStatus: Exclude<LatencyRequestStatus, "active" | "completed"> =
      "interrupted"
  ): void {
    settleRequest(requestLifecyclesRef.current, requestId, "cancelled");
    settleRequestLatency(requestId, latencyStatus);
    ignorePlaybackRequest(requestId);
    // A reply cut off before it said anything leaves no empty bubble behind.
    setMessages((current) =>
      current.filter(
        (item) =>
          !(
            item.requestId === requestId &&
            item.role === "assistant" &&
            item.kind !== "brain" &&
            !item.content.trim() &&
            !item.ui
          )
      )
    );

    const pttContext = pttRecordingRef.current;
    if (pttContext?.requestId === requestId && !pttContext.cancelled) {
      pttContext.cancelled = true;
      if (pttContext.recorder.state !== "inactive") {
        pttContext.recorder.stop();
      }
      cleanupPushToTalkRecording(pttContext);
    }

    const liveTurn = livePcmTurnRef.current;
    if (liveTurn?.requestId === requestId) {
      liveTurn.cancelled = true;
      livePcmTurnRef.current = null;
      speechDetectorRef.current?.cancelTurn(performance.now());
      clearPreRoll();
      setRecording(false);
    }

    clearCurrentRequest(requestId);
  }

  function cancelRequestsAfterDisconnect(): void {
    // The gateway expires pending approvals when the socket closes.
    setMessages((current) =>
      current.map((item) =>
        item.approvals?.some((entry) => entry.status === "pending")
          ? {
              ...item,
              approvals: item.approvals.map((entry) =>
                entry.status === "pending" ? { ...entry, status: "expired" as const, submitting: false } : entry
              )
            }
          : item
      )
    );
    for (const requestId of cancelActiveRequests(requestLifecyclesRef.current)) {
      ignorePlaybackRequest(requestId);
      settleRequestLatency(requestId, "interrupted");
    }
    cleanupAllPlayback();
    cancelPushToTalkRecording(false);
    cleanupLiveMode(false);
    activeRequestIdRef.current = null;
    setActiveRequestId(null);
    setRecording(false);
    setRecordingStatus(null);
  }

  function beginRequestLatency(
    requestId: string,
    kind: LatencyRequestKind,
    now = performance.now()
  ): void {
    setLatencySnapshot(
      beginLatencyRequest(latencyRegistryRef.current, requestId, kind, now)
    );
  }

  function markRequestLatency(
    requestId: string,
    mark: Parameters<typeof markLatency>[2],
    now = performance.now()
  ): void {
    const snapshot = markLatency(
      latencyRegistryRef.current,
      requestId,
      mark,
      now
    );
    if (!snapshot) return;
    setLatencySnapshot((current) =>
      !current || current.requestId === requestId ? snapshot : current
    );
  }

  function settleRequestLatency(
    requestId: string,
    status: Exclude<LatencyRequestStatus, "active">
  ): void {
    const snapshot = settleLatencyRequest(
      latencyRegistryRef.current,
      requestId,
      status
    );
    if (!snapshot) return;
    setLatencySnapshot((current) =>
      !current || current.requestId === requestId ? snapshot : current
    );
  }

  // Mirror playback into React so the voice indicator can show "Speaking".
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSpeaking(playerRef.current?.isActive() ?? false);
    }, 150);
    return () => window.clearInterval(timer);
  }, []);

  // Settings → Diagnostics shows the live voice numbers.
  useEffect(() => {
    useVoiceDiagnostics.setState({
      latency: latencySnapshot,
      vad: vadSnapshot,
      liveMode,
      adaptiveEnabled: vadConfig.adaptiveEnabled
    });
  }, [latencySnapshot, vadSnapshot, liveMode]);

  // ── Routing: the chat's address names the live chat (/ or /c/<id>) ──
  // Other screens keep the chat alive; the rail's Chat link brings you back
  // to the same address (shell.chatPath).
  const routedConversationId = conversationId && messages.length > 0 ? conversationId : null;
  /** Set while the chat catches up with Back/Forward, a link or a deep link. */
  const pendingRouteRef = useRef<string | null>(null);
  /** A conversation.state arrived since the pending route was set. */
  const routeSettledRef = useRef(false);
  /** The first conversation.state arrived (the address can follow the chat). */
  const routeReadyRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /** The live chat when the address was last updated (first message vs. switching chats). */
  const lastRoutedChatRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  /** Name a conversation in the address without adding a history entry. */
  function settleChatAddress(id: string | null): void {
    routeReadyRef.current = true;
    lastRoutedChatRef.current = conversationIdRef.current;
    const settled = chatPath(id);
    shell.setChatPath(settled);
    if (activeRef.current && window.location.pathname !== settled) {
      window.history.replaceState(window.history.state, "", settled);
    }
  }

  // Chat → address. Opening a chat adds a history entry; the first message
  // of a new chat only names the current one.
  useEffect(() => {
    if (!routeReadyRef.current || pendingRouteRef.current) return;
    const desired = chatPath(routedConversationId);
    const sameChat = lastRoutedChatRef.current === conversationId;
    lastRoutedChatRef.current = conversationId;
    const previous = shell.chatPathRef.current;
    if (previous === desired) return;
    shell.setChatPath(desired);
    // On another screen the address stays put; the Chat link carries the new one.
    if (!activeRef.current || window.location.pathname === desired) return;
    if (previous === chatPath(null) && routedConversationId && sameChat) {
      window.history.replaceState(window.history.state, "", desired);
    } else {
      window.history.pushState(window.history.state, "", desired);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, routedConversationId]);

  // Address → chat (links, Back / Forward, New chat).
  useEffect(() => {
    if (!isChatPath(pathname)) return;
    if (!routeReadyRef.current) {
      // Not connected yet: the open handler reads this address.
      shell.setChatPath(pathname);
      return;
    }
    const wanted = conversationIdOf(pathname);
    const shown = messagesRef.current.length > 0 ? conversationIdRef.current : null;
    if (wanted === shown) return;
    shell.setChatPath(pathname);
    pendingRouteRef.current = chatPath(wanted);
    routeSettledRef.current = false;
    switchConversation(wanted ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Send the next queued message as soon as Sibyl is free.
  useEffect(() => {
    if (!connected || activeRequestId || recording || queue.length === 0) return;
    const timer = window.setTimeout(() => {
      if (activeRequestIdRef.current) return;
      const [next, ...rest] = queue;
      if (!next) return;
      setQueue(rest);
      sendWithTransition(next.text, next.attachments, next.media);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [connected, activeRequestId, recording, queue]);

  // Follow new content unless the user scrolled up to read.
  useEffect(() => {
    if (atBottomRef.current) {
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  function onConversationScroll(): void {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  }

  /**
   * Make a conversation the live one: a stored one (its full context is
   * restored on the Gateway, so the chat simply continues) or a new one.
   */
  function switchConversation(id?: string): void {
    setSidebarOpen(false);
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Not connected to the gateway yet.");
      return;
    }
    if (activeRequestIdRef.current) stopResponse();
    setQueue([]);
    setError(null);
    sendRaw(socket, { type: WS_EVENTS.CONVERSATION_OPEN, ...(id ? { conversationId: id } : {}) });
  }

  function startNewChat(): void {
    setInput("");
    switchConversation();
  }

  function openConversation(id: string): void {
    if (id === conversationId) {
      setSidebarOpen(false);
      return;
    }
    switchConversation(id);
  }

  function removeConversation(id: string): void {
    const socket = socketRef.current;
    if (!socket || !sendRaw(socket, { type: WS_EVENTS.CONVERSATION_DELETE, conversationId: id })) {
      setError("Not connected to the gateway; the conversation was not deleted.");
    }
  }

  function exportConversation(): void {
    const source = messages.filter((item) => !item.transient);
    if (!source.length) return;
    const title = conversations.find((item) => item.id === conversationId)?.title ?? titleFor(source);
    const blob = new Blob([toMarkdown(title, source)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[^\w\- ]+/g, "").trim().slice(0, 48) || "sibyl-conversation"}.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function copyText(id: string, text: string): void {
    void navigator.clipboard?.writeText(text.replace(/\[[a-z][a-z' -]{0,30}\]\s*/gi, "")).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1400);
    });
  }

  function toggleSource(id: string): void {
    setOpenSources((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Send now if Sibyl is free, otherwise add to the queue. */
  function submitText(raw: string, fromComposer = false): void {
    const text = raw.trim();
    const uploaded = fromComposer ? toAttachmentRefs(attachments) : [];
    if (fromComposer && attachments.some((item) => item.status === "uploading")) return;
    // Create mode needs a prompt; references picked with @ travel with the message.
    if (fromComposer && chatMedia.mode !== "chat" && !text) return;
    const prepared = fromComposer ? chatMedia.prepare(uploaded) : { attachments: [] as AttachmentRef[] };
    const files = [...uploaded, ...prepared.attachments.filter((ref) => !uploaded.some((file) => file.id === ref.id))];
    if (!text && files.length === 0) return;
    if (fromComposer) {
      setInput("");
      clearAttachments();
    }
    if (activeRequestIdRef.current || recording || queue.length > 0) {
      setQueue((items) => [...items, { id: createRequestId(), text, ...(files.length ? { attachments: files } : {}), ...(prepared.media ? { media: prepared.media } : {}) }]);
      return;
    }
    sendWithTransition(text, files, prepared.media);
  }

  /** Upload files picked, dropped or pasted into the composer. */
  function addFiles(files: File[]): void {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setError(`At most ${MAX_ATTACHMENTS} files per message.`);
      return;
    }
    for (const file of files.slice(0, room)) {
      const localId = createRequestId();
      const name = file.name || `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`;
      const named = file.name ? file : new File([file], name, { type: file.type });
      const previewUrl = isImageMime(file.type) ? URL.createObjectURL(file) : undefined;
      setAttachments((items) => [
        ...items,
        { localId, name, size: file.size, mime: file.type || "application/octet-stream", status: "uploading", progress: 0, ...(previewUrl ? { previewUrl } : {}) }
      ]);
      const patch = (change: Partial<ComposerAttachment>) =>
        setAttachments((items) => items.map((item) => (item.localId === localId ? { ...item, ...change } : item)));
      const upload = uploadFile(named, {
        conversationId: conversationIdRef.current,
        onProgress: (progress) => patch({ progress })
      });
      uploadAbortsRef.current.set(localId, upload.abort);
      upload.promise.then(
        (uploaded) => patch({ status: "ready", progress: 1, id: uploaded.id, mime: uploaded.mime, size: uploaded.size, name: uploaded.name }),
        (cause: unknown) => patch({ status: "error", error: (cause as Error).message })
      ).finally(() => uploadAbortsRef.current.delete(localId));
    }
    if (files.length > room) setError(`At most ${MAX_ATTACHMENTS} files per message; the rest were skipped.`);
  }

  function removeAttachment(localId: string): void {
    uploadAbortsRef.current.get(localId)?.();
    setAttachments((items) => {
      const item = items.find((entry) => entry.localId === localId);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return items.filter((entry) => entry.localId !== localId);
    });
  }

  function clearAttachments(): void {
    setAttachments((items) => {
      for (const item of items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }

  function sendQueuedNow(id: string): void {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    setQueue((items) => items.filter((entry) => entry.id !== id));
    if (activeRequestIdRef.current) stopResponse();
    sendWithTransition(item.text, item.attachments, item.media);
  }

  function editQueued(id: string): void {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    setQueue((items) => items.filter((entry) => entry.id !== id));
    setInput((current) => (current.trim() ? `${current.trim()}\n${item.text}` : item.text));
    if (item.attachments?.length) {
      const restored = item.attachments.map((file): ComposerAttachment => ({
        localId: createRequestId(),
        id: file.id,
        name: file.name,
        mime: file.mime,
        size: file.size ?? 0,
        status: "ready",
        progress: 1
      }));
      setAttachments((items) => [...items, ...restored].slice(0, MAX_ATTACHMENTS));
    }
  }

  function moveQueuedUp(id: string): void {
    setQueue((items) => {
      const index = items.findIndex((entry) => entry.id === id);
      if (index <= 0) return items;
      const next = [...items];
      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
      return next;
    });
  }

  function sendQueueTogether(): void {
    if (queue.length === 0) return;
    const combined = queue.map((entry) => entry.text).filter(Boolean).join("\n\n");
    const files = queue.flatMap((entry) => entry.attachments ?? []).slice(0, MAX_ATTACHMENTS);
    const merged: QueuedItem = { id: createRequestId(), text: combined, ...(files.length ? { attachments: files } : {}) };
    if (activeRequestIdRef.current) {
      setQueue([merged]);
      return;
    }
    setQueue([]);
    sendWithTransition(combined, files);
  }

  function sendWithTransition(text: string, files?: AttachmentRef[], mediaSpec?: MediaCreateSpec): void {
    // Glide the composer from the centre to the bottom on the first message.
    const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
    if (messages.length === 0 && doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      doc.startViewTransition(() => {
        flushSync(() => sendMessage(text, undefined, "text", files, mediaSpec));
      });
      return;
    }
    sendMessage(text, undefined, "text", files, mediaSpec);
  }

  /** "Make another": the same prompt, model and settings, as a Create-mode message. */
  function regenerateMedia(item: MediaItemView): void {
    const spec = chatMedia.regenerateSpec(item);
    if (activeRequestIdRef.current || recording || queue.length > 0) {
      setQueue((items) => [...items, { id: createRequestId(), text: item.prompt, media: spec }]);
      return;
    }
    sendWithTransition(item.prompt, undefined, spec);
  }

  /** "Use as reference": a chip in the composer, named in the prompt (@image1). */
  function useMediaAsReference(output: MediaOutputView, item: MediaItemView): void {
    const token = chatMedia.addReference(output, item);
    setInput((current) => (current.includes(token) ? current : `${current}${current && !/\s$/.test(current) ? " " : ""}${token} `));
  }

  const vadState = vadSnapshot?.state;
  const userSpeaking =
    (liveMode && (vadState === "speaking" || vadState === "speech_candidate" || vadState === "pause")) ||
    (recording && (!liveMode || realtime.active));
  const voiceState: VoiceState = !connected
    ? "offline"
    : speaking || realtime.agentSpeaking
      ? "speaking"
      : userSpeaking
        ? "listening"
        : activeRequestId
          ? "thinking"
          : liveMode
            ? "ready"
            : "idle";
  const lastAssistantId = [...messages].reverse().find((item) => item.role === "assistant")?.id;
  const panelSources = useMemo(() => sidePanelSources(messages), [messages]);
  const latestGroupKey = groupTurns(messages).at(-1)?.key;
  const empty = messages.length === 0;
  const saved = conversations.find((item) => item.id === conversationId);
  const title = saved?.title ?? (messages.length ? titleFor(messages) : "New conversation");
  const modelLabel = (id?: string) =>
    catalog?.llm.find((model) => model.id === id)?.label ?? id?.split("/").pop() ?? "";

  const starters: Array<{ icon: IconName; label: string; text: string }> = [
    { icon: "layers", label: "Compare the planets", text: "Compare the planets of the solar system in a table" },
    { icon: "sparkle", label: "Plan a trip to Lisbon", text: "Plan a relaxed 3-day trip to Lisbon" },
    { icon: "activity", label: "Chart phone market share", text: "Show me global smartphone market share as a chart" },
    { icon: "check", label: "Help me pick a laptop", text: "Help me pick a laptop — ask me questions with a form" }
  ];
  const firstName = session.user?.name?.trim().split(/\s+/)[0];
  const greeting = `${partOfDay(new Date())}${firstName ? `, ${firstName}` : ""}`;

  return (
    <div className={`chatScreen${sidebarOpen ? " sidebarOpen" : ""}`} hidden={!active}>
      <Sidebar
        open={sidebarOpen}
        catalog={catalog}
        settings={settings}
        conversations={conversations}
        activeConversationId={conversationId}
        onNewChat={startNewChat}
        onOpenConversation={openConversation}
        onDeleteConversation={removeConversation}
        onApplyPreset={(patch) => updateSettings(patch)}
        onOpenSettings={() => openSettings("models")}
        onClose={() => setSidebarOpen(false)}
      />
      {sidebarOpen ? <button type="button" className="scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} /> : null}

      <SidePanelLayout conversationId={conversationId} sources={panelSources} active={active} onVisualAction={sendUiAction}>
      <main className="main" id={active ? "main" : undefined}>
        <header className="topbar">
          <button type="button" className="iconBtn mobileOnly" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <Icon name="menu" />
          </button>
          <InboxBell className="iconBtn mobileOnly" count={gateway.inboxCount} />
          <div className="topTitle">
            <span className="titleText" title={title}>{title}</span>
            {connectionStatus !== "connected" || liveMode ? (
              <span className={`statusBadge ${connectionStatus}`}>
                <i />
                {connectionStatus === "connected"
                  ? "Live"
                  : connectionStatus === "reconnecting" || connectionStatus === "connecting"
                    ? "Connecting"
                    : "Offline"}
              </span>
            ) : null}
          </div>
          <div className="topActions">
            <SidePanelToggle className="ghostBtn" />
            {realtime.available ? (
              <button
                type="button"
                className="ghostBtn"
                onClick={() => void startMeetingFromChat(saved ? title : undefined).then((id) => router.push(paths.call(id, true)))}
                disabled={!connected}
                title="Start a meeting with people and agents from this chat"
              >
                <Icon name="video" size={16} />
                <span className="hideSm">Meet</span>
              </button>
            ) : null}
            <button type="button" className="ghostBtn" onClick={() => openSettings("models")}>
              <Icon name="sliders" size={16} />
              <span className="hideSm">Configure</span>
            </button>
            {empty ? null : (
              <button type="button" className="ghostBtn" onClick={exportConversation} title="Download this conversation as Markdown">
                <Icon name="share" size={16} />
                <span className="hideSm">Share</span>
              </button>
            )}
            <button type="button" className="darkBtn" onClick={startNewChat}>
              <Icon name="plus" size={16} />
              <span className="hideSm">New chat</span>
            </button>
          </div>
        </header>

        <section className={`canvas${empty ? " empty" : ""}`}>
          <div className="scroller" ref={scrollerRef} onScroll={onConversationScroll} aria-live="polite">
            {empty ? (
              <div className="hero">
                <SilverMark size={48} />
                <h1>{greeting}</h1>
                <p>Type, or tap the mic and just talk.</p>
              </div>
            ) : (
              <div className="thread">
                {groupTurns(messages).map((group) => {
                  const replies = group.replies;
                  const lastReply = replies[replies.length - 1];
                  const isLatest = group.key === latestGroupKey;
                  const pending =
                    isLatest &&
                    Boolean(activeRequestId) &&
                    !replies.some((reply) => reply.content.trim() || reply.ui || reply.tools?.length);
                  // Tools have run but the answer hasn't started yet.
                  const composing =
                    isLatest &&
                    Boolean(activeRequestId) &&
                    !pending &&
                    replies.some((reply) => reply.kind !== "brain" && !reply.done && reply.tools?.length) &&
                    replies.every((reply) => !reply.tools?.some((tool) => tool.status === "running")) &&
                    !replies.some((reply) => reply.content.trim() || reply.ui);
                  const settled =
                    replies.length > 0 &&
                    replies.every((reply) => reply.done) &&
                    replies.some((reply) => reply.content.trim() || reply.ui);
                  const replyText = replies
                    .map((reply) => cleanText(reply.content))
                    .filter(Boolean)
                    .join("\n\n");
                  const visuals = replies.filter((reply) => reply.ui);
                  const replyAgent = replies.map((reply) => gateway.agents.turns[reply.requestId]).find(Boolean);
                  return (
                    <div className="turnGroup" key={group.key}>
                      {group.user ? (
                        <article className={`turn user${group.user.transient ? " transient" : ""}`}>
                          <div className="bubble">
                            {group.user.source === "audio" ? <Icon name="mic" size={13} className="bubbleIcon" /> : null}
                            {group.user.source === "ui" ? <Icon name="layers" size={13} className="bubbleIcon" /> : null}
                            {group.user.content ||
                              (group.user.attachments?.length ? null : <span className="typing"><i /><i /><i /></span>)}
                            <AttachmentList
                              attachments={group.user.attachments}
                              action={(file) => <SaveToKnowledgeButton uploadId={file.id} />}
                              onOpen={(file) => openSidePanel({ kind: "file", uploadId: file.id, name: file.name, mime: file.mime })}
                            />
                          </div>
                        </article>
                      ) : null}

                      {replies.length > 0 || pending ? (
                        <article className="reply">
                          {replyAgent ? (
                            <span className="replyAvatar agent" title={replyAgent.name}>
                              <AgentAvatar
                                avatar={replyAgent.avatar}
                                name={replyAgent.name}
                                size={28}
                                mood={
                                  pending
                                    ? voiceState === "listening"
                                      ? "listening"
                                      : "thinking"
                                    : composing
                                      ? "thinking"
                                      : isLatest && voiceState === "speaking"
                                        ? "speaking"
                                        : "idle"
                                }
                              />
                            </span>
                          ) : (
                          <span className={`replyAvatar${isLatest && voiceState === "speaking" ? " live" : ""}`} aria-hidden>
                            <SibylLoader
                              size={14}
                              state={
                                pending
                                  ? voiceState === "listening"
                                    ? "listening"
                                    : "thinking"
                                  : composing
                                    ? "working"
                                    : isLatest &&
                                        voiceState === "speaking" &&
                                        !replies.some((reply) => !reply.done && (reply.kind === "brain" || reply.tools?.some((tool) => tool.status === "running")))
                                      ? "speaking"
                                      : "idle"
                              }
                            />
                          </span>
                          )}
                          <div className="replyBody">
                            {pending ? (
                              <ThinkingStatus phase={voiceState === "listening" ? "listening" : "thinking"} />
                            ) : null}
                            {replies.map((message) => (
                              <div className="replyPart" key={message.id}>
                                {message.kind === "brain" ? (
                                  <div className="steps">
                                    <button
                                      type="button"
                                      className="step"
                                      aria-expanded={openSources.has(`task:${message.id}`)}
                                      onClick={() => toggleSource(`task:${message.id}`)}
                                    >
                                      {message.failed ? (
                                        <Icon name="close" size={15} className="stepIcon fail" />
                                      ) : message.done ? (
                                        <Icon name="check" size={15} className="stepIcon done" />
                                      ) : (
                                        <SibylLoader state="working" size={15} />
                                      )}
                                      <span>
                                        {message.failed
                                          ? "Deep work hit a problem"
                                          : message.done
                                            ? "Thought it through"
                                            : message.approvals?.some((entry) => entry.status === "pending")
                                              ? "Waiting for your approval…"
                                              : message.ui
                                                ? "Building the visual…"
                                                : "Thinking it through…"}
                                      </span>
                                      <span className="stepChip">{modelLabel(message.model)}</span>
                                      <span className="stepChevron" aria-hidden>›</span>
                                    </button>
                                    {openSources.has(`task:${message.id}`) && message.task ? (
                                      <p className="stepDetail">{message.task}</p>
                                    ) : null}
                                    <ToolSteps tools={message.tools} settled={Boolean(message.done)} />
                                  </div>
                                ) : message.tools?.length ? (
                                  <div className="steps">
                                    <ToolSteps tools={message.tools} settled={Boolean(message.done)} />
                                  </div>
                                ) : null}
                                {replyAgent && message.tools?.some((tool) => isComputerTool(tool.toolName)) ? (
                                  <ComputerThumbnail
                                    agentId={replyAgent.agentId}
                                    agentName={replyAgent.name}
                                    onOpen={() => openSidePanel({ kind: "computer", agentId: replyAgent.agentId })}
                                  />
                                ) : null}
                                {message.tools?.map((tool) =>
                                  tool.artifact?.kind === "slides" ? (
                                    <SlidesCard
                                      key={`deck:${tool.callId}`}
                                      artifact={tool.artifact}
                                      onRevise={setInput}
                                      onPreview={() => openSidePanel({ kind: "slides", artifactId: tool.artifact!.id, title: tool.artifact!.title })}
                                    />
                                  ) : tool.artifact?.kind === "media" && tool.artifact.media ? (
                                    <MediaResult key={`media:${tool.callId}`} item={tool.artifact.media} onUseAsReference={useMediaAsReference} onRegenerate={regenerateMedia} onRemix={chatMedia.remix} />
                                  ) : null
                                )}
                                {/* After a reload the tool steps are gone: the conversation's media, by the reply they belong to. */}
                                {!message.tools?.some((tool) => tool.artifact?.kind === "media")
                                  ? chatMedia.byRequest.get(message.requestId)?.map((item) => (
                                      <MediaResult key={`media:${item.id}`} item={item} onUseAsReference={useMediaAsReference} onRegenerate={regenerateMedia} onRemix={chatMedia.remix} />
                                    ))
                                  : null}
                                {message.tools?.some((tool) => tool.toolName === "remember" && tool.status === "ok") ? (
                                  <MemorySavedChip
                                    summary={message.tools.find((tool) => tool.toolName === "remember" && tool.status === "ok")?.summary}
                                  />
                                ) : null}
                                {message.approvals?.map((entry) => (
                                  <ApprovalCard
                                    key={entry.view.id}
                                    approval={entry.view}
                                    status={entry.status}
                                    submitting={entry.submitting}
                                    onDecide={(decision, remember) => decideApproval(entry.view.id, decision, remember)}
                                  />
                                ))}
                                {message.secretPrompts?.map((entry) => (
                                  <SecretPrompt
                                    key={entry.view.id}
                                    request={entry.view}
                                    status={entry.status}
                                    submitting={entry.submitting}
                                    error={entry.error}
                                    savedHosts={entry.savedHosts}
                                    onSave={(value, hosts) => provideSecret(entry.view.id, value, hosts)}
                                    onCancel={() => cancelSecret(entry.view.id)}
                                  />
                                ))}
                                {cleanText(message.content) ? (
                                  <SpokenText className="spoken" text={cleanText(message.content)} />
                                ) : null}
                                {message.ui ? (
                                  <GenUiView
                                    source={message.ui}
                                    streaming={!message.done}
                                    onAction={message.id === lastAssistantId ? sendUiAction : undefined}
                                  />
                                ) : null}
                                {message.ui && openSources.has(message.id) ? (
                                  <pre className="sourceView">{message.ui}</pre>
                                ) : null}
                              </div>
                            ))}
                            {composing ? <ThinkingStatus phase="composing" /> : null}
                            {settled && lastReply ? (
                              <div className="actions">
                                <button
                                  type="button"
                                  className="actionBtn"
                                  aria-label="Copy reply"
                                  title={copiedId === lastReply.id ? "Copied" : "Copy"}
                                  onClick={() => copyText(lastReply.id, replyText)}
                                >
                                  <Icon name={copiedId === lastReply.id ? "check" : "copy"} size={15} />
                                </button>
                                {visuals.map((visual) => (
                                  <button
                                    key={`expand:${visual.id}`}
                                    type="button"
                                    className="actionBtn"
                                    aria-label="Expand the visual next to the chat"
                                    title="Expand"
                                    onClick={() => openSidePanel({ kind: "visual", requestId: visual.requestId })}
                                  >
                                    <Icon name="layers" size={15} />
                                  </button>
                                ))}
                                {visuals.map((visual) => (
                                  <button
                                    key={visual.id}
                                    type="button"
                                    className={`actionBtn${openSources.has(visual.id) ? " on" : ""}`}
                                    aria-label="Show visual source"
                                    title="Show visual source"
                                    onClick={() => toggleSource(visual.id)}
                                  >
                                    <Icon name="code" size={15} />
                                  </button>
                                ))}
                                {group.user && isLatest ? (
                                  <button
                                    type="button"
                                    className="actionBtn"
                                    aria-label="Ask again"
                                    title="Ask again"
                                    disabled={!connected}
                                    onClick={() => {
                                      const user = group.user!;
                                      if (user.attachments?.length && !activeRequestIdRef.current && queue.length === 0) {
                                        sendWithTransition(user.content, user.attachments);
                                      } else submitText(user.content);
                                    }}
                                  >
                                    <Icon name="history" size={15} />
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </article>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="dock">
            {showJump && !empty ? (
              <button
                type="button"
                className="jumpBtn"
                aria-label="Scroll to latest"
                onClick={() => {
                  atBottomRef.current = true;
                  scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
                }}
              >
                <Icon name="arrowUp" size={16} className="flip" />
              </button>
            ) : null}

            {manualPlaybackRequestId ? (
              <button className="notice action" type="button" onClick={playBlockedAudio}>
                Tap to enable Sibyl&apos;s voice
              </button>
            ) : null}
            {micError ? <p className="notice error">{micError}</p> : null}
            {error ? <p className="notice error">{error}</p> : null}
            {budgetNotice ? (
              <div className="notice budgetNotice" role="alert">
                <span>{budgetNotice.message}</span>
                {/* Hosted organizations on AI credits: add credits or their own key (Settings → Models). */}
                <button type="button" className="ghostBtn" onClick={() => openSettings(budgetNotice.credits ? "models" : "usage")}>
                  {budgetNotice.credits ? "Add credits" : "View usage"}
                </button>
                <button
                  type="button"
                  className="iconBtn"
                  aria-label="Dismiss budget notice"
                  onClick={() => setBudgetNotice(null)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ) : null}
              <QueueStack
                items={queue}
                busy={Boolean(activeRequestId)}
                onSendNow={sendQueuedNow}
                onEdit={editQueued}
                onRemove={(id) => setQueue((items) => items.filter((item) => item.id !== id))}
                onMoveUp={moveQueuedUp}
                onSendTogether={sendQueueTogether}
                onClear={() => setQueue([])}
              />
              <Composer
                agentSlot={
                  gateway.agents.agents.length > 0 ? (
                    <AgentPicker
                      agents={gateway.agents.agents}
                      selectedAgentId={gateway.agents.selectedAgentId}
                      onSelect={gateway.agents.select}
                      onManage={() => router.push(paths.agents)}
                      disabled={!connected}
                    />
                  ) : null
                }
                value={input}
                onChange={setInput}
                onSubmit={() => submitText(input, true)}
                canSend={canSend}
                willQueue={Boolean(activeRequestId) || recording}
                connected={connected}
                responding={Boolean(activeRequestId) && !recording}
                voiceState={voiceState}
                level={vadSnapshot?.rms ?? 0}
                liveMode={liveMode}
                pushToTalk={recording && !liveMode}
                onToggleVoice={() => void toggleLiveMode()}
                onHoldStart={() => void startRecording()}
                onHoldEnd={stopRecording}
                onStop={stopResponse}
                catalog={catalog}
                settings={settings}
                activePresetId={activePresetId}
                onChangeSettings={(patch) => updateSettings(patch)}
                onOpenSettings={() => openSettings("models")}
                sessionUsd={usage?.sessionUsd}
                economyMode={usage?.economyMode}
                onOpenUsage={() => openSettings("usage")}
                attachments={attachments}
                onAddFiles={addFiles}
                onRemoveAttachment={removeAttachment}
                mediaControls={chatMedia.controls}
                hideModelMenu={chatMedia.mode !== "chat"}
                topSlot={chatMedia.tray}
                placeholder={chatMedia.placeholder}
                mention={{ items: chatMedia.mentionItems, onOpen: chatMedia.loadMentions, onPick: chatMedia.pick }}
              />
          </div>
          {empty ? (
            <ul className="starterRow" aria-label="Try asking">
              {starters.map((starter) => (
                <li key={starter.text}>
                  <button
                    type="button"
                    title={starter.text}
                    disabled={!connected || Boolean(activeRequestId)}
                    onClick={() => submitText(starter.text)}
                  >
                    <Icon name={starter.icon} size={15} />
                    {starter.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </main>
      </SidePanelLayout>

    </div>
  );
}

/** Tool calls as step rows: spinner while running, then check or ×. */
function ToolSteps({ tools, settled }: { tools?: ToolStep[]; settled: boolean }) {
  if (!tools?.length) return null;
  return (
    <>
      {tools.map((tool) => {
        const link = tool.link;
        const Row = link ? "button" : "div";
        return (
        <Row
          className={`step toolStep ${tool.status}`}
          key={tool.callId}
          {...(link
            ? { type: "button" as const, title: link.url, onClick: () => openSidePanel({ kind: "url", url: link.url, ...(link.title ? { title: link.title } : {}) }) }
            : {})}
        >
          {tool.status === "running" && !settled ? (
            <SibylLoader state="working" size={15} />
          ) : tool.status === "ok" ? (
            <Icon name="check" size={15} className="stepIcon done" />
          ) : (
            <Icon name="close" size={15} className="stepIcon fail" />
          )}
          <span>{tool.title}</span>
          {tool.summary && tool.status !== "ok" ? <span className="stepChip">{tool.summary}</span> : null}
          {link ? <span className="stepChevron" aria-hidden>›</span> : null}
        </Row>
        );
      })}
    </>
  );
}

interface TurnGroup {
  key: string;
  user?: ChatMessage;
  replies: ChatMessage[];
}

/** One user message plus everything Sibyl said back (voice, deep work, visuals). */
function groupTurns(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      groups.push({ key: message.id, user: message, replies: [] });
      continue;
    }
    const current = groups[groups.length - 1];
    if (current) current.replies.push(message);
    else groups.push({ key: message.id, replies: [message] });
  }
  return groups;
}

/** Trim and collapse runs of blank lines so replies don't leave big gaps. */
function cleanText(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A message from the Gateway's conversation store, ready to show. */
function fromStoredMessage(message: ConversationMessageView): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    requestId: message.requestId,
    ...(message.source ? { source: message.source } : {}),
    ...(message.ui ? { ui: message.ui } : {}),
    ...(message.kind ? { kind: message.kind } : {}),
    ...(message.task ? { task: message.task } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    done: true
  };
}

function selectAudioMimeType(): string {
  const preferred = ["audio/webm;codecs=opus", "audio/webm"];
  return preferred.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return uint8ArrayToBase64(bytes);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function calculatePcm16Rms(samples: Int16Array): number {
  let sumSquares = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const normalized = samples[index] / 0x8000;
    sumSquares += normalized * normalized;
  }

  return samples.length === 0 ? 0 : Math.sqrt(sumSquares / samples.length);
}

/** "Good morning" / "Good afternoon" / "Good evening" for the new-chat greeting. */
function partOfDay(now: Date): string {
  const hour = now.getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
