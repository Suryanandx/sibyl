/**
 * Presence: user-created agents in Slack and Microsoft Teams channels, and
 * Slack/Teams as notification channels. See docs/slack-and-teams.md.
 *
 * - Bindings: an agent is placed in a channel of the workspace's shared
 *   Slack or Microsoft 365 connection by someone who may edit the agent and
 *   use integrations. Turns run with that person's *current* rights (never
 *   their personal accounts: see turn.ts).
 * - Inbound: Slack events (signed) and Graph change notifications (clientState)
 *   are acknowledged at once; the work runs afterwards: dedupe the delivery,
 *   pick the agent (inbound.ts), one turn at a time per binding, a few at a
 *   time overall, rate-limited per binding. The reply goes into the thread.
 * - Teams subscriptions are created when an agent is placed and renewed by a
 *   job on the routine scheduler (the same tick and lease machinery as
 *   routines and monitors).
 * - Notifications: registers the "slack" and "teams" notifiers with the one
 *   notifications module (monitors pick them; agents' "act, then tell me"
 *   notices use the channels each agent chose).
 */
import { randomUUID } from "node:crypto";
import {
  PERMISSIONS,
  authorize,
  type ConversationRecord,
  type NotificationChannel,
  type NotificationRecord,
  type Principal,
  type Store,
  type ToolRegistry,
  type UsageMeter
} from "@open-gpt-live/core";
import type {
  PresenceAgentState,
  PresenceBindingInput,
  PresenceBindingView,
  PresenceChannelList,
  PresenceChannelRef,
  PresenceProvider,
  PresenceProviderStatus,
  PresenceRespondMode,
  PresenceWorkspaceSettings
} from "@open-gpt-live/protocol";
import { actingPrincipal, createdByOwner, creatorId } from "../agents/access.js";
import type { AgentRuntime } from "../agents/runtime.js";
import { ConnectorHttpError } from "../connectors/http-client.js";
import type { ConnectorService } from "../connectors/service.js";
import { SLACK_SIGNING_SECRET, slackCall, slackUserNames, type SlackMessage, type SlackResponse } from "../connectors/slack/index.js";
import type { ConnectionRecord, ConnectorActionContext } from "../connectors/types.js";
import { MONITOR_TOOL_NAMES } from "../monitors/service.js";
import type { Notifier, NotifyRecipient } from "../notifications/notifiers.js";
import { notificationPath } from "../notifications/notifiers.js";
import type { NotificationInput, NotificationService } from "../notifications/service.js";
import type { RoutineService } from "../routines/service.js";
import type { ScheduledJobType } from "../routines/scheduler.js";
import { ROUTINE_TOOL_NAMES } from "../routines/tools.js";
import { RecentIds, pickBinding, type BindingPick, type InboundMessage } from "./inbound.js";
import { parseSlackEnvelope, slackEscape, slackInbound, verifySlackSignature } from "./slack.js";
import { PresenceStore, threadKey, type PresenceBinding } from "./store.js";
import {
  TEAMS_RENEW_BEFORE_MS,
  accountUserId,
  clientStateMatches,
  createSubscription,
  deleteSubscription,
  fetchChannelMessage,
  fetchThread,
  parseGraphNotifications,
  parseMessageResource,
  renewSubscription,
  teamsHtml,
  teamsInbound
} from "./teams.js";
import { runChannelTurn, type PresenceBrainOptions, type ThreadLine } from "./turn.js";
import { messageText } from "../connectors/microsoft/files-teams.js";
import { tenantPath } from "../tenancy/mode.js";

export const PRESENCE_JOB_KIND = "presence";
export const MAX_BINDINGS_PER_AGENT = 20;
/** Turns per binding in RATE_WINDOW_MS (the rest are dropped and logged). */
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 10 * 60_000;
const DEFAULT_CONCURRENCY = 4;
const VENDOR_TIMEOUT_MS = 20_000;
/** A turn may wait this long (approvals wait up to a day). */
const TURN_TIMEOUT_MS = 25 * 60 * 60_000;

/** Connector and groups an agent needs to live in each provider. */
const PROVIDERS: Record<PresenceProvider, { connectorId: string; name: string; groups: string[]; notifyGroups: string[] }> = {
  slack: { connectorId: "slack", name: "Slack", groups: ["agents"], notifyGroups: ["write"] },
  teams: { connectorId: "microsoft", name: "Microsoft Teams", groups: ["teams_read", "teams_messages_read", "teams_post"], notifyGroups: ["teams_post"] }
};

type Log = (event: string, fields?: Record<string, unknown>) => void;

export class PresenceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request"
  ) {
    super(message);
  }
}

export interface PresenceServiceOptions {
  store: Store;
  ownerId: string;
  tools: ToolRegistry;
  meter: UsageMeter;
  env: NodeJS.ProcessEnv;
  log: Log;
  connectors: ConnectorService;
  agents: AgentRuntime;
  notifications: NotificationService;
  /** Approval gate (inbox) and the scheduler that renews Teams subscriptions. */
  routines?: RoutineService;
  createId?(): string;
  now?(): number;
  maxConcurrent?: number;
  /** Tests only: accept an http:// public URL for Teams subscriptions (Graph itself requires https). */
  allowHttpPublicUrl?: boolean;
}

export interface Caller {
  principal: Principal;
  workspaceId: string;
  name?: string;
}

