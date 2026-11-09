"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  WS_EVENTS,
  createRequestId,
  parseServerMessage,
  type ClientMessage,
  type ModelCatalog,
  type ServerMessage,
  type SessionCapabilities,
  type SessionSettings
} from "@open-gpt-live/protocol";
import { ThemeProvider, useSystemThemeMode } from "@openuidev/react-ui";
import { GenUiView, type GenUiAction } from "../components/GenUiView";
import { SettingsPanel } from "../components/SettingsPanel";
import { Composer } from "../components/Composer";
import { QueueStack, type QueuedMessage } from "../components/QueueStack";
import { Sidebar } from "../components/Sidebar";
import { Icon, type IconName } from "../components/Icon";
import { Mark, SilverMark } from "../components/Brand";
import type { VoiceState } from "../components/voice-state";
import { sibylDarkTheme, sibylLightTheme } from "../lib/sibyl-theme";
import {
  deleteConversation,
  loadConversations,
  saveConversation,
  titleFor,
  toMarkdown,
  type StoredConversation
} from "../lib/conversations";
import { SpokenText } from "../components/SpokenText";
import { StreamPlayer } from "../lib/stream-player";
import { LiveCaptions, liveCaptionsSupported } from "../lib/live-captions";
import { blobToWav } from "../lib/audio-wav";
import {
  LIVE_PCM_MIME_TYPE,
  LIVE_PCM_SAMPLE_RATE,
  Pcm16FrameBuffer,
  StreamingPcm16Resampler
} from "../lib/audio-pcm";
import { resolveVadConfig } from "../lib/live-config";
import {
  AdaptiveVadEngine,
  type SpeechDetector,
  type VadSnapshot
} from "../lib/vad-engine";
import {
  beginLatencyRequest,
  markLatency,
  settleLatencyRequest,
  type LatencyRegistry,
  type LatencyRequestKind,
  type LatencyRequestStatus,
  type LatencySnapshot
} from "../lib/latency-metrics";
import {
  beginRequest,
  canAcceptRequestEvent,
  cancelActiveRequests,
  settleRequest,
  transitionRequest,
  type RequestLifecycleRegistry
} from "../lib/request-lifecycle";

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
}

const SETTINGS_STORAGE_KEY = "open-gpt-live.settings.v1";
const THEME_KEY = "sibyl.theme";

function readStoredSettings(): Partial<SessionSettings> {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<SessionSettings>) : {};
  } catch {
    return {};
  }
}

function writeStoredSettings(settings: Partial<SessionSettings>): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); preferences then last one session.
  }
}

