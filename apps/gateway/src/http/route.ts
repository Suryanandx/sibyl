/**
 * The frame every API handler shares: which paths it owns, the options the
 * gateway hands it, and running its async work with one 500 reply on failure.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { auditActor, type AuditEvent } from "@open-gpt-live/core";
import { requestCaller } from "./caller.js";
import type { LogFn } from "./log.js";
import { requestWorkspace } from "./request.js";
import { sendError } from "./response.js";

/** What the gateway gives every API handler (on top of its own service). */
export interface ApiOptions {
  /** ALLOWED_ORIGINS (empty: pages on the gateway's own host name). */
  allowedOrigins?: readonly string[];
  log?: LogFn;
  /** The runtime's audit path (downloads, licence changes, …); absent in bare test setups. */
  audit?: (event: AuditEvent) => void;
}

/** Audit an HTTP action as the caller the identity gate bound to the request. */
export function auditRequest(options: Pick<ApiOptions, "audit">, request: IncomingMessage, event: Omit<AuditEvent, "actor">): void {
  if (!options.audit) return;
  const caller = requestCaller(request);
  options.audit({ ...event, actor: auditActor(caller?.principal), ...(event.workspaceId ? {} : { workspaceId: requestWorkspace(request) }) });
}

/** `path` is `prefix` or below it. */
export function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Run a handler's async work: an unexpected error is logged as `event` and
 * answered with 500 (or ends a reply already under way). Returns true, the
 * "handled" answer the gateway's router expects.
 */
export function runRoute(response: ServerResponse, log: LogFn | undefined, event: string, work: Promise<void>): true {
  void work.catch((error: unknown) => {
    log?.(event, { error: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) sendError(response, 500, "internal_error", "Something went wrong.");
    else response.end();
  });
  return true;
}
