/**
 * Organization policies — Sibyl Enterprise (licence feature `policies`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * - Blocked tools: never offered to the model and refused if called (by
 *   name, or a whole provider with "provider:<id>").
 * - Second approval: write actions (all, high-risk only, or a list) also need
 *   an organization admin's approval after the person's own. Reuses the
 *   approval records and cards of apps/gateway/src/brain/approvals.ts.
 * - Model allowlist: only these models may be chosen or run (empty: all).
 * - Data retention: chats, uploads and notifications older than N days are
 *   deleted by a job on the gateway's one scheduler.
 *
 * The rules are plain data in one key of the store's key-value table; the
 * gateway consults them through the Governance hooks (packages/core/src/governance.ts).
 */
import { randomUUID } from "node:crypto";
import {
  AUDIT_ACTIONS,
  auditActor,
  isHighRiskTool,
  type ApprovalRecord,
  type AuditActor,
  type EnterpriseModuleContext,
  type EnterpriseNotice,
  type GovernedTool,
  type ScheduledJob,
  type ScheduledJobType,
  type SecondApprovalOutcome,
  type SecondApprovalRequest,
  type Store,
  type ToolDefinition,
  type ToolPolicyHook
} from "../../../packages/core/src/index";
import type { ApprovalView } from "../../../packages/protocol/src/index";
import { APPROVAL_TTL_MS, approvalView, newApprovalRecord } from "../../../apps/gateway/src/brain/approvals";
import { uploadServiceFor } from "../../../apps/gateway/src/uploads/index";
import { AdminError, badRequest, notFound, stringList } from "../http";

export const POLICIES_KV_KEY = "enterprise.policies.v1";

export type SecondApprovalMode = "off" | "high_risk" | "all_writes" | "listed";
export const SECOND_APPROVAL_MODES: readonly SecondApprovalMode[] = ["off", "high_risk", "all_writes", "listed"];

export interface RetentionPolicy {
  chatsDays?: number;
  uploadsDays?: number;
  notificationsDays?: number;
}

export interface OrgPolicies {
  /** Tool names, or "provider:<id>" for every tool of a provider (an MCP server, a connector). */
  blockedTools: string[];
  secondApproval: { mode: SecondApprovalMode; tools: string[] };
  /** Model ids that may be used (empty: every model in the catalogue). */
  modelAllowlist: string[];
  retention: RetentionPolicy;
  updatedAt?: number;
}

export const DEFAULT_POLICIES: OrgPolicies = { blockedTools: [], secondApproval: { mode: "off", tools: [] }, modelAllowlist: [], retention: {} };

const TOOL_RULE = /^(provider:)?[A-Za-z0-9_.:-]{1,128}$/;
const MODEL_ID = /^[A-Za-z0-9_.:/@+-]{1,200}$/;
const MAX_RETENTION_DAYS = 3650;
/** How often the retention job runs while a retention rule is set. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

type Audit = EnterpriseModuleContext["audit"];

/* ───────────── rules ───────────── */

