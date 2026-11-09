/**
 * Runs one routine: its instruction goes through the deep brain's tool loop
 * (non-interactive, no voice) with the enabled tools.
 *
 * - Budget: before every model round the run's cap (the routine's maxRunUsd,
 *   else SIBYL_BUDGET_ROUTINE_RUN_USD) and the owner's daily/monthly and
 *   per-routine daily caps are checked; a run that would exceed one stops as
 *   `budget_blocked`.
 * - Write tools create an approval carrying `routineId`; the run waits as
 *   `awaiting_approval` until it is decided (inbox or chat) or expires (24 h).
 * - The result is posted as an assistant message to the routine's own
 *   conversation (created on the first run).
 * - Every model and tool cost is recorded as feature "routine" with the
 *   routine id, and summed on the run.
 */
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import type {
  ApprovalRecord,
  ConversationRecord,
  RoutineRecord,
  RoutineRunRecord,
  RoutineRunStatus,
  Store,
  StoredMessage,
  ToolDefinition,
  ToolRegistry,
  UsageMeter
} from "@open-gpt-live/core";
import type { ApprovalView, ModelCatalog, RoutineNotification } from "@open-gpt-live/protocol";
import { approvalDetails, redactInput, summarizeApproval, type ApprovalOutcome } from "../brain/approvals.js";
import { runToolLoop, toolSystemPrompt } from "../brain/tool-loop.js";
import { estimateTurnUsd } from "../metering/budget.js";
import { formatUsd } from "./records.js";

export const ROUTINE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type RunOutcomeStatus = Extract<RoutineRunStatus, "succeeded" | "failed" | "interrupted" | "budget_blocked">;

export interface RunOutcome {
  status: RunOutcomeStatus;
  summary?: string;
  error?: string;
  /** A failure worth one retry (network, rate limit, 5xx). */
  transient?: boolean;
}

/** The run being executed; the scheduler persists it. */
export interface RunHandle {
  readonly run: RoutineRunRecord;
  /** False while the scheduler would still retry a transient failure. */
  readonly lastAttempt: boolean;
  setStatus(status: "running" | "awaiting_approval"): Promise<void>;
  addCost(usd: number): void;
}

export type RoutineRunner = (routine: RoutineRecord, handle: RunHandle, signal: AbortSignal) => Promise<RunOutcome>;

type Log = (event: string, fields?: Record<string, unknown>) => void;

/* ───────────── approvals for routine runs ───────────── */

export interface RoutineApprovalRequest {
  routine: RoutineRecord;
  runId: string;
  conversationId?: string;
  tool: ToolDefinition<any, any>;
  input: Record<string, unknown>;
  signal: AbortSignal;
}

/** Waits for decisions on approvals created by routine runs (not tied to a socket). */
export class RoutineApprovalGate {
  private readonly waiters = new Map<string, { runId: string; resolve(outcome: ApprovalOutcome): void }>();
  private readonly ttlMs: number;

  constructor(
    private readonly options: {
      store: Store;
      ownerId: string;
      createId(): string;
      now(): number;
      log: Log;
      ttlMs?: number;
      /** A new approval is waiting (inbox + notification). */
      onRequested?(view: ApprovalView, routine: RoutineRecord): void;
      /** An approval was decided or expired. */
      onResolved?(id: string, status: "approved" | "declined" | "expired"): void;
    }
  ) {
    this.ttlMs = options.ttlMs ?? ROUTINE_APPROVAL_TTL_MS;
  }

  /** Run ids currently waiting on a decision. */
  waitingRunIds(): Set<string> {
    return new Set([...this.waiters.values()].map((w) => w.runId));
  }

