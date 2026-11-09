/**
 * OpenRouter's media APIs, one small client:
 *
 *   POST /images                  image generation (base64 results, usage.cost)
 *   POST /videos                  submit a video job → { id }
 *   GET  /videos/<id>             poll: pending | in_progress | completed | failed (+ usage.cost)
 *   GET  /videos/<id>/content     the finished video's bytes (needs the key)
 *   POST /audio/speech            voice-over (bytes; X-Generation-Id for the cost)
 *   POST /chat/completions        music (Lyria): streamed, audio arrives as base64 deltas
 *   GET  /generation?id=          cost of a generation, when the response didn't carry it
 *
 * The key is sent only to OpenRouter and never logged. OpenRouter has no
 * video cancel endpoint (2026-11): cancelling stops waiting, not the render.
 */

export class MediaProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MediaProviderError";
  }
}

export interface MediaClient {
  getJson(path: string, signal?: AbortSignal): Promise<unknown>;
  images(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ images: Array<{ data: Buffer; mime: string }>; costUsd?: number }>;
  submitVideo(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ id: string }>;
  pollVideo(id: string, signal?: AbortSignal): Promise<VideoPoll>;
  videoContent(id: string, index: number, signal?: AbortSignal): Promise<{ data: Buffer; mime: string }>;
  speech(body: { model: string; input: string; voice?: string; format?: string }, signal?: AbortSignal): Promise<{ data: Buffer; mime: string; generationId?: string }>;
  music(body: { model: string; prompt: string }, signal?: AbortSignal): Promise<{ data: Buffer; mime: string; text: string; costUsd?: number }>;
  generationCost(id: string, signal?: AbortSignal): Promise<number | undefined>;
}

export interface VideoPoll {
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";
  outputs: number;
  costUsd?: number;
  error?: string;
}

