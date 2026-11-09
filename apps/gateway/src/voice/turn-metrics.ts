/**
 * Turn metrics with LiveKit Agents' names and definitions (docs/voice.md,
 * "Latency metrics"), computed from one turn's gateway timestamps:
 *
 *   eouDelayMs            end of speech → turn committed (incl. the detector's silence wait)
 *   transcriptionDelayMs  end of speech → final transcript
 *   llmTtftMs             voice-brain request → first token
 *   ttsTtfbMs             first speech request → first audio byte from the speech model
 *   e2eLatencyMs          end of speech → first audio sent to the listener
 *
 * "End of speech" is the last voiced audio: the time the detector's
 * vad.speech_end arrived minus the silence it waited for (`silenceMs`).
 */
import type { TurnMetrics } from "@open-gpt-live/protocol";

export interface TurnTiming {
  /** Gateway time vad.speech_end (or the final audio chunk) arrived. */
  speechEndedAt?: number;
  /** Silence the detector waited for before ending the turn. */
  silenceMs?: number;
  /** The turn was committed (voice brain or chat model started on it). */
  finalTranscriptAt?: number;
  /** The accurate transcript arrived (background transcription in live mode). */
  transcriptAt?: number;
  llmStartedAt?: number;
  firstLlmDeltaAt?: number;
  ttsStartedAt?: number;
  ttsFirstByteAt?: number;
  firstTtsChunkAt?: number;
  preemptive?: boolean;
}

export function turnMetrics(
  timing: TurnTiming,
  context: { transport: TurnMetrics["transport"]; voiceModel?: string; ttsModel?: string }
): TurnMetrics {
  const lastVoiceAt = timing.speechEndedAt === undefined ? undefined : timing.speechEndedAt - (timing.silenceMs ?? 0);
  const metrics: TurnMetrics = {
    transport: context.transport,
    ...span("eouDelayMs", lastVoiceAt, timing.finalTranscriptAt),
    ...span("transcriptionDelayMs", lastVoiceAt, timing.transcriptAt),
    ...span("llmTtftMs", timing.llmStartedAt, timing.firstLlmDeltaAt),
    ...span("ttsTtfbMs", timing.ttsStartedAt, timing.ttsFirstByteAt),
    ...span("e2eLatencyMs", lastVoiceAt, timing.firstTtsChunkAt),
    ...(timing.preemptive ? { preemptive: true } : {}),
    ...(context.voiceModel ? { voiceModel: context.voiceModel } : {}),
    ...(context.ttsModel ? { ttsModel: context.ttsModel } : {})
  };
  return metrics;
}

function span<K extends string>(key: K, start: number | undefined, end: number | undefined): Partial<Record<K, number>> {
  if (start === undefined || end === undefined) return {};
  // A preemptive reply can start before the turn is final: never report negative time.
  return { [key]: Math.max(0, Math.round(end - start)) } as Record<K, number>;
}
