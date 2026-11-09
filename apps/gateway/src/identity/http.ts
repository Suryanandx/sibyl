/**
 * HTTP side of identity:
 *
 * - /api/auth/*, /api/invites*, /api/workspaces* (routes listed in
 *   @open-gpt-live/protocol, "Identity & workspaces").
 * - `gateProtectedRoute()`: the one check in front of the older JSON/file
 *   APIs (/api/uploads, /api/memory, /api/slides): who is calling (cookie or
 *   owner token), which workspace, and whether `authorize()` allows it.
 * - `authenticateUpgrade()`: the same for the WebSocket upgrade.
 *
 * Cookie: `sibyl_session`, httpOnly, SameSite=Lax, Secure on https, 30 days
 * (sliding). Credentialed CORS is only granted to ALLOWED_ORIGINS, or — when
 * that list is empty (local dev) — to pages on the gateway's own host name.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  PERMISSIONS,
  authorize,
  type IdentityBridge,
  type IdentitySecrets,
  type Permission
} from "@open-gpt-live/core";
import {
  bearer,
  bindCaller,
  corsHeaders,
  isUnder,
  originAllowed,
  queryParam,
  readJsonObject,
  requestOrigin,
  requestPath,
  requestWorkspace,
  sendBodyError,
  sendError,
  sendJson
} from "../http/index.js";
import { isMeetingGuestRoute } from "../meetings/routes.js";
import { MfaUnavailableError } from "./mfa.js";
import { IdentityError, SESSION_TTL_MS, type Authenticated, type IdentityService, type SignInResult } from "./service.js";

export const SESSION_COOKIE = "sibyl_session";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface IdentityHttpOptions {
  identity: IdentityService;
  allowedOrigins?: string[];
  /** Force the cookie's Secure flag (default: on when the request is https). */
  secureCookies?: boolean;
  /** Enabled Enterprise features (from the licence), reported by /api/auth/me. */
  features?: () => string[];
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/* ───────────── shared helpers ───────────── */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionTokenOf(request: IncomingMessage): string | undefined {
  const value = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  return value && value.length <= 128 ? value : undefined;
}

export function isHttps(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  if (proto) return proto === "https";
  if ((request.socket as { encrypted?: boolean }).encrypted) return true;
  return request.headers.origin?.startsWith("https://") ?? false;
}

export function sessionCookie(token: string, request: IncomingMessage, secure: boolean | undefined): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...((secure ?? isHttps(request)) ? ["Secure"] : [])
  ].join("; ");
}

export function clearCookie(request: IncomingMessage, secure: boolean | undefined): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...((secure ?? isHttps(request)) ? ["Secure"] : [])].join("; ");
}

export function clientIp(request: IncomingMessage): string {
  // Only trust X-Forwarded-For from a local reverse proxy.
  const remote = request.socket.remoteAddress ?? "unknown";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1" || /^(::ffff:)?(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(remote);
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return local && first ? first : remote;
}

/** Who is calling: session cookie (from an allowed origin), owner token, or local mode. */
export async function authenticateRequest(
  identity: IdentityService,
  request: IncomingMessage,
  allowedOrigins?: string[]
): Promise<Authenticated | undefined> {
  const cookie = originAllowed(request.headers.origin, request, allowedOrigins) ? sessionTokenOf(request) : undefined;
  const token = bearer(request);
  return identity.authenticate({
    ...(cookie ? { sessionToken: cookie } : {}),
    ...(token !== undefined ? { bearerToken: token } : {}),
    ip: clientIp(request)
  });
}

/* ───────────── WebSocket upgrade ───────────── */

/**
 * Authenticate a WebSocket upgrade: the session cookie (only from an allowed
 * origin, so other sites can't ride on it) or `?token=` (owner token).
 */
export function authenticateUpgrade(identity: IdentityService, request: IncomingMessage, allowedOrigins?: string[]): Promise<Authenticated | undefined> {
  return authenticateRequest(identity, request, allowedOrigins);
}

/* ───────────── gate for the older APIs ───────────── */

export interface ProtectedRoute {
  permission: Permission;
}

