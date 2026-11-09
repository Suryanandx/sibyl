/**
 * SSO and session-policy HTTP routes — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Browser sign-in (no sign-in needed; protected by state, the browser
 * binding cookie and the protocol's own checks):
 *   GET  /api/sso/:id/start?next=           → 302 to the identity provider
 *   GET  /api/sso/oidc/:id/callback         → session cookie, 302 to the app
 *   POST /api/sso/saml/:id/acs              → 303 to /api/sso/complete
 *   GET  /api/sso/complete?ticket=          → session cookie, 302 to the app
 *   GET  /api/sso/saml/:id/metadata         → SP metadata (XML)
 * Failures send the browser to <app>/login?sso_error=<code>.
 *
 * Administration (org.settings): /api/sso/config, /api/sso/providers[/:id[/test]],
 * /api/session-policy. See packages/protocol ("Sign-in providers … SSO …").
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpRouteHandler, IdentityBridge } from "../../../packages/core/src/index";
import type { SsoConfigView } from "../../../packages/protocol/src/index";
import { readBody, requestPath, requestUrl } from "../../../apps/gateway/src/http/index";
import { DirectoryError } from "../directory/directory";
import { adminRoute, type IdentityContext } from "../directory/context";
import {
  clientSecretName,
  newProviderId,
  parseDomains,
  parseHttpUrl,
  parseLabel,
  parseSaml,
  parseScopes,
  providerUrls,
  providerView,
  type SsoProviderRecord,
  type SsoStore
} from "./config";
import { OidcClients, privateNetworkAllowed } from "./oidc";
import { SamlProviders } from "./saml";
import type { SessionPolicyStore } from "./session-policy";
import { BINDING_COOKIE, SignInState, SsoError, resolveAccount, safeNext, type ExternalIdentity } from "./signin";

const ID = /^[a-f0-9]{10}$/;

export interface SsoHttpDeps {
  context: IdentityContext;
  sso: SsoStore;
  policy: SessionPolicyStore;
  oidc: OidcClients;
  saml: SamlProviders;
  state: SignInState;
}

export function ssoRoutes(deps: SsoHttpDeps): HttpRouteHandler {
  return (request, response) => {
    const path = requestPath(request);
    if (path === "/api/session-policy") return policyRoute(deps, request, response);
    if (path !== "/api/sso" && !path.startsWith("/api/sso/")) return false;
    const parts = path.split("/").slice(3); // after /api/sso
    const [a, b, c] = parts;
    // Browser flows.
    if (request.method === "GET" && a && ID.test(a) && b === "start" && parts.length === 2) return browser(deps, request, response, () => start(deps, request, response, a));
    if (request.method === "GET" && a === "oidc" && b && ID.test(b) && c === "callback" && parts.length === 3) {
      return browser(deps, request, response, () => oidcCallback(deps, request, response, b));
    }
    if (request.method === "POST" && a === "saml" && b && ID.test(b) && c === "acs" && parts.length === 3) return browser(deps, request, response, () => samlAcs(deps, request, response, b));
    if (request.method === "GET" && a === "complete" && parts.length === 1) return browser(deps, request, response, () => complete(deps, request, response));
    if (request.method === "GET" && a === "saml" && b && ID.test(b) && c === "metadata" && parts.length === 3) return browser(deps, request, response, () => metadata(deps, request, response, b));
    // Administration.
    return adminRoute(deps.context, request, response, "sso.http_failed", async (admin) => {
      const bridge = deps.context.bridge();
      if (a === "config" && parts.length === 1) {
        if (request.method === "GET") {
          request.resume();
          return admin.reply(200, await configView(deps, request));
        }
        if (request.method === "PUT") {
          await updateConfig(deps, await admin.body(), admin.principal.userId);
          return admin.reply(200, await configView(deps, request));
        }
      }
      if (a === "providers" && parts.length === 1 && request.method === "POST") {
        const provider = await saveProvider(deps, bridge, undefined, await admin.body());
        return admin.reply(201, { provider: await viewOf(deps, provider, request) });
      }
      if (a === "providers" && b && ID.test(b)) {
        if (parts.length === 2 && request.method === "PATCH") {
          const provider = await saveProvider(deps, bridge, b, await admin.body());
          return admin.reply(200, { provider: await viewOf(deps, provider, request) });
        }
        if (parts.length === 2 && request.method === "DELETE") {
          request.resume();
          await deleteProvider(deps, bridge, b);
          return admin.reply(200, { ok: true });
        }
        if (parts.length === 3 && c === "test" && request.method === "POST") {
          request.resume();
          return admin.reply(200, await testProvider(deps, b));
        }
      }
      request.resume();
      admin.reply(404, { error: "not_found" });
    });
  };
}

/* ───────────── browser flows ───────────── */

