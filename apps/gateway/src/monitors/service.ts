/**
 * Monitors as one service on the runtime.
 *
 * - Scheduling: polled monitors are a second job type on the routine
 *   scheduler (`jobType`): the scheduler's tick asks `due()`, claims a
 *   monitor with a lease (`leaseUntil`, renewed by its heartbeat), runs one
 *   check and releases it. Expired leases are cleared on every tick.
 * - A check: creator's principal → fetch → evaluate (diff, filters, model on
 *   new candidates only) → actions → save state, spend and status.
 * - Failures back off (interval × 2^failures, at most a day); after
 *   MAX_CONSECUTIVE_FAILURES in a row the monitor pauses itself with the
 *   reason, and the creator is told (a monitor_paused notification).
 * - Notify actions publish one notification (monitor_fired) to the creator
 *   through the notifications module: inbox always, plus the monitor's
 *   other channels (email, …). The stored event records how each went.
 * - Budget: a monitor's daily budget (and the owner's budgets) gate every
 *   model call; when the daily budget is used up, checks resume tomorrow.
 * - Webhooks: HMAC-verified deliveries run the same pipeline right away.
 * - Privacy: a monitor runs with its creator's access; only the creator sees
 *   its condition, events and results. Workspace admins see that it exists
 *   and can pause or delete it.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import {
  PERMISSIONS,
  authorize,
  type ModelUsage,
  type MonitorEventAction,
  type MonitorEventRecord,
  type MonitorRecord,
  type Principal,
  type Store,
  type ToolRegistry,
  type UsageMeter
} from "@open-gpt-live/core";
import {
  MONITOR_EVENTS,
  type ModelCatalog,
  type MonitorChannelOption,
  type MonitorChannelView,
  type MonitorEventView,
  type MonitorInput,
  type MonitorSaveResponse,
  type MonitorSourceOption,
  type MonitorStatusView,
  type MonitorTestResult,
  type MonitorView,
  type MonitorsListResponse,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { economyModel, estimateTurnUsd } from "../metering/budget.js";
import { GatewayUsageMeter } from "../metering/meter.js";
import { CostEstimator } from "../metering/pricing.js";
import type { RoutineService } from "../routines/service.js";
import type { ScheduledJobType } from "../routines/scheduler.js";
import { ROUTINE_TOOL_NAMES } from "../routines/tools.js";
import type { SecretVault } from "../secrets/vault.js";
import type { FetchLike } from "../tools/builtin/http.js";
import { assertPublicUrl, defaultResolveHost, type ResolveHost } from "../net/safe-fetch.js";
import { askCondition, MAX_ASK_ITEMS } from "./ask.js";
import { evaluate, linksOf, MAX_EVENT_ITEMS, summarizeMatches, type EvaluateMode, type Evaluation, type Match } from "./engine.js";
import type { NotificationService } from "../notifications/service.js";
import {
  addSpend,
  applyMonitorInput,
  createMonitorRecord,
  currentSpend,
  estimateMonthlyCost,
  formatUsd,
  hookPath,
  nextUtcMidnight,
  setPaused,
  toEventView,
  toMonitorView,
  toStatusView,
  type CostEstimate
} from "./records.js";
import { fetchSource, parseWebhookBody, sourceToolProblem } from "./sources.js";
import { runMonitorTask } from "./task.js";
import { actingPrincipal } from "../agents/access.js";
import type { AgentRuntime } from "../agents/runtime.js";

export const MONITOR_JOB_KIND = "monitor";
export const MAX_CONSECUTIVE_FAILURES = 5;
export const MAX_BACKOFF_MINUTES = 24 * 60;
export const MAX_TASK_RUNS = 3;
export const MAX_MONITORS_PER_PERSON = 50;
export const WEBHOOK_MAX_BYTES = 256 * 1024;
export const WEBHOOK_PER_MINUTE = 60;
/** Brain rounds assumed per task run for estimates. */
const TASK_ROUNDS_ESTIMATE = 3;
/** Floors for estimates when no pricing is known. */
const MIN_ASK_USD = 0.0002;
const MIN_TASK_TURN_USD = 0.002;
const MINUTE = 60_000;

export const MONITOR_TOOL_NAMES: ReadonlySet<string> = new Set(["create_monitor", "list_monitors", "pause_monitor", "delete_monitor"]);

type Log = (event: string, fields?: Record<string, unknown>) => void;
type Send = (message: ServerMessage) => void;

export class MonitorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request"
  ) {
    super(message);
  }
}

export interface MonitorServiceOptions {
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: Log;
  /** Scheduler (shared with routines) and the approval inbox for task writes. */
  routines?: RoutineService;
  /** Secrets vault (webhook signing keys); a getter because it is installed later. */
  vault?(): SecretVault | undefined;
  /** The one publish path for fired and paused notices (inbox, email, …). */
  notifications: NotificationService;
  createId?(): string;
  now?(): number;
  /** Test seams. */
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

export interface MonitorBrainOptions {
  provider: ToolChatProvider | undefined;
  /** Deep-brain model for tasks. */
  model(): string | undefined;
  /** Small model for the plain-language condition (default: SIBYL_MONITOR_MODEL, the cheapest preset, else model()). */
  askModel?(): string | undefined;
  systemPrompt: string;
  extraBody?(model: string): Record<string, unknown> | undefined;
  catalog?(): ModelCatalog | undefined;
}

interface Subscriber {
  send: Send;
  principal(): Principal;
  workspaceId(): string;
}

interface Caller {
  principal: Principal;
  workspaceId: string;
}

export class MonitorService {
  readonly jobType: ScheduledJobType<MonitorRecord>;
  private brain: MonitorBrainOptions | undefined;
  /** Set by the runtime once agents are installed (tasks can run as an agent, like routines). */
  agents: AgentRuntime | undefined;
  private readonly subscribers = new Set<Subscriber>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly checking = new Set<string>();
  private readonly tasks = new Map<string, AbortController>();
  private readonly hookHits = new Map<string, number[]>();
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly excluded: ReadonlySet<string>;
  private stopped = false;

