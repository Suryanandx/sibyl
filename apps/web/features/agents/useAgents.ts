"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_EVENTS,
  type AgentInput,
  type AgentMemoryView,
  type AgentTemplateView,
  type AgentView,
  type ClientMessage,
  type ServerMessage,
  type SkillDraftView,
  type SkillProposalView
} from "@open-gpt-live/protocol";

/**
 * How the Agents feature talks to the gateway: the app's existing WebSocket.
 * The app shell passes `send` and a `subscribe` to incoming messages.
 */
export interface AgentsClient {
  send(message: ClientMessage): void;
  /** Called with every server message; returns an unsubscribe function. */
  subscribe(listener: (message: ServerMessage) => void): () => void;
  /** False while the socket is reconnecting (requests are re-sent when it is back). */
  connected?: boolean;
}

export interface AgentsState {
  loaded: boolean;
  agents: AgentView[];
  templates: AgentTemplateView[];
  selectedAgentId: string | undefined;
  canCreate: boolean;
  canShare: boolean;
  /** Memory and proposals per agent (after `open(id)`). */
  memory: Record<string, AgentMemoryView[]>;
  proposals: Record<string, SkillProposalView[]>;
  /** Last error from the gateway about agents. */
  error: string | undefined;
  /** Which agent answered which request (agent.turn), for avatars next to chat replies. */
  turns: Record<string, { agentId: string; name: string; avatar: AgentView["avatar"] }>;
}

export interface AgentsApi extends AgentsState {
  refresh(): void;
  /** Load an agent's memory and proposals. */
  open(agentId: string): void;
  save(agent: AgentInput): Promise<AgentView>;
  remove(agentId: string): void;
  select(agentId: string | null): void;
  decide(proposalId: string, decision: "approve" | "reject" | "rollback", edits?: { skill?: SkillDraftView; memory?: string }): void;
  saveMemory(agentId: string, text: string, itemId?: string): void;
  deleteMemory(agentId: string, itemId: string): void;
  /** Hear a voice; resolves with a playable data URL. */
  previewVoice(input: { ttsModel?: string; ttsVoice?: string; name?: string }): Promise<string>;
  clearError(): void;
}

const EMPTY: AgentsState = {
  loaded: false,
  agents: [],
  templates: [],
  selectedAgentId: undefined,
  canCreate: false,
  canShare: false,
  memory: {},
  proposals: {},
  error: undefined,
  turns: {}
};

let counter = 0;
const nextId = (): string => `ag${Date.now().toString(36)}${(counter += 1).toString(36)}`;

