/**
 * Licence + enterprise modules for the gateway runtime.
 *
 * 1. Verify the licence key (SIBYL_LICENSE_KEY or the stored one) offline.
 * 2. If it enables any feature and `ee/gateway` is present, let it register
 *    its modules, then install the ones whose feature is licensed.
 * 3. Hand the gateway the extra HTTP routes; register the modules' permission
 *    policies with authorize() and their audit sinks / tool policies with the
 *    runtime's Governance (all removed again on close).
 *
 * Without a key, or without `ee/`, this is a no-op apart from the
 * GET /api/license state.
 */
import {
  createEnterpriseRegistry,
  registerPolicy,
  type EnterpriseMailer,
  type EnterpriseNotice,
  type EnterpriseRegistry,
  type EnterpriseSecrets,
  type Governance,
  type HttpRouteHandler,
  type ScheduledJobType,
  type IdentityExtension,
  type PermissionPolicyHook,
  type Store,
  type ToolRegistry,
  type UsageMeter
} from "@open-gpt-live/core";
import { loadEnterpriseEntry, type EnterpriseEntry } from "./ee-loader.js";
import { LicenseService } from "./service.js";

export { LicenseService, LicenseError, LICENSE_KV_KEY, type LicenseStateView } from "./service.js";
export { handleLicenseHttp } from "./http.js";

export interface LicenseRuntime {
  service: LicenseService;
  /** Routes registered by enterprise modules (checked before the 404). */
  httpRoutes: HttpRouteHandler[];
  /** Permission rules registered by enterprise modules. */
  permissionPolicies: PermissionPolicyHook[];
  /** Sign-in providers and session rules registered by enterprise modules (SSO, session policies). */
  identityExtensions: IdentityExtension[];
  /** Enterprise module ids that were installed. */
  modules: string[];
  close(): Promise<void>;
}

export interface InstallLicenseOptions {
  env: NodeJS.ProcessEnv;
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  ownerId: string;
  /** The gateway's one mailer (enterprise alerts send through it). */
  mailer?: EnterpriseMailer;
  /** The vault, bound to the organisation (enterprise signing keys live there). */
  secrets?: EnterpriseSecrets;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** The runtime's audit trail and tool/model policy (enterprise modules plug into it). */
  governance: Governance;
  notify?(notice: EnterpriseNotice): void;
  /** Run a job type on the gateway's one scheduler (retention, alerts). */
  addJobType?(type: ScheduledJobType<any>): void;
  /** Tests: override the embedded public keys. */
  publicKeys?: readonly string[];
  /** Tests: replace the `ee/gateway` lookup (return undefined to simulate no `ee/`). */
  loadEntry?: () => Promise<EnterpriseEntry | undefined>;
  /** Tests: use a private registry instead of a fresh one. */
  registry?: EnterpriseRegistry;
}

export async function installLicense(options: InstallLicenseOptions): Promise<LicenseRuntime> {
  const service = await new LicenseService({
    env: options.env,
    store: options.store,
    ownerId: options.ownerId,
    log: options.log,
    ...(options.publicKeys ? { publicKeys: options.publicKeys } : {})
  }).init();
  service.logLoaded();

  const empty: LicenseRuntime = { service, httpRoutes: [], permissionPolicies: [], identityExtensions: [], modules: [], close: async () => {} };
  const gate = service.gate;
  service.markInstalled();
  if (gate.features.length === 0) return empty;

  let entry: EnterpriseEntry | undefined;
  try {
    entry = await (options.loadEntry ?? (() => loadEnterpriseEntry({ env: options.env })))();
  } catch (error) {
    options.log("enterprise.load_failed", { error: error instanceof Error ? error.message : String(error) });
    return empty;
  }
  if (!entry) {
    options.log("enterprise.absent", { message: "licensed features are enabled but this build has no ee/ modules" });
    return empty;
  }

  const registry = options.registry ?? createEnterpriseRegistry();
  try {
    await entry({ registerEnterpriseModule: (module) => registry.registerEnterpriseModule(module) });
  } catch (error) {
    options.log("enterprise.register_failed", { error: error instanceof Error ? error.message : String(error) });
    return empty;
  }
  const result = await registry.install({
    gate,
    ownerId: options.ownerId,
    env: options.env,
    store: options.store,
    tools: options.tools,
    meter: options.meter,
    log: options.log,
    governance: options.governance,
    ...(options.notify ? { notify: options.notify } : {}),
    ...(options.addJobType ? { addJobType: options.addJobType } : {}),
    ...(options.mailer ? { mailer: options.mailer } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {})
  });
  // authorize() consults the modules' permission rules (custom roles, grants) while they are installed.
  const unregister = result.permissionPolicies.map((policy) => registerPolicy(policy));
  // Usage policies (advanced usage controls) are asked by the meter after its own caps.
  const removePolicies = result.usagePolicies.map((policy) => options.meter.addPolicy?.(policy) ?? (() => undefined));
  if (result.usagePolicies.length > 0 && !options.meter.addPolicy) options.log("enterprise.usage_policy_unsupported", {});
  options.log("enterprise.modules", {
    installed: result.installed,
    skipped: result.skipped.map((s) => s.id),
    ...(result.failed.length ? { failed: result.failed } : {})
  });
  return {
    service,
    httpRoutes: result.httpRoutes,
    permissionPolicies: result.permissionPolicies,
    identityExtensions: result.identityExtensions,
    modules: result.installed,
    close: async () => {
      for (const off of unregister) off();
      for (const remove of removePolicies) remove();
      await result.close();
    }
  };
}
