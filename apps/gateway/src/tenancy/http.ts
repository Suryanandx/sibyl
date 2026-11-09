/**
 * An organization's model access and AI credits (behind the identity gate;
 * permissions in identity/http.ts → protectedRoutePermission):
 *
 *   GET    /api/model-access[?refresh=1]  → ModelAccessView        (chat.use)
 *   PUT    /api/model-access/key {key}    → ModelAccessView        (org.settings; checked with OpenRouter first; 400 invalid_key)
 *   DELETE /api/model-access/key          → ModelAccessView        (org.settings)
 *   GET    /api/credits                   → CreditsView            (usage.view; hosted only)
 *   POST   /api/credits/purchase {amountUsd} → { status, balanceUsd } (org.billing; needs a payment provider)
 *
 * Saving or removing the key rebuilds the organization's runtime for the
 * new key (open connections reconnect). The key is never returned.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { auditActor } from "@open-gpt-live/core";
import { corsGuard, queryParam, readJsonObject, requestCaller, requestPath, runRoute, sendBodyError, sendJson, type ApiOptions } from "../http/index.js";
import type { GatewayRuntime } from "../runtime.js";
import { CreditsError } from "./credits.js";
import { ModelAccessError } from "./model-access.js";

export interface TenancyHttpOptions extends ApiOptions {
  runtime: Pick<GatewayRuntime, "modelAccess" | "credits">;
}

const METHODS = "GET, PUT, POST, DELETE, OPTIONS";

export function isTenancyPath(path: string): boolean {
  return path === "/api/model-access" || path === "/api/model-access/key" || path === "/api/credits" || path === "/api/credits/purchase";
}

export function handleTenancyHttp(options: TenancyHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isTenancyPath(path)) return false;
  return runRoute(response, options.log, "tenancy.http_failed", serve(options, request, response, path));
}

async function serve(options: TenancyHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const actor = auditActor(requestCaller(request)?.principal);
  try {
    if (path === "/api/model-access" || path === "/api/model-access/key") {
      const access = options.runtime.modelAccess;
      if (!access) {
        request.resume();
        return reply(404, { error: "not_found" });
      }
      if (path === "/api/model-access" && method === "GET") {
        request.resume();
        return reply(200, await access.status({ refresh: queryParam(request, "refresh") === "1" }));
      }
      if (path === "/api/model-access/key" && method === "PUT") {
        const { key } = await readJsonObject(request, 8 * 1024);
        return reply(200, await access.save(key, actor));
      }
      if (path === "/api/model-access/key" && method === "DELETE") {
        request.resume();
        await access.remove(actor);
        // The organization's runtime is rebuilt for the server's key or credits.
        const { key: _removed, ...rest } = await access.status();
        return reply(200, { ...rest, mode: rest.hosted ? "credits" : "server" });
      }
    }
    const credits = options.runtime.credits;
    if (path === "/api/credits" && method === "GET") {
      request.resume();
      if (!credits) return reply(404, { error: "not_found", message: "AI credits are part of hosted Sibyl." });
      return reply(200, await credits.view());
    }
    if (path === "/api/credits/purchase" && method === "POST") {
      if (!credits) {
        request.resume();
        return reply(404, { error: "not_found", message: "AI credits are part of hosted Sibyl." });
      }
      const { amountUsd } = await readJsonObject(request, 4 * 1024);
      return reply(200, await credits.purchase(typeof amountUsd === "number" ? amountUsd : Number.NaN, actor.userId ?? actor.kind));
    }
    request.resume();
    return reply(405, { error: "method_not_allowed" });
  } catch (error) {
    if (error instanceof ModelAccessError || error instanceof CreditsError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
