/**
 * Installs media generation (images, video, audio through OpenRouter):
 * catalogue + service + brain tools. Needs OPENROUTER_API_KEY;
 * SIBYL_MEDIA=off turns it off. See docs/media.md.
 */
import type { Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import type { UploadService } from "../uploads/index.js";
import { MediaCatalog } from "./catalog.js";
import { OpenRouterMediaClient, type MediaClient } from "./client.js";
import { DEFAULT_APPROVE_ABOVE_USD, MediaService } from "./service.js";
import { createMediaTools } from "./tools.js";

export { MediaService, MediaError, sanitizeSettings, DEFAULT_APPROVE_ABOVE_USD } from "./service.js";
export { MediaCatalog, TESTED_DEFAULTS } from "./catalog.js";
export { takeMediaArtifact, mediaArtifact, MEDIA_TOOL_NAMES } from "./tools.js";
export { runMediaChatTurn } from "./chat.js";
export { handleMediaHttp, handleMediaRefHttp } from "./http.js";

export interface InstallMediaInput {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  ownerId: string;
  uploads: UploadService;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Test seam. */
  client?: MediaClient;
  pollMs?: number;
}

export async function installMedia(input: InstallMediaInput): Promise<MediaService | undefined> {
  const { env, log } = input;
  if (/^(false|0|no|off)$/i.test(env.SIBYL_MEDIA?.trim() ?? "")) {
    log("media.disabled", {});
    return undefined;
  }
  const apiKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  if (!input.client && !apiKey) {
    log("media.unavailable", { reason: "OPENROUTER_API_KEY is not set" });
    return undefined;
  }
  const client =
    input.client ??
    new OpenRouterMediaClient({
      apiKey,
      ...(env.SIBYL_MEDIA_BASE_URL?.trim() ? { baseUrl: env.SIBYL_MEDIA_BASE_URL.trim() } : {}),
      headers: { "HTTP-Referer": env.OPENROUTER_SITE_URL?.trim() || "https://github.com/Suryanandx/sibyl", "X-Title": env.OPENROUTER_APP_NAME?.trim() || "Sibyl" }
    });
  const catalog = new MediaCatalog({ client, env, log });
  const threshold = Number(env.SIBYL_MEDIA_APPROVE_ABOVE_USD);
  const service = new MediaService({
    store: input.store,
    ownerId: input.ownerId,
    meter: input.meter,
    uploads: input.uploads,
    catalog,
    client,
    approveAboveUsd: env.SIBYL_MEDIA_APPROVE_ABOVE_USD?.trim() && Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_APPROVE_ABOVE_USD,
    ...(env.SIBYL_PUBLIC_GATEWAY_URL?.trim() ? { publicUrl: env.SIBYL_PUBLIC_GATEWAY_URL.trim() } : {}),
    ...(input.pollMs ? { pollMs: input.pollMs } : {}),
    log
  });
  for (const tool of createMediaTools(service)) {
    try {
      input.tools.register(tool);
    } catch (error) {
      log("media.tool_skipped", { tool: tool.name, error: (error as Error).message });
    }
  }
  // The catalogue loads in the background (the first request waits for it); the default image model's price too.
  void catalog
    .refresh()
    .then(async () => {
      const image = catalog.defaults().image;
      const entry = image ? catalog.peek(image) : undefined;
      if (entry) await catalog.imagePricing(entry);
    })
    .catch((error: unknown) => log("media.catalog_failed", { error: error instanceof Error ? error.message : String(error) }));
  await service.resume().catch((error: unknown) => log("media.resume_failed", { error: error instanceof Error ? error.message : String(error) }));
  log("media.installed", { approveAboveUsd: service.approveAboveUsd });
  return service;
}
