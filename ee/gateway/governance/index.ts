/**
 * Governance modules — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Two modules, each installed only when its licence feature is present:
 *
 * custom_roles — /api/admin/roles (org.settings)
 *   GET    /api/admin/roles              → { permissions, builtInRoles, roles, assignments, grants, people, workspaces, connections }
 *   POST   /api/admin/roles              { name, description?, permissions[] } → { role }
 *   PATCH  /api/admin/roles/:id          { name, description?, permissions[] } → { role }
 *   DELETE /api/admin/roles/:id
 *   PUT    /api/admin/roles/assignments  { userId, scope: "org"|workspaceId, roleId|null } → { assignment? }
 *   PUT    /api/admin/roles/grants       { resource: { kind: "connection", id, name? }, roles[], userIds[] } → { grant? }
 *
 * policies — /api/admin/policies and /api/admin/approvals (org.settings)
 *   GET    /api/admin/policies           → { policies, tools }
 *   PUT    /api/admin/policies           partial OrgPolicies → { policies }
 *   POST   /api/admin/policies/retention/run → { result } (run the retention job now)
 *   GET    /api/admin/approvals          → { items } (waiting for an admin's second approval)
 *   POST   /api/admin/approvals/:id      { decision: "approve"|"decline" } → { status }
 */
import { ALL_PERMISSIONS, ORG_PERMISSIONS, type EnterpriseModule } from "../../../packages/core/src/index";
import type { AdminPoliciesState, AdminRolesState, AdminSecondApprovalItem } from "../../../packages/protocol/src/index";
import { CONNECTIONS_KV_KEY } from "../../../apps/gateway/src/connectors/store";
import type { ConnectionRecord } from "../../../apps/gateway/src/connectors/types";
import { adminRoute, notFound } from "../http";
import { PolicyBook, SecondApprovalDesk, purgeExpired, retentionJobType } from "./policies";
import { RoleBook } from "./roles";

const BUILT_IN_ROLES = [
  { id: "owner", name: "Owner" },
  { id: "admin", name: "Admin" },
  { id: "member", name: "Member" },
  { id: "viewer", name: "Viewer" }
] as const;

export const customRolesModule: EnterpriseModule = {
  id: "custom-roles",
  feature: "custom_roles",
  async install(ctx) {
    const book = await new RoleBook({ store: ctx.store, orgId: ctx.ownerId, audit: ctx.audit }).load();
    // authorize() consults it everywhere: HTTP gate, WebSocket messages, tools, connectors.
    ctx.registerPermissionPolicy(book.policy);
    ctx.registerHttpRoute(
      adminRoute("/api/admin/roles", ctx.log, async (req) => {
        const [first, second] = req.segments;
        if (req.method === "GET" && !first) {
          req.request.resume();
          const users = await ctx.store.identity.users.list(ctx.ownerId);
          const workspaces = await ctx.store.workspaces.list(ctx.ownerId);
          const connections = ((await ctx.store.kv.get<ConnectionRecord[]>(ctx.ownerId, CONNECTIONS_KV_KEY)) ?? [])
            .filter((c) => c.scope === "workspace" && !c.id.startsWith("probe-"))
            .map((c) => ({ id: c.id, connectorId: c.connectorId, workspaceId: c.workspaceId, name: c.accountName ?? c.account ?? c.connectorId }));
          const state: AdminRolesState = {
            ...book.snapshot(),
            permissions: ALL_PERMISSIONS.map((id) => ({ id, org: (ORG_PERMISSIONS as readonly string[]).includes(id) })),
            builtInRoles: [...BUILT_IN_ROLES],
            people: users.filter((u) => u.disabledAt === undefined).map((u) => ({ id: u.id, name: u.name, email: u.email })),
            workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
            connections
          };
          return req.reply(200, state);
        }
        if (req.method === "POST" && !first) return req.reply(201, { role: await book.saveRole(req.actor, undefined, await req.body()) });
        if (req.method === "PUT" && first === "assignments" && !second) {
          const assignment = await book.assign(req.actor, await req.body());
          return req.reply(200, assignment ? { assignment } : {});
        }
        if (req.method === "PUT" && first === "grants" && !second) {
          const grant = await book.setGrant(req.actor, await req.body());
          return req.reply(200, grant ? { grant } : {});
        }
        if (first && first.startsWith("role_") && !second) {
          if (req.method === "PATCH") return req.reply(200, { role: await book.saveRole(req.actor, first, await req.body()) });
          if (req.method === "DELETE") {
            req.request.resume();
            await book.deleteRole(req.actor, first);
            return req.reply(200, { ok: true });
          }
        }
        return false;
      })
    );
    ctx.log("enterprise.custom_roles_installed", { roles: book.snapshot().roles.length });
  }
};

export const policiesModule: EnterpriseModule = {
  id: "policies",
  feature: "policies",
  async install(ctx) {
    const book = await new PolicyBook({ store: ctx.store, orgId: ctx.ownerId, audit: ctx.audit }).load();
    const desk = new SecondApprovalDesk({ store: ctx.store, orgId: ctx.ownerId, audit: ctx.audit, log: ctx.log, ...(ctx.notify ? { notify: ctx.notify } : {}) });
    // Consulted where tools are offered and run and where models are chosen.
    ctx.registerToolPolicy(book.hook);
    ctx.registerSecondApprover(desk.approver);
    const purge = (signal?: AbortSignal, actor?: Parameters<typeof purgeExpired>[0]["actor"]) =>
      purgeExpired({
        store: ctx.store,
        orgId: ctx.ownerId,
        env: ctx.env,
        retention: book.policies.retention,
        now: Date.now(),
        audit: ctx.audit,
        log: ctx.log,
        ...(actor ? { actor } : {}),
        ...(signal ? { signal } : {})
      });
    // Data retention runs on the gateway's one scheduler (routines, monitors, …).
    ctx.addJobType?.(retentionJobType({ book, run: (signal) => purge(signal) }));
    ctx.registerHttpRoute(
      adminRoute("/api/admin/policies", ctx.log, async (req) => {
        const [first, second] = req.segments;
        if (req.method === "GET" && !first) {
          req.request.resume();
          const tools = ctx.tools
            .list()
            .map((t) => ({ name: t.name, title: t.title, effect: t.effect, source: t.source, ...(t.provider ? { provider: t.provider } : {}), ...(t.risk ? { risk: t.risk } : {}) }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return req.reply(200, { policies: book.policies, tools } satisfies AdminPoliciesState);
        }
        if (req.method === "PUT" && !first) return req.reply(200, { policies: await book.save(req.actor, await req.body()) });
        if (req.method === "POST" && first === "retention" && second === "run") {
          req.request.resume();
          return req.reply(200, { result: await purge(undefined, req.actor) });
        }
        return false;
      })
    );
    ctx.registerHttpRoute(
      adminRoute("/api/admin/approvals", ctx.log, async (req) => {
        const [id, extra] = req.segments;
        if (req.method === "GET" && !id) {
          req.request.resume();
          return req.reply(200, { items: desk.list() satisfies AdminSecondApprovalItem[] });
        }
        if (req.method === "POST" && id && !extra) {
          const body = await req.body();
          return req.reply(200, { status: desk.decide(req.actor, id, body.decision) });
        }
        if (id && extra) throw notFound();
        return false;
      })
    );
    ctx.log("enterprise.policies_installed", { secondApproval: book.policies.secondApproval.mode, blockedTools: book.policies.blockedTools.length });
    return { close: () => desk.close() };
  }
};

export const governanceModules: EnterpriseModule[] = [customRolesModule, policiesModule];