export class PolicyBook {
  private current: OrgPolicies = structuredClone(DEFAULT_POLICIES);
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: { store: Store; orgId: string; audit: Audit; now?: () => number }
  ) {}

  async load(): Promise<this> {
    const stored = await this.options.store.kv.get<Partial<OrgPolicies>>(this.options.orgId, POLICIES_KV_KEY);
    if (stored) this.current = normalize(stored);
    return this;
  }

  get policies(): OrgPolicies {
    return structuredClone(this.current);
  }

  /** The hook registered with the runtime's Governance. Synchronous, cached. */
  readonly hook: ToolPolicyHook = {
    tool: (tool) => {
      if (this.blocked(tool)) return { allowed: false, reason: `${tool.name} is blocked by your organization's policy.` };
      return this.needsSecondApproval(tool) ? { secondApproval: true } : undefined;
    },
    model: (model) => {
      const list = this.current.modelAllowlist;
      if (list.length === 0 || list.includes(model)) return undefined;
      return { allowed: false, reason: `The model ${model} isn't on your organization's model allowlist.` };
    }
  };

  private blocked(tool: GovernedTool): boolean {
    const rules = this.current.blockedTools;
    return rules.includes(tool.name) || (tool.provider !== undefined && rules.includes(`provider:${tool.provider}`));
  }

  private needsSecondApproval(tool: GovernedTool): boolean {
    if (tool.effect !== "write") return false;
    const { mode, tools } = this.current.secondApproval;
    if (mode === "all_writes") return true;
    if (mode === "high_risk") return isHighRiskTool(tool);
    if (mode === "listed") return tools.includes(tool.name) || (tool.provider !== undefined && tools.includes(`provider:${tool.provider}`));
    return false;
  }

  /** Replace the policies (validated); audited with the parts that changed. */
  async save(actor: AuditActor, input: Record<string, unknown>): Promise<OrgPolicies> {
    const next = parsePolicies(input, this.current);
    next.updatedAt = (this.options.now ?? Date.now)();
    const changed = (Object.keys(DEFAULT_POLICIES) as Array<keyof OrgPolicies>).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(this.current[key]));
    const run = this.writes.then(async () => {
      await this.options.store.kv.set(this.options.orgId, POLICIES_KV_KEY, next);
      this.current = next;
    });
    this.writes = run.catch(() => undefined);
    await run;
    this.options.audit({
      action: AUDIT_ACTIONS.POLICY_CHANGED,
      actor,
      target: { kind: "policies" },
      details: {
        changed,
        blockedTools: next.blockedTools,
        secondApproval: next.secondApproval.mode,
        secondApprovalTools: next.secondApproval.tools,
        modelAllowlist: next.modelAllowlist,
        chatsDays: next.retention.chatsDays ?? null,
        uploadsDays: next.retention.uploadsDays ?? null,
        notificationsDays: next.retention.notificationsDays ?? null
      }
    });
    return this.policies;
  }
}

function normalize(stored: Partial<OrgPolicies>): OrgPolicies {
  return {
    blockedTools: stored.blockedTools ?? [],
    secondApproval: { mode: stored.secondApproval?.mode ?? "off", tools: stored.secondApproval?.tools ?? [] },
    modelAllowlist: stored.modelAllowlist ?? [],
    retention: stored.retention ?? {},
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {})
  };
}

/** Validate a (partial) policy update on top of the current one. */
export function parsePolicies(input: Record<string, unknown>, current: OrgPolicies): OrgPolicies {
  const next = structuredClone(current);
  if (input.blockedTools !== undefined) next.blockedTools = stringList(input.blockedTools, "Blocked tools", 500, TOOL_RULE);
  if (input.secondApproval !== undefined) {
    const raw = input.secondApproval as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") throw badRequest("secondApproval must be an object.");
    const mode = raw.mode ?? next.secondApproval.mode;
    if (!SECOND_APPROVAL_MODES.includes(mode as SecondApprovalMode)) throw badRequest(`Second approval is one of: ${SECOND_APPROVAL_MODES.join(", ")}.`);
    next.secondApproval = { mode: mode as SecondApprovalMode, tools: raw.tools === undefined ? next.secondApproval.tools : stringList(raw.tools, "Second-approval tools", 500, TOOL_RULE) };
  }
  if (input.modelAllowlist !== undefined) next.modelAllowlist = stringList(input.modelAllowlist, "Model allowlist", 200, MODEL_ID);
  if (input.retention !== undefined) {
    const raw = input.retention as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") throw badRequest("retention must be an object.");
    const retention: RetentionPolicy = {};
    for (const key of ["chatsDays", "uploadsDays", "notificationsDays"] as const) {
      const value = raw[key];
      if (value === undefined || value === null || value === "" || value === 0) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RETENTION_DAYS) {
        throw badRequest(`Retention is a whole number of days from 1 to ${MAX_RETENTION_DAYS} (or empty to keep forever).`);
      }
      retention[key] = value;
    }
    next.retention = retention;
  }
  return next;
}

/* ───────────── second approvals ───────────── */

interface PendingSecond {
  record: ApprovalRecord;
  view: ApprovalView;
  requestedBy: AuditActor;
  workspaceId?: string;
  resolve(outcome: SecondApprovalOutcome): void;
}

