/**
 * The voice engines as the app shows them: Sibyl voice (default) and GPT
 * Realtime (premium), with their price per minute and why GPT Realtime may be
 * unavailable. Every place that offers the choice uses these.
 */
import type { RealtimeTurnDetection, SessionSettings, VoiceEngineCapability, VoiceEngineId } from "@open-gpt-live/protocol";

export function perMinute(usd: number | undefined): string | undefined {
  if (usd === undefined) return undefined;
  if (usd < 0.01) return `≈ $${usd.toFixed(3)}/min`;
  return `≈ $${usd.toFixed(2)}/min`;
}

export function activeEngine(settings: Partial<SessionSettings> | null, capability: VoiceEngineCapability | undefined): VoiceEngineId {
  const wanted = settings?.voiceEngine ?? capability?.default ?? "sibyl";
  return wanted === "gpt-realtime" && capability?.realtime.available ? "gpt-realtime" : "sibyl";
}

export function realtimeModelOf(settings: Partial<SessionSettings> | null, capability: VoiceEngineCapability) {
  const models = capability.realtime.models;
  return models.find((model) => model.id === settings?.realtimeModel) ?? models.find((model) => model.id === capability.realtime.defaultModel) ?? models[0];
}

export function unavailableText(capability: VoiceEngineCapability): string | undefined {
  switch (capability.realtime.unavailableReason) {
    case "no_key":
      return "Add an OpenAI key to use GPT Realtime";
    case "blocked":
      return "Turned off in this workspace";
    case "disabled":
      return "Turned off on this server";
    default:
      return undefined;
  }
}

export const TURN_OPTIONS: Array<{ id: RealtimeTurnDetection; label: string; hint: string }> = [
  { id: "quick", label: "Quick", hint: "Answers after a short pause (Sibyl's own detector). The fastest." },
  { id: "balanced", label: "Balanced", hint: "Listens to how you speak and waits when you sound unfinished." },
  { id: "patient", label: "Patient", hint: "Lets you take your time before it answers." }
];

const VOICE_NOTES: Record<string, string> = { marin: "warm, natural", cedar: "calm, natural" };

export function voiceLabel(voice: string): string {
  const name = voice.charAt(0).toUpperCase() + voice.slice(1);
  return VOICE_NOTES[voice] ? `${name} (${VOICE_NOTES[voice]})` : name;
}
