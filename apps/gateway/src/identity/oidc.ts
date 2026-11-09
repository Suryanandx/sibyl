/**
 * OpenID Connect client helpers, shared by "Continue with Google / Microsoft"
 * (signup.ts) and Sibyl Enterprise single sign-on (ee/gateway/sso).
 *
 * Authorization code flow with PKCE (S256), state and nonce, using
 * `openid-client` (discovery, token exchange, ID token signature check
 * against the provider's JWKS, issuer/audience/expiry/nonce checks; the
 * Microsoft multi-tenant issuer `{tenantid}` is matched against the token's
 * `tid` by openid-client itself).
 *
 * Outbound requests go through fetchPublic (public addresses, https). An
 * identity provider on a private network (on-premises, or a local test IdP)
 * needs `allowPrivateNetwork`; plain http is accepted only then, too.
 *
 * Also here: the browser binding of a sign-in (a random cookie whose hash is
 * kept with the pending sign-in, so the callback must come from the browser
 * that started it) and `safeNext` for redirects after sign-in.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as client from "openid-client";
import { fetchPublic } from "../net/safe-fetch.js";
import { parseCookies } from "./http.js";

const DISCOVERY_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

/** What an OIDC client needs to know about its provider. */
export interface OidcClientSettings {
  issuer: string;
  clientId: string;
  scopes: string[];
  /** Claim with the person's groups (SSO); absent: no groups. */
  groupsClaim?: string;
}

export interface OidcIdentity {
  subject: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  groups: string[];
  /** Every claim of the verified ID token (provider-specific checks). */
  claims: Record<string, unknown>;
}

/** fetchPublic as a fetch() for openid-client (or plain fetch for private identity providers). */
function fetchFor(allowPrivate: boolean): client.CustomFetch {
  return async (url, options) => {
    const headers = Object.fromEntries(new Headers(options.headers as HeadersInit).entries());
    const body = options.body === undefined || options.body === null ? undefined : String(options.body);
    if (allowPrivate) {
      return fetch(url, { method: options.method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
    const response = await fetchPublic(url, { method: options.method, headers, ...(body !== undefined ? { body } : {}), httpsOnly: true, maxRedirects: 0, timeoutMs: TIMEOUT_MS, maxBytes: 1024 * 1024 });
    const { bytes } = await response.bytes();
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : Buffer.from(bytes), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export class OidcClients {
  /** Discovery documents, cached 10 minutes per provider and issuer. */
  private readonly discovered = new Map<string, { at: number; issuer: string; metadata: Promise<client.ServerMetadata> }>();

  constructor(private readonly options: { allowPrivateNetwork: boolean }) {}

  /** The provider's discovery document (checked: issuer matches, endpoints present). */
  discover(providerId: string | undefined, settings: OidcClientSettings): Promise<client.ServerMetadata> {
    const cached = providerId ? this.discovered.get(providerId) : undefined;
    if (cached && cached.issuer === settings.issuer && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.metadata;
    const allowPrivate = this.options.allowPrivateNetwork;
    const metadata = client
      .discovery(new URL(settings.issuer), settings.clientId, undefined, client.None(), {
        [client.customFetch]: fetchFor(allowPrivate),
        timeout: TIMEOUT_MS / 1000,
        ...(allowPrivate && settings.issuer.startsWith("http:") ? { execute: [client.allowInsecureRequests] } : {})
      })
      .then((config) => {
        const server = config.serverMetadata();
        if (!server.token_endpoint || !server.authorization_endpoint) throw new Error("the discovery document has no authorization or token endpoint");
        if (!server.jwks_uri) throw new Error("the discovery document has no jwks_uri");
        return { ...server } as client.ServerMetadata;
      });
    if (providerId) {
      metadata.catch(() => this.discovered.delete(providerId));
      this.discovered.set(providerId, { at: Date.now(), issuer: settings.issuer, metadata });
    }
    return metadata;
  }

  /** Client configuration: discovery + client credentials (a secret, or a public client). */
  async configuration(providerId: string, settings: OidcClientSettings, clientSecret: (tokenEndpointHost: string) => Promise<string | undefined>): Promise<client.Configuration> {
    const server = await this.discover(providerId, settings);
    const secret = await clientSecret(new URL(server.token_endpoint!).hostname);
    const config = new client.Configuration(server, settings.clientId, secret, secret ? client.ClientSecretBasic(secret) : client.None());
    const allowPrivate = this.options.allowPrivateNetwork;
    config[client.customFetch] = fetchFor(allowPrivate);
    config.timeout = TIMEOUT_MS / 1000;
    if (allowPrivate && settings.issuer.startsWith("http:")) client.allowInsecureRequests(config);
    return config;
  }

  forget(providerId: string): void {
    this.discovered.delete(providerId);
  }

  /** The URL to send the browser to, plus what the callback must check. */
  async start(
    config: client.Configuration,
    settings: OidcClientSettings,
    redirectUri: string,
    extra: Record<string, string> = {}
  ): Promise<{ url: URL; state: string; nonce: string; verifier: string }> {
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: settings.scopes.join(" "),
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
      ...extra
    });
    return { url, state, nonce, verifier };
  }

  /** Exchange the code and verify the ID token; returns who signed in. */
  async finish(
    config: client.Configuration,
    settings: OidcClientSettings,
    callbackUrl: URL,
    checks: { state: string; nonce: string; verifier: string }
  ): Promise<OidcIdentity> {
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("the provider returned no ID token");
    const groupsValue = settings.groupsClaim ? claims[settings.groupsClaim] : undefined;
    const groups = Array.isArray(groupsValue) ? groupsValue.filter((g): g is string => typeof g === "string") : typeof groupsValue === "string" ? [groupsValue] : [];
    return {
      subject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.email_verified === "boolean" ? { emailVerified: claims.email_verified } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : typeof claims.preferred_username === "string" ? { name: claims.preferred_username } : {}),
      groups,
      claims: { ...claims }
    };
  }
}

/* ───────────── browser binding & redirects ───────────── */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A new random browser binding (the cookie value) and the hash kept with the pending sign-in. */
export function newBrowserBinding(): { binding: string; hash: string } {
  const binding = randomBytes(24).toString("base64url");
  return { binding, hash: sha256(binding) };
}

/** Does the request carry the binding cookie whose hash is `expectedHash`? (constant time) */
export function browserBindingMatches(request: IncomingMessage, cookieName: string, expectedHash: string): boolean {
  const cookie = parseCookies(request.headers.cookie)[cookieName];
  const actual = Buffer.from(cookie ? sha256(cookie) : "");
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A safe same-site path for after sign-in (from ?next=). */
export function safeNext(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && value.length <= 512 ? value : "/";
}
