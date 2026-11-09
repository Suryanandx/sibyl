/**
 * Agents at run time: CRUD with permission checks, the per-turn shaping of a
 * brain call (prompt, tools, model, voice, approvals, budget), run logs and
 * the learning loop (proposals, apply, rollback).
 *
 * The gateway (typed chat, voice turns, deep brain) and the routine runner
 * call `prepareTurn()` and use the returned AgentTurn instead of their
 * defaults; without an agent nothing changes.
 */
import { randomUUID } from "node:crypto";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import {
  AGENT_RUN_LOG_LIMIT,
  PERMISSIONS,
  agentVisibleTo,
  authorize,
  normalizeAvatar,
  type AgentMemoryItem,
  type AgentRecord,
  type BudgetDecision,
  type Principal,
  type SkillDraft,
  type SkillProposal,
  type SkillRecord,
  type Store,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type UsageMeter
} from "@open-gpt-live/core";
import type { AgentInput, AgentView, ModelCatalog, SkillProposalView } from "@open-gpt-live/protocol";
import type { ApprovalOutcome } from "../brain/approvals.js";
import type { NotificationInput } from "../notifications/service.js";
import { GatewayUsageMeter, type AgentSpend } from "../metering/meter.js";
import { agentTools, creatorId, creatorPrincipal, isHighRisk, principalMayUse, secretRefusal } from "./access.js";
import { MIN_STEPS_FOR_REFLECTION, reflect, shouldReflect, slug, type ReflectionResult, type RunSummary } from "./learning.js";
import { agentSystemBlock } from "./prompt.js";
import { AGENT_TOOL_NAMES, createAgentTools } from "./tools.js";

type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface AgentRuntimeOptions {
  store: Store;
  ownerId: string;
  tools: ToolRegistry;
  meter: UsageMeter;
  log: Log;
  createId?(): string;
  now?(): number;
  /** "Act, then tell me" notices; wired to the notifications module's publish path. */
  notify?(notification: NotificationInput): void;
}

