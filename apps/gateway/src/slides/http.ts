/**
 * Slides page API on the gateway's HTTP server, under /api/slides/*.
 *
 * Runs behind the gateway's identity gate like every other API
 * (gateProtectedRoute: slides.use to read, slides.manage to change or
 * generate), with the shared CORS rule. Decks, spaces and builds are scoped
 * to the request's workspace. Engine URLs and tokens never reach the
 * browser: files are streamed through the gateway.
 *
 *   GET    /api/slides/status
 *   GET    /api/slides/sources                 read-only data sources, grouped ("Web", "Your connections")
 *   GET    /api/slides/templates
 *   GET    /api/slides/spaces
 *   POST   /api/slides/spaces                  { name, instructions?, template? }
 *   PATCH  /api/slides/spaces/:id              { name?, instructions?, template? }
 *   DELETE /api/slides/spaces/:id
 *   GET    /api/slides/decks?spaceId=          decks with their versions
 *   GET    /api/slides/decks/:id/download?format=pptx|pdf
 *   GET    /api/slides/decks/:id/thumbnail
 *   POST   /api/slides/generate                SSE: job → research → outline → generate → done
 *   GET    /api/slides/jobs                    recent deck builds (running / done / error)
 *   DELETE /api/slides/jobs/:id                stop a running build
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import { AUDIT_ACTIONS, type ArtifactRecord, type Governance, type Store, type ToolDefinition, type ToolRegistry, type UsageMeter } from "@open-gpt-live/core";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { runToolLoop } from "../brain/tool-loop.js";
import { auditRequest, corsGuard, isUnder, newId, readJsonObject, requestCaller, requestUrl, requestWorkspace, runRoute, sendBodyError, sendJson, type ApiOptions, type HeaderMap } from "../http/index.js";
import { SlidesEngineError, type ExportFormat } from "./client.js";
import { SlidesBudgetError, SlidesLibrary, clampSlides, DEFAULT_SLIDE_COUNT, type SlidesScope, type SlidesService } from "./service.js";
import { SLIDES_TOOL_NAMES } from "./tools.js";

export const SLIDES_API_PREFIX = "/api/slides";
const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const MAX_BODY_BYTES = 256 * 1024;
const RESEARCH_ROUNDS = 5;

export interface SlidesHttpDeps extends ApiOptions {
  runtime: { ownerId: string; store: Store; tools: ToolRegistry; meter: UsageMeter; slides?: SlidesService; governance?: Governance };
  /** Tool-calling model stream for the research step. */
  toolLlm?: ToolChatProvider;
  /** Model for the research step (the session default deep-brain model). */
  model?: () => string | undefined;
  llmParams?: (model: string) => Record<string, unknown> | undefined;
}

/** One request's context: where it acts and how it replies. */
interface SlidesRequest {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  scope: SlidesScope;
  library: SlidesLibrary;
  reply: (status: number, body: unknown) => void;
  cors: HeaderMap;
  deps: SlidesHttpDeps;
}

/** Handles the request when it is a /api/slides route; returns false otherwise. */
export function routeSlidesRequest(request: IncomingMessage, response: ServerResponse, deps: SlidesHttpDeps): boolean {
  const url = requestUrl(request);
  if (!isUnder(url.pathname, SLIDES_API_PREFIX)) return false;
  return runRoute(response, deps.log, "slides.http_failed", handle(request, response, url, deps));
}