/** Keep only stored preferences the current catalog still allows. */
function storedPatch(
  stored: Partial<SessionSettings>,
  catalog: ModelCatalog,
  current: SessionSettings
): Partial<SessionSettings> {
  const patch: Partial<SessionSettings> = {};
  if (stored.llmModel && stored.llmModel !== current.llmModel && catalog.llm.some((m) => m.id === stored.llmModel)) {
    patch.llmModel = stored.llmModel;
  }
  if (stored.sttModel && stored.sttModel !== current.sttModel && catalog.stt.some((m) => m.id === stored.sttModel)) {
    patch.sttModel = stored.sttModel;
  }
  const tts = catalog.tts.find((m) => m.id === (stored.ttsModel ?? current.ttsModel));
  if (stored.ttsModel && stored.ttsModel !== current.ttsModel && tts) {
    patch.ttsModel = stored.ttsModel;
  }
  if (stored.ttsVoice && stored.ttsVoice !== current.ttsVoice && (!tts?.voices?.length || tts.voices.includes(stored.ttsVoice))) {
    patch.ttsVoice = stored.ttsVoice;
  }
  if (typeof stored.genUi === "boolean" && stored.genUi !== current.genUi) patch.genUi = stored.genUi;
  if (typeof stored.speak === "boolean" && stored.speak !== current.speak) patch.speak = stored.speak;
  return patch;
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

type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

const gatewayUrl =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787";

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
const reconnectBaseDelayMs = 500;
const reconnectMaximumDelayMs = 8_000;

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);
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
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
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
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [conversationId, setConversationId] = useState(() => createRequestId());
  const [viewing, setViewing] = useState<StoredConversation | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [themePref, setThemePref] = useState<"system" | "light" | "dark">("system");
  const [showJump, setShowJump] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openSources, setOpenSources] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const resettingRef = useRef(false);
  const [speaking, setSpeaking] = useState(false);
  const storedSettingsAppliedRef = useRef(false);
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

  const canSend = useMemo(
    () => connected && input.trim().length > 0,
    [connected, input]
  );

  useEffect(() => {
    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return;
      }

      const delay = Math.min(
        reconnectMaximumDelayMs,
        reconnectBaseDelayMs * 2 ** reconnectAttempt
      );
      reconnectAttempt += 1;
      setConnectionStatus("reconnecting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      const currentSocket = socketRef.current;
      if (
        currentSocket &&
        (currentSocket.readyState === WebSocket.CONNECTING ||
          currentSocket.readyState === WebSocket.OPEN)
      ) {
        return;
      }

      setConnectionStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");

      let socket: WebSocket;
      try {
        socket = new WebSocket(gatewayUrl);
      } catch {
        setConnected(false);
        setConnectionStatus("disconnected");
        setError("Could not connect to the gateway. Retrying automatically...");
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) {
          socket.close();
          return;
        }
        storedSettingsAppliedRef.current = false;
        const restoredConnection = reconnectAttempt > 0;
        reconnectAttempt = 0;
        setConnected(true);
        setConnectionStatus("connected");
        setError(
          restoredConnection
            ? "Gateway reconnected. A new session has started."
            : null
        );
      });

      socket.addEventListener("close", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }

        socketRef.current = null;
        setConnected(false);
        setSessionId(null);
        if (resettingRef.current) {
          // "New chat": start a fresh session right away, no error.
          resettingRef.current = false;
          cancelRequestsAfterDisconnect();
          reconnectAttempt = 0;
          connect();
          return;
        }
        setConnectionStatus("disconnected");
        cancelRequestsAfterDisconnect();
        setError(
          "Gateway disconnected. Reconnecting automatically; the next connection starts a new session."
        );
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        if (socketRef.current === socket) {
          setError("Gateway connection failed. Waiting to reconnect...");
        }
      });

      socket.addEventListener("message", (event) => {
        if (disposed || socketRef.current !== socket) {
          return;
        }

        try {
          const result = parseServerMessage(JSON.parse(event.data as string));
          if (!result.success) {
            setError(`Received an invalid gateway message: ${result.error}`);
            return;
          }
          handleServerMessage(result.data);
        } catch {
          setError("Received an invalid gateway message.");
        }
      });
    };

    reconnectNowRef.current = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    };

    connect();

    return () => {
      disposed = true;
      reconnectNowRef.current = null;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      cleanupAllPlayback(false);
      cleanupLiveMode(false, false);
      cancelPushToTalkRecording(false);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  function handleServerMessage(message: ServerMessage): void {
    if (message.type === WS_EVENTS.SESSION_START) {
      setSessionId(message.sessionId);
      return;
    }

    if (message.type === WS_EVENTS.SESSION_CONFIG) {
      setCatalog(message.catalog);
      setSettings(message.settings);
      setCapabilities(message.capabilities);
      if (!storedSettingsAppliedRef.current) {
        storedSettingsAppliedRef.current = true;
        const patch = storedPatch(readStoredSettings(), message.catalog, message.settings);
        if (Object.keys(patch).length > 0) {
          updateSettings(patch, false);
        }
      }
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
            ? { ...item, done: true, failed: message.reason === "error" }
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
      playerRef.current?.start(message.requestId);
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

  function updateSettings(patch: Partial<SessionSettings>, persist = true): void {
    const socket = socketRef.current;
    if (persist) {
      writeStoredSettings({ ...readStoredSettings(), ...patch });
    }
    if (!socket) return;
    sendRaw(socket, { type: WS_EVENTS.SESSION_UPDATE, settings: patch });
  }

  function sendUiAction(action: GenUiAction): void {
    sendMessage(action.prompt, action.display, "ui");
  }

  function sendMessage(
    overrideText?: string,
    displayText?: string,
    source: "text" | "ui" = "text"
  ): void {
    const text = (overrideText ?? input).trim();
    const socket = socketRef.current;
    if (!socket || !connected || activeRequestIdRef.current || !text) {
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
        source
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
      text
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
        result.event.reason === "max_duration" ? "manual" : "silence"
      );
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

  function endLiveSpeechTurn(reason: "silence" | "manual"): void {
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
      ...(caption ? { caption } : {})
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

  // Theme: system by default, user can pin light or dark.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") setThemePref(stored);
    } catch {
      // ignore
    }
    setConversations(loadConversations());
  }, []);
  const systemMode = useSystemThemeMode();
  const themeMode: "light" | "dark" = themePref === "system" ? systemMode : themePref;
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);
  function cycleTheme(): void {
    const next = themeMode === "dark" ? "light" : "dark";
    setThemePref(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // ignore
    }
  }

  // Send the next queued message as soon as Sibyl is free.
  useEffect(() => {
    if (!connected || activeRequestId || recording || viewing || queue.length === 0) return;
    const timer = window.setTimeout(() => {
      if (activeRequestIdRef.current) return;
      const [next, ...rest] = queue;
      if (!next) return;
      setQueue(rest);
      sendWithTransition(next.text);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [connected, activeRequestId, recording, viewing, queue]);

  // Keep the current conversation in local history.
  useEffect(() => {
    const persistable = messages.filter((item) => !item.transient && (item.content.trim() || item.ui));
    if (!persistable.some((item) => item.role === "user")) return;
    const timer = window.setTimeout(() => {
      const stored = persistable.map(
        ({ id, role, content, requestId, source, ui, kind, task, model }) => ({
          id, role, content, requestId, source, ui, kind, task, model
        })
      );
      setConversations(
        saveConversation({
          id: conversationId,
          title: titleFor(stored),
          updatedAt: Date.now(),
          messages: stored
        })
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [messages, conversationId]);

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

  function startNewChat(): void {
    setViewing(null);
    setSidebarOpen(false);
    if (activeRequestIdRef.current) stopResponse();
    setMessages([]);
    setInput("");
    setError(null);
    setConversationId(createRequestId());
    // A fresh Gateway session so Sibyl starts without the old context.
    resettingRef.current = true;
    socketRef.current?.close();
  }

  function openConversation(id: string): void {
    const found = conversations.find((item) => item.id === id);
    setSidebarOpen(false);
    if (!found) return;
    if (found.id === conversationId) {
      setViewing(null);
      return;
    }
    setViewing(found);
  }

  function removeConversation(id: string): void {
    setConversations(deleteConversation(id));
    if (viewing?.id === id) setViewing(null);
  }

  function exportConversation(): void {
    const source = viewing?.messages ?? messages;
    if (!source.length) return;
    const title = viewing?.title ?? titleFor(source);
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
    if (!text) return;
    if (fromComposer) setInput("");
    if (activeRequestIdRef.current || recording || queue.length > 0) {
      setQueue((items) => [...items, { id: createRequestId(), text }]);
      return;
    }
    sendWithTransition(text);
  }

  function sendQueuedNow(id: string): void {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    setQueue((items) => items.filter((entry) => entry.id !== id));
    if (activeRequestIdRef.current) stopResponse();
    sendWithTransition(item.text);
  }

  function editQueued(id: string): void {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    setQueue((items) => items.filter((entry) => entry.id !== id));
    setInput((current) => (current.trim() ? `${current.trim()}\n${item.text}` : item.text));
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
    const combined = queue.map((entry) => entry.text).join("\n\n");
    if (activeRequestIdRef.current) {
      setQueue([{ id: createRequestId(), text: combined }]);
      return;
    }
    setQueue([]);
    sendWithTransition(combined);
  }

  function sendWithTransition(text: string): void {
    // Glide the composer from the centre to the bottom on the first message.
    const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
    if (messages.length === 0 && doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      doc.startViewTransition(() => {
        flushSync(() => sendMessage(text));
      });
      return;
    }
    sendMessage(text);
  }

  const vadState = vadSnapshot?.state;
  const userSpeaking =
    (liveMode && (vadState === "speaking" || vadState === "speech_candidate" || vadState === "pause")) ||
    (recording && !liveMode);
  const voiceState: VoiceState = !connected
    ? "offline"
    : speaking
      ? "speaking"
      : userSpeaking
        ? "listening"
        : activeRequestId
          ? "thinking"
          : liveMode
            ? "ready"
            : "idle";
  const activePresetId =
    catalog?.presets?.find(
      (preset) =>
        settings &&
        Object.entries(preset.settings).every(
          ([key, value]) => settings[key as keyof SessionSettings] === value
        )
    )?.id ?? null;
  const shown: ChatMessage[] = viewing ? (viewing.messages as ChatMessage[]) : messages;
  const lastAssistantId = [...messages].reverse().find((item) => item.role === "assistant")?.id;
  const latestGroupKey = groupTurns(shown).at(-1)?.key;
  const empty = shown.length === 0;
  const title = viewing?.title ?? (messages.length ? titleFor(messages) : "New conversation");
  const modelLabel = (id?: string) =>
    catalog?.llm.find((model) => model.id === id)?.label ?? id?.split("/").pop() ?? "";

  const starters: Array<{ icon: IconName; text: string }> = [
    { icon: "layers", text: "Compare the planets of the solar system in a table" },
    { icon: "sparkle", text: "Plan a relaxed 3-day trip to Lisbon" },
    { icon: "activity", text: "Show me global smartphone market share as a chart" },
    { icon: "check", text: "Help me pick a laptop — ask me questions with a form" }
  ];

  return (
    <ThemeProvider mode={themeMode} lightTheme={sibylLightTheme} darkTheme={sibylDarkTheme}>
    <div className={`app${sidebarOpen ? " sidebarOpen" : ""}`}>
      <nav className="rail" aria-label="Sibyl">
        <button type="button" className="railLogo" onClick={startNewChat} aria-label="Sibyl — new chat" title="Sibyl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/sibyl-mark.png" alt="" width={24} height={24} />
        </button>
        <button type="button" className="railBtn active" aria-label="Chat" title="Chat" onClick={() => setViewing(null)}>
          <Icon name="chat" />
        </button>
        <button type="button" className="railBtn" aria-label="History" title="History" onClick={() => setSidebarOpen((open) => !open)}>
          <Icon name="history" />
        </button>
        <button type="button" className="railBtn" aria-label="Models & voice" title="Models & voice" onClick={() => setSettingsOpen(true)}>
          <Icon name="sliders" />
        </button>
        <span className="railSpacer" />
        <button type="button" className="railBtn" aria-label="Switch theme" title="Switch theme" onClick={cycleTheme}>
          <Icon name={themeMode === "dark" ? "sun" : "moon"} />
        </button>
        <span
          className={`railStatus ${connectionStatus}`}
          title={connected ? "Connected" : connectionStatus === "reconnecting" ? "Reconnecting" : "Offline"}
          aria-label={connected ? "Connected" : "Offline"}
        >
          <Mark size={16} />
        </span>
      </nav>

      <Sidebar
        open={sidebarOpen}
        catalog={catalog}
        settings={settings}
        conversations={conversations}
        activeConversationId={conversationId}
        viewingId={viewing?.id ?? null}
        onNewChat={startNewChat}
        onOpenConversation={openConversation}
        onDeleteConversation={removeConversation}
        onApplyPreset={(patch) => updateSettings(patch)}
        onOpenSettings={() => setSettingsOpen(true)}
        onClose={() => setSidebarOpen(false)}
      />
      {sidebarOpen ? <button type="button" className="scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} /> : null}

      <main className="main">
        <header className="topbar">
          <button type="button" className="iconBtn mobileOnly" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="topTitle">
            <span className="titleText" title={title}>{title}</span>
            <span className={`statusBadge ${connectionStatus}`}>
              <i />
              {viewing
                ? "Saved"
                : connectionStatus === "connected"
                  ? liveMode
                    ? "Live"
                    : "Ready"
                  : connectionStatus === "reconnecting" || connectionStatus === "connecting"
                    ? "Connecting"
                    : "Offline"}
            </span>
          </div>
          <div className="topActions">
            <button type="button" className="ghostBtn" onClick={() => setSettingsOpen(true)}>
              <Icon name="sliders" size={16} />
              <span className="hideSm">Configure</span>
            </button>
            <button type="button" className="ghostBtn" onClick={exportConversation} disabled={empty} title="Download this conversation as Markdown">
              <Icon name="share" size={16} />
              <span className="hideSm">Share</span>
            </button>
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
                <SilverMark size={72} />
                <h1>What&apos;s on your mind?</h1>
                <p>Talk naturally or type. Sibyl answers out loud and shows you the details.</p>
                <ul className="starterList">
                  {starters.map((starter) => (
                    <li key={starter.text}>
                      <button
                        type="button"
                        disabled={!connected || Boolean(activeRequestId)}
                        onClick={() => submitText(starter.text)}
                      >
                        <Icon name={starter.icon} size={16} />
                        {starter.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="thread">
                {groupTurns(shown).map((group) => {
                  const replies = group.replies;
                  const lastReply = replies[replies.length - 1];
                  const isLatest = group.key === latestGroupKey;
                  const pending =
                    !viewing &&
                    isLatest &&
                    Boolean(activeRequestId) &&
                    !replies.some((reply) => reply.content.trim() || reply.ui);
                  const settled =
                    replies.length > 0 &&
                    replies.every((reply) => reply.done || viewing) &&
                    replies.some((reply) => reply.content.trim() || reply.ui);
                  const replyText = replies
                    .map((reply) => cleanText(reply.content))
                    .filter(Boolean)
                    .join("\n\n");
                  const visuals = replies.filter((reply) => reply.ui);
                  return (
                    <div className="turnGroup" key={group.key}>
                      {group.user ? (
                        <article className={`turn user${group.user.transient ? " transient" : ""}`}>
                          <div className="bubble">
                            {group.user.source === "audio" ? <Icon name="mic" size={13} className="bubbleIcon" /> : null}
                            {group.user.source === "ui" ? <Icon name="layers" size={13} className="bubbleIcon" /> : null}
                            {group.user.content || <span className="typing"><i /><i /><i /></span>}
                          </div>
                        </article>
                      ) : null}

                      {replies.length > 0 || pending ? (
                        <article className="reply">
                          <span className={`replyAvatar${pending || (isLatest && voiceState === "speaking") ? " live" : ""}`} aria-hidden>
                            <Mark size={14} />
                          </span>
                          <div className="replyBody">
                            {pending ? (
                              <p className="thinkingLine">
                                <span className="typing"><i /><i /><i /></span>
                                {voiceState === "listening" ? "Listening…" : "Sibyl is thinking…"}
                              </p>
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
                                      ) : message.done || viewing ? (
                                        <Icon name="check" size={15} className="stepIcon done" />
                                      ) : (
                                        <span className="spinner" aria-hidden />
                                      )}
                                      <span>
                                        {message.failed
                                          ? "Deep work hit a problem"
                                          : message.done || viewing
                                            ? "Thought it through"
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
                                  </div>
                                ) : null}
                                {cleanText(message.content) ? (
                                  <SpokenText className="spoken" text={cleanText(message.content)} />
                                ) : null}
                                {message.ui ? (
                                  <GenUiView
                                    source={message.ui}
                                    streaming={!viewing && !message.done}
                                    onAction={!viewing && message.id === lastAssistantId ? sendUiAction : undefined}
                                  />
                                ) : null}
                                {message.ui && openSources.has(message.id) ? (
                                  <pre className="sourceView">{message.ui}</pre>
                                ) : null}
                              </div>
                            ))}
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
                                {!viewing && group.user && isLatest ? (
                                  <button
                                    type="button"
                                    className="actionBtn"
                                    aria-label="Ask again"
                                    title="Ask again"
                                    disabled={!connected}
                                    onClick={() => submitText(group.user!.content)}
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
            {viewing ? (
              <div className="savedBanner">
                <span>You&apos;re reading a saved conversation.</span>
                <button type="button" className="ghostBtn" onClick={() => setViewing(null)}>
                  Back to current chat
                </button>
                <button type="button" className="darkBtn" onClick={startNewChat}>
                  New chat
                </button>
              </div>
            ) : (
              <>
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
                onOpenSettings={() => setSettingsOpen(true)}
              />
              </>
            )}
          </div>
        </section>
      </main>

      <SettingsPanel
        open={settingsOpen}
        catalog={catalog}
        settings={settings}
        capabilities={capabilities}
        disabled={!connected}
        activePresetId={activePresetId}
        onChange={(patch) => updateSettings(patch)}
        onClose={() => setSettingsOpen(false)}
        diagnostics={
          <>
            <LatencyPanel snapshot={latencySnapshot} />
            <VadPanel snapshot={vadSnapshot} liveMode={liveMode} adaptiveEnabled={vadConfig.adaptiveEnabled} />
            <p className="muted small">
              Gateway {gatewayUrl} · Session {sessionId ?? "pending"}
              {capabilities ? ` · ${capabilities.provider}` : ""}
            </p>
          </>
        }
      />
    </div>
    </ThemeProvider>
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

function LatencyPanel({ snapshot }: { snapshot: LatencySnapshot | null }) {
  const metrics = [
    ["STT first partial", snapshot?.sttFirstPartialMs],
    ["Final transcript", snapshot?.sttFinalMs],
    ["LLM first token", snapshot?.llmFirstDeltaMs],
    ["TTS first audio", snapshot?.ttsFirstAudioMs],
    ["Speech end → audio", snapshot?.speechEndToFirstAudioMs]
  ] as const;

  return (
    <section className="latencyPanel" aria-label="Voice latency metrics">
      <div className="latencyHeading">
        <strong>Latency</strong>
        <span>
          {snapshot
            ? `${snapshot.kind.toUpperCase()} · ${snapshot.status}`
            : "waiting for a request"}
        </span>
      </div>
      <dl>
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value === undefined ? "—" : `${value} ms`}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function VadPanel({
  snapshot,
  liveMode,
  adaptiveEnabled
}: {
  snapshot: VadSnapshot | null;
  liveMode: boolean;
  adaptiveEnabled: boolean;
}) {
  const state = !liveMode
    ? "off"
    : snapshot?.state === "calibrating"
      ? `calibrating ${Math.round(snapshot.calibrationProgress * 100)}%`
      : (snapshot?.state ?? "starting");

  return (
    <section className="vadPanel" aria-label="Voice activity detector status">
      <div className="vadHeading">
        <strong>Voice activity</strong>
        <span>
          {snapshot?.adaptive ?? adaptiveEnabled
            ? liveMode
              ? "adaptive"
              : "adaptive ready"
            : "fixed fallback"}
        </span>
      </div>
      <dl>
        <div>
          <dt>State</dt>
          <dd>{state}</dd>
        </div>
        <div>
          <dt>RMS</dt>
          <dd>{formatVadLevel(snapshot?.rms)}</dd>
        </div>
        <div>
          <dt>Noise floor</dt>
          <dd>{formatVadLevel(snapshot?.noiseFloor)}</dd>
        </div>
        <div>
          <dt>Speech / silence</dt>
          <dd>
            {formatVadLevel(snapshot?.speechThreshold)} / {formatVadLevel(snapshot?.silenceThreshold)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function formatVadLevel(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(4);
}

function sendRaw(socket: WebSocket, message: ClientMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
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
