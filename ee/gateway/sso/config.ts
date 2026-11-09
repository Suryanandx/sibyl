/**
 * SSO configuration — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Stored in `store.kv` (`ee.sso.v1`): the identity providers (OIDC or SAML),
 * the email domains each one claims, whether SSO is enforced for those
 * domains, and the break-glass owner who keeps password sign-in.
 * An OIDC client secret is a vault secret (`SSO_<ID>_CLIENT_SECRET`, allowed
 * only for the provider's token endpoint host), never in this record.
 *
 * Domain claim: one Sibyl instance is one organization, and only its owners
 * and admins can claim a domain, so a claim is the admin's statement (no DNS
 * proof). A domain belongs to at most one provider.
 */
import { X509Certificate, randomBytes } from "node:crypto";
import type { Store } from "../../../packages/core/src/index";
import type { SsoConfigView, SsoProviderView } from "../../../packages/protocol/src/index";
import { DirectoryError } from "../directory/directory";

export const SSO_KV_KEY = "ee.sso.v1";
const MAX_PROVIDERS = 20;
const DOMAIN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export interface OidcSettings {
  issuer: string;
  clientId: string;
  scopes: string[];
  groupsClaim: string;
  /** Vault secret holding the client secret (absent: public client, PKCE only). */
  secretName?: string;
}

export interface SamlSettings {
  entryPoint: string;
  idpIssuer?: string;
  /** IdP signing certificate (PEM). */
  certificate: string;
  emailAttribute: string;
  nameAttribute: string;
  groupsAttribute: string;
}

export interface SsoProviderRecord {
  id: string;
  kind: "oidc" | "saml";
  label: string;
  enabled: boolean;
  domains: string[];
  oidc?: OidcSettings;
  saml?: SamlSettings;
  createdAt: number;
  updatedAt: number;
}

export interface SsoSettings {
  providers: SsoProviderRecord[];
  enforce: boolean;
  breakGlassUserId?: string;
}

export function clientSecretName(providerId: string): string {
  return `SSO_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_SECRET`;
}

export class SsoStore {
  private cache: SsoSettings | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { store: Store; orgId: string; now?: () => number }) {}

  async get(): Promise<SsoSettings> {
    this.cache ??= { providers: [], enforce: false, ...((await this.options.store.kv.get<SsoSettings>(this.options.orgId, SSO_KV_KEY)) ?? {}) };
    return structuredClone(this.cache);
  }

  async provider(id: string): Promise<SsoProviderRecord | undefined> {
    return (await this.get()).providers.find((p) => p.id === id);
  }

  /** The enabled provider claiming this email's domain. */
  async providerForEmail(email: string): Promise<SsoProviderRecord | undefined> {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return undefined;
    return (await this.get()).providers.find((p) => p.enabled && p.domains.includes(domain));
  }

  update<T>(change: (settings: SsoSettings) => T | Promise<T>): Promise<T> {
    const run = this.writes.catch(() => undefined).then(async () => {
      const settings = await this.get();
      const result = await change(settings);
      await this.options.store.kv.set(this.options.orgId, SSO_KV_KEY, settings);
      this.cache = settings;
      return result;
    });
    this.writes = run;
    return run;
  }

  now(): number {
    return (this.options.now ?? Date.now)();
  }
}

export function newProviderId(): string {
  return randomBytes(5).toString("hex");
}

/* ───────────── validation ───────────── */

export function parseLabel(value: unknown, fallback?: string): string {
  const label = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : fallback ?? "";
  if (!label) throw new DirectoryError(400, "invalid_label", "Give the provider a name people will recognise (e.g. “Okta”).");
  return label;
}

export function parseDomains(value: unknown, providerId: string, providers: SsoProviderRecord[]): string[] {
  if (!Array.isArray(value)) throw new DirectoryError(400, "invalid_domains", "List the email domains this provider signs people in for.");
  const domains = [...new Set(value.map((d) => (typeof d === "string" ? d.trim().toLowerCase().replace(/^@/, "") : "")))].filter(Boolean);
  if (domains.length === 0) throw new DirectoryError(400, "invalid_domains", "Add at least one email domain (e.g. example.com).");
  if (domains.length > 50) throw new DirectoryError(400, "invalid_domains", "Up to 50 domains per provider.");
  for (const domain of domains) {
    if (!DOMAIN.test(domain)) throw new DirectoryError(400, "invalid_domains", `${domain} isn't a domain name.`);
    const other = providers.find((p) => p.id !== providerId && p.domains.includes(domain));
    if (other) throw new DirectoryError(409, "domain_claimed", `${domain} is already claimed by ${other.label}.`);
  }
  return domains;
}

