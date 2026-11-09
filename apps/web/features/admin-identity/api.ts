"use client";

/**
 * Browser client for sign-in providers, two-step verification, SSO, SCIM and
 * session policies (routes listed in @open-gpt-live/protocol, "Sign-in
 * providers, two-step verification, SSO, SCIM & session policies"). Calls go
 * through the shared gateway client.
 */
import type {
  DirectorySettingsView,
  GroupRoleRule,
  MfaSetupResponse,
  MfaStatusView,
  ScimTokenView,
  SessionPolicyView,
  SignInProvidersResponse,
  SignInResponse,
  SsoConfigView,
  SsoProviderInput,
  SsoProviderView
} from "@open-gpt-live/protocol";
import { gatewayHttpUrl, gatewayRequest } from "../../lib/gateway-http";

/** Calls made before anyone is signed in: no owner token, no workspace. */
const anonymous = { ownerToken: null, workspaceId: null } as const;

export const signInApi = {
  providers: () => gatewayRequest<SignInProvidersResponse>("/api/auth/providers", anonymous),
  login: (email: string, password: string) => gatewayRequest<SignInResponse>("/api/auth/login", { method: "POST", body: { email, password }, ...anonymous }),
  verify: (challenge: string, answer: { code: string } | { recoveryCode: string }, org?: string) =>
    gatewayRequest<SignInResponse>("/api/auth/mfa/verify", {
      method: "POST",
      body: { challenge, ...answer },
      ...anonymous,
      // Hosted: names the organization of this signed-out step.
      ...(org ? { headers: { "x-sibyl-org": org } } : {})
    }),
  /** Full gateway URL that starts an SSO sign-in (the browser navigates there). */
  startUrl: (startPath: string, next: string) => `${gatewayHttpUrl()}${startPath}?next=${encodeURIComponent(next)}`
};

export const mfaApi = {
  status: () => gatewayRequest<MfaStatusView>("/api/auth/mfa"),
  setup: () => gatewayRequest<MfaSetupResponse>("/api/auth/mfa/setup", { method: "POST", body: {} }),
  enable: (setupToken: string, code: string) =>
    gatewayRequest<{ recoveryCodes: string[]; status: MfaStatusView }>("/api/auth/mfa/enable", { method: "POST", body: { setupToken, code } }),
  disable: (code: string) => gatewayRequest<{ status: MfaStatusView }>("/api/auth/mfa/disable", { method: "POST", body: proof(code) }),
  newRecoveryCodes: (code: string) =>
    gatewayRequest<{ recoveryCodes: string[]; status: MfaStatusView }>("/api/auth/mfa/recovery-codes", { method: "POST", body: proof(code) })
};

/** A 6-digit code, or a recovery code (letters and dashes). */
function proof(code: string): { code: string } | { recoveryCode: string } {
  const value = code.trim();
  return /^\d{6}$/.test(value.replace(/\s/g, "")) ? { code: value.replace(/\s/g, "") } : { recoveryCode: value };
}
export { proof as mfaProof };

export const ssoApi = {
  config: () => gatewayRequest<SsoConfigView>("/api/sso/config"),
  saveConfig: (input: { enforce?: boolean; breakGlassUserId?: string | null }) => gatewayRequest<SsoConfigView>("/api/sso/config", { method: "PUT", body: input }),
  add: (input: SsoProviderInput) => gatewayRequest<{ provider: SsoProviderView }>("/api/sso/providers", { method: "POST", body: input }),
  update: (id: string, input: SsoProviderInput) => gatewayRequest<{ provider: SsoProviderView }>(`/api/sso/providers/${id}`, { method: "PATCH", body: input }),
  remove: (id: string) => gatewayRequest<{ ok: true }>(`/api/sso/providers/${id}`, { method: "DELETE" }),
  test: (id: string) => gatewayRequest<{ ok: boolean; message: string }>(`/api/sso/providers/${id}/test`, { method: "POST" })
};

export const directoryApi = {
  get: () => gatewayRequest<DirectorySettingsView>("/api/directory"),
  save: (input: Partial<{ defaultWorkspaceId: string; defaultRole: string; jitProvisioning: boolean; groupRoles: GroupRoleRule[] }>) =>
    gatewayRequest<DirectorySettingsView>("/api/directory", { method: "PUT", body: input })
};

export const scimApi = {
  list: () => gatewayRequest<{ tokens: ScimTokenView[]; baseUrl: string }>("/api/scim/tokens"),
  create: (label: string) => gatewayRequest<{ token: ScimTokenView; secret: string; baseUrl: string }>("/api/scim/tokens", { method: "POST", body: { label } }),
  revoke: (id: string) => gatewayRequest<{ ok: true }>(`/api/scim/tokens/${id}`, { method: "DELETE" })
};

export const sessionPolicyApi = {
  get: () => gatewayRequest<SessionPolicyView>("/api/session-policy"),
  save: (input: { maxSessionHours?: number | null; idleTimeoutMinutes?: number | null; ipAllowlist: string[]; requireMfa: boolean }) =>
    gatewayRequest<SessionPolicyView>("/api/session-policy", { method: "PUT", body: input })
};

/** Messages for `?sso_error=` codes the gateway sends the browser back with. */
export function ssoErrorMessage(code: string): string {
  switch (code) {
    case "sso_expired":
      return "That sign-in took too long or was already used. Try again.";
    case "sso_browser_mismatch":
      return "Finish signing in in the same browser you started in.";
    case "sso_domain_not_allowed":
      return "Your identity provider can't sign in that email address here.";
    case "sso_no_email":
      return "Your identity provider didn't share your email address.";
    case "sso_email_unverified":
      return "Your identity provider says your email address isn't verified.";
    case "sso_no_account":
      return "There's no Sibyl account for you yet. Ask an admin to add you.";
    case "account_disabled":
      return "This account is turned off. Ask an admin.";
    case "ip_not_allowed":
      return "Your organization only allows sign-in from its own networks.";
    case "sso_denied":
      return "The identity provider didn't let you in.";
    case "sso_unavailable":
      return "That sign-in option isn't available any more.";
    default:
      return "Single sign-on didn't work. Try again, or ask an admin.";
  }
}
