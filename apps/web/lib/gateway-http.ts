"use client";

/**
 * The web app's one HTTP client for the Sibyl gateway.
 *
 * Every REST call (identity, knowledge, skills, plugins, integrations,
 * monitors, memory, licence, slides, uploads) goes through here, so they all
 * agree on:
 *
 *  - where the gateway is (`gatewayHttpUrl`): NEXT_PUBLIC_GATEWAY_HTTP_URL,
 *    else the origin of NEXT_PUBLIC_GATEWAY_WS_URL, else localhost:8787;
 *  - who is asking: the session cookie (`credentials: "include"`) plus the
 *    stored owner token as a Bearer header (never in a URL);
 *  - which workspace: the `x-sibyl-workspace` header from the app session;
 *  - errors: one `GatewayError` carrying status, message and code.
 */
import { currentWorkspaceId } from "./app-session";
import { readOwnerToken } from "../components/SignIn";

const DEFAULT_GATEWAY = "http://localhost:8787";

/** The gateway's WebSocket address (the live session). */
export const gatewayWsUrl = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787";

/** The gateway's HTTP origin (no trailing slash). */
export function gatewayHttpUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_GATEWAY_HTTP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const url = new URL(gatewayWsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  } catch {
    return DEFAULT_GATEWAY;
  }
}

/** Absolute gateway URL for a path such as `/api/knowledge`. */
export function gatewayUrlFor(path: string): string {
  return /^https?:\/\//.test(path) ? path : `${gatewayHttpUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** A user-facing message for anything thrown by a gateway call. */
export function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
}

export interface AuthOptions {
  /** Owner token to send instead of the stored one (null: none, e.g. first-run setup). */
  ownerToken?: string | null;
  /** Workspace header (default: the current workspace; null: none). */
  workspaceId?: string | null;
}

/** Owner token and workspace headers for a gateway request. */
export function gatewayHeaders(options: AuthOptions = {}): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = options.ownerToken === undefined ? readOwnerToken() : options.ownerToken;
  const workspaceId = options.workspaceId === undefined ? currentWorkspaceId() : options.workspaceId;
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(workspaceId ? { "x-sibyl-workspace": workspaceId } : {})
  };
}

export interface GatewayRequest extends AuthOptions {
  method?: string;
  /** JSON body (plain values), or a raw body (Blob / string) sent with `contentType`. */
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const NETWORK_MESSAGE = "Can't reach Sibyl. Check that the gateway is running.";

function fallbackMessage(status: number): string {
  if (status === 401) return "Sign in to continue.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "Not found.";
  return `Request failed (${status}).`;
}

async function errorFrom(response: Response): Promise<GatewayError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const message = typeof body?.message === "string" && body.message ? body.message : fallbackMessage(response.status);
  const code = typeof body?.error === "string" && body.error ? body.error : "error";
  return new GatewayError(message, response.status, code);
}

/**
 * The raw response of a gateway call (for streams and files). Throws
 * GatewayError when the gateway can't be reached or answers with an error.
 */
export async function gatewayFetch(path: string, init: GatewayRequest = {}): Promise<Response> {
  const raw = init.body instanceof Blob || typeof init.body === "string";
  let response: Response;
  try {
    response = await fetch(gatewayUrlFor(path), {
      method: init.method ?? "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        ...gatewayHeaders(init),
        ...(init.body !== undefined ? { "content-type": init.contentType ?? "application/json" } : {}),
        ...(init.headers ?? {})
      },
      ...(init.body !== undefined ? { body: raw ? (init.body as BodyInit) : JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {})
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new GatewayError(NETWORK_MESSAGE, 0, "network");
  }
  if (!response.ok) throw await errorFrom(response);
  return response;
}

/** JSON call to the gateway. */
export async function gatewayRequest<T>(path: string, init: GatewayRequest = {}): Promise<T> {
  const response = await gatewayFetch(path, init);
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayError("The gateway sent an unexpected answer.", response.status, "invalid_response");
  }
}

/** A gateway file as an object URL (auth stays in headers, not the URL). Revoke it when done. */
export async function gatewayObjectUrl(path: string, signal?: AbortSignal): Promise<string> {
  const response = await gatewayFetch(path, signal ? { signal } : {});
  return URL.createObjectURL(await response.blob());
}

/** Download a gateway file under its Content-Disposition name (or `fallbackName`). */
export async function gatewayDownload(path: string, fallbackName: string): Promise<void> {
  const response = await gatewayFetch(path);
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename\*?="?([^";]+)"?/.exec(disposition)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = href;
  link.download = decodeURIComponentSafe(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^UTF-8''/i, ""));
  } catch {
    return value;
  }
}

/**
 * POST a file with upload progress (XHR: fetch can't report it). Resolves
 * with the JSON answer; rejects with GatewayError.
 */
export function gatewayUpload<T>(
  path: string,
  body: Blob,
  options: { headers?: Record<string, string>; onProgress?: (fraction: number) => void } = {}
): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open("POST", gatewayUrlFor(path));
    xhr.withCredentials = true;
    const headers = { ...gatewayHeaders(), "content-type": body.type || "application/octet-stream", ...(options.headers ?? {}) };
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      const data = parseJson(xhr.responseText) as { message?: unknown; error?: unknown } | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      const message = typeof data?.message === "string" && data.message ? data.message : fallbackMessage(xhr.status);
      reject(new GatewayError(message, xhr.status, typeof data?.error === "string" ? data.error : "error"));
    };
    xhr.onerror = () => reject(new GatewayError(NETWORK_MESSAGE, 0, "network"));
    xhr.onabort = () => reject(new GatewayError("Upload cancelled.", 0, "aborted"));
    xhr.send(body);
  });
  return { promise, abort: () => xhr.abort() };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // Not JSON (a proxy's error page).
  }
}

/** Read a `text/event-stream` response, one parsed `data:` payload at a time. */
export async function readEventStream<T>(response: Response, onEvent: (event: T) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as T);
      } catch {
        // Ignore a malformed event.
      }
    }
  }
}
