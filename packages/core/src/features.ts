/**
 * Editions, enterprise features and the extension points enterprise modules
 * plug into.
 *
 * The one-way rule: open-source code never imports from `ee/`. It calls the
 * hooks defined here; enterprise code (under `ee/`, Sibyl Enterprise License)
 * registers itself through them. Deleting `ee/` leaves a working product.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditEvent, AuditSink, Governance, SecondApprover, ToolPolicyHook } from "./governance";
import type { ScheduledJobType } from "./jobs";
import type { LicenseVerification } from "./license";
import type { NotificationKind, NotificationLinks } from "./notifications";
import type { Policy, Principal } from "./permissions";
import type { Store } from "./store";
import type { ToolRegistry } from "./tools";
import type { UsageMeter, UsagePolicy } from "./usage";

/** Everything Sibyl Enterprise adds. Teams and workspaces are free and not listed. */
export const FEATURES = {
  custom_roles: { title: "Custom roles", description: "Define roles beyond owner, admin, member and viewer." },
  policies: { title: "Policies", description: "Organisation-wide rules for tools, models, data and sharing." },
  sso: { title: "Single sign-on", description: "Sign in through SAML or OpenID Connect identity providers." },
  scim: { title: "SCIM provisioning", description: "Create and remove users and groups from your identity provider." },
  audit_log: { title: "Audit log", description: "A tamper-evident record of who did what, exportable to your SIEM." },
  usage_advanced: { title: "Advanced usage controls", description: "Per-team and per-user budgets, quotas and reports." },
  connector_hubspot: { title: "HubSpot connector", description: "Read and update HubSpot CRM records." },
  connector_salesforce: { title: "Salesforce connector", description: "Read and update Salesforce records." },
  recordings: { title: "Call recordings", description: "Record calls (LiveKit egress), keep them for a set time and download them." }
} as const satisfies Record<string, { title: string; description: string }>;

export type FeatureId = keyof typeof FEATURES;

export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FEATURES, value);
}

export type Edition = "oss" | "enterprise";

/** What the running instance may do, derived from the licence key. */
export interface FeatureGate {
  edition: Edition;
  /** "none": no key; "valid"; "expired"; "invalid": signature/format problem. */
  status: "none" | "valid" | "expired" | "invalid";
  /** Failure reason when status is "expired" or "invalid". */
  reason?: string;
  has(feature: FeatureId | (string & {})): boolean;
  /** Enabled features (known ids only). */
  features: FeatureId[];
  licensee?: string;
  seats?: number;
  expiresAt?: string;
}

/**
 * Turn a verification result into a gate. Only a valid key enables
 * anything; an expired or broken key gives the open-source edition (with the
 * licensee/expiry kept for display) — never a lock-out.
 */
export function createFeatureGate(license?: LicenseVerification): FeatureGate {
  const payload = license?.payload;
  const status: FeatureGate["status"] = !license || license.reason === "missing"
    ? "none"
    : license.valid
      ? "valid"
      : license.reason === "expired"
        ? "expired"
        : "invalid";
  const features = license?.valid && payload ? payload.features.filter(isFeatureId) : [];
  const enabled = new Set<string>(features);
  return {
    edition: license?.valid ? "enterprise" : "oss",
    status,
    ...(license?.reason && license.reason !== "missing" ? { reason: license.reason } : {}),
    has: (feature) => enabled.has(feature),
    features,
    ...(payload ? { licensee: payload.licensee, seats: payload.seats, expiresAt: payload.expiresAt } : {})
  };
}

/* ── Enterprise module registry ── */

/**
 * Handles one HTTP request; returns true when it did (same contract as the
 * gateway's routes). `api` carries the gateway's CORS allowlist (ALLOWED_ORIGINS).
 */
export type HttpRouteHandler = (request: IncomingMessage, response: ServerResponse, api?: { allowedOrigins?: readonly string[] }) => boolean;

