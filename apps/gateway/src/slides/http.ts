/**
 * Slides page API on the gateway's HTTP server, under /api/slides/*.
 *
 * Auth matches the WebSocket: when an owner token is set, requests carry
 * `Authorization: Bearer <token>` (or `?token=` for plain links). CORS is
 * limited to the configured web origins (any origin when none are set, as
 * for the WebSocket). Engine URLs and tokens never reach the browser: files
 * are streamed through the gateway.
 *
 *   GET    /api/slides/status
 *   GET    /api/slides/sources                 enabled read tools + MCP servers
 *   GET    /api/slides/templates
 *   GET    /api/slides/spaces
 *   POST   /api/slides/spaces                  { name, instructions?, template? }
 *   PATCH  /api/slides/spaces/:id              { name?, instructions?, template? }
 *   DELETE /api/slides/spaces/:id
 *   GET    /api/slides/decks?spaceId=          decks with their versions
 *   GET    /api/slides/decks/:id/download?format=pptx|pdf
 *   GET    /api/slides/decks/:id/thumbnail
 *   POST   /api/slides/generate                SSE: research → outline → generate → done
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import type { ArtifactRecord, Store, ToolDefinition, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { tokensMatch } from "../auth.js";
import { runToolLoop } from "../brain/tool-loop.js";
import { SlidesEngineError, type ExportFormat } from "./client.js";
import { SlidesBudgetError, clampSlides, DEFAULT_SLIDE_COUNT, type SlidesMeta, type SlidesService } from "./service.js";
import { SLIDES_TOOL_NAMES } from "./tools.js";

export const SLIDES_API_PREFIX = "/api/slides";
const MAX_BODY_BYTES = 256 * 1024;
const RESEARCH_ROUNDS = 5;

export interface SlidesHttpDeps {
  runtime: { ownerId: string; store: Store; tools: ToolRegistry; meter: UsageMeter; slides?: SlidesService };
  ownerToken?: string;
  allowedOrigins?: string[];
  /** Tool-calling model stream for the research step. */
  toolLlm?: ToolChatProvider;
  /** Model for the research step (the session default deep-brain model). */
  model?: () => string | undefined;
  llmParams?: (model: string) => Record<string, unknown> | undefined;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Handles the request when it is a /api/slides route; returns false otherwise. */
export function routeSlidesRequest(request: IncomingMessage, response: ServerResponse, deps: SlidesHttpDeps): boolean {
  const url = new URL(request.url ?? "/", "http://gateway.invalid");
  if (url.pathname !== SLIDES_API_PREFIX && !url.pathname.startsWith(`${SLIDES_API_PREFIX}/`)) return false;
  void handle(request, response, url, deps).catch((error: unknown) => {
    deps.log?.("slides.http_failed", { path: url.pathname, error: errorMessage(error) });
    if (!response.headersSent) sendJson(response, 500, { error: "internal_error", message: "Something went wrong." });
    else response.end();
  });
  return true;
}

