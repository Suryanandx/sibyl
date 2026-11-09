/**
 * Approvals for the deep brain's "write" tools, per WebSocket session.
 *
 * A write call creates an ApprovalRecord, shows an approval card in chat and
 * waits. The user's decision (APPROVAL_DECISION) resolves it; it expires after
 * 10 minutes, when the run is aborted, or when the socket closes. "Don't ask
 * again in this chat" auto-approves that tool for the rest of the session.
 */
import {
  DEFAULT_WORKSPACE_ID,
  PERMISSIONS,
  authorize,
  isHighRiskTool,
  type ApprovalRecord,
  type Principal,
  type Store,
  type ToolDefinition
} from "@open-gpt-live/core";
import { WS_EVENTS, type ApprovalView, type ServerMessage } from "@open-gpt-live/protocol";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalOutcome = "approved" | "declined" | "expired";

export interface ApprovalRequestInput {
  runId: string;
  conversationId?: string;
  tool: ToolDefinition<any, any>;
  input: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ApprovalBrokerOptions {
  store: Store;
  ownerId: string;
  /** Who is chatting and where, read when an approval is created (stored on the record). */
  requester?(): { principal: Principal; workspaceId: string };
  send(message: ServerMessage): void;
  createId(): string;
  now(): number;
  log?(event: string, fields?: Record<string, unknown>): void;
  ttlMs?: number;
}

interface Waiter {
  toolName: string;
  resolve(outcome: ApprovalOutcome): void;
}

/** Chat approvals still waiting, by id → the session's broker (a decision may come from another tab). */
const liveChatApprovals = new Map<string, ApprovalBroker>();

/** The broker (session) waiting on this chat approval, if any. */
export function chatApprovalBroker(id: string): ApprovalBroker | undefined {
  return liveChatApprovals.get(id);
}

/** Who asked for an approval, as stored (user id, or "token"/"local" for the org owner). */
export function requesterId(principal: Principal): string {
  return principal.userId ?? principal.kind;
}

/** The workspace an approval belongs to (older records: their routine's or chat's, else the default). */
export async function approvalWorkspace(store: Store, ownerId: string, record: ApprovalRecord): Promise<string> {
  if (record.workspaceId) return record.workspaceId;
  if (record.routineId) {
    const routine = await store.routines.get(ownerId, record.routineId).catch(() => undefined);
    if (routine) return routine.workspaceId ?? DEFAULT_WORKSPACE_ID;
  }
  if (record.conversationId) {
    const conversation = await store.conversations.get(ownerId, record.conversationId).catch(() => undefined);
    if (conversation) return conversation.workspaceId ?? DEFAULT_WORKSPACE_ID;
  }
  return DEFAULT_WORKSPACE_ID;
}

/**
 * May this person decide a chat approval? Only in the approval's workspace,
 * with tools.write there, and only the person it was asked of (older records
 * without a requester: the org owner).
 */
export function canDecideChatApproval(principal: Principal, record: ApprovalRecord, workspaceId: string): boolean {
  if (!authorize(principal, PERMISSIONS.TOOLS_WRITE, { workspaceId })) return false;
  return record.requestedBy === undefined ? principal.kind !== "user" : record.requestedBy === requesterId(principal);
}

export class ApprovalBroker {
  private readonly waiters = new Map<string, Waiter>();
  private readonly remembered = new Set<string>();
  private readonly ttlMs: number;
  private disposed = false;

  constructor(private readonly options: ApprovalBrokerOptions) {
    this.ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  }

  /** Tools the user said not to ask about again in this session. */
  isRemembered(toolName: string): boolean {
    return this.remembered.has(toolName);
  }

  /** Ask the user; resolves with their decision (or "expired"). */
  async request(request: ApprovalRequestInput): Promise<ApprovalOutcome> {
    const { tool, input, signal } = request;
    if (this.remembered.has(tool.name)) return "approved";
    if (this.disposed || signal.aborted) return "expired";

    const createdAt = this.options.now();
    const details = approvalDetails(input);
    const requester = this.options.requester?.();
    const record = newApprovalRecord({
      id: this.options.createId(),
      ownerId: this.options.ownerId,
      runId: request.runId,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...(requester ? { workspaceId: requester.workspaceId, requestedBy: requesterId(requester.principal) } : {}),
      tool,
      input,
      details,
      createdAt,
      ttlMs: this.ttlMs
    });
    await this.options.store.approvals.create(record);

    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      this.waiters.set(record.id, { toolName: tool.name, resolve });
    });
    liveChatApprovals.set(record.id, this);
    const timer = setTimeout(() => void this.expire(record.id, "timeout"), this.ttlMs);
    const onAbort = (): void => void this.expire(record.id, "aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || this.disposed) onAbort();

    const view = approvalView(record, details);
    this.options.send({ type: WS_EVENTS.APPROVAL_REQUEST, approval: view });
    this.options.log?.("approval.requested", { id: record.id, toolName: tool.name, runId: record.runId });

    try {
      return await outcome;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (liveChatApprovals.get(record.id) === this) liveChatApprovals.delete(record.id);
    }
  }

