/**
 * Storage contract. The gateway uses one Store for everything that must
 * survive a restart: conversations, approvals, usage, routines, artifacts,
 * memory and settings. `createMemoryStore()` is a full in-memory
 * implementation for tests and for running without a database file; the
 * SQLite implementation lives in @open-gpt-live/store.
 */
import type { UsageEvent } from "./usage";
import { createMemoryIdentityStore, type IdentityStore } from "./identity";
import { createMemoryMonitorStore, type MonitorStore } from "./monitors";
import { createMemoryAgentStore, type AgentStore } from "./agents";
import { createMemoryNotificationStore, type NotificationStore } from "./notifications";
import { createMemoryAuditStore, type AuditStore } from "./audit";
import { createMemoryMeetingStore, type MeetingStore } from "./meetings";
import { createMemoryCreditStore, createMemoryOrganizationStore, type CreditStore, type OrganizationStore } from "./tenancy";
import {
  availableInWorkspace,
  inWorkspace,
  keywordScore,
  type KnowledgeBaseRecord,
  type KnowledgeChunk,
  type KnowledgeDocRecord,
  type PluginRecord,
  type SkillRecord,
  type WorkspaceRecord,
  type WorkspaceStore
} from "./workspace";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  requestId: string;
  source?: "text" | "audio" | "ui";
  ui?: string;
  kind?: "brain";
  task?: string;
  model?: string;
  /** Tool activity shown as steps under a reply. */
  steps?: Array<{ callId: string; toolName: string; title: string; status: "ok" | "error" | "declined" }>;
  createdAt: number;
}

