/**
 * SAML 2.0 service provider — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Built on `@node-saml/node-saml` (signature validation with xml-crypto,
 * conditions, audience). What Sibyl requires on top of its defaults:
 *
 * - the assertion itself must be signed by the configured IdP certificate
 *   (an unsigned assertion inside a signed response is refused);
 * - SP-initiated only: every response must answer a request this gateway
 *   made in the last 10 minutes (InResponseTo), and each request id works
 *   once;
 * - audience = this provider's SP entity ID; the subject confirmation's
 *   Recipient (and the response Destination, when present) = our ACS URL;
 * - NotBefore / NotOnOrAfter with one minute of clock skew;
 * - replay: an assertion ID is accepted once (kept until it expires);
 * - the IdP's Issuer must match when configured.
 */
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import type { SamlSettings } from "./config";

const REQUEST_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const MAX_REPLAY_ENTRIES = 100_000;

/** In-memory cache of outstanding AuthnRequest ids (one per provider). */
class RequestCache implements CacheProvider {
  private readonly items = new Map<string, CacheItem>();

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    this.sweep();
    if (this.items.has(key)) return null;
    const item = { value, createdAt: Date.now() };
    this.items.set(key, item);
    return item;
  }

  async getAsync(key: string): Promise<string | null> {
    const item = this.items.get(key);
    if (!item || Date.now() - item.createdAt > REQUEST_TTL_MS) return null;
    return item.value;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null;
    const item = this.items.get(key);
    this.items.delete(key);
    return item?.value ?? null;
  }

  private sweep(): void {
    const cutoff = Date.now() - REQUEST_TTL_MS;
    for (const [key, item] of this.items) if (item.createdAt < cutoff) this.items.delete(key);
  }
}

export interface SamlIdentity {
  subject: string;
  email?: string;
  name?: string;
  groups: string[];
}

export class SamlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamlRejectedError";
  }
}

export class SamlProviders {
  private readonly requestCaches = new Map<string, RequestCache>();
  /** assertion ID → expiry (ms). */
  private readonly seenAssertions = new Map<string, number>();

  private instance(providerId: string, settings: SamlSettings, urls: { spEntityId: string; acsUrl: string }): SAML {
    let cache = this.requestCaches.get(providerId);
    if (!cache) {
      cache = new RequestCache();
      this.requestCaches.set(providerId, cache);
    }
    return new SAML({
      callbackUrl: urls.acsUrl,
      entryPoint: settings.entryPoint,
      issuer: urls.spEntityId,
      audience: urls.spEntityId,
      idpCert: settings.certificate,
      ...(settings.idpIssuer ? { idpIssuer: settings.idpIssuer } : {}),
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_MS,
      cacheProvider: cache,
      acceptedClockSkewMs: CLOCK_SKEW_MS,
      // Let the IdP pick the NameID format; email comes from an attribute or an email NameID.
      identifierFormat: null,
      disableRequestedAuthnContext: true,
      signatureAlgorithm: "sha256",
      digestAlgorithm: "sha256"
    });
  }

  /** Redirect-binding URL for a new AuthnRequest; `relayState` comes back with the response. */
  authorizeUrl(providerId: string, settings: SamlSettings, urls: { spEntityId: string; acsUrl: string }, relayState: string): Promise<string> {
    return this.instance(providerId, settings, urls).getAuthorizeUrlAsync(relayState, undefined, {});
  }

  metadata(providerId: string, settings: SamlSettings, urls: { spEntityId: string; acsUrl: string }): string {
    return this.instance(providerId, settings, urls).generateServiceProviderMetadata(null, null);
  }

  /** Validate a POSTed SAMLResponse; throws SamlRejectedError (or node-saml's error) when anything is off. */
  async validate(
    providerId: string,
    settings: SamlSettings,
    urls: { spEntityId: string; acsUrl: string },
    samlResponse: string
  ): Promise<SamlIdentity> {
    const { profile, loggedOut } = await this.instance(providerId, settings, urls).validatePostResponseAsync({ SAMLResponse: samlResponse });
    if (loggedOut || !profile) throw new SamlRejectedError("not a sign-in response");
    this.checkRecipient(profile, urls.acsUrl);
    this.checkReplay(profile);
    const attributes = (profile.attributes ?? {}) as Record<string, unknown>;
    const first = (value: unknown): string | undefined =>
      typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
    const email =
      first(attributes[settings.emailAttribute]) ??
      first(profile.email) ??
      first(profile.mail) ??
      (profile.nameIDFormat?.endsWith(":emailAddress") || /^[^\s@]+@[^\s@]+$/.test(profile.nameID ?? "") ? profile.nameID : undefined);
    const groupsValue = attributes[settings.groupsAttribute];
    const groups = Array.isArray(groupsValue) ? groupsValue.filter((g): g is string => typeof g === "string") : typeof groupsValue === "string" ? [groupsValue] : [];
    const name = first(attributes[settings.nameAttribute]);
    if (!profile.nameID) throw new SamlRejectedError("the assertion has no NameID");
    return { subject: profile.nameID, ...(email ? { email } : {}), ...(name ? { name } : {}), groups };
  }

  private checkRecipient(profile: Profile, acsUrl: string): void {
    const assertion = profile.getAssertion?.() as { Assertion?: Record<string, unknown> } | undefined;
    const subject = (assertion?.Assertion?.Subject as Array<Record<string, unknown>> | undefined)?.[0];
    const confirmations = (subject?.SubjectConfirmation as Array<Record<string, unknown>> | undefined) ?? [];
    const recipients = confirmations
      .flatMap((c) => (c.SubjectConfirmationData as Array<{ $?: Record<string, string> }> | undefined) ?? [])
      .map((data) => data.$?.Recipient)
      .filter((value): value is string => typeof value === "string");
    if (recipients.length === 0 || recipients.some((recipient) => recipient !== acsUrl)) {
      throw new SamlRejectedError("the assertion's Recipient is not this service's ACS URL");
    }
    const responseXml = profile.getSamlResponseXml?.() ?? "";
    const destination = /<(?:\w+:)?Response\b[^>]*\sDestination="([^"]*)"/.exec(responseXml)?.[1];
    if (destination !== undefined && destination !== acsUrl) throw new SamlRejectedError("the response's Destination is not this service's ACS URL");
  }

  private checkReplay(profile: Profile): void {
    const assertion = profile.getAssertion?.() as { Assertion?: { $?: Record<string, string>; Conditions?: Array<{ $?: Record<string, string> }> } } | undefined;
    const id = assertion?.Assertion?.$?.ID ?? profile.ID;
    if (!id) throw new SamlRejectedError("the assertion has no ID");
    const now = Date.now();
    for (const [key, expires] of this.seenAssertions) if (expires < now) this.seenAssertions.delete(key);
    if (this.seenAssertions.has(id)) throw new SamlRejectedError("this assertion was already used");
    const notOnOrAfter = Date.parse(assertion?.Assertion?.Conditions?.[0]?.$?.NotOnOrAfter ?? "");
    if (this.seenAssertions.size >= MAX_REPLAY_ENTRIES) this.seenAssertions.delete(this.seenAssertions.keys().next().value!);
    this.seenAssertions.set(id, (Number.isFinite(notOnOrAfter) ? notOnOrAfter : now + REQUEST_TTL_MS) + CLOCK_SKEW_MS);
  }
}
