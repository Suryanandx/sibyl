/**
 * The gateway's shared runtime: one store, one tool registry, one usage meter.
 *
 * Wiring lives here (not in server.ts) so each capability is installed in
 * exactly one place:
 * - storage:   SQLite store via openStore() (SIBYL_STORAGE=memory for none)
 * - metering:  createUsageMeter() over the store, budgets from SIBYL_BUDGET_*
 * - tools:     register built-ins / MCP / slides tools in installTools()
 * - governance: the one audit(event) path and the tool/model policy hook
 *   (enterprise modules plug in; without a licence it records nothing)
 *
 * One runtime serves one organization (`orgId`, default the self-hosted
 * "owner"). Hosted Sibyl builds one per organization through the tenant
 * registry (tenancy/registry.ts), all sharing one store and one meter.
 */
import {
  DEFAULT_OWNER_ID,
  createGovernance,
  createMemoryStore,
  createToolRegistry,
  type Governance,
  type EnterpriseSecrets,
  type Store,
  type ToolRegistry,
  type UsageMeter
} from "@open-gpt-live/core";
import { createUsageMeter } from "./metering/meter.js";
import { applyAppBudgets } from "./metering/app-budgets.js";
import { installSibylTools, type InstalledTools } from "./tools/index.js";
import type { ConnectionsManager } from "./tools/connections.js";
import { openStore } from "@open-gpt-live/store";
import { installSlides, type SlidesService } from "./slides/index.js";
import { installMemoryAndUploadTools } from "./memory/install.js";
import { RoutineService } from "./routines/service.js";
import { installSecrets, resolveSecretRefs, type SecretsService } from "./secrets/index.js";
import { installLicense, type LicenseRuntime } from "./license/index.js";
import { installMonitors, type MonitorService } from "./monitors/index.js";
import { installKnowledge, type KnowledgeService } from "./knowledge/index.js";
import { installSkills, type SkillsService } from "./skills/index.js";
import { PluginService } from "./plugins/index.js";
import { installConnectors, type ConnectorService } from "./connectors/index.js";
import { AgentRuntime } from "./agents/runtime.js";
import { installNotifications, type NotificationService } from "./notifications/index.js";
import { installPresence, type PresenceService } from "./presence/index.js";
import { installComputers, type ComputerService } from "./computers/index.js";
import { installRealtime, type RealtimeService } from "./realtime/index.js";
import { installMeetings, type MeetingService } from "./meetings/index.js";
import { installMedia, type MediaService } from "./media/index.js";
import { uploadServiceFor } from "./uploads/index.js";
import type { GatewayUsageMeter } from "./metering/meter.js";
import { CreditsService, creditsMargin, type PaymentProvider } from "./tenancy/credits.js";
import { ModelAccessService, readOwnModelKey, resolveModelAccess } from "./tenancy/model-access.js";

