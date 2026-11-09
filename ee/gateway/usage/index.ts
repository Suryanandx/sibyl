/**
 * Advanced usage controls (feature `usage_advanced`) — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Adds, on top of the open-source organisation budgets (which still apply
 * first, with the 85% economy switch unchanged):
 *   - per-person and per-role daily/monthly budgets,
 *   - a per-request cost cap and an allowed-models list,
 *   - a requests-per-minute limit per person,
 *   - alerts at thresholds by email (the one mailer) and signed webhook,
 *   - a chargeback report by workspace and person, with CSV export.
 *
 * It plugs in through two core hooks only: a usage policy the meter asks
 * (EnterpriseModuleContext.registerUsagePolicy) and an HTTP route behind the
 * gateway's permission gate (registerHttpRoute).
 */
import type { EnterpriseModule } from "../../../packages/core/src/features";
import { parseAllowedOrigins } from "../../../apps/gateway/src/config";
import { createUsageControlsRoute } from "./http";
import { UsageControlsService } from "./service";

export const usageControlsModule: EnterpriseModule = {
  id: "usage-controls",
  feature: "usage_advanced",
  async install(ctx) {
    const service = await new UsageControlsService({
      store: ctx.store,
      ownerId: ctx.ownerId,
      env: ctx.env,
      ...(ctx.mailer ? { mailer: ctx.mailer } : {}),
      ...(ctx.secrets ? { secrets: ctx.secrets } : {}),
      log: ctx.log
    }).init();
    ctx.registerUsagePolicy(service.policy);
    ctx.registerHttpRoute(createUsageControlsRoute({ service, allowedOrigins: parseAllowedOrigins(ctx.env.ALLOWED_ORIGINS), log: ctx.log }));
    ctx.log("enterprise.module_loaded", { module: "usage-controls", people: Object.keys(service.controls.users).length });
    return { close: () => service.alerts.flush() };
  }
};

export { UsageControlsService } from "./service";
