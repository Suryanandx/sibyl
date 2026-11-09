/**
 * Onboarding routes (behind the identity gate: chat.use; see
 * identity/http.ts → protectedRoutePermission):
 *
 *   GET   /api/onboarding                          → OnboardingView
 *   PATCH /api/onboarding  OnboardingPatch         → OnboardingView
 *   PUT   /api/onboarding/profile {name?,avatar?}  → OnboardingView (people with an account)
 *
 * Every answer is for the caller in the request's workspace.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OnboardingPatch } from "@open-gpt-live/protocol";
import { corsGuard, readJsonObject, requestCaller, requestPath, requestWorkspace, runRoute, sendBodyError, sendJson, type ApiOptions } from "../http/index.js";
import { IdentityError } from "../identity/service.js";
import type { OnboardingService } from "./service.js";

export interface OnboardingHttpOptions extends ApiOptions {
  onboarding: OnboardingService;
}

const METHODS = "GET, PATCH, PUT, OPTIONS";

export function isOnboardingPath(path: string): boolean {
  return path === "/api/onboarding" || path === "/api/onboarding/profile";
}

export function handleOnboardingHttp(options: OnboardingHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isOnboardingPath(path)) return false;
  return runRoute(response, options.log, "onboarding.http_failed", serve(options, request, response, path));
}

async function serve(options: OnboardingHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const caller = requestCaller(request);
  if (!caller) {
    request.resume();
    return reply(401, { error: "unauthorized", message: "Sign in to continue." });
  }
  const workspaceId = requestWorkspace(request);
  const method = request.method ?? "GET";
  try {
    if (path === "/api/onboarding" && method === "GET") {
      request.resume();
      return reply(200, await options.onboarding.view(caller.principal, workspaceId));
    }
    if (path === "/api/onboarding" && method === "PATCH") {
      const patch = (await readJsonObject(request, 4 * 1024)) as OnboardingPatch;
      return reply(200, await options.onboarding.update(caller.principal, workspaceId, patch));
    }
    if (path === "/api/onboarding/profile" && method === "PUT") {
      const input = await readJsonObject(request, 16 * 1024);
      return reply(200, await options.onboarding.setProfile(caller.principal, workspaceId, { name: input.name, avatar: input.avatar }));
    }
    request.resume();
    return reply(405, { error: "method_not_allowed" });
  } catch (error) {
    request.resume();
    if (error instanceof IdentityError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