/** Run a browser step; any failure sends the browser back to the sign-in screen with a code. */
function browser(deps: SsoHttpDeps, request: IncomingMessage, response: ServerResponse, step: () => Promise<void>): true {
  void step().catch((error: unknown) => {
    request.resume();
    const code = error instanceof SsoError ? error.code : statusCode(error) ?? "sso_failed";
    deps.context.log("sso.sign_in_failed", { code, error: error instanceof Error ? error.message : String(error) });
    if (response.headersSent) {
      response.end();
      return;
    }
    let target = "/login";
    try {
      target = `${deps.context.bridge().appUrl(request)}/login?sso_error=${encodeURIComponent(code)}`;
    } catch {
      // No bridge: fall back to a relative path.
    }
    response.writeHead(302, { location: target, "cache-control": "no-store", "set-cookie": bindingCookie(deps, request, "", 0) });
    response.end();
  });
  return true;
}

/** Sign-in refusals from the identity service carry a code (enforced SSO, network). */
function statusCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; status?: unknown };
  return typeof value?.code === "string" && typeof value.status === "number" ? value.code : undefined;
}

/** The browser-binding cookie (Secure when the gateway is reached over https). */
function bindingCookie(deps: SsoHttpDeps, request: IncomingMessage, value: string, maxAge: number): string {
  let secure = false;
  try {
    secure = deps.context.bridge().gatewayUrl(request).startsWith("https://");
  } catch {
    secure = false;
  }
  return [`${BINDING_COOKIE}=${value}`, "Path=/api/sso", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : [])].join("; ");
}

async function enabledProvider(deps: SsoHttpDeps, id: string): Promise<SsoProviderRecord> {
  const provider = await deps.sso.provider(id);
  if (!provider || !provider.enabled) throw new SsoError("sso_unavailable", "That sign-in option isn't available.");
  return provider;
}

async function clientSecretFor(deps: SsoHttpDeps, provider: SsoProviderRecord, host: string): Promise<string | undefined> {
  const name = provider.oidc?.secretName;
  if (!name) return undefined;
  const secrets = deps.context.bridge().secrets;
  if (!secrets) throw new SsoError("sso_misconfigured", "The client secret can't be read (no secrets key).");
  return secrets.resolve(name, host);
}

async function start(deps: SsoHttpDeps, request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
  request.resume();
  const provider = await enabledProvider(deps, id);
  const bridge = deps.context.bridge();
  const url = requestUrl(request);
  const next = safeNext(url.searchParams.get("next") ?? undefined);
  const binding = deps.state.newBinding();
  const urls = providerUrls(bridge.gatewayUrl(request), provider.id);
  let location: string;
  if (provider.kind === "oidc" && provider.oidc) {
    const config = await deps.oidc.configuration(provider.id, provider.oidc, (host) => clientSecretFor(deps, provider, host));
    const started = await deps.oidc.start(config, provider.oidc, urls.redirectUri);
    deps.state.remember(started.state, { providerId: provider.id, binding, next, oidc: { state: started.state, nonce: started.nonce, verifier: started.verifier } });
    location = started.url.toString();
  } else if (provider.kind === "saml" && provider.saml) {
    const relayState = deps.state.newBinding();
    deps.state.remember(relayState, { providerId: provider.id, binding, next });
    location = await deps.saml.authorizeUrl(provider.id, provider.saml, urls, relayState);
  } else {
    throw new SsoError("sso_misconfigured", "This sign-in option isn't set up completely.");
  }
  deps.context.log("sso.start", { provider: provider.id, kind: provider.kind });
  response.writeHead(302, { location, "cache-control": "no-store", "set-cookie": bindingCookie(deps, request, binding, 600) });
  response.end();
}

async function oidcCallback(deps: SsoHttpDeps, request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
  request.resume();
  const url = requestUrl(request);
  const providerError = url.searchParams.get("error");
  const pending = deps.state.take(url.searchParams.get("state") ?? undefined, id);
  deps.state.assertBinding(request, pending.bindingHash);
  if (providerError) throw new SsoError("sso_denied", `The identity provider refused: ${providerError}`);
  const provider = await enabledProvider(deps, id);
  if (!provider.oidc || !pending.oidc) throw new SsoError("sso_misconfigured", "This sign-in option isn't set up completely.");
  const bridge = deps.context.bridge();
  const urls = providerUrls(bridge.gatewayUrl(request), provider.id);
  const config = await deps.oidc.configuration(provider.id, provider.oidc, (host) => clientSecretFor(deps, provider, host));
  // openid-client compares the callback URL with the redirect URI: rebuild it on the registered base.
  const callbackUrl = new URL(urls.redirectUri);
  callbackUrl.search = url.search;
  let identity: ExternalIdentity;
  try {
    identity = await deps.oidc.finish(config, provider.oidc, callbackUrl, pending.oidc);
  } catch (error) {
    throw new SsoError("sso_invalid_response", error instanceof Error ? error.message : "The identity provider's answer didn't check out.");
  }
  await signIn(deps, request, response, provider, identity, pending.next);
}