/** What a vendor callback is answered with. */
export interface CallbackReply {
  status: number;
  body?: unknown;
  text?: string;
}

export class PresenceService {
  readonly records: PresenceStore;
  readonly jobType: ScheduledJobType<PresenceBinding>;
  private brain: PresenceBrainOptions | undefined;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly seen: RecentIds;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly hits = new Map<string, number[]>();
  private readonly running = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly renewing = new Set<string>();
  private readonly restore: Array<() => void> = [];
  private readonly excluded: ReadonlySet<string>;
  /** Agent names for picking by "@App Name …" (kept in step with the agents). */
  private readonly agentNames = new Map<string, string>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private closed = false;

  constructor(private readonly options: PresenceServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.seen = new RecentIds(60 * 60_000, 10_000, this.now);
    this.records = new PresenceStore({ store: options.store, ownerId: options.ownerId, now: this.now, log: options.log });
    this.excluded = new Set([...ROUTINE_TOOL_NAMES, ...MONITOR_TOOL_NAMES]);
    this.jobType = this.createJobType();
  }

  async init(): Promise<this> {
    await this.records.load();
    this.restore.push(this.options.notifications.notifiers.register(this.slackNotifier()));
    this.restore.push(this.options.notifications.notifiers.register(this.teamsNotifier()));
    // A deleted agent leaves its channels.
    this.restore.push(this.options.agents.subscribe(() => this.track(this.syncAgents())));
    await this.syncAgents();
    this.options.routines?.addJobType(this.jobType);
    return this;
  }

  /** Models for channel turns (called by the server once they are known). */
  configure(brain: PresenceBrainOptions): void {
    this.brain = brain;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort("shutdown");
    for (const undo of this.restore.splice(0)) undo();
    await Promise.race([this.settle(), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
    await this.records.flush().catch(() => undefined);
  }

  /** Wait for background work (tests). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Channels an agent's "act, then tell me" notice also goes to (wired into the notifications publish path). */
  channelsFor(input: NotificationInput): NotificationChannel[] {
    if (input.kind !== "agent_action" || !input.links?.agentId) return [];
    return this.records.agentNotify(input.links.agentId);
  }

  /* ───────────── settings an agent editor shows ───────────── */

  async agentState(caller: Caller, agentId: string): Promise<PresenceAgentState> {
    const agent = await this.options.agents.get(caller.principal, caller.workspaceId, agentId);
    if (!agent) throw new PresenceError("Agent not found.", 404, "not_found");
    const canEdit = this.options.agents.canEdit(caller.principal, agent) && authorize(caller.principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: caller.workspaceId });
    return {
      agentId,
      bindings: this.records
        .bindings()
        .filter((b) => b.agentId === agentId && b.workspaceId === caller.workspaceId)
        .map((b) => this.view(b, canEdit)),
      notify: this.records.agentNotify(agentId),
      providers: (["slack", "teams"] as const).map((provider) => this.providerStatus(provider, caller.workspaceId)),
      canEdit
    };
  }

  async addBinding(caller: Caller, agentId: string, input: PresenceBindingInput): Promise<PresenceAgentState> {
    await this.editableAgent(caller, agentId);
    const connection = this.hostConnection(input.provider, caller.workspaceId);
    if (!connection) throw new PresenceError(this.providerStatus(input.provider, caller.workspaceId).reason ?? "Not available.", 409, "not_connected");
    const existing = this.records.bindings().filter((b) => b.agentId === agentId);
    if (existing.length >= MAX_BINDINGS_PER_AGENT) throw new PresenceError(`An agent can be in at most ${MAX_BINDINGS_PER_AGENT} channels.`, 409, "limit");
    if (existing.some((b) => b.provider === input.provider && b.channelId === input.channelId && b.teamId === input.teamId)) {
      throw new PresenceError("The agent is already in that channel.", 409, "exists");
    }
    const at = this.now();
    const binding: PresenceBinding = {
      id: this.createId(),
      ownerId: this.options.ownerId,
      workspaceId: caller.workspaceId,
      agentId,
      provider: input.provider,
      connectionId: connection.id,
      channelId: input.channelId,
      ...(input.channelName ? { channelName: input.channelName } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamName ? { teamName: input.teamName } : {}),
      respond: input.respond,
      createdBy: creatorId(caller.principal),
      ...(caller.name ? { createdByName: caller.name } : {}),
      createdAt: at,
      updatedAt: at,
      status: input.provider === "slack" ? "active" : "pending"
    };
    await this.records.upsertBinding(binding);
    this.options.log("presence.bound", { bindingId: binding.id, agentId, provider: binding.provider, channelId: binding.channelId });
    // Teams: subscribe now (Graph calls back to validate; that must not block this reply).
    if (binding.provider === "teams") this.track(this.ensureSubscription(binding.id));
    return this.agentState(caller, agentId);
  }

  async updateBinding(caller: Caller, agentId: string, bindingId: string, respond: PresenceRespondMode): Promise<PresenceAgentState> {
    await this.editableAgent(caller, agentId);
    const updated = await this.records.patchBinding(bindingId, (b) => (b.agentId === agentId && b.workspaceId === caller.workspaceId ? { ...b, respond, updatedAt: this.now() } : b));
    if (!updated || updated.agentId !== agentId || updated.workspaceId !== caller.workspaceId) throw new PresenceError("Not found.", 404, "not_found");
    return this.agentState(caller, agentId);
  }

  async removeBinding(caller: Caller, agentId: string, bindingId: string): Promise<PresenceAgentState> {
    await this.editableAgent(caller, agentId);
    const binding = this.records.binding(bindingId);
    if (!binding || binding.agentId !== agentId || binding.workspaceId !== caller.workspaceId) throw new PresenceError("Not found.", 404, "not_found");
    await this.unbind(binding);
    return this.agentState(caller, agentId);
  }

  async setAgentNotify(caller: Caller, agentId: string, notify: PresenceProvider[]): Promise<PresenceAgentState> {
    await this.editableAgent(caller, agentId);
    await this.records.setAgentNotify(agentId, notify);
    return this.agentState(caller, agentId);
  }

  /** Channels to pick from (the workspace's shared connection). */
  async channels(caller: Caller, provider: PresenceProvider, teamId?: string): Promise<PresenceChannelList> {
    if (!authorize(caller.principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: caller.workspaceId })) throw new PresenceError("You can't use integrations here.", 403, "forbidden");
    const connection = this.anyConnection(provider, caller.workspaceId);
    if (!connection) throw new PresenceError(this.providerStatus(provider, caller.workspaceId).reason ?? "Not available.", 409, "not_connected");
    const signal = AbortSignal.timeout(VENDOR_TIMEOUT_MS);
    try {
      if (provider === "slack") {
        const result = await this.options.connectors.runActionAs(connection.id, "list_channels", { maxResults: 500 }, signal);
        const channels = ((result.data as { channels?: Array<{ id: string; name?: string; private?: boolean; appIsMember?: boolean }> }).channels ?? []).map((c) => ({
          id: c.id,
          name: c.name ?? c.id,
          ...(c.private ? { private: true } : {}),
          appIsMember: Boolean(c.appIsMember)
        }));
        return { provider, channels };
      }
      const teams = ((await this.options.connectors.runActionAs(connection.id, "teams_list_teams", {}, signal)).data as { teams?: Array<{ teamId: string; name?: string }> }).teams ?? [];
      const chosen = teamId ?? teams[0]?.teamId;
      const channels = chosen
        ? (((await this.options.connectors.runActionAs(connection.id, "teams_list_channels", { teamId: chosen }, signal)).data as { channels?: Array<{ channelId: string; name?: string; type?: string }> }).channels ?? []).map((c) => ({
            id: c.channelId,
            name: c.name ?? c.channelId,
            ...(c.type && c.type !== "standard" ? { private: true } : {})
          }))
        : [];
      return { provider, teams: teams.map((t) => ({ id: t.teamId, name: t.name ?? t.teamId })), channels };
    } catch (error) {
      throw new PresenceError(error instanceof Error ? error.message : String(error), 502, "vendor_failed");
    }
  }

