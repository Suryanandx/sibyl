/**
 * Call recordings — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * /api/recordings — runs behind the gateway's identity gate (calls.record,
 * route map in apps/gateway/src/identity/http.ts), so the caller is known.
 *
 *   GET    /api/recordings?q=&kind=&type=&status=&held= → { items, retentionDays }
 *   POST   /api/recordings {room, video?}  → recording (starts it; video: MP4 of the active speaker)
 *   POST   /api/recordings/:id/stop        → recording
 *   PATCH  /api/recordings/:id {legalHold} → recording
 *   GET    /api/recordings/:id/file[?inline=1] → audio/ogg or video/mp4 (local) or 302 to a presigned link (S3)
 *   DELETE /api/recordings/:id             → { ok }
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
  queryParam,
  sendError,
  sendJson
} from "../../../apps/gateway/src/http/index";
import { RecordingError, type RecordingService } from "./service";

const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
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
    if (parts.length === 0 && method === "GET") {
      const kind = queryParam(request, "kind");
      const type = queryParam(request, "type");
      const status = queryParam(request, "status");
      const held = queryParam(request, "held");
      const items = await service.list(workspaceId, {
        q: (queryParam(request, "q") ?? "").slice(0, 200),
        ...(kind === "call" || kind === "phone" ? { kind } : {}),
        ...(type === "audio" || type === "video" ? { type } : {}),
        ...(status === "recording" || status === "ready" || status === "failed" ? { status } : {}),
        ...(held === "1" || held === "0" ? { held: held === "1" } : {})
      });
      return reply(200, { items, retentionDays: service.retentionDays });
    }
    if (parts.length === 0 && method === "POST") {
      const input = await readJsonObject(request, 4 * 1024);
      if (typeof input.room !== "string" || input.room.length > 300) return reply(400, { error: "bad_request", message: "room is required." });
      return reply(201, await service.start(principal, workspaceId, input.room, { video: input.video === true }));
    }
    const id = parts[0];
    if (!id || !ID.test(id)) return reply(404, { error: "not_found" });
    if (parts.length === 2 && parts[1] === "stop" && method === "POST") return reply(200, await service.stop(workspaceId, id));
    if (parts.length === 1 && method === "PATCH") {
      const input = await readJsonObject(request, 1024);
      if (typeof input.legalHold !== "boolean") return reply(400, { error: "bad_request", message: "legalHold must be true or false." });
      return reply(200, await service.setLegalHold(workspaceId, id, input.legalHold));
    }
    if (parts.length === 2 && parts[1] === "file" && method === "GET") {
      const file = await service.file(workspaceId, id);
      const inline = queryParam(request, "inline") === "1";
      if ("url" in file) {
        response.writeHead(302, { ...cors, location: file.url, "cache-control": "no-store" });
        response.end();
        return;
      }
      const video = file.type === "video";
      response.writeHead(200, {
        ...cors,
        "content-type": video ? "video/mp4" : "audio/ogg",
        "content-length": String(file.size),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="sibyl-recording-${id}.${video ? "mp4" : "ogg"}"`,
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
