/**
 * `wikipedia`: search Wikipedia and return the best match's summary, via the
 * public REST APIs (with a descriptive User-Agent, as Wikimedia asks).
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { errorResult, fetchJson, HttpError, stringInput, truncate, type FetchLike } from "./http.js";

export interface WikipediaInput {
  query: string;
  lang?: string;
}

export interface WikipediaData {
  lang: string;
  page?: { title: string; description?: string; extract: string; url: string; type?: string };
  results: Array<{ title: string; description?: string; excerpt?: string; url: string }>;
}

interface SearchResponse {
  pages?: Array<{ title: string; key: string; excerpt?: string; description?: string | null }>;
}

interface SummaryResponse {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

const stripHtml = (text: string | undefined): string | undefined =>
  text?.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();

export function createWikipediaTool(fetchImpl: FetchLike): ToolDefinition<WikipediaInput, WikipediaData> {
  return {
    name: "wikipedia",
    title: "Wikipedia",
    description:
      "Look up a topic on Wikipedia: searches, then returns the best-matching article's summary plus other matching titles. " +
      "Good for stable background facts (people, places, concepts, history). For news or fast-changing facts use web_search. " +
      "Pass an exact article title as `query` to get that article.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Topic or article title." },
        lang: { type: "string", description: "Wikipedia language code (default \"en\"), e.g. \"de\", \"zh\", \"es\"." }
      },
      required: ["query"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    async run(input, context) {
      const query = stringInput(input?.query);
      if (!query) return { content: "Wikipedia lookup failed: give a query.", isError: true };
      const lang = (stringInput(input?.lang) ?? "en").toLowerCase();
      if (!/^[a-z][a-z-]{1,11}$/.test(lang)) return { content: "Wikipedia lookup failed: invalid language code.", isError: true };
      const base = `https://${lang}.wikipedia.org`;
      const pageUrl = (key: string) => `${base}/wiki/${encodeURIComponent(key.replace(/ /g, "_"))}`;

      try {
        const search = await fetchJson<SearchResponse>(
          fetchImpl,
          `${base}/w/rest.php/v1/search/page?${new URLSearchParams({ q: query, limit: "5" })}`,
          { signal: context.signal }
        );
        const results = (search?.pages ?? []).map((page) => ({
          title: page.title,
          description: page.description ?? undefined,
          excerpt: stripHtml(page.excerpt),
          url: pageUrl(page.key)
        }));
        if (results.length === 0) {
          return { content: `Wikipedia (${lang}): no articles found for "${query}".`, data: { lang, results } };
        }

        // Prefer an exact title match, else the top search hit.
        const best = results.find((r) => r.title.toLowerCase() === query.toLowerCase()) ?? results[0]!;
        let page: WikipediaData["page"];
        try {
          const summary = await fetchJson<SummaryResponse>(
            fetchImpl,
            `${base}/api/rest_v1/page/summary/${encodeURIComponent(best.title.replace(/ /g, "_"))}?redirect=true`,
            { signal: context.signal }
          );
          page = {
            title: summary.title ?? best.title,
            description: summary.description ?? best.description,
            extract: truncate(summary.extract ?? best.excerpt ?? "", 3_000),
            url: summary.content_urls?.desktop?.page ?? best.url,
            type: summary.type
          };
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          page = { title: best.title, description: best.description, extract: best.excerpt ?? "", url: best.url };
        }

        const others = results.filter((r) => r.title !== best.title);
        const lines = [
          `${page.title}${page.description ? ` — ${page.description}` : ""}`,
          page.type === "disambiguation" ? "(Disambiguation page: the query is ambiguous; see other results.)" : "",
          page.extract,
          `Source: ${page.url}`,
          others.length ? `Other matches: ${others.map((r) => r.title + (r.description ? ` (${r.description})` : "")).join("; ")}` : ""
        ].filter(Boolean);
        return { content: lines.join("\n"), data: { lang, page, results } };
      } catch (error) {
        return errorResult("Wikipedia lookup failed", error, context.signal);
      }
    }
  };
}
