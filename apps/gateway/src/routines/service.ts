/**
 * Routines as one service on the runtime: chat tools, the approval gate for
 * routine runs, the scheduler (started once a model is known) and the set of
 * connected browsers that get list updates and notifications.
 */
import { randomUUID } from "node:crypto";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import type { RoutineRecord, Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import {
  ROUTINE_EVENTS,
  WS_EVENTS,
  type ApprovalView,
  type ModelCatalog,
  type RoutineNotification,
  type RoutinePatch,
  type RoutineView,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { isValidTimeZone } from "./cron.js";
import { RoutineInputError, applyRoutinePatch, toRoutineView } from "./records.js";
import { RoutineApprovalGate, approvalView, createRoutineRunner } from "./runner.js";
import { RoutineScheduler, type SchedulerOptions } from "./scheduler.js";
import { ROUTINE_TOOL_NAMES, createRoutineTools } from "./tools.js";

export const TIMEZONE_KEY = "routines.timezone";

type Log = (event: string, fields?: Record<string, unknown>) => void;
type Send = (message: ServerMessage) => void;

export interface RoutineServiceOptions {
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: Log;
  createId?(): string;
  now?(): number;
}

export interface SchedulerStartOptions {
  provider: ToolChatProvider | undefined;
  model(): string | undefined;
  systemPrompt: string;
  extraBody?(model: string): Record<string, unknown> | undefined;
  catalog?(): ModelCatalog | undefined;
  /** Test seams for timing. */
  scheduler?: Partial<Pick<SchedulerOptions, "tickMs" | "leaseMs" | "heartbeatMs" | "retryDelayMs" | "maxConcurrency" | "sleep">>;
}

export class RoutineService {
  readonly approvals: RoutineApprovalGate;
  scheduler: RoutineScheduler | undefined;
  private readonly subscribers = new Set<Send>();
  private readonly names = new Map<string, string>();
  private timezone: string;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: RoutineServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.timezone = serverTimeZone(options.env);
    this.approvals = new RoutineApprovalGate({
      store: options.store,
      ownerId: options.ownerId,
      createId: this.createId,
      now: this.now,
      log: options.log,
      onRequested: (view, routine) => {
        this.broadcast({ type: WS_EVENTS.APPROVAL_REQUEST, approval: view });
        this.notify({
          kind: "needs_approval",
          routineId: routine.id,
          routineName: routine.name,
          runId: view.runId,
          approvalId: view.id,
          ...(view.conversationId ? { conversationId: view.conversationId } : {}),
          message: `“${routine.name}” needs your approval: ${view.summary}`,
          at: this.now()
        });
        void this.broadcastInbox();
        this.changed();
      },
      onResolved: (id, status) => {
        this.broadcast({ type: WS_EVENTS.APPROVAL_RESOLVED, id, status });
        void this.broadcastInbox();
      }
    });
  }

  /** Load the saved time zone and the name cache; register the chat tools. */
  async init(): Promise<void> {
    try {
      const saved = await this.options.store.kv.get<string>(this.options.ownerId, TIMEZONE_KEY);
      if (typeof saved === "string" && isValidTimeZone(saved)) this.timezone = saved;
    } catch {
      // Keep the server's zone.
    }
    await this.refreshNames();
    for (const tool of createRoutineTools({
      store: this.options.store,
      meter: this.options.meter,
      createId: this.createId,
      now: this.now,
      timezone: () => this.timezone,
      routineName: (id) => this.names.get(id),
      onChanged: () => this.changed(),
      onDeleted: (id) => this.scheduler?.cancel(id)
    })) {
      this.options.tools.register(tool);
    }
  }

  /** Start the worker unless SIBYL_ROUTINES=false. */
  async startScheduler(input: SchedulerStartOptions): Promise<boolean> {
    if (/^(false|0|no|off)$/i.test(this.options.env.SIBYL_ROUTINES?.trim() ?? "")) {
      this.options.log("routines.disabled", {});
      return false;
    }
    if (this.scheduler) return true;
    const runner = createRoutineRunner({
      store: this.options.store,
      tools: this.options.tools,
      meter: this.options.meter,
      provider: input.provider,
      model: input.model,
      systemPrompt: input.systemPrompt,
      approvals: this.approvals,
      excludeTools: ROUTINE_TOOL_NAMES,
      createId: this.createId,
      now: this.now,
      log: this.options.log,
      ...(input.extraBody ? { extraBody: input.extraBody } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {})
    });
    this.scheduler = new RoutineScheduler({
      store: this.options.store,
      ownerId: this.options.ownerId,
      runner,
      createId: this.createId,
      now: this.now,
      log: this.options.log,
      onChange: () => this.changed(),
      notify: (notification) => this.notify(notification),
      expireOrphanApproval: (id) => this.approvals.expireOrphan(id),
      ...input.scheduler
    });
    await this.scheduler.start();
    this.options.log("routines.scheduler_started", {});
    return true;
  }

  async stop(): Promise<void> {
    this.approvals.dispose();
    await this.scheduler?.stop();
    this.subscribers.clear();
  }

  /* ── browsers ── */

  subscribe(send: Send): () => void {
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  broadcast(message: ServerMessage): void {
    for (const send of this.subscribers) {
      try {
        send(message);
      } catch {
        // A closing socket; it unsubscribes on close.
      }
    }
  }

  notify(notification: RoutineNotification): void {
    this.broadcast({ type: ROUTINE_EVENTS.ROUTINE_NOTIFICATION, notification });
  }

  /** Routines changed: refresh caches and every browser's list. */
  changed(): void {
    void (async () => {
      await this.refreshNames();
      if (this.subscribers.size === 0) return;
      this.broadcast({ type: ROUTINE_EVENTS.ROUTINES_LIST, items: await this.list() });
    })().catch((error: unknown) => this.options.log("routines.broadcast_failed", { error: String(error) }));
  }

  async broadcastInbox(): Promise<void> {
    if (this.subscribers.size === 0) return;
    this.broadcast({ type: ROUTINE_EVENTS.INBOX_LIST, items: await this.inbox() });
  }

  /* ── queries and edits ── */

  getTimezone(): string {
    return this.timezone;
  }

  async setTimezone(timezone: string): Promise<boolean> {
    if (!isValidTimeZone(timezone)) return false;
    if (timezone === this.timezone) return true;
    this.timezone = timezone;
    await this.options.store.kv.set(this.options.ownerId, TIMEZONE_KEY, timezone);
    return true;
  }

  async list(): Promise<RoutineView[]> {
    const { store, ownerId } = this.options;
    const routines = await store.routines.list(ownerId);
    const views = await Promise.all(
      routines.map(async (routine) => {
        const [last] = await store.routines.listRuns(ownerId, routine.id, 1);
        return toRoutineView(routine, last);
      })
    );
    return views.sort((a, b) => a.name.localeCompare(b.name));
  }

  getApproval(id: string) {
    return this.options.store.approvals.get(this.options.ownerId, id);
  }

  /** Pending approvals across chat and routines, oldest first. */
  async inbox(): Promise<ApprovalView[]> {
    const now = this.now();
    const pending = await this.options.store.approvals.listPending(this.options.ownerId);
    return pending.filter((record) => record.expiresAt === undefined || record.expiresAt > now).map((record) => approvalView(record));
  }

  async update(routineId: string, patch: RoutinePatch): Promise<RoutineRecord | string> {
    const routine = await this.options.store.routines.get(this.options.ownerId, routineId);
    if (!routine) return "Routine not found.";
    try {
      const next = applyRoutinePatch(routine, patch, this.now());
      await this.options.store.routines.upsert(next);
      this.changed();
      return next;
    } catch (error) {
      if (error instanceof RoutineInputError) return error.message;
      throw error;
    }
  }

  async remove(routineId: string): Promise<void> {
    this.scheduler?.cancel(routineId);
    await this.options.store.routines.remove(this.options.ownerId, routineId);
    this.changed();
  }

  async runNow(routineId: string): Promise<string | undefined> {
    if (!this.scheduler) return "Routines are turned off on this gateway (SIBYL_ROUTINES=false).";
    return this.scheduler.runNow(routineId);
  }

  private async refreshNames(): Promise<void> {
    try {
      const routines = await this.options.store.routines.list(this.options.ownerId);
      this.names.clear();
      for (const routine of routines) this.names.set(routine.id, routine.name);
    } catch {
      // Names are only used for approval sentences.
    }
  }
}

function serverTimeZone(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SIBYL_TIMEZONE?.trim() || env.TZ?.trim();
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