async function samlAcs(deps: SsoHttpDeps, request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
  const raw = await readBody(request, 512 * 1024);
  const form = new URLSearchParams(raw.toString("utf8"));
  const samlResponse = form.get("SAMLResponse");
  if (!samlResponse) throw new SsoError("sso_invalid_response", "No SAMLResponse in the request.");
  // RelayState ties the response to a sign-in this gateway started (IdP-initiated sign-in isn't accepted).
  const pending = deps.state.take(form.get("RelayState") ?? undefined, id);
  const provider = await enabledProvider(deps, id);
  if (!provider.saml) throw new SsoError("sso_misconfigured", "This sign-in option isn't set up completely.");
  const urls = providerUrls(deps.context.bridge().gatewayUrl(request), provider.id);
  let identity: ExternalIdentity;
  try {
    identity = await deps.saml.validate(provider.id, provider.saml, urls, samlResponse);
  } catch (error) {
    throw new SsoError("sso_invalid_response", error instanceof Error ? error.message : "The SAML response didn't check out.");
  }
  const ticket = deps.state.issueTicket(pending, identity);
  // 303: the browser comes back with a top-level GET, which carries the Lax binding cookie.
  const gateway = deps.context.bridge().gatewayUrl(request);
  response.writeHead(303, { location: `${gateway}/api/sso/complete?ticket=${encodeURIComponent(ticket)}`, "cache-control": "no-store" });
  response.end();
}

async function complete(deps: SsoHttpDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  request.resume();
  const ticket = deps.state.redeemTicket(requestUrl(request).searchParams.get("ticket") ?? undefined);
  deps.state.assertBinding(request, ticket.bindingHash);
  const provider = await enabledProvider(deps, ticket.providerId);
  await signIn(deps, request, response, provider, ticket.identity, ticket.next);
}

/** The provider vouched for `identity`: find the account and create the session (the identity service's one session code). */
async function signIn(
  deps: SsoHttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  provider: SsoProviderRecord,
  identity: ExternalIdentity,
  next: string
): Promise<void> {
  const bridge = deps.context.bridge();
  const { store, orgId } = deps.context;
  const user = await resolveAccount(deps.context.directory, (email) => store.identity.users.getByEmail(orgId, email), provider, identity);
  const { setCookie } = await bridge.createSession(request, user.id, provider.kind);
  deps.context.log("sso.signed_in", { provider: provider.id, kind: provider.kind, userId: user.id });
  response.writeHead(302, {
    location: `${bridge.appUrl(request)}${next}`,
    "cache-control": "no-store",
    "set-cookie": [setCookie, bindingCookie(deps, request, "", 0)]
  });
  response.end();
}

async function metadata(deps: SsoHttpDeps, request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
  request.resume();
  const provider = await deps.sso.provider(id);
  if (!provider?.saml) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  const urls = providerUrls(deps.context.bridge().gatewayUrl(request), provider.id);
  response.writeHead(200, { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "no-store" });
  response.end(deps.saml.metadata(provider.id, provider.saml, urls));
}

/* ───────────── administration ───────────── */

async function viewOf(deps: SsoHttpDeps, provider: SsoProviderRecord, request: IncomingMessage) {
  const secrets = deps.context.bridge().secrets;
  const hasSecret = Boolean(provider.oidc?.secretName && secrets && (await secrets.has(provider.oidc.secretName)));
  return providerView(provider, deps.context.bridge().gatewayUrl(request), hasSecret);
}

async function configView(deps: SsoHttpDeps, request: IncomingMessage): Promise<SsoConfigView> {
  const settings = await deps.sso.get();
  const { store, orgId } = deps.context;
  const owners = (await store.identity.memberships.listForScope(orgId, "org")).filter((m) => m.role === "owner");
  const users = await store.identity.users.list(orgId);
  return {
    providers: await Promise.all(settings.providers.map((provider) => viewOf(deps, provider, request))),
    enforce: settings.enforce,
    ...(settings.breakGlassUserId ? { breakGlassUserId: settings.breakGlassUserId } : {}),
    owners: users
      .filter((u) => u.disabledAt === undefined && owners.some((o) => o.userId === u.id))
      .map((u) => ({ id: u.id, name: u.name, email: u.email }))
  };
}

