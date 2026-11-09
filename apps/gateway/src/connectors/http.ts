/**
 * /api/connectors — the Integrations screen's API (see the protocol's
 * "Integrations (v0.4)" block for the routes).
 *
 * Every route except the OAuth callback runs behind the identity gate
 * (identity/http.ts → protectedRoutePermission); this handler then checks
 * the finer rules itself (personal vs shared, org settings for apps). The
 * callback is reached by the vendor's redirect: it is accepted only with a
 * valid, unused `state` that belongs to the same signed-in person and
 * browser session that started the flow.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IdentityService } from "../identity/service.js";
import { authenticateRequest, sessionTokenOf } from "../identity/http.js";
import { corsGuard, isUnder, readJsonObject, requestCaller, requestOrigin, requestPath, requestUrl, requestWorkspace, runRoute, sendBodyError, sendJson } from "../http/index.js";
import { bindingMatches, hashBinding } from "./oauth.js";
import { CALLBACK_PATH, ConnectorService, ownerKeyOf, type Actor } from "./service.js";
import { ConnectorError } from "./types.js";

export interface ConnectorsHttpOptions {
  connectors?: ConnectorService;
  identity: IdentityService;
  allowedOrigins?: string[];
  env?: NodeJS.ProcessEnv;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isConnectorsPath(path: string): boolean {
  return isUnder(path, "/api/connectors");
}

/** Returns true when the request was for /api/connectors (and is being handled). */
export function handleConnectorsHttp(options: ConnectorsHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isConnectorsPath(path)) return false;
  return runRoute(response, options.log, "connectors.http_failed", serve(options, request, response, path));
}


