/**
 * Single sign-on and session policies — Sibyl Enterprise (licence feature `sso`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Plugs into the open-source identity service through the IdentityExtension
 * hook (packages/core/src/features.ts):
 * - signInProviders: "Continue with <provider>" on the sign-in screen;
 * - checkSignIn: enforced SSO (password sign-in refused for claimed domains,
 *   except the break-glass owner), allowed networks, required two-step
 *   verification for password sign-ins;
 * - checkSession: maximum lifetime, idle timeout, allowed networks.
 * Providers only establish who someone is; sessions are created by the
 * identity service through the bridge (bridge.createSession).
 */
import type { EnterpriseModule, IdentityExtension, SignInDecision } from "../../../packages/core/src/index";
import { identityContext } from "../directory/context";
import { registerDirectoryRoutes } from "../directory/http";
import { SsoStore } from "./config";
import { ssoRoutes } from "./http";
import { OidcClients } from "./oidc";
import { SamlProviders } from "./saml";
import { SessionPolicyStore } from "./session-policy";
import { SignInState } from "./signin";

/** How often live connections re-check time-limited sessions. */
const RECHECK_MS = 60_000;

export const ssoModule: EnterpriseModule = {
  id: "sso",
  feature: "sso",
  install(ctx) {
    const context = identityContext(ctx);
    const sso = new SsoStore({ store: ctx.store, orgId: ctx.ownerId });
    const policy = new SessionPolicyStore({ store: ctx.store, orgId: ctx.ownerId });
    const deps = { context, sso, policy, oidc: new OidcClients(ctx.env), saml: new SamlProviders(), state: new SignInState() };

    const extension: IdentityExtension = {
      id: "sso",
      async signInProviders() {
        return (await sso.get()).providers
          .filter((provider) => provider.enabled)
          .map((provider) => ({ id: provider.id, kind: provider.kind, label: provider.label, startPath: `/api/sso/${provider.id}/start` }));
      },
      async checkSignIn(input): Promise<SignInDecision> {
        const network = await policy.checkSignIn(input);
        if (!network.allow) return network;
        // Every way in except the organization's own SSO: passwords, email links, Continue with Google / Microsoft.
        if (input.method !== "oidc" && input.method !== "saml") {
          const settings = await sso.get();
          const provider = settings.enforce ? await sso.providerForEmail(input.email) : undefined;
          if (provider && input.userId !== settings.breakGlassUserId) {
            return { allow: false, code: "sso_required", message: `Your organization signs in with ${provider.label}. Use “Continue with ${provider.label}”.` };
          }
        }
        return network;
      },
      checkSession: (input) => policy.checkSession(input),
      // Admin → Users: who signs in through which provider (linked identities, or accounts SSO created).
      async describeUsers(userIds) {
        const labels = new Map((await sso.get()).providers.map((provider) => [provider.id, provider.label] as const));
        const out: Record<string, { sso: { providers: string[] } }> = {};
        for (const userId of userIds) {
          const record = await context.directory.record(userId);
          const ids = new Set(record?.links?.map((link) => link.providerId) ?? []);
          if (record?.createdBy && record.createdBy !== "scim") ids.add(record.createdBy);
          if (ids.size > 0) out[userId] = { sso: { providers: [...ids].map((id) => labels.get(id) ?? id) } };
        }
        return out;
      },
      attach(bridge) {
        context.setBridge(bridge);
      }
    };
    ctx.registerIdentityExtension(extension);
    ctx.registerHttpRoute(ssoRoutes(deps));
    registerDirectoryRoutes(context, ctx.registerHttpRoute);

    // Lifetime and idle limits also end live WebSocket connections: ask them to re-check.
    const timer = setInterval(() => {
      void policy
        .timeLimited()
        .then((limited) => {
          if (limited) context.bridge().changed({ kind: "memberships" });
        })
        .catch(() => undefined);
    }, RECHECK_MS);
    timer.unref();
    ctx.log("enterprise.sso_installed", {});
    return { close: () => clearInterval(timer) };
  }
};