export interface AgentTurn {
  agent: AgentRecord;
  /** The creator's current principal (undefined: creator gone, the agent can use no tools). */
  creator: Principal | undefined;
  /** What the agent's tool calls carry as `ToolContext.agent` (its knowledge and skill limits, when controlled). */
  scope: AgentScope;
  /** Appended to the chat / deep-brain system prompt. */
  systemBlock: string;
  /** Appended to the live voice prompt (adds the voice style). */
  voiceBlock: string;
  /** Allowed tools for this run (filtered, wrapped) plus the agent's own tools. */
  tools(base: ToolDefinition<any, any>[]): ToolDefinition<any, any>[];
  /** Autonomy: decide a write call (asks via `ask` when the agent must). */
  approve(request: { tool: ToolDefinition<any, any>; input: Record<string, unknown> }, ask: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
  /** The agent's own budget (and the owner's) before spending ~estimateUsd. */
  budget(estimateUsd: number): BudgetDecision;
  /** Count spend of this request toward the agent's budget. */
  bindRequest(requestId: string): void;
  /** Record a tool step of the run (for the learning loop). */
  noteStep(step: { toolName: string; title: string; status: string }): void;
  /** After the reply: run log, spend, learning. Never throws. */
  finish(run: { runId: string; task: string; reply: string; conversationId?: string; reflectWith?: { provider: ToolChatProvider; model: string } }): Promise<void>;
}

export type AgentScope = NonNullable<ToolContext["agent"]>;

const SPEND_KEY = (agentId: string): string => `agents.spend.${agentId}`;
const MAX_PROMPT_SKILLS = 30;

export class AgentRuntime {
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly seeded = new Set<string>();
  /** Reflections in flight (tests await them). */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(readonly options: AgentRuntimeOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  /* ───────────── change notifications ───────────── */

  /** Agents, proposals or memory changed (connections refresh their lists). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A closing socket.
      }
    }
  }

  /** Wait for background learning (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /* ───────────── queries & permissions ───────────── */

  async list(principal: Principal, workspaceId: string): Promise<AgentRecord[]> {
    if (!authorize(principal, PERMISSIONS.AGENTS_USE, { workspaceId })) return [];
    return this.options.store.agents.list(this.options.ownerId, { workspaceId, visibleTo: principal.userId ?? "" });
  }

  /** An agent the principal may use in this workspace. */
  async get(principal: Principal | undefined, workspaceId: string, id: string): Promise<AgentRecord | undefined> {
    const agent = await this.options.store.agents.get(this.options.ownerId, id);
    if (!agent || agent.workspaceId !== workspaceId) return undefined;
    if (principal && (!authorize(principal, PERMISSIONS.AGENTS_USE, { workspaceId }) || !agentVisibleTo(agent, principal.userId))) return undefined;
    return agent;
  }

  /** Creator, or anyone who may share agents (admins), may edit an agent. */
  canEdit(principal: Principal, agent: AgentRecord): boolean {
    const own = agent.createdBy === creatorId(principal) && authorize(principal, PERMISSIONS.AGENTS_CREATE, { workspaceId: agent.workspaceId });
    return own || authorize(principal, PERMISSIONS.AGENTS_SHARE, { workspaceId: agent.workspaceId });
  }

  /** "@Name …" at the start of a message picks a visible agent; returns the rest of the text. */
  async findByMention(principal: Principal, workspaceId: string, text: string): Promise<{ agent: AgentRecord; text: string } | undefined> {
    const match = /^\s*@(\S)/.exec(text);
    if (!match) return undefined;
    const body = text.trimStart().slice(1);
    const lower = body.toLowerCase();
    const agents = (await this.list(principal, workspaceId)).sort((a, b) => b.name.length - a.name.length);
    for (const agent of agents) {
      for (const candidate of [agent.name, agent.name.replace(/\s+/g, ""), agent.name.replace(/\s+/g, "-"), agent.name.replace(/\s+/g, "_")]) {
        const name = candidate.toLowerCase();
        if (lower.startsWith(name) && (lower.length === name.length || /[\s,.:;!?]/.test(lower[name.length]!))) {
          return { agent, text: body.slice(name.length).replace(/^[\s,.:;!?]+/, "").trim() };
        }
      }
    }
    return undefined;
  }

  async view(agent: AgentRecord, principal: Principal): Promise<AgentView> {
    const pending = await this.options.store.skillProposals.list(this.options.ownerId, { agentId: agent.id, status: "pending" });
    const spend = this.spend(agent.id);
    const { ownerId: _owner, ...rest } = agent;
    return {
      ...rest,
      mine: agent.createdBy === creatorId(principal),
      canEdit: this.canEdit(principal, agent),
      pendingProposals: pending.length,
      ...(spend ? { spend: { todayUsd: round(spend.todayUsd), monthUsd: round(spend.monthUsd) } } : {})
    };
  }

  /* ───────────── create, update, delete ───────────── */

  async save(principal: Principal, workspaceId: string, input: AgentInput): Promise<AgentRecord | string> {
    const now = this.now();
    if (input.visibility === "workspace" && !authorize(principal, PERMISSIONS.AGENTS_SHARE, { workspaceId })) {
      return "Only workspace admins can share agents with the workspace. Keep it private, or ask an admin.";
    }
    const fields = {
      name: input.name.trim(),
      description: input.description.trim(),
      instructions: input.instructions,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.modelPreset ? { modelPreset: input.modelPreset } : {}),
      access: input.access,
      autonomy: input.autonomy,
      learning: input.learning,
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.computer ? { computer: input.computer } : {}),
      visibility: input.visibility,
      ...(input.templateId ? { templateId: input.templateId } : {})
    };
    if (input.id) {
      const existing = await this.get(principal, workspaceId, input.id);
      if (!existing) return "Agent not found.";
      if (!this.canEdit(principal, existing)) return "You can only edit agents you created.";
      const record: AgentRecord = {
        id: existing.id,
        ownerId: existing.ownerId,
        workspaceId: existing.workspaceId,
        createdBy: existing.createdBy,
        avatar: normalizeAvatar(input.avatar, existing.id),
        ...fields,
        createdAt: existing.createdAt,
        updatedAt: now
      };
      await this.options.store.agents.upsert(record);
      this.changed();
      return record;
    }
    if (!authorize(principal, PERMISSIONS.AGENTS_CREATE, { workspaceId })) return "You don't have permission to create agents in this workspace.";
    const id = this.createId();
    const record: AgentRecord = {
      id,
      ownerId: this.options.ownerId,
      workspaceId,
      createdBy: creatorId(principal),
      avatar: normalizeAvatar(input.avatar, id),
      ...fields,
      createdAt: now,
      updatedAt: now
    };
    await this.options.store.agents.upsert(record);
    this.options.log("agents.created", { agentId: id, workspaceId });
    this.changed();
    return record;
  }

