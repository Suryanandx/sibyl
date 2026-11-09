/**
 * SCIM provisioning — Sibyl Enterprise (licence feature `scim`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * The identity provider creates, updates and turns off accounts and groups
 * through SCIM 2.0 (see service.ts). It registers an identity extension only
 * to receive the identity bridge (ending sessions on deactivation, telling
 * open connections that memberships changed).
 */
import type { EnterpriseModule } from "../../../packages/core/src/index";
import { identityContext } from "../directory/context";
import { registerDirectoryRoutes } from "../directory/http";
import { scimRoutes } from "./http";
import { ScimTokens } from "./tokens";

export const scimModule: EnterpriseModule = {
  id: "scim",
  feature: "scim",
  install(ctx) {
    const context = identityContext(ctx);
    ctx.registerIdentityExtension({
      id: "scim",
      attach: (bridge) => context.setBridge(bridge),
      // Admin → Users shows accounts the identity provider manages as read-only.
      async describeUsers(userIds) {
        const out: Record<string, { managedBy: "scim" }> = {};
        for (const userId of userIds) {
          const record = await context.directory.record(userId);
          if (record && (record.createdBy === "scim" || record.externalId)) out[userId] = { managedBy: "scim" };
        }
        return out;
      }
    });
    ctx.registerHttpRoute(scimRoutes(context, new ScimTokens({ store: ctx.store, orgId: ctx.ownerId })));
    registerDirectoryRoutes(context, ctx.registerHttpRoute);
    ctx.log("enterprise.scim_installed", {});
  }
};
