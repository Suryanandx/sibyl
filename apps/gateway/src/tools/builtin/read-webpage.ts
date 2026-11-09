/**
 * `read_webpage`: fetch a public URL and return its readable text, through
 * fetchPublic (net/safe-fetch.ts: SSRF guard, size, time and redirect caps).
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { DEFAULT_MAX_BYTES, fetchPublic, type FetchLike, type ResolveHost } from "../../net/safe-fetch.js";
import { describeError, stringInput, truncate } from "./http.js";

export const MAX_BYTES = DEFAULT_MAX_BYTES;
export const MAX_TEXT_CHARS = 15_000;

const TEXT_TYPES = /^(text\/(html|plain|markdown|xml|csv|x-markdown)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))$/;

export interface ReadWebpageData {
  url: string;
  finalUrl: string;
  title?: string;
  contentType: string;
  text: string;
  truncated: boolean;
}


const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
  laquo: "«", raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°", times: "×", divide: "÷"
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Extract a page title and readable text from HTML (no DOM needed). */
export function htmlToText(html: string): { title?: string; text: string } {
  const title =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|button|select|dialog|menu)\b[\s\S]*?<\/\1\s*>/gi, " ");
  // Prefer the main content when the page marks it.
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(body)?.[2];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 200) body = main;
  const text = body
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/(p|div|section|article|main|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|dd|dt)\s*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  return {
    title: title ? collapse(decodeEntities(title)) : undefined,
    text: collapseBlocks(decodeEntities(text))
  };
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

function collapseBlocks(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line, i, lines) => line !== "" || (i > 0 && lines[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ReadWebpageDeps {
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

export function createReadWebpageTool(deps: ReadWebpageDeps = {}): ToolDefinition<{ url: string }, ReadWebpageData> {
  return {
    name: "read_webpage",
    title: "Read a webpage",
    description:
      "Fetch a public web page (http/https) and return its readable text (scripts, styles and navigation removed; " +
      `capped at ~${MAX_TEXT_CHARS / 1000}k characters), its title and final URL after redirects. ` +
      "Use it to read a specific article or source, e.g. a URL from web_search. Works for HTML, plain text and JSON; not PDFs or images. " +
      "Private, local and internal network addresses are refused.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL." } },
      required: ["url"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    async run(input, context) {
      const raw = stringInput(input?.url);
      if (!raw) return { content: "Could not read the page: no URL given.", isError: true };
      try {
        const response = await fetchPublic(raw, {
          signal: context.signal,
          headers: {
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
            "accept-language": "en;q=0.9,*;q=0.5"
          },
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {})
        });
        const finalUrl = response.url.toString();
        const mime = response.mime;
        if (!response.ok) {
          await response.discard();
          return { content: `Could not read ${finalUrl}: the site answered HTTP ${response.status}.`, isError: true };
        }
        if (mime && !TEXT_TYPES.test(mime)) {
          await response.discard();
          return { content: `Could not read ${finalUrl}: unsupported content type ${mime} (only HTML, text and JSON pages).`, isError: true };
        }
        const { text: decoded, truncated: bytesTruncated } = await response.text();
        const isHtml = !mime || mime.includes("html") || (mime === "text/plain" && /^\s*<(!doctype html|html)/i.test(decoded));
        const { title, text: fullText } = isHtml ? htmlToText(decoded) : { title: undefined, text: collapseBlocks(decoded) };
        const truncated = bytesTruncated || fullText.length > MAX_TEXT_CHARS || response.tooLarge;
        const text = truncate(fullText, MAX_TEXT_CHARS);
        if (!text) return { content: `${finalUrl} has no readable text (it may need JavaScript).`, data: { url: raw, finalUrl, title, contentType: mime, text, truncated } };
        const header = [`Title: ${title ?? "(none)"}`, `URL: ${finalUrl}`, truncated ? "(Text truncated.)" : ""].filter(Boolean).join("\n");
        return { content: `${header}\n\n${text}`, data: { url: raw, finalUrl, title, contentType: mime, text, truncated } };
      } catch (error) {
        return { content: `Could not read the page: ${describeError(error, context.signal)}`, isError: true };
      }
    }
  };
}