/**
 * Extra permission rule an enterprise module may add (custom roles,
 * per-resource grants). It gets the principal, the permission, the workspace,
 * what the built-in roles decided and, when the caller names one, the
 * resource (e.g. `{ kind: "connection", id }`). Return "deny" to block,
 * "allow" to grant, undefined to leave the decision to the others.
 * The gateway registers these with `authorize()` (permissions.ts) while the
 * module is installed.
 */
export type PermissionPolicyHook = Policy;

/** A notification an enterprise module asks the gateway to deliver (inbox, live push). */
export interface EnterpriseNotice {
  kind: NotificationKind;
  workspaceId?: string;
  recipientUserId?: string;
  title: string;
  body?: string;
  links?: NotificationLinks;
}

/** The gateway's one mailer (absent when SMTP isn't configured). */
export interface EnterpriseMailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** The secrets vault, bound to the organisation (absent without SIBYL_SECRET_KEY / a vault key). */
export interface EnterpriseSecrets {
  /**
   * Store or replace a value that may only be sent to `allowedHosts`. Without
   * `value`, an existing secret keeps its value and only its details change
   * (e.g. a webhook moved to another host).
   */
  set(input: { name: string; value?: string; service?: string; description?: string; allowedHosts?: string[] }): Promise<void>;
  /** The value, only for a host the secret allows (throws otherwise). */
  resolve(name: string, host: string): Promise<string>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<void>;
}

export interface EnterpriseModuleContext {
  gate: FeatureGate;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  /** The gateway's one mailer (SIBYL_SMTP_URL); undefined when email isn't set up. */
  mailer?: EnterpriseMailer;
  /** The secrets vault (signing keys, tokens); undefined when the vault is off. */
  secrets?: EnterpriseSecrets;
  log(event: string, fields?: Record<string, unknown>): void;
  /** Serve extra gateway HTTP routes (checked before the 404). */
  registerHttpRoute(handler: HttpRouteHandler): void;
  /** Add a permission rule (see PermissionPolicyHook). */
  registerPermissionPolicy(policy: PermissionPolicyHook): void;
  /** Record an audit event through the runtime's one audit path. */
  audit(event: AuditEvent): void;
  /** Receive every audit event (the audit log). Removed when the module closes. */
  registerAuditSink(sink: AuditSink): void;
  /** Block tools, mark writes for a second approval, restrict models. Removed when the module closes. */
  registerToolPolicy(policy: ToolPolicyHook): void;
  /** Answer second-approval requests (one approver per runtime). Removed when the module closes. */
  registerSecondApprover(approver: SecondApprover): void;
  /** Deliver a notification (absent in bare runtimes). */
  notify?(notice: EnterpriseNotice): void;
  /** Run a job type on the gateway's one scheduler (absent when routines are off in a bare runtime). */
  addJobType?(type: ScheduledJobType<any>): void;
  /** Add sign-in providers and session rules (see IdentityExtension). */
  registerIdentityExtension(extension: IdentityExtension): void;
  /** Add a usage policy the meter consults after its own caps (see UsagePolicy in usage.ts). */
  registerUsagePolicy(policy: UsagePolicy): void;
}

/** What the gateway passes to `install()`; the registry adds the register functions. */
export type EnterpriseInstallContext = Omit<
  EnterpriseModuleContext,
  "registerHttpRoute" | "registerPermissionPolicy" | "registerIdentityExtension" | "registerUsagePolicy" | "audit" | "registerAuditSink" | "registerToolPolicy" | "registerSecondApprover"
> & { governance: Governance };

export interface EnterpriseModule {
  id: string;
  /** The module installs only when the licence enables this feature. */
  feature: FeatureId;
  install(ctx: EnterpriseModuleContext): void | { close?(): void | Promise<void> } | Promise<void | { close?(): void | Promise<void> }>;
}

/* ── Identity extensions (sign-in providers, session rules) ── */

/**
 * A way to sign in other than email + password, shown on the sign-in screen
 * as "Continue with <label>". The open-source edition has none.
 */
