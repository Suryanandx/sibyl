/**
 * Audit log module — Sibyl Enterprise (licence feature `audit_log`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Registers the audit sink with the runtime's Governance (the open-source
 * code calls `audit(event)` at sign-ins, member and role changes,
 * invitations, connections, secret use, approvals, write actions, exports,
 * licence and policy changes) and serves /api/admin/audit (audit.view):
 *
 *   GET    /api/admin/audit                 ?action=&actor=&workspaceId=&outcome=&from=&to=&q=&before=&limit= → { entries, next? }
 *   GET    /api/admin/audit/verify          → VerifyResult (walks the hash chain)
 *   GET    /api/admin/audit/export          ?format=csv|jsonl (+ the filters) → file
 *   GET    /api/admin/audit/stream          → StreamView
 *   PUT    /api/admin/audit/stream          { url, enabled?, rotateSecret? } → StreamView (+ secret once)
 *   DELETE /api/admin/audit/stream
 *   POST   /api/admin/audit/stream/test     → { ok, status?, error? }
 */
import { AUDIT_ACTIONS, type AuditOutcome, type AuditQuery, type EnterpriseModule } from "../../../packages/core/src/index";
import type { AdminAuditListResponse, AdminAuditStreamView, AdminAuditVerifyResponse } from "../../../packages/protocol/src/index";
import { adminRoute, badRequest } from "../http";
import { AuditLog, CSV_COLUMNS, csvRow } from "./log";
import { AuditStreamer } from "./stream";

const OUTCOMES: readonly AuditOutcome[] = ["success", "failure", "denied"];
const EXPORT_MAX = 100_000;

/** Filters from the query string (shared by the list and the export). */
export function auditQueryFrom(params: URLSearchParams): AuditQuery {
  const query: AuditQuery = {};
  const action = params.get("action")?.trim();
  if (action) {
    if (!/^[a-z_]+(\.[a-z_]*)?$/.test(action)) throw badRequest("Unknown action filter.");
    query.action = action;
  }
  const actor = params.get("actor")?.trim();
  if (actor) query.actorUserId = actor.slice(0, 128);
  const workspaceId = params.get("workspaceId")?.trim();
  if (workspaceId) query.workspaceId = workspaceId.slice(0, 128);
  const outcome = params.get("outcome");
  if (outcome) {
    if (!OUTCOMES.includes(outcome as AuditOutcome)) throw badRequest("outcome is success, failure or denied.");
    query.outcome = outcome as AuditOutcome;
  }
  for (const key of ["from", "to"] as const) {
    const raw = params.get(key);
    if (!raw) continue;
    const at = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isFinite(at)) throw badRequest(`${key} is a date.`);
    query[key] = at;
  }
  const text = params.get("q")?.trim();
  if (text) query.text = text.slice(0, 200);
  const before = Number(params.get("before"));
  if (params.get("before") && Number.isInteger(before) && before > 0) query.beforeSeq = before;
  return query;
}

export const auditLogModule: EnterpriseModule = {
  id: "audit-log",
  feature: "audit_log",
  async install(ctx) {
    const log = new AuditLog({ store: ctx.store, orgId: ctx.ownerId, log: ctx.log });
    const streamer = await new AuditStreamer({
      store: ctx.store,
      orgId: ctx.ownerId,
      ...(ctx.secrets ? { secrets: ctx.secrets } : {}),
      head: async () => {
        await log.flush();
        return (await ctx.store.audit.last(ctx.ownerId))?.seq ?? 0;
      },
      log: ctx.log
    }).load();
    log.onAppended(() => streamer.notify());
    ctx.registerAuditSink(log.sink);

    ctx.registerHttpRoute(
      adminRoute("/api/admin/audit", ctx.log, async (req) => {
        const [first, second] = req.segments;
        if (req.method === "GET" && !first) {
          req.request.resume();
          await log.flush();
          const limit = Math.min(200, Math.max(1, Number(req.url.searchParams.get("limit")) || 50));
          const entries = await log.query({ ...auditQueryFrom(req.url.searchParams), limit });
          const last = entries[entries.length - 1];
          return req.reply(200, { entries, ...(entries.length === limit && last ? { next: last.seq } : {}) } satisfies AdminAuditListResponse);
        }
        if (req.method === "GET" && first === "verify" && !second) {
          req.request.resume();
          return req.reply(200, (await log.verify()) satisfies AdminAuditVerifyResponse);
        }
        if (req.method === "GET" && first === "export" && !second) {
          req.request.resume();
          const format = req.url.searchParams.get("format") === "jsonl" ? "jsonl" : "csv";
          const query = auditQueryFrom(req.url.searchParams);
          await log.flush();
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          req.response.writeHead(200, {
            ...req.cors,
            "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
            "content-disposition": `attachment; filename="sibyl-audit-${stamp}.${format}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
          });
          if (format === "csv") req.response.write(`${CSV_COLUMNS.join(",")}\n`);
          let rows = 0;
          for await (const page of log.exportPages(query, EXPORT_MAX)) {
            req.response.write(page.map((record) => (format === "csv" ? csvRow(record) : JSON.stringify(record))).join("\n") + "\n");
            rows += page.length;
          }
          req.response.end();
          ctx.audit({ action: AUDIT_ACTIONS.AUDIT_EXPORTED, actor: req.actor, target: { kind: "audit_log" }, details: { format, rows, ...(query.action ? { filter: query.action } : {}) } });
          return;
        }
        if (first === "stream") {
          if (req.method === "GET" && !second) {
            req.request.resume();
            return req.reply(200, streamer.view() satisfies AdminAuditStreamView);
          }
          if (req.method === "PUT" && !second) {
            const view = await streamer.configure(await req.body());
            ctx.audit({ action: AUDIT_ACTIONS.AUDIT_STREAM_CHANGED, actor: req.actor, target: { kind: "webhook", name: view.url ?? "" }, details: { enabled: view.enabled ?? false, secretCreated: Boolean(view.secret) } });
            return req.reply(200, view);
          }
          if (req.method === "DELETE" && !second) {
            req.request.resume();
            await streamer.remove();
            ctx.audit({ action: AUDIT_ACTIONS.AUDIT_STREAM_CHANGED, actor: req.actor, target: { kind: "webhook" }, details: { removed: true } });
            return req.reply(200, { ok: true });
          }
          if (req.method === "POST" && second === "test") {
            req.request.resume();
            return req.reply(200, await streamer.test());
          }
        }
        return false;
      })
    );
    ctx.log("enterprise.audit_log_installed", { streaming: streamer.view().enabled ?? false });
    return {
      close: async () => {
        streamer.close();
        await log.flush();
      }
    };
  }
};
