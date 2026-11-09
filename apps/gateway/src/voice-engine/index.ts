/**
 * Voice engines: Sibyl voice (the session's own pipeline) and GPT Realtime
 * (OpenAI speech-to-speech, a premium option). See docs/voice.md.
 */
import { WebSocket } from "ws";
import type { Store } from "@open-gpt-live/core";
import type { StreamingSTTWebSocket } from "@open-gpt-live/adapters";
import type { SecretVault } from "../secrets/vault.js";
import { VoiceEngineService } from "./service.js";

export { VoiceEngineService, VoiceEngineError, REALTIME_KEY_SECRET, checkOpenAIKey } from "./service.js";
export { RealtimeVoiceEngine, type VoiceEngineHost, type RealtimeEngineSettings } from "./realtime-engine.js";
export { handleVoiceEngineHttp, isVoiceEnginePath } from "./http.js";
export { closestRealtimeVoice, isRealtimeVoice } from "./voices.js";
export { sibylUsdPerMinute, realtimeEngineConfig, type RealtimeEngineConfig } from "./config.js";

export async function installVoiceEngines(input: {
  store: Store;
  ownerId: string;
  vault: SecretVault | undefined;
  env: NodeJS.ProcessEnv;
  hosted: boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<VoiceEngineService> {
  const service = new VoiceEngineService({
    store: input.store,
    orgId: input.ownerId,
    vault: input.vault,
    env: input.env,
    hosted: input.hosted,
    log: input.log,
    webSocketFactory: (url, options) => new WebSocket(url, { headers: options.headers }) as unknown as StreamingSTTWebSocket
  });
  await service.load().catch((error: unknown) => input.log("voice_engine.load_failed", { error: error instanceof Error ? error.message : String(error) }));
  input.log("voice_engine.ready", { enabled: service.config.enabled, keySource: service.keySource, defaultEngine: service.config.defaultEngine, model: service.config.defaultModel });
  return service;
}
export { applyVoiceEngineSettings, wantedEngine, realtimeSettings, agentRealtimeVoice, sibylMinuteFor } from "./session.js";
