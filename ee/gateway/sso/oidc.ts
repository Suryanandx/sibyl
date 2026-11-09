/**
 * OpenID Connect sign-in — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * The OIDC client itself (discovery, PKCE, ID token checks) is the
 * open-source one in apps/gateway/src/identity/oidc.ts, shared with
 * "Continue with Google / Microsoft". SSO providers on a private network
 * (on-premises, or a local test IdP) need SIBYL_SSO_ALLOW_PRIVATE_NETWORK=true;
 * plain http is accepted only then, too.
 */
import { OidcClients as SharedOidcClients } from "../../../apps/gateway/src/identity/oidc";

export type { OidcIdentity } from "../../../apps/gateway/src/identity/oidc";

export function privateNetworkAllowed(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes)$/i.test(env.SIBYL_SSO_ALLOW_PRIVATE_NETWORK?.trim() ?? "");
}

/** The shared OIDC client, with the SSO private-network setting. */
export class OidcClients extends SharedOidcClients {
  constructor(env: NodeJS.ProcessEnv) {
    super({ allowPrivateNetwork: privateNetworkAllowed(env) });
  }
}
