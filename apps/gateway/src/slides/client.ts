/**
 * Sibyl Slides engine client (the vendored Presenton backend).
 *
 * EVERY HTTP call to the engine lives in this file, so the paths can be
 * adjusted in one place. The engine is reached at SIBYL_SLIDES_URL (default
 * http://localhost:8000) and, when SIBYL_OWNER_TOKEN is set, every request
 * carries `Authorization: Bearer <token>`.
 *
 * Engine API used (Presenton public API, prefix /api/v1/ppt):
 *   POST /api/v1/ppt/presentation/generate   { content, n_slides, language, template, export_as, instructions?, tone?, verbosity? }
 *        → { presentation_id, path, edit_path }
 *   GET  /api/v1/ppt/presentation/{id}       → { id, title?, n_slides?, slides?: [...], ... }
 *   POST /api/v1/ppt/presentation/{id}/export { export_as: "pptx" | "pdf" } → { path, edit_path? }
 *   GET  /api/v1/ppt/presentation/{id}/thumbnail → PNG of slide 1 (Sibyl addition, cached by the engine)
 *   GET  /api/v1/sibyl/config                → { model, pricing: { prompt, completion } | null } (Sibyl addition)
 *   GET  /api/v1/ppt/template/all?page_size=100 → { items: [{ id, name, description?, ... }] } (or a bare array)
 *   GET  {path}                               → the exported file (path as returned above, relative to the engine root)
 */

export const DEFAULT_SLIDES_URL = "http://localhost:8000";
export const ENGINE_PATHS = {
  generate: "/api/v1/ppt/presentation/generate",
  presentation: (id: string) => `/api/v1/ppt/presentation/${encodeURIComponent(id)}`,
  export: (id: string) => `/api/v1/ppt/presentation/${encodeURIComponent(id)}/export`,
  /** PNG of slide 1, rendered by the export runtime and cached by the engine. */
  thumbnail: (id: string) => `/api/v1/ppt/presentation/${encodeURIComponent(id)}/thumbnail`,
  templates: "/api/v1/ppt/template/all?page_size=100",
  config: "/api/v1/sibyl/config"
} as const;

export type ExportFormat = "pptx" | "pdf";

export interface GenerateRequest {
  /** Topic, brief, outline and real figures, in plain text or Markdown. */
  content: string;
  nSlides?: number;
  language?: string;
  template?: string;
  instructions?: string;
  tone?: string;
  verbosity?: "concise" | "standard" | "text-heavy";
  exportAs?: ExportFormat;
}

export interface GeneratedDeck {
  presentationId: string;
  /** Exported file path on the engine (relative to its root). */
  path: string;
  /** Editor path on the engine, e.g. /presentation?id=… */
  editPath: string;
  /** What the generation actually cost (OpenRouter usage accounting), when the engine reports it. */
  costUsd?: number;
  /** True when some model calls reported no cost, so costUsd is a lower bound. */
  costEstimated?: boolean;
}

/** The engine's active deck model and its price per token (USD), the one source of truth. */
export interface EngineConfig {
  model?: string;
  pricing?: { prompt: number; completion: number };
}

export interface EnginePresentation {
  id: string;
  title?: string;
  slideCount?: number;
  /** Engine-relative thumbnail path, when the engine provides one. */
  thumbnail?: string;
  raw: Record<string, unknown>;
}

export interface EngineTemplate {
  id: string;
  name: string;
  description?: string;
}

export interface SlidesClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  /** Generation can take minutes (outline + every slide). */
  generateTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** A failure the user can read as-is. */
export class SlidesEngineError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "SlidesEngineError";
  }
}

export interface SlidesClient {
  readonly baseUrl: string;
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<GeneratedDeck>;
  get(presentationId: string, signal?: AbortSignal): Promise<EnginePresentation>;
  export(presentationId: string, format: ExportFormat, signal?: AbortSignal): Promise<{ path: string; editPath?: string }>;
  templates(signal?: AbortSignal): Promise<EngineTemplate[]>;
  config(signal?: AbortSignal): Promise<EngineConfig>;
  /** Stream a file the engine exported (path as returned by generate/export). */
  download(path: string, signal?: AbortSignal): Promise<Response>;
  /** True when the engine answers at all (any HTTP status). */
  ping(timeoutMs?: number): Promise<boolean>;
}

