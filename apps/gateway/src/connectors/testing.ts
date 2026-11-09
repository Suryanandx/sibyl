/**
 * Test helpers: a fake vendor (OAuth token endpoint + API routes) on a local
 * HTTP server, and principals. Used by the connector tests (open source and
 * ee/). Not imported by the gateway itself.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Principal, Role } from "@open-gpt-live/core";

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
}

export type FakeRoute = (request: RecordedRequest) => { status?: number; headers?: Record<string, string>; json?: unknown; text?: string; raw?: Buffer; public?: boolean } | undefined;

export interface FakeVendor {
  url: string;
  requests: RecordedRequest[];
  /** Access tokens handed out (valid until revoked/expired by the test). */
  issued: Array<{ access: string; refresh?: string }>;
  validTokens: Set<string>;
  revoked: string[];
  /** Codes accepted at the token endpoint → their PKCE challenge (or "" for none). */
  codes: Map<string, { challenge: string; extra?: Record<string, unknown> }>;
  /** Make the next refresh fail with this status/body. */
  failRefresh?: { status: number; body: unknown };
  route(method: string, path: string | RegExp, handler: FakeRoute): void;
  /** Register a code for the callback (as if the person approved). */
  approve(challenge: string, extra?: Record<string, unknown>): string;
  close(): Promise<void>;
}

export interface FakeVendorOptions {
  clientId: string;
  clientSecret: string;
  /** Token lifetime in seconds (default 3600). */
  expiresIn?: number;
  /** "scope" to report in token responses. */
  scope?: string;
  /** Token endpoint path (default /token). */
  tokenPath?: string;
  /** Revoke endpoint path (default /revoke). */
  revokePath?: string;
  /** Extra fields on every token response (e.g. instance_url). */
  tokenExtra?: (vendorUrl: string) => Record<string, unknown>;
}

export async function startFakeVendor(options: FakeVendorOptions): Promise<FakeVendor> {
  const routes: Array<{ method: string; path: string | RegExp; handler: FakeRoute }> = [];
  const requests: RecordedRequest[] = [];
  const validTokens = new Set<string>();
  const issued: FakeVendor["issued"] = [];
  const revoked: string[] = [];
  const codes = new Map<string, { challenge: string; extra?: Record<string, unknown> }>();
  const refreshTokens = new Set<string>();
  let vendor: FakeVendor;

  const issue = (extra?: Record<string, unknown>) => {
    const access = `at-${randomBytes(12).toString("hex")}`;
    const refresh = `rt-${randomBytes(12).toString("hex")}`;
    validTokens.add(access);
    refreshTokens.add(refresh);
    issued.push({ access, refresh });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      ...(options.scope ? { scope: options.scope } : {}),
      ...options.tokenExtra?.(vendor.url),
      ...extra
    };
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const recorded: RecordedRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(recorded);
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (recorded.method === "POST" && recorded.path === (options.tokenPath ?? "/token")) {
        const form = new URLSearchParams(recorded.body);
        if (form.get("client_id") !== options.clientId || form.get("client_secret") !== options.clientSecret) return send(401, { error: "invalid_client" });
        if (form.get("grant_type") === "authorization_code") {
          const code = codes.get(form.get("code") ?? "");
          if (!code) return send(400, { error: "invalid_grant", error_description: "bad code" });
          codes.delete(form.get("code")!);
          if (code.challenge) {
            const verifier = form.get("code_verifier") ?? "";
            const expected = createHash("sha256").update(verifier).digest("base64url");
            if (expected !== code.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          }
          return send(200, issue(code.extra));
        }
        if (form.get("grant_type") === "refresh_token") {
          if (vendor.failRefresh) {
            const failure = vendor.failRefresh;
            return send(failure.status, failure.body);
          }
          if (!refreshTokens.has(form.get("refresh_token") ?? "")) return send(400, { error: "invalid_grant" });
          const token = issue();
          // Keep the old refresh token valid (most vendors do not rotate on every refresh).
          return send(200, { ...token, refresh_token: undefined });
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      if (recorded.method === "POST" && recorded.path === (options.revokePath ?? "/revoke")) {
        const token = new URLSearchParams(recorded.body).get("token") ?? "";
        revoked.push(token);
        refreshTokens.delete(token);
        validTokens.delete(token);
        return send(200, {});
      }
      for (const route of routes) {
        if (route.method !== recorded.method) continue;
        if (typeof route.path === "string" ? route.path !== recorded.path : !route.path.test(recorded.path)) continue;
        const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
        const result = route.handler(recorded);
        if (!result) continue;
        if (!result.public && (!bearer || !validTokens.has(bearer))) return send(401, { error: { message: "invalid token" } });
        if (result.raw) {
          res.writeHead(result.status ?? 200, { "content-type": "application/octet-stream", ...result.headers });
          return res.end(result.raw);
        }
        if (result.text !== undefined) {
          res.writeHead(result.status ?? 200, { "content-type": "text/plain", ...result.headers });
          return res.end(result.text);
        }
        return send(result.status ?? 200, result.json, result.headers);
      }
      return send(404, { error: { message: `no fake route for ${recorded.method} ${recorded.path}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  vendor = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    issued,
    validTokens,
    revoked,
    codes,
    route(method, path, handler) {
      routes.push({ method, path, handler });
    },
    approve(challenge, extra) {
      const code = `code-${randomBytes(8).toString("hex")}`;
      codes.set(code, { challenge, ...(extra ? { extra } : {}) });
      return code;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
  return vendor;
}

export function userPrincipal(userId: string, roles: Record<string, Role>, orgRole?: Role): Principal {
  return { kind: "user", orgId: "owner", userId, ...(orgRole ? { orgRole } : {}), workspaceRoles: roles };
}

/** The OAuth `state` and PKCE challenge from an authorize URL. */
export function authorizeParams(url: string): { state: string; challenge: string; scope: string; redirectUri: string; clientId: string } {
  const parsed = new URL(url);
  return {
    state: parsed.searchParams.get("state") ?? "",
    challenge: parsed.searchParams.get("code_challenge") ?? "",
    scope: parsed.searchParams.get("scope") ?? "",
    redirectUri: parsed.searchParams.get("redirect_uri") ?? "",
    clientId: parsed.searchParams.get("client_id") ?? ""
  };
}
