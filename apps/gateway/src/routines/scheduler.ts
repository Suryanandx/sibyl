/**
 * The routine scheduler: one in-process worker (SIBYL_ROUTINES=false turns it
 * off).
 *
 * - Ticks every 30 s; runs routines whose nextRunAt has passed, then moves
 *   nextRunAt to the next cron time after now (missed runs while the gateway
 *   was down collapse into one run).
 * - Each run holds a lease (`leaseUntil`) renewed by a heartbeat while it is
 *   running or waiting for an approval. A run whose lease expired without an
 *   active worker (crash, restart) is marked `interrupted`; this happens on
 *   start and on every tick.
 * - No double runs: a routine with an active run (in memory, or a live lease
 *   in the store) is skipped for that slot.
 * - A transient failure (network, rate limit, 5xx) is retried once after a
 *   back-off, within the same run.
 * - At most `maxConcurrency` (2) runs at a time; extra due routines wait for
 *   the next tick, manual "run now" requests queue.
 * - Other job types (monitors) plug into the same tick and lease machinery
 *   with `addJobType()`: each type says what is due, claims a job with a
 *   lease, runs it with a heartbeat and releases it. Job types have their own
 *   concurrency, so they never hold up routines.
 */
import type { RoutineRecord, RoutineRunRecord, ScheduledJob, ScheduledJobType, Store } from "@open-gpt-live/core";
import { nextRun } from "./cron.js";
import { formatUsd } from "./records.js";
import type { RoutineRunner, RunHandle, RunOutcome } from "./runner.js";

/**
 * A routine run's outcome, handed to the routine service, which publishes it
 * through the notifications module (it is never sent to browsers as is).
 */
export interface RoutineOutcome {
  /** "agent_action": an agent ran a write action on its own ("act, then tell me"). */
  kind: "finished" | "failed" | "budget_blocked" | "needs_approval" | "interrupted" | "agent_action";
  routineId: string;
  routineName: string;
  runId: string;
  /** One human sentence. */
  message: string;
  conversationId?: string;
  approvalId?: string;
  costUsd?: number;
  /** The agent that acted (kind "agent_action", or a routine run as an agent). */
  agentId?: string;
  at: number;
}

export const TICK_MS = 30_000;
export const LEASE_MS = 5 * 60_000;
export const HEARTBEAT_MS = 60_000;
export const RETRY_DELAY_MS = 60_000;
export const MAX_CONCURRENCY = 2;

type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface SchedulerOptions {
  store: Store;
  ownerId: string;
  runner: RoutineRunner;
  createId(): string;
  now?(): number;
  log?: Log;
  tickMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryDelayMs?: number;
  maxConcurrency?: number;
  /** Abortable wait (tests replace it). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Runs or routines changed (refresh the browser's list). */
  onChange?(): void;
  /** false: don't run routines, only the other job types (default true). */
  routines?: boolean;
  /** false: no timer of its own; someone else calls tick() (hosted: the tenant registry's one loop). */
  selfTick?: boolean;
  notify?(notification: RoutineOutcome): void;
  /** An approval of a run that no longer exists should be expired. */
  expireOrphanApproval?(approvalId: string): Promise<void>;
}

/** Job types (e.g. one monitor check) live in core so enterprise modules can add them too. */
export type { ScheduledJob, ScheduledJobType } from "@open-gpt-live/core";

interface ActiveJob {
  controller: AbortController;
  done: Promise<void>;
}

interface ActiveRun {
  run: RoutineRunRecord;
  controller: AbortController;
  done: Promise<void>;
}

const LIVE_STATUSES = new Set<RoutineRunRecord["status"]>(["running", "awaiting_approval"]);