export interface GatewayRuntime {
  ownerId: string;
  /** The environment the runtime was built with: the organization's model key as OPENROUTER_API_KEY (see tenancy/model-access.ts). */
  modelEnv?: NodeJS.ProcessEnv;
  /** Which OpenRouter key model calls use; saving or removing the organization's own key (see docs/hosting.md). */
  modelAccess?: ModelAccessService;
  /** Hosted: the organization's AI credits (charged per call when it has no own key). */
  credits?: CreditsService;
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  /** Audit trail + tool/model policy (see packages/core/src/governance.ts). */
  governance: Governance;
  /** Sibyl Slides (engine client + decks), when the engine is configured. */
  slides?: SlidesService;
  /** MCP servers and tool switches managed from the app (absent in bare test runtimes). */
  connections?: ConnectionsManager;
  /** Routines + approval inbox (chat tools now; scheduler started by the server). */
  routines?: RoutineService;
  /** Monitors: watch sources, notify or start tasks (see docs/monitors.md). */
  monitors?: MonitorService;
  /** Secrets vault, secure prompt and Secrets panel (see docs/secrets.md). */
  secrets?: SecretsService;
  /** Licence key, edition and enterprise modules (see LICENSING.md). */
  license?: LicenseRuntime;
  /** Knowledge bases, skills and plugins (v0.4; see docs/knowledge.md, docs/skills-and-plugins.md). */
  knowledge?: KnowledgeService;
  skills?: SkillsService;
  plugins?: PluginService;
  /** Native connectors: Google, Microsoft (+ HubSpot, Salesforce from ee/). See docs/integrations.md. */
  connectors?: ConnectorService;
  /** User-created agents (see docs/agents.md). */
  agents?: AgentRuntime;
  /** The one notifications path (store, live push, inbox/email/…; the shared mailer). */
  notifications?: NotificationService;
  /** Agents in Slack and Teams channels; Slack/Teams notifications (see docs/slack-and-teams.md). */
  presence?: PresenceService;
  /** Agent computers: sandboxed browsers (see docs/agent-computers.md); absent when SIBYL_COMPUTERS=off. */
  computers?: ComputerService;
  /** LiveKit realtime layer, only when LIVEKIT_* is set (see docs/realtime.md). */
  realtime?: RealtimeService;
  /** Meetings: records, transcripts, AI notes, comments; the room when realtime is on (see docs/meetings.md). */
  meetings?: MeetingService;
  /** Images, video and audio through OpenRouter (see docs/media.md); absent without a key or with SIBYL_MEDIA=off. */
  media?: MediaService;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Organization this runtime serves (default: the self-hosted "owner"). */
  orgId?: string;
  /** The store connection and usage meter shared by every organization's runtime (not closed by it). */
  shared?: { store: Store; meter: GatewayUsageMeter };
  /** Hosted Sibyl: AI credits, no licence or enterprise modules (see docs/hosting.md). */
  hosted?: boolean;
  /** Hosted: how organizations buy credits (absent: they can't in the app). */
  payments?: PaymentProvider;
}

/** Open the store (SQLite in $SIBYL_DATA_DIR/sibyl.db, or memory with SIBYL_STORAGE=memory) and the usage meter shared by all organizations. */
export async function openSharedRuntime(env: NodeJS.ProcessEnv, log: RuntimeOptions["log"]): Promise<{ store: Store; meter: GatewayUsageMeter }> {
  const { store, kind, file } = openStore(env);
  log("store.opened", { kind, ...(file ? { file } : {}) });
  const meter = await createUsageMeter({ store, ownerId: DEFAULT_OWNER_ID, env, log, load: false });
  return { store, meter };
}

