/**
 * `read_webpage`: fetch a public URL and return its readable text.
 * Guarded against SSRF (see ssrf.ts), with size, time and type limits.
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { fetch as undiciFetch } from "undici";
import { describeError, stringInput, truncate, USER_AGENT, withTimeout, type FetchLike } from "./http.js";
import { assertPublicUrl, BlockedUrlError, defaultResolveHost, getGuardedDispatcher, type ResolveHost } from "./ssrf.js";

export const MAX_REDIRECTS = 3;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_CHARS = 15_000;
const TIMEOUT_MS = 10_000;

const TEXT_TYPES = /^(text\/(html|plain|markdown|xml|csv|x-markdown)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))$/;

export interface ReadWebpageData {
  url: string;
  finalUrl: string;
  title?: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

/** Real network fetch: undici with a dispatcher that refuses private addresses at connect time. */
export const guardedFetch: FetchLike = (input, init) =>
  undiciFetch(String(input), { ...(init as object), dispatcher: getGuardedDispatcher() }) as unknown as Promise<Response>;

class FetchProblem extends Error {}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(await response.arrayBuffer()).slice(0, maxBytes), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function decode(bytes: Uint8Array, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
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
  const fetchImpl = deps.fetch ?? guardedFetch;
  const resolveHost = deps.resolveHost ?? defaultResolveHost;

  async function fetchFollowing(startUrl: string, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
    let current = startUrl;
    for (let hop = 0; ; hop += 1) {
      const url = await assertPublicUrl(current, resolveHost);
      const response = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
          "accept-language": "en;q=0.9,*;q=0.5"
        }
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        await response.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new FetchProblem(`too many redirects (more than ${MAX_REDIRECTS})`);
        current = new URL(response.headers.get("location")!, url).toString();
        continue;
      }
      return { response, finalUrl: url.toString() };
    }
  }

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
      const signal = withTimeout(context.signal, TIMEOUT_MS);
      try {
        const { response, finalUrl } = await fetchFollowing(raw, signal);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { content: `Could not read ${finalUrl}: the site answered HTTP ${response.status}.`, isError: true };
        }
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        const mime = contentType.split(";")[0]!.trim();
        if (mime && !TEXT_TYPES.test(mime)) {
          await response.body?.cancel().catch(() => undefined);
          return { content: `Could not read ${finalUrl}: unsupported content type ${mime} (only HTML, text and JSON pages).`, isError: true };
        }
        const declared = Number(response.headers.get("content-length"));
        const { bytes, truncated: bytesTruncated } = await readCapped(response, MAX_BYTES);
        const decoded = decode(bytes, contentType);
        const isHtml = !mime || mime.includes("html") || (mime === "text/plain" && /^\s*<(!doctype html|html)/i.test(decoded));
        const { title, text: fullText } = isHtml ? htmlToText(decoded) : { title: undefined, text: collapseBlocks(decoded) };
        const truncated = bytesTruncated || fullText.length > MAX_TEXT_CHARS || (Number.isFinite(declared) && declared > MAX_BYTES);
        const text = truncate(fullText, MAX_TEXT_CHARS);
        if (!text) return { content: `${finalUrl} has no readable text (it may need JavaScript).`, data: { url: raw, finalUrl, title, contentType: mime, text, truncated } };
        const header = [`Title: ${title ?? "(none)"}`, `URL: ${finalUrl}`, truncated ? "(Text truncated.)" : ""].filter(Boolean).join("\n");
        return { content: `${header}\n\n${text}`, data: { url: raw, finalUrl, title, contentType: mime, text, truncated } };
      } catch (error) {
        if (error instanceof BlockedUrlError || error instanceof FetchProblem) {
          return { content: `Could not read the page: ${error.message}.`, isError: true };
        }
        const cause = (error as { cause?: { code?: string } })?.cause;
        if (cause?.code === "EBLOCKED") return { content: "Could not read the page: the host resolves to a private address.", isError: true };
        return { content: `Could not read the page: ${describeError(error, context.signal)}`, isError: true };
      }
    }
  };
}
