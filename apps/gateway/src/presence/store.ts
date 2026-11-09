/**
 * What presence keeps: which agents are in which channels (bindings), per
 * agent notice channels, per workspace notification channels, and the threads
 * each agent takes part in. One JSON document in the store's key-value table
 * (small: tens of bindings, a capped set of threads), kept in memory and
 * written through on every change, one write at a time.
 */
import type { Store } from "@open-gpt-live/core";
import type { PresenceChannelRef, PresenceProvider, PresenceRespondMode } from "@open-gpt-live/protocol";

export const PRESENCE_KV_KEY = "presence.v1";
/** Threads an agent stays in (it answers replies there without a new @mention). */
export const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_THREADS = 5_000;

export interface PresenceBinding {
  id: string;
  ownerId: string;
  workspaceId: string;
  agentId: string;
  provider: PresenceProvider;
  /** The workspace connection that receives and posts (Slack bot install / Microsoft 365 account). */
  connectionId: string;
  channelId: string;
  channelName?: string;
  teamId?: string;
  teamName?: string;
  respond: PresenceRespondMode;
  /** Who placed the agent here; turns run with their current rights. */
  createdBy: string;
  createdByName?: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number;
  /** The binding's own Sibyl conversation (a log of what was asked and answered). */
  conversationId?: string;
  status: "active" | "pending" | "error";
  statusMessage?: string;
  /** Teams: the connected account's Graph user id (its own messages are skipped; @mentions of it count). */
  accountUserId?: string;
  /** Teams: change-notification subscription. */
  subscription?: { id: string; expiresAt: number; clientStateHash: string };
  /** Teams: when to try creating/renewing the subscription again after a failure. */
  retryAt?: number;
  failures?: number;
}

export interface PresenceState {
  bindings: PresenceBinding[];
  /** agentId → providers that also get its "act, then tell me" notices. */
  agents: Record<string, { notify: PresenceProvider[] }>;
  /** workspaceId → notification channels. */
  workspaces: Record<string, { slack?: PresenceChannelRef; teams?: PresenceChannelRef }>;
  /** threadKey → binding that takes part in it. */
  threads: Record<string, { bindingId: string; at: number }>;
}

export function threadKey(provider: PresenceProvider, connectionKey: string, channelId: string, threadId: string): string {
  return `${provider}:${connectionKey}:${channelId}:${threadId}`;
}

export class PresenceStore {
  private state: PresenceState = { bindings: [], agents: {}, workspaces: {}, threads: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: { store: Store; ownerId: string; now(): number; log(event: string, fields?: Record<string, unknown>): void }
  ) {}

  async load(): Promise<void> {
    const saved = await this.options.store.kv.get<Partial<PresenceState>>(this.options.ownerId, PRESENCE_KV_KEY);
    this.state = {
      bindings: Array.isArray(saved?.bindings) ? saved!.bindings : [],
      agents: saved?.agents && typeof saved.agents === "object" ? saved.agents : {},
      workspaces: saved?.workspaces && typeof saved.workspaces === "object" ? saved.workspaces : {},
      threads: saved?.threads && typeof saved.threads === "object" ? saved.threads : {}
    };
  }

  bindings(): readonly PresenceBinding[] {
    return this.state.bindings;
  }

  binding(id: string): PresenceBinding | undefined {
    return this.state.bindings.find((binding) => binding.id === id);
  }

  agentNotify(agentId: string): PresenceProvider[] {
    return this.state.agents[agentId]?.notify ?? [];
  }

  workspace(workspaceId: string): { slack?: PresenceChannelRef; teams?: PresenceChannelRef } {
    return this.state.workspaces[workspaceId] ?? {};
  }

  threadBinding(key: string): string | undefined {
    const entry = this.state.threads[key];
    if (!entry || this.options.now() - entry.at > THREAD_TTL_MS) return undefined;
    return entry.bindingId;
  }

  /* ───────────── changes (each one persisted) ───────────── */

  upsertBinding(binding: PresenceBinding): Promise<void> {
    return this.change((state) => {
      const index = state.bindings.findIndex((b) => b.id === binding.id);
      if (index >= 0) state.bindings[index] = binding;
      else state.bindings.push(binding);
    });
  }

  /** Update a binding if it still exists (read-modify-write on the latest copy). */
  patchBinding(id: string, fn: (binding: PresenceBinding) => PresenceBinding): Promise<PresenceBinding | undefined> {
    let result: PresenceBinding | undefined;
    return this.change((state) => {
      const index = state.bindings.findIndex((b) => b.id === id);
      if (index < 0) return;
      result = fn({ ...state.bindings[index]! });
      state.bindings[index] = result;
    }).then(() => result);
  }

  removeBinding(id: string): Promise<void> {
    return this.change((state) => {
      state.bindings = state.bindings.filter((b) => b.id !== id);
      for (const [key, entry] of Object.entries(state.threads)) if (entry.bindingId === id) delete state.threads[key];
    });
  }

  /** Drop everything of an agent (it was deleted). */
  removeAgent(agentId: string): Promise<void> {
    const ids = new Set(this.state.bindings.filter((b) => b.agentId === agentId).map((b) => b.id));
    return this.change((state) => {
      state.bindings = state.bindings.filter((b) => !ids.has(b.id));
      delete state.agents[agentId];
      for (const [key, entry] of Object.entries(state.threads)) if (ids.has(entry.bindingId)) delete state.threads[key];
    });
  }

  setAgentNotify(agentId: string, notify: PresenceProvider[]): Promise<void> {
    return this.change((state) => {
      if (notify.length) state.agents[agentId] = { notify };
      else delete state.agents[agentId];
    });
  }

  setWorkspace(workspaceId: string, value: { slack?: PresenceChannelRef; teams?: PresenceChannelRef }): Promise<void> {
    return this.change((state) => {
      if (value.slack || value.teams) state.workspaces[workspaceId] = value;
      else delete state.workspaces[workspaceId];
    });
  }

  /** The agent takes part in this thread (answers replies there). */
  joinThread(key: string, bindingId: string): Promise<void> {
    return this.change((state) => {
      state.threads[key] = { bindingId, at: this.options.now() };
      const entries = Object.entries(state.threads);
      if (entries.length <= MAX_THREADS) return;
      const cutoff = this.options.now() - THREAD_TTL_MS;
      entries
        .filter(([, entry]) => entry.at < cutoff)
        .forEach(([k]) => delete state.threads[k]);
      const left = Object.entries(state.threads).sort((a, b) => a[1].at - b[1].at);
      for (const [k] of left.slice(0, Math.max(0, left.length - MAX_THREADS))) delete state.threads[k];
    });
  }

  private change(fn: (state: PresenceState) => void): Promise<void> {
    fn(this.state);
    const snapshot = JSON.parse(JSON.stringify(this.state)) as PresenceState;
    const write = this.writing.then(() => this.options.store.kv.set(this.options.ownerId, PRESENCE_KV_KEY, snapshot));
    this.writing = write.catch((error: unknown) => this.options.log("presence.save_failed", { error: error instanceof Error ? error.message : String(error) }));
    return write;
  }

  /** Wait for pending writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.writing;
  }
}