  constructor(private readonly options: MonitorServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.excluded = new Set([...MONITOR_TOOL_NAMES, ...ROUTINE_TOOL_NAMES]);
    this.jobType = this.createJobType();
  }

  /** Models for the condition and tasks (called by the server once they are known). */
  configure(brain: MonitorBrainOptions): void {
    this.brain = brain;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.tasks.values()) controller.abort("shutdown");
    this.subscribers.clear();
  }

  /* ───────────── scheduler job type ───────────── */

  private createJobType(): ScheduledJobType<MonitorRecord> {
    const { store, ownerId } = this.options;
    return {
      kind: MONITOR_JOB_KIND,
      maxConcurrency: 2,
      due: async (now) => (await store.monitors.due(now)).filter((m) => m.ownerId === ownerId && m.source.kind !== "webhook"),
      claim: (job, now, leaseUntil) =>
        this.mutate(job.id, (latest) => {
          if (!latest.enabled || latest.source.kind === "webhook" || (latest.leaseUntil ?? 0) > now || this.checking.has(latest.id)) return undefined;
          return { ...latest, leaseUntil, nextCheckAt: now + latest.schedule.everyMinutes * MINUTE };
        }),
      renew: async (job, leaseUntil) => {
        await this.mutate(job.id, (latest) => ({ ...latest, leaseUntil }));
      },
      run: (job, signal) => this.runCheck(job.id, signal),
      release: async (job) => {
        await this.mutate(job.id, (latest) => {
          if (latest.leaseUntil === undefined) return undefined;
          const next = { ...latest };
          delete next.leaseUntil;
          return next;
        });
      },
      recover: async (now, active) => {
        for (const monitor of await store.monitors.list(ownerId)) {
          if (monitor.leaseUntil === undefined || monitor.leaseUntil > now || active.has(monitor.id)) continue;
          await this.mutate(monitor.id, (latest) => {
            const next = { ...latest };
            delete next.leaseUntil;
            return next;
          });
          this.options.log("monitor.lease_recovered", { monitorId: monitor.id });
        }
      },
      liveRunIds: () => new Set(this.tasks.keys()),
      get: (id) => store.monitors.get(ownerId, id)
    };
  }

