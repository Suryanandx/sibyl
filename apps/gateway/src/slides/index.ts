/**
 * Installs Sibyl Slides into the runtime: engine client + service + brain
 * tools. The tools are registered only when the engine is configured
 * (SIBYL_SLIDES_URL set) or the default engine address answers.
 * SIBYL_SLIDES=false turns slides off entirely.
 */
import type { Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import { slidesClientFromEnv, type SlidesClient } from "./client.js";
import { SlidesService } from "./service.js";
import { createSlidesTools } from "./tools.js";

export { SlidesService } from "./service.js";

/** The engine's default deck model (apps/slides/servers/fastapi/utils/sibyl.py). */
export const ENGINE_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
export { takeSlidesArtifact, SLIDES_PROMPT_GUIDANCE } from "./tools.js";
export { routeSlidesRequest } from "./http.js";

export interface InstallSlidesInput {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Test seam. */
  client?: SlidesClient;
}

export async function installSlides(input: InstallSlidesInput): Promise<SlidesService | undefined> {
  const { env, log } = input;
  if (/^(false|0|no|off)$/i.test(env.SIBYL_SLIDES?.trim() ?? "")) {
    log("slides.disabled", {});
    return undefined;
  }
  const client = input.client ?? slidesClientFromEnv(env);
  const configured = Boolean(env.SIBYL_SLIDES_URL?.trim()) || Boolean(input.client);
  if (!configured && !(await client.ping())) {
    log("slides.unavailable", { url: client.baseUrl, reason: "engine not reachable; set SIBYL_SLIDES_URL to enable" });
    return undefined;
  }
  const usdPerSlide = Number(env.SIBYL_SLIDES_USD_PER_SLIDE);
  const service = new SlidesService({
    client,
    store: input.store,
    meter: input.meter,
    // Until the engine reports its model (below): the same default as the engine.
    model: env.SIBYL_SLIDES_MODEL?.trim() || ENGINE_DEFAULT_MODEL,
    ...(Number.isFinite(usdPerSlide) && usdPerSlide >= 0 && env.SIBYL_SLIDES_USD_PER_SLIDE?.trim() ? { usdPerSlide } : {}),
    ...(env.SIBYL_SLIDES_EDITOR_BASE?.trim() ? { editorBase: env.SIBYL_SLIDES_EDITOR_BASE.trim() } : {})
  });
  // The engine is the source of truth for the deck model and its price.
  await service.refreshEngineConfig();
  const tools = createSlidesTools(service);
  for (const tool of tools) {
    try {
      input.tools.register(tool);
    } catch (error) {
      log("slides.tool_skipped", { tool: tool.name, error: (error as Error).message });
    }
  }
  log("slides.installed", { url: client.baseUrl, model: service.model, tools: tools.map((t) => t.name) });
  return service;
}
