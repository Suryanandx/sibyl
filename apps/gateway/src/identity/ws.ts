/**
 * WebSocket permission map: every client message type → the permission it
 * needs in the connection's current workspace. The gateway checks this once,
 * before any handler runs (GatewayConnection.handleMessage).
 *
 * `null` means "no check" (session plumbing that reads or changes nothing
 * protected). Unknown types fall back to chat.use, so a new message type is
 * never open to someone who isn't a member of the workspace.
 */
import { PERMISSIONS, type Permission } from "@open-gpt-live/core";
import {
  CONNECTIONS_EVENTS,
  IDENTITY_EVENTS,
  MONITOR_EVENTS,
  NOTIFICATION_EVENTS,
  ROUTINE_EVENTS,
  SECRET_EVENTS,
  WS_EVENTS,
  type SessionSettings
} from "@open-gpt-live/protocol";

const MAP: Record<string, Permission | null> = {
  [WS_EVENTS.SESSION_START]: null,
  [WS_EVENTS.PLAYBACK_ACK]: null,
  [WS_EVENTS.INTERRUPT]: null,
  [IDENTITY_EVENTS.SESSION_WORKSPACE]: null,
  // Settings: model fields are checked per field (see modelSettingKeys).
  [WS_EVENTS.SESSION_UPDATE]: null,

  [WS_EVENTS.USER_TEXT]: PERMISSIONS.CHAT_USE,
  [WS_EVENTS.AUDIO_CHUNK]: PERMISSIONS.CHAT_USE,
  [WS_EVENTS.VAD_SPEECH_START]: PERMISSIONS.CHAT_USE,
  [WS_EVENTS.VAD_SPEECH_END]: PERMISSIONS.CHAT_USE,
  [WS_EVENTS.CONVERSATIONS_REQUEST]: PERMISSIONS.CHAT_USE,
  [WS_EVENTS.CONVERSATION_OPEN]: PERMISSIONS.CHAT_USE,
  [WS_EVENTS.CONVERSATION_DELETE]: PERMISSIONS.CHAT_USE,

  // Deciding an approval lets a write action run.
  [WS_EVENTS.APPROVAL_DECISION]: PERMISSIONS.TOOLS_WRITE,
  [WS_EVENTS.USAGE_REQUEST]: PERMISSIONS.USAGE_VIEW,

  [CONNECTIONS_EVENTS.REQUEST]: PERMISSIONS.CHAT_USE,
  [CONNECTIONS_EVENTS.TOOL_TOGGLE]: PERMISSIONS.MCP_MANAGE,
  [CONNECTIONS_EVENTS.SERVER_TOGGLE]: PERMISSIONS.MCP_MANAGE,
  [CONNECTIONS_EVENTS.SERVER_SAVE]: PERMISSIONS.MCP_MANAGE,
  [CONNECTIONS_EVENTS.SERVER_REMOVE]: PERMISSIONS.MCP_MANAGE,
  [CONNECTIONS_EVENTS.SERVER_RECONNECT]: PERMISSIONS.MCP_MANAGE,
  [CONNECTIONS_EVENTS.SERVER_TEST]: PERMISSIONS.MCP_MANAGE,

  [ROUTINE_EVENTS.ROUTINES_CONTEXT]: PERMISSIONS.ROUTINES_USE,
  [ROUTINE_EVENTS.ROUTINES_REQUEST]: PERMISSIONS.ROUTINES_USE,
  [ROUTINE_EVENTS.INBOX_REQUEST]: PERMISSIONS.ROUTINES_USE,
  [ROUTINE_EVENTS.ROUTINE_UPDATE]: PERMISSIONS.ROUTINES_MANAGE,
  [ROUTINE_EVENTS.ROUTINE_RUN_NOW]: PERMISSIONS.ROUTINES_MANAGE,
  [ROUTINE_EVENTS.ROUTINE_DELETE]: PERMISSIONS.ROUTINES_MANAGE,

  [SECRET_EVENTS.PROVIDE]: PERMISSIONS.SECRETS_USE,
  [SECRET_EVENTS.CANCEL]: PERMISSIONS.SECRETS_USE,
  [SECRET_EVENTS.LIST]: PERMISSIONS.SECRETS_USE,
  [SECRET_EVENTS.UPDATE]: PERMISSIONS.SECRETS_MANAGE,
  [SECRET_EVENTS.DELETE]: PERMISSIONS.SECRETS_MANAGE,

  [MONITOR_EVENTS.SUBSCRIBE]: PERMISSIONS.MONITORS_USE,

  // Every member may read their own feed; what it holds is filtered per kind (notifications/service.ts).
  [NOTIFICATION_EVENTS.REQUEST]: PERMISSIONS.CHAT_USE,
  [NOTIFICATION_EVENTS.READ]: PERMISSIONS.CHAT_USE
};

/** Permission a client message needs; null: none. */
export function permissionForMessage(type: string): Permission | null {
  return type in MAP ? MAP[type]! : PERMISSIONS.CHAT_USE;
}

/** Messages that are answered silently (no error) when not allowed, because the app sends them on every connect. */
export const QUIET_DENIALS = new Set<string>([
  WS_EVENTS.USAGE_REQUEST,
  ROUTINE_EVENTS.ROUTINES_CONTEXT,
  ROUTINE_EVENTS.ROUTINES_REQUEST,
  ROUTINE_EVENTS.INBOX_REQUEST,
  SECRET_EVENTS.LIST,
  CONNECTIONS_EVENTS.REQUEST,
  MONITOR_EVENTS.SUBSCRIBE,
  NOTIFICATION_EVENTS.REQUEST
]);

/** Session settings that pick models (need models.choose); voice/speak/genUi stay personal. */
export const MODEL_SETTING_KEYS: ReadonlyArray<keyof SessionSettings> = ["voiceModel", "llmModel", "sttModel", "ttsModel", "voiceEngine", "realtimeModel", "speechProvider"];

/** Every permission-mapped message type (for docs and tests). */
export function permissionTable(): Array<[string, Permission | null]> {
  return Object.entries(MAP);
}
