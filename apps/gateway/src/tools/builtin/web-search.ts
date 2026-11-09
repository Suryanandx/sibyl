/**
 * `web_search`: current web results through OpenRouter's web plugin, so no
 * extra search API key is needed. One cheap model call with
 * `plugins: [{ id: "web", engine: "exa" }]`; results come back as
 * `url_citation` annotations (title, URL, page content) and the model writes a
 * short digest. Cost ≈ $0.007 per call (Exa, ≤10 results) + a few thousand
 * prompt tokens on a flash-class model — recorded through the usage meter.
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { errorResult, fetchJson, stringInput, truncate, type FetchLike } from "./http.js";

/** Exa search fee per request (OpenRouter pricing, up to 10 results). */
export const EXA_SEARCH_USD = 0.007;
/** Rough estimate used for budget checks and when the provider omits `usage.cost`. */
export const WEB_SEARCH_ESTIMATE_USD = 0.01;

export interface WebSearchConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  extraHeaders?: Record<string, string>;
  fetch: FetchLike;
  timeoutMs?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchData {
  query: string;
  answer: string;
  results: WebSearchResult[];
  model: string;
  costUsd?: number;
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      annotations?: Array<{
        type?: string;
        url_citation?: { url?: string; title?: string; content?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export function createWebSearchTool(config: WebSearchConfig): ToolDefinition<{ query: string; max_results?: number }, WebSearchData> {
  return {
    name: "web_search",
    title: "Search the web",
    description:
      "Search the live web for current information (news, prices, schedules, recent events, anything after your training data " +
      "or likely to have changed). Returns a short digest plus result titles, URLs and snippets. Write a specific query " +
      "(include names, places, dates). Follow up with read_webpage for a full article. Each call costs about one cent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, e.g. \"Lisbon metro strike November 2026\"." },
        max_results: { type: "integer", minimum: 1, maximum: 10, description: "Number of results (default 5)." }
      },
      required: ["query"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    async run(input, context) {
      const query = stringInput(input?.query);
      if (!query) return { content: "Web search failed: no query given.", isError: true };
      const maxResults = Math.min(10, Math.max(1, Math.round(Number(input?.max_results) || 5)));

      const budget = context.meter.check({ ownerId: context.ownerId, estimateUsd: WEB_SEARCH_ESTIMATE_USD });
      if (!budget.allowed) {
        return { content: `Web search skipped: ${budget.message ?? "the spending limit has been reached"}.`, isError: true };
      }

      const today = new Date().toISOString().slice(0, 10);
      try {
        const response = await fetchJson<ChatResponse>(config.fetch, `${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          signal: context.signal,
          timeoutMs: config.timeoutMs ?? 25_000,
          headers: { authorization: `Bearer ${config.apiKey}`, ...config.extraHeaders },
          body: {
            model: config.model,
            plugins: [{ id: "web", engine: "exa", max_results: maxResults }],
            messages: [
              {
                role: "system",
                content:
                  `Today is ${today}. Using only the web results provided, answer the query in at most 4 short sentences ` +
                  "with the key facts, numbers and dates. If the results don't answer it, say so. No preamble."
              },
              { role: "user", content: query }
            ],
            max_tokens: 300,
            temperature: 0.2,
            usage: { include: true }
          }
        });

        const message = response.choices?.[0]?.message;
        const seen = new Set<string>();
        const results: WebSearchResult[] = [];
        for (const annotation of message?.annotations ?? []) {
          const citation = annotation.url_citation;
          if (annotation.type !== "url_citation" || !citation?.url || seen.has(citation.url)) continue;
          seen.add(citation.url);
          results.push({
            title: citation.title?.trim() || citation.url,
            url: citation.url,
            snippet: truncate((citation.content ?? "").replace(/\s+/g, " ").trim(), 300)
          });
        }
        const answer = (message?.content ?? "").trim();
        const costUsd = typeof response.usage?.cost === "number" ? response.usage.cost : undefined;
        context.meter.record({
          ownerId: context.ownerId,
          feature: "tool",
          model: `${response.model ?? config.model} +web`,
          costUsd: costUsd ?? WEB_SEARCH_ESTIMATE_USD,
          estimated: costUsd === undefined,
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
          conversationId: context.conversationId,
          requestId: context.runId
        });

        if (results.length === 0 && !answer) {
          return { content: `Web search found nothing for "${query}".`, data: { query, answer, results, model: config.model, costUsd } };
        }
        const lines = [`Web results for "${query}":`];
        if (answer) lines.push(`Digest: ${answer}`);
        results.forEach((result, i) => {
          lines.push(`${i + 1}. ${result.title} — ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`);
        });
        return { content: lines.join("\n"), data: { query, answer, results, model: config.model, costUsd } };
      } catch (error) {
        return errorResult("Web search failed", error, context.signal);
      }
    }
  };
}