export function parseHttpUrl(value: unknown, what: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(typeof value === "string" ? value.trim() : "");
  } catch {
    throw new DirectoryError(400, "invalid_url", `Enter the ${what} as a full URL.`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new DirectoryError(400, "https_required", `The ${what} must use https.`);
  }
  if (url.username || url.password) throw new DirectoryError(400, "invalid_url", `The ${what} can't contain a user name or password.`);
  url.hash = "";
  return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/");
}

/** PEM or bare base64 DER → PEM, checked to be an X.509 certificate. */
export function parseCertificate(value: unknown): { pem: string; certificate: X509Certificate } {
  const text = typeof value === "string" ? value.trim() : "";
  const body = text.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new DirectoryError(400, "invalid_certificate", "Paste the identity provider's signing certificate (PEM).");
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  try {
    return { pem, certificate: new X509Certificate(pem) };
  } catch {
    throw new DirectoryError(400, "invalid_certificate", "That isn't a valid X.509 certificate.");
  }
}

function attributeName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.trim().slice(0, 200) : "";
  return name || fallback;
}

export function parseScopes(value: unknown): string[] {
  const scopes = Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(s)) : [];
  const set = new Set(["openid", "email", "profile", ...scopes]);
  return [...set].slice(0, 20);
}

export function parseSaml(input: Record<string, unknown>, current: SamlSettings | undefined, allowHttp: boolean): SamlSettings {
  const certificate = input.certificate !== undefined && input.certificate !== "" ? parseCertificate(input.certificate).pem : current?.certificate;
  if (!certificate) throw new DirectoryError(400, "invalid_certificate", "Paste the identity provider's signing certificate (PEM).");
  const idpIssuer = input.idpIssuer !== undefined ? (typeof input.idpIssuer === "string" ? input.idpIssuer.trim().slice(0, 500) : "") : current?.idpIssuer ?? "";
  return {
    entryPoint: input.entryPoint !== undefined ? parseHttpUrl(input.entryPoint, "single sign-on URL", allowHttp) : (current?.entryPoint ?? parseHttpUrl("", "single sign-on URL", allowHttp)),
    ...(idpIssuer ? { idpIssuer } : {}),
    certificate,
    emailAttribute: attributeName(input.emailAttribute, current?.emailAttribute ?? "email"),
    nameAttribute: attributeName(input.nameAttribute, current?.nameAttribute ?? "displayName"),
    groupsAttribute: attributeName(input.groupsAttribute, current?.groupsAttribute ?? "groups")
  };
}

/* ───────────── views ───────────── */

export interface ProviderUrls {
  redirectUri: string;
  spEntityId: string;
  acsUrl: string;
  metadataUrl: string;
}

export function providerUrls(gatewayUrl: string, providerId: string): ProviderUrls {
  return {
    redirectUri: `${gatewayUrl}/api/sso/oidc/${providerId}/callback`,
    spEntityId: `${gatewayUrl}/api/sso/saml/${providerId}/metadata`,
    acsUrl: `${gatewayUrl}/api/sso/saml/${providerId}/acs`,
    metadataUrl: `${gatewayUrl}/api/sso/saml/${providerId}/metadata`
  };
}

export function providerView(record: SsoProviderRecord, gatewayUrl: string, hasClientSecret: boolean): SsoProviderView {
  const urls = providerUrls(gatewayUrl, record.id);
  let certificate: { subject: string; expiresAt: string } | null = null;
  if (record.saml) {
    try {
      const cert = new X509Certificate(record.saml.certificate);
      certificate = { subject: cert.subject.replace(/\n/g, ", "), expiresAt: new Date(cert.validTo).toISOString() };
    } catch {
      certificate = null;
    }
  }
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    enabled: record.enabled,
    domains: record.domains,
    ...(record.oidc
      ? {
          oidc: {
            issuer: record.oidc.issuer,
            clientId: record.oidc.clientId,
            hasClientSecret,
            scopes: record.oidc.scopes,
            groupsClaim: record.oidc.groupsClaim,
            redirectUri: urls.redirectUri
          }
        }
      : {}),
    ...(record.saml
      ? {
          saml: {
            entryPoint: record.saml.entryPoint,
            ...(record.saml.idpIssuer ? { idpIssuer: record.saml.idpIssuer } : {}),
            certificate,
            emailAttribute: record.saml.emailAttribute,
            nameAttribute: record.saml.nameAttribute,
            groupsAttribute: record.saml.groupsAttribute,
            spEntityId: urls.spEntityId,
            acsUrl: urls.acsUrl,
            metadataUrl: urls.metadataUrl
          }
        }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export type { SsoConfigView };