async function handle(request: IncomingMessage, response: ServerResponse, url: URL, deps: SlidesHttpDeps): Promise<void> {
  const origin = request.headers.origin;
  const allowed = deps.allowedOrigins ?? [];
  if (origin && allowed.length > 0 && !allowed.includes(origin)) {
    sendJson(response, 403, { error: "origin_not_allowed" });
    return;
  }
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-expose-headers", "content-disposition");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600"
    });
    response.end();
    return;
  }
  if (deps.ownerToken && !tokensMatch(deps.ownerToken, bearer(request) ?? url.searchParams.get("token") ?? undefined)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  const path = url.pathname.slice(SLIDES_API_PREFIX.length).replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method ?? "GET";
  const { runtime } = deps;
  const service = runtime.slides;
  const ownerId = runtime.ownerId;

  if (method === "GET" && path === "/status") {
    sendJson(response, 200, { enabled: Boolean(service), research: Boolean(deps.toolLlm) });
    return;
  }
  if (method === "GET" && path === "/sources") {
    sendJson(response, 200, { sources: listSources(runtime.tools) });
    return;
  }
  if (segments[0] === "spaces") {
    await spacesRoute(request, response, method, segments, deps);
    return;
  }
  if (!service) {
    sendJson(response, 503, { error: "slides_unavailable", message: "Sibyl Slides is not running. Start the slides service or set SIBYL_SLIDES_URL." });
    return;
  }

  if (method === "GET" && path === "/templates") {
    try {
      const templates = await service.client.templates();
      sendJson(response, 200, { templates: templates.length ? templates : [{ id: "general", name: "General" }] });
    } catch {
      sendJson(response, 200, { templates: [{ id: "general", name: "General" }], fallback: true });
    }
    return;
  }
  if (method === "GET" && path === "/decks") {
    const decks = await service.listDecks(ownerId, url.searchParams.get("spaceId") ?? undefined);
    sendJson(response, 200, { decks: groupVersions(decks, service) });
    return;
  }
  if (method === "GET" && segments[0] === "decks" && segments.length === 3 && (segments[2] === "download" || segments[2] === "thumbnail")) {
    await fileRoute(response, segments[1]!, segments[2], url, service, ownerId);
    return;
  }
  if (method === "POST" && path === "/generate") {
    await generateRoute(request, response, deps, service);
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

/* ───────────── spaces ───────────── */

async function spacesRoute(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  segments: string[],
  deps: SlidesHttpDeps
): Promise<void> {
  const { store, ownerId } = deps.runtime;
  if (segments.length === 1 && method === "GET") {
    const [spaces, decks] = await Promise.all([store.spaces.list(ownerId), store.artifacts.list(ownerId, { kind: "slides" })]);
    const counts = new Map<string, number>();
    for (const deck of decks) if (deck.spaceId) counts.set(deck.spaceId, (counts.get(deck.spaceId) ?? 0) + 1);
    sendJson(response, 200, {
      spaces: spaces
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((space) => ({ ...space, deckCount: counts.get(space.id) ?? 0 })),
      unfiled: decks.filter((deck) => !deck.spaceId || !spaces.some((s) => s.id === deck.spaceId)).length
    });
    return;
  }
  if (segments.length === 1 && method === "POST") {
    const body = await readJson(request, response);
    if (!body) return;
    const name = text(body.name, 80);
    if (!name) {
      sendJson(response, 400, { error: "name_required" });
      return;
    }
    const at = Date.now();
    const space = {
      id: cryptoId(),
      ownerId,
      name,
      ...(text(body.instructions, 4_000) ? { instructions: text(body.instructions, 4_000)! } : {}),
      ...(text(body.template, 120) ? { template: text(body.template, 120)! } : {}),
      createdAt: at,
      updatedAt: at
    };
    await store.spaces.upsert(space);
    sendJson(response, 201, { space });
    return;
  }
  if (segments.length === 2) {
    const existing = await store.spaces.get(ownerId, segments[1]!);
    if (!existing) {
      sendJson(response, 404, { error: "space_not_found" });
      return;
    }
    if (method === "PATCH") {
      const body = await readJson(request, response);
      if (!body) return;
      const next = { ...existing, updatedAt: Date.now() };
      if (body.name !== undefined) {
        const name = text(body.name, 80);
        if (!name) {
          sendJson(response, 400, { error: "name_required" });
          return;
        }
        next.name = name;
      }
      for (const key of ["instructions", "template"] as const) {
        if (body[key] === undefined) continue;
        const value = text(body[key], key === "instructions" ? 4_000 : 120);
        if (value) next[key] = value;
        else delete next[key];
      }
      await store.spaces.upsert(next);
      sendJson(response, 200, { space: next });
      return;
    }
    if (method === "DELETE") {
      // Decks stay in the library (unfiled); the store has no artifact delete.
      await store.spaces.remove(ownerId, existing.id);
      sendJson(response, 200, { ok: true });
      return;
    }
  }
  sendJson(response, 404, { error: "not_found" });
}

/* ───────────── decks ───────────── */

export interface DeckGroup {
  /** Id of the first version (the chain root). */
  id: string;
  title: string;
  spaceId?: string;
  latest: ToolArtifactView;
  versions: ToolArtifactView[];
  updatedAt: number;
}

/** Group versions by their root (parentId chain), newest version first. */
export function groupVersions(decks: ArtifactRecord[], service: SlidesService): DeckGroup[] {
  const byId = new Map(decks.map((deck) => [deck.id, deck]));
  const rootOf = (deck: ArtifactRecord): string => {
    let current = deck;
    const seen = new Set<string>();
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId)!;
    }
    return current.id;
  };
  const groups = new Map<string, ArtifactRecord[]>();
  for (const deck of decks) {
    const root = rootOf(deck);
    groups.set(root, [...(groups.get(root) ?? []), deck]);
  }
  return [...groups.entries()]
    .map(([id, members]) => {
      const sorted = members.sort((a, b) => b.version - a.version || b.createdAt - a.createdAt);
      const latest = sorted[0]!;
      return {
        id,
        title: latest.title,
        ...(latest.spaceId ? { spaceId: latest.spaceId } : {}),
        latest: service.view(latest),
        versions: sorted.map((deck) => service.view(deck)),
        updatedAt: Math.max(...sorted.map((deck) => deck.createdAt))
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function fileRoute(
  response: ServerResponse,
  artifactId: string,
  kind: "download" | "thumbnail",
  url: URL,
  service: SlidesService,
  ownerId: string
): Promise<void> {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  try {
    let enginePath: string;
    let filename: string | undefined;
    if (kind === "thumbnail") {
      const artifact = await service.listDecks(ownerId).then((decks) => decks.find((d) => d.id === artifactId));
      const thumbnail = (artifact?.meta as Partial<SlidesMeta> | undefined)?.thumbnail;
      if (!thumbnail) {
        sendJson(response, 404, { error: "no_thumbnail" });
        return;
      }
      enginePath = thumbnail;
    } else {
      const format = url.searchParams.get("format") === "pdf" ? "pdf" : ("pptx" satisfies ExportFormat);
      const found = await service.exportPath(ownerId, artifactId, format, controller.signal);
      enginePath = found.path;
      filename = `${safeFilename(found.title)}.${format}`;
    }
    const upstream = await service.client.download(enginePath, controller.signal);
    const type =
      upstream.headers.get("content-type") ??
      (filename?.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const headers: Record<string, string> = { "content-type": type, "cache-control": "private, no-store" };
    const length = upstream.headers.get("content-length");
    if (length) headers["content-length"] = length;
    if (filename) headers["content-disposition"] = `attachment; filename="${filename.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    response.writeHead(200, headers);
    if (!upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => response.destroy()).pipe(response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof SlidesEngineError && error.status === 404 ? 404 : 502;
    sendJson(response, status, { error: "download_failed", message: errorMessage(error) });
  }
}

/* ───────────── sources ───────────── */

export interface SlidesSource {
  /** "tool:<name>" or "mcp:<server>". */
  id: string;
  label: string;
  kind: "tool" | "mcp";
  description?: string;
  tools: string[];
}

/** Read-only tools the research step may use: built-ins one by one, MCP grouped by server. */
export function listSources(registry: ToolRegistry): SlidesSource[] {
  const tools = researchTools(registry);
  const sources: SlidesSource[] = [];
  const servers = new Map<string, string[]>();
  for (const tool of tools) {
    if (tool.source === "mcp" && tool.provider) {
      servers.set(tool.provider, [...(servers.get(tool.provider) ?? []), tool.name]);
    } else {
      sources.push({ id: `tool:${tool.name}`, label: tool.title, kind: "tool", description: tool.description.slice(0, 200), tools: [tool.name] });
    }
  }
  for (const [server, names] of servers) {
    sources.push({ id: `mcp:${server}`, label: server, kind: "mcp", description: `${names.length} tool${names.length === 1 ? "" : "s"} from MCP server ${server}`, tools: names });
  }
  return sources;
}

function researchTools(registry: ToolRegistry): ToolDefinition<any, any>[] {
  return registry
    .list({ enabledOnly: true })
    .filter((tool) => tool.effect === "read" && !(SLIDES_TOOL_NAMES as readonly string[]).includes(tool.name));
}

export function selectTools(registry: ToolRegistry, selected: string[]): ToolDefinition<any, any>[] {
  const wanted = new Set(selected);
  return researchTools(registry).filter(
    (tool) => wanted.has(`tool:${tool.name}`) || wanted.has(tool.name) || (tool.provider !== undefined && tool.source === "mcp" && wanted.has(`mcp:${tool.provider}`))
  );
}

/* ───────────── generate (SSE) ───────────── */

export type SlidesProgressEvent =
  | { type: "step"; step: "researching"; tools: string[] }
  | { type: "step"; step: "outlining" }
  | { type: "step"; step: "generating"; nSlides: number; estimateUsd: number }
  | { type: "tool"; callId: string; name: string; title: string; status: "running" | "ok" | "error" | "declined"; summary?: string }
  | { type: "done"; artifact: ToolArtifactView }
  | { type: "error"; message: string };

export const RESEARCH_PROMPT = [
  "You research and outline slide decks for the user.",
  "Use the available tools to gather real, current data for the request (figures, names, dates, sources). Do not write anything until you have the data you need.",
  "Then reply with ONLY a slide-by-slide outline in Markdown: a first line `# <deck title>`, then `## Slide N: <heading>` sections with short bullets that contain the actual figures, each with its source.",
  "Never invent numbers; if something could not be found, say so on the slide."
].join("\n");

async function generateRoute(request: IncomingMessage, response: ServerResponse, deps: SlidesHttpDeps, service: SlidesService): Promise<void> {
  const body = await readJson(request, response);
  if (!body) return;
  const prompt = text(body.prompt, 20_000);
  if (!prompt) {
    sendJson(response, 400, { error: "prompt_required" });
    return;
  }
  const { runtime } = deps;
  const ownerId = runtime.ownerId;
  const nSlides = clampSlides(typeof body.nSlides === "number" ? body.nSlides : DEFAULT_SLIDE_COUNT);
  const selected = Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === "string") : [];
  const tools = selectTools(runtime.tools, selected);
  const spaceId = text(body.spaceId, 200);
  const template = text(body.template, 120);
  const language = text(body.language, 40);
  const explicitTitle = text(body.title, 160);

  const estimateUsd = service.estimateUsd(nSlides);
  try {
    service.checkBudget(ownerId, estimateUsd);
  } catch (error) {
    sendJson(response, 402, { error: "budget_blocked", message: errorMessage(error) });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  const send = (event: SlidesProgressEvent): void => {
    if (!response.writableEnded && !response.destroyed) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref?.();

  const runId = `slides-${cryptoId()}`;
  try {
    const space = await service.resolveSpace(ownerId, spaceId);
    let outline = "";
    const model = deps.model?.();
    if (tools.length > 0 && deps.toolLlm && model) {
      send({ type: "step", step: "researching", tools: tools.map((tool) => tool.name) });
      let outlining = false;
      const extraBody = deps.llmParams?.(model);
      const result = await runToolLoop({
        provider: deps.toolLlm,
        model,
        ...(extraBody ? { extraBody } : {}),
        tools,
        maxRounds: RESEARCH_ROUNDS,
        signal: controller.signal,
        runId,
        ownerId,
        store: runtime.store,
        meter: runtime.meter,
        messages: [
          { role: "system", content: RESEARCH_PROMPT },
          {
            role: "user",
            content: [
              `Deck request: ${prompt}`,
              `Slides: about ${nSlides}.`,
              space.instructions ? `Space guidance: ${space.instructions}` : ""
            ]
              .filter(Boolean)
              .join("\n")
          }
        ],
        log: (event, fields) => deps.log?.(event, { runId, ...fields }),
        onText: (delta) => {
          if (!outlining) {
            outlining = true;
            send({ type: "step", step: "outlining" });
          }
          outline += delta;
        },
        onToolStarted: (call) => send({ type: "tool", callId: call.callId, name: call.toolName, title: call.title, status: "running" }),
        onToolFinished: (call) =>
          send({ type: "tool", callId: call.callId, name: call.toolName, title: call.title, status: call.status, ...(call.summary ? { summary: call.summary } : {}) }),
        // Sources are read-only; nothing in this flow may change the world.
        approve: async () => "declined"
      });
      if (result.aborted || controller.signal.aborted) return;
    } else {
      send({ type: "step", step: "outlining" });
    }

    const title = explicitTitle ?? outlineTitle(outline) ?? titleFrom(prompt);
    const content = outline.trim() ? `Request: ${prompt}\n\n${outline.trim()}` : prompt;
    send({ type: "step", step: "generating", nSlides, estimateUsd });
    const artifact = await service.create({
      ownerId,
      title,
      content,
      nSlides,
      space: space.id,
      ...(template ? { template } : {}),
      ...(language ? { language } : {}),
      requestId: runId,
      signal: controller.signal
    });
    send({ type: "done", artifact: service.view(artifact) });
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof SlidesBudgetError || error instanceof SlidesEngineError ? error.message : `Slides failed: ${errorMessage(error)}`;
      send({ type: "error", message });
      deps.log?.("slides.generate_failed", { runId, error: errorMessage(error) });
    }
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

function outlineTitle(outline: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(outline);
  return match?.[1]?.trim().slice(0, 160) || undefined;
}

function titleFrom(prompt: string): string {
  const firstLine = prompt.split(/\n/)[0]!.trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 59).trimEnd()}…` : firstLine;
}

/* ───────────── helpers ───────────── */

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return match?.[1]?.trim();
}

async function readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      sendJson(response, 413, { error: "body_too_large" });
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  sendJson(response, 400, { error: "invalid_json" });
  return undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function safeFilename(title: string): string {
  return title.replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().replace(/\s+/g, "_").slice(0, 80) || "deck";
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
