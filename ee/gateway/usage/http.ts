/**
 * Advanced usage controls — HTTP API (Sibyl Enterprise).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Runs behind the gateway's gate (apps/gateway/src/identity/http.ts route
 * map: reads need usage.view, writes budgets.manage), then:
 *
 *   GET  /api/usage-controls               org.settings  → settings, people and their spend
 *   PUT  /api/usage-controls  {controls}   org.settings  → the same (+ webhookKey once)
 *   POST /api/usage-controls/webhook-key   org.settings  → { webhookKey } (rotated, shown once)
 *   POST /api/usage-controls/test-alert    org.settings  → { delivery }
 *   GET  /api/usage-controls/report?from=YYYY-MM-DD&to=YYYY-MM-DD        → chargeback JSON
 *   GET  /api/usage-controls/report.csv?from=…&to=…                     → the same as CSV
 *
 * Settings apply to the whole organisation, so they also need org.settings.
 * Reports: org.settings sees everything; otherwise each workspace where the
 * caller has budgets.manage in full, and only their own spend where they
 * have usage.view.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PERMISSIONS, authorize } from "../../../packages/core/src/permissions";
import { corsGuard, isUnder, queryParam, readJsonObject, requestCaller, requestPath, requestWorkspace, runRoute, sendBodyError, sendJson } from "../../../apps/gateway/src/http/index";
import { parseControls } from "./controls";
import { chargebackCsv, type ReportScope } from "./report";
import { UsageControlsError, type UsageControlsService } from "./service";

export const USAGE_CONTROLS_PATH = "/api/usage-controls";
const METHODS = "GET, PUT, POST, OPTIONS";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageControlsHttpOptions {
  service: UsageControlsService;
  allowedOrigins: readonly string[];
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export function createUsageControlsRoute(options: UsageControlsHttpOptions): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const path = requestPath(request);
    if (!isUnder(path, USAGE_CONTROLS_PATH)) return false;
    return runRoute(response, options.log, "usage_controls.http_failed", serve(options, request, response, path));
  };
}

async function serve(options: UsageControlsHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const caller = requestCaller(request);
  // Only reachable through the gate; a request that skipped it is refused.
  if (!caller) {
    request.resume();
    return reply(401, { error: "unauthorized", message: "Sign in to continue." });
  }
  const { principal } = caller;
  const method = request.method ?? "GET";
  const sub = path.slice(USAGE_CONTROLS_PATH.length).replace(/^\/+/, "");
  const orgAdmin = authorize(principal, PERMISSIONS.ORG_SETTINGS);
  const denied = () => reply(403, { error: "forbidden", permission: PERMISSIONS.ORG_SETTINGS, message: "Only organisation owners and admins can change usage controls." });
  const { service } = options;

  try {
    if (sub === "" && method === "GET") {
      request.resume();
      if (!orgAdmin) return denied();
      return reply(200, await service.view());
    }
    if (sub === "" && method === "PUT") {
      if (!orgAdmin) {
        request.resume();
        return denied();
      }
      const input = await readJsonObject(request, 256 * 1024);
      const parsed = parseControls(input.controls ?? input);
      if (!parsed.success) return reply(400, { error: "invalid", message: parsed.error });
      const issued = await service.update(parsed.data);
      return reply(200, { ...(await service.view()), ...issued });
    }
    if (sub === "webhook-key" && method === "POST") {
      request.resume();
      if (!orgAdmin) return denied();
      return reply(200, { webhookKey: await service.rotateWebhookKey() });
    }
    if (sub === "test-alert" && method === "POST") {
      request.resume();
      if (!orgAdmin) return denied();
      const userId = principal.userId ?? principal.kind;
      return reply(200, { delivery: await service.testAlert(userId, requestWorkspace(request)) });
    }
    if ((sub === "report" || sub === "report.csv") && method === "GET") {
      request.resume();
      const range = parseRange(queryParam(request, "from"), queryParam(request, "to"), (options.now ?? Date.now)());
      if (typeof range === "string") return reply(400, { error: "invalid", message: range });
      const scope: ReportScope = orgAdmin
        ? { all: true }
        : {
            all: false,
            userId: principal.userId ?? principal.kind,
            workspaces: (workspaceId) =>
              authorize(principal, PERMISSIONS.BUDGETS_MANAGE, { workspaceId }) ? "all" : authorize(principal, PERMISSIONS.USAGE_VIEW, { workspaceId }) ? "own" : "none"
          };
      const report = await service.report(range, scope);
      options.log("usage_controls.report", { format: sub === "report.csv" ? "csv" : "json", rows: report.rows.length, scope: orgAdmin ? "org" : "workspaces" });
      if (sub === "report") return reply(200, report);
      const name = `sibyl-usage-${dateKey(range.from)}-to-${dateKey(range.to - 1)}.csv`;
      response.writeHead(200, {
        ...cors,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store"
      });
      response.end(chargebackCsv(report));
      return;
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof UsageControlsError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}

/** Local dates YYYY-MM-DD, both inclusive (default: this month so far). Returns [from, to) in ms or an error. */
export function parseRange(fromText: string | undefined, toText: string | undefined, now: number): { from: number; to: number } | string {
  const today = new Date(now);
  const from = fromText ? localDate(fromText) : new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const toDay = toText ? localDate(toText) : new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (from === undefined || toDay === undefined) return "Dates must look like 2026-11-30.";
  const to = new Date(new Date(toDay).getFullYear(), new Date(toDay).getMonth(), new Date(toDay).getDate() + 1).getTime();
  if (to <= from) return "The end date is before the start date.";
  if (to - from > 400 * DAY_MS) return "Pick at most about a year.";
  return { from, to };
}

function localDate(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : undefined;
}

function dateKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