  async remove(principal: Principal, workspaceId: string, id: string): Promise<string | undefined> {
    const agent = await this.get(principal, workspaceId, id);
    if (!agent) return "Agent not found.";
    if (!this.canEdit(principal, agent)) return "You can only delete agents you created.";
    // Learned skills go with the agent.
    for (const skill of await this.options.store.skills.list(this.options.ownerId)) {
      if (skill.source === "agent" && skill.agentId === id) await this.options.store.skills.remove(this.options.ownerId, skill.id);
    }
    await this.options.store.agents.remove(this.options.ownerId, id);
    await this.options.store.kv.delete(this.options.ownerId, SPEND_KEY(id));
    this.changed();
    return undefined;
  }

  /* ───────────── a turn ───────────── */

  /** Skills the agent may load: its allowlist (controlled) or every enabled one, plus what it learned. */
  async skillsFor(agent: AgentRecord, creator: Principal | undefined): Promise<SkillRecord[]> {
    const all = await this.options.store.skills.list(this.options.ownerId, { workspaceId: agent.workspaceId });
    const own = all.filter((skill) => skill.source === "agent" && skill.agentId === agent.id && skill.enabled);
    const mayUse = authorize(creator, PERMISSIONS.SKILLS_USE, { workspaceId: agent.workspaceId });
    const shared = !mayUse
      ? []
      : all.filter(
          (skill) =>
            skill.enabled &&
            skill.source !== "agent" &&
            (agent.access.mode === "inherit" || agent.access.skillIds.includes(skill.id) || agent.access.skillIds.includes(skill.name))
        );
    return [...own, ...shared].slice(0, MAX_PROMPT_SKILLS);
  }

  async knowledgeFor(agent: AgentRecord, creator: Principal | undefined): Promise<Array<{ id: string; name: string }>> {
    if (!authorize(creator, PERMISSIONS.KNOWLEDGE_VIEW, { workspaceId: agent.workspaceId })) return [];
    const bases = await this.options.store.knowledge.listBases(this.options.ownerId, { workspaceId: agent.workspaceId });
    const allowed = agent.access.mode === "inherit" ? bases : bases.filter((kb) => (agent.access as { knowledgeBaseIds: string[] }).knowledgeBaseIds.includes(kb.id));
    return allowed.map((kb) => ({ id: kb.id, name: kb.name }));
  }

