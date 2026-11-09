/**
 * Reading an incoming request: path, query, body (always size-capped), the
 * bearer token and the workspace it acts in. Every gateway HTTP route uses
 * these; none parses requests on its own.
 */
import type { IncomingMessage } from "node:http";
import { DEFAULT_WORKSPACE_ID } from "@open-gpt-live/core";

/** Header naming the workspace a request acts in (the web app sets it on every call). */
export const WORKSPACE_HEADER = "x-sibyl-workspace";
/** Default JSON body cap; routes that take more (documents, imports) pass their own. */
export const DEFAULT_JSON_BYTES = 64 * 1024;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

/** The request URL, parsed against a placeholder origin (never throws). */
export function requestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? "/", "http://gateway.invalid");
  } catch {
    return new URL("/", "http://gateway.invalid");
  }
}

/** Path part of the request URL (no query). */
export function requestPath(request: IncomingMessage): string {
  return requestUrl(request).pathname;
}

/** One query parameter (undefined when absent). */
export function queryParam(request: IncomingMessage, name: string): string | undefined {
  return requestUrl(request).searchParams.get(name) ?? undefined;
}

/** First value of a request header. */
export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Token from `Authorization: Bearer <token>`, else `?token=` (plain links, like the WebSocket). */
export function bearer(request: IncomingMessage): string | undefined {
  const header = headerValue(request, "authorization");
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (match) return match[1]!.trim();
  return queryParam(request, "token");
}

/** The workspace an HTTP request acts in: the x-sibyl-workspace header, then ?workspaceId=, else default. */
export function requestWorkspace(request: IncomingMessage): string {
  const value = headerValue(request, WORKSPACE_HEADER) || queryParam(request, "workspaceId");
  return value && WORKSPACE_ID.test(value) ? value : DEFAULT_WORKSPACE_ID;
}

// Bodies read before routing (hosted Sibyl: which organization a sign-in or a LiveKit webhook is for), per process.
const PRIMED = Symbol.for("sibyl.http.primedBodies");
const primedRegistry = globalThis as typeof globalThis & { [PRIMED]?: WeakMap<IncomingMessage, Buffer> };
const primed = (primedRegistry[PRIMED] ??= new WeakMap<IncomingMessage, Buffer>());

/**
 * Read the body once before routing; the handler that serves the request
 * then gets the same bytes from readBody()/readJson() instead of the
 * (consumed) stream.
 */
export async function primeBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const known = primed.get(request);
  if (known) return known;
  const raw = await readBody(request, maxBytes);
  primed.set(request, raw);
  return raw;
}

/** Read the whole body, failing fast (BodyTooLargeError) past `maxBytes`. */
export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const known = primed.get(request);
  if (known) {
    if (known.byteLength > maxBytes) throw new BodyTooLargeError();
    return known;
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    throw new BodyTooLargeError();
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        // Keep draining (without buffering) so the 413 reply can still be read.
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    request.once("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

/** A JSON body (an empty body is `{}`). Throws SyntaxError on bad JSON, BodyTooLargeError past the cap. */
export async function readJson(request: IncomingMessage, maxBytes = DEFAULT_JSON_BYTES): Promise<unknown> {
  const raw = await readBody(request, maxBytes);
  return raw.byteLength === 0 ? {} : (JSON.parse(raw.toString("utf8")) as unknown);
}

/** A JSON object body (an empty body is `{}`); anything else is a SyntaxError. */
export async function readJsonObject(request: IncomingMessage, maxBytes = DEFAULT_JSON_BYTES): Promise<Record<string, unknown>> {
  const parsed = await readJson(request, maxBytes);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** The gateway's public origin as the request saw it (OAuth/SSO callbacks when SIBYL_PUBLIC_GATEWAY_URL is unset). */
export function requestOrigin(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || ((request.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host = (request.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || request.headers.host || "localhost:8787";
  return `${proto === "https" ? "https" : "http"}://${host.replace(/[^A-Za-z0-9.:[\]-]/g, "")}`;
}
