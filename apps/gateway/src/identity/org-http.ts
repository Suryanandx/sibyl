/**
 * Admin → Organization and Admin → Users over HTTP. Runs behind the
 * gateway's gateProtectedRoute() (route map in http.ts: /api/admin/* needs
 * org.settings); the OrgAdmin service checks the finer rules.
 *
 *   GET    /api/admin/org                  → OrgView
 *   PATCH  /api/admin/org                  { name?, defaultWorkspaceId?, defaultRole? } → OrgView
 *   GET    /api/admin/users                → OrgUsersResponse
 *   PATCH  /api/admin/users/:id            { orgRole?, active? } → { user }
 *   DELETE /api/admin/users/:id            → { ok }
 *   POST   /api/admin/invites/:id/resend   → { invite, url, emailed }
 *   DELETE /api/admin/invites/:id          → { ok }
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OrgUsersResponse } from "@open-gpt-live/protocol";
import { corsGuard, readJsonObject, requestCaller, requestPath, runRoute, sendBodyError, sendJson, type ApiOptions } from "../http/index.js";
import { webAppUrl } from "./http.js";
import type { OrgAdmin } from "./org.js";
import { IdentityError, type IdentityService } from "./service.js";

export interface OrgAdminHttpOptions extends ApiOptions {
  org: OrgAdmin;
  identity: IdentityService;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

/** The paths this handler owns. */
export function isOrgAdminPath(path: string): boolean {
  return path === "/api/admin/org" || path === "/api/admin/users" || path.startsWith("/api/admin/users/") || path.startsWith("/api/admin/invites/");
}

export function handleOrgAdminHttp(options: OrgAdminHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isOrgAdminPath(path)) return false;
  return runRoute(response, options.log, "org_admin.http_failed", serve(options, request, response, path));
}

async function serve(options: OrgAdminHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const caller = requestCaller(request);
  if (!caller) {
    request.resume();
    return reply(401, { error: "unauthorized", message: "Sign in to continue." });
  }
  const { principal } = caller;
  const [, , area, id, action] = path.split("/").filter(Boolean) as [string, string, string, string | undefined, string | undefined];
  try {
    if (area === "org" && !id) {
      if (method === "GET") {
        request.resume();
        return reply(200, await options.org.view(principal));
      }
      if (method === "PATCH") return reply(200, await options.org.update(principal, await readJsonObject(request, 16 * 1024)));
    }
    if (area === "users" && !id && method === "GET") {
      request.resume();
      const body: OrgUsersResponse = { users: await options.org.listUsers(principal), invites: await options.identity.listAllInvites(principal) };
      return reply(200, body);
    }
    if (area === "users" && id && ID.test(id) && !action) {
      if (method === "PATCH") {
        const input = await readJsonObject(request, 4 * 1024);
        return reply(200, { user: await options.org.updateUser(principal, id, { orgRole: input.orgRole, active: input.active }) });
      }
      if (method === "DELETE") {
        request.resume();
        await options.org.removeUser(principal, id);
        return reply(200, { ok: true });
      }
    }
    if (area === "invites" && id && ID.test(id)) {
      if (action === "resend" && method === "POST") {
        request.resume();
        return reply(200, await options.identity.resendInvite(principal, id, webAppUrl({ identity: options.identity, allowedOrigins: [...(options.allowedOrigins ?? [])] }, request)));
      }
      if (!action && method === "DELETE") {
        request.resume();
        await options.identity.revokeInvite(principal, id);
        return reply(200, { ok: true });
      }
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    request.resume();
    if (error instanceof IdentityError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
