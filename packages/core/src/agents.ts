/**
 * Agents: user-created teammates with their own look, voice, access and
 * autonomy, built from the same parts as everything else (tools, skills,
 * knowledge, memory, approvals, budgets). There is no second agent runtime:
 * an agent shapes one brain call (instructions, memory, allowed tools, model,
 * voice) and the gateway enforces its access and autonomy.
 *
 * - Access "inherit": everything its creator may use, checked with the
 *   creator's principal at run time (so it shrinks when they lose rights).
 *   "controlled": the intersection of that with explicit allowlists.
 * - Autonomy: how write actions run (ask first / act then tell / autonomous).
 *   High-risk tools always ask.
 * - Learning: after multi-step runs the agent reflects and proposes skills
 *   and memory ("ask_first"), applies them ("automatic", revertible) or
 *   doesn't ("off").
 */
import type { AvatarSpec } from "./avatar";
import { keywordScore, type SkillRecord } from "./workspace";

export type AgentAccess =
  | { mode: "inherit" }
  | {
      mode: "controlled";
      /** Tool names (built-in, MCP or plugin tools). */
      tools: string[];
      /** Connector / MCP server ids (tool `provider`); every tool of the connector is allowed. */
      connectors: string[];
      knowledgeBaseIds: string[];
      skillIds: string[];
      /** Secret names the agent may reference (${secret:NAME}). */
      secrets: string[];
    };

export type AgentAutonomy = "ask_first" | "act_then_tell" | "autonomous";
export type AgentLearning = "ask_first" | "automatic" | "off";
export type AgentVisibility = "private" | "workspace";

export const AGENT_AUTONOMY: readonly AgentAutonomy[] = ["ask_first", "act_then_tell", "autonomous"];
export const AGENT_LEARNING: readonly AgentLearning[] = ["ask_first", "automatic", "off"];

export interface AgentVoice {
  ttsModel?: string;
  ttsVoice?: string;
  /** Speaking style / personality hint added to the voice prompt ("warm, brisk"). */
  style?: string;
}

/**
 * The agent's own computer: a sandboxed browser with a file area, started on
 * demand and stopped when idle (see docs/agent-computers.md). Absent or
 * `enabled: false`: no computer tools are offered to the agent.
 */
export interface AgentComputerSettings {
  enabled: boolean;
  /** Stop the sandbox after this many idle minutes (default: the gateway's). Bounds: AGENT_COMPUTER_LIMITS in the protocol. */
  idleMinutes?: number;
  /** Computer time per day; the agent's computer pauses at the cap (default: the gateway's). */
  dailyMinutes?: number;
}

