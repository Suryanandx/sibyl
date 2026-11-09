/**
 * /api/memory — the Memory tab's API (same owner-token auth and CORS as uploads).
 *
 *   GET    /api/memory               → { available, enabled, items }
 *   POST   /api/memory      {text, pinned?}   → { item }
 *   PATCH  /api/memory/:id  {text?, pinned?}  → { item }
 *   DELETE /api/memory/:id                    → { ok }
 *   DELETE /api/memory                        → { ok } (forget everything)
 *   PUT    /api/memory/settings {enabled}     → state
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "@open-gpt-live/core";
import { BodyTooLargeError, guardRequest, readBody, requestPath, sendJson, type HttpGuardOptions } from "../uploads/http-util.js";
import { MemoryError, MemoryService } from "./store.js";

export interface MemoryHttpOptions extends HttpGuardOptions {
  store: Store;
  ownerId: string;
  env?: NodeJS.ProcessEnv;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Returns true when the request was for /api/memory (and is being handled). */
export function handleMemoryHttp(options: MemoryHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (path !== "/api/memory" && !path.startsWith("/api/memory/")) return false;
  void serve(options, request, response, path).catch((error: unknown) => {
    options.log?.("memory.http_failed", { error: error instanceof Error ? error.message : String(error) });
    sendJson(response, 500, { error: "internal_error" });
  });
  return true;
}

async function serve(options: MemoryHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = guardRequest(options, request, response, METHODS);
  if (!cors) return;
  const memory = new MemoryService({ store: options.store, ownerId: options.ownerId, env: options.env });
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const rest = path.slice("/api/memory".length).replace(/^\//, "");

  const body = async (): Promise<Record<string, unknown>> => {
    const raw = await readBody(request, 16 * 1024);
    if (raw.byteLength === 0) return {};
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("body must be an object");
    return parsed as Record<string, unknown>;
  };

  try {
    if (rest === "" && method === "GET") return reply(200, await memory.state());
    if (!memory.available) {
      request.resume();
      return reply(409, { error: "memory_disabled", message: "Memory is turned off on this Sibyl (SIBYL_MEMORY=false)." });
    }
    if (rest === "settings" && method === "PUT") {
      const input = await body();
      if (typeof input.enabled !== "boolean") return reply(400, { error: "enabled must be a boolean" });
      await memory.setEnabled(input.enabled);
      return reply(200, await memory.state());
    }
    if (rest === "" && method === "POST") {
      const input = await body();
      const item = await memory.add(input.text, { pinned: input.pinned === true });
      return reply(201, { item });
    }
    if (rest === "" && method === "DELETE") {
      await memory.clear();
      return reply(200, { ok: true });
    }
    if (ID.test(rest) && method === "PATCH") {
      const input = await body();
      if (input.pinned !== undefined && typeof input.pinned !== "boolean") return reply(400, { error: "pinned must be a boolean" });
      const item = await memory.update(rest, {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(typeof input.pinned === "boolean" ? { pinned: input.pinned } : {})
      });
      return reply(200, { item });
    }
    if (ID.test(rest) && method === "DELETE") {
      const removed = await memory.remove(rest);
      return removed ? reply(200, { ok: true }) : reply(404, { error: "not_found" });
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof MemoryError) {
      return reply(error.code === "not_found" ? 404 : 400, { error: error.code, message: error.message });
    }
    if (error instanceof BodyTooLargeError) return reply(413, { error: "too_large" });
    if (error instanceof SyntaxError) return reply(400, { error: "invalid_json" });
    throw error;
  }
}