  async prepareTurn(input: { agent: AgentRecord; caller?: Principal; workspaceId?: string }): Promise<AgentTurn> {
    const { agent, caller } = input;
    const workspaceId = input.workspaceId ?? agent.workspaceId;
    const { store, ownerId, meter } = this.options;
    await this.seedSpend(agent.id);
    const creator = await creatorPrincipal(store, ownerId, agent.createdBy);
    const [memory, skills, knowledge] = await Promise.all([
      store.agentMemory.list(ownerId, agent.id, { kind: "fact", limit: 60 }),
      this.skillsFor(agent, creator),
      this.knowledgeFor(agent, creator)
    ]);
    const blockInput = { agent, memory, skills, knowledgeBases: knowledge };
    const steps: Array<{ toolName: string; title: string; status: string }> = [];
    /** Write calls auto-approved by autonomy, waiting to be reported after they run. */
    const toTell: string[] = [];
    const scope: AgentScope = {
      id: agent.id,
      ...(agent.access.mode === "controlled" ? { knowledgeBaseIds: knowledge.map((kb) => kb.id), skillIds: skills.map((s) => s.id) } : {})
    };
    const ownTools = createAgentTools({
      agent,
      skills,
      knowledgeBaseIds: knowledge.map((kb) => kb.id),
      remember: (text, runId) => this.rememberFromRun(agent, text, runId)
    });

    const wrap = (tool: ToolDefinition<any, any>): ToolDefinition<any, any> => ({
      ...tool,
      run: async (args, context) => {
        // Checked again when the call runs: the creator's rights may have changed mid-run.
        if (!principalMayUse(creator, tool, workspaceId)) {
          return { content: `${agent.name} is not allowed to use ${tool.title} (its creator no longer has access).`, isError: true };
        }
        const refused = secretRefusal(agent, args);
        if (refused) return { content: refused, isError: true };
        const result = await tool.run(args, { ...context, agent: scope });
        const told = toTell.indexOf(tool.name);
        if (told >= 0) {
          toTell.splice(told, 1);
          this.tell(agent, tool, args, { workspaceId, ...(caller?.kind === "user" && caller.userId ? { userId: caller.userId } : {}), ...(context.conversationId ? { conversationId: context.conversationId } : {}) }, Boolean(result.isError));
        }
        return result;
      }
    });

    return {
      agent,
      creator,
      scope,
      systemBlock: agentSystemBlock(blockInput),
      voiceBlock: agentSystemBlock({ ...blockInput, voice: true }),
      tools: (base) => {
        const allowed = agentTools({ agent, tools: base.filter((tool) => !AGENT_TOOL_NAMES.has(tool.name)), creator, ...(caller ? { caller } : {}), workspaceId });
        return [...allowed.map(wrap), ...(creator ? ownTools : [])];
      },
      approve: async ({ tool }, ask) => {
        if (tool.effect !== "write") return "approved";
        if (agent.autonomy === "ask_first" || isHighRisk(tool)) return ask();
        if (agent.autonomy === "act_then_tell") toTell.push(tool.name);
        this.options.log("agents.auto_approved", { agentId: agent.id, toolName: tool.name, autonomy: agent.autonomy });
        return "approved";
      },
      budget: (estimateUsd) =>
        meter.check({
          ownerId,
          estimateUsd,
          agent: { id: agent.id, name: agent.name, ...(agent.budget?.dailyUsd !== undefined ? { dailyUsd: agent.budget.dailyUsd } : {}), ...(agent.budget?.monthlyUsd !== undefined ? { monthlyUsd: agent.budget.monthlyUsd } : {}) }
        }),
      bindRequest: (requestId) => {
        if (meter instanceof GatewayUsageMeter) meter.bindAgent(requestId, agent.id);
      },
      noteStep: (step) => {
        steps.push(step);
      },
      finish: async (run) => {
        try {
          // "That's how we do it" usually refers to the previous task: give the reflection that context.
          const [previous] = steps.length < MIN_STEPS_FOR_REFLECTION ? await store.agentMemory.list(ownerId, agent.id, { kind: "run", limit: 1 }) : [];
          await this.logRun(agent, { ...run, steps: [...steps] });
          await this.persistSpend(agent.id);
          if (agent.learning !== "off" && run.reflectWith && shouldReflect({ steps, feedback: run.task })) {
            const task = previous ? `Previous task — ${previous.text}\nNow the user says: ${run.task}` : run.task;
            const job = this.reflectAndLearn(agent, { runId: run.runId, task, reply: run.reply, steps: [...steps], feedback: run.task }, run.reflectWith);
            this.pending.add(job);
            void job.finally(() => this.pending.delete(job));
          }
        } catch (error) {
          this.options.log("agents.finish_failed", { agentId: agent.id, error: errorMessage(error) });
        } finally {
          steps.length = 0;
        }
      }
    };
  }