export interface SignInProvider {
  id: string;
  kind: "oidc" | "saml";
  label: string;
  /** Gateway path that starts the sign-in (the browser navigates there; `?next=` is passed on). */
  startPath: string;
}

/**
 * How someone is signing in: a password, the organization's SSO (oidc,
 * saml), an emailed sign-in link, or "Continue with Google / Microsoft".
 */
export type SignInMethod = "password" | "oidc" | "saml" | "magic_link" | "google" | "microsoft";

/** Answer to "may this person sign in now?". */
export type SignInDecision =
  | { allow: true; /** Password sign-ins: ask for a second factor (enrolling one first if needed). */ requireMfa?: boolean }
  | { allow: false; code: string; message: string };

/** Answer to "is this session still good for this request?". */
export type SessionDecision =
  | { allow: true; /** Write the session's last-seen time at least this often (idle timeouts). */ touchEveryMs?: number }
  | {
      allow: false;
      code: string;
      message: string;
      /** End the session for good (expired); false refuses only this request (e.g. from outside the allowed networks). */
      end: boolean;
    };

/** The part of the secrets vault identity extensions use (organization secrets, never shown). */
export interface IdentitySecrets {
  set(input: { name: string; value: string; allowedHosts: string[]; service: string; description: string }): Promise<void>;
  /** The value, only for a host the secret allows. */
  resolve(name: string, host: string): Promise<string>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<void>;
}

/**
 * The one session code, handed to identity extensions once the gateway's
 * identity service exists. Providers only establish who someone is; the
 * session (cookie, expiry, revocation, policy checks) is always made here.
 */
export interface IdentityBridge {
  orgId: string;
  /** ALLOWED_ORIGINS (empty: pages on the gateway's own host name), for CORS on admin routes. */
  allowedOrigins: readonly string[];
  /** Who is calling: session cookie (from an allowed origin) or the owner token. */
  authenticate(request: IncomingMessage): Promise<{ principal: Principal } | undefined>;
  /**
   * Sign `userId` in: runs every extension's checkSignIn, creates the session
   * and returns the Set-Cookie header value. Throws an error carrying
   * `status`, `code` and `message` when sign-in is refused.
   */
  createSession(request: IncomingMessage, userId: string, method: Exclude<SignInMethod, "password">): Promise<{ setCookie: string }>;
  /** End every session of a user (deactivated by the directory). */
  endSessions(userId: string): Promise<void>;
  /** Users or memberships changed outside the identity service: open connections re-check their access. */
  changed(change: { kind: "memberships" | "user"; userId?: string }): void;
  /** The caller's address (X-Forwarded-For only from a local proxy). */
  clientIp(request: IncomingMessage): string;
  /** The web app's address, for redirects back after an external sign-in. */
  appUrl(request: IncomingMessage): string;
  /** The gateway's public address (SIBYL_PUBLIC_GATEWAY_URL, else the request's), for callback URLs. */
  gatewayUrl(request: IncomingMessage): string;
  /** The secrets vault (undefined when it has no key). */
  secrets?: IdentitySecrets;
}

/**
 * Enterprise identity: SSO providers, enforced SSO, session policies. Every
 * hook is optional; with none registered the open-source behaviour (password
 * sign-in, 30-day sliding sessions) is unchanged.
 */
export interface IdentityExtension {
  id: string;
  /** Buttons for the sign-in screen. */
  signInProviders?(): Promise<SignInProvider[]>;
  /** Before any session is created (password and external sign-in). The first refusal wins. */
  checkSignIn?(input: { userId: string; email: string; orgRole?: string; method: SignInMethod; ip: string }): Promise<SignInDecision>;
  /** Whenever a session cookie is used. The first refusal wins. */
  checkSession?(input: { userId: string; sessionId: string; createdAt: number; lastSeenAt: number; ip?: string; now: number }): Promise<SessionDecision>;
  /** Receive the identity bridge (once, when the gateway starts). */
  attach?(bridge: IdentityBridge): void;
  /**
   * Facts about accounts for Admin → Users (SSO sign-in, SCIM-managed).
   * Results of several extensions are merged per user id; users left out
   * have nothing to add.
   */
  describeUsers?(userIds: readonly string[]): Promise<Record<string, ExternalUserFacts>>;
}