export interface OpenRouterMediaOptions {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const IMAGE_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export class OpenRouterMediaClient implements MediaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenRouterMediaOptions) {
    this.baseUrl = (options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.options.apiKey);
  }

  private headers(json = true): Record<string, string> {
    return {
      ...(this.options.headers ?? {}),
      authorization: `Bearer ${this.options.apiKey}`,
      ...(json ? { "content-type": "application/json" } : {})
    };
  }

  private async request(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    const signals = [init.signal, AbortSignal.timeout(init.timeoutMs ?? 60_000)].filter((s): s is AbortSignal => Boolean(s));
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: this.headers(init.body !== undefined),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.any(signals)
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new MediaProviderError(`OpenRouter could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new MediaProviderError(await errorMessage(response), response.status);
    return response;
  }

  private async json(path: string, init: Parameters<OpenRouterMediaClient["request"]>[1] = {}): Promise<Record<string, unknown>> {
    const response = await this.request(path, init);
    // OpenRouter may send whitespace keep-alives before the JSON body.
    const text = (await response.text()).trim();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MediaProviderError("OpenRouter sent an unreadable answer.");
    }
  }

  getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.json(path, signal ? { signal } : {});
  }

  async images(body: Record<string, unknown>, signal?: AbortSignal) {
    const result = await this.json("/images", { body, timeoutMs: IMAGE_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    const data = Array.isArray(result.data) ? (result.data as Array<{ b64_json?: unknown; media_type?: unknown; url?: unknown }>) : [];
    const images = data.flatMap((item) => {
      if (typeof item.b64_json !== "string") return [];
      return [{ data: Buffer.from(item.b64_json, "base64"), mime: typeof item.media_type === "string" ? item.media_type : "image/png" }];
    });
    if (!images.length) throw new MediaProviderError("The model returned no image (it may have refused the prompt).");
    const costUsd = usageCost(result.usage);
    return { images, ...(costUsd !== undefined ? { costUsd } : {}) };
  }

  async submitVideo(body: Record<string, unknown>, signal?: AbortSignal) {
    const result = await this.json("/videos", { body, timeoutMs: 120_000, ...(signal ? { signal } : {}) });
    if (typeof result.id !== "string") throw new MediaProviderError("OpenRouter did not return a video job id.");
    return { id: result.id };
  }

  async pollVideo(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const result = await this.json(`/videos/${encodeURIComponent(id)}`, signal ? { signal } : {});
    const status = String(result.status ?? "pending") as VideoPoll["status"];
    const costUsd = usageCost(result.usage);
    const urls = Array.isArray(result.unsigned_urls) ? result.unsigned_urls.length : 0;
    const error = typeof result.error === "string" ? result.error : isRecord(result.error) && typeof result.error.message === "string" ? result.error.message : undefined;
    return { status, outputs: urls, ...(costUsd !== undefined ? { costUsd } : {}), ...(error ? { error } : {}) };
  }

  async videoContent(id: string, index: number, signal?: AbortSignal) {
    const response = await this.request(`/videos/${encodeURIComponent(id)}/content?index=${index}`, { timeoutMs: DOWNLOAD_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    return { data: Buffer.from(await response.arrayBuffer()), mime: response.headers.get("content-type")?.split(";")[0] ?? "video/mp4" };
  }

  async speech(body: { model: string; input: string; voice?: string; format?: string }, signal?: AbortSignal) {
    const response = await this.request("/audio/speech", {
      body: { model: body.model, input: body.input, ...(body.voice ? { voice: body.voice } : {}), response_format: body.format ?? "mp3" },
      timeoutMs: 180_000,
      ...(signal ? { signal } : {})
    });
    const generationId = response.headers.get("x-generation-id") ?? undefined;
    return { data: Buffer.from(await response.arrayBuffer()), mime: response.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg", ...(generationId ? { generationId } : {}) };
  }

  async music(body: { model: string; prompt: string }, signal?: AbortSignal) {
    // Audio output must be streamed (OpenRouter refuses it otherwise).
    const response = await this.request("/chat/completions", {
      body: { model: body.model, messages: [{ role: "user", content: body.prompt }], modalities: ["text", "audio"], audio: { format: "mp3" }, stream: true, usage: { include: true } },
      timeoutMs: 5 * 60_000,
      ...(signal ? { signal } : {})
    });
    const chunks: Buffer[] = [];
    let text = "";
    let costUsd: number | undefined;
    const reader = response.body?.getReader();
    if (!reader) throw new MediaProviderError("OpenRouter sent no audio.");
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line: string) => {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const event = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown; audio?: { data?: unknown } } }>; usage?: unknown; error?: { message?: string } };
        if (event.error?.message) throw new MediaProviderError(event.error.message);
        const delta = event.choices?.[0]?.delta;
        if (typeof delta?.content === "string") text += delta.content;
        if (typeof delta?.audio?.data === "string") chunks.push(Buffer.from(delta.audio.data, "base64"));
        const cost = usageCost(event.usage);
        if (cost !== undefined) costUsd = cost;
      } catch (error) {
        if (error instanceof MediaProviderError) throw error;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    }
    handle(buffer.trim());
    const data = Buffer.concat(chunks);
    if (!data.byteLength) throw new MediaProviderError("The model returned no audio.");
    return { data, mime: "audio/mpeg", text: text.trim(), ...(costUsd !== undefined ? { costUsd } : {}) };
  }

  async generationCost(id: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
      const result = await this.json(`/generation?id=${encodeURIComponent(id)}`, signal ? { signal } : {});
      const data = (result.data ?? {}) as { total_cost?: unknown; usage?: unknown };
      const cost = Number(data.total_cost ?? data.usage);
      return Number.isFinite(cost) ? cost : undefined;
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function usageCost(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const cost = Number(usage.cost);
  return Number.isFinite(cost) ? cost : undefined;
}

async function errorMessage(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.message ?? text;
  } catch {
    // Plain text.
  }
  const clean = message.replace(/\s+/g, " ").slice(0, 400);
  return `OpenRouter answered ${response.status}${clean ? `: ${clean}` : ""}`;
}
