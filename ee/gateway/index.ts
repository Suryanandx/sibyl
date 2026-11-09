/**
 * Sibyl Enterprise — gateway modules.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * How this is loaded (apps/gateway/src/license/ee-loader.ts is the only
 * open-source file that reaches in here):
 *   1. The gateway verifies the licence key at startup.
 *   2. If the key enables at least one feature, it calls the default export
 *      below with a registrar.
 *   3. Each registered module is installed only when its `feature` is in the
 *      licence. `install(ctx)` gets the gateway runtime: tool registry, store,
 *      usage meter, an HTTP route hook and a permission policy hook.
 *
 * Code here may import from the open-source code (the gateway bundle includes
 * both, so each module still exists once — e.g. the connector catalogue).
 * Open-source code must never import from here —
 * scripts/check-ee-boundary.mjs enforces it.
 */
import type { EnterpriseRegistrar } from "../../packages/core/src/features";
import { auditLogModule } from "./audit/index";
import { connectorModules } from "./connectors/index";
import { governanceModules } from "./governance/index";
import { scimModule } from "./scim/index";
import { ssoModule } from "./sso/index";
import { usageControlsModule } from "./usage/index";
import { recordingsModule } from "./recordings/index";

export default function registerEnterprise(registrar: EnterpriseRegistrar): void {
  // The audit log first, so it records what the other modules do from the start.
  registrar.registerEnterpriseModule(auditLogModule);
  // Custom roles and per-resource grants (custom_roles); policies (policies).
  for (const module of governanceModules) registrar.registerEnterpriseModule(module);
  // HubSpot (connector_hubspot) and Salesforce (connector_salesforce).
  for (const module of connectorModules) registrar.registerEnterpriseModule(module);
  // Single sign-on + session policies (sso) and SCIM provisioning (scim).
  registrar.registerEnterpriseModule(ssoModule);
  registrar.registerEnterpriseModule(scimModule);
  // Advanced usage controls (usage_advanced).
  registrar.registerEnterpriseModule(usageControlsModule);
  // Call recordings (recordings): LiveKit egress, retention, list and download.
  registrar.registerEnterpriseModule(recordingsModule);
}
