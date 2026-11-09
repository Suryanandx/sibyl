/**
 * WebSocket handlers for the Agents screen: list, detail, save, delete,
 * select, proposals and memory. Every handler checks permissions itself
 * (agents.use to see and use, agents.create to create, agents.share to share
 * with the workspace or edit someone else's agent).
 */
import { PERMISSIONS, authorize, type Principal } from "@open-gpt-live/core";
import { AGENT_EVENTS, type AgentsClientMessage, type ServerMessage } from "@open-gpt-live/protocol";
import type { AgentRuntime } from "./runtime.js";
import { AGENT_TEMPLATES } from "./templates.js";

export interface AgentsWsContext {
  agents: AgentRuntime;
  principal: Principal;
  workspaceId: string;
  send(message: ServerMessage): void;
  selectedAgentId(): string | undefined;
  select(agentId: string | undefined): void;
}

export async function sendAgentsList(ctx: AgentsWsContext): Promise<void> {
  const { agents, principal, workspaceId } = ctx;
  const records = await agents.list(principal, workspaceId);
  const selected = ctx.selectedAgentId();
  ctx.send({
    type: AGENT_EVENTS.LIST,
    items: await Promise.all(records.map((agent) => agents.view(agent, principal))),
    templates: AGENT_TEMPLATES.map((template) => ({ ...template })),
    ...(selected && records.some((agent) => agent.id === selected) ? { selectedAgentId: selected } : {}),
    canCreate: authorize(principal, PERMISSIONS.AGENTS_CREATE, { workspaceId }),
    canShare: authorize(principal, PERMISSIONS.AGENTS_SHARE, { workspaceId })
  });
}

async function sendDetail(ctx: AgentsWsContext, agentId: string): Promise<void> {
  const agent = await ctx.agents.get(ctx.principal, ctx.workspaceId, agentId);
  if (!agent) {
    ctx.send({ type: "error", message: "Agent not found." });
    return;
  }
  const memory = await ctx.agents.listMemory(ctx.principal, ctx.workspaceId, agentId);
  ctx.send({
    type: AGENT_EVENTS.DETAIL,
    agent: await ctx.agents.view(agent, ctx.principal),
    memory: typeof memory === "string" ? [] : memory.map(memoryView),
    proposals: await ctx.agents.listProposals(ctx.principal, ctx.workspaceId, agentId)
  });
}

function memoryView(item: { id: string; agentId: string; kind: "fact" | "run"; text: string; source: "user" | "agent"; createdAt: number; updatedAt: number }) {
  return { id: item.id, agentId: item.agentId, kind: item.kind, text: item.text, source: item.source, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

export async function handleAgentsMessage(message: AgentsClientMessage, ctx: AgentsWsContext): Promise<void> {
  const { agents, principal, workspaceId } = ctx;
  if (!authorize(principal, PERMISSIONS.AGENTS_USE, { workspaceId })) {
    if (message.type !== AGENT_EVENTS.REQUEST) ctx.send({ type: "error", message: "You don't have permission to use agents in this workspace." });
    return;
  }
  const fail = (text: string): void => ctx.send({ type: "error", message: text });

  switch (message.type) {
    case AGENT_EVENTS.REQUEST:
      return sendAgentsList(ctx);
    case AGENT_EVENTS.VOICE_PREVIEW:
      // Needs the gateway's speech provider: handled by the connection.
      return;
    case AGENT_EVENTS.GET:
      return sendDetail(ctx, message.agentId);
    case AGENT_EVENTS.SAVE: {
      const saved = await agents.save(principal, workspaceId, message.agent);
      if (typeof saved === "string") return fail(saved);
      ctx.send({ type: AGENT_EVENTS.SAVED, agent: await agents.view(saved, principal) });
      return;
    }
    case AGENT_EVENTS.DELETE: {
      const error = await agents.remove(principal, workspaceId, message.agentId);
      if (error) return fail(error);
      if (ctx.selectedAgentId() === message.agentId) ctx.select(undefined);
      return;
    }
    case AGENT_EVENTS.SELECT: {
      if (message.agentId === null) {
        ctx.select(undefined);
        return sendAgentsList(ctx);
      }
      const agent = await agents.get(principal, workspaceId, message.agentId);
      if (!agent) return fail("Agent not found.");
      ctx.select(agent.id);
      return sendAgentsList(ctx);
    }
    case AGENT_EVENTS.PROPOSALS_REQUEST:
      ctx.send({
        type: AGENT_EVENTS.PROPOSALS,
        ...(message.agentId ? { agentId: message.agentId } : {}),
        items: await agents.listProposals(principal, workspaceId, message.agentId)
      });
      return;
    case AGENT_EVENTS.PROPOSAL_DECIDE: {
      const result = await agents.decideProposal(principal, workspaceId, message.proposalId, message.decision, {
        ...(message.skill ? { skill: message.skill } : {}),
        ...(message.memory ? { memory: message.memory } : {})
      });
      if (typeof result === "string") return fail(result);
      ctx.send({ type: AGENT_EVENTS.PROPOSALS, agentId: result.agentId, items: await agents.listProposals(principal, workspaceId, result.agentId) });
      return;
    }
    case AGENT_EVENTS.MEMORY_REQUEST: {
      const items = await agents.listMemory(principal, workspaceId, message.agentId);
      if (typeof items === "string") return fail(items);
      ctx.send({ type: AGENT_EVENTS.MEMORY, agentId: message.agentId, items: items.map(memoryView) });
      return;
    }
    case AGENT_EVENTS.MEMORY_SAVE:
    case AGENT_EVENTS.MEMORY_DELETE: {
      const error =
        message.type === AGENT_EVENTS.MEMORY_SAVE
          ? await agents.saveMemory(principal, workspaceId, message.agentId, message.itemId, message.text)
          : await agents.deleteMemory(principal, workspaceId, message.agentId, message.itemId);
      if (error) return fail(error);
      const items = await agents.listMemory(principal, workspaceId, message.agentId);
      if (typeof items !== "string") ctx.send({ type: AGENT_EVENTS.MEMORY, agentId: message.agentId, items: items.map(memoryView) });
      return;
    }
  }
}