async function updateConfig(deps: SsoHttpDeps, input: Record<string, unknown>, callerId: string | undefined): Promise<void> {
  const { store, orgId } = deps.context;
  const owners = new Set((await store.identity.memberships.listForScope(orgId, "org")).filter((m) => m.role === "owner").map((m) => m.userId));
  await deps.sso.update(async (settings) => {
    if (input.breakGlassUserId !== undefined) {
      if (input.breakGlassUserId === null || input.breakGlassUserId === "") delete settings.breakGlassUserId;
      else {
        const user = typeof input.breakGlassUserId === "string" ? await store.identity.users.get(orgId, input.breakGlassUserId) : undefined;
        if (!user || user.disabledAt !== undefined || !owners.has(user.id)) throw new DirectoryError(400, "invalid_break_glass", "The break-glass account must be an active organization owner.");
        settings.breakGlassUserId = user.id;
      }
    }
    if (input.enforce !== undefined) {
      const enforce = input.enforce === true;
      if (enforce) {
        if (!settings.providers.some((p) => p.enabled)) throw new DirectoryError(409, "no_provider", "Add and turn on an identity provider before enforcing SSO.");
        // Someone must keep a way in if the identity provider is down.
        if (!settings.breakGlassUserId) {
          if (callerId && owners.has(callerId)) settings.breakGlassUserId = callerId;
          else throw new DirectoryError(400, "invalid_break_glass", "Choose a break-glass owner who keeps password sign-in.");
        }
      }
      settings.enforce = enforce;
    }
  });
  deps.context.log("sso.config_changed", { enforce: (await deps.sso.get()).enforce });
}

