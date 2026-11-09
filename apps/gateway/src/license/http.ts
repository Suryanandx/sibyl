/**
 * /api/license — Settings → Licence (owner token + CORS like /api/memory).
 * Owner-only: until identity lands, the owner token is the owner check; the
 * identity work narrows this to owner/admin roles.
 *
 *   GET    /api/license          → LicenseStateView
 *   POST   /api/license {key}    → LicenseStateView (400 with reason if the key is not valid)
 *   DELETE /api/license          → LicenseStateView (stored key removed)
 *
 * The key itself is never returned.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { AUDIT_ACTIONS } from "@open-gpt-live/core";
import { auditRequest, corsGuard, readJsonObject, requestPath, runRoute, sendBodyError, sendJson, type ApiOptions } from "../http/index.js";
import { LicenseError, type LicenseService } from "./service.js";

export interface LicenseHttpOptions extends ApiOptions {
  license: LicenseService;
}

const METHODS = "GET, POST, DELETE, OPTIONS";

export function handleLicenseHttp(options: LicenseHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  if (requestPath(request) !== "/api/license") return false;
  return runRoute(response, options.log, "license.http_failed", serve(options, request, response));
}

async function serve(options: LicenseHttpOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  try {
    if (method === "GET") return reply(200, options.license.state());
    if (method === "POST") {
      const { key } = await readJsonObject(request, 16 * 1024);
      const state = await options.license.setKey(key);
      // The audit sink may only exist after this change (a newly enabled licence); it records from then on.
      auditRequest(options, request, { action: AUDIT_ACTIONS.LICENSE_CHANGED, target: { kind: "license", ...(state.licensee ? { name: state.licensee } : {}) }, details: { change: "set", edition: state.edition, features: state.features } });
      return reply(200, state);
    }
    if (method === "DELETE") {
      const state = await options.license.clearKey();
      auditRequest(options, request, { action: AUDIT_ACTIONS.LICENSE_CHANGED, target: { kind: "license" }, details: { change: "removed", edition: state.edition } });
      return reply(200, state);
    }
    request.resume();
    return reply(405, { error: "method_not_allowed" });
  } catch (error) {
    if (error instanceof LicenseError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