export class RoutineScheduler {
  private readonly active = new Map<string, ActiveRun>();
  private readonly manual: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = true;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly tickMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly retryDelayMs: number;
  private readonly maxConcurrency: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly jobTypes = new Map<string, ScheduledJobType<any>>();
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly manualJobs: Array<{ kind: string; id: string }> = [];

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.tickMs = options.tickMs ?? TICK_MS;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
    this.sleep = options.sleep ?? abortableSleep;
  }

  /** Recover interrupted runs, then tick every 30 s. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.recover();
    await this.backfillNextRuns();
    if (this.options.selfTick !== false) {
      this.timer = setInterval(() => void this.tick(), this.tickMs);
      this.timer.unref?.();
    }
    void this.tick();
  }

  /** Stop ticking and interrupt active runs (waits for them to settle). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const runs = [...this.active.values(), ...this.activeJobs.values()];
    for (const active of runs) active.controller.abort("shutdown");
    await Promise.race([
      Promise.allSettled(runs.map((active) => active.done)),
      new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())
    ]);
  }

  /** A run or job is in progress or queued (its organization is not idle). */
  busy(): boolean {
    return this.active.size > 0 || this.activeJobs.size > 0 || this.manual.length > 0 || this.manualJobs.length > 0;
  }

  isRunning(routineId: string): boolean {
    return this.active.has(routineId);
  }

  /* ── other job types ── */

  /** Register another job type (before or after start). */
  addJobType(type: ScheduledJobType<any>): void {
    if (this.jobTypes.has(type.kind)) throw new Error(`Job type already registered: ${type.kind}`);
    this.jobTypes.set(type.kind, type);
    if (!this.stopped) void this.tick();
  }

  isJobRunning(kind: string, id: string): boolean {
    return this.activeJobs.has(jobKey(kind, id));
  }

  /** Queue a job to run now. Returns an error message when it cannot. */
  async runJobNow(kind: string, id: string): Promise<string | undefined> {
    const type = this.jobTypes.get(kind);
    if (!type?.get) return "That can't be run now.";
    if (!(await type.get(id))) return "Not found.";
    if (this.activeJobs.has(jobKey(kind, id)) || this.manualJobs.some((job) => job.kind === kind && job.id === id)) return "It is already running.";
    this.manualJobs.push({ kind, id });
    void this.tick();
    return undefined;
  }

  /** Abort a job's active run (e.g. it was deleted or paused). */
  cancelJob(kind: string, id: string): void {
    this.activeJobs.get(jobKey(kind, id))?.controller.abort("cancelled");
    const queued = this.manualJobs.findIndex((job) => job.kind === kind && job.id === id);
    if (queued >= 0) this.manualJobs.splice(queued, 1);
  }

  /** Active run id per routine (for orphan detection). */
  activeRunIds(): Set<string> {
    return new Set([...this.active.values()].map((active) => active.run.id));
  }

  /** Queue a manual run. Returns an error message when it cannot run. */
  async runNow(routineId: string): Promise<string | undefined> {
    const routine = await this.options.store.routines.get(this.options.ownerId, routineId);
    if (!routine) return "Routine not found.";
    if (this.active.has(routineId) || this.manual.includes(routineId)) return `“${routine.name}” is already running.`;
    if (await this.hasLiveLease(routine)) return `“${routine.name}” is already running.`;
    this.manual.push(routineId);
    void this.tick();
    return undefined;
  }

  /** Abort a routine's active run (e.g. it was deleted). */
  cancel(routineId: string): void {
    this.active.get(routineId)?.controller.abort("cancelled");
    const queued = this.manual.indexOf(routineId);
    if (queued >= 0) this.manual.splice(queued, 1);
  }

  /** One scheduling pass (exposed for tests). Concurrent calls share a pass. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.ticking ??= this.pass().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /** Resolves when all runs started so far have finished (tests). */
  async idle(): Promise<void> {
    while (this.active.size > 0 || this.activeJobs.size > 0 || this.ticking) {
      await Promise.allSettled([...this.active.values(), ...this.activeJobs.values()].map((active) => active.done));
      if (this.ticking) await this.ticking;
    }
  }

  private async pass(): Promise<void> {
    try {
      await this.recover();
      // Manual runs first: the user is waiting for them.
      while (this.manual.length > 0 && this.active.size < this.maxConcurrency) {
        const routineId = this.manual.shift()!;
        const routine = await this.options.store.routines.get(this.options.ownerId, routineId);
        if (routine && !this.active.has(routineId)) await this.begin(routine, false);
      }
      const now = this.now();
      // routines: false runs only the other job types (SIBYL_ROUTINES=false with monitors on).
      const due = (this.options.routines === false ? [] : await this.options.store.routines.due(now))
        .filter((routine) => routine.ownerId === this.options.ownerId)
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
      for (const routine of due) {
        if (this.stopped) return;
        if (this.active.has(routine.id) || (await this.hasLiveLease(routine))) {
          // Still running from an earlier slot: skip this one.
          await this.advance(routine, now, false);
          this.log("routine.skipped_overlap", { routineId: routine.id });
          continue;
        }
        if (this.active.size >= this.maxConcurrency) break; // stays due; next tick
        await this.begin(routine, true);
      }
    } catch (error) {
      this.log("routine.tick_failed", { error: errorMessage(error) });
    }
    for (const type of this.jobTypes.values()) {
      if (this.stopped) return;
      try {
        await this.passJobs(type);
      } catch (error) {
        this.log("scheduler.job_tick_failed", { kind: type.kind, error: errorMessage(error) });
      }
    }
  }

  private activeJobIds(kind: string): Set<string> {
    const prefix = jobKey(kind, "");
    return new Set([...this.activeJobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
  }

  private async passJobs(type: ScheduledJobType<any>): Promise<void> {
    const limit = type.maxConcurrency ?? MAX_CONCURRENCY;
    await type.recover?.(this.now(), this.activeJobIds(type.kind));
    // Manual "run now" first: someone is waiting for it.
    for (let index = 0; index < this.manualJobs.length && this.activeJobIds(type.kind).size < limit; ) {
      const queued = this.manualJobs[index]!;
      if (queued.kind !== type.kind) {
        index += 1;
        continue;
      }
      this.manualJobs.splice(index, 1);
      const job = await type.get?.(queued.id);
      if (job && !this.activeJobs.has(jobKey(type.kind, job.id))) await this.beginJob(type, job);
    }
    for (const job of await type.due(this.now())) {
      if (this.stopped) return;
      if (this.activeJobs.has(jobKey(type.kind, job.id))) continue;
      if (this.activeJobIds(type.kind).size >= limit) break; // stays due; next tick
      await this.beginJob(type, job);
    }
  }

  private async beginJob(type: ScheduledJobType<any>, job: ScheduledJob): Promise<void> {
    const now = this.now();
    const claimed: ScheduledJob | undefined = await type.claim(job, now, now + this.leaseMs);
    if (!claimed) return;
    const key = jobKey(type.kind, claimed.id);
    const controller = new AbortController();
    const entry: ActiveJob = { controller, done: Promise.resolve() };
    this.activeJobs.set(key, entry);
    this.log("scheduler.job_started", { kind: type.kind, id: claimed.id });
    const heartbeat = setInterval(() => {
      type.renew(claimed, this.now() + this.leaseMs).catch((error: unknown) => {
        this.log("scheduler.job_renew_failed", { kind: type.kind, id: claimed.id, error: errorMessage(error) });
      });
    }, this.heartbeatMs);
    heartbeat.unref?.();
    entry.done = (async () => {
      try {
        await type.run(claimed, controller.signal);
      } catch (error) {
        this.log("scheduler.job_failed", { kind: type.kind, id: claimed.id, error: errorMessage(error) });
      } finally {
        clearInterval(heartbeat);
        await type.release(claimed).catch((error: unknown) => {
          this.log("scheduler.job_release_failed", { kind: type.kind, id: claimed.id, error: errorMessage(error) });
        });
      }
    })().finally(() => {
      this.activeJobs.delete(key);
      // A slot freed up: queued or waiting jobs can start.
      if (!this.stopped) void this.tick();
    });
  }

  /** Move nextRunAt past now (and record lastRunAt when a run starts). */
  private async advance(routine: RoutineRecord, now: number, started: boolean): Promise<RoutineRecord> {
    const latest = (await this.options.store.routines.get(routine.ownerId, routine.id)) ?? routine;
    // A one-time task pauses itself once its run starts.
    const finished = started && latest.once === true;
    const next = latest.enabled && !finished ? safeNextRun(latest, now) : undefined;
    const updated: RoutineRecord = { ...latest, ...(started ? { lastRunAt: now } : {}), ...(finished ? { enabled: false } : {}) };
    if (next === undefined) delete updated.nextRunAt;
    else updated.nextRunAt = next;
    await this.options.store.routines.upsert(updated);
    return updated;
  }

  private async begin(routine: RoutineRecord, scheduled: boolean): Promise<void> {
    const now = this.now();
    const current = scheduled
      ? await this.advance(routine, now, true)
      : await this.options.store.routines.get(routine.ownerId, routine.id).then(async (latest) => {
          const base = latest ?? routine;
          const updated = { ...base, lastRunAt: now };
          await this.options.store.routines.upsert(updated);
          return updated;
        });
    const run: RoutineRunRecord = {
      id: this.options.createId(),
      routineId: current.id,
      ownerId: current.ownerId,
      status: "running",
      startedAt: now,
      costUsd: 0,
      leaseUntil: now + this.leaseMs
    };
    await this.options.store.routines.insertRun(run);
    const controller = new AbortController();
    const active: ActiveRun = { run, controller, done: Promise.resolve() };
    this.active.set(current.id, active);
    this.log("routine.run_started", { routineId: current.id, runId: run.id, manual: !scheduled });
    this.options.onChange?.();
    active.done = this.execute(current, active).finally(() => {
      this.active.delete(current.id);
      this.options.onChange?.();
      // A slot freed up: queued manual runs or waiting due routines can start.
      if (!this.stopped && (this.manual.length > 0 || this.active.size < this.maxConcurrency)) void this.tick();
    });
  }

  private async execute(routine: RoutineRecord, active: ActiveRun): Promise<void> {
    const { run, controller } = active;
    let saving = Promise.resolve();
    const save = (): Promise<void> => {
      const snapshot = { ...run };
      saving = saving
        .then(() => this.options.store.routines.updateRun(snapshot))
        .catch((error: unknown) => this.log("routine.run_save_failed", { runId: run.id, error: errorMessage(error) }));
      return saving;
    };
    const heartbeat = setInterval(() => {
      run.leaseUntil = this.now() + this.leaseMs;
      void save();
    }, this.heartbeatMs);
    heartbeat.unref?.();

    let outcome: RunOutcome = { status: "failed", error: "The run did not start." };
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const handle: RunHandle = {
          run,
          lastAttempt: attempt === 2,
          setStatus: async (status) => {
            run.status = status;
            run.leaseUntil = this.now() + this.leaseMs;
            await save();
            this.options.onChange?.();
          },
          addCost: (usd) => {
            run.costUsd += usd;
          }
        };
        try {
          outcome = await this.options.runner(routine, handle, controller.signal);
        } catch (error) {
          outcome = controller.signal.aborted
            ? { status: "interrupted", error: "The run was stopped." }
            : { status: "failed", error: errorMessage(error) };
        }
        if (outcome.status === "failed" && outcome.transient && attempt === 1 && !controller.signal.aborted) {
          this.log("routine.retrying", { routineId: routine.id, runId: run.id, error: outcome.error });
          run.status = "running";
          await save();
          try {
            await this.sleep(this.retryDelayMs, controller.signal);
          } catch {
            outcome = { status: "interrupted", error: "The run was stopped." };
            break;
          }
          continue;
        }
        break;
      }
    } finally {
      clearInterval(heartbeat);
    }

    run.status = outcome.status;
    run.finishedAt = this.now();
    delete run.leaseUntil;
    if (outcome.summary) run.summary = outcome.summary;
    if (outcome.error) run.error = outcome.error;
    await save();
    this.log("routine.run_finished", { routineId: routine.id, runId: run.id, status: run.status, costUsd: run.costUsd });
    this.options.notify?.(finishedNotification(routine, run, this.now()));
  }

  /** Runs with an expired lease and no worker → interrupted; orphan approvals expire. */
  private async recover(): Promise<void> {
    const { store, ownerId } = this.options;
    const now = this.now();
    const activeIds = this.activeRunIds();
    const routines = await store.routines.list(ownerId);
    let changed = false;
    for (const routine of routines) {
      for (const run of await store.routines.listRuns(ownerId, routine.id, 10)) {
        if (!LIVE_STATUSES.has(run.status) || activeIds.has(run.id)) continue;
        if ((run.leaseUntil ?? 0) > now) continue;
        await store.routines.updateRun({
          ...run,
          status: "interrupted",
          finishedAt: now,
          error: "Sibyl stopped while this run was in progress.",
          leaseUntil: undefined
        });
        changed = true;
        this.log("routine.run_interrupted", { routineId: routine.id, runId: run.id });
      }
    }
    if (this.options.expireOrphanApproval) {
      const liveRunIds = new Set(activeIds);
      // Approvals of other job types (e.g. monitor tasks) are theirs to keep alive.
      for (const type of this.jobTypes.values()) for (const id of type.liveRunIds?.() ?? []) liveRunIds.add(id);
      for (const routine of routines) {
        for (const run of await store.routines.listRuns(ownerId, routine.id, 10)) {
          if (LIVE_STATUSES.has(run.status)) liveRunIds.add(run.id);
        }
      }
      for (const approval of await store.approvals.listPending(ownerId)) {
        if (approval.routineId && !liveRunIds.has(approval.runId)) {
          await this.options.expireOrphanApproval(approval.id);
          changed = true;
        }
      }
    }
    if (changed) this.options.onChange?.();
  }

  /** Enabled routines without a nextRunAt (e.g. created by an older build) get one. */
  private async backfillNextRuns(): Promise<void> {
    const now = this.now();
    for (const routine of await this.options.store.routines.list(this.options.ownerId)) {
      if (routine.enabled && routine.nextRunAt === undefined) {
        const next = safeNextRun(routine, now);
        if (next !== undefined) await this.options.store.routines.upsert({ ...routine, nextRunAt: next });
      }
    }
  }

  private async hasLiveLease(routine: RoutineRecord): Promise<boolean> {
    const now = this.now();
    const runs = await this.options.store.routines.listRuns(routine.ownerId, routine.id, 5);
    return runs.some((run) => LIVE_STATUSES.has(run.status) && (run.leaseUntil ?? 0) > now);
  }
}

function jobKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

function safeNextRun(routine: RoutineRecord, after: number): number | undefined {
  try {
    return nextRun(routine.cron, routine.timezone, after);
  } catch {
    return undefined;
  }
}

function finishedNotification(routine: RoutineRecord, run: RoutineRunRecord, at: number): RoutineOutcome {
  const kind: RoutineOutcome["kind"] =
    run.status === "succeeded" ? "finished" : run.status === "budget_blocked" ? "budget_blocked" : run.status === "interrupted" ? "interrupted" : "failed";
  const cost = run.costUsd > 0 ? ` (${formatUsd(run.costUsd)})` : "";
  const message =
    kind === "finished"
      ? `“${routine.name}” finished${cost}.`
      : kind === "budget_blocked"
        ? `“${routine.name}” stopped at its budget. ${run.error ?? ""}`.trim()
        : kind === "interrupted"
          ? `“${routine.name}” was interrupted.`
          : `“${routine.name}” failed: ${run.error ?? "unknown error"}`;
  return {
    kind,
    routineId: routine.id,
    routineName: routine.name,
    runId: run.id,
    message,
    ...(routine.conversationId ? { conversationId: routine.conversationId } : {}),
    costUsd: run.costUsd,
    at
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
