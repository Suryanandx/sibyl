/**
 * Monitors ("keep an eye on it"): watch a source and act when something
 * matters.
 *
 * - Source: a read tool (any connector's `<connector>_<action>` read tool,
 *   an MCP read tool, a built-in), an RSS/Atom feed, a web page, or a
 *   webhook that POSTs to the gateway (HMAC-signed).
 * - Each check fetches the source, keeps only items it hasn't seen (by id,
 *   dedupe key or content hash), applies cheap structured filters first and
 *   asks a small model the plain-language condition only for what is left.
 * - Actions: notify (inbox, email, Slack, Teams) and/or start a task (a brain
 *   run, optionally as an agent; writes follow the approval rules).
 *
 * Polled monitors have `nextCheckAt`; the shared scheduler (routines'
 * lease/tick machinery) picks them up via `due()`. Webhook monitors have no
 * `nextCheckAt` and run when a delivery arrives.
 */

/** Minimum polling interval. */
export const MIN_MONITOR_EVERY_MINUTES = 5;
/** Maximum polling interval (one week). */
export const MAX_MONITOR_EVERY_MINUTES = 7 * 24 * 60;

export type MonitorSource =
  | { kind: "tool"; toolName: string; input: Record<string, unknown> }
  | { kind: "webhook"; secretRef: string }
  | { kind: "rss" | "webpage"; url: string };

export type MonitorFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "in"
  | "exists"
  /** The value at `path` differs from the last time this item was seen (value: optional new value). */
  | "changed";

export const MONITOR_FILTER_OPS: readonly MonitorFilterOp[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "in",
  "exists",
  "changed"
];

export interface MonitorFilter {
  /** Dotted path into the item, e.g. "properties.amount" or "labels.0". */
  path: string;
  op: MonitorFilterOp;
  value?: unknown;
}

export interface MonitorCondition {
  /** Structured checks, all must pass (cheap, no model). */
  filter?: MonitorFilter[];
  /** Plain-language test asked of a small model, only for new candidates. */
  ask?: string;
}

export type MonitorChannel = "inbox" | "email" | "slack" | "teams";
export const MONITOR_CHANNELS: readonly MonitorChannel[] = ["inbox", "email", "slack", "teams"];

export type MonitorAction =
  | { kind: "notify"; channels: MonitorChannel[] }
  | { kind: "task"; instruction: string };

export interface MonitorSpend {
  /** UTC day "YYYY-MM-DD" and month "YYYY-MM" the totals belong to. */
  day: string;
  dayUsd: number;
  month: string;
  monthUsd: number;
}

export interface MonitorRecord {
  id: string;
  /** Organization (store owner). */
  ownerId: string;
  workspaceId: string;
  /** User id of the creator ("owner" for the API token / local mode). Checks run with their access. */
  createdBy: string;
  /** Run tasks as this agent (its autonomy decides whether writes need approval). */
  agentId?: string;
  name: string;
  source: MonitorSource;
  schedule: { everyMinutes: number };
  condition: MonitorCondition;
  actions: MonitorAction[];
  dedupe: { keyPath?: string };
  enabled: boolean;
  budget?: { dailyUsd?: number };
  lastCheckedAt?: number;
  lastFiredAt?: number;
  /** Engine state (seen keys, tracked values); opaque to everything else. */
  state?: unknown;
  createdAt: number;
  updatedAt: number;
  /** Next poll (absent: webhook monitors, or paused). */
  nextCheckAt?: number;
  /** Worker lease while a check runs (expired leases are cleared on recovery). */
  leaseUntil?: number;
  /** Consecutive failed checks (reset on success). */
  failureCount?: number;
  lastError?: string;
  /** Why the monitor was paused automatically (absent: paused by a person, or running). */
  pausedReason?: string;
  /** Conversation that task results are posted to (created on the first task). */
  conversationId?: string;
  spend?: MonitorSpend;
}

export interface MonitorEventItem {
  key: string;
  title: string;
  url?: string;
  /** Why it matched (from the model, when the condition has an `ask`). */
  reason?: string;
}

export interface MonitorEventAction {
  kind: "notify" | "task";
  channel?: MonitorChannel;
  status: "sent" | "started" | "failed" | "unavailable" | "skipped";
  detail?: string;
}

export interface MonitorEventRecord {
  id: string;
  monitorId: string;
  ownerId: string;
  workspaceId: string;
  /** Creator of the monitor (events are private to them). */
  createdBy: string;
  at: number;
  /** "fired": something matched; "paused": auto-paused (errors or budget). */
  kind: "fired" | "paused";
  /** Concise, plain-language summary. */
  summary: string;
  items: MonitorEventItem[];
  /** Source links (deduplicated). */
  links: string[];
  /** Cost of the check that produced this event (USD). */
  costUsd: number;
  actions: MonitorEventAction[];
  /** Brain run started by a task action. */
  runId?: string;
}

export interface MonitorStore {
  list(ownerId: string, filter?: { workspaceId?: string }): Promise<MonitorRecord[]>;
  get(ownerId: string, id: string): Promise<MonitorRecord | undefined>;
  upsert(record: MonitorRecord): Promise<void>;
  /** Removes the monitor and its events. */
  remove(ownerId: string, id: string): Promise<void>;
  /** Enabled monitors with nextCheckAt ≤ now (any owner), oldest first. */
  due(now: number): Promise<MonitorRecord[]>;
  insertEvent(event: MonitorEventRecord): Promise<void>;
  /** Newest first. */
  listEvents(ownerId: string, filter?: { monitorId?: string; workspaceId?: string; createdBy?: string; before?: number; limit?: number }): Promise<MonitorEventRecord[]>;
}

/** In-memory MonitorStore (used by createMemoryStore). */
export function createMemoryMonitorStore(): MonitorStore {
  const monitors = new Map<string, MonitorRecord>();
  const events: MonitorEventRecord[] = [];
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    async list(ownerId, filter = {}) {
      return [...monitors.values()]
        .filter((m) => m.ownerId === ownerId && (!filter.workspaceId || m.workspaceId === filter.workspaceId))
        .map(clone);
    },
    async get(ownerId, id) {
      const found = monitors.get(id);
      return found && found.ownerId === ownerId ? clone(found) : undefined;
    },
    async upsert(record) {
      monitors.set(record.id, clone(record));
    },
    async remove(ownerId, id) {
      if (monitors.get(id)?.ownerId !== ownerId) return;
      monitors.delete(id);
      for (let i = events.length - 1; i >= 0; i -= 1) if (events[i]!.monitorId === id) events.splice(i, 1);
    },
    async due(now) {
      return [...monitors.values()]
        .filter((m) => m.enabled && m.nextCheckAt !== undefined && m.nextCheckAt <= now)
        .sort((a, b) => (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0))
        .map(clone);
    },
    async insertEvent(event) {
      events.push(clone(event));
    },
    async listEvents(ownerId, filter = {}) {
      const limit = filter.limit ?? 50;
      return events
        .map((event, index) => ({ event, index }))
        .filter(
          ({ event: e }) =>
            e.ownerId === ownerId &&
            (!filter.monitorId || e.monitorId === filter.monitorId) &&
            (!filter.workspaceId || e.workspaceId === filter.workspaceId) &&
            (!filter.createdBy || e.createdBy === filter.createdBy) &&
            (filter.before === undefined || e.at < filter.before)
        )
        .sort((a, b) => b.event.at - a.event.at || a.index - b.index)
        .slice(0, limit)
        .map(({ event }) => clone(event));
    }
  };
}
