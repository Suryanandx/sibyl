/**
 * /api/media — the Media page, the composer's settings popover and the chat
 * cards. Behind the identity gate (identity/http.ts): chat.use in the
 * request's workspace for everything; deleting someone else's item also
 * needs chat.view_all.
 *
 *   GET    /api/media/models                    → MediaModelsResponse (from OpenRouter)
 *   POST   /api/media/estimate  {kind, model?, settings?, references?, prompt?} → { usd, detail, model, needsApproval }
 *   GET    /api/media?kind=&model=&creator=&q=&conversationId=&limit= → { items } (the workspace's media, newest first)
 *   POST   /api/media           MediaCreateRequest → 201 { item } (images/audio finished; video rendering)
 *   GET    /api/media/by-upload/:uploadId       → { item } (the item that made a file)
 *   GET    /api/media/:id                       → { item } (poll this while a video renders)
 *   POST   /api/media/:id/cancel                → { item }
 *   PATCH  /api/media/:id   {favorite?, addToCollection?, removeFromCollection?} → { item }
 *   DELETE /api/media/:id                       → { ok } (and its files)
 *   GET/POST /api/media/collections, PATCH/DELETE /api/media/collections/:id   the library's collections
 *
 * Not gated (the signature is the check): GET /api/media/ref/:uploadId?exp=&sig=
 * — a short-lived link the model provider fetches reference video/audio from.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PERMISSIONS, authorize } from "@open-gpt-live/core";
import { MAX_MEDIA_PROMPT_CHARS, MEDIA_KINDS, parseMediaCreateSpec, type MediaKind } from "@open-gpt-live/protocol";
import {
  BodyTooLargeError,
  corsGuard,
  isUnder,
  queryParam,
  readJsonObject,
  requestCaller,
  requestPath,
  requestWorkspace,
  runRoute,
  sendJson,
  type ApiOptions
} from "../http/index.js";
import { MediaError, type MediaService } from "./service.js";

export interface MediaHttpOptions extends ApiOptions {
  media: MediaService;
  ownerId: string;
}

const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const MEDIA_ID = /^md_[a-f0-9]{24}$/;
const UPLOAD_ID = /^up_[a-f0-9]{24}$/;
const COLLECTION_ID = /^mc_[a-f0-9]{24}$/;

export function handleMediaHttp(options: MediaHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isUnder(path, "/api/media") || path.startsWith("/api/media/ref/")) return false;
  return runRoute(response, options.log, "media.http_failed", serve(options, request, response, path));
}

/** The provider fetching a reference file (signed link; no sign-in). */
export function handleMediaRefHttp(options: Pick<MediaHttpOptions, "media" | "log">, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  const match = /^\/api\/media\/ref\/(up_[a-f0-9]{24})$/.exec(path);
  if (!match || (request.method !== "GET" && request.method !== "HEAD")) return false;
  return runRoute(
    response,
    options.log,
    "media.ref_failed",
    (async () => {
      request.resume();
      const upload = await options.media.refUpload(match[1]!, Number(queryParam(request, "exp")), queryParam(request, "sig") ?? "");
      if (!upload) return sendJson(response, 404, { error: "not_found" });
      const bytes = await options.media.readUpload(upload.id);
      response.writeHead(200, {
        "content-type": upload.mime,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    })()
  );
}

async function serve(options: MediaHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const workspaceId = requestWorkspace(request);
  const caller = requestCaller(request);
  const principal = caller?.principal;
  const userId = principal ? (principal.userId ?? principal.kind) : undefined;
  const scope = { ownerId: options.ownerId, workspaceId, ...(userId ? { viewer: userId } : {}) };
  const { media } = options;
  const parts = path.slice("/api/media".length).split("/").filter(Boolean).map(decodeURIComponent);

  try {
    if (parts.length === 0 && method === "GET") {
      request.resume();
      const kind = queryParam(request, "kind");
      const limit = Number(queryParam(request, "limit") ?? "200");
      const items = await media.list(scope, {
        ...(MEDIA_KINDS.includes(kind as MediaKind) ? { kind: kind as MediaKind } : {}),
        ...(queryParam(request, "model") ? { model: queryParam(request, "model")! } : {}),
        ...(queryParam(request, "creator") ? { createdBy: queryParam(request, "creator") === "me" ? (userId ?? "") : queryParam(request, "creator")! } : {}),
        ...(queryParam(request, "conversationId") ? { conversationId: queryParam(request, "conversationId")! } : {}),
        ...(queryParam(request, "q") ? { query: queryParam(request, "q")!.slice(0, 200) } : {}),
        ...(queryParam(request, "collection") ? { collectionId: queryParam(request, "collection")! } : {}),
        ...(queryParam(request, "favorites") === "1" ? { favorites: true } : {}),
        ...(Number.isFinite(limit) ? { limit } : {})
      });
      return reply(200, { items });
    }
    if (parts.length === 0 && method === "POST") {
      const body = await readJsonObject(request, 256 * 1024);
      const spec = parseMediaCreateSpec(body);
      if (!spec.success) return reply(400, { error: "invalid", message: spec.error });
      const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, MAX_MEDIA_PROMPT_CHARS) : "";
      const conversationId = typeof body.conversationId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.conversationId) ? body.conversationId : undefined;
      const item = await media.create({
        ...spec.data,
        prompt,
        workspaceId,
        ...(conversationId ? { conversationId } : {}),
        ...(userId ? { userId } : {}),
        ...(body.audioType === "music" || body.audioType === "speech" ? { audioType: body.audioType } : {})
      });
      return reply(201, { item });
    }
    const [first, second] = parts;
    if (parts.length === 1 && first === "models" && method === "GET") {
      request.resume();
      return reply(200, await media.models());
    }
    if (parts.length === 1 && first === "estimate" && method === "POST") {
      const body = await readJsonObject(request, 64 * 1024);
      const spec = parseMediaCreateSpec(body);
      if (!spec.success) return reply(400, { error: "invalid", message: spec.error });
      return reply(200, await media.estimate(scope, { ...spec.data, prompt: typeof body.prompt === "string" ? body.prompt : "" }));
    }
    if (first === "collections") {
      if (parts.length === 1 && method === "GET") {
        request.resume();
        return reply(200, { collections: await media.collections(scope) });
      }
      if (parts.length === 1 && method === "POST") {
        const body = await readJsonObject(request, 8 * 1024);
        return reply(201, { collection: await media.createCollection(scope, typeof body.name === "string" ? body.name : "") });
      }
      if (parts.length === 2 && second && COLLECTION_ID.test(second)) {
        if (method === "PATCH") {
          const body = await readJsonObject(request, 8 * 1024);
          return (await media.renameCollection(scope, second, typeof body.name === "string" ? body.name : "")) ? reply(200, { ok: true }) : reply(404, { error: "not_found" });
        }
        if (method === "DELETE") {
          request.resume();
          return (await media.removeCollection(scope, second)) ? reply(200, { ok: true }) : reply(404, { error: "not_found" });
        }
      }
    }
    if (parts.length === 2 && first === "by-upload" && second && UPLOAD_ID.test(second) && method === "GET") {
      request.resume();
      const item = await media.byUpload(scope, second);
      return item ? reply(200, { item }) : reply(404, { error: "not_found" });
    }
    if (first && MEDIA_ID.test(first)) {
      if (parts.length === 1 && method === "GET") {
        request.resume();
        const item = await media.get(scope, first);
        return item ? reply(200, { item }) : reply(404, { error: "not_found" });
      }
      if (parts.length === 1 && method === "PATCH") {
        const body = await readJsonObject(request, 8 * 1024);
        const patch = {
          ...(typeof body.favorite === "boolean" ? { favorite: body.favorite } : {}),
          ...(typeof body.addToCollection === "string" && COLLECTION_ID.test(body.addToCollection) ? { addToCollection: body.addToCollection } : {}),
          ...(typeof body.removeFromCollection === "string" && COLLECTION_ID.test(body.removeFromCollection) ? { removeFromCollection: body.removeFromCollection } : {})
        };
        const item = await media.update(scope, first, patch);
        return item ? reply(200, { item }) : reply(404, { error: "not_found" });
      }
      if (parts.length === 2 && second === "cancel" && method === "POST") {
        request.resume();
        const item = await media.cancel(scope, first);
        return item ? reply(200, { item }) : reply(404, { error: "not_found" });
      }
      if (parts.length === 1 && method === "DELETE") {
        request.resume();
        const creator = await media.owner(scope, first);
        const mine = Boolean(userId) && creator === userId;
        if (!mine && !authorize(principal, PERMISSIONS.CHAT_VIEW_ALL, { workspaceId })) {
          return reply(403, { error: "forbidden", message: "Only the person who made it (or someone who can see every chat) can delete it." });
        }
        return (await media.remove(scope, first)) ? reply(200, { ok: true }) : reply(404, { error: "not_found" });
      }
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof MediaError) return reply(error.status, { error: error.code, message: error.message });
    if (error instanceof BodyTooLargeError) return reply(413, { error: "too_large", message: "The request is too large." });
    if (error instanceof SyntaxError) return reply(400, { error: "invalid", message: "The body must be JSON." });
    if (error instanceof Error && error.name === "MediaProviderError") return reply(502, { error: "provider", message: error.message });
    throw error;
  }
}