/** Agents list, detail, edits and the composer selection, kept in sync over the socket. */
export function useAgents(client: AgentsClient | null | undefined): AgentsApi {
  const [state, setState] = useState<AgentsState>(EMPTY);
  const pendingSave = useRef<Array<{ resolve(view: AgentView): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>>([]);
  const pendingVoice = useRef(new Map<string, { resolve(url: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>());

  useEffect(() => {
    if (!client) return;
    const unsubscribe = client.subscribe((message) => {
      switch (message.type) {
        case AGENT_EVENTS.LIST:
          setState((s) => ({
            ...s,
            loaded: true,
            agents: message.items,
            templates: message.templates,
            selectedAgentId: message.selectedAgentId,
            canCreate: message.canCreate,
            canShare: message.canShare
          }));
          return;
        case AGENT_EVENTS.SAVED: {
          setState((s) => ({ ...s, agents: upsert(s.agents, message.agent), error: undefined }));
          const waiter = pendingSave.current.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(message.agent);
          }
          return;
        }
        case AGENT_EVENTS.DETAIL:
          setState((s) => ({
            ...s,
            agents: upsert(s.agents, message.agent),
            memory: { ...s.memory, [message.agent.id]: message.memory },
            proposals: { ...s.proposals, [message.agent.id]: message.proposals }
          }));
          return;
        case AGENT_EVENTS.MEMORY:
          setState((s) => ({ ...s, memory: { ...s.memory, [message.agentId]: message.items } }));
          return;
        case AGENT_EVENTS.PROPOSALS:
          if (message.agentId) {
            const agentId = message.agentId;
            setState((s) => ({
              ...s,
              proposals: { ...s.proposals, [agentId]: message.items },
              agents: s.agents.map((a) => (a.id === agentId ? { ...a, pendingProposals: message.items.filter((p) => p.status === "pending").length } : a))
            }));
          } else {
            const byAgent: Record<string, SkillProposalView[]> = {};
            for (const item of message.items) (byAgent[item.agentId] ??= []).push(item);
            setState((s) => ({ ...s, proposals: { ...s.proposals, ...byAgent } }));
          }
          return;
        case AGENT_EVENTS.TURN:
          setState((s) => {
            const entries = Object.entries(s.turns).slice(-99);
            return { ...s, turns: { ...Object.fromEntries(entries), [message.requestId]: { agentId: message.agentId, name: message.name, avatar: message.avatar } } };
          });
          return;
        case AGENT_EVENTS.VOICE_SAMPLE: {
          const waiter = pendingVoice.current.get(message.requestId);
          if (waiter) {
            clearTimeout(waiter.timer);
            pendingVoice.current.delete(message.requestId);
            waiter.resolve(`data:${message.mimeType};base64,${message.audio}`);
          }
          return;
        }
        case "error": {
          if (message.requestId && pendingVoice.current.has(message.requestId)) {
            const waiter = pendingVoice.current.get(message.requestId)!;
            clearTimeout(waiter.timer);
            pendingVoice.current.delete(message.requestId);
            waiter.reject(new Error(message.message));
            return;
          }
          if (!message.requestId && pendingSave.current.length && /agent|share|permission|name|avatar|access|budget/i.test(message.message)) {
            const waiter = pendingSave.current.shift()!;
            clearTimeout(waiter.timer);
            waiter.reject(new Error(message.message));
          }
          if (!message.requestId && /agent|suggestion|memory/i.test(message.message)) setState((s) => ({ ...s, error: message.message }));
          return;
        }
        default:
          return;
      }
    });
    client.send({ type: AGENT_EVENTS.REQUEST });
    return unsubscribe;
  }, [client]);

  // Re-sync after a reconnect.
  const connected = client?.connected;
  useEffect(() => {
    if (client && connected) client.send({ type: AGENT_EVENTS.REQUEST });
  }, [client, connected]);

  const send = useCallback((message: ClientMessage) => client?.send(message), [client]);

  // Actions stay the same object across state changes (safe in effect dependencies).
  const actions = useMemo<Omit<AgentsApi, keyof AgentsState>>(
    () => ({
      refresh: () => send({ type: AGENT_EVENTS.REQUEST }),
      open: (agentId) => send({ type: AGENT_EVENTS.GET, agentId }),
      save: (agent) =>
        new Promise<AgentView>((resolve, reject) => {
          if (!client) return reject(new Error("Not connected."));
          const timer = setTimeout(() => {
            pendingSave.current = pendingSave.current.filter((w) => w.timer !== timer);
            reject(new Error("The gateway didn't answer. Try again."));
          }, 15_000);
          pendingSave.current.push({ resolve, reject, timer });
          client.send({ type: AGENT_EVENTS.SAVE, agent });
        }),
      remove: (agentId) => {
        setState((s) => ({ ...s, agents: s.agents.filter((a) => a.id !== agentId) }));
        send({ type: AGENT_EVENTS.DELETE, agentId });
      },
      select: (agentId) => {
        setState((s) => ({ ...s, selectedAgentId: agentId ?? undefined }));
        send({ type: AGENT_EVENTS.SELECT, agentId });
      },
      decide: (proposalId, decision, edits) =>
        send({ type: AGENT_EVENTS.PROPOSAL_DECIDE, proposalId, decision, ...(edits?.skill ? { skill: edits.skill } : {}), ...(edits?.memory ? { memory: edits.memory } : {}) }),
      saveMemory: (agentId, text, itemId) => send({ type: AGENT_EVENTS.MEMORY_SAVE, agentId, text, ...(itemId ? { itemId } : {}) }),
      deleteMemory: (agentId, itemId) => send({ type: AGENT_EVENTS.MEMORY_DELETE, agentId, itemId }),
      previewVoice: (input) =>
        new Promise<string>((resolve, reject) => {
          if (!client) return reject(new Error("Not connected."));
          const requestId = nextId();
          const timer = setTimeout(() => {
            pendingVoice.current.delete(requestId);
            reject(new Error("The voice preview took too long."));
          }, 20_000);
          pendingVoice.current.set(requestId, { resolve, reject, timer });
          client.send({ type: AGENT_EVENTS.VOICE_PREVIEW, requestId, ...input });
        }),
      clearError: () => setState((s) => ({ ...s, error: undefined }))
    }),
    [send, client]
  );
  return useMemo<AgentsApi>(() => ({ ...state, ...actions }), [state, actions]);
}

function upsert(list: AgentView[], agent: AgentView): AgentView[] {
  const index = list.findIndex((a) => a.id === agent.id);
  const next = index >= 0 ? list.map((a) => (a.id === agent.id ? agent : a)) : [...list, agent];
  return next.sort((a, b) => a.name.localeCompare(b.name));
}
