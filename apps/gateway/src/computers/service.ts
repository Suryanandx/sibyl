/**
 * Agent computers: one sandbox per agent, started on demand by its browser
 * tools and stopped when idle, at its wall-clock cap, when its daily time or
 * budget runs out, when someone presses Stop, or when the agent loses its
 * computer. Time is metered per agent per day (and, with a price per hour,
 * through the UsageMeter toward the agent's and the owner's budgets).
 *
 * People who can see an agent can watch its computer live (status, actions,
 * screencast frames) and replay a run's timeline afterwards.
 */
import { randomUUID } from "node:crypto";
import { PERMISSIONS, authorize, type AgentRecord, type Store, type ToolContext, type ToolResult, type UsageMeter } from "@open-gpt-live/core";
import { COMPUTER_EVENTS, type ComputerActionView, type ComputerStatusView, type ComputersInfoMessage, type ComputerTimelineMessage, type ServerMessage } from "@open-gpt-live/protocol";
import { createdByOwner } from "../agents/access.js";
import type { NotificationInput } from "../notifications/service.js";
import type { ComputersConfig } from "./config.js";
import type { Availability, Sandbox, SandboxDriver } from "./docker.js";
import type { EgressProxy, ProxyCredentials } from "./egress-proxy.js";
import type { FileArea } from "./files.js";
import { BrowserSession, hostOf, type Frame, type SessionEvents } from "./session.js";
import type { Timeline } from "./timeline.js";

type Log = (event: string, fields?: Record<string, unknown>) => void;

/** One browser action may take this long before it is abandoned. */
export const ACTION_TIMEOUT_MS = 90_000;
const TICK_MS = 5_000;
const AVAILABILITY_TTL_MS = 30_000;
const WATCHER_RECHECK_MS = 60_000;
const FRAME_INTERVAL_MS = 150;
const USAGE_KEY = (agentId: string): string => `computers.usage.${agentId}`;

export interface ComputerServiceOptions {
  store: Store;
  ownerId: string;
  meter: UsageMeter;
  config: ComputersConfig;
  driver: SandboxDriver;
  proxy: EgressProxy;
  files: FileArea;
  timeline: Timeline;
  log: Log;
  notify?(input: NotificationInput): void;
  now?(): number;
  /** Test seam: connect to a sandbox's browser (default: BrowserSession.open). */
  openBrowser?(sandbox: Sandbox, events: SessionEvents, signal: AbortSignal): Promise<BrowserSession>;
}

/** What a tool's browser step reports back. */
export interface ActionOutcome {
  /** For the model. */
  content: string;
  /** For people (timeline, live log): "Opened example.com". */
  label: string;
  status?: ComputerActionView["status"];
  detail?: string;
  data?: unknown;
}

export interface Watcher {
  send(message: ServerMessage): void;
  /** Can this person still see the agent? Re-checked periodically. */
  allowed(): Promise<boolean>;
}

interface Running {
  agentId: string;
  agentName: string;
  workspaceId: string;
  createdBy: string;
  sandbox: Sandbox;
  credentials: ProxyCredentials;
  browser: BrowserSession;
  startedAt: number;
  lastActionAt: number;
  lastTickAt: number;
  runId?: string;
  url: string;
  title: string;
}

interface Usage {
  day: string;
  seconds: number;
}

class ComputerError extends Error {}

export class ComputerService {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, { workspaceId: string; promise: Promise<Running> }>();
  private readonly usage = new Map<string, Usage>();
  private readonly watchers = new Map<string, Set<Watcher>>();
  private readonly frameTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastFrameSent = new Map<string, number>();
  /** Proxy username → agent (refusals are logged to that agent's timeline). */
  private readonly proxyUsers = new Map<string, string>();
  private availability: { value: Availability; at: number } | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private lastWatcherCheck = 0;
  private readonly now: () => number;

  constructor(private readonly options: ComputerServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.tickTimer ??= setInterval(() => void this.tick(), TICK_MS);
    this.tickTimer.unref?.();
  }

  /* ───────────── availability & settings ───────────── */

  async available(force = false): Promise<Availability> {
    const cached = this.availability;
    if (!force && cached && this.now() - cached.at < AVAILABILITY_TTL_MS) return cached.value;
    if (!this.options.proxy.port) return { ok: false, reason: "The sandbox network proxy is not running (see the gateway log)" };
    const value = await this.options.driver.check().catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    this.availability = { value, at: this.now() };
    return value;
  }

