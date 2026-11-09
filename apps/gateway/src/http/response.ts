/**
 * Writing a reply: JSON with no-store caching, and one error shape
 * (`{ error: code, message? }`) for every route. Body-reading errors map to
 * their status here so handlers don't repeat the mapping.
 */
import type { ServerResponse } from "node:http";
import { BodyTooLargeError } from "./request.js";

export type HeaderMap = Record<string, string>;

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: HeaderMap = {}): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(body));
}

/** `{ error: code, message? }` with `status`. */
export function sendError(response: ServerResponse, status: number, code: string, message?: string, headers: HeaderMap = {}): void {
  sendJson(response, status, { error: code, ...(message ? { message } : {}) }, headers);
}

/**
 * Reply for a body-reading failure (413 too large, 400 bad JSON); false when
 * `error` is something else, for the caller to handle or rethrow.
 */
export function sendBodyError(response: ServerResponse, error: unknown, headers: HeaderMap = {}): boolean {
  if (error instanceof BodyTooLargeError) {
    sendError(response, 413, "too_large", "The request is too large.", headers);
    return true;
  }
  if (error instanceof SyntaxError) {
    sendError(response, 400, "invalid_json", "Send a JSON object.", headers);
    return true;
  }
  return false;
}