export function createSlidesClient(options: SlidesClientOptions = {}): SlidesClient {
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_SLIDES_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const generateTimeoutMs = options.generateTimeoutMs ?? 10 * 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  const headers = (json: boolean): Record<string, string> => ({
    accept: "application/json",
    ...(json ? { "content-type": "application/json" } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
  });

  async function call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw new SlidesEngineError("Slides generation was cancelled.");
      if (timeout.aborted) {
        throw new SlidesEngineError(`Sibyl Slides did not answer within ${Math.round(timeoutMs / 1000)} s. Try fewer slides or try again.`);
      }
      throw new SlidesEngineError(
        `Sibyl Slides is not reachable at ${baseUrl} (${errorMessage(error)}). Start the slides service or set SIBYL_SLIDES_URL.`
      );
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new SlidesEngineError(friendlyStatus(response.status, detail), response.status);
    }
    return response;
  }

  async function json(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const response = await call(path, init, timeoutMs, signal);
    try {
      return await response.json();
    } catch {
      throw new SlidesEngineError("Sibyl Slides sent a response that is not JSON.");
    }
  }

  return {
    baseUrl,
    async generate(request, signal) {
      const body: Record<string, unknown> = {
        content: request.content,
        language: request.language ?? "English",
        export_as: request.exportAs ?? "pptx"
      };
      if (request.nSlides) body.n_slides = request.nSlides;
      if (request.template) body.template = request.template;
      if (request.instructions) body.instructions = request.instructions;
      if (request.tone) body.tone = request.tone;
      if (request.verbosity) body.verbosity = request.verbosity;
      const data = record(
        await json(ENGINE_PATHS.generate, { method: "POST", headers: headers(true), body: JSON.stringify(body) }, generateTimeoutMs, signal)
      );
      const presentationId = str(data.presentation_id) ?? str(data.id);
      if (!presentationId) throw new SlidesEngineError("Sibyl Slides did not return a presentation id.");
      const costUsd = num(data.cost_usd);
      return {
        presentationId,
        path: str(data.path) ?? "",
        editPath: str(data.edit_path) ?? `/presentation?id=${encodeURIComponent(presentationId)}`,
        ...(costUsd !== undefined && costUsd >= 0 ? { costUsd, costEstimated: data.estimated === true } : {})
      };
    },
    async get(presentationId, signal) {
      const data = record(await json(ENGINE_PATHS.presentation(presentationId), { headers: headers(false) }, requestTimeoutMs, signal));
      const slides = Array.isArray(data.slides) ? data.slides : undefined;
      const firstSlide = slides?.[0] && typeof slides[0] === "object" ? (slides[0] as Record<string, unknown>) : undefined;
      const slideCount = num(data.n_slides) ?? slides?.length;
      const thumbnail = str(data.thumbnail) ?? str(firstSlide?.thumbnail);
      return {
        id: str(data.id) ?? presentationId,
        ...(str(data.title) ? { title: str(data.title)! } : {}),
        ...(slideCount !== undefined ? { slideCount } : {}),
        ...(thumbnail ? { thumbnail } : {}),
        raw: data
      };
    },
    async export(presentationId, format, signal) {
      const data = record(
        await json(
          ENGINE_PATHS.export(presentationId),
          { method: "POST", headers: headers(true), body: JSON.stringify({ export_as: format }) },
          generateTimeoutMs,
          signal
        )
      );
      const path = str(data.path);
      if (!path) throw new SlidesEngineError(`Sibyl Slides did not return a ${format.toUpperCase()} file.`);
      return { path, ...(str(data.edit_path) ? { editPath: str(data.edit_path)! } : {}) };
    },
    async templates(signal) {
      const data = await json(ENGINE_PATHS.templates, { headers: headers(false) }, requestTimeoutMs, signal);
      const items = Array.isArray(data) ? data : Array.isArray(record(data).items) ? (record(data).items as unknown[]) : [];
      return items.flatMap((item): EngineTemplate[] => {
        if (typeof item === "string") return [{ id: item, name: item }];
        const entry = record(item);
        const id = str(entry.id) ?? str(entry.name);
        if (!id) return [];
        const description = str(entry.description);
        return [{ id, name: str(entry.name) ?? id, ...(description ? { description } : {}) }];
      });
    },
    async config(signal) {
      const data = record(await json(ENGINE_PATHS.config, { headers: headers(false) }, requestTimeoutMs, signal));
      const pricing = record(data.pricing);
      const prompt = num(pricing.prompt);
      const completion = num(pricing.completion);
      return {
        ...(str(data.model) ? { model: str(data.model)! } : {}),
        ...(prompt !== undefined && completion !== undefined ? { pricing: { prompt, completion } } : {})
      };
    },
    async download(path, signal) {
      if (!path) throw new SlidesEngineError("This deck has no exported file yet.");
      // Only engine-relative paths: never let a stored value point the proxy elsewhere.
      if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
        throw new SlidesEngineError("Refusing to download a file outside Sibyl Slides.");
      }
      const relative = path.startsWith("/") ? path : `/${path}`;
      return call(encodeURI(relative), { headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) } }, generateTimeoutMs, signal);
    },
    async ping(timeoutMs = 1_500) {
      try {
        await doFetch(`${baseUrl}/`, { signal: AbortSignal.timeout(timeoutMs) });
        return true;
      } catch {
        return false;
      }
    }
  };
}

/** Client from env: SIBYL_SLIDES_URL, SIBYL_OWNER_TOKEN. */
export function slidesClientFromEnv(env: NodeJS.ProcessEnv, overrides: Partial<SlidesClientOptions> = {}): SlidesClient {
  const token = env.SIBYL_OWNER_TOKEN?.trim();
  return createSlidesClient({
    baseUrl: env.SIBYL_SLIDES_URL?.trim() || DEFAULT_SLIDES_URL,
    ...(token ? { token } : {}),
    ...(positiveInt(env.SIBYL_SLIDES_TIMEOUT_MS) ? { generateTimeoutMs: positiveInt(env.SIBYL_SLIDES_TIMEOUT_MS)! } : {}),
    ...overrides
  });
}

function friendlyStatus(status: number, detail: string): string {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) return `Sibyl Slides refused the request (${status}). Check that SIBYL_OWNER_TOKEN matches on both services${suffix}.`;
  if (status === 404) return `Sibyl Slides could not find that (404)${suffix}.`;
  if (status === 422 || status === 400) return `Sibyl Slides rejected the request (${status})${suffix}.`;
  if (status === 429) return "Sibyl Slides is busy (429). Try again in a minute.";
  if (status >= 500) return `Sibyl Slides hit an error (${status})${suffix}.`;
  return `Sibyl Slides answered ${status}${suffix}.`;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown; message?: unknown };
      const detail = parsed.detail ?? parsed.error ?? parsed.message;
      if (typeof detail === "string") return detail.slice(0, 300);
      if (detail !== undefined) return JSON.stringify(detail).slice(0, 300);
    } catch {
      // not JSON
    }
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
