/**
 * Sibyl's out-of-the-box tools. All are read-only and need no API key beyond
 * the OpenRouter key (web_search only).
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { calculateTool } from "./calculate.js";
import { createCurrencyTool } from "./currency.js";
import type { FetchLike } from "./http.js";
import { createReadWebpageTool } from "./read-webpage.js";
import type { ResolveHost } from "../../net/safe-fetch.js";
import { createWeatherTool } from "./weather.js";
import { createWebSearchTool } from "./web-search.js";
import { createWikipediaTool } from "./wikipedia.js";
import { createWorldTimeTool } from "./world-time.js";

export interface BuiltinToolsOptions {
  /** fetch for public APIs (weather, currency, wikipedia, web search). */
  fetch?: FetchLike;
  /** fetch for read_webpage (default: SSRF-guarded undici fetch). */
  pageFetch?: FetchLike;
  resolveHost?: ResolveHost;
  /** Enables web_search (OpenRouter web plugin). */
  openRouter?: { apiKey: string; baseUrl: string; model: string; extraHeaders?: Record<string, string> };
  now?: () => Date;
}

export function createBuiltinTools(options: BuiltinToolsOptions = {}): ToolDefinition<any, any>[] {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const tools: ToolDefinition<any, any>[] = [];
  if (options.openRouter) tools.push(createWebSearchTool({ ...options.openRouter, fetch: fetchImpl }));
  tools.push(
    createReadWebpageTool({ fetch: options.pageFetch, resolveHost: options.resolveHost }),
    createWeatherTool(fetchImpl),
    createCurrencyTool(fetchImpl),
    createWorldTimeTool(options.now),
    calculateTool,
    createWikipediaTool(fetchImpl)
  );
  return tools;
}

export { calculateTool, evaluateExpression, formatNumber } from "./calculate.js";
export { createCurrencyTool } from "./currency.js";
export { createReadWebpageTool, htmlToText } from "./read-webpage.js";
export { assertPublicUrl, isBlockedAddress } from "../../net/safe-fetch.js";
export { createWeatherTool } from "./weather.js";
export { createWebSearchTool } from "./web-search.js";
export { createWikipediaTool } from "./wikipedia.js";
export { createWorldTimeTool, resolveTimeZone } from "./world-time.js";
