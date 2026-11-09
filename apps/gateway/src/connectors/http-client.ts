/**
 * The single HTTP client behind every connector call.
 *
 * - Credentials are added here (connector code never sees a token) and only
 *   for the connector's own API hosts.
 * - Timeouts per attempt, tied to the brain run's AbortSignal.
 * - Retries: 429 always (it was not processed), 5xx and network errors only
 *   for idempotent methods; Retry-After is respected (capped).
 * - A 401 triggers one credential refresh and a single retry.
 * - Pagination helper with an item cap.
 */
import { ConnectorError, type ConnectorHttp, type HttpRequest, type HttpResponse } from "./types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_CONNECTOR_TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const USER_AGENT = "Sibyl/0.4 (connectors)";

export class ConnectorHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = "ConnectorHttpError";
  }
}

export interface ConnectorHttpOptions {
  fetch: FetchLike;
  /** Headers that authenticate a request (Authorization etc.); `as: "user"` asks for the person's user token. */
  authHeaders(as?: "user"): Promise<Record<string, string>>;
  /** Refresh credentials after a 401; resolves true when a retry makes sense. */
  onUnauthorized?(): Promise<boolean>;
  /** May credentials be sent to this host? */
  hostAllowed(host: string): boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  log?(event: string, fields?: Record<string, unknown>): void;
}

export function createConnectorHttp(options: ConnectorHttpOptions): ConnectorHttp {
  const sleep = options.sleep ?? defaultSleep;

  async function request<T>(input: HttpRequest): Promise<HttpResponse<T>> {
    const method = input.method ?? (input.body !== undefined || input.form ? "POST" : "GET");
    const url = buildUrl(input.url, input.query);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConnectorError("bad_url", "Only http(s) URLs can be called");
    const presigned = input.unauthenticated === true && url.protocol === "https:";
    if (!presigned && !options.hostAllowed(url.host) && !options.hostAllowed(url.hostname)) {
      throw new ConnectorError("host_not_allowed", `This connection may not call ${url.hostname}`);
    }
    const idempotent = method !== "POST";
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const signal = withTimeout(options.signal, input.timeoutMs ?? options.timeoutMs ?? DEFAULT_CONNECTOR_TIMEOUT_MS);
      // Outside the network try: a failed refresh is not a network error to retry.
      const auth = input.unauthenticated ? {} : await options.authHeaders(input.as);
      let response: Response;
      try {
        response = await options.fetch(url, {
          method,
          headers: {
            accept: input.responseType === "buffer" ? "*/*" : "application/json",
            "user-agent": USER_AGENT,
            ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(input.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
            ...input.headers,
            ...auth
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
          ...(input.form ? { body: new URLSearchParams(input.form).toString() } : {}),
          signal,
          redirect: "manual"
        });
      } catch (error) {
        if (options.signal?.aborted) throw new ConnectorError("cancelled", "The request was cancelled.");
        if (idempotent && attempt < MAX_RETRIES) {
          await sleep(backoff(attempt), options.signal);
          continue;
        }
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new ConnectorHttpError(0, timedOut ? "The service did not answer in time." : "Could not reach the service.");
      }

      if (response.status === 401 && !refreshed && options.onUnauthorized && input.as !== "user") {
        refreshed = true;
        await response.body?.cancel().catch(() => undefined);
        if (await options.onUnauthorized()) continue;
      }
      const retryable = response.status === 429 || (idempotent && response.status >= 500 && response.status !== 501);
      if (retryable && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(response.headers.get("retry-after")) ?? backoff(attempt);
        await response.body?.cancel().catch(() => undefined);
        options.log?.("connectors.retry", { status: response.status, attempt: attempt + 1, waitMs: wait, host: url.hostname });
        await sleep(Math.min(wait, MAX_RETRY_WAIT_MS), options.signal);
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConnectorHttpError(response.status, `The service redirected (HTTP ${response.status}); not followed.`);
      }
      if (!response.ok) {
        const text = await readLimited(response, 64 * 1024).then((b) => b.toString("utf8")).catch(() => "");
        throw new ConnectorHttpError(response.status, `HTTP ${response.status}`, errorDetail(text));
      }
      const data = await parseBody<T>(response, input);
      return { status: response.status, headers: response.headers, data };
    }
  }

  const simple =
    (method: NonNullable<HttpRequest["method"]>) =>
    async <T>(url: string, body?: unknown, query?: HttpRequest["query"]): Promise<T> =>
      (await request<T>({ method, url, ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) })).data;

  return {
    request,
    get: async <T>(url: string, query?: HttpRequest["query"], headers?: Record<string, string>) =>
      (await request<T>({ method: "GET", url, ...(query ? { query } : {}), ...(headers ? { headers } : {}) })).data,
    post: simple("POST"),
    patch: simple("PATCH"),
    put: simple("PUT"),
    delete: async <T>(url: string, query?: HttpRequest["query"]) => (await request<T>({ method: "DELETE", url, ...(query ? { query } : {}) })).data,
    async paginate<Page, Item>(
      first: HttpRequest,
      paging: { items(page: Page): Item[]; next(page: Page): HttpRequest | string | undefined; max: number }
    ): Promise<Item[]> {
      const out: Item[] = [];
      let next: HttpRequest | undefined = first;
      for (let pages = 0; next && pages < 50; pages += 1) {
        const page: Page = (await request<Page>(next)).data;
        out.push(...paging.items(page));
        if (out.length >= paging.max) return out.slice(0, paging.max);
        const following = paging.next(page);
        next = typeof following === "string" ? { url: following } : following;
      }
      return out;
    }
  };
}

export function buildUrl(base: string, query?: HttpRequest["query"]): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

/** Does `host` match one of the patterns ("example.com" exact, ".example.com" any subdomain)? */
export function hostMatches(patterns: readonly string[], host: string): boolean {
  const target = host.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith(".") ? target.endsWith(p) && target.length > p.length : target === p;
  });
}

async function parseBody<T>(response: Response, input: HttpRequest): Promise<T> {
  const type = input.responseType ?? "json";
  const max = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return undefined as T;
  }
  const raw = await readLimited(response, max);
  if (type === "buffer") return raw as T;
  const text = raw.toString("utf8");
  if (type === "text") return text as T;
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("too_large", `The file is too large to read here (over ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ConnectorError("too_large", `The file is too large to read here (over ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Retry-After as milliseconds (seconds or an HTTP date). */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function backoff(attempt: number): number {
  return Math.min(MAX_RETRY_WAIT_MS, 400 * 2 ** attempt + Math.floor(Math.random() * 200));
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ConnectorError("cancelled", "The request was cancelled."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ConnectorError("cancelled", "The request was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A short, model-readable reason from a vendor error body (never headers). */
function errorDetail(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as unknown;
    const pick = (value: unknown): string | undefined => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return pick(value[0]);
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return pick(record.message ?? record.error_description ?? record.error ?? record.errorCode);
      }
      return undefined;
    };
    return pick(body)?.slice(0, 300);
  } catch {
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
  }
}
