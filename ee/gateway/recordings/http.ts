/**
 * Call recordings — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * /api/recordings — runs behind the gateway's identity gate (calls.record,
 * route map in apps/gateway/src/identity/http.ts), so the caller is known.
 *
 *   GET    /api/recordings              → { items, retentionDays }
 *   POST   /api/recordings {room}       → recording (starts it)
 *   POST   /api/recordings/:id/stop     → recording
 *   GET    /api/recordings/:id/file     → audio/ogg (local) or 302 to a presigned link (S3)
 *   DELETE /api/recordings/:id          → { ok }
 */
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  corsGuard,
  isUnder,
  readJsonObject,
  requestCaller,
  requestPath,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendError,
  sendJson
} from "../../../apps/gateway/src/http/index";
import { RecordingError, type RecordingService } from "./service";

const METHODS = "GET, POST, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function recordingsRoute(service: RecordingService, allowedOrigins: readonly string[], log: (event: string, fields?: Record<string, unknown>) => void) {
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const path = requestPath(request);
    if (!isUnder(path, "/api/recordings")) return false;
    return runRoute(response, log, "recordings.http_failed", serve(service, allowedOrigins, request, response, path));
  };
}

async function serve(service: RecordingService, allowedOrigins: readonly string[], request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, allowedOrigins, METHODS);
  if (!cors) return;
  const principal = requestCaller(request)?.principal;
  // Only reached through the gate; refuse anything that slipped past it.
  if (!principal) return sendError(response, 401, "unauthorized", "Sign in to continue.", cors);
  const workspaceId = requestWorkspace(request);
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const parts = path.slice("/api/recordings".length).replace(/^\//, "").split("/").filter(Boolean);
  try {
    if (parts.length === 0 && method === "GET") return reply(200, { items: await service.list(workspaceId), retentionDays: service.retentionDays });
    if (parts.length === 0 && method === "POST") {
      const input = await readJsonObject(request, 4 * 1024);
      if (typeof input.room !== "string" || input.room.length > 300) return reply(400, { error: "bad_request", message: "room is required." });
      return reply(201, await service.start(principal, workspaceId, input.room));
    }
    const id = parts[0];
    if (!id || !ID.test(id)) return reply(404, { error: "not_found" });
    if (parts.length === 2 && parts[1] === "stop" && method === "POST") return reply(200, await service.stop(workspaceId, id));
    if (parts.length === 2 && parts[1] === "file" && method === "GET") {
      const file = await service.file(workspaceId, id);
      if ("url" in file) {
        response.writeHead(302, { ...cors, location: file.url, "cache-control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(200, {
        ...cors,
        "content-type": "audio/ogg",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="sibyl-recording-${id}.ogg"`,
        "cache-control": "no-store"
      });
      createReadStream(file.path).pipe(response);
      return;
    }
    if (parts.length === 1 && method === "DELETE") {
      return (await service.remove(workspaceId, id)) ? reply(200, { ok: true }) : reply(404, { error: "not_found" });
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (sendBodyError(response, error, cors)) return;
    if (error instanceof RecordingError) return reply(error.status, { error: "recordings", message: error.message });
    throw error;
  }
}