export async function createRuntime(input: RuntimeOptions): Promise<GatewayRuntime> {
  const ownerId = input.orgId ?? DEFAULT_OWNER_ID;
  const hosted = input.hosted ?? false;
  const shared = input.shared ?? (await openSharedRuntime(input.env, input.log));
  const { store } = shared;
  // The organization's own OpenRouter key (vault) wins over the server's: the runtime is built for one key.
  const access = resolveModelAccess({ env: input.env, hosted, ownKey: await readOwnModelKey({ store, env: input.env, orgId: ownerId, log: input.log }) });
  const options: RuntimeOptions = { ...input, env: access.env };
  options.log("model_access.mode", { orgId: ownerId, mode: access.mode });
  const tools = createToolRegistry();
  const governance = createGovernance({
    orgId: ownerId,
    onError: (where, error) => options.log("governance.hook_failed", { where, error: error instanceof Error ? error.message : String(error) })
  });
  const audit = governance.audit.bind(governance);
  const meter = shared.meter;
  // This organization's spend so far and its in-app budgets (Admin → Organization, Settings → Workspace).
  await meter.load([ownerId]).catch((error: unknown) => options.log("usage.load_failed", { error: error instanceof Error ? error.message : String(error) }));
  await applyAppBudgets(meter, store, ownerId).catch((error: unknown) => options.log("usage.budgets_failed", { error: error instanceof Error ? error.message : String(error) }));
  // Hosted organizations without their own key run on the platform key and pay with AI credits.
  const credits = hosted
    ? await new CreditsService({ store, orgId: ownerId, active: access.mode === "credits", margin: creditsMargin(options.env), ...(input.payments ? { payments: input.payments } : {}), log: options.log }).load()
    : undefined;
  const removeCreditsPolicy = credits?.active ? meter.addPolicy(credits.policy()) : undefined;
  // Notifications first: routines, monitors, agents and invitations all publish through it (and its one mailer).
  const notifications = installNotifications({ store, ownerId, env: options.env, log: options.log });
  // Routine chat tools register before the per-tool switches are applied.
  const routines = new RoutineService({ store, tools, meter, ownerId, env: options.env, log: options.log, notifications, governance });
  await routines.init();
  // Old notices are deleted on the shared scheduler (SIBYL_NOTIFICATION_RETENTION_DAYS).
  routines.addJobType(notifications.retentionJob);
  // Monitors: chat tools now; checks run on the routine scheduler (started by the server).
  let secretsService: SecretsService | undefined;
  const monitors = installMonitors({
    store,
    tools,
    meter,
    ownerId,
    env: options.env,
    log: options.log,
    routines,
    notifications,
    vault: () => secretsService?.vault
  });
  // Knowledge (search_knowledge, …) and skills (use_skill) register before the tool switches.
  const knowledge = await installKnowledge({ tools, store, meter, ownerId, env: options.env, log: options.log });
  const skills = await installSkills({ tools, store, ownerId, log: options.log });
  // Agents: "act, then tell me" notices are notifications too (plus Slack/Teams when the agent chose them).
  let presence: PresenceService | undefined;
  const agents = new AgentRuntime({ store, tools, meter, ownerId, log: options.log, notify: (input) => notifications.publish(input, { channels: presence?.channelsFor(input) ?? [] }) });
  // Routines and monitor tasks run as an agent through the same AgentTurn as chat.
  routines.agents = agents;
  if (monitors) monitors.agents = agents;
  // Agent computers: browser tools register before the tool switches; secrets come from the vault below.
  const computers = await installComputers({
    store,
    tools,
    meter,
    ownerId,
    env: options.env,
    log: options.log,
    agents,
    vault: () => secretsService?.vault,
    notify: (input) => notifications.publish(input)
  });
  // Realtime (LiveKit; off unless LIVEKIT_* is set): its tools register before the tool switches.
  const realtime = installRealtime({
    env: options.env,
    store,
    tools,
    ownerId,
    agents,
    vault: () => secretsService?.vault,
    notify: (input) => notifications.publish(input),
    log: options.log
  });
  // Meetings own the realtime layer's call records (the meeting id is the call id).
  const meetings = installMeetings({ store, tools, meter, ownerId, env: options.env, log: options.log, notifications, ...(realtime ? { realtime } : {}) });
  // Media generation (create_image / create_video / create_audio): results are uploads; tools before the switches.
  const media = await installMedia({ tools, store, meter, ownerId, uploads: uploadServiceFor({ store, ownerId, env: options.env, log: options.log }), env: options.env, log: options.log });
  const installed = await installTools({ tools, store, meter, ownerId, options, audit });
  secretsService = installed.secrets;
  // Finished deck builds become "Deck ready" notifications (inbox + toast on every screen).
  installed.slides?.notifyWith((input) => notifications.publish(input));
  const plugins = new PluginService({
    store,
    ownerId,
    skills,
    knowledge,
    connections: installed.connections,
    ...(installed.secrets ? { vault: installed.secrets.vault } : {}),
    routines,
    env: options.env,
    log: options.log
  });
  // Native connectors (credentials encrypted with the vault key; tools per action).
  const connectors = await installConnectors({ store, ownerId, tools, ...(installed.secrets ? { vault: installed.secrets.vault } : {}), env: options.env, log: options.log, audit });
  // Licence (SIBYL_LICENSE_KEY) and, when licensed and present, the ee/ modules
  // (enterprise connectors register with the connector catalogue here).
  // Enterprise modules get the governance hooks, notifications, the mailer, the scheduler and the vault.
  // Hosted Sibyl has none: Enterprise is a separate deployment (Agent Serve), and these modules are per process.
  const license = hosted
    ? undefined
    : await installLicense({
        env: options.env,
        store,
        tools,
        meter,
        ownerId,
        log: options.log,
        governance,
        notify: (notice) => notifications.publish(notice),
        addJobType: (type) => routines.addJobType(type),
        ...(notifications.mailer ? { mailer: notifications.mailer } : {}),
        ...(installed.secrets ? { secrets: vaultFor(installed.secrets.vault, ownerId) } : {}),
        // Call recordings plug into the realtime layer (announce, link to meetings, record phone calls).
        ...(realtime ? { calls: realtime.recordingHost() } : {})
      });
  const modelAccess = new ModelAccessService({
    store,
    orgId: ownerId,
    vault: installed.secrets?.vault,
    hosted,
    mode: access.mode,
    serverKey: Boolean(input.env.OPENROUTER_API_KEY?.trim()),
    ...(credits ? { creditsBalance: () => credits.balanceUsd() } : {}),
    log: options.log
  });
  // Agents in Slack and Teams (through the connectors) and the Slack/Teams notifiers.
  presence = connectors
    ? await installPresence({ store, ownerId, tools, meter, env: options.env, log: options.log, connectors, agents, notifications, routines })
    : undefined;
  return {
    ownerId,
    modelEnv: options.env,
    modelAccess,
    ...(credits ? { credits } : {}),
    store,
    tools,
    meter,
    governance,
    ...(installed.slides ? { slides: installed.slides } : {}),
    connections: installed.connections,
    routines,
    ...(monitors ? { monitors } : {}),
    agents,
    notifications,
    ...(computers ? { computers } : {}),
    ...(installed.secrets ? { secrets: installed.secrets } : {}),
    ...(license ? { license } : {}),
    knowledge,
    skills,
    plugins,
    ...(connectors ? { connectors } : {}),
    ...(presence ? { presence } : {}),
    ...(realtime ? { realtime } : {}),
    meetings,
    ...(media ? { media } : {}),
    close: async () => {
      await realtime?.close();
      media?.close();
      knowledge.close();
      await presence?.close();
      await computers?.close();
      await agents.settle();
      await license?.close();
      connectors?.close();
      installed.secrets?.close();
      await monitors?.stop();
      await routines.stop();
      notifications.close();
      await installed.close();
      removeCreditsPolicy?.();
      // The store and meter are shared: closed by whoever opened them (the server), unless this runtime opened them.
      if (!input.shared) await store.close();
    }
  };
}

