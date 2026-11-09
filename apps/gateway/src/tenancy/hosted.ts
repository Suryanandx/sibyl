/**
 * Hosted request routing: which organization a request or WebSocket belongs
 * to, and the few routes that answer before any organization.
 *
 * An organization is found from (first match wins):
 * 1. a `/o/<orgId>/…` path (vendor callbacks: monitor webhooks, Slack, Teams);
 * 2. an invitation token (`/api/invites/<token>`): the inviting organization;
 * 3. the OAuth redirect's single-use state (the organization that started it);
 * 4. a LiveKit webhook's room name (rooms carry their organization);
 * 5. the session cookie (a session belongs to one organization);
 * 6. the `x-sibyl-org` header (signed-out steps: sign-in to a chosen
 *    organization, the two-step code).
 * The organization's own checks (sign-in, signatures, state) still decide;
 * routing only picks whose checks run. Nothing reaches another organization.
 *
 * Routes before any organization:
 *   POST /api/orgs {orgName, workspaceName?}  create an organization: needs a sign-up ticket
 *                                  (x-sibyl-signup-ticket header or sibyl_signup cookie); rate-limited
 *   GET  /api/orgs                 the signed-in person's organizations
 *   signed out: GET /api/auth/me, GET /api/auth/providers, POST /api/auth/login
 *               (finds the organization from the email), POST /api/auth/logout
 *   /api/platform/*                operator API (Bearer SIBYL_PLATFORM_TOKEN):
 *     POST /api/platform/orgs/:id/credits {amountUsd, note?, idempotencyKey?}
 *     GET  /api/platform/orgs/:id
 *     POST /api/platform/signup-tickets {email, name?, password?} → {ticket}
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_WORKSPACE_ID, usdToMicros, type SignupTicketVerifier, type Store } from "@open-gpt-live/core";
import { tokensMatch } from "../auth.js";
import type { HostedGatewayAccess } from "../gateway.js";
import { bearer, corsHeaders, headerValue, primeBody, queryParam, readJsonObject, requestPath, sendBodyError, sendError, sendJson } from "../http/index.js";
import { CALLBACK_PATH } from "../connectors/service.js";
import { dummyPasswordHash, hashPassword, hashToken, passwordProblem, verifyPassword } from "../identity/crypto.js";
import { clearCookie, clientIp, parseCookies, sessionCookie, sessionTokenOf } from "../identity/http.js";
import { LoginRateLimiter } from "../identity/rate-limit.js";
import { IdentityError } from "../identity/service.js";
import { SIGNUP_COOKIE, handleSignupHttp, isSignupPath } from "../identity/signup-http.js";
import type { SignupService } from "../identity/signup.js";
import { orgOfRoom } from "../realtime/rooms.js";
import { isMeetingGuestRoute } from "../meetings/routes.js";
import { WEBHOOK_PATH } from "../realtime/http.js";
import type { GatewayRuntime } from "../runtime.js";
import { CreditsError } from "./credits.js";
import { ORG_HEADER, isOrgId, splitTenantPath } from "./mode.js";
import { OrganizationError, type OrganizationService } from "./organizations.js";

export interface HostedRoutingOptions {
  store: Store;
  organizations: OrganizationService;
  /** Sign-up and the sign-in methods beyond a password (identity/signup.ts): served here, before any organization. */
  signup?: SignupService;
  /** Redeems sign-up tickets (default: the sign-up layer's, else the organization service's; both are identity/signup-tickets.ts). */
  signupTickets?: SignupTicketVerifier;
  /** Runtimes loaded right now (the OAuth callback is routed to the one that started the flow). */
  loaded(): Array<{ orgId: string; runtime: Pick<GatewayRuntime, "connectors"> }>;
  env?: NodeJS.ProcessEnv;
  /** SIBYL_PLATFORM_TOKEN: the operator API (absent: no operator API). */
  platformToken?: string;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export const SIGNUP_TICKET_HEADER = "x-sibyl-signup-ticket";
export { SIGNUP_COOKIE };
const INVITE_PATH = /^\/api\/invites\/([A-Za-z0-9_-]{1,128})(?:\/accept)?$/;
const PLATFORM_ORG = /^\/api\/platform\/orgs\/(o[0-9a-f]{24})(\/credits)?$/;