async function saveProvider(deps: SsoHttpDeps, bridge: IdentityBridge, id: string | undefined, input: Record<string, unknown>): Promise<SsoProviderRecord> {
  const allowHttp = privateNetworkAllowed(deps.context.env);
  const settings = await deps.sso.get();
  const current = id ? settings.providers.find((p) => p.id === id) : undefined;
  if (id && !current) throw new DirectoryError(404, "not_found", "No such provider.");
  if (!current && settings.providers.length >= 20) throw new DirectoryError(400, "too_many", "Up to 20 identity providers.");
  const kind = current?.kind ?? (input.kind === "saml" ? "saml" : input.kind === "oidc" ? "oidc" : undefined);
  if (!kind) throw new DirectoryError(400, "invalid_kind", "Choose OpenID Connect or SAML.");
  const providerId = current?.id ?? newProviderId();
  const record: SsoProviderRecord = {
    id: providerId,
    kind,
    label: input.label !== undefined ? parseLabel(input.label) : parseLabel(current?.label),
    enabled: input.enabled !== undefined ? input.enabled === true : current?.enabled ?? true,
    domains: input.domains !== undefined ? parseDomains(input.domains, providerId, settings.providers) : current?.domains ?? parseDomains([], providerId, []),
    createdAt: current?.createdAt ?? deps.sso.now(),
    updatedAt: deps.sso.now()
  };
  let secretToStore: { value: string; hosts: string[] } | undefined;
  if (kind === "oidc") {
    const raw = (input.oidc ?? {}) as Record<string, unknown>;
    const issuer = raw.issuer !== undefined ? parseHttpUrl(raw.issuer, "issuer URL", allowHttp) : current?.oidc?.issuer;
    const clientId = typeof raw.clientId === "string" && raw.clientId.trim() ? raw.clientId.trim().slice(0, 300) : current?.oidc?.clientId;
    if (!issuer) throw new DirectoryError(400, "invalid_url", "Enter the issuer URL.");
    if (!clientId) throw new DirectoryError(400, "invalid_client", "Enter the client ID.");
    const oidc = {
      issuer,
      clientId,
      scopes: raw.scopes !== undefined ? parseScopes(raw.scopes) : current?.oidc?.scopes ?? parseScopes([]),
      groupsClaim: typeof raw.groupsClaim === "string" && raw.groupsClaim.trim() ? raw.groupsClaim.trim().slice(0, 100) : current?.oidc?.groupsClaim ?? "groups",
      ...(current?.oidc?.secretName ? { secretName: current.oidc.secretName } : {})
    };
    // Check the issuer now (discovery), and learn where the client secret may be sent.
    let tokenHost: string;
    try {
      const server = await deps.oidc.discover(undefined, oidc);
      tokenHost = new URL(server.token_endpoint!).hostname;
    } catch (error) {
      throw new DirectoryError(400, "discovery_failed", `Couldn't read ${issuer}/.well-known/openid-configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof raw.clientSecret === "string" && raw.clientSecret.trim()) {
      secretToStore = { value: raw.clientSecret.trim(), hosts: [...new Set([tokenHost])] };
      oidc.secretName = clientSecretName(providerId);
    } else if (raw.clientSecret === "" && current?.oidc?.secretName) {
      // Empty string: turn the client into a public client (PKCE only).
      delete (oidc as { secretName?: string }).secretName;
    }
    record.oidc = oidc;
  } else {
    record.saml = parseSaml((input.saml ?? {}) as Record<string, unknown>, current?.saml, allowHttp);
  }
  if (secretToStore) {
    if (!bridge.secrets) throw new DirectoryError(503, "vault_unavailable", "Client secrets need the secrets vault (SIBYL_SECRET_KEY or data/secret.key).");
    try {
      await bridge.secrets.set({
        name: clientSecretName(providerId),
        value: secretToStore.value,
        allowedHosts: secretToStore.hosts,
        service: `SSO: ${record.label}`,
        description: "OpenID Connect client secret for single sign-on."
      });
    } catch (error) {
      // The vault binds the secret to the token endpoint's host (a dotted name or an IP address).
      throw new DirectoryError(400, "invalid_secret_host", `The client secret can't be stored for ${secretToStore.hosts.join(", ")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (current?.oidc?.secretName && !record.oidc?.secretName && bridge.secrets) {
    await bridge.secrets.delete(current.oidc.secretName);
  }
  await deps.sso.update((next) => {
    // Domains are checked again under the lock (another save may have claimed one).
    parseDomains(record.domains, record.id, next.providers);
    next.providers = current ? next.providers.map((p) => (p.id === record.id ? record : p)) : [...next.providers, record];
    if (next.enforce && !next.providers.some((p) => p.enabled)) next.enforce = false;
  });
  deps.oidc.forget(providerId);
  deps.context.log(current ? "sso.provider_updated" : "sso.provider_added", { provider: providerId, kind });
  return record;
}

async function deleteProvider(deps: SsoHttpDeps, bridge: IdentityBridge, id: string): Promise<void> {
  const removed = await deps.sso.update((settings) => {
    const provider = settings.providers.find((p) => p.id === id);
    if (!provider) throw new DirectoryError(404, "not_found", "No such provider.");
    settings.providers = settings.providers.filter((p) => p.id !== id);
    // Nothing left to sign in with: password sign-in comes back for everyone.
    if (!settings.providers.some((p) => p.enabled)) settings.enforce = false;
    return provider;
  });
  if (removed.oidc?.secretName && bridge.secrets) await bridge.secrets.delete(removed.oidc.secretName);
  deps.oidc.forget(id);
  deps.context.log("sso.provider_removed", { provider: id });
}

async function testProvider(deps: SsoHttpDeps, id: string): Promise<{ ok: boolean; message: string }> {
  const provider = await deps.sso.provider(id);
  if (!provider) throw new DirectoryError(404, "not_found", "No such provider.");
  if (provider.oidc) {
    try {
      deps.oidc.forget(id);
      const server = await deps.oidc.discover(id, provider.oidc);
      return { ok: true, message: `Found ${server.issuer}: sign-in at ${new URL(server.authorization_endpoint!).host}, keys published.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  const view = providerView(provider, "", false).saml?.certificate;
  if (!view) return { ok: false, message: "The signing certificate can't be read." };
  const expires = Date.parse(view.expiresAt);
  if (expires <= Date.now()) return { ok: false, message: `The IdP signing certificate expired on ${view.expiresAt.slice(0, 10)}.` };
  return { ok: true, message: `Certificate ${view.subject}, valid until ${view.expiresAt.slice(0, 10)}. Sign in once to finish the check.` };
}

/* ───────────── session policy ───────────── */

function policyRoute(deps: SsoHttpDeps, request: IncomingMessage, response: ServerResponse): true {
  return adminRoute(deps.context, request, response, "sso.policy_http_failed", async (admin) => {
    const ip = deps.context.bridge().clientIp(request);
    if (request.method === "GET") {
      request.resume();
      return admin.reply(200, await deps.policy.view(ip));
    }
    if (request.method === "PUT") {
      await deps.policy.set(await admin.body(), ip);
      deps.context.log("sso.session_policy_changed", {});
      return admin.reply(200, await deps.policy.view(ip));
    }
    request.resume();
    admin.reply(405, { error: "method_not_allowed" });
  });
}
