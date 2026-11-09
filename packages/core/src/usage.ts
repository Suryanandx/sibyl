/**
 * Cost metering: every model call (voice, deep brain, transcription, speech,
 * slides, routines) is recorded through one meter, with budgets that stop
 * spending before it happens instead of after.
 */

import type { CreditEntry } from "./tenancy";

export type UsageFeature =
  | "voice"
  | "brain"
  | "stt"
  | "tts"
  | "slides"
  | "routine"
  | "tool"
  | "scout"
  | "warmup"
  | "monitor"
  /** Vision / OCR model reading images and scanned PDFs added to knowledge. */
  | "knowledge_ocr"
  /** Meeting notes (summaries) and Ask AI about a meeting. */
  | "meetings"
  /** Images, video and audio made with create_image / create_video / create_audio or the Media page. */
  | "media";

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
  monitorId?: string;
  /** Agent the spend counts toward (agent budgets). */
  agentId?: string;
  /** Who caused the spend: a user id, or "token"/"local" for the org owner without an account. */
  userId?: string;
  /** Workspace the spend belongs to (absent: unattributed, e.g. background work of older records). */
  workspaceId?: string;
  /** Paid on the organization's own provider key (e.g. its OpenAI key for GPT Realtime): never charged as AI credits. */
  ownKey?: boolean;
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
  | {
      allowed: false;
      /** "policy": blocked by a usage policy (see UsagePolicy), not by the built-in caps. */
      scope: "daily" | "monthly" | "workspace_daily" | "workspace_monthly" | "routine_run" | "routine_daily" | "agent_daily" | "agent_monthly" | "policy" | "credits";
      message: string;
    };

/**
 * Spending caps set in the app (organization: Admin → Organization;
 * workspaces: Settings → Workspace). The meter checks them with the env caps.
 */
export interface AppBudgets {
  org?: { dailyUsd?: number; monthlyUsd?: number };
  workspaces?: Record<string, { dailyUsd?: number; monthlyUsd?: number }>;
}

/** An agent's own caps, checked on top of the owner's (agent budgets). */
export interface AgentBudgetScope {
  id: string;
  name?: string;
  dailyUsd?: number;
  monthlyUsd?: number;
}

/** Who is spending: filled in from the WebSocket session when the caller doesn't say. */
export interface UsageAttribution {
  /** User id, or "token"/"local" for the org owner without an account. */
  userId?: string;
  workspaceId?: string;
  /** The user's role in that workspace. */
  role?: string;
}

/** What a usage policy is asked before a call, after the built-in caps allowed it. */
export interface UsagePolicyCheck extends UsageAttribution {
  ownerId: string;
  estimateUsd: number;
  feature?: UsageFeature;
  model?: string;
  routineId?: string;
  now: number;
}

/**
 * The one usage-policy hook (Enterprise "advanced usage controls" plugs in
 * here through EnterpriseModuleContext.registerUsagePolicy). The meter asks
 * every policy only after its own organisation caps allowed the call, so the
 * open-source budgets and the 85% economy switch behave exactly the same
 * with or without a policy.
 */
export interface UsagePolicy {
  /** undefined (or { allowed: true }) lets the call go ahead; { downgrade: true } asks for economy models. */
  check(input: UsagePolicyCheck): BudgetDecision | undefined;
  /**
   * A credits ledger charge for this event, written in the same store
   * transaction as the event (hosted AI credits). Called before `recorded`.
   * Must not throw.
   */
  charge?(event: UsageEvent): CreditEntry | undefined;
  /** Called after every recorded event (attribution filled in). Must not throw. */
  recorded?(event: UsageEvent): void;
}

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
    /** Also check this agent's caps (meters without agent tracking ignore it). */
    agent?: AgentBudgetScope;
    /** Who is spending (for usage policies); a WebSocket session's attribution is used when absent. */
    userId?: string;
    workspaceId?: string;
    role?: string;
    sessionId?: string;
    feature?: UsageFeature;
    model?: string;
    now?: number;
  }): BudgetDecision;
  /** The organization caps in force (env caps, tightened by the in-app budget). */
  /** The caps in force for an organization (default: the self-hosted one). */
  limits(ownerId?: string): BudgetLimits;
  /** Replace an organization's in-app budgets (organization and per workspace). Meters without budgets leave it out. */
  configureBudgets?(budgets: AppBudgets, ownerId?: string): void;
  /** Install a usage policy (returns its removal). Meters without policy support leave it out. */
  addPolicy?(policy: UsagePolicy): () => void;
}