  async info(): Promise<Omit<ComputersInfoMessage, "type">> {
    const availability = await this.available();
    return {
      available: availability.ok,
      ...(availability.ok ? {} : { reason: availability.reason }),
      defaults: { idleMinutes: this.options.config.idleMinutes, dailyMinutes: this.options.config.dailyMinutes }
    };
  }

  limits(agent: Pick<AgentRecord, "computer">): { idleMinutes: number; dailyMinutes: number } {
    return {
      idleMinutes: agent.computer?.idleMinutes ?? this.options.config.idleMinutes,
      dailyMinutes: agent.computer?.dailyMinutes ?? this.options.config.dailyMinutes
    };
  }

  /* ───────────── metering ───────────── */

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private async usageFor(agentId: string): Promise<Usage> {
    const day = this.today();
    let usage = this.usage.get(agentId);
    if (!usage) {
      const saved = await this.options.store.kv.get<Usage>(this.options.ownerId, USAGE_KEY(agentId)).catch(() => undefined);
      usage = saved && typeof saved.seconds === "number" ? saved : { day, seconds: 0 };
      this.usage.set(agentId, usage);
    }
    if (usage.day !== day) {
      usage.day = day;
      usage.seconds = 0;
    }
    return usage;
  }

  private async addTime(running: Running, seconds: number): Promise<void> {
    if (seconds <= 0) return;
    const usage = await this.usageFor(running.agentId);
    usage.seconds += seconds;
    await this.options.store.kv.set(this.options.ownerId, USAGE_KEY(running.agentId), usage).catch(() => undefined);
    const { usdPerHour } = this.options.config;
    if (usdPerHour > 0) {
      this.options.meter.record({
        ownerId: this.options.ownerId,
        feature: "tool",
        model: "agent-computer",
        costUsd: (seconds / 3_600) * usdPerHour,
        estimated: true,
        units: Math.round(seconds),
        agentId: running.agentId,
        ...(running.runId ? { requestId: running.runId } : {})
      });
    }
  }

  /** Why the agent's computer may not run now (time or budget), or undefined. */
  private async pauseReason(agent: AgentRecord): Promise<string | undefined> {
    const { dailyMinutes } = this.limits(agent);
    const usage = await this.usageFor(agent.id);
    if (usage.seconds >= dailyMinutes * 60) {
      return `${agent.name}'s computer time for today is used up (${dailyMinutes} min). It resumes tomorrow (UTC), or raise the daily limit in the agent's settings.`;
    }
    if (this.options.config.usdPerHour > 0) {
      const decision = this.options.meter.check({
        ownerId: this.options.ownerId,
        estimateUsd: this.options.config.usdPerHour / 60,
        agent: { id: agent.id, name: agent.name, ...agent.budget }
      });
      if (!decision.allowed) return decision.message;
    }
    return undefined;
  }

  /* ───────────── lifecycle ───────────── */

  private async ensure(agent: AgentRecord, runId: string, signal: AbortSignal): Promise<Running> {
    const existing = this.running.get(agent.id);
    if (existing) return existing;
    const pending = this.starting.get(agent.id);
    if (pending) return pending.promise;
    const inWorkspace =
      [...this.running.values()].filter((r) => r.workspaceId === agent.workspaceId).length +
      [...this.starting.values()].filter((s) => s.workspaceId === agent.workspaceId).length;
    const max = this.options.config.maxPerWorkspace;
    if (inWorkspace >= max) {
      throw new ComputerError(`${max} agent computer${max === 1 ? " is" : "s are"} already running in this workspace (the limit). Try again when one stops.`);
    }
    const promise = this.launch(agent, runId, signal);
    this.starting.set(agent.id, { workspaceId: agent.workspaceId, promise });
    this.broadcastStatus(agent.id);
    try {
      return await promise;
    } finally {
      this.starting.delete(agent.id);
      this.broadcastStatus(agent.id);
    }
  }

