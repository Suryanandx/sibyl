/**
 * /api/plugins — the Plugins screen's API, behind gateProtectedRoute():
 *
 *   GET    /api/plugins                         skills.use      → { installed, catalog, stdioAllowed }
 *   GET    /api/plugins/:id                     skills.use      → { plugin }
 *   POST   /api/plugins/preview  {source}       plugins.install → { summary }
 *   POST   /api/plugins/install  {source, scope} plugins.install → { plugin }
 *   PATCH  /api/plugins/:id      {enabled}      plugins.install → { plugin }
 *   DELETE /api/plugins/:id                     plugins.install → { ok, keptKnowledgeBases }
 *   POST   /api/plugins/:id/secrets {name, value, allowedHosts?} plugins.install → { plugin }
 *   POST   /api/plugins/:id/recheck             plugins.install → { plugin }
 *   POST   /api/plugins/:id/routines {index}    routines.manage → { plugin }
 *
 * A secret value arrives once in the POST body, goes straight into the
 * vault, and is never echoed, logged or returned.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parsePluginInstallInput } from "@open-gpt-live/protocol";
import { corsGuard, isUnder, readJsonObject, requestCaller, requestPath, requestWorkspace, runRoute, sendBodyError, sendJson, type ApiOptions } from "../http/index.js";
import { creatorId } from "../agents/access.js";
import { KnowledgeError } from "../knowledge/service.js";
import { SkillError } from "../skills/service.js";
import { ManifestError, summarize } from "./manifest.js";
import { PluginError, type PluginService } from "./service.js";

export interface PluginsHttpOptions extends ApiOptions {
  plugins: PluginService;
}

const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ID = /^[a-z0-9-]{1,64}$/;

export function isPluginsPath(path: string): boolean {
  return isUnder(path, "/api/plugins");
}

export function handlePluginsHttp(options: PluginsHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isPluginsPath(path)) return false;
  return runRoute(response, options.log, "plugins.http_failed", serve(options, request, response, path));
}

async function serve(options: PluginsHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const workspaceId = requestWorkspace(request);
  const { plugins } = options;
  const parts = path.slice("/api/plugins".length).split("/").filter(Boolean).map(decodeURIComponent);
  const body = () => readJsonObject(request, 64 * 1024);

  try {
    if (parts.length === 0 && method === "GET") {
      request.resume();
      return reply(200, { ...(await plugins.list(workspaceId)), stdioAllowed: plugins.stdioAllowed });
    }
    const [first, second] = parts;
    if (parts.length === 1 && (first === "preview" || first === "install") && method === "POST") {
      const parsed = parsePluginInstallInput(await body());
      if (!parsed.success) return reply(400, { error: "invalid", message: parsed.error });
      if (first === "preview") {
        const { manifest } = await plugins.preview(parsed.data.source);
        return reply(200, { summary: summarize(manifest), stdioAllowed: plugins.stdioAllowed });
      }
      return reply(201, { plugin: await plugins.install(workspaceId, parsed.data) });
    }
    if (!first || !ID.test(first)) {
      request.resume();
      return reply(404, { error: "not_found" });
    }
    if (parts.length === 1) {
      if (method === "GET") {
        request.resume();
        return reply(200, { plugin: await plugins.get(workspaceId, first) });
      }
      if (method === "PATCH") {
        const input = await body();
        if (typeof input.enabled !== "boolean") return reply(400, { error: "invalid", message: "enabled must be a boolean" });
        return reply(200, { plugin: await plugins.setEnabled(workspaceId, first, input.enabled) });
      }
      if (method === "DELETE") {
        request.resume();
        return reply(200, { ok: true, ...(await plugins.uninstall(workspaceId, first)) });
      }
    }
    if (parts.length === 2 && method === "POST") {
      if (second === "secrets") {
        const input = await body();
        return reply(200, { plugin: await plugins.provideSecret(workspaceId, first, { name: input.name, value: input.value, allowedHosts: input.allowedHosts }) });
      }
      if (second === "recheck") {
        request.resume();
        return reply(200, { plugin: await plugins.recheck(workspaceId, first) });
      }
      if (second === "routines") {
        const input = await body();
        if (typeof input.index !== "number" || !Number.isInteger(input.index) || input.index < 0) return reply(400, { error: "invalid", message: "index must be a template index" });
        // The routine runs as the person who added it.
        const caller = requestCaller(request);
        if (!caller) return reply(401, { error: "unauthorized", message: "Sign in to continue." });
        return reply(201, { plugin: await plugins.addRoutine(workspaceId, first, input.index, creatorId(caller.principal)) });
      }
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof PluginError || error instanceof SkillError || error instanceof KnowledgeError) {
      return reply(error.status, { error: error.code, message: error.message });
    }
    if (error instanceof ManifestError) return reply(422, { error: "invalid_manifest", message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
