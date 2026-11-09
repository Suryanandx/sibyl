/**
 * HTTP routes of the sign-up layer (signup.ts), listed in
 * @open-gpt-live/protocol ("Sign-up and onboarding"). They need no sign-in:
 * each one is protected by what it carries (a code, a link token, the
 * OAuth state + browser binding, a ticket or choice cookie) and by rate
 * limits. Hosted Sibyl serves them before any organization
 * (tenancy/hosted.ts); self-hosted serves them from the one organization.
 *
 * Cookies (HttpOnly, SameSite=Lax, Secure on https):
 * - `sibyl_signup`: the sign-up ticket (30 minutes; POST /api/orgs redeems it);
 * - `sibyl_signin_oauth`: binds a Google / Microsoft sign-in to the browser (10 minutes);
 * - `sibyl_choose`: a pending "which organization?" choice (5 minutes);
 * - `sibyl_session`: the session, when an existing account signs in.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SignupResult } from "@open-gpt-live/protocol";
import { corsHeaders, readJsonObject, requestOrigin, requestPath, requestUrl, sendBodyError, sendError, sendJson } from "../http/index.js";
import { clientIp, isHttps, parseCookies, sessionCookie } from "./http.js";
import { safeNext } from "./oidc.js";
import { IdentityError } from "./service.js";
import type { IdentityFor, SignupOutcome, SignupService } from "./signup.js";
import { SIGNUP_TICKET_TTL_MS } from "./signup-tickets.js";

export const SIGNUP_COOKIE = "sibyl_signup";
const OAUTH_COOKIE = "sibyl_signin_oauth";
const CHOICE_COOKIE = "sibyl_choose";
const OAUTH_PATH = /^\/api\/signup\/oauth\/(google|microsoft)\/(start|callback)$/;

export interface SignupHttpOptions {
  signup: SignupService;
  allowedOrigins?: string[];
  secureCookies?: boolean;
  env: NodeJS.ProcessEnv;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export function isSignupPath(path: string): boolean {
  return path === "/api/signup" || path.startsWith("/api/signup/");
}

/** Returns true when the request is a sign-up route (and is being handled). */
export function handleSignupHttp(options: SignupHttpOptions, request: IncomingMessage, response: ServerResponse, identityFor: IdentityFor): boolean {
  const path = requestPath(request);
  if (!isSignupPath(path)) return false;
  void serve(options, request, response, path, identityFor).catch((error: unknown) => {
    options.log?.("signup.http_failed", { path, error: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) sendError(response, 500, "internal_error", "Something went wrong.");
  });
  return true;
}

function cookie(request: IncomingMessage, options: SignupHttpOptions, name: string, value: string, maxAgeSeconds: number): string {
  return [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`, ...((options.secureCookies ?? isHttps(request)) ? ["Secure"] : [])].join("; ");
}

/** The web app: the request's allowed Origin, else SIBYL_APP_URL, else the first allowed origin. */
export function signupAppUrl(options: Pick<SignupHttpOptions, "allowedOrigins" | "env">, request: IncomingMessage): string {
  const origin = request.headers.origin;
  const allowed = options.allowedOrigins ?? [];
  if (origin && allowed.includes(origin)) return origin;
  const configured = options.env.SIBYL_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return allowed[0] ?? origin ?? "http://localhost:3000";
}

function gatewayUrl(options: SignupHttpOptions, request: IncomingMessage): string {
  return options.env.SIBYL_PUBLIC_GATEWAY_URL?.trim().replace(/\/+$/, "") || requestOrigin(request);
}

async function serve(options: SignupHttpOptions, request: IncomingMessage, response: ServerResponse, path: string, identityFor: IdentityFor): Promise<void> {
  const { signup } = options;
  const method = request.method ?? "GET";
  const oauth = OAUTH_PATH.exec(path);
  // Top-level navigations (Google / Microsoft) carry no Origin and get redirects, not JSON.
  if (oauth && method === "GET") return serveOAuth(options, request, response, oauth[1] as "google" | "microsoft", oauth[2] as "start" | "callback", identityFor);

  const cors = corsHeaders(request, options.allowedOrigins);
  if (!cors) {
    request.resume();
    return sendError(response, 403, "origin_not_allowed");
  }
  if (method === "OPTIONS") {
    request.resume();
    response.writeHead(204, cors);
    response.end();
    return;
  }
  const reply = (status: number, body: unknown, cookies: string[] = []) => {
    if (cookies.length) response.setHeader("set-cookie", cookies);
    sendJson(response, status, body, cors);
  };
  const ip = clientIp(request);
  const cookies = parseCookies(request.headers.cookie);
  const action = path.slice("/api/signup/".length);
  try {
    if (action === "options" && method === "GET") {
      request.resume();
      return reply(200, signup.available());
    }
    if (action === "email" && method === "POST") {
      const input = await readJsonObject(request, 8 * 1024);
      return reply(200, await signup.startEmail({ email: input.email, method: input.method, password: input.password, name: input.name, next: input.next }, ip, signupAppUrl(options, request)));
    }
    if (action === "code" && method === "POST") {
      const input = await readJsonObject(request, 4 * 1024);
      return outcomeReply(await signup.verifyCode({ email: input.email, code: input.code }, ip, identityFor));
    }
    if (action === "link" && method === "POST") {
      const input = await readJsonObject(request, 4 * 1024);
      return outcomeReply(await signup.redeemLink(input.token, ip, identityFor));
    }
    if (action === "choose" && method === "GET") {
      request.resume();
      return reply(200, { organizations: await signup.choiceOrganizations(cookies[CHOICE_COOKIE]) });
    }
    if (action === "choose" && method === "POST") {
      const input = await readJsonObject(request, 4 * 1024);
      return outcomeReply(await signup.choose(cookies[CHOICE_COOKIE], input.org, ip, identityFor));
    }
    if (action === "ticket" && method === "GET") {
      request.resume();
      const view = await signup.ticketView(cookies[SIGNUP_COOKIE]);
      if (!view) return reply(401, { error: "no_signup", message: "Start by verifying your email address." });
      return reply(200, view);
    }
    if (action === "ticket" && method === "DELETE") {
      request.resume();
      return reply(200, { ok: true }, [cookie(request, options, SIGNUP_COOKIE, "", 0)]);
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    request.resume();
    if (error instanceof IdentityError) {
      if (error.retryAfter) response.setHeader("retry-after", String(error.retryAfter));
      return reply(error.status, { error: error.code, message: error.message });
    }
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }

  /** JSON answer for a verified code or link (cookies set as needed). */
  function outcomeReply(outcome: SignupOutcome): void {
    const body = resultOf(outcome);
    reply(200, body, outcomeCookies(options, request, outcome));
  }
}

function resultOf(outcome: SignupOutcome): SignupResult {
  if (outcome.kind === "ticket") return { next: "org", ...outcome.view };
  if (outcome.kind === "session") return { next: "app", path: outcome.path };
  return { next: "choose", organizations: outcome.organizations };
}

function outcomeCookies(options: SignupHttpOptions, request: IncomingMessage, outcome: SignupOutcome): string[] {
  if (outcome.kind === "ticket") return [cookie(request, options, SIGNUP_COOKIE, outcome.ticket, Math.floor(SIGNUP_TICKET_TTL_MS / 1000))];
  if (outcome.kind === "session") return [sessionCookie(outcome.token, request, options.secureCookies), cookie(request, options, SIGNUP_COOKIE, "", 0), cookie(request, options, CHOICE_COOKIE, "", 0)];
  return [cookie(request, options, CHOICE_COOKIE, outcome.choice, 5 * 60)];
}

/** GET …/oauth/:provider/start and …/callback: redirects only (errors go back to the web app as ?signin_error=). */
async function serveOAuth(
  options: SignupHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  provider: "google" | "microsoft",
  step: "start" | "callback",
  identityFor: IdentityFor
): Promise<void> {
  request.resume();
  const { signup } = options;
  const app = signupAppUrl(options, request);
  const url = requestUrl(request);
  const redirectUri = `${gatewayUrl(options, request)}/api/signup/oauth/${provider}/callback`;
  const back = (target: string, cookies: string[] = []) => {
    response.writeHead(302, { location: `${app}${target}`, "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
    response.end();
  };
  try {
    if (!signup.isConfigured(provider)) throw new IdentityError(404, "not_available", "That sign-in option isn't available.");
    if (step === "start") {
      const next = safeNext(url.searchParams.get("next") ?? undefined);
      const started = await signup.startOAuth(provider, next, redirectUri, clientIp(request));
      response.writeHead(302, {
        location: started.url,
        "cache-control": "no-store",
        "set-cookie": cookie(request, options, OAUTH_COOKIE, started.binding, 600)
      });
      response.end();
      options.log?.("signup.oauth_start", { provider });
      return;
    }
    // openid-client compares the callback URL with the redirect URI: rebuild it on the registered base.
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = url.search;
    const outcome = await signup.finishOAuth(provider, request, callbackUrl, OAUTH_COOKIE, clientIp(request), identityFor);
    const clearBinding = cookie(request, options, OAUTH_COOKIE, "", 0);
    if (outcome.kind === "ticket") return back("/signup/org", [...outcomeCookies(options, request, outcome), clearBinding]);
    if (outcome.kind === "choose") return back("/login?choose=1", [...outcomeCookies(options, request, outcome), clearBinding]);
    return back(outcome.path, [...outcomeCookies(options, request, outcome), clearBinding]);
  } catch (error) {
    const code = error instanceof IdentityError ? error.code : "signin_failed";
    if (!(error instanceof IdentityError)) options.log?.("signup.oauth_error", { provider, error: error instanceof Error ? error.message : String(error) });
    // Back to the screen with a message (hosted: the sign-up screen, which also signs people in).
    const screen = signup.hosted ? "/signup" : "/login";
    return back(`${screen}?signin_error=${encodeURIComponent(code)}&provider=${provider}`, [cookie(request, options, OAUTH_COOKIE, "", 0)]);
  }
}
