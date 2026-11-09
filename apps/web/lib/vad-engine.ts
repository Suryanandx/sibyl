/** The speech detector lives in @open-gpt-live/core (shared with the gateway's realtime room agent). */
export {
  AdaptiveVadEngine,
  type SpeechDetector,
  type SpeechDetectorEvent,
  type SpeechDetectorFrame,
  type SpeechDetectorResult,
  type VadSnapshot,
  type VadState
} from "@open-gpt-live/core/vad";
