export type VoiceState =
  | "offline"
  | "idle"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking";

export const VOICE_LABELS: Record<VoiceState, string> = {
  offline: "Offline",
  idle: "Voice off",
  ready: "Listening for you…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking"
};
