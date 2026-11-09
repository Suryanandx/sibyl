/**
 * Sibyl's secrets manager: an encrypted vault, a secure prompt the assistant
 * can open in the chat, tools that use keys without the model seeing them,
 * and the Secrets panel's WebSocket handlers. See docs/secrets.md.
 *
 * Installed once by runtime.ts (`installSecrets`). Integration points:
 * - `resolveSecretRefs(value, { host })` for MCP configs (stdio: host undefined)
 * - `redactSecrets(ownerId, text)` — the tool loop runs every tool result through it
 * - `service.connect(...)` — one secrets session per WebSocket connection
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_OWNER_ID, type Store, type ToolRegistry } from "@open-gpt-live/core";
import type { FetchLike } from "../tools/builtin/http.js";
import type { ResolveHost } from "../tools/builtin/ssrf.js";
import { loadMasterKey, SecretKeyError } from "./crypto.js";
import { createSecretTools } from "./tools.js";
import { referencedSecrets, SecretError, SecretVault } from "./vault.js";
import { SecretsHub, type SecretsSession } from "./ws.js";

export { SecretVault, SecretError, referencedSecrets, SECRET_REF, SECRETS_KV_KEY, type SecretMeta } from "./vault.js";
export { SecretsHub, isSecretsClientMessage, type SecretsSession } from "./ws.js";
export { redactSecrets } from "./redact.js";
export { hostAllowed, normalizeHostList, LOCAL_HOST } from "./hosts.js";
export { loadMasterKey } from "./crypto.js";

export interface SecretsService {
  vault: SecretVault;
  hub: SecretsHub;
  /** One per WebSocket connection; dispose it when the socket closes. */
  connect(input: Parameters<SecretsHub["connect"]>[0]): SecretsSession;
  close(): void;
}

export interface InstallSecretsInput {
  store: Store;
  tools?: ToolRegistry;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Use this key instead of SIBYL_SECRET_KEY / data/secret.key (tests). */
  key?: Buffer;
  createId?: () => string;
  now?: () => number;
  /** Test seams for api_request. */
  fetch?: FetchLike;
  resolveHost?: ResolveHost;
}

let active: SecretsService | undefined;

/**
 * Install the vault, the prompt hub and the tools. Returns undefined (and
 * logs why) when the master key is misconfigured: the gateway still runs.
 */
export async function installSecrets(input: InstallSecretsInput): Promise<SecretsService | undefined> {
  let key = input.key;
  if (!key) {
    try {
      key = loadMasterKey(input.env, input.log).key;
    } catch (error) {
      input.log("secrets.unavailable", { error: error instanceof SecretKeyError ? error.message : "could not load the secrets key" });
      return undefined;
    }
  }
  const vault = new SecretVault({
    store: input.store,
    key,
    ...(input.now ? { now: input.now } : {}),
    log: input.log
  });
  // Loaded up front so tool output is redacted from the first call.
  await vault.preload(input.ownerId).catch((error: unknown) => {
    input.log("secrets.load_failed", { error: error instanceof Error ? error.message : String(error) });
  });
  const hub = new SecretsHub({
    vault,
    createId: input.createId ?? randomUUID,
    ...(input.now ? { now: input.now } : {}),
    log: input.log
  });
  if (input.tools) {
    const tools = createSecretTools({
      vault,
      hub,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.resolveHost ? { resolveHost: input.resolveHost } : {})
    });
    for (const tool of tools) input.tools.register(tool);
    input.log("secrets.installed", { tools: tools.map((tool) => tool.name) });
  }
  const service: SecretsService = {
    vault,
    hub,
    connect: (session) => hub.connect(session),
    close: () => {
      hub.close();
      vault.close();
      if (active === service) active = undefined;
    }
  };
  active = service;
  return service;
}

type Resolvable = string | number | boolean | null | undefined | Resolvable[] | { [key: string]: Resolvable };

/**
 * Fill `${secret:NAME}` references in an MCP server config value (a string,
 * or an env/headers object or args array). `host` is the server's URL host
 * for HTTP servers, or undefined for stdio servers (the secret must allow
 * "local"). Throws SecretError when a secret is missing or not allowed.
 */
export async function resolveSecretRefs<T extends Resolvable>(
  value: T,
  context: { host: string | undefined; ownerId?: string }
): Promise<T> {
  const ownerId = context.ownerId ?? DEFAULT_OWNER_ID;
  const walk = async (item: Resolvable): Promise<Resolvable> => {
    if (typeof item === "string") {
      if (referencedSecrets(item).length === 0) return item;
      if (!active) throw new SecretError("Secrets are not available on this gateway (check SIBYL_SECRET_KEY)");
      return active.vault.resolveRefs(ownerId, item, { host: context.host });
    }
    if (Array.isArray(item)) return Promise.all(item.map(walk));
    if (item && typeof item === "object") {
      const out: { [key: string]: Resolvable } = {};
      for (const [key, inner] of Object.entries(item)) out[key] = await walk(inner);
      return out;
    }
    return item;
  };
  return (await walk(value)) as T;
}
