"use client";

import { create } from "zustand";
import type { TurnMetrics } from "@open-gpt-live/protocol";
import type { LatencySnapshot } from "../../lib/latency-metrics";
import type { VadSnapshot } from "../../lib/vad-engine";

/**
 * Live voice diagnostics, written by the chat screen and shown in
 * Settings → Diagnostics. A tiny store so VAD updates don't re-render the app.
 */
export interface VoiceDiagnostics {
  latency: LatencySnapshot | null;
  /** The gateway's metrics for the latest spoken reply (turn.metrics; LiveKit's names). */
  turn: (TurnMetrics & { requestId: string }) | null;
  vad: VadSnapshot | null;
  liveMode: boolean;
  adaptiveEnabled: boolean;
}

export const useVoiceDiagnostics = create<VoiceDiagnostics>(() => ({
  latency: null,
  turn: null,
  vad: null,
  liveMode: false,
  adaptiveEnabled: false
}));
