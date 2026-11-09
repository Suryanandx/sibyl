/**
 * Small HTTP helpers shared by the gateway's JSON/file endpoints
 * (/api/uploads, /api/memory): owner-token auth identical to the WebSocket
 * login (auth.ts), CORS limited to the configured web origins, JSON replies.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { tokenFromUrl, tokensMatch } from "../auth.js";

export interface HttpGuardOptions {
  /** SIBYL_OWNER_TOKEN; when unset every request is allowed (same as the WebSocket). */
  ownerToken?: string;
  /** ALLOWED_ORIGINS; when empty any origin may call (same as the WebSocket). */
  allowedOrigins?: string[];
}

export const ALLOWED_HEADERS = "authorization, content-type, x-filename, x-sibyl-filename";

/** Token from `Authorization: Bearer <token>` or `?token=` (like the WebSocket). */
export function requestToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1]!.trim();
  }
  return tokenFromUrl(request.url);
}

export function isHttpAuthorized(options: HttpGuardOptions, request: IncomingMessage): boolean {
  if (!options.ownerToken) return true;
  return tokensMatch(options.ownerToken, requestToken(request));
}

/** CORS headers for an allowed origin, or undefined when the origin is not allowed. */
export function corsHeaders(options: HttpGuardOptions, request: IncomingMessage, methods: string): Record<string, string> | undefined {
  const origin = request.headers.origin;
  const allowed = options.allowedOrigins ?? [];
  if (!origin) return {};
  if (allowed.length > 0 && !allowed.includes(origin)) return undefined;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": methods,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "600",
    vary: "Origin"
  };
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(body));
}

/**
 * Common guard: CORS (with preflight) then auth. Returns the CORS headers to
 * add to the real reply, or undefined when a reply has already been sent.
 */
export function guardRequest(
  options: HttpGuardOptions,
  request: IncomingMessage,
  response: ServerResponse,
  methods: string
): Record<string, string> | undefined {
  const cors = corsHeaders(options, request, methods);
  if (!cors) {
    sendJson(response, 403, { error: "origin_not_allowed" });
    request.resume();
    return undefined;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors);
    response.end();
    return undefined;
  }
  if (!isHttpAuthorized(options, request)) {
    sendJson(response, 401, { error: "unauthorized" }, cors);
    request.resume();
    return undefined;
  }
  return cors;
}

export class BodyTooLargeError extends Error {}

/** Read the whole body, failing fast past `maxBytes`. */
export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError("too large");
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
        reject(new BodyTooLargeError("too large"));
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

/** Path part of the request URL (no query). */
export function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  } catch {
    return "/";
  }
}
