/**
 * /api/knowledge — the Knowledge screen's API. Runs behind gateProtectedRoute()
 * (identity/http.ts), which checks the permission for each route:
 *
 *   GET    /api/knowledge                               knowledge.view   → { bases, autoBaseIds, embeddings }
 *   GET    /api/knowledge/search?q=&base=a,b&limit=     knowledge.view   → { query, hits, mode }
 *   GET    /api/knowledge/:id                           knowledge.view   → { base, docs }
 *   POST   /api/knowledge            {name, description} knowledge.manage → { base }
 *   PATCH  /api/knowledge/:id        {name?, description?} knowledge.manage
 *   DELETE /api/knowledge/:id                           knowledge.manage
 *   PUT    /api/knowledge/settings   {autoBaseIds}      workspace.settings
 *   POST   /api/knowledge/save-upload {uploadId, knowledgeBaseId?} knowledge.edit → { base, doc }
 *   POST   /api/knowledge/:id/docs   {kind, …}          knowledge.edit   → { doc, docs, skipped } (a ZIP: one doc per file)
 *   DELETE /api/knowledge/:id/docs/:docId               knowledge.edit
 *   POST   /api/knowledge/:id/docs/:docId/reindex       knowledge.edit   → { doc }
 *
 * Everything is scoped to the request's workspace (x-sibyl-workspace).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseKnowledgeDocInput } from "@open-gpt-live/protocol";
import { corsGuard, isUnder, readJsonObject, requestPath, requestUrl, requestWorkspace, runRoute, sendBodyError, sendJson, type ApiOptions } from "../http/index.js";
import { KnowledgeError, type KnowledgeService } from "./service.js";

export interface KnowledgeHttpOptions extends ApiOptions {
  knowledge: KnowledgeService;
}

const METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 3 * 1024 * 1024;

export function isKnowledgePath(path: string): boolean {
  return isUnder(path, "/api/knowledge");
}

/** Returns true when the request was for /api/knowledge (and is being handled). */
export function handleKnowledgeHttp(options: KnowledgeHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isKnowledgePath(path)) return false;
  return runRoute(response, options.log, "knowledge.http_failed", serve(options, request, response, path));
}

async function serve(options: KnowledgeHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const workspaceId = requestWorkspace(request);
  const { knowledge } = options;
  const parts = path.slice("/api/knowledge".length).split("/").filter(Boolean).map(decodeURIComponent);
  const body = () => readJsonObject(request, MAX_BODY);

  try {
    if (parts.length === 0) {
      if (method === "GET") {
        return reply(200, { bases: await knowledge.listBases(workspaceId), autoBaseIds: await knowledge.autoBaseIds(workspaceId), embeddings: Boolean(knowledge.embeddings) });
      }
      if (method === "POST") {
        const input = await body();
        return reply(201, { base: await knowledge.createBase(workspaceId, { name: input.name, description: input.description }) });
      }
    }
    const [first, second, third, fourth] = parts;
    if (parts.length === 1 && first === "search" && method === "GET") {
      const url = requestUrl(request);
      const q = url.searchParams.get("q") ?? "";
      const baseIds = (url.searchParams.get("base") ?? "").split(",").filter((id) => ID.test(id));
      const limit = Number(url.searchParams.get("limit") ?? "8");
      request.resume();
      return reply(200, await knowledge.search(workspaceId, q, { ...(baseIds.length ? { baseIds } : {}), limit: Number.isFinite(limit) ? limit : 8 }));
    }
    if (parts.length === 1 && first === "settings" && method === "PUT") {
      const input = await body();
      return reply(200, { autoBaseIds: await knowledge.setAutoBaseIds(workspaceId, input.autoBaseIds) });
    }
    if (parts.length === 1 && first === "save-upload" && method === "POST") {
      const input = await body();
      if (typeof input.uploadId !== "string") return reply(400, { error: "invalid", message: "uploadId is required" });
      if (input.knowledgeBaseId !== undefined && (typeof input.knowledgeBaseId !== "string" || !ID.test(input.knowledgeBaseId))) {
        return reply(400, { error: "invalid", message: "knowledgeBaseId must be an id" });
      }
      return reply(201, await knowledge.saveUpload(workspaceId, input.uploadId, input.knowledgeBaseId as string | undefined));
    }
    if (first && ID.test(first)) {
      if (parts.length === 1) {
        if (method === "GET") {
          request.resume();
          return reply(200, await knowledge.getBase(workspaceId, first));
        }
        if (method === "PATCH") {
          const input = await body();
          return reply(200, { base: await knowledge.updateBase(workspaceId, first, { name: input.name, description: input.description }) });
        }
        if (method === "DELETE") {
          request.resume();
          await knowledge.removeBase(workspaceId, first);
          return reply(200, { ok: true });
        }
      }
      if (second === "docs") {
        if (parts.length === 2 && method === "POST") {
          const parsed = parseKnowledgeDocInput(await body());
          if (!parsed.success) return reply(400, { error: "invalid", message: parsed.error });
          return reply(201, await knowledge.addDocs(workspaceId, first, parsed.data));
        }
        if (parts.length === 3 && third && ID.test(third) && method === "DELETE") {
          request.resume();
          await knowledge.removeDoc(workspaceId, first, third);
          return reply(200, { ok: true });
        }
        if (parts.length === 4 && third && ID.test(third) && fourth === "reindex" && method === "POST") {
          request.resume();
          return reply(200, { doc: await knowledge.reindexDoc(workspaceId, first, third) });
        }
      }
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof KnowledgeError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