export function createHostedRouting(options: HostedRoutingOptions) {
  const now = options.now ?? Date.now;
  const known = new Set<string>();
  // Organization creation: at most 5 per address and 20 per IP an hour.
  const creations = new LoginRateLimiter({ windowMs: 60 * 60_000, perAccount: 5, perIp: 20, now });
  // Sign-in across organizations (finding the organization from the email).
  const signIns = new LoginRateLimiter({ now });

  const exists = async (orgId: string): Promise<boolean> => {
    if (known.has(orgId)) return true;
    const found = Boolean(await options.store.organizations.get(orgId));
    if (found) known.add(orgId);
    return found;
  };

  const sessionOrg = async (request: IncomingMessage): Promise<string | undefined> => {
    const token = sessionTokenOf(request);
    if (!token) return undefined;
    const session = await options.store.identity.sessions.getByTokenHash(hashToken(token));
    return session && session.expiresAt > now() ? session.orgId : undefined;
  };

  async function orgFor(request: IncomingMessage): Promise<string | undefined> {
    const path = requestPath(request);
    const prefixed = splitTenantPath(path);
    if (prefixed) {
      if (!(await exists(prefixed.orgId))) return undefined;
      // The organization's routes see their usual path.
      const query = (request.url ?? "").indexOf("?");
      request.url = prefixed.path + (query >= 0 ? request.url!.slice(query) : "");
      return prefixed.orgId;
    }
    const invite = INVITE_PATH.exec(path);
    if (invite) {
      const record = await options.store.identity.invites.getByTokenHash(hashToken(invite[1]!));
      if (record) return record.orgId;
    }
    if (path === CALLBACK_PATH) {
      const state = queryParam(request, "state") ?? "";
      const owner = options.loaded().find((tenant) => tenant.runtime.connectors?.ownsOAuthState(state));
      if (owner) return owner.orgId;
    }
    if (path === WEBHOOK_PATH && request.method === "POST") {
      try {
        const event = JSON.parse((await primeBody(request, 256 * 1024)).toString("utf8")) as { room?: { name?: unknown } };
        const orgId = typeof event.room?.name === "string" ? orgOfRoom(event.room.name) : undefined;
        if (orgId && (await exists(orgId))) return orgId;
      } catch {
        return undefined;
      }
      return undefined;
    }
    // A meeting guest link names its organization (the guest may be signed in somewhere else).
    const named = headerValue(request, ORG_HEADER);
    if (isMeetingGuestRoute(request.method ?? "GET", path) && isOrgId(named) && (await exists(named))) return named;
    const fromSession = await sessionOrg(request);
    if (fromSession) return fromSession;
    if (isOrgId(named) && (await exists(named))) return named;
    return undefined;
  }

  async function handleHosted(request: IncomingMessage, response: ServerResponse, access: HostedGatewayAccess): Promise<boolean> {
    const path = requestPath(request);
    const method = request.method ?? "GET";
    if (options.signup && isSignupPath(path)) {
      // Sign-up, emailed links and codes, Google / Microsoft: they find the organization from the verified address.
      return handleSignupHttp(
        { signup: options.signup, allowedOrigins: access.allowedOrigins, ...(access.secureCookies !== undefined ? { secureCookies: access.secureCookies } : {}), env: options.env ?? process.env, ...(options.log ? { log: options.log } : {}) },
        request,
        response,
        async (orgId) => (await access.gatewayFor(orgId)).identity
      );
    }
    const isPlatform = path === "/api/platform" || path.startsWith("/api/platform/");
    const isOrgs = path === "/api/orgs";
    const signedOutRoute = path === "/api/auth/me" || path === "/api/auth/providers" || path === "/api/auth/login" || path === "/api/auth/logout" || path === "/api/auth/setup";
    if (!isPlatform && !isOrgs && !signedOutRoute) return false;
    const cors = corsHeaders(request, access.allowedOrigins);
    if (!cors) {
      request.resume();
      sendError(response, 403, "origin_not_allowed");
      return true;
    }
    if (method === "OPTIONS") {
      request.resume();
      response.writeHead(204, cors);
      response.end();
      return true;
    }
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => sendJson(response, status, body, { ...cors, ...headers });
    try {
      if (isPlatform) return await platform(request, path, method, reply, access);
      if (isOrgs) return await organizations(request, response, method, reply, access);
      // Sign-in picks its organization itself (the one named, else the email's), whatever the cookie says.
      if (path === "/api/auth/login" && method === "POST") return await discoverSignIn(request, response, reply, access);
      // A signed-in browser (or one that named its organization) is served by its organization.
      const orgId = await orgFor(request);
      if (orgId) return false;
      request.resume();
      if (path === "/api/auth/me" && method === "GET") {
        return reply(200, { authenticated: false, mode: "signin", next: "login", setupAvailable: false, ownerTokenRequired: false, smtp: false, user: null, workspaces: [], permissions: {}, features: [], hosted: true }), true;
      }
      if (path === "/api/auth/providers" && method === "GET") return reply(200, { password: true, providers: [] }), true;
      if (path === "/api/auth/logout" && method === "POST") return reply(200, { ok: true }, { "set-cookie": clearCookie(request, access.secureCookies) }), true;
      if (path === "/api/auth/setup") return reply(404, { error: "not_available", message: "Create an organization at sign-up instead." }), true;
      return reply(404, { error: "not_found" }), true;
    } catch (error) {
      request.resume();
      if (error instanceof OrganizationError || error instanceof IdentityError || error instanceof CreditsError) {
        reply(error.status, { error: error.code, message: error.message }, error instanceof IdentityError && error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
        return true;
      }
      if (sendBodyError(response, error, cors)) return true;
      throw error;
    }
  }

  /** Sign-in without a chosen organization: the organization of the account with this email and password. */
  async function discoverSignIn(request: IncomingMessage, response: ServerResponse, reply: (status: number, body: unknown, headers?: Record<string, string>) => void, access: HostedGatewayAccess): Promise<true> {
    const body = await primeBody(request, 32 * 1024);
    const input = (body.byteLength ? JSON.parse(body.toString("utf8")) : {}) as { email?: unknown; password?: unknown; org?: unknown };
    const named = isOrgId(input.org) ? input.org : headerValue(request, ORG_HEADER);
    if (isOrgId(named) && (await exists(named))) {
      (await access.gatewayFor(named)).serve(request, response);
      return true;
    }
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const ip = clientIp(request);
    const wait = signIns.retryAfter(ip, email);
    if (wait > 0) throw new IdentityError(429, "rate_limited", `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.`, wait);
    const accounts = email ? (await options.store.identity.users.listByEmail(email)).filter((user) => user.disabledAt === undefined && user.removedAt === undefined) : [];
    if (accounts.length === 1) {
      (await access.gatewayFor(accounts[0]!.orgId)).serve(request, response);
      return true;
    }
    // Several organizations: only those whose account this password opens (an unknown email costs the same scrypt).
    const matches: string[] = [];
    for (const account of accounts.length ? accounts : [undefined]) {
      if (await verifyPassword(password, account?.passwordHash ?? (await dummyPasswordHash()))) matches.push(account!.orgId);
    }
    if (matches.length === 0) {
      signIns.fail(ip, email);
      throw new IdentityError(401, "invalid_credentials", "That email and password don't match.");
    }
    signIns.succeed(ip, email);
    if (matches.length === 1) {
      (await access.gatewayFor(matches[0]!)).serve(request, response);
      return true;
    }
    const records = await options.store.organizations.getMany(matches);
    reply(409, { error: "choose_organization", message: "Your account is in more than one organization. Choose one.", organizations: records.map((record) => ({ id: record.id, name: record.name })) });
    return true;
  }

  /** POST /api/orgs (create) and GET /api/orgs (mine). */
  async function organizations(request: IncomingMessage, response: ServerResponse, method: string, reply: (status: number, body: unknown, headers?: Record<string, string>) => void, access: HostedGatewayAccess): Promise<true> {
    const currentOrg = await sessionOrg(request);
    const signedIn = currentOrg ? await (await access.gatewayFor(currentOrg)).identity.authenticate({ sessionToken: sessionTokenOf(request)!, ip: clientIp(request) }) : undefined;
    if (method === "GET") {
      request.resume();
      if (!signedIn?.user) return reply(401, { error: "unauthorized", message: "Sign in to continue." }), true;
      return reply(200, { organizations: await options.organizations.listFor(signedIn.user) }), true;
    }
    if (method !== "POST") {
      request.resume();
      return reply(405, { error: "method_not_allowed" }), true;
    }
    const input = await readJsonObject(request, 16 * 1024);
    const ip = clientIp(request);
    // The sign-up ticket proves the address; a signed-in person with a verified address may add another organization.
    const ticketText = headerValue(request, SIGNUP_TICKET_HEADER) || parseCookies(request.headers.cookie)[SIGNUP_COOKIE];
    const tickets = options.signupTickets ?? options.signup?.tickets ?? options.organizations.tickets;
    const ticket = ticketText ? await tickets.verify(ticketText) : undefined;
    const user = signedIn?.user?.emailVerifiedAt !== undefined ? signedIn.user : undefined;
    const emailKey = ticket?.email ?? user?.email ?? "";
    const wait = creations.retryAfter(ip, emailKey);
    if (wait > 0) throw new OrganizationError(429, "rate_limited", `Too many new organizations. Try again in ${Math.ceil(wait / 60)} minutes.`);
    creations.fail(ip, emailKey);
    if (!ticket && !user) throw new OrganizationError(403, "signup_required", "Verify your email address first.");
    const created = await options.organizations.create(
      {
        name: input.orgName,
        workspaceName: input.workspaceName,
        owner: ticket
          ? {
              email: ticket.email,
              name: ticket.name,
              ...(ticket.passwordHash ? { passwordHash: ticket.passwordHash } : {}),
              // Google / Microsoft sign-up: link that account, so "Continue with …" finds this person later.
              ...(ticket.subject && (ticket.provider === "google" || ticket.provider === "microsoft") ? { link: { provider: ticket.provider, subject: ticket.subject } } : {})
            }
          : { email: user!.email, name: user!.name, passwordHash: user!.passwordHash },
        verifiedEmail: ticket?.email ?? user!.email
      },
      async (orgId, owner) => (await access.gatewayFor(orgId)).identity.createOwner(owner)
    );
    known.add(created.organization.id);
    // Single use: the ticket can't make a second organization.
    if (ticket && ticketText) await tickets.redeem?.(ticketText);
    const cookies = [sessionCookie(created.token, request, access.secureCookies), ...(ticketText ? [`${SIGNUP_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`] : [])];
    response.setHeader("set-cookie", cookies);
    reply(201, { org: { id: created.organization.id, name: created.organization.name }, workspaceId: DEFAULT_WORKSPACE_ID });
    return true;
  }

  /** The operator API (Bearer SIBYL_PLATFORM_TOKEN). */
  async function platform(request: IncomingMessage, path: string, method: string, reply: (status: number, body: unknown) => void, access: HostedGatewayAccess): Promise<true> {
    if (!options.platformToken || !tokensMatch(options.platformToken, bearer(request))) {
      request.resume();
      return reply(401, { error: "unauthorized", message: "The platform API needs SIBYL_PLATFORM_TOKEN." }), true;
    }
    if (path === "/api/platform/signup-tickets" && method === "POST") {
      const { email, name, password } = await readJsonObject(request, 4 * 1024);
      if (typeof email !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/.test(email.trim())) return reply(400, { error: "invalid_email" }), true;
      if (password !== undefined && passwordProblem(password)) return reply(400, { error: "weak_password", message: passwordProblem(password) }), true;
      const { ticket } = options.organizations.tickets.issue({
        email,
        provider: password !== undefined ? "password" : "magic_link",
        ...(typeof name === "string" && name.trim() ? { name: name.trim().slice(0, 80) } : {}),
        ...(typeof password === "string" ? { passwordHash: await hashPassword(password) } : {})
      });
      return reply(201, { ticket }), true;
    }
    const match = PLATFORM_ORG.exec(path);
    if (!match || !(await exists(match[1]!))) {
      request.resume();
      return reply(404, { error: "not_found" }), true;
    }
    const orgId = match[1]!;
    if (match[2] && method === "POST") {
      const input = await readJsonObject(request, 4 * 1024);
      const amountUsd = typeof input.amountUsd === "number" ? input.amountUsd : Number.NaN;
      const { runtime } = await access.gatewayFor(orgId);
      if (!runtime.credits) return reply(409, { error: "credits_unavailable" }), true;
      const added = await runtime.credits.add({
        kind: "grant",
        amountUsd,
        ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
        note: typeof input.note === "string" && input.note.trim() ? input.note.trim() : "Granted by the Sibyl team",
        reference: "platform"
      });
      options.log?.("tenancy.credits_granted", { orgId, amountUsd, added });
      return reply(200, { added, balanceUsd: runtime.credits.balanceUsd() }), true;
    }
    if (!match[2] && method === "GET") {
      request.resume();
      const organization = await options.store.organizations.get(orgId);
      return reply(200, { organization, users: await options.store.identity.users.count(orgId), balanceUsd: (await options.store.credits.balance(orgId)) / usdToMicros(1) }), true;
    }
    request.resume();
    return reply(405, { error: "method_not_allowed" }), true;
  }

  return { orgFor, handleHosted };
}
