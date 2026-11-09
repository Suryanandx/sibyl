"use client";

/**
 * One live connection to the Sibyl gateway, shared by every screen.
 *
 * Mounted once in `app/layout.tsx`, so moving between Chat, Routines,
 * Settings, … never reconnects. Screens read shared state (catalog, settings,
 * usage, conversations, routines, secrets) with `useGateway()` and talk to the
 * gateway with `send` / `subscribe`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from "react";
import { usePathname } from "next/navigation";
import {
  IDENTITY_EVENTS,
  SECRET_EVENTS,
  WS_EVENTS,
  parseServerMessage,
  type ClientMessage,
  type ModelCatalog,
  type SecretMetaView,
  type ServerMessage,
  type SessionCapabilities,
  type SessionSettings,
  type UsageView,
  type AuthMeResponse
} from "@open-gpt-live/protocol";
import { gatewayRequiresLogin, readOwnerToken, readWorkspaceId, withOwnerToken, writeOwnerToken } from "../components/SignIn";
import { refreshAppSession, useAppSession } from "./app-session";
import { gatewayRequest, gatewayWsUrl } from "./gateway-http";
import { currentPath } from "./routes";
import { useRoutinesInbox, type RoutinesInbox } from "../components/Inbox";
import { inboxBadgeCount, showBrowserNotification, useNotifications, type NotificationsApi } from "./notifications";
import type { SecretUpdate } from "../components/SecretsPanel";
import type { ConversationSummary } from "./conversations";
import { useAgents, type AgentsApi } from "../features/agents/useAgents";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Socket lifecycle, for screens that keep their own notices (the chat). */
export type GatewayEvent =
  | { type: "open"; restored: boolean }
  | { type: "close"; wasOpen: boolean }
  | { type: "error"; message: string };

export interface Gateway {
  gatewayUrl: string;
  connected: boolean;
  status: ConnectionStatus;
  sessionId: string | null;
  catalog: ModelCatalog | null;
  settings: SessionSettings | null;
  capabilities: SessionCapabilities | null;
  usage: UsageView | null;
  /** The preset whose settings match the current ones. */
  activePresetId: string | null;
  /** Conversations stored on the gateway (newest first). */
  conversations: ConversationSummary[];
  /** Routines and the approval inbox. */
  routines: RoutinesInbox;
  /** Agents: the list, the selected agent, and who answered each request (shared by every screen). */
  agents: AgentsApi;
  /** Notifications: the Inbox's activity feed, unread counts and the toast shown on every screen. */
  notifications: NotificationsApi;
  /** The rail badge: approvals waiting plus unread notifications. */
  inboxCount: number;
  /** Stored secrets (null until listed) and the last secrets error. */
  secrets: SecretMetaView[] | null;
  secretsError: string | null;
  /** Owner sign-in needed (failed: the stored password was rejected). */
  signIn: { failed: boolean } | null;
  submitOwnerToken(token: string): void;
  /** Send a message; false when the socket isn't open. */
  send(message: ClientMessage): boolean;
  /** Every server message (after shared state is updated). Returns an unsubscribe. */
  subscribe(listener: (message: ServerMessage) => void): () => void;
  /** Socket lifecycle events. Returns an unsubscribe. */
  subscribeEvents(listener: (event: GatewayEvent) => void): () => void;
  /** The raw socket, for the chat's audio streaming. */
  socketRef: MutableRefObject<WebSocket | null>;
  updateSettings(patch: Partial<SessionSettings>, persist?: boolean): void;
  requestUsage(): void;
  requestSecrets(): void;
  saveSecret(update: SecretUpdate): void;
  deleteSecret(name: string): void;
}

const SETTINGS_STORAGE_KEY = "open-gpt-live.settings.v1";
const reconnectBaseDelayMs = 500;
const reconnectMaximumDelayMs = 8_000;
/** Pages with their own sign-in flow (and meeting guest links, shared meeting notes): no gateway connection there. */
const NO_GATEWAY = /^\/(setup|login|invite|join|signup|shared)(\/|$)/;

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