/** Which permission an /api/uploads, /api/memory, /api/slides or /api/monitors request needs (undefined: not one of them). */
export function protectedRoutePermission(method: string, path: string): ProtectedRoute | undefined {
  const write = method !== "GET" && method !== "HEAD";
  if (path === "/api/uploads" || path.startsWith("/api/uploads/")) {
    // Attaching files is part of chatting.
    return { permission: PERMISSIONS.CHAT_USE };
  }
  if (path === "/api/media" || path.startsWith("/api/media/")) {
    // A model provider fetching a reference file: the signed, expiring link is the check (media/http.ts).
    if (path.startsWith("/api/media/ref/")) return undefined;
    // Making images, video and audio is part of chatting (budgets still apply).
    return { permission: PERMISSIONS.CHAT_USE };
  }
  if (path === "/api/memory" || path.startsWith("/api/memory/")) {
    if (!write) return { permission: PERMISSIONS.CHAT_USE };
    if (path === "/api/memory/settings") return { permission: PERMISSIONS.WORKSPACE_SETTINGS };
    return { permission: PERMISSIONS.KNOWLEDGE_EDIT };
  }
  if (path === "/api/slides" || path.startsWith("/api/slides/")) {
    return { permission: write ? PERMISSIONS.SLIDES_MANAGE : PERMISSIONS.SLIDES_USE };
  }
  if (path === "/api/monitors" || path.startsWith("/api/monitors/")) {
    // Webhook deliveries are signed (HMAC) instead of signed in.
    if (path.startsWith("/api/monitors/hooks/")) return undefined;
    return { permission: write ? PERMISSIONS.MONITORS_MANAGE : PERMISSIONS.MONITORS_USE };
  }
  if (path === "/api/knowledge" || path.startsWith("/api/knowledge/")) {
    if (!write) return { permission: PERMISSIONS.KNOWLEDGE_VIEW };
    if (path === "/api/knowledge/settings") return { permission: PERMISSIONS.WORKSPACE_SETTINGS };
    // Creating, renaming and deleting bases; documents and "save to knowledge" are edits.
    if (path === "/api/knowledge" || /^\/api\/knowledge\/[^/]+$/.test(path)) {
      return { permission: path === "/api/knowledge/save-upload" ? PERMISSIONS.KNOWLEDGE_EDIT : PERMISSIONS.KNOWLEDGE_MANAGE };
    }
    return { permission: PERMISSIONS.KNOWLEDGE_EDIT };
  }
  if (path === "/api/skills" || path.startsWith("/api/skills/")) {
    return { permission: write ? PERMISSIONS.SKILLS_EDIT : PERMISSIONS.SKILLS_USE };
  }
  if (path === "/api/plugins" || path.startsWith("/api/plugins/")) {
    if (!write) return { permission: PERMISSIONS.SKILLS_USE };
    if (/^\/api\/plugins\/[^/]+\/routines$/.test(path)) return { permission: PERMISSIONS.ROUTINES_MANAGE };
    return { permission: PERMISSIONS.PLUGINS_INSTALL };
  }
  if (path === "/api/connectors" || path.startsWith("/api/connectors/")) {
    // The OAuth callback is reached by the vendor's redirect: checked by its
    // single-use state, bound to the person and session that started it.
    if (path === "/api/connectors/oauth/callback") return undefined;
    if (!write) return { permission: PERMISSIONS.INTEGRATIONS_USE };
    // The organization's OAuth apps (client ID/secret, allowed groups).
    if (path.startsWith("/api/connectors/apps/")) return { permission: PERMISSIONS.ORG_SETTINGS };
    // Connect, change, test, remove: personal at least; shared connections
    // additionally need integrations.connect_shared (checked by the handler).
    return { permission: PERMISSIONS.INTEGRATIONS_CONNECT_PERSONAL };
  }
  if (path === "/api/presence" || path.startsWith("/api/presence/")) {
    // Slack events and Graph notifications are signed / carry the subscription's clientState instead.
    if (path === "/api/presence/slack/events" || path.startsWith("/api/presence/teams/")) return undefined;
    // The workspace's notifications channel: who may set up shared integrations.
    if (path === "/api/presence/settings") return { permission: write ? PERMISSIONS.INTEGRATIONS_CONNECT_SHARED : PERMISSIONS.INTEGRATIONS_USE };
    if (path === "/api/presence/channels") return { permission: PERMISSIONS.INTEGRATIONS_USE };
    // An agent's channels: agents.use to see; the handler also requires editing rights on the agent and integrations.use.
    return { permission: PERMISSIONS.AGENTS_USE };
  }
  if (path === "/api/usage-controls" || path.startsWith("/api/usage-controls/")) {
    // Enterprise advanced usage controls (ee/gateway/usage): reports are usage.view, settings budgets.manage.
    return { permission: write ? PERMISSIONS.BUDGETS_MANAGE : PERMISSIONS.USAGE_VIEW };
  }
  if (path === "/api/realtime" || path.startsWith("/api/realtime/")) {
    // LiveKit's webhook is signed instead (realtime/http.ts).
    if (path === "/api/realtime/webhook") return undefined;
    // The phone line (SIP trunks) belongs to the organization.
    if (path === "/api/realtime/phone" || path.startsWith("/api/realtime/phone/")) return { permission: PERMISSIONS.ORG_SETTINGS };
    // The phone line's call log: the people who see every chat of the workspace (calls are chats).
    if (path === "/api/realtime/calls") return { permission: PERMISSIONS.CHAT_VIEW_ALL };
    // Starting or stopping a stream an agent listens to is a write action.
    if (path.startsWith("/api/realtime/streams") && write) return { permission: PERMISSIONS.TOOLS_WRITE };
    return { permission: PERMISSIONS.CHAT_USE };
  }
  if (path === "/api/meetings" || path.startsWith("/api/meetings/")) {
    // Guests (no account) knock with the guest-link key and poll their lobby ticket (meetings/http.ts).
    if (isMeetingGuestRoute(method, path)) return undefined;
    // Joining, hosting, notes and comments are part of chatting in the workspace; host-only actions are checked by the handler.
    return { permission: PERMISSIONS.CHAT_USE };
  }
  if (path === "/api/recordings" || path.startsWith("/api/recordings/")) {
    // Call recordings (Sibyl Enterprise; without the licence the route is absent: 404).
    return { permission: PERMISSIONS.CALLS_RECORD };
  }
  if (path === "/api/model-access" || path === "/api/model-access/key") {
    // The organization's own OpenRouter key: anyone who chats sees its status; owners and admins change it.
    return { permission: write ? PERMISSIONS.ORG_SETTINGS : PERMISSIONS.CHAT_USE };
  }
  if (path === "/api/voice-engine" || path.startsWith("/api/voice-engine/")) {
    // Voice engines (GPT Realtime): everyone who chats sees them; the OpenAI key is the organization's, the switch the workspace's.
    if (!write) return { permission: PERMISSIONS.CHAT_USE };
    return { permission: path === "/api/voice-engine/policy" ? PERMISSIONS.WORKSPACE_SETTINGS : PERMISSIONS.ORG_SETTINGS };
  }
  if (path === "/api/onboarding" || path === "/api/onboarding/profile") {
    // Your own onboarding and checklist (steps are filtered by permission in onboarding/service.ts).
    return { permission: PERMISSIONS.CHAT_USE };
  }
  if (path === "/api/credits" || path === "/api/credits/purchase") {
    // AI credits (hosted): the balance is usage; buying is billing.
    return { permission: write ? PERMISSIONS.ORG_BILLING : PERMISSIONS.USAGE_VIEW };
  }
  if (path === "/api/license" || path.startsWith("/api/license/")) {
    // Edition, seats and the key itself: organization owners and admins only.
    return { permission: PERMISSIONS.ORG_SETTINGS };
  }
  if (path === "/api/admin" || path.startsWith("/api/admin/")) {
    // Enterprise admin APIs: the audit log needs audit.view; roles, policies and second approvals org.settings.
    if (path === "/api/admin/audit" || path.startsWith("/api/admin/audit/")) return { permission: PERMISSIONS.AUDIT_VIEW };
    // Organization settings and the people list (open source, org-http.ts): org.settings; finer rules in OrgAdmin.
    if (path === "/api/admin/org" || isUnder(path, "/api/admin/users") || path.startsWith("/api/admin/invites/")) return { permission: PERMISSIONS.ORG_SETTINGS };
    return { permission: PERMISSIONS.ORG_SETTINGS };
  }
  return undefined;
}