  async request(request: RoutineApprovalRequest): Promise<ApprovalOutcome> {
    if (request.signal.aborted) return "expired";
    const createdAt = this.options.now();
    const details = approvalDetails(request.input);
    const record: ApprovalRecord = {
      id: this.options.createId(),
      ownerId: this.options.ownerId,
      runId: request.runId,
      routineId: request.routine.id,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      toolName: request.tool.name,
      title: request.tool.title,
      summary: summarizeApproval(request.tool, request.input, details),
      input: redactInput(request.input),
      status: "pending",
      createdAt,
      expiresAt: createdAt + this.ttlMs
    };
    await this.options.store.approvals.create(record);
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      this.waiters.set(record.id, { runId: request.runId, resolve });
    });
    const timer = setTimeout(() => void this.expire(record.id, "timeout"), this.ttlMs);
    timer.unref?.();
    const onAbort = (): void => void this.expire(record.id, "aborted");
    request.signal.addEventListener("abort", onAbort, { once: true });
    this.options.log("routine.approval_requested", { id: record.id, routineId: request.routine.id, toolName: record.toolName });
    this.options.onRequested?.(approvalView(record, details), request.routine);
    try {
      return await outcome;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Apply a decision. Returns the resulting status, or undefined when the
   * approval is unknown. Already-decided approvals return their status.
   */
  async decide(id: string, decision: "approve" | "decline"): Promise<ApprovalRecord["status"] | undefined> {
    const status = decision === "approve" ? "approved" : "declined";
    const decided = await this.options.store.approvals.decide(this.options.ownerId, id, status, this.options.now());
    if (!decided) {
      const existing = await this.options.store.approvals.get(this.options.ownerId, id);
      return existing?.status;
    }
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.resolve(status);
    this.options.log("routine.approval_decided", { id, status, waiting: Boolean(waiter) });
    this.options.onResolved?.(id, status);
    return status;
  }

  /** Expire an approval whose run is gone (e.g. after a restart). */
  async expireOrphan(id: string): Promise<void> {
    if (this.waiters.has(id)) return;
    const decided = await this.options.store.approvals.decide(this.options.ownerId, id, "expired", this.options.now());
    if (decided) this.options.onResolved?.(id, "expired");
  }

  dispose(): void {
    for (const id of [...this.waiters.keys()]) void this.expire(id, "shutdown");
  }

  private async expire(id: string, reason: string): Promise<void> {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.resolve("expired");
    try {
      await this.options.store.approvals.decide(this.options.ownerId, id, "expired", this.options.now());
    } catch {
      // Store may be closing; the run has been told either way.
    }
    this.options.log("routine.approval_expired", { id, reason });
    this.options.onResolved?.(id, "expired");
  }
}

export function approvalView(record: ApprovalRecord, details = approvalDetails(record.input)): ApprovalView {
  return {
    id: record.id,
    runId: record.runId,
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    ...(record.routineId ? { routineId: record.routineId } : {}),
    toolName: record.toolName,
    title: record.title,
    summary: record.summary,
    details,
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt })
  };
}

/* ───────────── the runner ───────────── */

export class BudgetBlockedError extends Error {
  constructor(
    message: string,
    readonly scope: string
  ) {
    super(message);
  }
}

export interface RoutineRunnerOptions {
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  provider: ToolChatProvider | undefined;
  /** Deep-brain model for routines. */
  model(): string | undefined;
  extraBody?(model: string): Record<string, unknown> | undefined;
  catalog?(): ModelCatalog | undefined;
  /** Brain persona / instructions (without the tool list). */
  systemPrompt: string;
  approvals: RoutineApprovalGate;
  /** Names of tools a routine may not call (e.g. the routine tools themselves). */
  excludeTools?: ReadonlySet<string>;
  createId(): string;
  now(): number;
  log: Log;
  notify?(notification: RoutineNotification): void;
  maxRounds?: number;
}

const ROUTINE_PROMPT = [
  "",
  "",
  "## Scheduled routine",
  "You are running a scheduled routine on your own: nobody is watching live and you cannot ask questions.",
  "Do the task below completely, using tools where needed, then write the result as a concise message for the user's chat.",
  "Write plain text: no Markdown symbols (no **, #, tables) and no generative UI; short paragraphs, simple \"- \" lists, links as plain URLs. Lead with the result; skip greetings and meta commentary."
].join("\n");

