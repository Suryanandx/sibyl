import {
  OpenAILLMProvider,
  OpenAIToolChatClient,
  OpenAIRealtimeSTTProvider,
  OpenAITTSProvider,
  OpenAIWhisperProvider,
  type OpenAIRealtimeTranscriptionDelay,
  type StreamingSTTProvider,
  type TTSProvider
} from "@open-gpt-live/adapters";
import {
  buildBrainSystemPrompt,
  buildGenUiSystemPrompt,
  buildRealtimeVoicePrompt,
  buildVoicePrompt
} from "@open-gpt-live/genui";
import { DEFAULT_OWNER_ID } from "@open-gpt-live/core";
import { Agent, setGlobalDispatcher } from "undici";
import { WebSocket } from "ws";
import { loadGatewayRuntimeConfig, type GatewayRuntimeConfig } from "./config.js";
import { discoverOpenRouterVoices, loadModelCatalog, mergePinnedModels } from "./models.js";
import { hasFreshScoutCache, scoutModels } from "./scout.js";
import { createRuntime, openSharedRuntime, type GatewayRuntime } from "./runtime.js";
import { createMeteredFetch } from "./metering/fetch.js";
import type { GatewayProviders, GatewayServerHandle, GatewayTenant, ModelUpdate } from "./gateway.js";
import { loadProjectEnvironment } from "./environment.js";
import { createGatewayServer } from "./gateway.js";
import { liveKitSpeechFromEnv } from "./voice/livekit-inference.js";
import { createJsonLogger } from "./logger.js";
import { deploymentMode } from "./tenancy/mode.js";
import { TenantRegistry, tenantIdleMs, type TenantHandle } from "./tenancy/registry.js";
import { paymentProviderFromEnv } from "./tenancy/credits.js";
import { PresenceStore } from "./presence/store.js";
import { keyFingerprint } from "./tenancy/model-access.js";
import { OrganizationService } from "./tenancy/organizations.js";
import { createHostedRouting } from "./tenancy/hosted.js";
import { SignupService } from "./identity/signup.js";
import { SignupTickets } from "./identity/signup-tickets.js";
import { createMailer } from "./notifications/mailer.js";
import { loadMasterKey } from "./secrets/crypto.js";

loadProjectEnvironment();

// Keep provider connections open between turns. Node's default keep-alive
// (4 s) drops them during normal pauses in a conversation, so every reply
// would pay a fresh TLS handshake.
setGlobalDispatcher(
  new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 10 * 60_000 })
);

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "gateway.start_failed",
      error: error instanceof Error ? error.message : String(error)
    })
  );
  process.exitCode = 1;
});

/** One organization's runtime, model providers and catalog (tenancy/registry.ts). */
interface Tenant extends TenantHandle, GatewayTenant {
  models: ModelUpdate;
  /** Its own key's catalog (scouted for that key), not the server's. */
  ownCatalog: boolean;
}