export interface AgentRecord {
  id: string;
  /** Organization. */
  ownerId: string;
  workspaceId: string;
  /** User id of the creator (absent or "local"/"token": the org owner in single-owner mode). */
  createdBy: string;
  name: string;
  description: string;
  avatar: AvatarSpec;
  voice?: AgentVoice;
  /** How the agent works (its system instructions). */
  instructions: string;
  /** Model preset id from the catalog (e.g. "balanced", "best") or an explicit model id. */
  modelPreset?: string;
  access: AgentAccess;
  autonomy: AgentAutonomy;
  learning: AgentLearning;
  budget?: { dailyUsd?: number; monthlyUsd?: number };
  /** Its own sandboxed computer (browser + files). */
  computer?: AgentComputerSettings;
  visibility: AgentVisibility;
  /** Starter template it was created from. */
  templateId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Per-agent memory.
 * - "fact": curated profile lines (what it knows about the user and team),
 *   injected into the prompt (capped at AGENT_MEMORY_MAX_CHARS).
 * - "run": a short log of a past run (task and outcome), searchable (FTS).
 */
export interface AgentMemoryItem {
  id: string;
  ownerId: string;
  agentId: string;
  kind: "fact" | "run";
  text: string;
  /** Who wrote it: the person, or the agent while learning. */
  source: "user" | "agent";
  runId?: string;
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
}

export type SkillProposalStatus = "pending" | "applied" | "rejected" | "rolled_back";

export interface SkillDraft {
  /** Slug [a-z0-9-]{1,64}. */
  name: string;
  title: string;
  description: string;
  /** Markdown body. */
  instructions: string;
}

/**
 * Something an agent learned: a new skill, an edit to one, or a memory line.
 * With learning "ask_first" it waits for the person ("pending"); with
 * "automatic" it is applied straight away ("applied") and can be rolled back.
 */
export interface SkillProposal {
  id: string;
  ownerId: string;
  agentId: string;
  workspaceId?: string;
  kind: "new" | "edit" | "memory";
  /** Skill draft (kinds "new" and "edit"). */
  skill?: SkillDraft;
  /** Skill being edited (kind "edit"), or the skill created when applied (kind "new"). */
  skillId?: string;
  /** Memory line (kind "memory"). */
  memory?: string;
  /** Memory item created when applied (kind "memory"). */
  memoryItemId?: string;
  /** The skill before the edit was applied (for rollback). */
  previous?: SkillRecord;
  rationale: string;
  sourceRunId: string;
  status: SkillProposalStatus;
  createdAt: number;
  decidedAt?: number;
  /** Who decided (user id), or "agent" when applied automatically. */
  decidedBy?: string;
}

/** Curated memory injected into an agent's prompt is capped at this many characters. */
export const AGENT_MEMORY_MAX_CHARS = 2_000;
/** Run logs kept per agent (oldest are pruned). */
export const AGENT_RUN_LOG_LIMIT = 200;

export interface AgentStore {
  agents: {
    /**
     * Agents of an organization. `workspaceId` limits to one workspace;
     * `visibleTo` keeps workspace-visible agents plus the private ones that
     * user created. Ordered by name.
     */
    list(ownerId: string, filter?: { workspaceId?: string; visibleTo?: string }): Promise<AgentRecord[]>;
    get(ownerId: string, id: string): Promise<AgentRecord | undefined>;
    upsert(record: AgentRecord): Promise<void>;
    /** Removes the agent with its memory and proposals. */
    remove(ownerId: string, id: string): Promise<void>;
  };
  agentMemory: {
    /** Newest first. */
    list(ownerId: string, agentId: string, filter?: { kind?: AgentMemoryItem["kind"]; limit?: number }): Promise<AgentMemoryItem[]>;
    get(ownerId: string, id: string): Promise<AgentMemoryItem | undefined>;
    upsert(record: AgentMemoryItem): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
    /** Keyword search (FTS5 in SQLite) over one agent's memory, best first. */
    search(ownerId: string, agentId: string, query: string, limit?: number): Promise<AgentMemoryItem[]>;
  };
  skillProposals: {
    /** Newest first. */
    list(ownerId: string, filter?: { agentId?: string; status?: SkillProposalStatus }): Promise<SkillProposal[]>;
    get(ownerId: string, id: string): Promise<SkillProposal | undefined>;
    upsert(record: SkillProposal): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
  };
}

/** Can this user see (and use) the agent? Private agents are their creator's alone. */
export function agentVisibleTo(agent: Pick<AgentRecord, "visibility" | "createdBy">, userId: string | undefined): boolean {
  return agent.visibility === "workspace" || !userId || agent.createdBy === userId;
}

/** In-memory AgentStore (part of createMemoryStore). */
export function createMemoryAgentStore(): AgentStore {
  const agents = new Map<string, AgentRecord>();
  const memory = new Map<string, AgentMemoryItem>();
  const proposals = new Map<string, SkillProposal>();
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    agents: {
      async list(ownerId, filter = {}) {
        return [...agents.values()]
          .filter(
            (a) =>
              a.ownerId === ownerId &&
              (!filter.workspaceId || a.workspaceId === filter.workspaceId) &&
              (filter.visibleTo === undefined || agentVisibleTo(a, filter.visibleTo))
          )
          .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt)
          .map(clone);
      },
      async get(ownerId, id) {
        const found = agents.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async upsert(record) {
        agents.set(record.id, clone(record));
      },
      async remove(ownerId, id) {
        if (agents.get(id)?.ownerId !== ownerId) return;
        agents.delete(id);
        for (const [key, item] of memory) if (item.agentId === id) memory.delete(key);
        for (const [key, item] of proposals) if (item.agentId === id) proposals.delete(key);
      }
    },
    agentMemory: {
      async list(ownerId, agentId, filter = {}) {
        const items = [...memory.values()]
          .filter((m) => m.ownerId === ownerId && m.agentId === agentId && (!filter.kind || m.kind === filter.kind))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return (filter.limit ? items.slice(0, filter.limit) : items).map(clone);
      },
      async get(ownerId, id) {
        const found = memory.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async upsert(record) {
        memory.set(record.id, clone(record));
      },
      async remove(ownerId, id) {
        if (memory.get(id)?.ownerId === ownerId) memory.delete(id);
      },
      async search(ownerId, agentId, query, limit = 8) {
        return [...memory.values()]
          .filter((m) => m.ownerId === ownerId && m.agentId === agentId)
          .map((item) => ({ item, score: keywordScore(item.text, query) }))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((hit) => clone(hit.item));
      }
    },
    skillProposals: {
      async list(ownerId, filter = {}) {
        return [...proposals.values()]
          .filter((p) => p.ownerId === ownerId && (!filter.agentId || p.agentId === filter.agentId) && (!filter.status || p.status === filter.status))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(clone);
      },
      async get(ownerId, id) {
        const found = proposals.get(id);
        return found && found.ownerId === ownerId ? clone(found) : undefined;
      },
      async upsert(record) {
        proposals.set(record.id, clone(record));
      },
      async remove(ownerId, id) {
        if (proposals.get(id)?.ownerId === ownerId) proposals.delete(id);
      }
    }
  };
}