  workspaceSettings(caller: Caller): PresenceWorkspaceSettings {
    if (!authorize(caller.principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: caller.workspaceId })) throw new PresenceError("You can't use integrations here.", 403, "forbidden");
    const settings = this.records.workspace(caller.workspaceId);
    return {
      ...(settings.slack ? { slack: settings.slack } : {}),
      ...(settings.teams ? { teams: settings.teams } : {}),
      providers: (["slack", "teams"] as const).map((provider) => this.providerStatus(provider, caller.workspaceId)),
      canManage: authorize(caller.principal, PERMISSIONS.INTEGRATIONS_CONNECT_SHARED, { workspaceId: caller.workspaceId })
    };
  }

  async setWorkspaceSettings(caller: Caller, input: { slack?: PresenceChannelRef | null; teams?: PresenceChannelRef | null }): Promise<PresenceWorkspaceSettings> {
    if (!authorize(caller.principal, PERMISSIONS.INTEGRATIONS_CONNECT_SHARED, { workspaceId: caller.workspaceId })) {
      throw new PresenceError("Only workspace admins can choose the notifications channel.", 403, "forbidden");
    }
    const next = { ...this.records.workspace(caller.workspaceId) };
    for (const provider of ["slack", "teams"] as const) {
      const value = input[provider];
      if (value === null) delete next[provider];
      else if (value) next[provider] = value;
    }
    await this.records.setWorkspace(caller.workspaceId, next);
    return this.workspaceSettings(caller);
  }

  /* ───────────── vendor callbacks ───────────── */

  /** POST /api/presence/slack/events. Answers at once; the turn runs afterwards. */
  async receiveSlack(headers: { timestamp?: string; signature?: string; retryNum?: string }, body: Buffer): Promise<CallbackReply> {
    const secret = await this.options.connectors.appSecret("slack", SLACK_SIGNING_SECRET);
    if (!secret) {
      this.options.log("presence.slack_unconfigured", {});
      return { status: 503, body: { error: "not_configured", message: "Slack's signing secret isn't set up (Integrations → Slack → Setup)." } };
    }
    const check = verifySlackSignature({ secret, timestamp: headers.timestamp, signature: headers.signature, body, nowMs: this.now() });
    if (check !== "ok") {
      this.options.log("presence.slack_rejected", { reason: check });
      return { status: 401, body: { error: "invalid_signature" } };
    }
    const envelope = parseSlackEnvelope(body);
    if (!envelope) return { status: 400, body: { error: "bad_request" } };
    if (envelope.type === "url_verification") return { status: 200, body: { challenge: envelope.challenge } };
    if (envelope.type !== "event_callback") return { status: 200, body: { ok: true } };
    // Every Sibyl connection of this Slack workspace (and app).
    const connections = this.options.connectors
      .connectionsOf("slack")
      .filter((c) => c.metadata.teamId === envelope.team_id && (!envelope.api_app_id || !c.metadata.appId || c.metadata.appId === envelope.api_app_id));
    if (connections.length === 0) {
      this.options.log("presence.slack_unknown_team", { teamId: envelope.team_id });
      return { status: 200, body: { ok: true } };
    }
    const botUserId = connections.find((c) => c.metadata.botUserId)?.metadata.botUserId;
    const message = slackInbound(envelope, { connectionIds: connections.map((c) => c.id), ...(botUserId ? { botUserId } : {}) });
    if (message) this.accept(message);
    return { status: 200, body: { ok: true } };
  }

  /** POST /api/presence/teams/notifications (and its validation handshake). */
  receiveTeams(body: Buffer): CallbackReply {
    const notifications = parseGraphNotifications(body);
    if (!notifications) return { status: 400, body: { error: "bad_request" } };
    for (const notification of notifications) {
      const binding = this.records.bindings().find((b) => b.provider === "teams" && b.subscription?.id === notification.subscriptionId);
      if (!binding || !clientStateMatches(binding.subscription!.clientStateHash, notification.clientState)) {
        this.options.log("presence.teams_rejected", { subscriptionId: notification.subscriptionId.slice(0, 64) });
        continue;
      }
      const ref = notification.resource ? parseMessageResource(notification.resource) : undefined;
      if (!ref || notification.changeType !== "created") continue;
      this.track(this.receiveTeamsMessage(binding, ref));
    }
    return { status: 202 };
  }

  /** POST /api/presence/teams/lifecycle: renew or recreate subscriptions Graph asks about. */
  receiveTeamsLifecycle(body: Buffer): CallbackReply {
    const notifications = parseGraphNotifications(body);
    if (!notifications) return { status: 400, body: { error: "bad_request" } };
    for (const notification of notifications) {
      const binding = this.records.bindings().find((b) => b.provider === "teams" && b.subscription?.id === notification.subscriptionId);
      if (!binding || !clientStateMatches(binding.subscription!.clientStateHash, notification.clientState)) continue;
      this.options.log("presence.teams_lifecycle", { bindingId: binding.id, event: notification.lifecycleEvent });
      if (notification.lifecycleEvent === "subscriptionRemoved") {
        this.track(this.records.patchBinding(binding.id, (b) => withoutSubscription(b)).then(() => this.ensureSubscription(binding.id)));
      } else if (notification.lifecycleEvent === "reauthorizationRequired") {
        this.track(this.ensureSubscription(binding.id));
      }
    }
    return { status: 202 };
  }

  private async receiveTeamsMessage(binding: PresenceBinding, ref: { teamId: string; channelId: string; messageId: string; replyId?: string }): Promise<void> {
    if (ref.teamId !== binding.teamId || ref.channelId !== binding.channelId) return;
    try {
      const ctx = this.options.connectors.contextFor(binding.connectionId, AbortSignal.timeout(VENDOR_TIMEOUT_MS));
      const message = await fetchChannelMessage(ctx, ref);
      const inbound = teamsInbound(message, {
        connectionId: binding.connectionId,
        teamId: ref.teamId,
        channelId: ref.channelId,
        rootId: ref.messageId,
        isReply: Boolean(ref.replyId),
        accountUserId: binding.accountUserId
      });
      if (inbound) this.accept(inbound);
    } catch (error) {
      this.options.log("presence.teams_fetch_failed", { bindingId: binding.id, error: errorText(error) });
    }
  }

  /* ───────────── dispatch ───────────── */

  /** A message arrived: drop retries, pick the agent, queue its turn. */
  accept(message: InboundMessage): void {
    if (this.closed || !this.seen.add(message.dedupeKey)) return;
    const candidates = this.records
      .bindings()
      .filter((b) => b.provider === message.provider && message.connectionIds.includes(b.connectionId) && b.channelId === message.channelId && (message.provider !== "teams" || b.teamId === message.teamId));
    const key = threadKey(message.provider, message.spaceKey, message.channelId, message.threadId);
    const pick = pickBinding({ message, candidates, threadBindingId: this.records.threadBinding(key), agentName: (id) => this.agentNames.get(id) });
    if (!pick) return;
    if (!this.withinRate(pick.binding.id)) {
      this.options.log("presence.rate_limited", { bindingId: pick.binding.id });
      return;
    }
    const previous = this.chains.get(pick.binding.id) ?? Promise.resolve();
    const next = previous.then(() => this.withSlot(() => this.respond(pick, message, key)));
    const settled = next.catch((error: unknown) => this.options.log("presence.turn_crashed", { bindingId: pick.binding.id, error: errorText(error) }));
    this.chains.set(pick.binding.id, settled);
    void settled.then(() => {
      if (this.chains.get(pick.binding.id) === settled) this.chains.delete(pick.binding.id);
    });
    this.track(settled);
  }

  private async respond(pick: BindingPick, message: InboundMessage, key: string): Promise<void> {
    const binding = this.records.binding(pick.binding.id);
    if (!binding || this.closed) return;
    const { store, ownerId } = this.options;
    const principal = await actingPrincipal(store, ownerId, { createdBy: binding.createdBy, workspaceId: binding.workspaceId, permission: PERMISSIONS.AGENTS_USE, feature: "agents" });
    if (typeof principal === "string" || !authorize(principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: binding.workspaceId })) {
      await this.setStatus(binding.id, "error", `The agent can't answer here: ${typeof principal === "string" ? principal : "the person who added it can no longer use integrations."}`);
      return;
    }
    const agent = await this.options.agents.get(principal, binding.workspaceId, binding.agentId);
    if (!agent) {
      await this.setStatus(binding.id, "error", "The agent was deleted or its creator can no longer use it.");
      return;
    }
    this.agentNames.set(agent.id, agent.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), TURN_TIMEOUT_MS);
    timer.unref?.();
    const runId = this.createId();
    this.running.set(runId, controller);
    try {
      const ctx = this.options.connectors.contextFor(binding.connectionId, controller.signal);
      await this.records.joinThread(key, binding.id);
      const io = binding.provider === "slack" ? this.slackIo(ctx, binding, message) : this.teamsIo(ctx, binding);
      void io.ack().catch(() => undefined);
      const [history, authorName] = await Promise.all([message.inThread ? io.history(message).catch(() => []) : Promise.resolve([]), io.authorName(message).catch(() => message.authorName ?? "Someone")]);
      const conversationId = await this.ensureConversation(binding, agent.name);
      const result = await runChannelTurn(
        {
          store,
          tools: this.options.tools,
          meter: this.options.meter,
          agents: this.options.agents,
          brain: this.brain ?? { provider: undefined, model: () => undefined, systemPrompt: "" },
          approvals: this.options.routines?.approvals,
          excludeTools: this.excluded,
          createId: this.createId,
          now: this.now,
          log: this.options.log
        },
        {
          binding,
          agent,
          principal,
          place: placeOf(binding),
          authorName,
          text: pick.text || message.text,
          history,
          runId,
          conversationId,
          signal: controller.signal,
          say: (text) => io.reply(message.threadId, agent.name, text)
        }
      );
      if (result.reply) await io.reply(message.threadId, agent.name, result.reply);
      await this.records.patchBinding(binding.id, (b) => {
        const next: PresenceBinding = { ...b, lastActivityAt: this.now() };
        if (b.status === "error" && b.provider === "slack") {
          next.status = "active";
          delete next.statusMessage;
        }
        return next;
      });
      this.options.log("presence.answered", { bindingId: binding.id, agentId: agent.id, provider: binding.provider, reason: pick.reason, status: result.status });
    } catch (error) {
      this.options.log("presence.reply_failed", { bindingId: binding.id, error: errorText(error) });
      if (error instanceof ConnectorHttpError && (error.status === 401 || error.status === 403)) await this.setStatus(binding.id, "error", errorText(error));
    } finally {
      clearTimeout(timer);
      this.running.delete(runId);
    }
  }

  /* ───────────── Slack and Teams I/O for one turn ───────────── */

  private slackIo(ctx: ConnectorActionContext, binding: PresenceBinding, message: InboundMessage) {
    const connection = this.options.connectors.store.get(binding.connectionId);
    const botUserId = connection?.metadata.botUserId;
    return {
      // 👀 while working (best effort; needs the Reactions group).
      ack: () => slackCall(ctx, "reactions.add", { channel: binding.channelId, timestamp: message.messageId, name: "eyes" }, { write: true }).then(() => undefined),
      authorName: async (m: InboundMessage) => (await slackUserNames(ctx, [m.authorId])).get(m.authorId) ?? "Someone",
      history: async (m: InboundMessage): Promise<ThreadLine[]> => {
        const replies = await slackCall<SlackResponse & { messages?: SlackMessage[] }>(ctx, "conversations.replies", { channel: binding.channelId, ts: m.threadId, limit: 40 });
        const earlier = (replies.messages ?? []).filter((x) => x.ts !== m.messageId && (!x.subtype || x.subtype === "bot_message" || x.subtype === "thread_broadcast"));
        const names = await slackUserNames(ctx, earlier.map((x) => x.user ?? "").filter(Boolean));
        return earlier.map((x) => {
          const fromAgent = Boolean(x.bot_id) && (!botUserId || x.user === botUserId || !x.user);
          const text = (x.text ?? "").replace(botUserId ? new RegExp(`<@${botUserId}>`, "g") : /$^/, "").trim();
          return { author: fromAgent ? (x.username ?? "Agent") : (x.user ? (names.get(x.user) ?? x.user) : (x.username ?? "Someone")), text, fromAgent };
        });
      },
      reply: async (threadId: string, agentName: string, text: string) => {
        await slackCall(ctx, "chat.postMessage", { channel: binding.channelId, thread_ts: threadId, text: slackEscape(text), username: agentName, unfurl_links: false }, { write: true });
      }
    };
  }

  private teamsIo(ctx: ConnectorActionContext, binding: PresenceBinding) {
    const ref = { teamId: binding.teamId!, channelId: binding.channelId };
    return {
      ack: async () => undefined,
      authorName: async (m: InboundMessage) => m.authorName ?? "Someone",
      history: async (m: InboundMessage): Promise<ThreadLine[]> => {
        const thread = await fetchThread(ctx, { ...ref, messageId: m.threadId });
        return thread
          .filter((x) => x.id !== m.messageId)
          .map((x) => {
            const fromAgent = Boolean(binding.accountUserId && x.from?.user?.id === binding.accountUserId);
            return { author: x.from?.user?.displayName ?? x.from?.application?.displayName ?? "Someone", text: messageText(x), fromAgent };
          });
      },
      reply: async (threadId: string, agentName: string, text: string) => {
        await ctx.http.post(`${ctx.base("graph")}/v1.0/teams/${encodeURIComponent(ref.teamId)}/channels/${encodeURIComponent(ref.channelId)}/messages/${encodeURIComponent(threadId)}/replies`, {
          body: { contentType: "html", content: teamsHtml(agentName, text) }
        });
      }
    };
  }

  /* ───────────── Teams subscriptions (scheduler job) ───────────── */

  private createJobType(): ScheduledJobType<PresenceBinding> {
    return {
      kind: PRESENCE_JOB_KIND,
      maxConcurrency: 1,
      due: async (now) =>
        this.records
          .bindings()
          .filter((b) => b.provider === "teams" && (b.retryAt ?? 0) <= now && (!b.subscription || b.subscription.expiresAt - now < TEAMS_RENEW_BEFORE_MS))
          .map((b) => ({ ...b })),
      claim: async (job) => {
        if (this.renewing.has(job.id) || !this.records.binding(job.id)) return undefined;
        this.renewing.add(job.id);
        return job;
      },
      renew: async () => undefined,
      run: async (job) => {
        await this.ensureSubscription(job.id);
      },
      release: async (job) => {
        this.renewing.delete(job.id);
      },
      liveRunIds: () => new Set(this.running.keys()),
      get: async (id) => this.records.binding(id)
    };
  }

  /** Create or renew the binding's Graph subscription; failures back off (1 min doubling, at most an hour). */
  async ensureSubscription(bindingId: string): Promise<void> {
    const binding = this.records.binding(bindingId);
    if (!binding || binding.provider !== "teams" || !binding.teamId) return;
    const publicUrl = this.options.env.SIBYL_PUBLIC_GATEWAY_URL?.trim().replace(/\/+$/, "");
    if (!publicUrl || !(publicUrl.startsWith("https://") || (this.options.allowHttpPublicUrl && publicUrl.startsWith("http://")))) {
      await this.records.patchBinding(bindingId, (b) => ({ ...b, status: "error", statusMessage: "Teams needs SIBYL_PUBLIC_GATEWAY_URL set to this gateway's public HTTPS address to deliver messages.", retryAt: this.now() + 60 * 60_000 }));
      return;
    }
    try {
      const ctx = this.options.connectors.contextFor(binding.connectionId, AbortSignal.timeout(VENDOR_TIMEOUT_MS));
      const userId = binding.accountUserId ?? (await accountUserId(ctx));
      let subscription = binding.subscription;
      if (subscription) {
        try {
          subscription = { ...subscription, expiresAt: await renewSubscription(ctx, subscription.id, this.now()) };
        } catch (error) {
          if (!(error instanceof ConnectorHttpError && error.status === 404)) throw error;
          subscription = undefined;
        }
      }
      // Hosted organizations receive Graph notifications under /o/<orgId>.
      subscription ??= await createSubscription(ctx, { teamId: binding.teamId, channelId: binding.channelId, publicUrl: `${publicUrl}${tenantPath(this.options.ownerId, "")}`, nowMs: this.now() });
      const kept = subscription;
      await this.records.patchBinding(bindingId, (b) => {
        const next: PresenceBinding = { ...b, accountUserId: userId, subscription: kept, status: "active", updatedAt: this.now() };
        delete next.statusMessage;
        delete next.retryAt;
        delete next.failures;
        return next;
      });
      this.options.log("presence.teams_subscribed", { bindingId, subscriptionId: kept.id, expiresAt: kept.expiresAt });
    } catch (error) {
      const failures = (binding.failures ?? 0) + 1;
      const wait = Math.min(60 * 60_000, 60_000 * 2 ** (failures - 1));
      const detail = error instanceof ConnectorHttpError ? `HTTP ${error.status}${error.detail ? `: ${error.detail}` : ""}` : errorText(error);
      await this.records.patchBinding(bindingId, (b) => ({ ...b, status: "error", statusMessage: `Couldn't subscribe to the Teams channel (${detail}). Retrying.`, failures, retryAt: this.now() + wait }));
      this.options.log("presence.teams_subscribe_failed", { bindingId, failures, error: detail });
    }
  }

  /* ───────────── notifications ───────────── */

  private slackNotifier(): Notifier {
    return {
      channel: "slack",
      available: ({ workspaceId, recipient }) => {
        const connection = this.anyConnection("slack", workspaceId, PROVIDERS.slack.notifyGroups);
        if (!connection) return { ok: false, reason: "Connect Slack for the whole workspace in Integrations to deliver here." };
        if (recipient.email && connection.groups.includes("notify")) return { ok: true };
        if (this.records.workspace(workspaceId).slack) return { ok: true };
        return { ok: false, reason: "Slack can't reach you: switch on “Notifications by direct message” or choose a notifications channel (Integrations → Slack)." };
      },
      send: async ({ record, recipient }) => {
        const connection = this.anyConnection("slack", record.workspaceId, PROVIDERS.slack.notifyGroups);
        if (!connection) throw new Error("Slack isn't connected for this workspace.");
        const ctx = this.options.connectors.contextFor(connection.id, AbortSignal.timeout(VENDOR_TIMEOUT_MS));
        const text = this.slackNotice(record);
        const fallback = this.records.workspace(record.workspaceId).slack;
        if (recipient.email && connection.groups.includes("notify")) {
          try {
            await this.slackDirectMessage(ctx, recipient, text);
            return;
          } catch (error) {
            if (!fallback) throw error;
            this.options.log("presence.slack_dm_failed", { error: errorText(error) });
          }
        }
        if (!fallback) throw new Error("No Slack notifications channel is set.");
        await slackCall(ctx, "chat.postMessage", { channel: fallback.channelId, text, unfurl_links: false }, { write: true });
      }
    };
  }

  private async slackDirectMessage(ctx: ConnectorActionContext, recipient: NotifyRecipient, text: string): Promise<void> {
    const found = await slackCall<SlackResponse & { user?: { id?: string } }>(ctx, "users.lookupByEmail", { email: recipient.email });
    if (!found.user?.id) throw new Error("No Slack user with that e-mail.");
    const opened = await slackCall<SlackResponse & { channel?: { id?: string } }>(ctx, "conversations.open", { users: found.user.id }, { write: true });
    if (!opened.channel?.id) throw new Error("Slack didn't open a direct message.");
    await slackCall(ctx, "chat.postMessage", { channel: opened.channel.id, text, unfurl_links: false }, { write: true });
  }

  private slackNotice(record: NotificationRecord): string {
    const appUrl = this.options.env.SIBYL_APP_URL?.trim().replace(/\/+$/, "");
    const link = appUrl ? `\n<${appUrl}${notificationPath(record)}|Open in Sibyl>` : "";
    const body = record.body && record.body !== record.title ? `\n${slackEscape(record.body)}` : "";
    return `*${slackEscape(record.title)}*${body}${link}`;
  }

  private teamsNotifier(): Notifier {
    return {
      channel: "teams",
      available: ({ workspaceId }) => {
        if (!this.anyConnection("teams", workspaceId, PROVIDERS.teams.notifyGroups)) {
          return { ok: false, reason: "Connect Microsoft 365 for the whole workspace (with “Teams: post messages”) in Integrations to deliver here." };
        }
        if (!this.records.workspace(workspaceId).teams) return { ok: false, reason: "Choose a Teams notifications channel first (Integrations → Microsoft 365)." };
        return { ok: true };
      },
      send: async ({ record }) => {
        const connection = this.anyConnection("teams", record.workspaceId, PROVIDERS.teams.notifyGroups);
        const target = this.records.workspace(record.workspaceId).teams;
        if (!connection || !target?.teamId) throw new Error("Teams notifications aren't set up for this workspace.");
        const ctx = this.options.connectors.contextFor(connection.id, AbortSignal.timeout(VENDOR_TIMEOUT_MS));
        const appUrl = this.options.env.SIBYL_APP_URL?.trim().replace(/\/+$/, "");
        const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const content = `<p>${escape(record.body || record.title).replace(/\n/g, "<br>")}</p>${appUrl ? `<p><a href="${escape(`${appUrl}${notificationPath(record)}`)}">Open in Sibyl</a></p>` : ""}`;
        await ctx.http.post(`${ctx.base("graph")}/v1.0/teams/${encodeURIComponent(target.teamId)}/channels/${encodeURIComponent(target.channelId)}/messages`, {
          subject: record.title.slice(0, 200),
          body: { contentType: "html", content }
        });
      }
    };
  }

  /* ───────────── helpers ───────────── */

  /** The workspace's shared connection that can host agents (all needed groups). */
  private hostConnection(provider: PresenceProvider, workspaceId: string): ConnectionRecord | undefined {
    return this.anyConnection(provider, workspaceId, PROVIDERS[provider].groups);
  }

  /** A shared, working connection of the provider's connector in the workspace with these groups. */
  private anyConnection(provider: PresenceProvider, workspaceId: string, groups: string[] = []): ConnectionRecord | undefined {
    return this.options.connectors
      .connectionsOf(PROVIDERS[provider].connectorId)
      .filter((c) => c.scope === "workspace" && c.workspaceId === workspaceId && c.status !== "reconnect")
      .find((c) => groups.every((group) => c.groups.includes(group)));
  }

  private providerStatus(provider: PresenceProvider, workspaceId: string): PresenceProviderStatus {
    const { name, connectorId, groups } = PROVIDERS[provider];
    const host = this.hostConnection(provider, workspaceId);
    if (host) return { provider, available: true, ...(host.account ? { account: host.account } : {}) };
    const any = this.options.connectors.connectionsOf(connectorId).find((c) => c.scope === "workspace" && c.workspaceId === workspaceId);
    if (!any) return { provider, available: false, reason: `Connect ${provider === "teams" ? "Microsoft 365" : name} for the whole workspace in Integrations first.` };
    if (any.status === "reconnect") return { provider, available: false, reason: `${provider === "teams" ? "Microsoft 365" : name} needs to be reconnected in Integrations.` };
    const def = this.options.connectors.definition(connectorId);
    const missing = groups.filter((group) => !any.groups.includes(group)).map((group) => def?.groups.find((g) => g.id === group)?.title ?? group);
    return { provider, available: false, reason: `Switch on ${missing.map((m) => `“${m}”`).join(", ")} for the workspace connection in Integrations.` };
  }

  private async editableAgent(caller: Caller, agentId: string) {
    const agent = await this.options.agents.get(caller.principal, caller.workspaceId, agentId);
    if (!agent) throw new PresenceError("Agent not found.", 404, "not_found");
    if (!this.options.agents.canEdit(caller.principal, agent)) throw new PresenceError("Only the agent's creator (or a workspace admin) can change where it works.", 403, "forbidden");
    if (!authorize(caller.principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: caller.workspaceId })) throw new PresenceError("You can't use integrations in this workspace.", 403, "forbidden");
    this.agentNames.set(agent.id, agent.name);
    return agent;
  }

  private async unbind(binding: PresenceBinding): Promise<void> {
    await this.records.removeBinding(binding.id);
    this.options.log("presence.unbound", { bindingId: binding.id, agentId: binding.agentId });
    if (binding.subscription) {
      const id = binding.subscription.id;
      this.track(
        (async () => {
          try {
            await deleteSubscription(this.options.connectors.contextFor(binding.connectionId, AbortSignal.timeout(VENDOR_TIMEOUT_MS)), id);
          } catch (error) {
            this.options.log("presence.teams_unsubscribe_failed", { bindingId: binding.id, error: errorText(error) });
          }
        })()
      );
    }
  }

  /** Keep agent names current; a deleted agent leaves its channels. */
  private async syncAgents(): Promise<void> {
    const ids = [...new Set(this.records.bindings().map((b) => b.agentId))];
    for (const id of ids) {
      const agent = await this.options.store.agents.get(this.options.ownerId, id);
      if (agent) {
        this.agentNames.set(id, agent.name);
        continue;
      }
      this.agentNames.delete(id);
      for (const binding of this.records.bindings().filter((b) => b.agentId === id)) await this.unbind(binding);
      await this.records.removeAgent(id);
    }
  }

  private async setStatus(bindingId: string, status: PresenceBinding["status"], message: string): Promise<void> {
    this.options.log("presence.binding_status", { bindingId, status });
    await this.records.patchBinding(bindingId, (b) => ({ ...b, status, statusMessage: message, updatedAt: this.now() }));
  }

  private async ensureConversation(binding: PresenceBinding, agentName: string): Promise<string> {
    const { store, ownerId } = this.options;
    if (binding.conversationId && (await store.conversations.get(ownerId, binding.conversationId))) return binding.conversationId;
    const at = this.now();
    const conversation: ConversationRecord = {
      id: this.createId(),
      ownerId,
      workspaceId: binding.workspaceId,
      ...(createdByOwner(binding.createdBy) ? {} : { createdBy: binding.createdBy }),
      title: `${agentName} · ${placeOf(binding)}`.slice(0, 60),
      createdAt: at,
      updatedAt: at,
      messages: []
    };
    await store.conversations.upsert(conversation);
    await this.records.patchBinding(binding.id, (b) => ({ ...b, conversationId: conversation.id }));
    return conversation.id;
  }

  private withinRate(bindingId: string): boolean {
    const at = this.now();
    const recent = (this.hits.get(bindingId) ?? []).filter((t) => at - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      this.hits.set(bindingId, recent);
      return false;
    }
    recent.push(at);
    this.hits.set(bindingId, recent);
    return true;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.options.maxConcurrent ?? DEFAULT_CONCURRENCY;
    if (this.active >= max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private track<T>(work: Promise<T>): void {
    const settled = work.catch((error: unknown) => this.options.log("presence.background_failed", { error: errorText(error) }));
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }

  private view(binding: PresenceBinding, canEdit: boolean): PresenceBindingView {
    return {
      id: binding.id,
      agentId: binding.agentId,
      provider: binding.provider,
      connectionId: binding.connectionId,
      channelId: binding.channelId,
      ...(binding.channelName ? { channelName: binding.channelName } : {}),
      ...(binding.teamId ? { teamId: binding.teamId } : {}),
      ...(binding.teamName ? { teamName: binding.teamName } : {}),
      respond: binding.respond,
      status: binding.status,
      ...(binding.statusMessage ? { statusMessage: binding.statusMessage } : {}),
      ...(binding.createdByName ? { createdByName: binding.createdByName } : {}),
      createdAt: binding.createdAt,
      ...(binding.lastActivityAt ? { lastActivityAt: binding.lastActivityAt } : {}),
      canEdit
    };
  }
}

export function placeOf(binding: Pick<PresenceBinding, "provider" | "channelId" | "channelName" | "teamName">): string {
  if (binding.provider === "slack") return `Slack #${binding.channelName ?? binding.channelId}`;
  return `Teams ${binding.teamName ?? "team"} › ${binding.channelName ?? "channel"}`;
}

function withoutSubscription(binding: PresenceBinding): PresenceBinding {
  const next = { ...binding };
  delete next.subscription;
  return next;
}

function errorText(error: unknown): string {
  if (error instanceof ConnectorHttpError) return `HTTP ${error.status}${error.detail ? ` (${error.detail})` : ""}`;
  return error instanceof Error ? error.message : String(error);
}