async function handle(request: IncomingMessage, response: ServerResponse, url: URL, deps: SlidesHttpDeps): Promise<void> {
  const cors = corsGuard(request, response, deps.allowedOrigins, METHODS);
  if (!cors) return;
  const { runtime } = deps;
  const service = runtime.slides;
  const context: SlidesRequest = {
    request,
    response,
    url,
    scope: { ownerId: runtime.ownerId, workspaceId: requestWorkspace(request) },
    library: service?.library ?? new SlidesLibrary(runtime.store),
    reply: (status, body) => sendJson(response, status, body, cors),
    cors,
    deps
  };
  const { reply, scope } = context;
  const path = url.pathname.slice(SLIDES_API_PREFIX.length).replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method ?? "GET";

  try {
    if (method === "GET" && path === "/status") return reply(200, { enabled: Boolean(service), research: Boolean(deps.toolLlm) });
    if (method === "GET" && path === "/sources") return reply(200, { sources: listSources(runtime.tools), groups: SOURCE_GROUPS });
    if (segments[0] === "spaces") return await spacesRoute(context, method, segments);
    if (!service) {
      request.resume();
      return reply(503, { error: "slides_unavailable", message: "Sibyl Slides is not running. Start the slides service or set SIBYL_SLIDES_URL." });
    }
    if (method === "GET" && path === "/templates") {
      try {
        const templates = await service.client.templates();
        return reply(200, { templates: templates.length ? templates : [{ id: "general", name: "General" }] });
      } catch {
        return reply(200, { templates: [{ id: "general", name: "General" }], fallback: true });
      }
    }
    if (method === "GET" && path === "/decks") {
      const decks = await service.listDecks(scope, url.searchParams.get("spaceId") ?? undefined);
      return reply(200, { decks: groupVersions(decks, service) });
    }
    if (method === "GET" && segments[0] === "decks" && segments.length === 3 && (segments[2] === "download" || segments[2] === "thumbnail")) {
      return await fileRoute(context, segments[1]!, segments[2], service);
    }
    if (method === "POST" && path === "/generate") return await generateRoute(context, service);
    if (method === "GET" && path === "/jobs") return reply(200, { jobs: service.jobs.list(SlidesLibrary.workspaceOf(scope)) });
    if (method === "DELETE" && segments[0] === "jobs" && segments.length === 2) {
      return reply(service.jobs.cancel(segments[1]!, SlidesLibrary.workspaceOf(scope)) ? 200 : 404, { ok: true });
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}

/* ───────────── spaces ───────────── */

async function spacesRoute({ request, reply, scope, library }: SlidesRequest, method: string, segments: string[]): Promise<void> {
  if (segments.length === 1 && method === "GET") {
    const [spaces, decks] = await Promise.all([library.spaces(scope), library.decks(scope)]);
    const counts = new Map<string, number>();
    for (const deck of decks) if (deck.spaceId) counts.set(deck.spaceId, (counts.get(deck.spaceId) ?? 0) + 1);
    return reply(200, {
      spaces: spaces
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((space) => ({ ...space, deckCount: counts.get(space.id) ?? 0 })),
      unfiled: decks.filter((deck) => !deck.spaceId || !spaces.some((s) => s.id === deck.spaceId)).length
    });
  }
  if (segments.length === 1 && method === "POST") {
    const body = await readJsonObject(request, MAX_BODY_BYTES);
    const name = text(body.name, 80);
    if (!name) return reply(400, { error: "name_required" });
    const instructions = text(body.instructions, 4_000);
    const template = text(body.template, 120);
    const space = await library.createSpace(scope, { name, ...(instructions ? { instructions } : {}), ...(template ? { template } : {}) });
    return reply(201, { space });
  }
  if (segments.length === 2) {
    const existing = await library.space(scope, segments[1]!);
    if (!existing) {
      request.resume();
      return reply(404, { error: "space_not_found" });
    }
    if (method === "PATCH") {
      const body = await readJsonObject(request, MAX_BODY_BYTES);
      const next = { ...existing, updatedAt: Date.now() };
      if (body.name !== undefined) {
        const name = text(body.name, 80);
        if (!name) return reply(400, { error: "name_required" });
        next.name = name;
      }
      for (const key of ["instructions", "template"] as const) {
        if (body[key] === undefined) continue;
        const value = text(body[key], key === "instructions" ? 4_000 : 120);
        if (value) next[key] = value;
        else delete next[key];
      }
      await library.saveSpace(next);
      return reply(200, { space: next });
    }
    if (method === "DELETE") {
      // Decks stay in the library (unfiled); the store has no artifact delete.
      request.resume();
      await library.removeSpace(scope, existing.id);
      return reply(200, { ok: true });
    }
  }
  request.resume();
  return reply(404, { error: "not_found" });
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

/**
 * First-slide thumbnails, cached briefly in memory: the library asks for every
 * card at once, and the engine's render (a PDF export of the deck) is slow the
 * first time. The engine keeps its own on-disk cache and re-renders after edits.
 */
const THUMBNAIL_TTL_MS = 5 * 60 * 1000;
const MAX_THUMBNAILS = 200;
const thumbnailCache = new Map<string, { body: Buffer; type: string; expires: number }>();

function rememberThumbnail(id: string, entry: { body: Buffer; type: string; expires: number }): void {
  thumbnailCache.delete(id);
  if (thumbnailCache.size >= MAX_THUMBNAILS) {
    const oldest = thumbnailCache.keys().next().value;
    if (oldest !== undefined) thumbnailCache.delete(oldest);
  }
  thumbnailCache.set(id, entry);
}

function sendThumbnail(response: ServerResponse, entry: { body: Buffer; type: string }, cors: HeaderMap): void {
  response.writeHead(200, { ...cors, "content-type": entry.type, "content-length": String(entry.body.length), "cache-control": "private, max-age=300" });
  response.end(entry.body);
}

async function fileRoute({ request, response, url, scope, library, cors, reply, deps }: SlidesRequest, artifactId: string, kind: "download" | "thumbnail", service: SlidesService): Promise<void> {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  try {
    let enginePath: string;
    let filename: string | undefined;
    if (kind === "thumbnail") {
      const artifact = await library.deck(scope, artifactId);
      const thumbnail = artifact ? service.thumbnailPath(artifact) : undefined;
      if (!thumbnail) return reply(404, { error: "no_thumbnail" });
      const cached = thumbnailCache.get(artifactId);
      if (cached && cached.expires > Date.now()) return sendThumbnail(response, cached, cors);
      const upstream = await service.client.download(thumbnail, controller.signal);
      const entry = {
        body: Buffer.from(await upstream.arrayBuffer()),
        type: upstream.headers.get("content-type") ?? "image/png",
        expires: Date.now() + THUMBNAIL_TTL_MS
      };
      rememberThumbnail(artifactId, entry);
      return sendThumbnail(response, entry, cors);
    } else {
      const format = url.searchParams.get("format") === "pdf" ? "pdf" : ("pptx" satisfies ExportFormat);
      const found = await service.exportPath(scope, artifactId, format, controller.signal);
      enginePath = found.path;
      filename = `${safeFilename(found.title)}.${format}`;
      auditRequest(deps, request, { action: AUDIT_ACTIONS.EXPORT, target: { kind: "deck", id: artifactId, name: found.title }, details: { format } });
    }
    const upstream = await service.client.download(enginePath, controller.signal);
    const type =
      upstream.headers.get("content-type") ??
      (filename?.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const headers: HeaderMap = { ...cors, "content-type": type, "cache-control": "private, no-store" };
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
    reply(status, { error: "download_failed", message: errorMessage(error) });
  }
}

/* ───────────── sources ───────────── */

export type SlidesSourceGroup = "web" | "connections";

export interface SlidesSource {
  /** "tool:<name>" or "mcp:<server>". */
  id: string;
  label: string;
  kind: "tool" | "mcp";
  group: SlidesSourceGroup;
  description?: string;
  tools: string[];
}

export const SOURCE_GROUPS: Array<{ id: SlidesSourceGroup; label: string }> = [
  { id: "web", label: "Web" },
  { id: "connections", label: "Your connections" }
];

/**
 * Built-in tools that fetch outside data, with the label the New deck panel
 * shows. Anything else built in (memory, secrets, routines, slides, files,
 * calculators) is never offered as a source, even when it is read-only.
 */
export const WEB_SOURCES: Record<string, string> = {
  web_search: "Web search",
  read_webpage: "Read a webpage",
  wikipedia: "Wikipedia",
  weather: "Weather",
  currency_convert: "Currency rates",
  world_time: "World time"
};

/** Tool sources that are the user's own connections (MCP servers, knowledge bases, integrations). */
const CONNECTION_SOURCES = new Set(["mcp", "knowledge", "integration", "integrations", "connector"]);

/** Never a data source, whatever a connection calls itself. */
const PRIVATE_TOOL = /memor|recall|remember|secret|credential|password|token|routine|slides?\b|admin/i;

function isResearchTool(tool: ToolDefinition<any, any>): boolean {
  if (tool.effect !== "read") return false;
  if ((SLIDES_TOOL_NAMES as readonly string[]).includes(tool.name)) return false;
  if (tool.source === "builtin") return Object.hasOwn(WEB_SOURCES, tool.name);
  if (!CONNECTION_SOURCES.has(tool.source)) return false;
  return !PRIVATE_TOOL.test(tool.name) && !PRIVATE_TOOL.test(tool.provider ?? "");
}

/**
 * Read-only data sources the research step may use: web tools one by one
 * (in WEB_SOURCES order), then the user's connections grouped by server.
 */
export function listSources(registry: ToolRegistry): SlidesSource[] {
  const tools = researchTools(registry);
  const web: SlidesSource[] = [];
  const connections: SlidesSource[] = [];
  const servers = new Map<string, string[]>();
  for (const tool of tools) {
    if (tool.source === "builtin") {
      web.push({ id: `tool:${tool.name}`, label: WEB_SOURCES[tool.name] ?? tool.title, kind: "tool", group: "web", description: tool.description.slice(0, 200), tools: [tool.name] });
    } else if (tool.provider) {
      servers.set(tool.provider, [...(servers.get(tool.provider) ?? []), tool.name]);
    } else {
      connections.push({ id: `tool:${tool.name}`, label: tool.title, kind: "tool", group: "connections", description: tool.description.slice(0, 200), tools: [tool.name] });
    }
  }
  const order = Object.keys(WEB_SOURCES);
  web.sort((a, b) => order.indexOf(a.tools[0]!) - order.indexOf(b.tools[0]!));
  for (const [server, names] of servers) {
    connections.push({
      id: `mcp:${server}`,
      label: server,
      kind: "mcp",
      group: "connections",
      description: `${names.length} read-only tool${names.length === 1 ? "" : "s"} from ${server}`,
      tools: names
    });
  }
  return [...web, ...connections];
}

function researchTools(registry: ToolRegistry): ToolDefinition<any, any>[] {
  return registry.list({ enabledOnly: true }).filter(isResearchTool);
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
  | { type: "job"; id: string }
  | { type: "done"; artifact: ToolArtifactView }
  | { type: "error"; message: string };

export const RESEARCH_PROMPT = [
  "You research and outline slide decks for the user.",
  "Use the available tools to gather real, current data for the request (figures, names, dates, sources). Do not write anything until you have the data you need.",
  "Then reply with ONLY a slide-by-slide outline in Markdown: a first line `# <deck title>`, then `## Slide N: <heading>` sections with short bullets that contain the actual figures, each with its source.",
  "Never invent numbers; if something could not be found, say so on the slide."
].join("\n");

async function generateRoute({ request, response, deps, scope, library, cors, reply }: SlidesRequest, service: SlidesService): Promise<void> {
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  const prompt = text(body.prompt, 20_000);
  if (!prompt) return reply(400, { error: "prompt_required" });
  const { runtime } = deps;
  const ownerId = scope.ownerId;
  const workspaceId = SlidesLibrary.workspaceOf(scope);
  const nSlides = clampSlides(typeof body.nSlides === "number" ? body.nSlides : DEFAULT_SLIDE_COUNT);
  const selected = Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === "string") : [];
  // Organization policy: blocked tools are not offered (and the loop refuses them anyway).
  const tools = selectTools(runtime.tools, selected).filter((tool) => runtime.governance?.toolDecision(tool, { workspaceId }).allowed ?? true);
  const spaceId = text(body.spaceId, 200);
  const template = text(body.template, 120);
  const language = text(body.language, 40);
  const explicitTitle = text(body.title, 160);

  const estimateUsd = service.estimateUsd(nSlides);
  try {
    service.checkBudget(ownerId, estimateUsd);
  } catch (error) {
    return reply(402, { error: "budget_blocked", message: errorMessage(error) });
  }

  response.writeHead(200, {
    ...cors,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const runId = newId("slides");
  // The build outlives the request: leaving the page does not stop it (see
  // jobs.ts); only DELETE /api/slides/jobs/:id (the Stop button) does.
  const job = service.jobs.start(runId, explicitTitle ?? titleFrom(prompt), workspaceId, requestCaller(request)?.principal.userId);
  const controller = job.controller;
  const send = (event: SlidesProgressEvent): void => {
    if (!response.writableEnded && !response.destroyed) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref?.();
  response.on("close", () => clearInterval(heartbeat));
  send({ type: "job", id: runId });

  try {
    const space = await library.resolveSpace(scope, spaceId);
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
        ...(runtime.governance ? { governance: runtime.governance } : {}),
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
      if (result.aborted || controller.signal.aborted) {
        service.jobs.finish(runId, { cancelled: true });
        return;
      }
    } else {
      send({ type: "step", step: "outlining" });
    }

    const planned = explicitTitle ?? outlineTitle(outline);
    const title = planned ?? titleFrom(prompt);
    const content = outline.trim() ? `Request: ${prompt}\n\n${outline.trim()}` : prompt;
    send({ type: "step", step: "generating", nSlides, estimateUsd });
    const artifact = await service.create({
      ownerId,
      workspaceId,
      title,
      // Without a title from the user or the outline, the engine names the deck.
      ...(planned ? {} : { draftTitle: true }),
      content,
      nSlides,
      space: space.id,
      ...(template ? { template } : {}),
      ...(language ? { language } : {}),
      requestId: runId,
      signal: controller.signal
    });
    const view = service.view(artifact);
    service.jobs.finish(runId, { artifact: view });
    send({ type: "done", artifact: view });
  } catch (error) {
    if (controller.signal.aborted) {
      service.jobs.finish(runId, { cancelled: true });
    } else {
      const message = error instanceof SlidesBudgetError || error instanceof SlidesEngineError ? error.message : `Slides failed: ${errorMessage(error)}`;
      service.jobs.finish(runId, { error: message });
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

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function safeFilename(title: string): string {
  return title.replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().replace(/\s+/g, "_").slice(0, 80) || "deck";
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
