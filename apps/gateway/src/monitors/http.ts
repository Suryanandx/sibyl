/**
 * HTTP routes for monitors (listed in @open-gpt-live/protocol, "Monitors").
 *
 * - /api/monitors/hooks/:id: webhook deliveries. No sign-in; the body must be
 *   signed (HMAC-SHA256 with the monitor's secret, `x-sibyl-signature`).
 * - Everything else runs behind the gateway's `gateProtectedRoute()` (who is
 *   calling, monitors.use / monitors.manage in the workspace); the handler
 *   then uses that caller for the per-monitor checks (creator, admin).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseMonitorEventsQuery, parseMonitorInput, parseMonitorPause } from "@open-gpt-live/protocol";
import type { Principal } from "@open-gpt-live/core";
import {
  BodyTooLargeError,
  corsGuard,
  headerValue,
  isUnder,
  readBody,
  readJson,
  requestPath,
  requestUrl,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendJson,
  type ApiOptions
} from "../http/index.js";
import { HOOK_PATH_PREFIX } from "./records.js";
import { MonitorError, WEBHOOK_MAX_BYTES, type MonitorService } from "./service.js";

const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface MonitorsHttpOptions extends ApiOptions {
  monitors: MonitorService | undefined;
  /** Who is calling (the gateway passes the caller its identity gate bound to the request). */
  authenticate(request: IncomingMessage): Promise<{ principal: Principal } | undefined>;
}

export function isMonitorsPath(path: string): boolean {
  return isUnder(path, "/api/monitors");
}

export function isMonitorHookPath(path: string): boolean {
  return path.startsWith(HOOK_PATH_PREFIX);
}

/** Returns true when the request is a monitors route (and is being handled). */
export function handleMonitorsHttp(options: MonitorsHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isMonitorsPath(path)) return false;
  return runRoute(response, options.log, "monitors.http_failed", route(options, request, response, path));
}

async function route(options: MonitorsHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const method = request.method ?? "GET";
  const service = options.monitors;

  if (isMonitorHookPath(path)) {
    // Server-to-server: no CORS, no cookies.
    if (method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });
    const id = decodeSegment(path.slice(HOOK_PATH_PREFIX.length));
    if (!service || !id) {
      request.resume();
      return sendJson(response, 404, { error: "not_found" });
    }
    let body: Buffer;
    try {
      body = await readBody(request, WEBHOOK_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return sendJson(response, 413, { error: "too_large" });
      throw error;
    }
    const result = await service.receiveWebhook(id, body, headerValue(request, "x-sibyl-signature"));
    return sendJson(response, result.status, result.body);
  }

  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  if (!service) {
    request.resume();
    return reply(503, { error: "unavailable", message: "Monitors are not available on this gateway." });
  }
  const auth = await options.authenticate(request);
  if (!auth) {
    request.resume();
    return reply(401, { error: "unauthorized", message: "Sign in to continue." });
  }
  const caller = { principal: auth.principal, workspaceId: requestWorkspace(request) };
  const parts = path.split("/").slice(3).map(decodeSegment); // ["", "api", "monitors", ...]
  const url = requestUrl(request);

  try {
    // /api/monitors
    if (parts.length === 0) {
      if (method === "GET") return reply(200, await service.list(caller));
      if (method === "POST") {
        const input = parseMonitorInput(await readJson(request));
        if (!input.success) return reply(400, { error: "bad_request", message: input.error });
        return reply(201, await service.create(caller, input.data));
      }
      return reply(405, { error: "method_not_allowed" });
    }
    const [first, second] = parts;
    if (parts.length === 1 && first === "events" && method === "GET") {
      const query = parseMonitorEventsQuery(url.searchParams);
      if (!query.success) return reply(400, { error: "bad_request", message: query.error });
      return reply(200, { events: await service.events(caller, query.data) });
    }
    if (parts.length === 1 && first === "status" && method === "GET") {
      return reply(200, { statuses: await service.statuses(caller) });
    }
    if (parts.length === 1 && first === "test" && method === "POST") {
      const input = parseMonitorInput(await readJson(request));
      if (!input.success) return reply(400, { error: "bad_request", message: input.error });
      return reply(200, await service.test(caller, { input: input.data }));
    }
    if (!first || !ID.test(first)) return reply(404, { error: "not_found" });
    if (parts.length === 1) {
      if (method === "PATCH") {
        const input = parseMonitorInput(await readJson(request));
        if (!input.success) return reply(400, { error: "bad_request", message: input.error });
        return reply(200, await service.update(caller, first, input.data));
      }
      if (method === "DELETE") {
        request.resume();
        await service.remove(caller, first);
        return reply(200, { ok: true });
      }
      return reply(405, { error: "method_not_allowed" });
    }
    if (parts.length === 2 && method === "POST") {
      if (second === "pause") {
        const body = parseMonitorPause(await readJson(request));
        if (!body.success) return reply(400, { error: "bad_request", message: body.error });
        return reply(200, { monitor: await service.pause(caller, first, body.data.paused) });
      }
      if (second === "run") {
        request.resume();
        await service.runNow(caller, first);
        return reply(202, { ok: true });
      }
      if (second === "test") {
        request.resume();
        return reply(200, await service.test(caller, { id: first }));
      }
    }
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof MonitorError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}
