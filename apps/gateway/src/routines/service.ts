/**
 * Routines as one service on the runtime: chat tools, the approval gate for
 * routine runs, the scheduler (started once a model is known) and the set of
 * connected browsers that get list updates and notifications.
 */
import type { RoutineOutcome } from "./scheduler.js";
import { randomUUID } from "node:crypto";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import { DEFAULT_WORKSPACE_ID, canAccessWorkspace, type ApprovalRecord, type Governance, type NotificationKind, type RoutineRecord, type Store, type ToolRegistry, type UsageMeter } from "@open-gpt-live/core";
import {
  ROUTINE_EVENTS,
  WS_EVENTS,
  type ApprovalView,
  type ModelCatalog,
  type RoutinePatch,
  type RoutineView,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { isValidTimeZone } from "./cron.js";
import { canChangeRoutine, canDecideRoutineApproval, canSeeRoutine, routineWorkspace, type RoutineCaller } from "./access.js";
import { approvalWorkspace, canDecideChatApproval } from "../brain/approvals.js";
import { RoutineInputError, applyRoutinePatch, toRoutineView } from "./records.js";
import { RoutineApprovalGate, approvalView, createRoutineRunner } from "./runner.js";
import { RoutineScheduler, type ScheduledJobType, type SchedulerOptions } from "./scheduler.js";
import { ROUTINE_TOOL_NAMES, createRoutineTools } from "./tools.js";
import type { AgentRuntime } from "../agents/runtime.js";
import type { NotificationService } from "../notifications/service.js";

export const TIMEZONE_KEY = "routines.timezone";

type Log = (event: string, fields?: Record<string, unknown>) => void;
type Send = (message: ServerMessage) => void;

/** A connected browser: gets the routines of its current workspace that it may see. */
export interface RoutineSubscriber {
  send: Send;
  principal(): RoutineCaller["principal"];
  workspaceId(): string;
}

export interface RoutineServiceOptions {
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: Log;
  createId?(): string;
  now?(): number;
  /** Agents runtime (routines can run as an agent). */
  agents?: AgentRuntime;
  /** Where routine notices are published (finished, failed, budget, approval needed). */
  notifications?: NotificationService;
  /** Organization policy and audit for routine runs (monitor tasks use it too). */
  governance?: Governance;
}

export interface SchedulerStartOptions {
  provider: ToolChatProvider | undefined;
  model(): string | undefined;
  systemPrompt: string;
  extraBody?(model: string): Record<string, unknown> | undefined;
  catalog?(): ModelCatalog | undefined;
  /** Test seams for timing. */
  scheduler?: Partial<Pick<SchedulerOptions, "tickMs" | "leaseMs" | "heartbeatMs" | "retryDelayMs" | "maxConcurrency" | "sleep" | "selfTick">>;
}

export class RoutineService {
  readonly approvals: RoutineApprovalGate;
  /** The runtime's governance (monitor tasks run on the same scheduler and use it too). */
  get governance(): Governance | undefined {
    return this.options.governance;
  }
  scheduler: RoutineScheduler | undefined;
  private readonly jobTypes: ScheduledJobType<any>[] = [];
  private routinesEnabled = false;
  /** Set by the runtime once agents are installed (routines can run as an agent). */
  agents: AgentRuntime | undefined;
  private readonly subscribers = new Set<RoutineSubscriber>();
  private readonly names = new Map<string, string>();
  private timezone: string;
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: RoutineServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.agents = options.agents;
    this.timezone = serverTimeZone(options.env);
    this.approvals = new RoutineApprovalGate({
      store: options.store,
      ownerId: options.ownerId,
      createId: this.createId,
      now: this.now,
      log: options.log,
      onRequested: (view, routine, record) => {
        // Only to people who may decide it, in the routine's workspace.
        for (const subscriber of this.subscribers) {
          if (subscriber.workspaceId() === routineWorkspace(routine) && canDecideRoutineApproval(subscriber.principal(), record, routine)) {
            send(subscriber, { type: WS_EVENTS.APPROVAL_REQUEST, approval: view });
          }
        }
        this.publish({
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
        void this.sendResolved(id, status);
        void this.broadcastInbox();
        // Deciding (or expiring) the approval reads its approval_needed notification.
        void this.options.notifications?.resolveApproval(id).catch((error: unknown) => this.options.log("routines.notification_read_failed", { id, error: String(error) }));
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

  /**
   * Run another job type (e.g. monitors) on the routine scheduler's tick and
   * lease machinery. Registered types start with the scheduler.
   */
  addJobType(type: ScheduledJobType<any>): void {
    this.jobTypes.push(type);
    this.scheduler?.addJobType(type);
  }

  /** Start the worker unless SIBYL_ROUTINES=false (other job types still run then). */
  async startScheduler(input: SchedulerStartOptions): Promise<boolean> {
    const routinesOff = /^(false|0|no|off)$/i.test(this.options.env.SIBYL_ROUTINES?.trim() ?? "");
    if (routinesOff) {
      this.options.log("routines.disabled", {});
      if (this.jobTypes.length === 0 || this.scheduler) return false;
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
      ...(this.agents ? { agents: this.agents } : {}),
      ...(this.options.governance ? { governance: this.options.governance } : {}),
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
      notify: (notification) => this.publish(notification),
      expireOrphanApproval: (id) => this.approvals.expireOrphan(id),
      ...(routinesOff ? { routines: false } : {}),
      ...input.scheduler
    });
    for (const type of this.jobTypes) this.scheduler.addJobType(type);
    this.routinesEnabled = !routinesOff;
    await this.scheduler.start();
    this.options.log("routines.scheduler_started", { routines: !routinesOff, jobTypes: this.jobTypes.map((type) => type.kind) });
    return !routinesOff;
  }

  async stop(): Promise<void> {
    this.approvals.dispose();
    await this.scheduler?.stop();
    this.subscribers.clear();
  }

  /* ── browsers ── */

  subscribe(subscriber: RoutineSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** An approval was decided or expired: tell the browsers working in its workspace. */
  private async sendResolved(id: string, status: "approved" | "declined" | "expired"): Promise<void> {
    try {
      const record = await this.getApproval(id);
      if (!record) return;
      const workspaceId = await approvalWorkspace(this.options.store, this.options.ownerId, record);
      for (const subscriber of this.subscribers) {
        if (subscriber.workspaceId() === workspaceId && canAccessWorkspace(subscriber.principal(), workspaceId)) {
          send(subscriber, { type: WS_EVENTS.APPROVAL_RESOLVED, id, status });
        }
      }
    } catch (error) {
      this.options.log("routines.broadcast_failed", { error: String(error) });
    }
  }

  /** A routine run's notice → the notifications module (the one publish path). */
  private publish(notification: RoutineOutcome): void {
    const notifications = this.options.notifications;
    if (!notifications) return;
    void (async () => {
      // Routines may carry a workspace and creator (older ones don't): the notice goes there.
      const routine = (await this.options.store.routines.get(this.options.ownerId, notification.routineId).catch(() => undefined)) as
        | (RoutineRecord & { workspaceId?: string; createdBy?: string })
        | undefined;
      await notifications.notify({
        kind: ROUTINE_NOTICE_KIND[notification.kind],
        workspaceId: routine?.workspaceId ?? DEFAULT_WORKSPACE_ID,
        ...(routine?.createdBy ? { recipientUserId: routine.createdBy } : {}),
        title: notification.kind === "needs_approval" ? `“${notification.routineName}” needs your approval` : notification.routineName,
        body: notification.message,
        links: {
          routineId: notification.routineId,
          ...(notification.conversationId ? { conversationId: notification.conversationId } : {}),
          ...(notification.approvalId ? { approvalId: notification.approvalId } : {}),
          ...(notification.agentId ? { agentId: notification.agentId } : {})
        }
      });
    })().catch((error: unknown) => this.options.log("routines.notify_failed", { routineId: notification.routineId, error: String(error) }));
  }

  /** Routines changed: refresh caches and every browser's list. */
  changed(): void {
    void (async () => {
      await this.refreshNames();
      for (const subscriber of this.subscribers) {
        send(subscriber, { type: ROUTINE_EVENTS.ROUTINES_LIST, items: await this.list({ principal: subscriber.principal(), workspaceId: subscriber.workspaceId() }) });
      }
    })().catch((error: unknown) => this.options.log("routines.broadcast_failed", { error: String(error) }));
  }

  /** Every browser's inbox (each sees the approvals of its own workspace it may decide). */
  async broadcastInbox(): Promise<void> {
    for (const subscriber of this.subscribers) {
      send(subscriber, { type: ROUTINE_EVENTS.INBOX_LIST, items: await this.inbox({ principal: subscriber.principal(), workspaceId: subscriber.workspaceId() }) });
    }
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

  /** Routines the caller may see in their workspace. */
  async list(caller: RoutineCaller): Promise<RoutineView[]> {
    const { store, ownerId } = this.options;
    const routines = (await store.routines.list(ownerId)).filter((routine) => canSeeRoutine(caller, routine));
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

  /**
   * Pending approvals the caller may decide in their current workspace,
   * oldest first: routine approvals (creator or routines.manage) and the
   * caller's own chat approvals.
   */
  async inbox(caller: RoutineCaller): Promise<ApprovalView[]> {
    const { store, ownerId } = this.options;
    const now = this.now();
    const pending = (await store.approvals.listPending(ownerId)).filter((record) => record.expiresAt === undefined || record.expiresAt > now);
    const routines = new Map((await store.routines.list(ownerId)).map((routine) => [routine.id, routine]));
    const visible: ApprovalView[] = [];
    for (const record of pending) {
      if (await this.mayDecide(caller, record, routines)) visible.push(approvalView(record));
    }
    return visible;
  }

  /**
   * Decide a routine run's approval. Only in its workspace, by someone who may
   * decide it there; anyone else gets undefined ("no longer available").
   */
  async decideApproval(caller: RoutineCaller, id: string, decision: "approve" | "decline"): Promise<ApprovalRecord["status"] | undefined> {
    const record = await this.getApproval(id);
    const routine = record?.routineId ? await this.options.store.routines.get(this.options.ownerId, record.routineId) : undefined;
    if (!record || !routine || !canDecideRoutineApproval(caller.principal, record, routine)) {
      this.options.log("routines.approval_denied", { id, workspaceId: caller.workspaceId });
      return undefined;
    }
    return this.approvals.decide(id, decision);
  }

  /** Whether the caller, in their current workspace, may see and decide this approval. */
  private async mayDecide(caller: RoutineCaller, record: ApprovalRecord, routines: ReadonlyMap<string, RoutineRecord>): Promise<boolean> {
    if (record.routineId) {
      const routine = routines.get(record.routineId);
      return Boolean(routine && routineWorkspace(routine) === caller.workspaceId && canDecideRoutineApproval(caller.principal, record, routine));
    }
    const workspaceId = await approvalWorkspace(this.options.store, this.options.ownerId, record);
    return workspaceId === caller.workspaceId && canDecideChatApproval(caller.principal, record, workspaceId);
  }

  /** A routine the caller may see, or why not (unknown and out-of-workspace look the same). */
  private async visible(caller: RoutineCaller, routineId: string): Promise<RoutineRecord | string> {
    const routine = await this.options.store.routines.get(this.options.ownerId, routineId);
    return routine && canSeeRoutine(caller, routine) ? routine : "Routine not found.";
  }

  /** The routine, when the caller may change it (their own, or anyone's with routines.manage). */
  private async changeable(caller: RoutineCaller, routineId: string): Promise<RoutineRecord | string> {
    const routine = await this.visible(caller, routineId);
    if (typeof routine === "string") return routine;
    return canChangeRoutine(caller, routine) ? routine : "Only its creator or someone who may manage routines can change it.";
  }

  async update(caller: RoutineCaller, routineId: string, patch: RoutinePatch): Promise<RoutineRecord | string> {
    const routine = await this.changeable(caller, routineId);
    if (typeof routine === "string") return routine;
    if (patch.agentId && this.agents && !(await this.agents.get(caller.principal, caller.workspaceId, patch.agentId))) {
      return "That agent doesn't exist or you can't use it.";
    }
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

  async remove(caller: RoutineCaller, routineId: string): Promise<string | undefined> {
    const routine = await this.changeable(caller, routineId);
    if (typeof routine === "string") return routine;
    await this.discard(routine.id);
    return undefined;
  }

  /** Delete without a caller (e.g. the plugin that created it is uninstalled). */
  async discard(routineId: string): Promise<void> {
    this.scheduler?.cancel(routineId);
    await this.options.store.routines.remove(this.options.ownerId, routineId);
    this.changed();
  }

  async runNow(caller: RoutineCaller, routineId: string): Promise<string | undefined> {
    if (!this.scheduler || !this.routinesEnabled) return "Routines are turned off on this gateway (SIBYL_ROUTINES=false).";
    const routine = await this.changeable(caller, routineId);
    if (typeof routine === "string") return routine;
    return this.scheduler.runNow(routine.id);
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

function send(subscriber: RoutineSubscriber, message: ServerMessage): void {
  try {
    subscriber.send(message);
  } catch {
    // A closing socket; it unsubscribes on close.
  }
}

/** The scheduler's run outcomes as notification kinds. */
const ROUTINE_NOTICE_KIND: Record<RoutineOutcome["kind"], NotificationKind> = {
  finished: "routine_finished",
  failed: "routine_failed",
  interrupted: "routine_failed",
  budget_blocked: "budget_blocked",
  needs_approval: "approval_needed",
  agent_action: "agent_action"
};

function serverTimeZone(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SIBYL_TIMEZONE?.trim() || env.TZ?.trim();
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