  /** "Act, then tell me": a notice in the inbox after the agent acted on its own. */
  private tell(
    agent: AgentRecord,
    tool: ToolDefinition<any, any>,
    args: Record<string, unknown>,
    run: { workspaceId: string; userId?: string; conversationId?: string },
    failed: boolean
  ): void {
    const what = describeCall(tool, args);
    // For the person the agent worked for (in chat), else its creator (routines, monitors).
    const recipient = run.userId ?? (agent.createdBy && agent.createdBy !== "owner" ? agent.createdBy : undefined);
    this.options.notify?.({
      kind: "agent_action",
      workspaceId: run.workspaceId,
      ...(recipient ? { recipientUserId: recipient } : {}),
      title: failed ? `${agent.name} couldn't finish an action` : `${agent.name} acted on its own`,
      body: failed ? `${agent.name} tried to ${what}, but it failed.` : `${agent.name} ${what.replace(/^(\w+)/, (verb) => pastTense(verb))}.`,
      links: { agentId: agent.id, ...(run.conversationId ? { conversationId: run.conversationId } : {}) }
    });
  }

  /* ───────────── memory & run logs ───────────── */

  private async logRun(agent: AgentRecord, run: { runId: string; task: string; reply: string; conversationId?: string; steps: Array<{ title: string }> }): Promise<void> {
    const { store, ownerId } = this.options;
    const did = run.steps.length ? ` Steps: ${[...new Set(run.steps.map((s) => s.title))].join(", ")}.` : "";
    const text = `Asked: ${oneLine(run.task, 300)}.${did} Answer: ${oneLine(run.reply, 400)}`;
    const now = this.now();
    await store.agentMemory.upsert({
      id: this.createId(),
      ownerId,
      agentId: agent.id,
      kind: "run",
      text,
      source: "agent",
      runId: run.runId,
      ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      createdAt: now,
      updatedAt: now
    });
    const runs = await store.agentMemory.list(ownerId, agent.id, { kind: "run" });
    for (const old of runs.slice(AGENT_RUN_LOG_LIMIT)) await store.agentMemory.remove(ownerId, old.id);
  }

  /** agent_remember: keep the fact now (learning automatic) or as a proposal (ask first). */
  private async rememberFromRun(agent: AgentRecord, text: string, runId: string): Promise<string> {
    if (agent.learning === "off") return "Learning is off for this agent; nothing was saved.";
    const proposal = await this.propose(agent, { kind: "memory", memory: text, rationale: "Asked to remember during a task.", sourceRunId: runId });
    return proposal.status === "applied" ? "Saved to memory." : "Suggested to the user; it is kept once they approve.";
  }

  async listMemory(principal: Principal, workspaceId: string, agentId: string): Promise<AgentMemoryItem[] | string> {
    const agent = await this.get(principal, workspaceId, agentId);
    if (!agent) return "Agent not found.";
    return this.options.store.agentMemory.list(this.options.ownerId, agentId, { limit: 200 });
  }

  async saveMemory(principal: Principal, workspaceId: string, agentId: string, itemId: string | undefined, text: string): Promise<string | undefined> {
    const agent = await this.get(principal, workspaceId, agentId);
    if (!agent) return "Agent not found.";
    if (!this.canEdit(principal, agent)) return "Only the agent's creator can change its memory.";
    const now = this.now();
    const existing = itemId ? await this.options.store.agentMemory.get(this.options.ownerId, itemId) : undefined;
    if (itemId && (!existing || existing.agentId !== agentId)) return "Memory item not found.";
    await this.options.store.agentMemory.upsert(
      existing
        ? { ...existing, text, source: "user", updatedAt: now }
        : { id: this.createId(), ownerId: this.options.ownerId, agentId, kind: "fact", text, source: "user", createdAt: now, updatedAt: now }
    );
    this.changed();
    return undefined;
  }

  async deleteMemory(principal: Principal, workspaceId: string, agentId: string, itemId: string): Promise<string | undefined> {
    const agent = await this.get(principal, workspaceId, agentId);
    if (!agent) return "Agent not found.";
    if (!this.canEdit(principal, agent)) return "Only the agent's creator can change its memory.";
    const existing = await this.options.store.agentMemory.get(this.options.ownerId, itemId);
    if (!existing || existing.agentId !== agentId) return "Memory item not found.";
    await this.options.store.agentMemory.remove(this.options.ownerId, itemId);
    this.changed();
    return undefined;
  }