  private async launch(agent: AgentRecord, runId: string, signal: AbortSignal): Promise<Running> {
    const { proxy, driver, config } = this.options;
    const credentials = proxy.issue();
    this.proxyUsers.set(credentials.username, agent.id);
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await driver.start({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        proxy: { server: `http://${config.proxyHost}:${proxy.port}`, ...credentials }
      });
      const startedAt = this.now();
      const holder: { running?: Running } = {};
      const open = this.options.openBrowser ?? ((box: Sandbox, events: SessionEvents, abort: AbortSignal) => BrowserSession.open(box, events, abort));
      const browser = await open(
        sandbox,
        {
          frame: (frame) => this.frame(agent.id, frame),
          navigated: (page) => {
            const running = holder.running;
            if (!running) return;
            running.url = page.url;
            running.title = page.title;
            this.broadcastStatus(agent.id);
          },
          lost: (reason) => void this.stop(agent.id, reason)
        },
        signal
      );
      const running: Running = {
        agentId: agent.id,
        agentName: agent.name,
        workspaceId: agent.workspaceId,
        createdBy: agent.createdBy,
        sandbox,
        credentials,
        browser,
        startedAt,
        lastActionAt: startedAt,
        lastTickAt: startedAt,
        runId,
        url: browser.url(),
        title: ""
      };
      holder.running = running;
      this.running.set(agent.id, running);
      this.options.log("computers.started", { agentId: agent.id, workspaceId: agent.workspaceId, sandbox: sandbox.id.slice(0, 12) });
      return running;
    } catch (error) {
      proxy.revoke(credentials.username);
      this.proxyUsers.delete(credentials.username);
      await sandbox?.stop().catch(() => undefined);
      this.options.log("computers.start_failed", { agentId: agent.id, error: errorText(error) });
      throw new ComputerError(`${agent.name}'s computer could not start: ${errorText(error)}`);
    }
  }

  /**
   * Stop an agent's sandbox. `paused`: a limit stopped it (people are told
   * why); otherwise it just goes off and starts again on the next action.
   */
  async stop(agentId: string, reason: string, paused = false): Promise<boolean> {
    const running = this.running.get(agentId);
    if (!running) return false;
    this.running.delete(agentId);
    const now = this.now();
    await this.addTime(running, (now - running.lastTickAt) / 1_000);
    this.options.proxy.revoke(running.credentials.username);
    this.proxyUsers.delete(running.credentials.username);
    await running.browser.close();
    await running.sandbox.stop().catch(() => undefined);
    clearTimeout(this.frameTimers.get(agentId));
    this.frameTimers.delete(agentId);
    this.options.log("computers.stopped", { agentId, reason, seconds: Math.round((now - running.startedAt) / 1_000) });
    if (running.runId) {
      await this.record(running, { tool: "computer_stop", label: paused ? "Paused" : "Stopped", status: paused ? "blocked" : "ok", detail: reason }, undefined);
    }
    if (paused) {
      this.options.notify?.({
        kind: "budget_blocked",
        workspaceId: running.workspaceId,
        ...(createdByOwner(running.createdBy) ? {} : { recipientUserId: running.createdBy }),
        title: `${running.agentName}'s computer paused`,
        body: reason,
        links: { agentId }
      });
    }
    this.broadcastStatus(agentId, paused ? reason : undefined);
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const pending of this.starting.values()) await pending.promise.catch(() => undefined);
    await Promise.all([...this.running.keys()].map((agentId) => this.stop(agentId, "The gateway is shutting down.")));
    await this.options.proxy.close();
  }

  /** Stop sandboxes whose agent was deleted or lost its computer (agents changed). */
  async reconcile(): Promise<void> {
    for (const agentId of [...this.running.keys()]) {
      const agent = await this.options.store.agents.get(this.options.ownerId, agentId);
      if (!agent?.computer?.enabled) await this.stop(agentId, agent ? "The agent's computer was turned off." : "The agent was deleted.");
      if (!agent) await this.options.files.remove(agentId).catch(() => undefined);
    }
  }

  private async tick(): Promise<void> {
    const now = this.now();
    for (const running of [...this.running.values()]) {
      await this.addTime(running, (now - running.lastTickAt) / 1_000);
      running.lastTickAt = now;
      const agent = await this.options.store.agents.get(this.options.ownerId, running.agentId);
      if (!agent?.computer?.enabled) {
        await this.stop(running.agentId, "The agent's computer was turned off.");
        continue;
      }
      const { idleMinutes } = this.limits(agent);
      if (now - running.lastActionAt >= idleMinutes * 60_000) {
        await this.stop(running.agentId, `Stopped after ${idleMinutes} idle minute${idleMinutes === 1 ? "" : "s"}.`);
        continue;
      }
      if (now - running.startedAt >= this.options.config.maxSessionMinutes * 60_000) {
        await this.stop(running.agentId, `Stopped at the ${this.options.config.maxSessionMinutes}-minute session limit; it starts fresh on the next action.`);
        continue;
      }
      const paused = await this.pauseReason(agent);
      if (paused) await this.stop(running.agentId, paused, true);
      else this.broadcastStatus(running.agentId);
    }
    if (now - this.lastWatcherCheck >= WATCHER_RECHECK_MS) {
      this.lastWatcherCheck = now;
      for (const [agentId, set] of this.watchers) {
        for (const watcher of [...set]) if (!(await watcher.allowed().catch(() => false))) set.delete(watcher);
        if (!set.size) this.watchers.delete(agentId);
      }
    }
  }

  /** The egress proxy refused a request from a sandbox. */
  blocked(username: string, target: string, reason: string): void {
    const agentId = this.proxyUsers.get(username);
    const running = agentId ? this.running.get(agentId) : undefined;
    this.options.log("computers.egress_blocked", { agentId, target: target.slice(0, 200), reason });
    if (running) void this.record(running, { tool: "network", label: `Blocked ${hostOf(target.includes("://") ? target : `https://${target}`)}`, status: "blocked", detail: reason }, undefined);
  }

  /* ───────────── tools ───────────── */

  /**
   * Run one browser step for a tool call: checks the agent may use its
   * computer now, starts the sandbox if needed, runs the step (one at a
   * time, with a time limit), and records it in the run's timeline.
   */
  async act(context: ToolContext, tool: string, step: (browser: BrowserSession, agent: AgentRecord) => Promise<ActionOutcome>): Promise<ToolResult> {
    const agent = await this.agentFor(context);
    if (typeof agent === "string") return { content: agent, isError: true };
    const availability = await this.available();
    if (!availability.ok) return { content: `${agent.name}'s computer is unavailable: ${availability.reason}`, isError: true };
    const paused = await this.pauseReason(agent);
    if (paused) {
      if (this.running.has(agent.id)) await this.stop(agent.id, paused, true);
      return { content: paused, isError: true };
    }
    let running: Running;
    try {
      running = await this.ensure(agent, context.runId, context.signal);
    } catch (error) {
      return { content: errorText(error), isError: true };
    }
    running.runId = context.runId;
    running.lastActionAt = this.now();
    let outcome: ActionOutcome;
    try {
      outcome = await running.browser.queue(() => withTimeout(step(running.browser, agent), ACTION_TIMEOUT_MS, context.signal));
    } catch (error) {
      outcome = { content: `The browser action failed: ${errorText(error)}`, label: "Failed", status: "error", detail: errorText(error) };
    }
    running.lastActionAt = this.now();
    if (this.running.get(agent.id) === running) {
      running.url = running.browser.url();
      running.title = await running.browser.title();
      const thumb = await running.browser.thumbnail();
      await this.record(running, { tool, label: outcome.label, status: outcome.status ?? "ok", ...(outcome.detail ? { detail: outcome.detail } : {}) }, thumb);
      this.broadcastStatus(agent.id);
    }
    const failed = outcome.status === "error" || outcome.status === "blocked";
    return { content: outcome.content, ...(failed ? { isError: true } : {}), ...(outcome.data === undefined ? {} : { data: outcome.data }) };
  }

  /** The agent behind a tool call, if it may use its computer (else why not). */
  async agentFor(context: Pick<ToolContext, "agent" | "principal">): Promise<AgentRecord | string> {
    const agentId = context.agent?.id;
    if (!agentId) return "Only an agent with its own computer can use the browser. Pick such an agent first.";
    const agent = await this.options.store.agents.get(this.options.ownerId, agentId);
    if (!agent) return "This agent no longer exists.";
    if (!agent.computer?.enabled) return `${agent.name} has no computer. Turn it on in the agent's settings.`;
    if (context.principal && !authorize(context.principal, PERMISSIONS.AGENTS_USE, { workspaceId: agent.workspaceId })) {
      return "You don't have permission to use agents in this workspace.";
    }
    return agent;
  }

  private async record(running: Running, action: Pick<ComputerActionView, "tool" | "label" | "status" | "detail">, thumb: Buffer | undefined): Promise<void> {
    if (!running.runId) return;
    const view: ComputerActionView = {
      id: randomUUID(),
      agentId: running.agentId,
      runId: running.runId,
      at: this.now(),
      tool: action.tool,
      label: action.label,
      ...(running.url && running.url !== "about:blank" ? { url: running.url } : {}),
      status: action.status,
      ...(action.detail ? { detail: action.detail.slice(0, 500) } : {})
    };
    await this.options.timeline.add(view, thumb).catch((error: unknown) => this.options.log("computers.timeline_failed", { error: errorText(error) }));
    this.broadcast(running.agentId, { type: COMPUTER_EVENTS.ACTION, action: view });
  }

  /* ───────────── watching ───────────── */

  async status(agentId: string, pausedReason?: string): Promise<ComputerStatusView> {
    const agent = await this.options.store.agents.get(this.options.ownerId, agentId);
    const limits = agent ? this.limits(agent) : { idleMinutes: this.options.config.idleMinutes, dailyMinutes: this.options.config.dailyMinutes };
    const usage = await this.usageFor(agentId);
    const running = this.running.get(agentId);
    const base = { agentId, usedSecondsToday: Math.round(usage.seconds), ...limits };
    if (running) {
      return {
        ...base,
        state: "running",
        url: running.url,
        ...(running.title ? { title: running.title } : {}),
        startedAt: running.startedAt,
        lastActionAt: running.lastActionAt,
        ...(running.runId ? { runId: running.runId } : {})
      };
    }
    if (this.starting.has(agentId)) return { ...base, state: "starting" };
    if (!agent?.computer?.enabled) return { ...base, state: "disabled" };
    const availability = await this.available();
    if (!availability.ok) return { ...base, state: "unavailable", reason: availability.reason };
    const paused = pausedReason ?? (await this.pauseReason(agent));
    return paused ? { ...base, state: "paused", reason: paused } : { ...base, state: "off" };
  }

  /** Live status, actions and frames of one agent's computer. Returns unsubscribe. */
  watch(agentId: string, watcher: Watcher): () => void {
    let set = this.watchers.get(agentId);
    if (!set) this.watchers.set(agentId, (set = new Set()));
    set.add(watcher);
    void this.status(agentId).then((status) => watcher.send({ type: COMPUTER_EVENTS.STATUS, status }));
    const frame = this.running.get(agentId)?.browser.lastFrame;
    if (frame) watcher.send(frameMessage(agentId, frame));
    return () => {
      set.delete(watcher);
      if (!set.size && this.watchers.get(agentId) === set) this.watchers.delete(agentId);
    };
  }

  async timeline(agentId: string, runId?: string): Promise<Omit<ComputerTimelineMessage, "type">> {
    const runs = await this.options.timeline.runs(agentId);
    const shown = runId ?? runs[0]?.runId;
    return { agentId, runs, ...(shown ? { runId: shown } : {}), actions: shown ? await this.options.timeline.actions(agentId, shown) : [] };
  }

  private broadcast(agentId: string, message: ServerMessage): void {
    for (const watcher of this.watchers.get(agentId) ?? []) {
      try {
        watcher.send(message);
      } catch {
        // A closing socket.
      }
    }
  }

  private broadcastStatus(agentId: string, pausedReason?: string): void {
    if (!this.watchers.get(agentId)?.size) return;
    void this.status(agentId, pausedReason).then((status) => this.broadcast(agentId, { type: COMPUTER_EVENTS.STATUS, status }));
  }

  /** Screencast frames go to watchers at most every FRAME_INTERVAL_MS (the latest wins). */
  private frame(agentId: string, frame: Frame): void {
    if (!this.watchers.get(agentId)?.size || this.frameTimers.has(agentId)) return;
    const wait = Math.max(0, (this.lastFrameSent.get(agentId) ?? 0) + FRAME_INTERVAL_MS - Date.now());
    const timer = setTimeout(() => {
      this.frameTimers.delete(agentId);
      const latest = this.running.get(agentId)?.browser.lastFrame ?? frame;
      this.lastFrameSent.set(agentId, Date.now());
      this.broadcast(agentId, frameMessage(agentId, latest));
    }, wait);
    timer.unref?.();
    this.frameTimers.set(agentId, timer);
  }

  /** Sandboxes running now (diagnostics, tests). */
  runningAgents(): string[] {
    return [...this.running.keys()];
  }

  /** For tests: run the periodic checks now. */
  async runChecks(): Promise<void> {
    await this.tick();
  }
}

function frameMessage(agentId: string, frame: Frame): ServerMessage {
  return { type: COMPUTER_EVENTS.FRAME, agentId, mimeType: "image/jpeg", data: frame.data, width: frame.width, height: frame.height, at: frame.at };
}

async function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it took longer than ${Math.round(ms / 1_000)} s`)), ms);
        onAbort = () => reject(new Error("the run was stopped"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.replace(/^\w+\.\w+: /, "").slice(0, 300);
}