export interface SecondApprovalItem {
  approval: ApprovalView;
  requestedBy: AuditActor;
  workspaceId?: string;
}

/**
 * Admins' second approvals. A request waits (in memory, like the person's own
 * approval card) until an organization owner or admin decides it, it expires
 * (same 10 minutes as approval cards), or the run is stopped.
 */
export class SecondApprovalDesk {
  private readonly pending = new Map<string, PendingSecond>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      store: Store;
      orgId: string;
      audit: Audit;
      notify?: (notice: EnterpriseNotice) => void;
      log: (event: string, fields?: Record<string, unknown>) => void;
      ttlMs?: number;
      now?: () => number;
    }
  ) {
    this.ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** The SecondApprover registered with Governance. */
  readonly approver = async (request: SecondApprovalRequest): Promise<SecondApprovalOutcome> => {
    if (request.signal.aborted) return "expired";
    const createdAt = this.now();
    const record = newApprovalRecord({
      id: randomUUID(),
      ownerId: this.options.orgId,
      runId: request.runId,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      // The loop passes the tool definition itself (title, summary, risk).
      tool: request.tool as ToolDefinition<any, any>,
      input: request.input,
      createdAt,
      ttlMs: this.ttlMs
    });
    const requestedBy = auditActor(request.principal);
    const view = approvalView(record);
    const outcome = new Promise<SecondApprovalOutcome>((resolve) => {
      this.pending.set(record.id, { record, view, requestedBy, ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}), resolve });
    });
    const timer = setTimeout(() => this.finish(record.id, "expired", { kind: "system" }, "timeout"), this.ttlMs);
    timer.unref?.();
    const onAbort = () => this.finish(record.id, "expired", { kind: "system" }, "run stopped");
    request.signal.addEventListener("abort", onAbort, { once: true });
    this.options.audit({
      action: AUDIT_ACTIONS.SECOND_APPROVAL_REQUESTED,
      actor: requestedBy,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      target: { kind: "tool", id: record.toolName, name: record.title },
      details: { approvalId: record.id, runId: record.runId, summary: record.summary }
    });
    void this.notifyAdmins(view, requestedBy, request.workspaceId);
    try {
      return await outcome;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  };

  list(): SecondApprovalItem[] {
    return [...this.pending.values()]
      .sort((a, b) => a.record.createdAt - b.record.createdAt)
      .map((p) => ({ approval: p.view, requestedBy: p.requestedBy, ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}) }));
  }

  /** An admin's decision. The person who asked can't be their own second approver. */
  decide(actor: AuditActor, id: string, decision: unknown): SecondApprovalOutcome {
    if (decision !== "approve" && decision !== "decline") throw badRequest('decision is "approve" or "decline".');
    const pending = this.pending.get(id);
    if (!pending) throw notFound("That approval is no longer waiting (decided, expired or stopped).");
    if (actor.kind === "user" && actor.userId && actor.userId === pending.requestedBy.userId) {
      throw new AdminError(403, "same_person", "A second approval must come from someone other than the person who asked.");
    }
    const outcome: SecondApprovalOutcome = decision === "approve" ? "approved" : "declined";
    this.finish(id, outcome, actor);
    return outcome;
  }

  /** Stop: expire everything still waiting. */
  close(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, "expired", { kind: "system" }, "shutdown");
  }

  private finish(id: string, outcome: SecondApprovalOutcome, actor: AuditActor, reason?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(outcome);
    this.options.audit({
      action: AUDIT_ACTIONS.SECOND_APPROVAL_DECIDED,
      actor,
      outcome: outcome === "approved" ? "success" : "denied",
      ...(pending.workspaceId ? { workspaceId: pending.workspaceId } : {}),
      target: { kind: "tool", id: pending.record.toolName, name: pending.record.title },
      details: { approvalId: id, decision: outcome, requestedBy: pending.requestedBy.userId ?? pending.requestedBy.kind, ...(reason ? { reason } : {}) }
    });
    this.options.log("policies.second_approval", { id, outcome, ...(reason ? { reason } : {}) });
  }

  /** Tell the organization's owners and admins (inbox + live), except the person who asked. */
  private async notifyAdmins(view: ApprovalView, requestedBy: AuditActor, workspaceId: string | undefined): Promise<void> {
    if (!this.options.notify) return;
    try {
      const memberships = await this.options.store.identity.memberships.listForScope(this.options.orgId, "org");
      const admins = memberships.filter((m) => (m.role === "owner" || m.role === "admin") && m.userId !== requestedBy.userId);
      const who = requestedBy.name ?? requestedBy.email ?? "Someone";
      for (const admin of admins) {
        this.options.notify({
          kind: "approval_needed",
          ...(workspaceId ? { workspaceId } : {}),
          recipientUserId: admin.userId,
          title: `Second approval needed: ${view.title}`,
          body: `${who} approved this action: ${view.summary} Your organization's policy needs an admin to approve it too. Open Admin, then Policies.`
        });
      }
    } catch (error) {
      this.options.log("policies.notify_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/* ───────────── data retention ───────────── */

export interface RetentionResult {
  chats: number;
  uploads: number;
  notifications: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Delete what is older than the retention policy allows. Audited when anything (or a manual run) happened. */
export async function purgeExpired(input: {
  store: Store;
  orgId: string;
  env: NodeJS.ProcessEnv;
  retention: RetentionPolicy;
  now: number;
  audit: Audit;
  actor?: AuditActor;
  log: (event: string, fields?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}): Promise<RetentionResult> {
  const { store, orgId, retention, now } = input;
  const result: RetentionResult = { chats: 0, uploads: 0, notifications: 0 };
  if (retention.chatsDays) {
    const cutoff = now - retention.chatsDays * DAY_MS;
    for (const chat of await store.conversations.list(orgId, Number.MAX_SAFE_INTEGER)) {
      if (input.signal?.aborted) break;
      if (chat.updatedAt < cutoff) {
        await store.conversations.remove(orgId, chat.id);
        result.chats += 1;
      }
    }
  }
  if (retention.uploadsDays) {
    const cutoff = now - retention.uploadsDays * DAY_MS;
    const uploads = uploadServiceFor({ store, ownerId: orgId, env: input.env, log: input.log });
    for (const file of await store.artifacts.list(orgId, { kind: "file" })) {
      if (input.signal?.aborted) break;
      if (file.createdAt < cutoff && (await uploads.remove(file.id))) result.uploads += 1;
    }
  }
  if (retention.notificationsDays) {
    result.notifications = await store.notifications.prune(orgId, now - retention.notificationsDays * DAY_MS);
  }
  if (input.actor || result.chats || result.uploads || result.notifications) {
    input.audit({
      action: AUDIT_ACTIONS.RETENTION_PURGED,
      actor: input.actor ?? { kind: "system" },
      target: { kind: "retention" },
      details: { chats: result.chats, uploads: result.uploads, notifications: result.notifications, chatsDays: retention.chatsDays ?? null, uploadsDays: retention.uploadsDays ?? null, notificationsDays: retention.notificationsDays ?? null }
    });
  }
  input.log("policies.retention_purged", { ...result });
  return result;
}

/** The retention job on the gateway's scheduler: hourly while any retention rule is set. */
export function retentionJobType(input: {
  book: PolicyBook;
  run(signal: AbortSignal): Promise<unknown>;
}): ScheduledJobType<ScheduledJob> {
  const job: ScheduledJob = { id: "retention" };
  let nextAt = 0;
  let running = false;
  return {
    kind: "enterprise-retention",
    maxConcurrency: 1,
    async due(now) {
      const { retention } = input.book.policies;
      const active = Boolean(retention.chatsDays || retention.uploadsDays || retention.notificationsDays);
      return active && !running && now >= nextAt ? [job] : [];
    },
    async claim(claimed, now) {
      if (running) return undefined;
      running = true;
      nextAt = now + RETENTION_INTERVAL_MS;
      return claimed;
    },
    async renew() {},
    async run(_claimed, signal) {
      await input.run(signal);
    },
    async release() {
      running = false;
    },
    async get(id) {
      return id === job.id ? job : undefined;
    }
  };
}