async function installTools(input: {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  ownerId: string;
  options: RuntimeOptions;
  audit: Governance["audit"];
}): Promise<InstalledTools & { slides?: SlidesService; secrets?: SecretsService }> {
  // Slides first, so the persisted per-tool switches below apply to them too.
  const slides = await installSlides({ ...input, env: input.options.env, log: input.options.log });
  // Memory (remember/forget/recall, unless SIBYL_MEMORY=false) and read_file for uploads.
  installMemoryAndUploadTools({ tools: input.tools, store: input.store, ownerId: input.ownerId, env: input.options.env, log: input.options.log });
  // Secrets vault + request_secret / list_secrets / api_request (before the switches too).
  const secrets = await installSecrets({ ...input, env: input.options.env, log: input.options.log });
  // Built-in tools, MCP servers (mcp.config.json) and persisted per-tool switches.
  // MCP env/header values may use ${secret:NAME}; resolved from the vault only when connecting.
  const installed = await installSibylTools({
    ...input,
    env: input.options.env,
    log: input.options.log,
    ...(secrets
      ? { resolveSecrets: (value: string, ctx: { host?: string }) => resolveSecretRefs(value, { host: ctx.host, ownerId: input.ownerId, vault: secrets.vault }) }
      : {})
  });
  return { ...installed, ...(slides ? { slides } : {}), ...(secrets ? { secrets } : {}) };
}

/** The vault as enterprise modules see it: bound to the organisation, values only for allowed hosts. */
function vaultFor(vault: SecretsService["vault"], ownerId: string): EnterpriseSecrets {
  return {
    set: async (input) => {
      await vault.set(ownerId, input);
    },
    resolve: (name, host) => vault.resolve(ownerId, name, { host }),
    has: (name) => vault.has(ownerId, name),
    delete: async (name) => {
      await vault.delete(ownerId, name);
    }
  };
}

/** Meter that records nothing and never blocks (until metering is installed). */
export function createNoopMeter(): UsageMeter {
  return {
    record() {},
    totals: () => ({ todayUsd: 0, monthUsd: 0, sessionUsd: 0, byFeature: {} }),
    check: () => ({ allowed: true }),
    limits: () => ({})
  };
}

/** Runtime for tests and embedded use: memory store, empty registry, no-op meter. */
export function createTestRuntime(overrides: Partial<GatewayRuntime> = {}): GatewayRuntime {
  return {
    ownerId: DEFAULT_OWNER_ID,
    store: createMemoryStore(),
    tools: createToolRegistry(),
    meter: createNoopMeter(),
    governance: createGovernance({ orgId: DEFAULT_OWNER_ID }),
    close: async () => {},
    ...overrides
  };
}
