/**
 * Cost metering: every model call (voice, deep brain, transcription, speech,
 * slides, routines) is recorded through one meter, with budgets that stop
 * spending before it happens instead of after.
 */

export type UsageFeature =
  | "voice"
  | "brain"
  | "stt"
  | "tts"
  | "slides"
  | "routine"
  | "tool"
  | "scout"
  | "warmup";

export interface UsageEvent {
  id: string;
  at: number;
  ownerId: string;
  feature: UsageFeature;
  model: string;
  /** Actual USD cost reported by the provider (OpenRouter `usage.cost`), else an estimate. */
  costUsd: number;
  estimated: boolean;
  promptTokens?: number;
  completionTokens?: number;
  /** Seconds of audio (stt) or characters (tts) when billed that way. */
  units?: number;
  conversationId?: string;
  requestId?: string;
  routineId?: string;
}

/** Usage reported by a model call (OpenRouter returns `usage` with `cost` when asked). */
export interface ModelUsage {
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface BudgetLimits {
  /** Monthly cap for the owner (all features). */
  monthlyUsd?: number;
  /** Daily cap for the owner. */
  dailyUsd?: number;
  /** Per routine run cap. */
  perRoutineRunUsd?: number;
  /** Per routine per day cap. */
  perRoutineDailyUsd?: number;
}

export interface UsageTotals {
  todayUsd: number;
  monthUsd: number;
  /** Spend in the current WebSocket session (resets on reconnect). */
  sessionUsd?: number;
  byFeature: Partial<Record<UsageFeature, number>>;
}

export type BudgetDecision =
  | { allowed: true; downgrade?: boolean }
  | { allowed: false; scope: "daily" | "monthly" | "routine_run" | "routine_daily"; message: string };

export interface UsageMeter {
  record(event: Omit<UsageEvent, "id" | "at"> & { at?: number }): void;
  totals(ownerId: string, now?: number): UsageTotals;
  /**
   * Check before spending. `estimateUsd` is the expected cost of the call.
   * Returns { allowed:false } when a cap would be exceeded; { downgrade:true }
   * when close to a cap (≥ 85%), so callers can switch to cheaper models.
   */
  check(input: {
    ownerId: string;
    estimateUsd: number;
    routineId?: string;
    routineRunUsdSoFar?: number;
    now?: number;
  }): BudgetDecision;
  limits(): BudgetLimits;
}
