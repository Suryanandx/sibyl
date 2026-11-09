"use client";

/**
 * Sign-up and the sign-in methods beyond a password (gateway: identity/signup*.ts):
 * emailed links and codes, Continue with Google / Microsoft, choosing an
 * organization, and creating one (POST /api/orgs, hosted).
 */
import type { OrgCreatedResponse, SignInResponse, SignupEmailSent, SignupOptionsView, SignupResult, SignupTicketView } from "@open-gpt-live/protocol";
import { GatewayError, gatewayHttpUrl, gatewayRequest, gatewayUrlFor } from "../../lib/gateway-http";

/** Names the organization of a signed-out request (hosted). */
const ORG_HEADER = "x-sibyl-org";

/** Signed-out calls: no owner token, no workspace. */
const anonymous = { ownerToken: null, workspaceId: null } as const;

let cachedOptions: Promise<SignupOptionsView> | null = null;

export const signupApi = {
  /** Which ways in this server offers (cached per page). */
  options(): Promise<SignupOptionsView> {
    cachedOptions ??= gatewayRequest<SignupOptionsView>("/api/signup/options", anonymous).catch((error) => {
      cachedOptions = null;
      throw error;
    });
    return cachedOptions;
  },
  email: (input: { email: string; method: "magic_link" | "password"; password?: string; name?: string; next?: string }) =>
    gatewayRequest<SignupEmailSent>("/api/signup/email", { method: "POST", body: input, ...anonymous }),
  code: (email: string, code: string) => gatewayRequest<SignupResult>("/api/signup/code", { method: "POST", body: { email, code }, ...anonymous }),
  link: (token: string) => gatewayRequest<SignupResult>("/api/signup/link", { method: "POST", body: { token }, ...anonymous }),
  choices: () => gatewayRequest<{ organizations: Array<{ id: string; name: string }> }>("/api/signup/choose", anonymous),
  choose: (org: string) => gatewayRequest<SignupResult>("/api/signup/choose", { method: "POST", body: { org }, ...anonymous }),
  ticket: () => gatewayRequest<SignupTicketView>("/api/signup/ticket", anonymous),
  clearTicket: () => gatewayRequest<{ ok: true }>("/api/signup/ticket", { method: "DELETE", ...anonymous }),
  createOrg: (orgName: string, workspaceName?: string) =>
    gatewayRequest<OrgCreatedResponse>("/api/orgs", { method: "POST", body: { orgName, ...(workspaceName ? { workspaceName } : {}) }, ...anonymous }),
  /**
   * Password sign-in. Hosted: an address in several organizations answers
   * "choose_organization" with the list; send again with `org`.
   */
  async login(email: string, password: string, org?: string): Promise<SignInResponse | { choose: Array<{ id: string; name: string }> }> {
    let response: Response;
    try {
      response = await fetch(gatewayUrlFor("/api/auth/login"), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json", ...(org ? { [ORG_HEADER]: org } : {}) },
        body: JSON.stringify({ email, password, ...(org ? { org } : {}) })
      });
    } catch {
      throw new GatewayError("Can't reach Sibyl. Check that the gateway is running.", 0, "network");
    }
    const body = (await response.json().catch(() => null)) as (SignInResponse & { error?: string; message?: string; organizations?: Array<{ id: string; name: string }> }) | null;
    if (response.status === 409 && body?.error === "choose_organization" && body.organizations) return { choose: body.organizations };
    if (!response.ok || !body) throw new GatewayError(body?.message || "Couldn't sign in. Try again.", response.status, body?.error || "error");
    return body;
  },
  /** Full gateway URL that starts Continue with Google / Microsoft (the browser navigates there). */
  oauthUrl: (provider: "google" | "microsoft", next = "/") => `${gatewayHttpUrl()}/api/signup/oauth/${provider}/start?next=${encodeURIComponent(next)}`
};

/** A message for ?signin_error=<code> (Google / Microsoft) and failed links. */
export function signupErrorMessage(code: string, provider?: string | null): string {
  const who = provider === "microsoft" ? "Microsoft" : provider === "google" ? "Google" : "The provider";
  switch (code) {
    case "signin_expired":
      return "That sign-in took too long or was already used. Try again.";
    case "browser_mismatch":
      return "Finish signing in in the same browser you started in.";
    case "denied":
      return `${who} sign-in was cancelled.`;
    case "no_email":
      return `${who} didn't share your email address.`;
    case "email_unverified":
      return `${who} hasn't confirmed your email address. Use your email instead.`;
    case "no_account":
      return "There's no Sibyl account for that address here. Ask an admin for an invitation.";
    case "account_disabled":
      return "This account is turned off. Ask an admin.";
    case "sso_required":
      return "Your organization signs in with single sign-on. Use that button instead.";
    case "not_available":
      return "That sign-in option isn't available on this server.";
    case "rate_limited":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return "Couldn't sign you in. Try again.";
  }
}
