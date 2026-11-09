/**
 * HTTP logging: one info line per API request (method, path, status, time),
 * warnings only for failures (5xx replies and `*_failed` events).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestPath } from "./request.js";

export interface HttpLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

/** The `log` handed to HTTP handlers: failures at warn, everything else at info. */
export function httpEventLog(logger: HttpLogger): LogFn {
  return (event, fields) => (/_(failed|error)$/.test(event) ? logger.warn(event, fields) : logger.info(event, fields));
}

/** Log the request once its reply is sent: info normally, warn for a server error. */
export function logRequest(logger: HttpLogger, request: IncomingMessage, response: ServerResponse): void {
  const started = performance.now();
  response.once("finish", () => {
    const fields = { method: request.method ?? "GET", path: requestPath(request), status: response.statusCode, ms: Math.round(performance.now() - started) };
    if (response.statusCode >= 500) logger.warn("http.request_failed", fields);
    else logger.info("http.request", fields);
  });
}
