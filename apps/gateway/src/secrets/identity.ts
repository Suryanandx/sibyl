/**
 * The vault as identity extensions see it (IdentitySecrets in
 * @open-gpt-live/core): organization secrets such as an identity provider's
 * client secret. Same encryption, host binding and redaction as every other
 * secret; listed by name in Settings → Secrets, never shown.
 */
import type { IdentitySecrets } from "@open-gpt-live/core";
import type { SecretVault } from "./vault.js";

export function identitySecrets(vault: SecretVault, ownerId: string): IdentitySecrets {
  return {
    async set(input) {
      await vault.set(ownerId, input);
    },
    resolve: (name, host) => vault.resolve(ownerId, name, { host }),
    has: (name) => vault.has(ownerId, name),
    async delete(name) {
      await vault.delete(ownerId, name);
    }
  };
}