/**
 * Run before the API handlers. Returns true when the request may proceed
 * (the caller is then bound to the request: see requestCaller()); false when
 * a 401/403 reply was already sent. Preflights always proceed (the handler's
 * corsGuard answers them).
 */
export async function gateProtectedRoute(
  options: IdentityHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  route: ProtectedRoute
): Promise<boolean> {
  if (request.method === "OPTIONS") return true;
  const cors = corsHeaders(request, options.allowedOrigins) ?? {};
  const auth = await authenticateRequest(options.identity, request, options.allowedOrigins);
  if (!auth) {
    request.resume();
    sendError(response, 401, "unauthorized", "Sign in to continue.", cors);
    return false;
  }
  const workspaceId = requestWorkspace(request);
  if (!authorize(auth.principal, route.permission, { workspaceId })) {
    request.resume();
    sendJson(response, 403, { error: "forbidden", permission: route.permission, message: "You don't have permission to do that." }, cors);
    return false;
  }
  bindCaller(request, auth);
  return true;
}

/* ───────────── identity routes ───────────── */

export function isIdentityPath(path: string): boolean {
  return (
    path === "/api/auth" ||
    path.startsWith("/api/auth/") ||
    path === "/api/invites" ||
    path.startsWith("/api/invites/") ||
    path === "/api/workspaces" ||
    path.startsWith("/api/workspaces/")
  );
}

