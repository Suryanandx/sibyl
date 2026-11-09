/**
 * CORS for every gateway API, one rule: a browser page may call (with the
 * session cookie) when its origin is in ALLOWED_ORIGINS, or — when that list
 * is empty (local dev) — when it is on the gateway's own host name (any
 * port). Requests without an Origin (curl, server-to-server) need no CORS.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { WORKSPACE_HEADER } from "./request.js";
import { sendError, type HeaderMap } from "./response.js";

export const DEFAULT_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
export const ALLOWED_HEADERS = `authorization, content-type, ${WORKSPACE_HEADER}, x-sibyl-org, x-filename, x-sibyl-filename`;

/** Is a browser page at `origin` allowed to call here (and use the session cookie)? */
export function originAllowed(origin: string | undefined, request: IncomingMessage, allowedOrigins: readonly string[] = []): boolean {
  if (!origin) return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  try {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
    const from = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return Boolean(host) && host === from;
  } catch {
    return false;
  }
}

/** Credentialed CORS headers for an allowed origin ({} without an Origin); undefined when not allowed. */
export function corsHeaders(request: IncomingMessage, allowedOrigins: readonly string[] = [], methods = DEFAULT_METHODS): HeaderMap | undefined {
  const origin = request.headers.origin;
  if (!origin) return {};
  if (!originAllowed(origin, request, allowedOrigins)) return undefined;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": methods,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-expose-headers": "content-disposition",
    "access-control-max-age": "600",
    vary: "Origin"
  };
}

/**
 * First step of every API handler: refuse a foreign origin (403) and answer
 * a preflight (204). Returns the CORS headers to add to the real reply, or
 * undefined when a reply was already sent.
 */
export function corsGuard(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[] = [],
  methods = DEFAULT_METHODS
): HeaderMap | undefined {
  const cors = corsHeaders(request, allowedOrigins, methods);
  if (!cors) {
    request.resume();
    sendError(response, 403, "origin_not_allowed");
    return undefined;
  }
  if (request.method === "OPTIONS") {
    request.resume();
    response.writeHead(204, cors);
    response.end();
    return undefined;
  }
  return cors;
}