export function createRoutineRunner(options: RoutineRunnerOptions): RoutineRunner {
  return async (routine, handle, signal) => {
    const model = options.model();
    if (!options.provider || !model) {
      return { status: "failed", error: "No deep-brain model is configured for routines." };
    }
    const conversationId = await ensureConversation(options, routine);
    const tools = options.tools
      .list({ enabledOnly: true })
      .filter((tool) => !options.excludeTools?.has(tool.name));
    const now = new Date(options.now());
    const localNow = safeFormat(now, routine.timezone);
    const system =
      `${options.systemPrompt}${ROUTINE_PROMPT}\nRoutine: ${routine.name}\nNow: ${localNow} (${routine.timezone})` +
      (tools.length ? toolSystemPrompt(tools) : "");

    const envCap = options.meter.limits().perRoutineRunUsd;
    const runCap = routine.maxRunUsd ?? envCap;
    const meter = routineMeter(options.meter, routine.id, handle);
    const provider = budgetedProvider(options.provider, () => {
      const estimateUsd = estimateTurnUsd(options.meter, "routine", model, options.catalog?.());
      const spent = handle.run.costUsd;
      if (runCap !== undefined && (spent >= runCap || spent + estimateUsd > runCap)) {
        throw new BudgetBlockedError(
          `The run reached its cost cap (${formatUsd(spent)} of ${formatUsd(runCap)}) and was stopped.`,
          "routine_run"
        );
      }
      const decision = options.meter.check({
        ownerId: routine.ownerId,
        estimateUsd,
        routineId: routine.id,
        // The routine's own cap (checked above) replaces the env per-run cap.
        routineRunUsdSoFar: routine.maxRunUsd === undefined ? spent : 0
      });
      if (!decision.allowed) throw new BudgetBlockedError(decision.message, decision.scope);
    });

    let text = "";
    let steps: StoredMessage["steps"] = [];
    let outcome: RunOutcome;
    try {
      const result = await runToolLoop({
        provider,
        model,
        ...(options.extraBody?.(model) ? { extraBody: options.extraBody(model)! } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: routine.instruction }
        ],
        tools,
        signal,
        runId: handle.run.id,
        ownerId: routine.ownerId,
        conversationId,
        store: options.store,
        meter,
        log: (event, fields) => options.log(event, { routineId: routine.id, runId: handle.run.id, ...fields }),
        onText: (delta) => {
          text += delta;
        },
        onToolStarted: () => undefined,
        onToolFinished: () => undefined,
        approve: async ({ tool, input }) => {
          await handle.setStatus("awaiting_approval");
          try {
            return await options.approvals.request({ routine, runId: handle.run.id, conversationId, tool, input, signal });
          } finally {
            if (!signal.aborted) await handle.setStatus("running");
          }
        },
        ...(options.maxRounds ? { maxRounds: options.maxRounds } : {})
      });
      steps = result.steps;
      if (result.aborted || signal.aborted) return { status: "interrupted", error: "The run was stopped." };
      const reply = text.trim() || "The routine finished without a reply.";
      outcome = { status: "succeeded", summary: summarize(reply) };
      text = reply;
    } catch (error) {
      if (signal.aborted) return { status: "interrupted", error: "The run was stopped." };
      if (error instanceof BudgetBlockedError) {
        outcome = { status: "budget_blocked", error: error.message };
        text = [text.trim(), `Routine stopped: ${error.message}`].filter(Boolean).join("\n\n");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const transient = isTransientError(error);
        // Transient failures are retried once by the scheduler before posting.
        if (transient && !handle.lastAttempt) return { status: "failed", error: message, transient };
        outcome = { status: "failed", error: message, transient };
        text = [text.trim(), `Routine failed: ${message}`].filter(Boolean).join("\n\n");
      }
    }

    await postResult(options, routine, conversationId, handle.run.id, model, text, steps);
    return outcome;
  };
}

/** Post a message into the routine's conversation (used for results and final failures). */
export async function postResult(
  options: Pick<RoutineRunnerOptions, "store" | "createId" | "now" | "log">,
  routine: RoutineRecord,
  conversationId: string,
  runId: string,
  model: string | undefined,
  content: string,
  steps: StoredMessage["steps"] = []
): Promise<void> {
  const message: StoredMessage = {
    id: options.createId(),
    role: "assistant",
    content,
    requestId: runId,
    ...(model ? { model } : {}),
    ...(steps && steps.length ? { steps } : {}),
    createdAt: options.now()
  };
  try {
    await options.store.conversations.appendMessage(routine.ownerId, conversationId, message);
  } catch (error) {
    options.log("routine.post_failed", { routineId: routine.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/** The routine's conversation, created on first use (and re-created if deleted). */
export async function ensureConversation(
  options: Pick<RoutineRunnerOptions, "store" | "createId" | "now">,
  routine: RoutineRecord
): Promise<string> {
  const { store } = options;
  if (routine.conversationId && (await store.conversations.get(routine.ownerId, routine.conversationId))) {
    return routine.conversationId;
  }
  const now = options.now();
  const conversation: ConversationRecord = {
    id: options.createId(),
    ownerId: routine.ownerId,
    title: `Routine: ${routine.name}`.slice(0, 60),
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  await store.conversations.upsert(conversation);
  // Re-read so a concurrent edit (pause, rename) is not overwritten.
  const latest = (await store.routines.get(routine.ownerId, routine.id)) ?? routine;
  await store.routines.upsert({ ...latest, conversationId: conversation.id });
  routine.conversationId = conversation.id;
  return conversation.id;
}

/** Records every cost of the run as feature "routine" with the routine id, and sums it. */
function routineMeter(meter: UsageMeter, routineId: string, handle: RunHandle): UsageMeter {
  return {
    record(event) {
      const cost = Number.isFinite(event.costUsd) && event.costUsd > 0 ? event.costUsd : 0;
      handle.addCost(cost);
      meter.record({ ...event, feature: event.feature === "brain" ? "routine" : event.feature, routineId });
    },
    totals: (ownerId, now) => meter.totals(ownerId, now),
    check: (input) => meter.check({ ...input, routineId }),
    limits: () => meter.limits()
  };
}

/** Wraps the model so the budget is checked before each round. */
function budgetedProvider(provider: ToolChatProvider, check: () => void): ToolChatProvider {
  return {
    streamWithTools(messages, options) {
      check();
      return provider.streamWithTools(messages, options);
    }
  };
}

const TRANSIENT = /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|\b429\b|\b5\d\d\b|rate.?limit|overloaded|temporar|unavailable/i;

export function isTransientError(error: unknown): boolean {
  if (error instanceof BudgetBlockedError) return false;
  const message = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? "")}` : String(error);
  return TRANSIENT.test(message);
}

function summarize(text: string): string {
  const flat = text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function safeFormat(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "full",
      timeStyle: "short"
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