async function serve(options: ConnectorsHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  if (path === CALLBACK_PATH) return callback(options, request, response);

  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const service = options.connectors;
  if (!service) {
    request.resume();
    return reply(503, { error: "unavailable", message: "Integrations need the secrets vault (set SIBYL_SECRET_KEY or keep data/secret.key)." });
  }
  // Set by the identity gate in front of this route.
  const auth = requestCaller(request);
  if (!auth) {
    request.resume();
    return reply(401, { error: "unauthorized", message: "Sign in to continue." });
  }
  const principal = auth.principal;
  const workspaceId = requestWorkspace(request);
  const origin = requestOrigin(request);
  const method = request.method ?? "GET";
  const segments = path.split("/").filter(Boolean).slice(2); // drop "api", "connectors"
  const cookie = sessionTokenOf(request);
  const actor: Actor = {
    principal,
    binding: hashBinding(principal.kind === "user" && cookie ? `session:${cookie}` : `principal:${ownerKeyOf(principal)}`),
    ...(auth.user?.name || auth.user?.email ? { name: auth.user?.name || auth.user?.email } : {})
  };
  const body = () => readJsonObject(request, 32 * 1024);

  try {
    if (segments.length === 0 && method === "GET") return reply(200, await service.stateFor(principal, workspaceId, origin));

    // /api/connectors/apps/:id
    if (segments[0] === "apps" && segments.length === 2 && ID.test(segments[1]!)) {
      if (method === "PUT") {
        const input = await body();
        await service.setApp(principal, segments[1]!, input);
        return reply(200, await service.stateFor(principal, workspaceId, origin));
      }
      if (method === "DELETE") {
        request.resume();
        await service.removeApp(principal, segments[1]!);
        return reply(200, await service.stateFor(principal, workspaceId, origin));
      }
    }

    // /api/connectors/connections/:id[/test]
    if (segments[0] === "connections" && segments[1] && ID.test(segments[1])) {
      const id = segments[1];
      if (segments.length === 2 && method === "PATCH") {
        const input = await body();
        const record = await service.updateConnection(principal, id, { groups: input.groups });
        return reply(200, { connection: service.connectionView(principal, record) });
      }
      if (segments.length === 2 && method === "DELETE") {
        request.resume();
        await service.disconnect(principal, id);
        return reply(200, { ok: true });
      }
      if (segments.length === 3 && segments[2] === "test" && method === "POST") {
        request.resume();
        const record = await service.testConnection(principal, id);
        return reply(200, { connection: service.connectionView(principal, record) });
      }
      if (segments.length === 3 && segments[2] === "reconnect" && method === "POST") {
        const input = await body();
        const record = service.store.get(id);
        if (!record || !service.canSee(principal, record, workspaceId)) return reply(404, { error: "not_found", message: "Connection not found" });
        const result = await service.beginOAuth(
          actor,
          { connectorId: record.connectorId, scope: record.scope, ...(input.groups !== undefined ? { groups: input.groups } : {}), workspaceId: record.workspaceId, connectionId: id },
          service.redirectUri(origin)
        );
        return reply(200, result);
      }
    }

    // /api/connectors/:id/connect
    if (segments.length === 2 && segments[1] === "connect" && ID.test(segments[0]!) && method === "POST") {
      const input = await body();
      const connectorId = segments[0]!;
      if (input.credentials !== undefined) {
        const record = await service.connectApiKey(actor, { connectorId, scope: input.scope, groups: input.groups, workspaceId, credentials: input.credentials });
        return reply(201, { connection: service.connectionView(principal, record) });
      }
      const result = await service.beginOAuth(actor, { connectorId, scope: input.scope, ...(input.groups !== undefined ? { groups: input.groups } : {}), workspaceId }, service.redirectUri(origin));
      return reply(200, result);
    }

    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ConnectorError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}

/** GET /api/connectors/oauth/callback?code&state — finishes the flow, shows a small page. */
async function callback(options: ConnectorsHttpOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  request.resume();
  const service = options.connectors;
  const params = requestUrl(request).searchParams;
  if (request.method !== "GET" || !service) return page(response, options, 400, { ok: false, message: "Integrations are not available on this gateway." });
  try {
    const { connection, connector } = await service.completeOAuth(
      { state: params.get("state"), code: params.get("code"), error: params.get("error") },
      async (pending) => {
        // The same person and the same browser session that started it.
        const auth = await authenticateRequest(options.identity, request, options.allowedOrigins);
        if (pending.ownerKey.startsWith("user:")) {
          const cookie = sessionTokenOf(request);
          const ok = Boolean(auth && ownerKeyOf(auth.principal) === pending.ownerKey && cookie && bindingMatches(pending.binding, hashBinding(`session:${cookie}`)));
          return { ok };
        }
        if (pending.ownerKey === "local") return { ok: Boolean(auth && auth.principal.kind === "local") };
        // Owner-token flows: the browser can't carry the token on a redirect; the
        // unguessable, single-use state (bound to this flow) is the check.
        return { ok: pending.ownerKey === "token" };
      }
    );
    options.log?.("connectors.oauth_completed", { connector: connector.id, connectionId: connection.id });
    return page(response, options, 200, { ok: true, connectorId: connector.id, message: `${connector.name} is connected${connection.account ? ` as ${connection.account}` : ""}.` });
  } catch (error) {
    const known = error instanceof ConnectorError;
    options.log?.("connectors.oauth_failed", { code: known ? error.code : "internal" });
    return page(response, options, known ? Math.min(error.status, 499) : 500, { ok: false, message: known ? error.message : "Something went wrong while connecting." });
  }
}

function page(response: ServerResponse, options: ConnectorsHttpOptions, status: number, result: { ok: boolean; message: string; connectorId?: string }): void {
  const appUrl = options.env?.SIBYL_APP_URL?.trim().replace(/\/+$/, "");
  let target = "*";
  try {
    if (appUrl) target = new URL(appUrl).origin;
  } catch {
    target = "*";
  }
  const nonce = randomBytes(16).toString("base64");
  const payload = JSON.stringify({ source: "sibyl-integrations", ok: result.ok, ...(result.connectorId ? { connectorId: result.connectorId } : {}) }).replace(/</g, "\\u003c");
  const back = appUrl ? `<p><a href="${escapeHtml(`${appUrl}/integrations`)}">Back to Sibyl</a></p>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${result.ok ? "Connected" : "Not connected"} · Sibyl</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f5;color:#1d211f;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #e4e7e2;border-radius:14px;padding:28px 32px;max-width:420px}h1{font-size:18px;margin:0 0 8px}p{margin:0 0 8px;color:#646b67}a{color:#596c5d}@media (prefers-color-scheme:dark){body{background:#161817;color:#ecedea}main{background:#1b1d1c;border-color:#2b2f2d}p{color:#a3a9a5}}</style></head>
<body><main><h1>${result.ok ? "Connected" : "Couldn't connect"}</h1><p>${escapeHtml(result.message)}</p><p>You can close this window.</p>${back}</main>
<script nonce="${nonce}">try{if(window.opener){window.opener.postMessage(${payload},${JSON.stringify(target)});${result.ok ? "setTimeout(function(){window.close()},1200);" : ""}}}catch(e){}</script></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  });
  response.end(html);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
