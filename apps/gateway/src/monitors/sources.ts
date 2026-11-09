/**
 * Fetching a monitor's source.
 *
 * - tool: calls the read tool with the creator's principal and the
 *   monitor's workspace, exactly as the brain would. Any read tool works, so
 *   connector tools (`<connector>_<action>`) and MCP read tools plug in
 *   without changes here. Write tools are refused.
 * - rss: fetches the feed with fetchPublic (public addresses only, redirects
 *   re-checked, size and time capped) and parses RSS 2.0 / Atom entries.
 * - webpage: reuses the `read_webpage` tool's guarded fetch and text
 *   extraction; the page is one item keyed by its URL.
 * - webhook: the delivery body is the list of items (see parseWebhookBody).
 */
import type { MonitorRecord, Principal, Store, ToolContext, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import { FetchPublicError, fetchPublic, type FetchLike, type ResolveHost } from "../net/safe-fetch.js";
import { createReadWebpageTool, decodeEntities, htmlToText } from "../tools/builtin/read-webpage.js";
import { extractList } from "./items.js";

export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const MAX_FEED_ITEMS = 100;

export class SourceError extends Error {
  constructor(
    message: string,
    /** Worth retrying later (network, 5xx, rate limit). */
    readonly transient = false
  ) {
    super(message);
  }
}

export interface SourceContext {
  tools: ToolRegistry;
  /** Tools a monitor may never call as its source (its own chat tools, routines). */
  excludeTools: ReadonlySet<string>;
  store: Store;
  meter: UsageMeter;
  principal: Principal;
  runId: string;
  signal: AbortSignal;
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
  log(event: string, fields?: Record<string, unknown>): void;
}

/** Can this tool be watched? Returns why not, or undefined. */
export function sourceToolProblem(tools: ToolRegistry, excluded: ReadonlySet<string>, toolName: string): string | undefined {
  const tool = tools.get(toolName);
  if (!tool) return `There is no tool named ${toolName}.`;
  if (tool.effect !== "read") return `${toolName} changes things, so it can't be watched (only read tools can).`;
  if (excluded.has(toolName)) return `${toolName} can't be watched.`;
  if (!tools.isEnabled(toolName)) return `${toolName} is turned off in Connections.`;
  return undefined;
}

/** Fetch the raw items of a polled source. */
export async function fetchSource(monitor: MonitorRecord, context: SourceContext): Promise<unknown[]> {
  const source = monitor.source;
  switch (source.kind) {
    case "tool":
      return fetchTool(monitor, source.toolName, source.input, context);
    case "rss":
      return fetchFeed(source.url, context);
    case "webpage":
      return fetchPage(monitor, source.url, context);
    case "webhook":
      throw new SourceError("Webhook monitors are not polled; they run when a delivery arrives.");
  }
}

async function fetchTool(monitor: MonitorRecord, toolName: string, input: Record<string, unknown>, context: SourceContext): Promise<unknown[]> {
  const problem = sourceToolProblem(context.tools, context.excludeTools, toolName);
  if (problem) throw new SourceError(problem);
  const tool = context.tools.get(toolName)!;
  const toolContext: ToolContext = {
    signal: context.signal,
    ownerId: monitor.ownerId,
    runId: context.runId,
    principal: context.principal,
    workspaceId: monitor.workspaceId,
    store: context.store,
    meter: context.meter,
    log: (event, fields) => context.log(event, { monitorId: monitor.id, toolName, ...fields })
  };
  const result = await tool.run(structuredClone(input), toolContext);
  if (result.isError) {
    throw new SourceError(`${tool.title || toolName} failed: ${result.content.slice(0, 300)}`, isTransientText(result.content));
  }
  let raw: unknown = result.data;
  if (raw === undefined) {
    try {
      raw = JSON.parse(result.content);
    } catch {
      raw = result.content.trim() ? { text: result.content } : [];
    }
  }
  return extractList(raw);
}

async function fetchPage(monitor: MonitorRecord, url: string, context: SourceContext): Promise<unknown[]> {
  const tool = createReadWebpageTool({
    ...(context.fetch ? { fetch: context.fetch } : {}),
    ...(context.resolveHost ? { resolveHost: context.resolveHost } : {})
  });
  const result = await tool.run(
    { url },
    {
      signal: context.signal,
      ownerId: monitor.ownerId,
      runId: context.runId,
      store: context.store,
      meter: context.meter,
      log: context.log
    }
  );
  if (result.isError || !result.data) throw new SourceError(result.content, isTransientText(result.content));
  const page = result.data;
  // Keyed by the URL the monitor watches, so redirects don't look like a new page.
  return [{ id: url, url: page.finalUrl, title: page.title ?? url, text: page.text }];
}

/* ───────────── RSS / Atom ───────────── */

async function fetchFeed(rawUrl: string, context: SourceContext): Promise<unknown[]> {
  let response;
  try {
    response = await fetchPublic(rawUrl, {
      signal: context.signal,
      maxBytes: MAX_FEED_BYTES,
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5" },
      ...(context.fetch ? { fetch: context.fetch } : {}),
      ...(context.resolveHost ? { resolveHost: context.resolveHost } : {})
    });
  } catch (error) {
    // Refused by policy: permanent. Network trouble: worth retrying.
    if (error instanceof FetchPublicError) throw new SourceError(`Can't read the feed: ${error.message}.`);
    throw new SourceError(`Can't read the feed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (!response.ok) {
    await response.discard();
    throw new SourceError(`The feed answered HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
  }
  const tooLarge = new SourceError("The feed is too large (over 2 MB).");
  if (response.tooLarge) {
    await response.discard();
    throw tooLarge;
  }
  const { text, truncated } = await response.text();
  if (truncated) throw tooLarge;
  const items = parseFeed(text, response.url.toString());
  if (items === undefined) throw new SourceError("That address isn't an RSS or Atom feed.");
  return items;
}

export interface FeedItem {
  id: string;
  title: string;
  url?: string;
  published?: string;
  summary?: string;
}

function tagText(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!match) return undefined;
  const raw = match[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
  return raw || undefined;
}

function plain(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  // Feeds often entity-encode their HTML (&lt;p&gt;): decode first, then strip tags.
  const decoded = /<[a-z!/][^>]*>/i.test(text) ? text : decodeEntities(text);
  const value = /<[a-z!/][^>]*>/i.test(decoded) ? htmlToText(decoded).text : decoded;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]!);
  const pick = links.find((attrs) => !/rel=["'](?!alternate)/i.test(attrs)) ?? links[0];
  const href = pick ? /href=["']([^"']+)["']/i.exec(pick)?.[1] : undefined;
  return href ? decodeEntities(href) : undefined;
}

/** Parse RSS 2.0 / RDF / Atom. undefined: not a feed. */
export function parseFeed(xml: string, baseUrl?: string): FeedItem[] | undefined {
  const isAtom = /<feed[\s>]/i.test(xml);
  const isRss = /<(rss|rdf:RDF)[\s>]/i.test(xml) || /<channel[\s>]/i.test(xml);
  if (!isAtom && !isRss) return undefined;
  const blocks = [...xml.matchAll(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]).slice(0, MAX_FEED_ITEMS);
  const out: FeedItem[] = [];
  for (const block of blocks) {
    const title = plain(tagText(block, "title"), 300) ?? "(untitled)";
    let link = isAtom ? atomLink(block) : plain(tagText(block, "link"), 2_000) ?? atomLink(block);
    if (link && baseUrl) {
      try {
        link = new URL(link, baseUrl).toString();
      } catch {
        link = undefined;
      }
    }
    const id = plain(tagText(block, isAtom ? "id" : "guid"), 2_000) ?? link ?? title;
    const published = plain(tagText(block, isAtom ? "updated" : "pubDate") ?? tagText(block, "published") ?? tagText(block, "dc:date"), 100);
    const summary = plain(tagText(block, isAtom ? "summary" : "description") ?? tagText(block, "content") ?? tagText(block, "content:encoded"), 1_000);
    out.push({
      id,
      title,
      ...(link && /^https?:\/\//i.test(link) ? { url: link } : {}),
      ...(published ? { published } : {}),
      ...(summary ? { summary } : {})
    });
  }
  return out;
}

/* ───────────── webhooks ───────────── */

/** A webhook delivery body → raw items (an array, a list under a common key, or the object itself). */
export function parseWebhookBody(body: unknown): unknown[] {
  return extractList(body);
}

const TRANSIENT = /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|\b429\b|\b5\d\d\b|rate.?limit|overloaded|temporar|unavailable/i;

export function isTransientText(text: string): boolean {
  return TRANSIENT.test(text);
}