/** What an identity extension knows about an account (Admin → Users). */
export interface ExternalUserFacts {
  /** Signs in through single sign-on (provider labels, when known). */
  sso?: { providers: string[] };
  /**
   * The identity provider manages this account (SCIM): turning it off/on
   * and removing it happen there, so Admin → Users shows it read-only.
   */
  managedBy?: "scim";
}

/** What `ee/gateway` receives: register functions only, no gateway internals. */
export interface EnterpriseRegistrar {
  registerEnterpriseModule(module: EnterpriseModule): void;
}

export interface EnterpriseInstallResult {
  installed: string[];
  skipped: Array<{ id: string; feature: FeatureId }>;
  failed: Array<{ id: string; error: string }>;
  httpRoutes: HttpRouteHandler[];
  permissionPolicies: PermissionPolicyHook[];
  identityExtensions: IdentityExtension[];
  usagePolicies: UsagePolicy[];
  close(): Promise<void>;
}

export interface EnterpriseRegistry extends EnterpriseRegistrar {
  list(): EnterpriseModule[];
  /** Install every registered module whose feature the gate enables. */
  install(ctx: EnterpriseInstallContext): Promise<EnterpriseInstallResult>;
}

export function createEnterpriseRegistry(): EnterpriseRegistry {
  const modules = new Map<string, EnterpriseModule>();
  return {
    registerEnterpriseModule(module) {
      if (!module.id || modules.has(module.id)) throw new Error(`enterprise module "${module.id}" is already registered`);
      if (!isFeatureId(module.feature)) throw new Error(`enterprise module "${module.id}" has unknown feature "${module.feature}"`);
      modules.set(module.id, module);
    },
    list: () => [...modules.values()],
    async install({ governance, ...base }) {
      const httpRoutes: HttpRouteHandler[] = [];
      const permissionPolicies: PermissionPolicyHook[] = [];
      const identityExtensions: IdentityExtension[] = [];
      const usagePolicies: UsagePolicy[] = [];
      const closers: Array<() => void | Promise<void>> = [];
      const result: EnterpriseInstallResult = {
        installed: [],
        skipped: [],
        failed: [],
        httpRoutes,
        permissionPolicies,
        identityExtensions,
        usagePolicies,
        close: async () => {
          for (const close of closers.reverse()) await close();
        }
      };
      for (const module of modules.values()) {
        if (!base.gate.has(module.feature)) {
          result.skipped.push({ id: module.id, feature: module.feature });
          continue;
        }
        try {
          const handle = await module.install({
            ...base,
            registerHttpRoute: (handler) => httpRoutes.push(handler),
            registerPermissionPolicy: (policy) => permissionPolicies.push(policy),
            audit: (event) => governance.audit(event),
            registerAuditSink: (sink) => closers.push(governance.registerAuditSink(sink)),
            registerToolPolicy: (policy) => closers.push(governance.registerToolPolicy(policy)),
            registerSecondApprover: (approver) => closers.push(governance.setSecondApprover(approver)),
            registerIdentityExtension: (extension) => identityExtensions.push(extension),
            registerUsagePolicy: (policy) => usagePolicies.push(policy)
          });
          if (handle && typeof handle.close === "function") closers.push(handle.close.bind(handle));
          result.installed.push(module.id);
        } catch (error) {
          // A broken enterprise module never takes the open-source product down.
          result.failed.push({ id: module.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    }
  };
}

/** Process-wide registry used by the gateway. */
const defaultRegistry = createEnterpriseRegistry();

export function registerEnterpriseModule(module: EnterpriseModule): void {
  defaultRegistry.registerEnterpriseModule(module);
}

export function enterpriseRegistry(): EnterpriseRegistry {
  return defaultRegistry;
}
