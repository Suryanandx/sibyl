/**
 * Agent computers (docs/agent-computers.md): each agent can have its own
 * sandboxed browser with a file area.
 *
 * - docker.ts        the Docker sandbox driver (one container per agent)
 * - egress-proxy.ts  the network policy (public internet only)
 * - session.ts       the browser in a sandbox, screencast, request guard
 * - service.ts       lifecycle, limits, metering, watchers, timeline
 * - tools.ts         the browser tools agents use
 * - ws.ts            live view and Stop over the WebSocket
 *
 * Installed by the runtime unless SIBYL_COMPUTERS=off. When Docker isn't
 * running the feature reports "unavailable" with the reason; a browser never
 * runs on the host.
 */
import type { Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import type { AgentRuntime } from "../agents/runtime.js";
import type { NotificationInput } from "../notifications/service.js";
import type { SecretVault } from "../secrets/vault.js";
import { computersConfig } from "./config.js";
import { DockerDriver, type SandboxDriver } from "./docker.js";
import { EgressProxy } from "./egress-proxy.js";
import { FileArea } from "./files.js";
import { ComputerService } from "./service.js";
import { Timeline } from "./timeline.js";
import { createComputerTools } from "./tools.js";

export { ComputerService } from "./service.js";
export { handleComputersMessage, type ComputersWsContext } from "./ws.js";
export { COMPUTER_PROVIDER, COMPUTER_TOOL_NAMES } from "./tools.js";

export interface InstallComputersInput {
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  agents: AgentRuntime;
  vault(): SecretVault | undefined;
  notify?(input: NotificationInput): void;
  /** Test seam (default: Docker). */
  driver?: SandboxDriver;
}

export async function installComputers(input: InstallComputersInput): Promise<ComputerService | undefined> {
  const config = computersConfig(input.env, input.ownerId);
  if (!config.enabled) {
    input.log("computers.disabled", {});
    return undefined;
  }
  let service: ComputerService | undefined;
  const proxy = new EgressProxy({
    bind: config.proxyBind,
    port: config.proxyPort,
    onBlocked: (username, target, reason) => service?.blocked(username, target, reason)
  });
  const files = new FileArea(config.dataDir, config.filesMb * 1024 * 1024);
  const driver = input.driver ?? new DockerDriver(config, input.env);
  service = new ComputerService({
    store: input.store,
    ownerId: input.ownerId,
    meter: input.meter,
    config,
    driver,
    proxy,
    files,
    timeline: new Timeline(config.dataDir),
    log: input.log,
    ...(input.notify ? { notify: input.notify } : {})
  });
  try {
    await proxy.start();
  } catch (error) {
    input.log("computers.proxy_failed", { error: error instanceof Error ? error.message : String(error), bind: config.proxyBind });
  }
  for (const tool of createComputerTools({ service, files, vault: input.vault })) input.tools.register(tool);
  // Agents deleted, or their computer turned off: stop their sandboxes.
  const ready = service;
  input.agents.subscribe(() => void ready.reconcile());
  ready.start();
  // Leftovers from a crash, then report availability once.
  void driver
    .cleanup()
    .then((removed) => (removed ? input.log("computers.cleanup", { removed }) : undefined))
    .catch(() => undefined)
    .then(() => ready.available(true))
    .then((availability) => input.log("computers.ready", availability.ok ? { available: true, image: config.image } : { available: false, reason: availability.reason }));
  return service;
}
