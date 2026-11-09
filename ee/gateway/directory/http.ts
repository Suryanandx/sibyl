/**
 * /api/directory — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 *   GET /api/directory → DirectorySettingsView
 *   PUT /api/directory {defaultWorkspaceId?, defaultRole?, jitProvisioning?, groupRoles?}
 *
 * Organization owners and admins only (org.settings). Shared by SSO and SCIM.
 */
import type { HttpRouteHandler } from "../../../packages/core/src/index";
import { requestPath } from "../../../apps/gateway/src/http/index";
import { adminRoute, type IdentityContext } from "./context";

export function registerDirectoryRoutes(context: IdentityContext, register: (handler: HttpRouteHandler) => void): void {
  if (context.registered.has("directory")) return;
  context.registered.add("directory");
  register((request, response) => {
    if (requestPath(request) !== "/api/directory") return false;
    return adminRoute(context, request, response, "directory.http_failed", async ({ reply, body }) => {
      if (request.method === "GET") {
        request.resume();
        return reply(200, await context.directory.settingsView());
      }
      if (request.method === "PUT") return reply(200, await context.directory.updateSettings(await body()));
      request.resume();
      reply(405, { error: "method_not_allowed" });
    });
  });
}
