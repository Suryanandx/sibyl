/**
 * The session side of voice engines: which engine a live turn uses, the
 * session's GPT Realtime settings, and the per-minute comparison price.
 */
import type { AgentRecord } from "@open-gpt-live/core";
import type { ModelCatalog, SessionSettings, VoiceEngineId, VoiceEngineSettings } from "@open-gpt-live/protocol";
import { sibylUsdPerMinute } from "./config.js";
import type { RealtimeEngineSettings } from "./realtime-engine.js";
import type { VoiceEngineService } from "./service.js";
import { closestRealtimeVoice, isRealtimeVoice } from "./voices.js";

/** Check and apply the voice engine fields of a session.update. Returns an error message, or undefined. */
export function applyVoiceEngineSettings(patch: Partial<VoiceEngineSettings>, next: VoiceEngineSettings, service: VoiceEngineService | undefined): string | undefined {
  if (patch.realtimeModel !== undefined) {
    if (!service?.config.models.includes(patch.realtimeModel)) return `GPT Realtime model is not offered here: ${patch.realtimeModel}`;
    next.realtimeModel = patch.realtimeModel;
  }
  if (patch.realtimeVoice !== undefined) {
    if (!isRealtimeVoice(patch.realtimeVoice)) return `GPT Realtime has no voice called ${patch.realtimeVoice}`;
    next.realtimeVoice = patch.realtimeVoice;
  }
  if (patch.realtimeTurn !== undefined) next.realtimeTurn = patch.realtimeTurn;
  if (patch.voiceEngine !== undefined) next.voiceEngine = patch.voiceEngine;
  return undefined;
}

/** The engine a live turn should use (before checking that GPT Realtime is available). */
export function wantedEngine(settings: VoiceEngineSettings, agent: Pick<AgentRecord, "voice"> | undefined, service: VoiceEngineService): VoiceEngineId {
  return agent?.voice?.engine ?? settings.voiceEngine ?? service.config.defaultEngine;
}

export function realtimeSettings(settings: VoiceEngineSettings, service: VoiceEngineService): RealtimeEngineSettings {
  const config = service.config;
  return {
    model: settings.realtimeModel && config.models.includes(settings.realtimeModel) ? settings.realtimeModel : config.defaultModel,
    voice: settings.realtimeVoice && isRealtimeVoice(settings.realtimeVoice) ? settings.realtimeVoice : config.defaultVoice,
    turn: settings.realtimeTurn ?? "quick"
  };
}

/** An agent's GPT Realtime voice: its own choice, else the closest to its Sibyl voice and style. */
export function agentRealtimeVoice(agent: Pick<AgentRecord, "voice"> | undefined, sessionVoice: string): string {
  if (!agent?.voice) return sessionVoice;
  if (agent.voice.realtimeVoice && isRealtimeVoice(agent.voice.realtimeVoice)) return agent.voice.realtimeVoice;
  return closestRealtimeVoice({
    ...(agent.voice.ttsVoice ? { ttsVoice: agent.voice.ttsVoice } : {}),
    ...(agent.voice.style ? { style: agent.voice.style } : {}),
    fallback: sessionVoice
  });
}

/** Sibyl voice per minute on the session's models (their preset), else the Balanced preset. */
export function sibylMinuteFor(catalog: ModelCatalog | undefined, settings: Partial<SessionSettings>): number | undefined {
  const presets = catalog?.presets ?? [];
  const preset =
    presets.find((p) => p.settings.voiceModel === settings.voiceModel && p.settings.llmModel === settings.llmModel) ??
    presets.find((p) => p.id === "balanced") ??
    presets[0];
  return sibylUsdPerMinute(preset?.costPer100Turns);
}