  /* ───────────── learning ───────────── */

  /** Reflect on a run (one cheap metered call) and turn the result into proposals. */
  async reflectAndLearn(agent: AgentRecord, run: RunSummary, using: { provider: ToolChatProvider; model: string }): Promise<SkillProposal[]> {
    const { store, ownerId, meter } = this.options;
    try {
      const decision = meter.check({ ownerId, estimateUsd: 0.002, agent: { id: agent.id, name: agent.name, ...agent.budget } });
      if (!decision.allowed) return [];
      const [skills, memory] = await Promise.all([this.skillsFor(agent, await creatorPrincipal(store, ownerId, agent.createdBy)), store.agentMemory.list(ownerId, agent.id, { kind: "fact", limit: 40 })]);
      const requestId = `reflect-${run.runId}`;
      const result = await reflect({ provider: using.provider, model: using.model, agent, run, skills, memory, meter, ownerId, requestId });
      await this.persistSpend(agent.id);
      return await this.learn(agent, result, run.runId);
    } catch (error) {
      this.options.log("agents.reflection_failed", { agentId: agent.id, error: errorMessage(error) });
      return [];
    }
  }

  /** Turn a reflection into proposals; "automatic" applies them right away. */
  async learn(agent: AgentRecord, result: ReflectionResult, sourceRunId: string): Promise<SkillProposal[]> {
    if (agent.learning === "off") return [];
    const out: SkillProposal[] = [];
    for (const skill of result.skills) {
      out.push(await this.propose(agent, { kind: skill.kind, skill: skill.draft, ...(skill.skillId ? { skillId: skill.skillId } : {}), rationale: skill.rationale, sourceRunId }));
    }
    for (const memory of result.memory) {
      out.push(await this.propose(agent, { kind: "memory", memory: memory.text, rationale: memory.rationale, sourceRunId }));
    }
    if (out.length) this.options.log("agents.learned", { agentId: agent.id, proposals: out.length, applied: out.filter((p) => p.status === "applied").length });
    return out;
  }