  /** Serialized read-modify-write of one monitor. fn returns undefined to leave it unchanged. */
  private async mutate(id: string, fn: (latest: MonitorRecord) => MonitorRecord | undefined): Promise<MonitorRecord | undefined> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      const latest = await this.options.store.monitors.get(this.options.ownerId, id);
      if (!latest) return undefined;
      const next = fn(latest);
      if (!next) return undefined;
      await this.options.store.monitors.upsert(next);
      return next;
    });
    const settled = run.catch(() => undefined);
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }

  /* ───────────── checks ───────────── */

  /** One check of a polled monitor (the scheduler's job). */
  async runCheck(id: string, signal: AbortSignal): Promise<void> {
    const monitor = await this.options.store.monitors.get(this.options.ownerId, id);
    if (!monitor || !monitor.enabled || this.checking.has(id)) return;
    this.checking.add(id);
    this.broadcastStatus(monitor);
    try {
      await this.process(monitor, "check", signal, (context) => fetchSource(monitor, context));
    } finally {
      this.checking.delete(id);
      const latest = await this.options.store.monitors.get(this.options.ownerId, id).catch(() => undefined);
      if (latest) this.broadcastStatus(latest);
    }
  }

  /**
   * The pipeline shared by checks and webhook deliveries: principal, budget,
   * fetch, evaluate, act, save.
   */
  private async process(
    monitor: MonitorRecord,
    mode: Exclude<EvaluateMode, "test">,
    signal: AbortSignal,
    load: (context: Parameters<typeof fetchSource>[1]) => Promise<unknown[]>
  ): Promise<void> {
    const now = this.now();
    const principal = await this.creatorPrincipal(monitor);
    if (typeof principal === "string") {
      await this.autoPause(monitor, principal);
      return;
    }
    const spend = currentSpend(monitor.spend, now);
    const daily = monitor.budget?.dailyUsd;
    if (daily !== undefined && spend.dayUsd >= daily) {
      await this.mutate(monitor.id, (latest) => ({
        ...latest,
        lastCheckedAt: now,
        lastError: `Daily budget reached (${formatUsd(spend.dayUsd)} of ${formatUsd(daily)}); checks resume tomorrow.`,
        ...(latest.source.kind === "webhook" || !latest.enabled ? {} : { nextCheckAt: nextUtcMidnight(now) })
      }));
      return;
    }
    const checkId = this.createId();
    let cost = 0;
    const meter = this.monitorMeter(monitor.id, (usd) => (cost += usd));
    let evaluation: Evaluation;
    try {
      const raw = await load({
        tools: this.options.tools,
        excludeTools: this.excluded,
        store: this.options.store,
        meter,
        principal,
        runId: checkId,
        signal,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.resolveHost ? { resolveHost: this.options.resolveHost } : {}),
        log: this.options.log
      });
      evaluation = await this.evaluateWith(monitor, raw, mode, signal, checkId, () => cost, (usd) => (cost += usd));
    } catch (error) {
      if (signal.aborted) return;
      await this.recordFailure(monitor, error, cost);
      return;
    }
    if (signal.aborted) return;

    let fired: MonitorEventRecord | undefined;
    if (evaluation.matches.length > 0) {
      fired = await this.fire(monitor, evaluation.matches, principal, cost);
    }
    const saved = await this.mutate(monitor.id, (latest) => {
      const next: MonitorRecord = {
        ...latest,
        lastCheckedAt: now,
        failureCount: 0,
        spend: addSpend(latest.spend, cost, now),
        ...(evaluation.nextState ? { state: evaluation.nextState } : {}),
        ...(fired ? { lastFiredAt: now } : {})
      };
      if (evaluation.askSkipped) next.lastError = evaluation.askSkipped;
      else delete next.lastError;
      return next;
    });
    this.options.log("monitor.checked", {
      monitorId: monitor.id,
      mode,
      fetched: evaluation.fetched,
      newItems: evaluation.newItems,
      candidates: evaluation.candidates,
      matches: evaluation.matches.length,
      deferred: evaluation.deferred,
      baseline: evaluation.baseline,
      costUsd: cost
    });
    if (saved) this.broadcastStatus(saved);
  }

  private async evaluateWith(
    monitor: MonitorRecord,
    raw: unknown[],
    mode: EvaluateMode,
    signal: AbortSignal,
    checkId: string,
    spent: () => number,
    addCost: (usd: number) => void
  ): Promise<Evaluation> {
    const brain = this.brain;
    const model = this.askModel();
    const provider = brain?.provider;
    return evaluate({
      monitor,
      raw,
      mode,
      ...(provider && model
        ? {
            ask: async (items) => {
              const extraBody = brain?.extraBody?.(model);
              const result = await askCondition({
                provider,
                model,
                ...(extraBody ? { extraBody } : {}),
                question: monitor.condition.ask ?? "",
                monitorName: monitor.name,
                items,
                signal,
                onUsage: (usage) => addCost(this.recordAskUsage(monitor, model, checkId, usage))
              });
              return result.matches;
            }
          }
        : {}),
      canAsk: () => {
        const estimateUsd = this.askUnitUsd();
        const daily = monitor.budget?.dailyUsd;
        const today = currentSpend(monitor.spend, this.now()).dayUsd + spent();
        if (daily !== undefined && today + estimateUsd > daily) {
          return `Daily budget reached (${formatUsd(today)} of ${formatUsd(daily)}); new items wait until tomorrow.`;
        }
        const decision = this.options.meter.check({ ownerId: monitor.ownerId, estimateUsd });
        return decision.allowed ? undefined : decision.message;
      }
    });
  }

  private recordAskUsage(monitor: MonitorRecord, model: string, checkId: string, usage: ModelUsage): number {
    let costUsd = usage.costUsd;
    const meter = this.options.meter;
    if (costUsd === undefined && meter instanceof GatewayUsageMeter && (usage.promptTokens || usage.completionTokens)) {
      costUsd = new CostEstimator(meter.pricing, () => this.brain?.catalog?.()).llm("monitor", model, usage.promptTokens ?? 0, usage.completionTokens ?? 0);
    }
    const cost = Number.isFinite(costUsd) && (costUsd ?? 0) > 0 ? costUsd! : 0;
    try {
      meter.record({
        ownerId: monitor.ownerId,
        feature: "monitor",
        model,
        costUsd: cost,
        estimated: usage.costUsd === undefined,
        ...(usage.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
        ...(usage.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
        requestId: checkId,
        monitorId: monitor.id
      });
    } catch (error) {
      this.options.log("monitor.usage_record_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    return cost;
  }

  /** Records tool and model costs of a check under the monitor, and sums them. */
  private monitorMeter(monitorId: string, add: (usd: number) => void): UsageMeter {
    const meter = this.options.meter;
    return {
      record(event) {
        add(Number.isFinite(event.costUsd) && event.costUsd > 0 ? event.costUsd : 0);
        meter.record({ ...event, feature: event.feature === "brain" ? "monitor" : event.feature, monitorId });
      },
      totals: (ownerId, now) => meter.totals(ownerId, now),
      check: (input) => meter.check(input),
      limits: () => meter.limits()
    };
  }

  private async recordFailure(monitor: MonitorRecord, error: unknown, cost: number): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const now = this.now();
    const failures = (monitor.failureCount ?? 0) + 1;
    this.options.log("monitor.check_failed", { monitorId: monitor.id, failures, error: message });
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await this.mutate(monitor.id, (latest) => ({ ...latest, failureCount: failures, lastError: message, lastCheckedAt: now, spend: addSpend(latest.spend, cost, now) }));
      await this.autoPause(monitor, `Paused after ${failures} failed checks in a row. Last error: ${message}`);
      return;
    }
    const backoff = Math.min(monitor.schedule.everyMinutes * 2 ** failures, MAX_BACKOFF_MINUTES);
    const saved = await this.mutate(monitor.id, (latest) => ({
      ...latest,
      failureCount: failures,
      lastError: message,
      lastCheckedAt: now,
      spend: addSpend(latest.spend, cost, now),
      ...(latest.enabled && latest.source.kind !== "webhook" ? { nextCheckAt: now + backoff * MINUTE } : {})
    }));
    if (saved) this.broadcastStatus(saved);
  }

  /** Pause with a reason and tell the creator (inbox, and email when the monitor emails). */
  private async autoPause(monitor: MonitorRecord, reason: string): Promise<void> {
    const now = this.now();
    const paused = await this.mutate(monitor.id, (latest) => setPaused(latest, true, now, reason));
    if (!paused) return;
    this.options.routines?.scheduler?.cancelJob(MONITOR_JOB_KIND, monitor.id);
    const event: MonitorEventRecord = {
      id: this.createId(),
      monitorId: monitor.id,
      ownerId: monitor.ownerId,
      workspaceId: monitor.workspaceId,
      createdBy: monitor.createdBy,
      at: now,
      kind: "paused",
      summary: `“${monitor.name}” was paused. ${reason}`,
      items: [],
      links: [],
      costUsd: 0,
      actions: []
    };
    const email = paused.actions.some((action) => action.kind === "notify" && action.channels.includes("email"));
    event.actions.push(...(await this.tell(paused, event, email ? ["email"] : [])));
    await this.options.store.monitors.insertEvent(event);
    this.broadcastStatus(paused);
    this.options.log("monitor.auto_paused", { monitorId: monitor.id, reason });
  }

  /** Something matched: notify and/or start a task, and store the event. */
  private async fire(monitor: MonitorRecord, matches: Match[], principal: Principal, costUsd: number): Promise<MonitorEventRecord> {
    const event: MonitorEventRecord = {
      id: this.createId(),
      monitorId: monitor.id,
      ownerId: monitor.ownerId,
      workspaceId: monitor.workspaceId,
      createdBy: monitor.createdBy,
      at: this.now(),
      kind: "fired",
      summary: summarizeMatches(monitor.name, matches),
      items: matches.slice(0, MAX_EVENT_ITEMS).map((match) => ({
        key: match.item.key,
        title: match.item.title,
        ...(match.item.url ? { url: match.item.url } : {}),
        ...(match.reason ? { reason: match.reason } : {})
      })),
      links: linksOf(matches),
      costUsd,
      actions: []
    };
    for (const action of monitor.actions) {
      if (action.kind === "task") event.actions.push(this.startTask(monitor, principal, action.instruction, matches, event));
    }
    const notify = monitor.actions.filter((action) => action.kind === "notify");
    if (notify.length > 0) event.actions.unshift(...(await this.tell(monitor, event, notify.flatMap((action) => action.channels))));
    await this.options.store.monitors.insertEvent(event);
    this.options.log("monitor.fired", { monitorId: monitor.id, matches: matches.length, actions: event.actions.map((a) => `${a.kind}:${a.channel ?? ""}:${a.status}`) });
    return event;
  }

  /** Publish the event to the creator (inbox always, plus `channels`); returns how each channel went. */
  private async tell(monitor: MonitorRecord, event: MonitorEventRecord, channels: MonitorChannelView[]): Promise<MonitorEventAction[]> {
    try {
      const { deliveries } = await this.options.notifications.notify(
        {
          kind: event.kind === "paused" ? "monitor_paused" : "monitor_fired",
          workspaceId: monitor.workspaceId,
          recipientUserId: monitor.createdBy,
          title: event.summary,
          body: eventBody(monitor, event),
          links: { monitorId: monitor.id, ...(monitor.agentId ? { agentId: monitor.agentId } : {}), ...(monitor.conversationId ? { conversationId: monitor.conversationId } : {}) }
        },
        { channels }
      );
      return deliveries.map((delivery) => ({ kind: "notify", channel: delivery.channel, status: delivery.status, ...(delivery.detail ? { detail: delivery.detail } : {}) }));
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      this.options.log("monitor.notify_failed", { monitorId: monitor.id, error: detail });
      return [{ kind: "notify", channel: "inbox", status: "failed", detail }];
    }
  }

  private startTask(monitor: MonitorRecord, principal: Principal, instruction: string, matches: Match[], event: MonitorEventRecord): MonitorEventAction {
    const brain = this.brain;
    const model = brain?.model();
    if (!brain?.provider || !model) return { kind: "task", status: "unavailable", detail: "No model is configured for tasks." };
    if (this.tasks.size >= MAX_TASK_RUNS) return { kind: "task", status: "skipped", detail: "Too many monitor tasks are running; this one was skipped." };
    const runId = this.createId();
    const controller = new AbortController();
    this.tasks.set(runId, controller);
    event.runId = runId;
    const catalog = brain.catalog?.();
    // Today's spend when the task starts (incl. this check's cost), plus what the task adds.
    let spentToday = currentSpend(monitor.spend, this.now()).dayUsd + event.costUsd;
    void runMonitorTask(
      {
        store: this.options.store,
        tools: this.options.tools,
        meter: this.options.meter,
        provider: brain.provider,
        model,
        ...(brain.extraBody ? { extraBody: brain.extraBody } : {}),
        ...(catalog ? { catalog } : {}),
        systemPrompt: brain.systemPrompt,
        ...(this.options.routines ? { approvals: this.options.routines.approvals } : {}),
        ...(this.agents ? { agents: this.agents } : {}),
        ...(this.options.routines?.governance ? { governance: this.options.routines.governance } : {}),
        excludeTools: this.excluded,
        createId: this.createId,
        now: this.now,
        log: this.options.log,
        checkBudget: (taskModel) => this.checkTaskBudget(monitor, taskModel, spentToday),
        onCost: (usd) => {
          if (usd <= 0) return;
          spentToday += usd;
          void this.mutate(monitor.id, (latest) => ({ ...latest, spend: addSpend(latest.spend, usd, this.now()) }));
        },
        setConversation: async (conversationId) => {
          await this.mutate(monitor.id, (latest) => ({ ...latest, conversationId }));
        }
      },
      { monitor: { ...monitor }, principal, instruction, matches, runId, signal: controller.signal }
    )
      .then((result) => this.options.log("monitor.task_finished", { monitorId: monitor.id, runId, status: result.status }))
      .catch((error: unknown) => this.options.log("monitor.task_failed", { monitorId: monitor.id, runId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => this.tasks.delete(runId));
    return { kind: "task", status: "started" };
  }

  /** Before each model round of a task: the monitor's daily budget, then the owner's budgets. Returns the round's estimate. */
  private checkTaskBudget(monitor: MonitorRecord, model: string, spentToday: number): number {
    const estimateUsd = estimateTurnUsd(this.options.meter, "brain", model, this.brain?.catalog?.());
    const daily = monitor.budget?.dailyUsd;
    if (daily !== undefined && spentToday + estimateUsd > daily) {
      throw new Error(`The monitor's daily budget (${formatUsd(daily)}) is used up.`);
    }
    const decision = this.options.meter.check({ ownerId: monitor.ownerId, estimateUsd });
    if (!decision.allowed) throw new Error(decision.message);
    return estimateUsd;
  }

  /* ───────────── people ───────────── */

  /** The creator's current access (undefined user or no access → why). */
  creatorPrincipal(monitor: MonitorRecord): Promise<Principal | string> {
    return actingPrincipal(this.options.store, monitor.ownerId, {
      createdBy: monitor.createdBy,
      workspaceId: monitor.workspaceId,
      permission: PERMISSIONS.MONITORS_USE,
      feature: "monitors"
    });
  }

  private creatorOf(principal: Principal): string {
    return principal.kind === "user" && principal.userId ? principal.userId : "owner";
  }

  /** The creator (or the org owner via token/local mode) has full access to a monitor. */
  private isCreator(principal: Principal, monitor: MonitorRecord): boolean {
    if (principal.kind !== "user") return true;
    return principal.userId === monitor.createdBy;
  }

  private isAdmin(principal: Principal, workspaceId: string): boolean {
    return authorize(principal, PERMISSIONS.WORKSPACE_SETTINGS, { workspaceId });
  }

  private require(caller: Caller, permission: typeof PERMISSIONS.MONITORS_USE | typeof PERMISSIONS.MONITORS_MANAGE): void {
    if (!authorize(caller.principal, permission, { workspaceId: caller.workspaceId })) {
      throw new MonitorError(`You don't have permission to do that (${permission}).`, 403, "forbidden");
    }
  }

  private async load(caller: Caller, id: string, access: "creator" | "creator_or_admin" | "view"): Promise<MonitorRecord> {
    const monitor = await this.options.store.monitors.get(this.options.ownerId, id);
    if (!monitor || monitor.workspaceId !== caller.workspaceId) throw new MonitorError("Monitor not found.", 404, "not_found");
    const mine = this.isCreator(caller.principal, monitor);
    const admin = this.isAdmin(caller.principal, caller.workspaceId);
    if (access === "creator" && !mine) throw new MonitorError("Only the person who created this monitor can do that.", 403, "forbidden");
    if (access === "creator_or_admin" && !mine && !admin) throw new MonitorError("Only the creator or a workspace admin can do that.", 403, "forbidden");
    if (access === "view" && !mine && !admin) throw new MonitorError("Monitor not found.", 404, "not_found");
    return monitor;
  }

  /* ───────────── queries ───────────── */

  private askModel(): string | undefined {
    const fromEnv = this.options.env.SIBYL_MONITOR_MODEL?.trim();
    if (fromEnv) return fromEnv;
    return this.brain?.askModel?.() ?? economyModel("brain", this.brain?.catalog?.()) ?? this.brain?.model();
  }

  /** Expected cost of one condition call (never below a small floor, so budgets and estimates stay honest without pricing data). */
  private askUnitUsd(): number {
    return Math.max(MIN_ASK_USD, estimateTurnUsd(this.options.meter, "monitor", this.askModel(), this.brain?.catalog?.()) || 0);
  }

  estimate(monitor: Pick<MonitorRecord, "source" | "schedule" | "condition" | "actions" | "budget">): CostEstimate {
    const taskModel = this.brain?.model();
    const turn = Math.max(MIN_TASK_TURN_USD, estimateTurnUsd(this.options.meter, "brain", taskModel, this.brain?.catalog?.()) || 0);
    return estimateMonthlyCost(monitor, { askUsd: this.askUnitUsd(), taskUsd: turn * TASK_ROUNDS_ESTIMATE });
  }

  private view(monitor: MonitorRecord, principal: Principal): MonitorView {
    return toMonitorView(monitor, {
      mine: this.isCreator(principal, monitor),
      running: this.checking.has(monitor.id),
      now: this.now(),
      estimate: this.estimate(monitor)
    });
  }

  /** Monitors the caller may see in the workspace: their own, plus everyone's for admins. */
  async visible(caller: Caller): Promise<MonitorRecord[]> {
    const all = await this.options.store.monitors.list(this.options.ownerId, { workspaceId: caller.workspaceId });
    const admin = this.isAdmin(caller.principal, caller.workspaceId);
    return all.filter((monitor) => admin || this.isCreator(caller.principal, monitor)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(caller: Caller): Promise<MonitorsListResponse> {
    this.require(caller, PERMISSIONS.MONITORS_USE);
    const monitors = (await this.visible(caller)).map((monitor) => this.view(monitor, caller.principal));
    return { monitors, sources: this.sourceOptions(), channels: await this.channelOptions(caller) };
  }

  /** Read tools that can be watched (connectors and MCP read tools appear automatically). */
  sourceOptions(): MonitorSourceOption[] {
    return this.options.tools
      .list({ enabledOnly: true })
      .filter((tool) => tool.effect === "read" && !this.excluded.has(tool.name))
      .map((tool) => ({
        toolName: tool.name,
        title: tool.title,
        description: tool.description.slice(0, 300),
        source: String(tool.source),
        ...(tool.provider ? { provider: tool.provider } : {}),
        inputSchema: tool.inputSchema
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async channelOptions(caller: Caller): Promise<MonitorChannelOption[]> {
    const { notifications } = this.options;
    return notifications.channelOptions({ workspaceId: caller.workspaceId, recipient: notifications.recipientFor(caller.principal) });
  }

  async statuses(caller: Caller): Promise<MonitorStatusView[]> {
    this.require(caller, PERMISSIONS.MONITORS_USE);
    const now = this.now();
    return (await this.visible(caller)).map((monitor) => toStatusView(monitor, this.checking.has(monitor.id), now));
  }

  /** The caller's own events (newest first). */
  async events(caller: Caller, query: { monitorId?: string; before?: number; limit: number }): Promise<MonitorEventView[]> {
    this.require(caller, PERMISSIONS.MONITORS_USE);
    if (query.monitorId) await this.load(caller, query.monitorId, "creator");
    const records = await this.options.store.monitors.listEvents(this.options.ownerId, {
      workspaceId: caller.workspaceId,
      ...(caller.principal.kind === "user" ? { createdBy: this.creatorOf(caller.principal) } : {}),
      ...(query.monitorId ? { monitorId: query.monitorId } : {}),
      ...(query.before !== undefined ? { before: query.before } : {}),
      limit: query.limit
    });
    const monitors = new Map((await this.options.store.monitors.list(this.options.ownerId, { workspaceId: caller.workspaceId })).map((m) => [m.id, m]));
    return records.map((event) => toEventView(event, monitors.get(event.monitorId)));
  }

  /** Find one of the caller's monitors by id or exact name (chat tools). */
  async resolve(caller: Caller, ref: string): Promise<MonitorRecord> {
    const all = await this.visible(caller);
    const byId = all.find((monitor) => monitor.id === ref.trim());
    if (byId) return byId;
    const byName = all.filter((monitor) => monitor.name.toLowerCase() === ref.trim().toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw new MonitorError(`Several monitors are called "${ref}"; use the id from list_monitors.`);
    throw new MonitorError(`No monitor "${ref}". Use list_monitors to see them.`, 404, "not_found");
  }

  /* ───────────── changes ───────────── */

  /** Semantic checks beyond the protocol parser (tool exists and reads, public URL, channels, agent). */
  async validate(caller: Caller, input: MonitorInput): Promise<void> {
    const source = input.source;
    if (source.kind === "tool") {
      const problem = sourceToolProblem(this.options.tools, this.excluded, source.toolName);
      if (problem) throw new MonitorError(problem);
    } else if (source.kind === "rss" || source.kind === "webpage") {
      try {
        await assertPublicUrl(source.url, this.options.resolveHost ?? defaultResolveHost);
      } catch (error) {
        throw new MonitorError(`That address can't be watched: ${error instanceof Error ? error.message : String(error)}.`);
      }
    } else if (source.kind === "webhook" && source.secretRef) {
      const vault = this.options.vault?.();
      if (!vault) throw new MonitorError("Webhook monitors need the secrets vault (SIBYL_SECRET_KEY).", 503, "unavailable");
      if (!(await vault.has(this.options.ownerId, source.secretRef))) throw new MonitorError(`There is no secret named ${source.secretRef}.`);
    }
    const channels = await this.channelOptions(caller);
    for (const action of input.actions) {
      if (action.kind !== "notify") continue;
      for (const channel of action.channels) {
        const option = channels.find((c) => c.channel === channel);
        if (!option?.available) throw new MonitorError(option?.reason ?? `${channel} isn't available.`);
      }
    }
    if (input.agentId && this.agents && !(await this.agents.get(caller.principal, caller.workspaceId, input.agentId))) {
      throw new MonitorError("That agent doesn't exist or you can't use it.");
    }
  }

  async create(caller: Caller, input: MonitorInput): Promise<MonitorSaveResponse> {
    this.require(caller, PERMISSIONS.MONITORS_MANAGE);
    await this.validate(caller, input);
    const createdBy = this.creatorOf(caller.principal);
    const mine = (await this.options.store.monitors.list(this.options.ownerId)).filter((monitor) => monitor.createdBy === createdBy);
    if (mine.length >= MAX_MONITORS_PER_PERSON) throw new MonitorError(`You have ${MAX_MONITORS_PER_PERSON} monitors already; delete one first.`, 409, "limit");
    const id = this.createId();
    let secret: { secretRef: string; secret?: string } | undefined;
    if (input.source.kind === "webhook") secret = await this.webhookSecret(id, input.name, input.source.secretRef);
    const record = createMonitorRecord(input, {
      id,
      ownerId: this.options.ownerId,
      workspaceId: caller.workspaceId,
      createdBy,
      now: this.now(),
      ...(secret ? { secretRef: secret.secretRef } : {})
    });
    await this.options.store.monitors.upsert(record);
    this.options.log("monitor.created", { monitorId: id, source: record.source.kind, everyMinutes: record.schedule.everyMinutes });
    this.broadcastStatus(record);
    void this.options.routines?.scheduler?.tick();
    return {
      monitor: this.view(record, caller.principal),
      ...(secret ? { webhook: { path: hookPath(id, this.options.ownerId), secretRef: secret.secretRef, ...(secret.secret ? { secret: secret.secret } : {}) } } : {})
    };
  }

  async update(caller: Caller, id: string, input: MonitorInput): Promise<MonitorSaveResponse> {
    this.require(caller, PERMISSIONS.MONITORS_MANAGE);
    const existing = await this.load(caller, id, "creator");
    await this.validate(caller, input);
    let secret: { secretRef: string; secret?: string } | undefined;
    if (input.source.kind === "webhook" && !input.source.secretRef && existing.source.kind !== "webhook") {
      secret = await this.webhookSecret(id, input.name, undefined);
    }
    const next = await this.mutate(id, (latest) => {
      const applied = applyMonitorInput(latest, secret ? { ...input, source: { kind: "webhook", secretRef: secret.secretRef } } : input, this.now());
      return applied;
    });
    if (!next) throw new MonitorError("Monitor not found.", 404, "not_found");
    if (!next.enabled) this.options.routines?.scheduler?.cancelJob(MONITOR_JOB_KIND, id);
    this.broadcastStatus(next);
    return {
      monitor: this.view(next, caller.principal),
      ...(next.source.kind === "webhook" ? { webhook: { path: hookPath(id, this.options.ownerId), secretRef: next.source.secretRef, ...(secret?.secret ? { secret: secret.secret } : {}) } } : {})
    };
  }

  async pause(caller: Caller, id: string, paused: boolean): Promise<MonitorView> {
    this.require(caller, PERMISSIONS.MONITORS_MANAGE);
    await this.load(caller, id, paused ? "creator_or_admin" : "creator");
    const next = await this.mutate(id, (latest) => setPaused(latest, paused, this.now()));
    if (!next) throw new MonitorError("Monitor not found.", 404, "not_found");
    if (paused) this.options.routines?.scheduler?.cancelJob(MONITOR_JOB_KIND, id);
    else void this.options.routines?.scheduler?.tick();
    this.broadcastStatus(next);
    return this.view(next, caller.principal);
  }

  async remove(caller: Caller, id: string): Promise<void> {
    this.require(caller, PERMISSIONS.MONITORS_MANAGE);
    const monitor = await this.load(caller, id, "creator_or_admin");
    this.options.routines?.scheduler?.cancelJob(MONITOR_JOB_KIND, id);
    await this.options.store.monitors.remove(this.options.ownerId, id);
    if (monitor.source.kind === "webhook" && monitor.source.secretRef === autoSecretName(id)) {
      await this.options.vault?.()?.delete(this.options.ownerId, monitor.source.secretRef).catch(() => undefined);
    }
    this.options.log("monitor.deleted", { monitorId: id });
  }

  async runNow(caller: Caller, id: string): Promise<void> {
    this.require(caller, PERMISSIONS.MONITORS_MANAGE);
    const monitor = await this.load(caller, id, "creator");
    if (monitor.source.kind === "webhook") throw new MonitorError("Webhook monitors run when a delivery arrives.");
    if (!monitor.enabled) throw new MonitorError("Resume the monitor first.", 409, "paused");
    const scheduler = this.options.routines?.scheduler;
    if (scheduler) {
      const error = await scheduler.runJobNow(MONITOR_JOB_KIND, id);
      if (error) throw new MonitorError(error, 409, "busy");
      return;
    }
    // No scheduler (no model configured yet): run once here, with the same lease rules.
    const claimed = await this.jobType.claim(monitor, this.now(), this.now() + 5 * MINUTE);
    if (!claimed) throw new MonitorError("It is already running.", 409, "busy");
    void this.runCheck(id, new AbortController().signal).finally(() => void this.jobType.release(claimed));
  }

  /** Dry run: what would fire now. Nothing is saved, nobody is notified, no task starts. */
  async test(caller: Caller, target: { id: string } | { input: MonitorInput }): Promise<MonitorTestResult> {
    this.require(caller, PERMISSIONS.MONITORS_MANAGE);
    let monitor: MonitorRecord;
    if ("id" in target) {
      monitor = await this.load(caller, target.id, "creator");
    } else {
      await this.validate(caller, target.input);
      monitor = createMonitorRecord(target.input, {
        id: "test",
        ownerId: this.options.ownerId,
        workspaceId: caller.workspaceId,
        createdBy: this.creatorOf(caller.principal),
        now: this.now(),
        secretRef: "TEST"
      });
    }
    const empty = { fetched: 0, newItems: 0, candidates: 0, matches: [], costUsd: 0 };
    if (monitor.source.kind === "webhook") {
      return { ok: false, ...empty, summary: "Webhook monitors run when a delivery arrives.", error: `Send a signed test delivery to ${hookPath(monitor.id, monitor.ownerId)} instead.` };
    }
    const checkId = this.createId();
    let cost = 0;
    const meter = this.monitorMeter(monitor.id, (usd) => (cost += usd));
    const signal = AbortSignal.timeout(60_000);
    try {
      const raw = await fetchSource(monitor, {
        tools: this.options.tools,
        excludeTools: this.excluded,
        store: this.options.store,
        meter,
        principal: caller.principal,
        runId: checkId,
        signal,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.resolveHost ? { resolveHost: this.options.resolveHost } : {}),
        log: this.options.log
      });
      const evaluation = await this.evaluateWith(monitor, raw, "test", signal, checkId, () => cost, (usd) => (cost += usd));
      if (monitor.id !== "test" && cost > 0) {
        const now = this.now();
        await this.mutate(monitor.id, (latest) => ({ ...latest, spend: addSpend(latest.spend, cost, now) }));
      }
      const notes = [
        evaluation.askSkipped,
        evaluation.deferred > 0 && !evaluation.askSkipped ? `Only the first ${MAX_ASK_ITEMS} items were checked against your condition.` : undefined,
        monitor.id === "test" ? "When saved, the first check only records what's there; you hear about what's new after that." : undefined
      ].filter(Boolean);
      return {
        ok: true,
        fetched: evaluation.fetched,
        newItems: evaluation.newItems,
        candidates: evaluation.candidates,
        matches: evaluation.matches.slice(0, MAX_EVENT_ITEMS).map((match) => ({
          key: match.item.key,
          title: match.item.title,
          ...(match.item.url ? { url: match.item.url } : {}),
          ...(match.reason ? { reason: match.reason } : {})
        })),
        summary:
          evaluation.matches.length === 0
            ? `Fetched ${evaluation.fetched} item${evaluation.fetched === 1 ? "" : "s"}; none match right now.`
            : `${evaluation.matches.length} of ${evaluation.fetched} items would fire.`,
        costUsd: cost,
        ...(notes.length ? { note: notes.join(" ") } : {})
      };
    } catch (error) {
      return { ok: false, ...empty, costUsd: cost, summary: "The test failed.", error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }

  private async webhookSecret(id: string, name: string, existing: string | undefined): Promise<{ secretRef: string; secret?: string }> {
    if (existing) return { secretRef: existing };
    const vault = this.options.vault?.();
    if (!vault) throw new MonitorError("Webhook monitors need the secrets vault (SIBYL_SECRET_KEY).", 503, "unavailable");
    const secretRef = autoSecretName(id);
    const secret = randomBytes(32).toString("hex");
    await vault.set(this.options.ownerId, {
      name: secretRef,
      value: secret,
      service: "Sibyl monitor webhook",
      description: `Signs deliveries to the monitor “${name}”.`.slice(0, 500),
      allowedHosts: ["local"]
    });
    return { secretRef, secret };
  }

  /* ───────────── webhooks ───────────── */

  /**
   * A webhook delivery. Answers fast (202) and processes in the background,
   * one delivery at a time per monitor.
   */
  async receiveWebhook(id: string, body: Buffer, signature: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const monitor = await this.options.store.monitors.get(this.options.ownerId, id);
    if (!monitor || monitor.source.kind !== "webhook") return { status: 404, body: { error: "not_found" } };
    const vault = this.options.vault?.();
    let key: string;
    try {
      if (!vault) throw new Error("no vault");
      key = await vault.resolve(this.options.ownerId, monitor.source.secretRef, { host: undefined });
    } catch {
      return { status: 503, body: { error: "secret_unavailable", message: "The monitor's signing secret is missing." } };
    }
    if (!verifySignature(key, body, signature)) return { status: 401, body: { error: "bad_signature" } };
    if (!monitor.enabled) return { status: 409, body: { error: "paused", message: "This monitor is paused." } };
    const now = this.now();
    const hits = (this.hookHits.get(id) ?? []).filter((at) => at > now - MINUTE);
    if (hits.length >= WEBHOOK_PER_MINUTE) return { status: 429, body: { error: "rate_limited" } };
    hits.push(now);
    this.hookHits.set(id, hits);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8") || "null");
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    const raw = parseWebhookBody(parsed);
    const key2 = `hook:${id}`;
    const previous = this.locks.get(key2) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (this.stopped) return;
      const latest = await this.options.store.monitors.get(this.options.ownerId, id);
      if (!latest?.enabled) return;
      this.checking.add(id);
      this.broadcastStatus(latest);
      try {
        await this.process(latest, "webhook", AbortSignal.timeout(5 * MINUTE), async () => raw);
      } finally {
        this.checking.delete(id);
        const after = await this.options.store.monitors.get(this.options.ownerId, id).catch(() => undefined);
        if (after) this.broadcastStatus(after);
      }
    });
    const settled = run.catch((error: unknown) => this.options.log("monitor.webhook_failed", { monitorId: id, error: error instanceof Error ? error.message : String(error) }));
    this.locks.set(key2, settled);
    void settled.then(() => {
      if (this.locks.get(key2) === settled) this.locks.delete(key2);
    });
    return { status: 202, body: { accepted: true, items: raw.length } };
  }

  /** Resolves when queued webhook deliveries have been processed (tests). */
  async idle(): Promise<void> {
    while (this.locks.size > 0) await Promise.allSettled([...this.locks.values()]);
  }

  /* ───────────── live updates ───────────── */

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private broadcastStatus(monitor: MonitorRecord): void {
    if (this.subscribers.size === 0) return;
    const status = toStatusView(monitor, this.checking.has(monitor.id), this.now());
    for (const subscriber of this.subscribers) {
      try {
        const principal = subscriber.principal();
        if (subscriber.workspaceId() !== monitor.workspaceId) continue;
        if (!authorize(principal, PERMISSIONS.MONITORS_USE, { workspaceId: monitor.workspaceId })) continue;
        if (!this.isCreator(principal, monitor) && !this.isAdmin(principal, monitor.workspaceId)) continue;
        subscriber.send({ type: MONITOR_EVENTS.STATUS, status });
      } catch {
        // A closing socket; it unsubscribes on close.
      }
    }
  }
}

/** Notification body: what matched (with links and reasons) and which monitor. */
function eventBody(monitor: MonitorRecord, event: MonitorEventRecord): string {
  const items = event.items.map((item) => `- ${item.title}${item.url ? `\n  ${item.url}` : ""}${item.reason ? `\n  Why: ${item.reason}` : ""}`);
  return [...(event.kind === "paused" ? [] : items), ...(items.length > 0 && event.kind !== "paused" ? [""] : []), `Monitor: ${monitor.name}`].join("\n");
}

export function autoSecretName(monitorId: string): string {
  return `MONITOR_HOOK_${monitorId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 48)}`;
}

/** `x-sibyl-signature: sha256=<hex>` (or the bare hex) = HMAC-SHA256(secret, raw body). */
export function signBody(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(given, "hex"), expected);
}
