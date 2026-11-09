/**
 * Shared HTTP frame for the Enterprise admin APIs (/api/admin/*) — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * The gateway's identity gate runs first (the route map in
 * apps/gateway/src/identity/http.ts says which permission each prefix needs:
 * org.settings for roles, policies and second approvals, audit.view for the
 * audit log) and binds the caller to the request. Handlers here read that
 * caller, reuse the gateway's CORS, body and reply helpers, and answer
 * AdminError as a JSON error.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { auditActor, type AuditActor, type HttpRouteHandler, type Principal } from "../../packages/core/src/index";
import {
  corsGuard,
  isUnder,
  readJsonObject,
  requestCaller,
  requestPath,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendJson,
  type HeaderMap,
  type LogFn
} from "../../apps/gateway/src/http/index";

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export const badRequest = (message: string) => new AdminError(400, "bad_request", message);
export const notFound = (message = "Not found.") => new AdminError(404, "not_found", message);

export interface AdminRequest {
  request: IncomingMessage;
  response: ServerResponse;
  method: string;
  /** Path segments after the prefix (decoded). */
  segments: string[];
  url: URL;
  principal: Principal;
  actor: AuditActor;
  workspaceId: string;
  cors: HeaderMap;
  reply(status: number, body: unknown): void;
  body(maxBytes?: number): Promise<Record<string, unknown>>;
}

/**
 * An HttpRouteHandler for everything under `prefix`. `handle` returns false
 * for an unknown sub-path (answered 404).
 */
export function adminRoute(prefix: string, log: LogFn, handle: (req: AdminRequest) => Promise<boolean | void>): HttpRouteHandler {
  return (request, response, api) => {
    const path = requestPath(request);
    if (!isUnder(path, prefix)) return false;
    return runRoute(response, log, "enterprise.http_failed", serve(prefix, path, request, response, api?.allowedOrigins ?? [], handle));
  };
}

async function serve(
  prefix: string,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
  handle: (req: AdminRequest) => Promise<boolean | void>
): Promise<void> {
  const cors = corsGuard(request, response, allowedOrigins);
  if (!cors) return;
  const caller = requestCaller(request);
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  if (!caller) {
    // Only reachable behind the identity gate; refuse anything that skipped it.
    request.resume();
    return reply(401, { error: "unauthorized", message: "Sign in to continue." });
  }
  const url = new URL(request.url ?? "/", "http://gateway");
  const segments = path.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
  try {
    const handled = await handle({
      request,
      response,
      method: request.method ?? "GET",
      segments,
      url,
      principal: caller.principal,
      actor: auditActor(caller.principal),
      workspaceId: requestWorkspace(request),
      cors,
      reply,
      body: (maxBytes = 64 * 1024) => readJsonObject(request, maxBytes)
    });
    if (handled === false) {
      request.resume();
      reply(404, { error: "not_found" });
    }
  } catch (error) {
    request.resume();
    if (error instanceof AdminError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}

/* ───────────── small validators ───────────── */

export function text(value: unknown, label: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw badRequest(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw badRequest(`${label} must be text.`);
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (required && !trimmed) throw badRequest(`${label} is required.`);
  if (trimmed.length > max) throw badRequest(`${label} is longer than ${max} characters.`);
  return trimmed || undefined;
}

export function stringList(value: unknown, label: string, max: number, pattern?: RegExp): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${label} must be a list.`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) throw badRequest(`${label} must contain text.`);
    const trimmed = item.trim();
    if (pattern && !pattern.test(trimmed)) throw badRequest(`${label}: "${trimmed.slice(0, 80)}" is not valid.`);
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  if (out.length > max) throw badRequest(`${label} can have at most ${max} entries.`);
  return out;
}