  /** Apply the user's decision from APPROVAL_DECISION (the caller checked canDecideChatApproval). */
  async decide(id: string, decision: "approve" | "decline", remember?: "conversation"): Promise<void> {
    const status = decision === "approve" ? "approved" : "declined";
    const decided = await this.options.store.approvals.decide(this.options.ownerId, id, status, this.options.now());
    const waiter = this.waiters.get(id);
    if (!decided) {
      // Already decided/expired (or unknown): tell the browser where it stands.
      const existing = await this.options.store.approvals.get(this.options.ownerId, id);
      if (existing && existing.status !== "pending") {
        this.options.send({ type: WS_EVENTS.APPROVAL_RESOLVED, id, status: existing.status });
      } else {
        this.options.send({ type: "error", message: "That approval is no longer available." });
      }
      return;
    }
    if (status === "approved" && remember === "conversation") {
      this.remembered.add(decided.toolName);
    }
    this.waiters.delete(id);
    this.options.send({ type: WS_EVENTS.APPROVAL_RESOLVED, id, status });
    this.options.log?.("approval.decided", { id, status, remember: remember ?? null });
    waiter?.resolve(status);
  }

  /** Socket closed: expire everything still waiting. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.waiters.keys()]) void this.expire(id, "socket closed");
  }

  private async expire(id: string, reason: string): Promise<void> {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.resolve("expired");
    try {
      await this.options.store.approvals.decide(this.options.ownerId, id, "expired", this.options.now());
    } catch {
      // The store may already be closing; the run has been told either way.
    }
    this.options.send({ type: WS_EVENTS.APPROVAL_RESOLVED, id, status: "expired" });
    this.options.log?.("approval.expired", { id, reason });
  }
}

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|auth|cookie|credential|private[_-]?key/i;
const MAX_DETAILS = 6;
const MAX_VALUE_CHARS = 160;

/** Key inputs for the card: humanized labels, redacted and truncated values. */
export function approvalDetails(input: Record<string, unknown>): Array<{ label: string; value: string }> {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, MAX_DETAILS)
    .map(([key, value]) => ({
      label: humanize(key),
      value: SECRET_KEY.test(key) ? "••••••" : truncate(displayValue(value), MAX_VALUE_CHARS)
    }));
}

/**
 * A tool may describe its own approval in plain words by defining an optional
 * `approvalSummary(input)` (e.g. create_routine states the schedule and cost
 * cap). Otherwise the generic sentence from approvalSummary() is used.
 */
export function summarizeApproval(
  tool: Pick<ToolDefinition, "title"> & { approvalSummary?: (input: Record<string, unknown>) => string | undefined },
  input: Record<string, unknown>,
  details: Array<{ label: string; value: string }> = approvalDetails(input)
): string {
  try {
    const custom = tool.approvalSummary?.(input)?.trim();
    if (custom) return custom;
  } catch {
    // Fall back to the generic sentence.
  }
  return approvalSummary(tool, details);
}

/** One human sentence of exactly what will happen. */
export function approvalSummary(
  tool: Pick<ToolDefinition, "title">,
  details: Array<{ label: string; value: string }>
): string {
  const action = lowerFirst(tool.title.trim().replace(/[.\s]+$/, "")) || "run a tool";
  const key = details
    .filter((detail) => detail.value !== "••••••")
    .slice(0, 2)
    .map((detail) => `${detail.label.toLowerCase()} “${truncate(detail.value, 60)}”`);
  return key.length > 0 ? `Sibyl will ${action} with ${key.join(" and ")}.` : `Sibyl will ${action}.`;
}

/** Input as stored on the record: secrets masked, long strings cut. */
export function redactInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY.test(key)) out[key] = "[redacted]";
    else if (typeof value === "string") out[key] = truncate(value, 2_000);
    else out[key] = value;
  }
  return out;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
    return value.join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lowerFirst(value: string): string {
  // Keep acronyms ("SMS", "URL") intact.
  if (/^[A-Z]{2,}/.test(value)) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The stored approval for a tool call (chat, routines and monitors all use this). */
export function newApprovalRecord(input: {
  id: string;
  ownerId: string;
  runId: string;
  conversationId?: string;
  routineId?: string;
  workspaceId?: string;
  requestedBy?: string;
  tool: ToolDefinition<any, any>;
  input: Record<string, unknown>;
  details?: Array<{ label: string; value: string }>;
  createdAt: number;
  ttlMs: number;
}): ApprovalRecord {
  const details = input.details ?? approvalDetails(input.input);
  return {
    id: input.id,
    ownerId: input.ownerId,
    runId: input.runId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.routineId ? { routineId: input.routineId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    ...(isHighRiskTool(input.tool) ? { risk: "high" as const } : {}),
    toolName: input.tool.name,
    title: input.tool.title,
    summary: summarizeApproval(input.tool, input.input, details),
    input: redactInput(input.input),
    status: "pending",
    createdAt: input.createdAt,
    expiresAt: input.createdAt + input.ttlMs
  };
}

/** What the browser shows for an approval (approval card and inbox). */
export function approvalView(record: ApprovalRecord, details = approvalDetails(record.input)): ApprovalView {
  return {
    id: record.id,
    runId: record.runId,
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    ...(record.routineId ? { routineId: record.routineId } : {}),
    ...(record.risk ? { risk: record.risk } : {}),
    toolName: record.toolName,
    title: record.title,
    summary: record.summary,
    details,
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt })
  };
}
