/**
 * Sibyl's optional realtime layer over LiveKit (docs/realtime.md).
 *
 * installRealtime() returns undefined unless LIVEKIT_URL, LIVEKIT_API_KEY and
 * LIVEKIT_API_SECRET are set: the WebSocket voice path is the zero-setup
 * default and nothing here (not even the native WebRTC module) loads.
 */
import type { Store, ToolRegistry } from "@open-gpt-live/core";
import type { AgentRuntime } from "../agents/runtime.js";
import { realtimeConfigFromEnv } from "./config.js";
import { RealtimeService } from "./service.js";
import { realtimeTools } from "./tools.js";

export { RealtimeService, RealtimeError, type PhoneSettings, type StreamView, type CallRecord } from "./service.js";
export { realtimeConfigFromEnv, type RealtimeConfig } from "./config.js";
export { orgOfRoom, parseRoomName, roomName, roomPrefix, roomSpace, type RoomKind } from "./rooms.js";
export { handleRealtimeHttp, handleRealtimeWebhook } from "./http.js";
export { handleRealtimeMessage } from "./ws.js";

export interface InstallRealtimeOptions {
  env: NodeJS.ProcessEnv;
  store: Store;
  tools: ToolRegistry;
  ownerId: string;
  agents?: AgentRuntime;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export function installRealtime(options: InstallRealtimeOptions): RealtimeService | undefined {
  const result = realtimeConfigFromEnv(options.env);
  if (!result.config) {
    if (result.problem) options.log("realtime.disabled", { reason: result.problem });
    return undefined;
  }
  const service = new RealtimeService({
    config: result.config,
    store: options.store,
    ownerId: options.ownerId,
    ...(options.agents ? { agents: options.agents } : {}),
    log: options.log
  });
  for (const tool of realtimeTools(service)) options.tools.register(tool);
  options.log("realtime.enabled", { url: result.config.url, publicUrl: result.config.publicUrl, phone: Boolean(result.config.sipOutboundTrunkId) });
  return service;
}