export function sendRaw(socket: WebSocket, message: ClientMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

const GatewayContext = createContext<Gateway | null>(null);

export function GatewayProvider({ children }: { children: ReactNode }) {
  // Identity: the workspace this connection acts in (session.workspace).
  const appSession = useAppSession();
  const sentWorkspaceRef = useRef<string | null>(null);
  /** session.identity messages on the current connection. */
  const identityPushesRef = useRef(0);
  const pathname = usePathname() ?? "/";
  const enabled = !NO_GATEWAY.test(pathname);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const listenersRef = useRef(new Set<(message: ServerMessage) => void>());
  const eventListenersRef = useRef(new Set<(event: GatewayEvent) => void>());
  const storedSettingsAppliedRef = useRef(false);

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [secrets, setSecrets] = useState<SecretMetaView[] | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{ failed: boolean } | null>(null);

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    return socket ? sendRaw(socket, message) : false;
  }, []);

  const emit = useCallback((event: GatewayEvent) => {
    for (const listener of eventListenersRef.current) listener(event);
  }, []);

  const routines = useRoutinesInbox({ send });
  const routinesRef = useRef(routines);
  routinesRef.current = routines;
  const notifications = useNotifications({
    send,
    onLive: (notification) => {
      showBrowserNotification(notification);
      // A routine or task posted into a chat: refresh the chat list.
      if (notification.links.conversationId && notification.kind !== "approval_needed") send({ type: WS_EVENTS.CONVERSATIONS_REQUEST });
    }
  });
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  // Identity: a fresh install with an owner token still needs its owner account.
  useEffect(() => {
    void refreshAppSession().then((me) => {
      if (me?.authenticated && me.next === "setup") window.location.replace("/setup");
    });
  }, []);

  // Workspace switched (switcher, settings): move this connection to it,
  // then reload what depends on the workspace.
  useEffect(() => {
    const workspaceId = appSession.currentWorkspaceId;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || sentWorkspaceRef.current === workspaceId) return;
    if (sentWorkspaceRef.current === null && workspaceId === "default") return;
    sentWorkspaceRef.current = workspaceId;
    sendRaw(socket, { type: IDENTITY_EVENTS.SESSION_WORKSPACE, workspaceId });
    sendRaw(socket, { type: WS_EVENTS.CONVERSATIONS_REQUEST });
    sendRaw(socket, { type: WS_EVENTS.CONVERSATION_OPEN });
    // Spend and budgets of the workspace now open (Settings → Usage).
    sendRaw(socket, { type: WS_EVENTS.USAGE_REQUEST });
    notificationsRef.current.dismissToast();
    notificationsRef.current.onConnected();
  }, [appSession.currentWorkspaceId]);

  const toast = notifications.toast;
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => notificationsRef.current.dismissToast(), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const updateSettings = useCallback((patch: Partial<SessionSettings>, persist = true) => {
    if (persist) writeStoredSettings({ ...readStoredSettings(), ...patch });
    const socket = socketRef.current;
    if (socket) sendRaw(socket, { type: WS_EVENTS.SESSION_UPDATE, settings: patch });
  }, []);

  /** Shared state; returns true when the message is fully consumed. */
  const handleShared = useCallback(
    (message: ServerMessage): boolean => {
      if (routinesRef.current.handleMessage(message)) return true;
      if (notificationsRef.current.handleMessage(message)) return true;
      switch (message.type) {
        case IDENTITY_EVENTS.SESSION_IDENTITY:
          // The first one per connection is the greeting; later ones mean roles, workspaces
          // or the organization changed (Admin, Settings → Members): reload who we are.
          identityPushesRef.current += 1;
          if (identityPushesRef.current > 1) void refreshAppSession();
          return false;
        case WS_EVENTS.SESSION_START:
          setSessionId(message.sessionId);
          return false;
        case WS_EVENTS.USAGE_UPDATE:
          setUsage(message.usage);
          return false;
        case WS_EVENTS.CONVERSATIONS_LIST:
          setConversations(message.items);
          return false;
        case WS_EVENTS.SESSION_CONFIG:
          setCatalog(message.catalog);
          setSettings(message.settings);
          setCapabilities(message.capabilities);
          if (!storedSettingsAppliedRef.current) {
            storedSettingsAppliedRef.current = true;
            const patch = storedPatch(readStoredSettings(), message.catalog, message.settings);
            if (Object.keys(patch).length > 0) updateSettings(patch, false);
          }
          return false;
        case SECRET_EVENTS.STATE:
          setSecrets(message.secrets);
          setSecretsError(message.error ?? null);
          return false;
        default:
          return false;
      }
    },
    [updateSettings]
  );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      const delay = Math.min(reconnectMaximumDelayMs, reconnectBaseDelayMs * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      setStatus("reconnecting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      const currentSocket = socketRef.current;
      if (currentSocket && (currentSocket.readyState === WebSocket.CONNECTING || currentSocket.readyState === WebSocket.OPEN)) {
        return;
      }
      setStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting");

      let socket: WebSocket;
      try {
        socket = new WebSocket(withOwnerToken(gatewayWsUrl, readOwnerToken()));
      } catch {
        setConnected(false);
        setStatus("disconnected");
        emit({ type: "error", message: "Could not connect to the gateway. Retrying automatically..." });
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      let opened = false;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) {
          socket.close();
          return;
        }
        opened = true;
        identityPushesRef.current = 0;
        setSignIn(null);
        // Act in the chosen workspace before anything is listed or opened.
        const workspaceId = readWorkspaceId();
        sentWorkspaceRef.current = workspaceId;
        if (workspaceId) sendRaw(socket, { type: IDENTITY_EVENTS.SESSION_WORKSPACE, workspaceId });
        storedSettingsAppliedRef.current = false;
        const restored = reconnectAttempt > 0;
        reconnectAttempt = 0;
        setConnected(true);
        setStatus("connected");
        sendRaw(socket, { type: WS_EVENTS.USAGE_REQUEST });
        sendRaw(socket, { type: WS_EVENTS.CONVERSATIONS_REQUEST });
        routinesRef.current.onConnected();
        notificationsRef.current.onConnected();
        emit({ type: "open", restored });
      });

      socket.addEventListener("close", () => {
        if (disposed || socketRef.current !== socket) return;
        socketRef.current = null;
        setConnected(false);
        setSessionId(null);
        setStatus("disconnected");
        emit({ type: "close", wasOpen: opened });
        if (!opened) {
          // Rejected before opening: either the gateway is down or it wants
          // the owner password (the browser can't see the 401 itself).
          // Accounts first: send people to sign in (or to first-run setup).
          void gatewayRequest<AuthMeResponse>("/api/auth/me", { workspaceId: null })
            .then((me) => {
              if (me.authenticated || !me.next) return false;
              window.location.replace(me.next === "login" ? `/login?next=${encodeURIComponent(currentPath())}` : "/setup");
              return true;
            })
            .catch(() => false)
            .then((redirected) => (redirected ? false : gatewayRequiresLogin()))
            .then((required) => {
            if (disposed || socketRef.current) return;
            if (required) {
              setSignIn({ failed: Boolean(readOwnerToken()) });
              return;
            }
            scheduleReconnect();
          });
          return;
        }
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        if (socketRef.current === socket) emit({ type: "error", message: "Gateway connection failed. Waiting to reconnect..." });
      });

      socket.addEventListener("message", (event) => {
        if (disposed || socketRef.current !== socket) return;
        let message: ServerMessage;
        try {
          const result = parseServerMessage(JSON.parse(event.data as string));
          if (!result.success) {
            emit({ type: "error", message: `Received an invalid gateway message: ${result.error}` });
            return;
          }
          message = result.data;
        } catch {
          emit({ type: "error", message: "Received an invalid gateway message." });
          return;
        }
        if (handleShared(message)) return;
        for (const listener of listenersRef.current) listener(message);
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
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled, emit, handleShared]);

  const subscribe = useCallback((listener: (message: ServerMessage) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const subscribeEvents = useCallback((listener: (event: GatewayEvent) => void) => {
    eventListenersRef.current.add(listener);
    return () => {
      eventListenersRef.current.delete(listener);
    };
  }, []);

  const submitOwnerToken = useCallback((token: string) => {
    writeOwnerToken(token);
    setSignIn(null);
    reconnectNowRef.current?.();
  }, []);

  const requestUsage = useCallback(() => {
    send({ type: WS_EVENTS.USAGE_REQUEST });
  }, [send]);

  const requestSecrets = useCallback(() => {
    setSecretsError(null);
    send({ type: SECRET_EVENTS.LIST });
  }, [send]);

  const saveSecret = useCallback(
    (update: SecretUpdate) => {
      if (!send({ type: SECRET_EVENTS.UPDATE, ...update })) setSecretsError("Not connected — try again in a moment.");
    },
    [send]
  );

  const deleteSecret = useCallback(
    (name: string) => {
      if (!send({ type: SECRET_EVENTS.DELETE, name })) setSecretsError("Not connected — try again in a moment.");
    },
    [send]
  );

  const inboxCount = inboxBadgeCount(routines.inbox.length, notifications.unread);

  // One agents state for the Agents screen, the composer picker and reply avatars.
  const agentsClient = useMemo(() => ({ send, subscribe, connected }), [send, subscribe, connected]);
  const agents = useAgents(agentsClient);

  const activePresetId =
    catalog?.presets?.find(
      (preset) =>
        settings &&
        Object.entries(preset.settings).every(([key, value]) => settings[key as keyof SessionSettings] === value)
    )?.id ?? null;

  const value = useMemo<Gateway>(
    () => ({
      gatewayUrl: gatewayWsUrl,
      connected,
      status,
      sessionId,
      catalog,
      settings,
      capabilities,
      usage,
      activePresetId,
      conversations,
      routines,
      agents,
      notifications,
      inboxCount,
      secrets,
      secretsError,
      signIn,
      submitOwnerToken,
      send,
      subscribe,
      subscribeEvents,
      socketRef,
      updateSettings,
      requestUsage,
      requestSecrets,
      saveSecret,
      deleteSecret
    }),
    [
      connected,
      status,
      sessionId,
      catalog,
      settings,
      capabilities,
      usage,
      activePresetId,
      conversations,
      routines,
      agents,
      notifications,
      inboxCount,
      secrets,
      secretsError,
      signIn,
      submitOwnerToken,
      send,
      subscribe,
      subscribeEvents,
      updateSettings,
      requestUsage,
      requestSecrets,
      saveSecret,
      deleteSecret
    ]
  );

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway(): Gateway {
  const gateway = useContext(GatewayContext);
  if (!gateway) throw new Error("useGateway() needs <GatewayProvider> (mounted in app/layout.tsx).");
  return gateway;
}
