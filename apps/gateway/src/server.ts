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
  buildVoicePrompt
} from "@open-gpt-live/genui";
import { Agent, setGlobalDispatcher } from "undici";
import { WebSocket } from "ws";
import { loadGatewayRuntimeConfig, type GatewayRuntimeConfig } from "./config.js";
import { discoverOpenRouterVoices, loadModelCatalog, mergePinnedModels } from "./models.js";
import { hasFreshScoutCache, scoutModels } from "./scout.js";
import { createRuntime } from "./runtime.js";
import { createMeteredFetch } from "./metering/fetch.js";
import type { ModelUpdate } from "./gateway.js";
import { loadProjectEnvironment } from "./environment.js";
import { createGatewayServer } from "./gateway.js";
import { createJsonLogger } from "./logger.js";

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

async function main(): Promise<void> {
  const config = loadGatewayRuntimeConfig();
  const logger = createJsonLogger(config.logLevel);
  const runtime = await createRuntime({
    env: process.env,
    log: (event, fields) => logger.info(event, fields)
  });
  const ttsProvider = createTtsProvider(config);
  const models = loadModelCatalog(process.env, {
    llmModel: config.llm.model,
    sttModel: config.stt.model,
    ttsModel: config.tts.model,
    ttsVoice: config.ttsVoice
  });
  const staticCatalog = models.catalog;
  // Pick cost-efficient models from the live OpenRouter catalog.
  const runScout = async (): Promise<ModelUpdate | undefined> => {
    try {
      const startedAt = Date.now();
      const scouted = await scoutModels({
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey ?? "",
        extraHeaders: config.extraHeaders,
        strategy: config.modelStrategy,
        probe: config.scoutProbe,
        cacheFile: config.scoutCacheFile,
        // Probes are real (tiny) paid requests: meter them as "scout".
        fetchImpl: createMeteredFetch({ meter: runtime.meter, ownerId: runtime.ownerId }),
        probePrompts: {
          voice: buildVoicePrompt(config.assistantName),
          brain: buildBrainSystemPrompt(config.genUiEnabled, config.assistantName)
        },
        log: (event, fields) => logger.info(event, fields)
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
  const scoutInBackground = config.modelSelection === "auto" && !hasFreshScoutCache(config.scoutCacheFile);
  if (config.modelSelection === "auto" && !scoutInBackground) {
    // Fresh cache: apply instantly before accepting sessions.
    const update = await runScout();
    if (update) {
      models.catalog = update.catalog;
      models.defaults = { ...models.defaults, ...update.defaults };
      models.llmParams = update.llmParams ?? models.llmParams;
      models.source = `scout:${config.modelStrategy}`;
    }
  }
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
  const streamingSttProvider = createStreamingSttProvider(
    config.realtimeSttEnabled,
    config.realtimeSttLanguage,
    config.realtimeSttDelay
  );

  // Routines: scheduled runs of the deep brain (off with SIBYL_ROUTINES=false).
  await runtime.routines?.startScheduler({
    provider: new OpenAIToolChatClient({ ...config.llm, extraHeaders: config.extraHeaders }),
    model: () => process.env.SIBYL_ROUTINE_MODEL?.trim() || models.defaults.llmModel,
    systemPrompt: buildBrainSystemPrompt(false, config.assistantName),
    extraBody: (model) => models.llmParams[model],
    catalog: () => models.catalog
  });

  const gateway = await createGatewayServer({
    port: config.port,
    host: config.host,
    allowedOrigins: config.allowedOrigins,
    ...(process.env.SIBYL_OWNER_TOKEN?.trim() ? { ownerToken: process.env.SIBYL_OWNER_TOKEN.trim() } : {}),
    providers: {
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
            warmUp: true,
            brainPrompt: (genUi: boolean) =>
              buildBrainSystemPrompt(genUi, config.assistantName)
          }
        }
      : {}),
    // Small first segments so the voice starts speaking sooner.
    ttsSegmentMinLength: 14,
    hedge: config.hedge,
    runtime,
    logger,
    healthDetails: {
      version: "0.2.0",
      provider: config.provider,
      genUi: config.genUiEnabled,
      realtimeStt: config.realtimeSttEnabled,
      tts: config.ttsEnabled
    }
  });

  logger.info("gateway.started", {
    host: config.host,
    port: gateway.port,
    health: `http://${config.host}:${gateway.port}/healthz`,
    provider: config.provider,
    voiceModel: models.defaults.voiceModel,
    llmModel: models.defaults.llmModel,
    genUi: config.genUiEnabled,
    realtimeStt: config.realtimeSttEnabled,
    tts: config.ttsEnabled
  });

  if (config.modelSelection === "auto") {
    const refresh = async (): Promise<void> => {
      const update = await runScout();
      if (update) {
        gateway.updateModels(update);
        models.catalog = update.catalog;
        models.defaults = { ...models.defaults, ...update.defaults };
        if (update.llmParams) models.llmParams = update.llmParams;
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
    await gateway.close();
    await runtime.close();
    logger.info("gateway.stopped", { signal });
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
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
