/**
 * Shared state of the enterprise identity modules — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * SSO (`sso`) and SCIM (`scim`) are separate licence features but share one
 * directory and one identity bridge per gateway. Whichever module installs
 * first creates them; the directory routes (/api/directory) are registered
 * once.
 */
import { AUDIT_ACTIONS } from "../../../packages/core/src/governance";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PERMISSIONS,
  authorize,
  type EnterpriseModuleContext,
  type IdentityBridge,
  type Principal,
  type Store
} from "../../../packages/core/src/index";
import { corsGuard, readJsonObject, sendBodyError, sendJson, type HeaderMap } from "../../../apps/gateway/src/http/index";
import { Directory, DirectoryError } from "./directory";

export interface IdentityContext {
  store: Store;
  orgId: string;
  directory: Directory;
  log: EnterpriseModuleContext["log"];
  env: NodeJS.ProcessEnv;
  /** Set when the gateway attaches its identity bridge (before it listens). */
  bridge(): IdentityBridge;
  setBridge(bridge: IdentityBridge): void;
  /** Route groups already registered (directory routes are shared). */
  registered: Set<string>;
}

const contexts = new WeakMap<Store, IdentityContext>();

export function identityContext(ctx: Pick<EnterpriseModuleContext, "store" | "ownerId" | "log" | "env"> & Partial<Pick<EnterpriseModuleContext, "audit">>): IdentityContext {
  const existing = contexts.get(ctx.store);
  if (existing) return existing;
  // SSO and SCIM events go to the gateway log and, when the audit log is on, to the audit log.
  const log = auditingLog(ctx.log, ctx.audit);
  let current: IdentityBridge | undefined;
  const bridge = (): IdentityBridge => {
    if (!current) throw new Error("the identity bridge is not attached yet");
    return current;
  };
  const context: IdentityContext = {
    store: ctx.store,
    orgId: ctx.ownerId,
    log,
    env: ctx.env,
    bridge,
    setBridge: (value) => {
      current = value;
    },
    registered: new Set(),
    directory: new Directory({
      store: ctx.store,
      orgId: ctx.ownerId,
      changed: (change) => current?.changed(change),
      endSessions: async (userId) => {
        await current?.endSessions(userId);
      },
      log
    })
  };
  contexts.set(ctx.store, context);
  return context;
}

/** Gateway-log events that are also audit entries (sign-ins, SSO settings, SCIM changes). */
const AUDITED: Record<string, { action: string; outcome?: "success" | "failure" }> = {
  "sso.signed_in": { action: AUDIT_ACTIONS.SIGN_IN },
  "sso.sign_in_failed": { action: AUDIT_ACTIONS.SIGN_IN_FAILED, outcome: "failure" },
  "sso.config_changed": { action: AUDIT_ACTIONS.POLICY_CHANGED },
  "sso.provider_added": { action: AUDIT_ACTIONS.POLICY_CHANGED },
  "sso.provider_updated": { action: AUDIT_ACTIONS.POLICY_CHANGED },
  "sso.provider_removed": { action: AUDIT_ACTIONS.POLICY_CHANGED },
  "sso.session_policy_changed": { action: AUDIT_ACTIONS.POLICY_CHANGED },
  "scim.token_created": { action: "scim.token_created" },
  "scim.token_revoked": { action: "scim.token_revoked" },
  "scim.user_created": { action: "scim.user_created" },
  "scim.user_updated": { action: "scim.user_updated" },
  "scim.user_deactivated": { action: "scim.user_deactivated" },
  "scim.group_deleted": { action: "scim.group_deleted" }
};

function auditingLog(
  log: EnterpriseModuleContext["log"],
  audit: EnterpriseModuleContext["audit"] | undefined
): EnterpriseModuleContext["log"] {
  if (!audit) return log;
  return (event, fields = {}) => {
    log(event, fields);
    const mapped = AUDITED[event];
    if (!mapped) return;
    const details: Record<string, string | number | boolean> = { event };
    for (const [key, value] of Object.entries(fields)) {
      if (key === "error" || key === "userId") continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") details[key] = value;
    }
    const userId = typeof fields.userId === "string" ? fields.userId : undefined;
    audit({
      action: mapped.action,
      ...(event === "sso.signed_in" && userId ? { actor: { kind: "user" as const, userId } } : {}),
      ...(userId ? { target: { kind: "user", id: userId } } : {}),
      ...(mapped.outcome ? { outcome: mapped.outcome } : {}),
      details
    });
  };
}

/* ───────────── admin routes ───────────── */

export interface AdminRequest {
  principal: Principal;
  cors: HeaderMap;
  reply(status: number, body: unknown): void;
  body(): Promise<Record<string, unknown>>;
}

/**
 * Run an organization-admin JSON route: CORS, sign-in (cookie or owner
 * token), `org.settings`, then `handle`. DirectoryError and body errors map
 * to their status; anything else is logged and answered with 500.
 */
export function adminRoute(
  context: IdentityContext,
  request: IncomingMessage,
  response: ServerResponse,
  event: string,
  handle: (admin: AdminRequest) => Promise<void>
): true {
  const cors = corsGuard(request, response, context.bridge().allowedOrigins);
  if (!cors) return true;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  void (async () => {
    const auth = await context.bridge().authenticate(request);
    if (!auth) {
      request.resume();
      return reply(401, { error: "unauthorized", message: "Sign in to continue." });
    }
    if (!authorize(auth.principal, PERMISSIONS.ORG_SETTINGS)) {
      request.resume();
      return reply(403, { error: "forbidden", permission: PERMISSIONS.ORG_SETTINGS, message: "Only organization owners and admins can change this." });
    }
    await handle({ principal: auth.principal, cors, reply, body: () => readJsonObject(request, 256 * 1024) });
  })().catch((error: unknown) => {
    request.resume();
    if (error instanceof DirectoryError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    context.log(event, { error: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) reply(500, { error: "internal_error", message: "Something went wrong." });
  });
  return true;
}
