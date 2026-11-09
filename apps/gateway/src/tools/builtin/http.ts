/**
 * Small HTTP helpers shared by the built-in tools: per-call timeouts tied to
 * the brain's AbortSignal, JSON fetching, and friendly error results.
 */
import type { ToolResult } from "@open-gpt-live/core";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "Sibyl/0.3 (open-source assistant)";
export const DEFAULT_TIMEOUT_MS = 10_000;

/** An AbortSignal that fires on the caller's signal or after `timeoutMs`. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
  }
}

/** GET (or POST) JSON with a timeout; throws HttpError on non-2xx. */
export async function fetchJson<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<T> {
  const response = await fetchImpl(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}`, parsed);
  }
  return parsed as T;
}

/** Turn any failure into a compact, model-readable error result. */
export function errorResult(what: string, error: unknown, signal?: AbortSignal): ToolResult<never> {
  return { content: `${what}: ${describeError(error, signal)}`, isError: true };
}

export function describeError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "the request was cancelled.";
  if (error instanceof HttpError) {
    const detail = errorDetail(error.body);
    return `the service answered HTTP ${error.status}${detail ? ` (${detail})` : ""}.`;
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "the request timed out.";
    return error.message || error.name;
  }
  return String(error);
}

function errorDetail(body: unknown): string | undefined {
  if (typeof body === "string") return body.slice(0, 200) || undefined;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.reason ?? record.detail;
    if (typeof message === "string") return message.slice(0, 200);
    if (message && typeof message === "object" && typeof (message as { message?: unknown }).message === "string") {
      return ((message as { message: string }).message).slice(0, 200);
    }
  }
  return undefined;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