  private async propose(
    agent: AgentRecord,
    input: { kind: SkillProposal["kind"]; skill?: SkillDraft; skillId?: string; memory?: string; rationale: string; sourceRunId: string }
  ): Promise<SkillProposal> {
    const proposal: SkillProposal = {
      id: this.createId(),
      ownerId: this.options.ownerId,
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      kind: input.kind,
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.memory ? { memory: input.memory } : {}),
      rationale: input.rationale,
      sourceRunId: input.sourceRunId,
      status: "pending",
      createdAt: this.now()
    };
    let saved = proposal;
    if (agent.learning === "automatic") {
      // Edits to skills people wrote always wait for a person.
      const target = proposal.kind === "edit" && proposal.skillId ? await this.options.store.skills.get(this.options.ownerId, proposal.skillId) : undefined;
      if (proposal.kind !== "edit" || target?.source === "agent") saved = await this.apply(proposal, "agent");
      else await this.options.store.skillProposals.upsert(proposal);
    } else {
      await this.options.store.skillProposals.upsert(proposal);
    }
    this.changed();
    return saved;
  }

  /** Apply a proposal: write the skill (versioned, source "agent") or the memory line. */
  private async apply(proposal: SkillProposal, decidedBy: string, edits: { skill?: SkillDraft; memory?: string } = {}): Promise<SkillProposal> {
    const { store, ownerId } = this.options;
    const now = this.now();
    const next: SkillProposal = { ...proposal, status: "applied", decidedAt: now, decidedBy };
    if (proposal.kind === "memory") {
      const text = edits.memory ?? proposal.memory ?? "";
      const item: AgentMemoryItem = { id: this.createId(), ownerId, agentId: proposal.agentId, kind: "fact", text, source: "agent", runId: proposal.sourceRunId, createdAt: now, updatedAt: now };
      await store.agentMemory.upsert(item);
      next.memory = text;
      next.memoryItemId = item.id;
    } else {
      const draft = edits.skill ?? proposal.skill!;
      next.skill = draft;
      const existing = proposal.kind === "edit" && proposal.skillId ? await store.skills.get(ownerId, proposal.skillId) : undefined;
      if (proposal.kind === "edit" && existing) {
        next.previous = existing;
        await store.skills.upsert({
          ...existing,
          title: draft.title,
          description: draft.description,
          instructions: draft.instructions,
          version: String((Number.parseInt(existing.version ?? "1", 10) || 1) + 1),
          updatedAt: now
        });
      } else {
        const id = this.createId();
        const skill: SkillRecord = {
          id,
          ownerId,
          ...(proposal.workspaceId ? { workspaceId: proposal.workspaceId } : {}),
          name: await this.uniqueSkillName(draft.name || slug(draft.title)),
          title: draft.title,
          description: draft.description,
          instructions: draft.instructions,
          source: "agent",
          agentId: proposal.agentId,
          enabled: true,
          version: "1",
          createdAt: now,
          updatedAt: now
        };
        await store.skills.upsert(skill);
        next.kind = "new";
        next.skillId = id;
      }
    }
    await store.skillProposals.upsert(next);
    return next;
  }

  private async rollback(proposal: SkillProposal): Promise<SkillProposal> {
    const { store, ownerId } = this.options;
    if (proposal.kind === "memory" && proposal.memoryItemId) await store.agentMemory.remove(ownerId, proposal.memoryItemId);
    else if (proposal.kind === "edit" && proposal.previous) await store.skills.upsert(proposal.previous);
    else if (proposal.kind === "new" && proposal.skillId) await store.skills.remove(ownerId, proposal.skillId);
    const next: SkillProposal = { ...proposal, status: "rolled_back", decidedAt: this.now() };
    await store.skillProposals.upsert(next);
    return next;
  }

  async listProposals(principal: Principal, workspaceId: string, agentId?: string): Promise<SkillProposalView[]> {
    const visible = new Set((await this.list(principal, workspaceId)).map((agent) => agent.id));
    const proposals = (await this.options.store.skillProposals.list(this.options.ownerId, agentId ? { agentId } : {})).filter((p) => visible.has(p.agentId));
    return Promise.all(proposals.slice(0, 200).map((p) => this.proposalView(p)));
  }

  async proposalView(proposal: SkillProposal): Promise<SkillProposalView> {
    const current =
      proposal.kind === "edit" && proposal.status === "pending" && proposal.skillId ? await this.options.store.skills.get(this.options.ownerId, proposal.skillId) : proposal.previous;
    return {
      id: proposal.id,
      agentId: proposal.agentId,
      kind: proposal.kind,
      ...(proposal.skill ? { skill: proposal.skill } : {}),
      ...(proposal.kind === "edit" && current ? { currentSkill: { name: current.name, title: current.title, description: current.description, instructions: current.instructions } } : {}),
      ...(proposal.skillId ? { skillId: proposal.skillId } : {}),
      ...(proposal.memory ? { memory: proposal.memory } : {}),
      rationale: proposal.rationale,
      status: proposal.status,
      createdAt: proposal.createdAt,
      ...(proposal.decidedAt === undefined ? {} : { decidedAt: proposal.decidedAt })
    };
  }

  async decideProposal(
    principal: Principal,
    workspaceId: string,
    proposalId: string,
    decision: "approve" | "reject" | "rollback",
    edits: { skill?: SkillDraft; memory?: string } = {}
  ): Promise<SkillProposal | string> {
    const proposal = await this.options.store.skillProposals.get(this.options.ownerId, proposalId);
    const agent = proposal ? await this.get(principal, workspaceId, proposal.agentId) : undefined;
    if (!proposal || !agent) return "That suggestion is no longer available.";
    if (!this.canEdit(principal, agent)) return "Only the agent's creator (or a workspace admin) can review what it learned.";
    let result: SkillProposal;
    if (decision === "rollback") {
      if (proposal.status !== "applied") return "Only applied changes can be rolled back.";
      result = await this.rollback(proposal);
    } else {
      if (proposal.status !== "pending") return "This suggestion was already decided.";
      result =
        decision === "approve"
          ? await this.apply(proposal, creatorId(principal), edits)
          : await this.options.store.skillProposals.upsert({ ...proposal, status: "rejected", decidedAt: this.now(), decidedBy: creatorId(principal) }).then(() => ({ ...proposal, status: "rejected" as const }));
    }
    this.changed();
    return result;
  }

  /* ───────────── budgets ───────────── */

  spend(agentId: string): AgentSpend | undefined {
    const meter = this.options.meter;
    return meter instanceof GatewayUsageMeter ? meter.agentTotals(this.options.ownerId, agentId) : undefined;
  }

  private async seedSpend(agentId: string): Promise<void> {
    const meter = this.options.meter;
    if (this.seeded.has(agentId) || !(meter instanceof GatewayUsageMeter)) return;
    this.seeded.add(agentId);
    try {
      const saved = await this.options.store.kv.get<AgentSpend>(this.options.ownerId, SPEND_KEY(agentId));
      if (saved && typeof saved.todayUsd === "number") meter.seedAgentSpend(this.options.ownerId, agentId, saved);
    } catch {
      // Starts from zero.
    }
  }

  private async persistSpend(agentId: string): Promise<void> {
    const spend = this.spend(agentId);
    if (spend) await this.options.store.kv.set(this.options.ownerId, SPEND_KEY(agentId), spend);
  }

  private async uniqueSkillName(base: string): Promise<string> {
    const name = slug(base) || "learned-skill";
    const taken = new Set((await this.options.store.skills.list(this.options.ownerId)).map((skill) => skill.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 1_000; i += 1) {
      const candidate = `${name.slice(0, 60)}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${name.slice(0, 50)}-${this.createId().slice(0, 8)}`;
  }
}

/** The model an agent's preset points at: a catalog preset's llm model, or a model id. */
export function resolveAgentModel(agent: Pick<AgentRecord, "modelPreset">, catalog: ModelCatalog | undefined): string | undefined {
  const preset = agent.modelPreset;
  if (!preset || !catalog) return undefined;
  const fromPreset = catalog.presets?.find((p) => p.id === preset)?.settings.llmModel;
  if (fromPreset) return fromPreset;
  return catalog.llm.some((model) => model.id === preset) ? preset : undefined;
}

/** The agent's voice, when the catalog offers it (otherwise the session's voice is kept). */
export function resolveAgentVoice(agent: Pick<AgentRecord, "voice">, catalog: ModelCatalog | undefined, currentTtsModel: string | undefined): { ttsModel?: string; ttsVoice?: string } {
  const voice = agent.voice;
  if (!voice) return {};
  const ttsModelId = voice.ttsModel && (!catalog || catalog.tts.some((m) => m.id === voice.ttsModel)) ? voice.ttsModel : currentTtsModel;
  const model = catalog?.tts.find((m) => m.id === ttsModelId);
  const ttsVoice = voice.ttsVoice && (!model?.voices?.length || model.voices.includes(voice.ttsVoice)) ? voice.ttsVoice : undefined;
  return { ...(ttsModelId && ttsModelId !== currentTtsModel ? { ttsModel: ttsModelId } : {}), ...(ttsVoice ? { ttsVoice } : {}) };
}

function describeCall(tool: ToolDefinition<any, any>, args: Record<string, unknown>): string {
  const action = tool.title.trim().replace(/[.\s]+$/, "");
  const first = Object.entries(args).find(([key, value]) => typeof value === "string" && value.trim() && !/pass|secret|token|key|auth/i.test(key));
  const lowered = /^[A-Z]{2,}/.test(action) ? action : action.charAt(0).toLowerCase() + action.slice(1);
  return first ? `${lowered} (“${oneLine(String(first[1]), 60)}”)` : lowered;
}

function pastTense(verb: string): string {
  const irregular: Record<string, string> = { send: "sent", make: "made", write: "wrote", run: "ran", set: "set", put: "put", get: "got", take: "took" };
  const lower = verb.toLowerCase();
  if (irregular[lower]) return irregular[lower]!;
  if (lower.endsWith("e")) return `${lower}d`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ied`;
  return `${lower}ed`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