async function main(): Promise<void> {
  const config = loadGatewayRuntimeConfig();
  const logger = createJsonLogger(config.logLevel);
  const log = (event: string, fields?: Record<string, unknown>) => logger.info(event, fields);
  // Self-hosted (default): one organization. Hosted (SIBYL_MODE=hosted): many, one runtime each (docs/hosting.md).
  const hosted = deploymentMode(process.env) === "hosted";
  // One store connection and one usage meter for every organization.
  const shared = await openSharedRuntime(process.env, log);
  const payments = hosted ? paymentProviderFromEnv(process.env) : undefined;
  const models = loadModelCatalog(process.env, {
    llmModel: config.llm.model,
    sttModel: config.stt.model,
    ttsModel: config.tts.model,
    ttsVoice: config.ttsVoice
  });
  const staticCatalog = models.catalog;
  /** The server's catalog: organizations on the server's key (or the platform's) share it. */
  const serverModels = (): ModelUpdate => ({ catalog: models.catalog, defaults: models.defaults, llmParams: models.llmParams });
  // Pick cost-efficient models from the live OpenRouter catalog (for a key: the server's, or an organization's own).
  const runScout = async (input: { apiKey: string; cacheFile?: string; runtime: GatewayRuntime }): Promise<ModelUpdate | undefined> => {
    try {
      const startedAt = Date.now();
      const scouted = await scoutModels({
        baseUrl: config.llm.baseUrl,
        apiKey: input.apiKey,
        extraHeaders: config.extraHeaders,
        strategy: config.modelStrategy,
        probe: config.scoutProbe,
        ...(input.cacheFile ? { cacheFile: input.cacheFile } : {}),
        // Probes are real (tiny) paid requests: meter them as "scout".
        fetchImpl: createMeteredFetch({ meter: input.runtime.meter, ownerId: input.runtime.ownerId }),
        probePrompts: {
          voice: buildVoicePrompt(config.assistantName),
          brain: buildBrainSystemPrompt(config.genUiEnabled, config.assistantName)
        },
        log
      });
      mergePinnedModels(scouted.catalog, staticCatalog, models.source !== "env");
      logger.info("models.scouted", {
        ms: Date.now() - startedAt,
        generatedAt: scouted.generatedAt,
        strategy: config.modelStrategy,
        defaults: scouted.defaults,
        presets: scouted.catalog.presets?.map((p) => ({ id: p.id, costPer100Turns: p.costPer100Turns }))
      });
      return {
        catalog: scouted.catalog,
        defaults: scouted.defaults,
        llmParams: { ...scouted.llmParams, ...models.llmParams }
      };
    } catch (error) {
      logger.warn("models.scout_failed", {
        error: error instanceof Error ? error.message : String(error),
        fallback: models.source
      });
      return undefined;
    }
  };
  /** Catalogs scouted for organizations' own keys, by key fingerprint (cache file per key). */
  const ownCatalogs = new Map<string, Promise<ModelUpdate | undefined>>();
  const scoutCacheFor = (apiKey: string) => (config.scoutCacheFile ? `${config.scoutCacheFile.replace(/\.json$/, "")}.${keyFingerprint(apiKey)}.json` : undefined);

  let gateway: GatewayServerHandle | undefined;
  const serverKey = config.llm.apiKey ?? "";
  const buildTenant = async (orgId: string): Promise<Tenant> => {
    const runtime = await createRuntime({ env: process.env, log, orgId, shared, hosted, ...(payments ? { payments } : {}) });
    // The organization's own OpenRouter key, when it has one: providers, scout and catalog for that key.
    const tenantConfig = runtime.modelEnv === process.env ? config : loadGatewayRuntimeConfig(runtime.modelEnv);
    const tenantKey = tenantConfig.llm.apiKey ?? "";
    const ownKey = runtime.modelAccess?.mode === "byok" && tenantKey !== serverKey;
    let tenantModels = serverModels();
    if (ownKey && config.modelSelection === "auto") {
      const fingerprint = keyFingerprint(tenantKey);
      let scouted = ownCatalogs.get(fingerprint);
      if (!scouted) {
        scouted = runScout({ apiKey: tenantKey, cacheFile: scoutCacheFor(tenantKey), runtime });
        ownCatalogs.set(fingerprint, scouted);
        void scouted.then((update) => {
          if (!update) ownCatalogs.delete(fingerprint);
        });
      }
      // A fresh cache answers at once; a first scout (probes: ~30-60 s) runs on while the server's catalog is used.
      const ready = await Promise.race([scouted, new Promise<undefined>((resolve) => setTimeout(resolve, hasFreshScoutCache(scoutCacheFor(tenantKey)) ? 5_000 : 0))]);
      if (ready) tenantModels = ready;
      else void scouted.then((update) => update && registry.peek(orgId)?.runtime === runtime && applyModels(orgId, update));
    }
    const holder: { current: ModelUpdate } = { current: tenantModels };
    const tenantModelsNow = () => holder.current;
    const providers = createProviders(tenantConfig);
    // Knowledge OCR (images, scanned PDFs) picks its vision model from the live catalog.
    runtime.knowledge?.ocr?.useCatalog(() => tenantModelsNow().catalog);
    const brain = () => ({
      provider: new OpenAIToolChatClient({ ...tenantConfig.llm, extraHeaders: tenantConfig.extraHeaders }),
      systemPrompt: buildBrainSystemPrompt(false, config.assistantName),
      extraBody: (model: string) => tenantModelsNow().llmParams?.[model],
      catalog: () => tenantModelsNow().catalog
    });
    // Monitors: the condition's small model and tasks (checks run on the routine scheduler below).
    runtime.monitors?.configure({ ...brain(), model: () => process.env.SIBYL_ROUTINE_MODEL?.trim() || tenantModelsNow().defaults.llmModel });
    // Meetings: the cheap notes model (SIBYL_MEETING_MODEL, else the cheapest preset) and the deep brain for Ask AI.
    runtime.meetings?.configure({
      provider: brain().provider,
      model: () => tenantModelsNow().defaults.llmModel,
      fastModel: () => tenantModelsNow().defaults.voiceModel,
      extraBody: (model) => tenantModelsNow().llmParams?.[model],
      catalog: () => tenantModelsNow().catalog
    });
    // Agents in Slack and Teams channels: the same deep brain (an agent's own model preset wins).
    runtime.presence?.configure({ ...brain(), model: () => process.env.SIBYL_PRESENCE_MODEL?.trim() || tenantModelsNow().defaults.llmModel });
    // Routines: scheduled runs of the deep brain (off with SIBYL_ROUTINES=false). Hosted: the registry's one loop ticks it.
    await runtime.routines?.startScheduler({
      ...brain(),
      model: () => process.env.SIBYL_ROUTINE_MODEL?.trim() || tenantModelsNow().defaults.llmModel,
      ...(hosted ? { scheduler: { selfTick: false } } : {})
    });
    // Saving or removing the organization's own key rebuilds it for the new key.
    runtime.modelAccess?.onChange(() => void registry.reload(orgId));
    return {
      orgId,
      runtime,
      providers,
      get models() {
        return holder.current;
      },
      set models(update: ModelUpdate) {
        holder.current = update;
      },
      ownCatalog: ownKey,
      busy: () => runtime.routines?.scheduler?.busy() ?? false,
      ...(hosted ? { tick: () => runtime.routines?.scheduler?.tick() ?? Promise.resolve() } : {}),
      close: () => runtime.close()
    };
  };
  const applyModels = (orgId: string, update: ModelUpdate) => {
    const tenant = registry.peek(orgId);
    if (!tenant) return;
    tenant.models = update;
    gateway?.updateModels(update, orgId);
  };

  const registry = new TenantRegistry<Tenant>({
    hosted,
    build: buildTenant,
    idleMs: tenantIdleMs(process.env),
    log,
    // Due routines, monitors and Teams subscription renewals wake their organization (hosted).
    dueOrganizations: async (now) => {
      const [routines, monitors, renewals] = await Promise.all([shared.store.routines.due(now), shared.store.monitors.due(now), PresenceStore.dueOrganizations(shared.store, now)]);
      return [...routines.map((r) => r.ownerId), ...monitors.filter((m) => m.source.kind !== "webhook").map((m) => m.ownerId), ...renewals];
    }
  });

  if (config.modelSelection === "auto" && hasFreshScoutCache(config.scoutCacheFile)) {
    // Fresh cache: apply instantly before accepting sessions (metered on the self-hosted organization).
    const update = await runScout({ apiKey: serverKey, ...(config.scoutCacheFile ? { cacheFile: config.scoutCacheFile } : {}), runtime: scoutRuntime(shared, DEFAULT_OWNER_ID) });
    if (update) {
      models.catalog = update.catalog;
      models.defaults = { ...models.defaults, ...update.defaults };
      models.llmParams = update.llmParams ?? models.llmParams;
      models.source = `scout:${config.modelStrategy}`;
    }
  }
  const scoutInBackground = config.modelSelection === "auto" && !hasFreshScoutCache(config.scoutCacheFile);
  if (config.discoverVoices && config.ttsEnabled) {
    try {
      const updated = await discoverOpenRouterVoices(
        models.catalog,
        config.tts.baseUrl
      );
      logger.info("models.voices_discovered", { updated });
    } catch (error) {
      logger.warn("models.voice_discovery_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  logger.info("models.loaded", {
    source: models.source,
    llm: models.catalog.llm.map((model) => model.id),
    stt: models.catalog.stt.map((model) => model.id),
    tts: models.catalog.tts.map((model) => model.id)
  });

  // Sign-up and the sign-in methods beyond a password (links, codes, Google / Microsoft): before any organization.
  const organizations = hosted ? new OrganizationService({ store: shared.store, env: process.env, log }) : undefined;
  const masterKey = loadMasterKey(process.env).key;
  const mailer = createMailer({ env: process.env });
  const signup = new SignupService({
    store: shared.store,
    env: process.env,
    hosted,
    tickets: organizations?.tickets ?? new SignupTickets(masterKey, shared.store),
    masterKey,
    ...(mailer ? { mailer } : {}),
    log
  });
  const hostedRouting = organizations
    ? createHostedRouting({
        store: shared.store,
        organizations,
        signup,
        env: process.env,
        loaded: () => registry.loaded(),
        ...(process.env.SIBYL_PLATFORM_TOKEN?.trim() ? { platformToken: process.env.SIBYL_PLATFORM_TOKEN.trim() } : {}),
        log
      })
    : undefined;

  gateway = await createGatewayServer({
    port: config.port,
    host: config.host,
    allowedOrigins: config.allowedOrigins,
    ...(process.env.SIBYL_OWNER_TOKEN?.trim() ? { ownerToken: process.env.SIBYL_OWNER_TOKEN.trim() } : {}),
    signup,
    // The server's providers; each organization gets its own (createProviders) through the registry.
    providers: createProviders(config),
    tenants: {
      hosted,
      acquire: (orgId) => registry.get(orgId),
      orgFor: hostedRouting ? hostedRouting.orgFor : async () => DEFAULT_OWNER_ID,
      hold: (orgId) => registry.hold(orgId),
      touch: (orgId) => registry.touch(orgId),
      onUnload: (listener) => registry.onUnload(listener),
      ...(hostedRouting ? { handleHosted: hostedRouting.handleHosted } : {})
    },
    ttsFormat: config.ttsFormat,
    ttsVoice: config.ttsVoice,
    modelCatalog: models.catalog,
    llmParams: models.llmParams,
    defaultSettings: models.defaults,
    providerName: config.provider,
    realtimeSttEnabled: config.realtimeSttEnabled,
    ...(config.genUiEnabled
      ? { genUiSystemPrompt: buildGenUiSystemPrompt() }
      : {}),
    ...(config.liveConversation
      ? {
          live: {
            voicePrompt: buildVoicePrompt(config.assistantName),
            realtimePrompt: buildRealtimeVoicePrompt(config.assistantName),
            warmUp: true,
            brainPrompt: (genUi: boolean) =>
              buildBrainSystemPrompt(genUi, config.assistantName)
          }
        }
      : {}),
    // Small first segments so the voice starts speaking sooner.
    ttsSegmentMinLength: 14,
    hedge: config.hedge,
    preemptiveGeneration: config.preemptiveGeneration,
    livekitSpeech: liveKitSpeechFromEnv(process.env),
    logger,
    healthDetails: {
      version: "0.2.0",
      provider: config.provider,
      genUi: config.genUiEnabled,
      realtimeStt: config.realtimeSttEnabled,
      tts: config.ttsEnabled,
      mode: hosted ? "hosted" : "self-hosted"
    }
  });
  // Hosted: the one scheduler loop (wakes organizations with due work) and the idle sweep.
  registry.start();

  logger.info("gateway.started", {
    host: config.host,
    port: gateway.port,
    health: `http://${config.host}:${gateway.port}/healthz`,
    mode: hosted ? "hosted" : "self-hosted",
    provider: config.provider,
    voiceModel: models.defaults.voiceModel,
    llmModel: models.defaults.llmModel,
    genUi: config.genUiEnabled,
    realtimeStt: config.realtimeSttEnabled,
    tts: config.ttsEnabled
  });

  if (config.modelSelection === "auto") {
    const refresh = async (): Promise<void> => {
      const update = await runScout({ apiKey: serverKey, ...(config.scoutCacheFile ? { cacheFile: config.scoutCacheFile } : {}), runtime: scoutRuntime(shared, DEFAULT_OWNER_ID) });
      if (update) {
        models.catalog = update.catalog;
        models.defaults = { ...models.defaults, ...update.defaults };
        if (update.llmParams) models.llmParams = update.llmParams;
        // Organizations on the server's key (or the platform's) take the new catalog.
        for (const tenant of registry.loaded()) if (!tenant.ownCatalog) applyModels(tenant.orgId, serverModels());
        logger.info("models.applied", { defaults: update.defaults });
      }
    };
    // First run without a cache probes live latency (~30-60 s): do it in the
    // background so the gateway is usable right away, then refresh daily.
    if (scoutInBackground) void refresh();
    setInterval(() => void refresh(), 24 * 60 * 60 * 1000).unref();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("gateway.stopping", { signal });
    await gateway?.close();
    await registry.close();
    await shared.meter.flush?.();
    await shared.store.close();
    logger.info("gateway.stopped", { signal });
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/** What the server's own scout needs from a runtime: the meter to record its probes on. */
function scoutRuntime(shared: { meter: GatewayRuntime["meter"] }, ownerId: string): GatewayRuntime {
  return { ownerId, meter: shared.meter } as GatewayRuntime;
}

/** Model providers for one key (the server's, or an organization's own). */
function createProviders(config: GatewayRuntimeConfig): GatewayProviders {
  const ttsProvider = createTtsProvider(config);
  const streamingSttProvider = createStreamingSttProvider(
    config.realtimeSttEnabled,
    config.realtimeSttLanguage,
    config.realtimeSttDelay
  );
  return {
    llm: new OpenAILLMProvider({
      ...config.llm,
      extraHeaders: config.extraHeaders
    }),
    toolLlm: new OpenAIToolChatClient({
      ...config.llm,
      extraHeaders: config.extraHeaders
    }),
    stt: new OpenAIWhisperProvider({
      ...config.stt,
      extraHeaders: config.extraHeaders
    }),
    ...(streamingSttProvider === undefined
      ? {}
      : { streamingStt: streamingSttProvider }),
    ...(ttsProvider === undefined ? {} : { tts: ttsProvider })
  };
}

function createTtsProvider(
  config: GatewayRuntimeConfig
): TTSProvider | undefined {
  if (!config.ttsEnabled) {
    return undefined;
  }
  return new OpenAITTSProvider({
    ...config.tts,
    ...(config.ttsVoice ? { voice: config.ttsVoice } : {}),
    format: config.ttsFormat,
    extraHeaders: config.extraHeaders
  });
}

function createStreamingSttProvider(
  enabled: boolean,
  language?: string,
  delay?: OpenAIRealtimeTranscriptionDelay
): StreamingSTTProvider | undefined {
  if (!enabled) {
    return undefined;
  }
  return new OpenAIRealtimeSTTProvider({
    webSocketFactory: (url, options) =>
      new WebSocket(url, { headers: options.headers }),
    language,
    delay
  });
}
