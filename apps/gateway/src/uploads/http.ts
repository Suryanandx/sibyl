/**
 * /api/uploads on the gateway's HTTP server.
 *
 *   POST /api/uploads      multipart/form-data (first file part), or the raw
 *                          bytes with the name in `X-Filename` (URL-encoded)
 *                          or `?name=` → 201 { upload }
 *   GET  /api/uploads/:id  the file's bytes (only from the workspace it was uploaded in)
 *
 * Runs behind the gateway's identity gate (chat.use in the request's
 * workspace) with the shared CORS rule; size is capped by SIBYL_UPLOAD_MAX_MB.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { AUDIT_ACTIONS } from "@open-gpt-live/core";
import {
  BodyTooLargeError,
  auditRequest,
  corsGuard,
  headerValue,
  isUnder,
  queryParam,
  readBody,
  requestPath,
  requestWorkspace,
  runRoute,
  sendJson,
  type ApiOptions
} from "../http/index.js";
import { boundaryOf, parseMultipartFile } from "./multipart.js";
import { UploadError, type UploadService } from "./service.js";

export interface UploadsHttpOptions extends ApiOptions {
  uploads: UploadService;
}

const METHODS = "GET, POST, OPTIONS";
/** Room for multipart boundaries and headers on top of the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;

/** Returns true when the request was for /api/uploads (and is being handled). */
export function handleUploadsHttp(options: UploadsHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isUnder(path, "/api/uploads")) return false;
  return runRoute(response, options.log, "uploads.http_failed", serve(options, request, response, path));
}

async function serve(options: UploadsHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const { uploads } = options;
  const workspaceId = requestWorkspace(request);
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);

  if (path === "/api/uploads" && request.method === "POST") {
    try {
      const contentType = request.headers["content-type"];
      const boundary = boundaryOf(contentType);
      const body = await readBody(request, uploads.maxBytes + (boundary ? MULTIPART_OVERHEAD : 0));
      let data = body;
      let filename = headerFileName(request) ?? queryParam(request, "name");
      if (boundary) {
        const part = parseMultipartFile(body, boundary);
        if (!part) return reply(400, { error: "no_file", message: "No file in the form data." });
        data = part.data;
        filename = part.filename || filename;
      }
      if (!filename) return reply(400, { error: "no_filename", message: "Send the file name in X-Filename." });
      const conversationId = queryParam(request, "conversationId");
      const upload = await uploads.save({ data, filename, workspaceId, ...(conversationId ? { conversationId: conversationId.slice(0, 128) } : {}) });
      return reply(201, { upload });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return reply(413, { error: "too_large", message: `The file is larger than ${Math.round(uploads.maxBytes / 1024 / 1024)} MB.` });
      }
      if (error instanceof UploadError) return reply(error.status, { error: error.code, message: error.message });
      throw error;
    }
  }

  const match = /^\/api\/uploads\/([^/]+)$/.exec(path);
  if (match && (request.method === "GET" || request.method === "HEAD")) {
    request.resume();
    const id = decodeURIComponent(match[1]!);
    const upload = await uploads.get(id, { workspaceId });
    if (!upload) return reply(404, { error: "not_found" });
    const bytes = await uploads.readBytes(upload.id);
    // Previews open inline (images, PDFs, generated video and audio); `?download=1` asks for a download.
    const inline = queryParam(request, "download") !== "1" && (upload.kind === "image" || upload.kind === "pdf" || upload.kind === "video" || upload.kind === "audio");
    // Downloads (not inline previews) go to the audit log.
    if (!inline && request.method === "GET") {
      auditRequest(options, request, { action: AUDIT_ACTIONS.EXPORT, target: { kind: "upload", id: upload.id, name: upload.name }, details: { bytes: bytes.byteLength } });
    }
    response.writeHead(200, {
      ...cors,
      "content-type": upload.mime,
      "content-length": String(bytes.byteLength),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "cross-origin"
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
    return;
  }

  request.resume();
  return reply(404, { error: "not_found" });
}

function headerFileName(request: IncomingMessage): string | undefined {
  const value = headerValue(request, "x-filename") ?? headerValue(request, "x-sibyl-filename");
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
