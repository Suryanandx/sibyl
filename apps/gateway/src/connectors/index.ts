/**
 * Native connectors (see docs/integrations.md).
 *
 * Installed once by runtime.ts (`installConnectors`), after the secrets
 * vault: client credentials are vault secrets and connection credentials
 * are encrypted with the vault's master key. Enterprise connectors register
 * themselves later through `registerConnector()` (catalog.ts).
 */
import type { AuditEvent, Store, ToolRegistry } from "@open-gpt-live/core";
import { loadOrgKey, SecretKeyError } from "../secrets/crypto.js";
import type { SecretVault } from "../secrets/vault.js";
import { googleConnector } from "./google/index.js";
import type { FetchLike } from "./http-client.js";
import { microsoftConnector } from "./microsoft/index.js";
import { slackConnector } from "./slack/index.js";
import { ConnectorService, type EndpointOverride } from "./service.js";

export { ConnectorService, CALLBACK_PATH, ownerKeyOf, type Actor, type EndpointOverride } from "./service.js";
export { ENTERPRISE_CONNECTORS, registerConnector, listConnectors, getConnector } from "./catalog.js";
export { handleConnectorsHttp, isConnectorsPath } from "./http.js";
export { connectIntegrations, type IntegrationsSession } from "./ws.js";
export { googleConnector } from "./google/index.js";
export { microsoftConnector } from "./microsoft/index.js";
export { slackConnector, SLACK_EVENTS_PATH, SLACK_SIGNING_SECRET } from "./slack/index.js";
export type * from "./types.js";

export const BUILTIN_CONNECTORS = [googleConnector, microsoftConnector, slackConnector];

export interface InstallConnectorsInput {
  store: Store;
  ownerId: string;
  tools?: ToolRegistry;
  vault?: SecretVault;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** The runtime's audit path (connects, changes, disconnects, app setup). */
  audit?: (event: AuditEvent) => void;
  /** Master key (default: SIBYL_SECRET_KEY / data/secret.key, like the vault). */
  key?: Buffer;
  fetch?: FetchLike;
  endpoints?: Record<string, EndpointOverride>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Returns undefined (and logs why) when there is no usable master key; the gateway still runs. */
export async function installConnectors(input: InstallConnectorsInput): Promise<ConnectorService | undefined> {
  if (input.env.SIBYL_CONNECTORS?.trim().toLowerCase() === "false") {
    input.log("connectors.disabled", { reason: "SIBYL_CONNECTORS=false" });
    return undefined;
  }
  let key = input.key;
  if (!key) {
    try {
      key = loadOrgKey(input.env, input.ownerId, input.log);
    } catch (error) {
      input.log("connectors.unavailable", { error: error instanceof SecretKeyError ? error.message : "could not load the secrets key" });
      return undefined;
    }
  }
  const service = new ConnectorService({
    store: input.store,
    ownerId: input.ownerId,
    key,
    builtins: BUILTIN_CONNECTORS,
    env: input.env,
    log: input.log,
    ...(input.audit ? { audit: input.audit } : {}),
    ...(input.vault ? { vault: input.vault } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.endpoints ? { endpoints: input.endpoints } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {})
  });
  await service.init();
  input.log("connectors.installed", { connectors: service.definitions().map((def) => def.id) });
  return service;
}