/** Returns true when the request is an identity route (and is being handled). */
export function handleIdentityHttp(options: IdentityHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isIdentityPath(path)) return false;
  void serve(options, request, response, path).catch((error: unknown) => {
    options.log?.("identity.http_failed", { path, error: error instanceof Error ? error.message : String(error) });
    sendError(response, 500, "internal_error", "Something went wrong.");
  });
  return true;
}

async function serve(options: IdentityHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const { identity } = options;
  const cors = corsHeaders(request, options.allowedOrigins);
  if (!cors) {
    request.resume();
    return sendError(response, 403, "origin_not_allowed");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, cors);
    response.end();
    return;
  }
  const method = request.method ?? "GET";
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => sendJson(response, status, body, { ...cors, ...headers });
  const segments = path.split("/").filter(Boolean).slice(1); // drop "api"
  const body = () => readJsonObject(request, 32 * 1024);
  const auth = await authenticateRequest(identity, request, options.allowedOrigins);
  const requireAuth = (): Authenticated => {
    if (!auth) throw new IdentityError(401, "unauthorized", "Sign in to continue.");
    return auth;
  };
  const appUrl = (): string => webAppUrl(options, request);
  const withSession = (token: string) => ({ "set-cookie": sessionCookie(token, request, options.secureCookies) });
  /** Signed in, or the second step (two-step verification) still to do. */
  const signInReply = async (result: SignInResult, extra: Record<string, unknown> = {}) =>
    "token" in result
      ? reply(200, { ...(await identity.me(await identity.resolveSession(result.token))), ...extra }, withSession(result.token))
      : reply(200, { ...(await identity.me(undefined)), ...extra, mfa: result.mfa });

  /** /api/auth/mfa…: the sign-in second step, and turning two-step verification on and off for yourself. */
  const serveMfa = async (action: string | undefined, extra: string | undefined): Promise<void> => {
    if (extra !== undefined) {
      request.resume();
      return reply(404, { error: "not_found" });
    }
    if (action === "verify" && method === "POST") {
      const input = await body();
      const done = await identity.completeMfa(input.challenge, { code: input.code, recoveryCode: input.recoveryCode }, clientIp(request));
      return reply(
        200,
        {
          ...(await identity.me(await identity.resolveSession(done.token))),
          ...(done.recoveryCodes ? { recoveryCodes: done.recoveryCodes } : {}),
          ...(done.workspaceId ? { workspaceId: done.workspaceId } : {})
        },
        withSession(done.token)
      );
    }
    const user = requireAuth().user;
    if (!user) throw new IdentityError(400, "not_a_user", "Two-step verification is for people signed in with an account.");
    if (!action && method === "GET") {
      request.resume();
      // Accounts made by SSO/SCIM have no password: their identity provider does the second factor.
      return reply(200, { ...(await identity.mfa.status(user.id)), passwordSignIn: user.passwordHash.startsWith("scrypt$") });
    }
    if (method !== "POST") {
      request.resume();
      return reply(404, { error: "not_found" });
    }
    const input = await body();
    const code = typeof input.code === "string" ? input.code : "";
    if (action === "setup") {
      if (await identity.mfa.enabled(user.id)) throw new IdentityError(409, "mfa_enabled", "Two-step verification is already on.");
      return reply(200, identity.mfa.beginSetup(user));
    }
    if (action === "enable") {
      const codes = await identity.mfa.enable(user.id, typeof input.setupToken === "string" ? input.setupToken : "", code);
      if (!codes) throw new IdentityError(400, "invalid_code", "That code isn't right. Check the time on your phone and try the current code.");
      options.log?.("identity.mfa_enabled", { userId: user.id });
      return reply(200, { recoveryCodes: codes, status: await identity.mfa.status(user.id) });
    }
    // Turning it off or replacing recovery codes needs a current code (or a recovery code).
    const proven = await identity.mfa.verify(user.id, {
      ...(code ? { code } : {}),
      ...(typeof input.recoveryCode === "string" && input.recoveryCode ? { recoveryCode: input.recoveryCode } : {})
    });
    if (!proven) throw new IdentityError(400, "invalid_code", "That code isn't right.");
    if (action === "disable") {
      await identity.mfa.disable(user.id);
      options.log?.("identity.mfa_disabled", { userId: user.id });
      return reply(200, { status: await identity.mfa.status(user.id) });
    }
    if (action === "recovery-codes") {
      return reply(200, { recoveryCodes: await identity.mfa.regenerateRecoveryCodes(user.id), status: await identity.mfa.status(user.id) });
    }
    return reply(404, { error: "not_found" });
  };

  try {
    const [area, id, sub, subId] = segments as [string, string | undefined, string | undefined, string | undefined];

    /* auth */
    if (area === "auth") {
      if (id === "me" && method === "GET") {
        // Re-set the cookie so the 30-day expiry slides with use.
        const token = sessionTokenOf(request);
        const headers = auth?.session && token ? withSession(token) : {};
        const me = await identity.me(auth);
        // The web app's hasFeature() reads these: one source for "is this licensed?".
        return reply(200, { ...me, features: me.authenticated ? (options.features?.() ?? []) : [] }, headers);
      }
      if (id === "setup" && method === "POST") {
        const input = await body();
        const ownerTokenOk = auth?.principal.kind === "token";
        const created = await identity.setup({ email: input.email, name: input.name, password: input.password }, { ownerTokenOk });
        const signedIn = await identity.resolveSession(created.token);
        return reply(201, await identity.me(signedIn), withSession(created.token));
      }
      if (id === "login" && method === "POST") {
        const input = await body();
        return signInReply(await identity.login({ email: input.email, password: input.password }, clientIp(request)));
      }
      if (id === "providers" && !sub && method === "GET") {
        // The sign-in screen: password always (break-glass), plus SSO providers (Sibyl Enterprise).
        request.resume();
        return reply(200, { password: true, providers: await identity.signInProviders() });
      }
      if (id === "mfa") return await serveMfa(sub, subId);
      if (id === "logout" && method === "POST") {
        request.resume();
        await identity.logout(sessionTokenOf(request));
        return reply(200, { ok: true }, { "set-cookie": clearCookie(request, options.secureCookies) });
      }
      request.resume();
      return reply(404, { error: "not_found" });
    }

    /* invitations */
    if (area === "invites") {
      if (!id && method === "GET") {
        request.resume();
        const workspaceId = queryParam(request, "workspaceId") || DEFAULT_WORKSPACE_ID;
        return reply(200, { invites: await identity.listInvites(requireAuth().principal, workspaceId) });
      }
      if (!id && method === "POST") {
        const input = await body();
        const created = await identity.createInvite(requireAuth().principal, { workspaceId: input.workspaceId, role: input.role, email: input.email }, appUrl());
        return reply(201, created);
      }
      if (id && ID.test(id) && !sub && method === "DELETE") {
        request.resume();
        await identity.revokeInvite(requireAuth().principal, id);
        return reply(200, { ok: true });
      }
      if (id && ID.test(id) && !sub && method === "GET") {
        request.resume();
        return reply(200, await identity.previewInvite(id));
      }
      if (id && ID.test(id) && sub === "accept" && method === "POST") {
        const input = await body();
        const signedIn = auth?.principal.kind === "user" ? auth : undefined;
        const accepted = await identity.acceptInvite(id, { name: input.name, email: input.email, password: input.password }, signedIn, clientIp(request));
        if (accepted.mfa) return reply(200, { ...(await identity.me(undefined)), workspaceId: accepted.workspaceId, mfa: accepted.mfa });
        const session = accepted.token ? await identity.resolveSession(accepted.token) : signedIn;
        return reply(200, { ...(await identity.me(session)), workspaceId: accepted.workspaceId }, accepted.token ? withSession(accepted.token) : {});
      }
      request.resume();
      return reply(404, { error: "not_found" });
    }

    /* workspaces & members */
    if (area === "workspaces") {
      const { principal } = requireAuth();
      if (!id) {
        if (method === "GET") {
          request.resume();
          return reply(200, { workspaces: await identity.listWorkspaces(principal) });
        }
        if (method === "POST") {
          const input = await body();
          return reply(201, { workspace: await identity.createWorkspace(principal, { name: input.name, icon: input.icon, instructions: input.instructions }) });
        }
      } else if (ID.test(id)) {
        if (!sub) {
          if (method === "PATCH") {
            const input = await body();
            return reply(200, { workspace: await identity.updateWorkspace(principal, id, input) });
          }
          if (method === "DELETE") {
            request.resume();
            await identity.deleteWorkspace(principal, id);
            return reply(200, { ok: true });
          }
        }
        if (sub === "members" && !subId && method === "GET") {
          request.resume();
          return reply(200, { members: await identity.listMembers(principal, id) });
        }
        if (sub === "members" && subId && ID.test(subId)) {
          if (method === "PATCH") {
            const input = await body();
            return reply(200, { members: await identity.setMemberRole(principal, id, subId, input.role) });
          }
          if (method === "DELETE") {
            request.resume();
            await identity.removeMember(principal, id, subId);
            return reply(200, { ok: true });
          }
        }
        if (sub === "leave" && method === "POST") {
          request.resume();
          if (principal.kind !== "user") throw new IdentityError(400, "not_a_user", "Only signed-in people can leave a workspace.");
          await identity.removeMember(principal, id, principal.userId!);
          return reply(200, { ok: true });
        }
      }
      request.resume();
      return reply(404, { error: "not_found" });
    }

    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    request.resume();
    if (error instanceof MfaUnavailableError) return reply(503, { error: "mfa_unavailable", message: error.message });
    if (error instanceof IdentityError) {
      return reply(
        error.status,
        { error: error.code, message: error.message },
        error.retryAfter ? { "retry-after": String(error.retryAfter) } : {}
      );
    }
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}

