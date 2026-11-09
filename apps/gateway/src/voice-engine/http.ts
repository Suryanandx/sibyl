/**
 * Voice engine settings (behind the identity gate; permissions in
 * identity/http.ts → protectedRoutePermission):
 *
 *   GET    /api/voice-engine                         → VoiceEngineView   (chat.use)
 *   PUT    /api/voice-engine/key {key}               → VoiceEngineView   (org.settings; checked with OpenAI first)
 *   POST   /api/voice-engine/key/test                → { ok, message }   (org.settings)
 *   DELETE /api/voice-engine/key                     → VoiceEngineView   (org.settings)
 *   PUT    /api/voice-engine/policy {allowRealtime}  → VoiceEngineView   (workspace.settings; the caller's workspace)
 *
 * The key is never returned (only its last four characters).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { auditActor } from "@open-gpt-live/core";
import { corsGuard, readJsonObject, requestCaller, requestPath, requestWorkspace, runRoute, sendBodyError, sendJson, type ApiOptions } from "../http/index.js";
import { VoiceEngineError, type VoiceEngineService } from "./service.js";

export interface VoiceEngineHttpOptions extends ApiOptions {
  voiceEngines: VoiceEngineService;
  /** Sibyl voice's estimated USD per minute (for the comparison in Settings). */
  sibylUsdPerMinute: () => number | undefined;
}

const METHODS = "GET, PUT, POST, DELETE, OPTIONS";

export function isVoiceEnginePath(path: string): boolean {
  return path === "/api/voice-engine" || path === "/api/voice-engine/key" || path === "/api/voice-engine/key/test" || path === "/api/voice-engine/policy";
}

export function handleVoiceEngineHttp(options: VoiceEngineHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isVoiceEnginePath(path)) return false;
  return runRoute(response, options.log, "voice_engine.http_failed", serve(options, request, response, path));
}

async function serve(options: VoiceEngineHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const engines = options.voiceEngines;
  const workspaceId = requestWorkspace(request);
  const view = () => engines.view(workspaceId, options.sibylUsdPerMinute());
  try {
    if (path === "/api/voice-engine" && method === "GET") {
      request.resume();
      return reply(200, await view());
    }
    if (path === "/api/voice-engine/key" && method === "PUT") {
      const { key } = await readJsonObject(request, 8 * 1024);
      await engines.saveKey(key, auditActor(requestCaller(request)?.principal));
      return reply(200, await view());
    }
    if (path === "/api/voice-engine/key" && method === "DELETE") {
      request.resume();
      await engines.removeKey(auditActor(requestCaller(request)?.principal));
      return reply(200, await view());
    }
    if (path === "/api/voice-engine/key/test" && method === "POST") {
      request.resume();
      return reply(200, await engines.testKey());
    }
    if (path === "/api/voice-engine/policy" && method === "PUT") {
      const { allowRealtime } = await readJsonObject(request, 1024);
      await engines.setPolicy(workspaceId, allowRealtime);
      return reply(200, await view());
    }
    request.resume();
    return reply(405, { error: "method_not_allowed" });
  } catch (error) {
    if (error instanceof VoiceEngineError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