export interface ConversationRecord {
  id: string;
  ownerId: string;
  /** Workspace the chat belongs to (absent: the default workspace). */
  workspaceId?: string;
  /** User who started the chat (absent: created before sign-in existed). */
  createdBy?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export type ApprovalStatus = "pending" | "approved" | "declined" | "expired";

export interface ApprovalRecord {
  id: string;
  ownerId: string;
  /** Brain run (deep-work id or routine run id) waiting on this decision. */
  runId: string;
  conversationId?: string;
  routineId?: string;
  /** Workspace the action happens in (absent: older records — the routine's or chat's workspace, else default). */
  workspaceId?: string;
  /** Who it is asked of: the chatting user, or the routine's creator (user id, or "token"/"local"). */
  requestedBy?: string;
  /** "high": hard to undo (send, delete, share, move money); the card says so. */
  risk?: "high";
  toolName: string;
  title: string;
  /** One-line, human description of exactly what will happen. */
  summary: string;
  input: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
}

export interface RoutineRecord {
  id: string;
  ownerId: string;
  name: string;
  /** What to do, in plain language (the brain's instruction). */
  instruction: string;
  /** 5-field cron in `timezone`. */
  cron: string;
  timezone: string;
  enabled: boolean;
  /** Conversation the results are posted to. */
  conversationId?: string;
  maxRunUsd?: number;
  /** Run as this agent (its instructions, access, autonomy and budget). */
  agentId?: string;
  /** A one-time task: pauses itself after its first scheduled run. */
  once?: boolean;
  /** Workspace the routine runs in (absent: older records, the default workspace). */
  workspaceId?: string;
  /** Who created it (user id, or "local"/"token" for the owner); each run acts with their current rights. Absent: the org owner. */
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
}

export type RoutineRunStatus = "running" | "awaiting_approval" | "succeeded" | "failed" | "interrupted" | "budget_blocked";

export interface RoutineRunRecord {
  id: string;
  routineId: string;
  ownerId: string;
  status: RoutineRunStatus;
  startedAt: number;
  finishedAt?: number;
  costUsd: number;
  summary?: string;
  error?: string;
  /** Worker lease: a run whose lease expired is marked interrupted. */
  leaseUntil?: number;
}

export interface ArtifactRecord {
  id: string;
  ownerId: string;
  kind: "slides" | "file" | "media";
  title: string;
  /** Workspace the artifact belongs to (absent: the default workspace; see inWorkspace). */
  workspaceId?: string;
  /** Space the artifact belongs to (slides live in Spaces). */
  spaceId?: string;
  conversationId?: string;
  /** Version chain: revisions point at the artifact they replace. */
  parentId?: string;
  version: number;
  /** Provider-specific data, e.g. Presenton presentation id and export paths. */
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface SpaceRecord {
  id: string;
  ownerId: string;
  /** Workspace the space belongs to (absent: the default workspace; see inWorkspace). */
  workspaceId?: string;
  name: string;
  /** Default instructions for decks in this space (tone, audience, length). */
  instructions?: string;
  /** Presenton template id or name for branded decks. */
  template?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Store extends WorkspaceStore, AgentStore {
  conversations: {
    list(
      ownerId: string,
      limit?: number,
      filter?: { workspaceId?: string }
    ): Promise<Array<Omit<ConversationRecord, "messages">>>;
    get(ownerId: string, id: string): Promise<ConversationRecord | undefined>;
    upsert(record: ConversationRecord): Promise<void>;
    appendMessage(ownerId: string, conversationId: string, message: StoredMessage): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
  };
  approvals: {
    create(record: ApprovalRecord): Promise<void>;
    get(ownerId: string, id: string): Promise<ApprovalRecord | undefined>;
    listPending(ownerId: string): Promise<ApprovalRecord[]>;
    decide(ownerId: string, id: string, status: "approved" | "declined" | "expired", at?: number): Promise<ApprovalRecord | undefined>;
  };
  usage: {
    insert(event: UsageEvent): Promise<void>;
    /** Sum of cost for an owner in [from, to). */
    sum(ownerId: string, from: number, to: number, filter?: { routineId?: string }): Promise<number>;
    byFeature(ownerId: string, from: number, to: number): Promise<Record<string, number>>;
    /** Every event for an owner in [from, to), oldest first (reports and per-user totals). */
    list(ownerId: string, from: number, to: number): Promise<UsageEvent[]>;
  };
  routines: {
    list(ownerId: string): Promise<RoutineRecord[]>;
    get(ownerId: string, id: string): Promise<RoutineRecord | undefined>;
    upsert(record: RoutineRecord): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
    /** Enabled routines with nextRunAt ≤ now (any owner). */
    due(now: number): Promise<RoutineRecord[]>;
    insertRun(run: RoutineRunRecord): Promise<void>;
    updateRun(run: RoutineRunRecord): Promise<void>;
    listRuns(ownerId: string, routineId: string, limit?: number): Promise<RoutineRunRecord[]>;
  };
  artifacts: {
    create(record: ArtifactRecord): Promise<void>;
    get(ownerId: string, id: string): Promise<ArtifactRecord | undefined>;
    list(ownerId: string, filter?: { spaceId?: string; kind?: ArtifactRecord["kind"] }): Promise<ArtifactRecord[]>;
    /** Delete one record (data retention, upload removal). */
    remove(ownerId: string, id: string): Promise<void>;
  };
  spaces: {
    list(ownerId: string): Promise<SpaceRecord[]>;
    get(ownerId: string, id: string): Promise<SpaceRecord | undefined>;
    upsert(record: SpaceRecord): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
  };
  /** Users, memberships, invitations and sign-in sessions (see identity.ts). */
  identity: IdentityStore;
  /** Monitors and the events they fired (see monitors.ts). */
  monitors: MonitorStore;
  /** What Sibyl told people about (see notifications.ts). */
  notifications: NotificationStore;
  /** Append-only audit log (see audit.ts). */
  audit: AuditStore;
  /** Meetings, their transcripts and comments (see meetings.ts). */
  meetings: MeetingStore;
  /** Organizations (hosted Sibyl; self-hosted has none) and their AI credits ledger (see tenancy.ts). */
  organizations: OrganizationStore;
  credits: CreditStore;
  /** Small key-value settings/memory per owner (JSON values). */
  kv: {
    get<T = unknown>(ownerId: string, key: string): Promise<T | undefined>;
    set(ownerId: string, key: string, value: unknown): Promise<void>;
    delete(ownerId: string, key: string): Promise<void>;
  };
  close(): Promise<void>;
}

/** Complete in-memory Store (tests, or ephemeral mode with no database file). */
export function createMemoryStore(): Store {
  const conversations = new Map<string, ConversationRecord>();
  const approvals = new Map<string, ApprovalRecord>();
  const usage: UsageEvent[] = [];
  const routines = new Map<string, RoutineRecord>();
  const runs = new Map<string, RoutineRunRecord>();
  const artifacts = new Map<string, ArtifactRecord>();
  const spaces = new Map<string, SpaceRecord>();
  const kv = new Map<string, unknown>();
  const workspaces = new Map<string, WorkspaceRecord>();
  const bases = new Map<string, KnowledgeBaseRecord>();
  const docs = new Map<string, KnowledgeDocRecord>();
  let chunkList: KnowledgeChunk[] = [];
  const skills = new Map<string, SkillRecord>();
  const plugins = new Map<string, PluginRecord>();
  const clone = <T>(value: T): T => structuredClone(value);
  const ownedKey = (ownerId: string, id: string): string => `${ownerId}\u0000${id}`;
  const owned = <T extends { ownerId: string }>(map: Map<string, T>, ownerId: string, id: string): T | undefined => {
    const found = map.get(id);
    return found && found.ownerId === ownerId ? clone(found) : undefined;
  };

  return {
    conversations: {
      async list(ownerId, limit = 100, filter = {}) {
        return [...conversations.values()]
          .filter((c) => c.ownerId === ownerId && inWorkspace(c, filter.workspaceId))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit)
          .map(({ messages: _m, ...rest }) => clone(rest));
      },
      async get(ownerId, id) {
        const found = conversations.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async upsert(record) {
        conversations.set(record.id, clone(record));
      },
      async appendMessage(ownerId, conversationId, message) {
        const found = conversations.get(conversationId);
        if (!found || found.ownerId !== ownerId) throw new Error("conversation not found");
        found.messages.push(clone(message));
        found.updatedAt = Math.max(found.updatedAt, message.createdAt);
      },
      async remove(ownerId, id) {
        if (conversations.get(id)?.ownerId === ownerId) conversations.delete(id);
      }
    },
    approvals: {
      async create(record) {
        approvals.set(record.id, clone(record));
      },
      async get(ownerId, id) {
        const found = approvals.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async listPending(ownerId) {
        return [...approvals.values()]
          .filter((a) => a.ownerId === ownerId && a.status === "pending")
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(clone);
      },
      async decide(ownerId, id, status, at = Date.now()) {
        const found = approvals.get(id);
        if (!found || found.ownerId !== ownerId || found.status !== "pending") return undefined;
        found.status = status;
        found.decidedAt = at;
        return clone(found);
      }
    },
    usage: {
      async insert(event) {
        usage.push(clone(event));
      },
      async sum(ownerId, from, to, filter = {}) {
        return usage
          .filter((e) => e.ownerId === ownerId && e.at >= from && e.at < to && (!filter.routineId || e.routineId === filter.routineId))
          .reduce((total, e) => total + e.costUsd, 0);
      },
      async byFeature(ownerId, from, to) {
        const out: Record<string, number> = {};
        for (const e of usage) {
          if (e.ownerId === ownerId && e.at >= from && e.at < to) out[e.feature] = (out[e.feature] ?? 0) + e.costUsd;
        }
        return out;
      },
      async list(ownerId, from, to) {
        return usage.filter((e) => e.ownerId === ownerId && e.at >= from && e.at < to).map(clone);
      }
    },
    routines: {
      async list(ownerId) {
        return [...routines.values()].filter((r) => r.ownerId === ownerId).map(clone);
      },
      async get(ownerId, id) {
        const found = routines.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async upsert(record) {
        routines.set(record.id, clone(record));
      },
      async remove(ownerId, id) {
        if (routines.get(id)?.ownerId === ownerId) routines.delete(id);
      },
      async due(now) {
        return [...routines.values()]
          .filter((r) => r.enabled && r.nextRunAt !== undefined && r.nextRunAt <= now)
          .map(clone);
      },
      async insertRun(run) {
        runs.set(run.id, clone(run));
      },
      async updateRun(run) {
        runs.set(run.id, clone(run));
      },
      async listRuns(ownerId, routineId, limit = 20) {
        return [...runs.values()]
          .filter((r) => r.ownerId === ownerId && r.routineId === routineId)
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, limit)
          .map(clone);
      }
    },
    artifacts: {
      async create(record) {
        artifacts.set(record.id, clone(record));
      },
      async get(ownerId, id) {
        const found = artifacts.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async list(ownerId, filter = {}) {
        return [...artifacts.values()]
          .filter((a) => a.ownerId === ownerId && (!filter.spaceId || a.spaceId === filter.spaceId) && (!filter.kind || a.kind === filter.kind))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(clone);
      },
      async remove(ownerId, id) {
        if (artifacts.get(id)?.ownerId === ownerId) artifacts.delete(id);
      }
    },
    spaces: {
      async list(ownerId) {
        return [...spaces.values()].filter((s) => s.ownerId === ownerId).map(clone);
      },
      async get(ownerId, id) {
        const found = spaces.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async upsert(record) {
        spaces.set(record.id, clone(record));
      },
      async remove(ownerId, id) {
        if (spaces.get(id)?.ownerId === ownerId) spaces.delete(id);
      }
    },
    kv: {
      async get<T>(ownerId: string, key: string) {
        const value = kv.get(`${ownerId}\u0000${key}`);
        return value === undefined ? undefined : (clone(value) as T);
      },
      async set(ownerId, key, value) {
        kv.set(`${ownerId}\u0000${key}`, clone(value));
      },
      async delete(ownerId, key) {
        kv.delete(`${ownerId}\u0000${key}`);
      }
    },
    workspaces: {
      async list(ownerId) {
        return [...workspaces.values()].filter((w) => w.ownerId === ownerId).map(clone);
      },
      // Keyed by organization + id: every organization has a "default" workspace.
      async get(ownerId, id) {
        const found = workspaces.get(ownedKey(ownerId, id));
        return found ? clone(found) : undefined;
      },
      async upsert(record) {
        workspaces.set(ownedKey(record.ownerId, record.id), clone(record));
      },
      async remove(ownerId, id) {
        workspaces.delete(ownedKey(ownerId, id));
      }
    },
    knowledge: {
      async listBases(ownerId, filter = {}) {
        return [...bases.values()]
          .filter((b) => b.ownerId === ownerId && (!filter.workspaceId || b.workspaceId === filter.workspaceId))
          .map(clone);
      },
      async getBase(ownerId, id) {
        return owned(bases, ownerId, id);
      },
      async upsertBase(record) {
        bases.set(record.id, clone(record));
      },
      async removeBase(ownerId, id) {
        if (bases.get(id)?.ownerId !== ownerId) return;
        bases.delete(id);
        for (const [docId, doc] of docs) if (doc.knowledgeBaseId === id) docs.delete(docId);
        chunkList = chunkList.filter((c) => c.knowledgeBaseId !== id);
      },
      async listDocs(ownerId, knowledgeBaseId) {
        return [...docs.values()]
          .filter((d) => d.ownerId === ownerId && d.knowledgeBaseId === knowledgeBaseId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(clone);
      },
      async getDoc(ownerId, id) {
        return owned(docs, ownerId, id);
      },
      async upsertDoc(record) {
        docs.set(record.id, clone(record));
      },
      async removeDoc(ownerId, id) {
        if (docs.get(id)?.ownerId !== ownerId) return;
        docs.delete(id);
        chunkList = chunkList.filter((c) => c.docId !== id);
      },
      async replaceChunks(ownerId, docId, chunks) {
        chunkList = chunkList.filter((c) => !(c.docId === docId && c.ownerId === ownerId)).concat(chunks.map(clone));
      },
      async search(ownerId, knowledgeBaseIds, query, limit = 8) {
        const ids = new Set(knowledgeBaseIds);
        return chunkList
          .filter((c) => c.ownerId === ownerId && ids.has(c.knowledgeBaseId))
          .map((chunk) => ({ chunk: clone(chunk), score: keywordScore(`${chunk.label ?? ""} ${chunk.text}`, query) }))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
      async chunks(ownerId, knowledgeBaseIds) {
        const ids = new Set(knowledgeBaseIds);
        return chunkList.filter((c) => c.ownerId === ownerId && ids.has(c.knowledgeBaseId)).map(clone);
      }
    },
    skills: {
      async list(ownerId, filter = {}) {
        return [...skills.values()]
          .filter((s) => s.ownerId === ownerId && availableInWorkspace(s, filter.workspaceId))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(clone);
      },
      async get(ownerId, id) {
        return owned(skills, ownerId, id);
      },
      async upsert(record) {
        skills.set(record.id, clone(record));
      },
      async remove(ownerId, id) {
        if (skills.get(id)?.ownerId === ownerId) skills.delete(id);
      }
    },
    plugins: {
      async list(ownerId) {
        return [...plugins.values()].filter((p) => p.ownerId === ownerId).map(clone);
      },
      // Keyed by organization + id: a plugin's id is its catalog id, the same in every organization.
      async get(ownerId, id) {
        const found = plugins.get(ownedKey(ownerId, id));
        return found ? clone(found) : undefined;
      },
      async upsert(record) {
        plugins.set(ownedKey(record.ownerId, record.id), clone(record));
      },
      async remove(ownerId, id) {
        plugins.delete(ownedKey(ownerId, id));
      }
    },
    identity: createMemoryIdentityStore(),
    monitors: createMemoryMonitorStore(),
    notifications: createMemoryNotificationStore(),
    audit: createMemoryAuditStore(),
    meetings: createMemoryMeetingStore(),
    organizations: createMemoryOrganizationStore(),
    credits: createMemoryCreditStore(),
    ...createMemoryAgentStore(),
    async close() {}
  };
}