/* ───────────── enterprise bridge ───────────── */

/** Where the web app lives: the request's allowed Origin, else SIBYL_APP_URL, else the Origin / localhost:3000. */
export function webAppUrl(options: Pick<IdentityHttpOptions, "identity" | "allowedOrigins">, request: IncomingMessage): string {
  const origin = request.headers.origin;
  if (origin && options.allowedOrigins?.length && options.allowedOrigins.includes(origin)) return origin;
  if (options.identity.appUrl) return options.identity.appUrl;
  // A top-level navigation (SSO start/callback) has no Origin: the first allowed origin is the app.
  return origin ?? options.allowedOrigins?.[0] ?? "http://localhost:3000";
}

/**
 * The IdentityBridge enterprise identity extensions get (SSO providers sign
 * people in through it): the same cookie, session and sign-in rules as
 * password sign-in.
 */
export function createIdentityBridge(options: IdentityHttpOptions & { env: NodeJS.ProcessEnv; secrets?: IdentitySecrets }): IdentityBridge {
  const { identity } = options;
  return {
    orgId: identity.orgId,
    allowedOrigins: options.allowedOrigins ?? [],
    authenticate: (request) => authenticateRequest(identity, request, options.allowedOrigins),
    async createSession(request, userId, method) {
      const { token } = await identity.signInExternal(userId, method, clientIp(request));
      return { setCookie: sessionCookie(token, request, options.secureCookies) };
    },
    endSessions: (userId) => identity.endSessions(userId),
    changed: (change) => identity.notifyChange(change),
    clientIp,
    appUrl: (request) => webAppUrl(options, request).replace(/\/+$/, ""),
    gatewayUrl: (request) => options.env.SIBYL_PUBLIC_GATEWAY_URL?.trim().replace(/\/+$/, "") || requestOrigin(request),
    ...(options.secrets ? { secrets: options.secrets } : {})
  };
}
