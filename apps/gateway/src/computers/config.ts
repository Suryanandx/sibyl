/**
 * Agent computers: settings from the environment (docs/configuration.md,
 * "Agent computers"). Every number has a safe default; bad values fall back
 * to it rather than failing the gateway.
 */
import { resolve } from "node:path";

/** The playwright-core the gateway drives; the sandbox image must run the same version. */
export const PLAYWRIGHT_VERSION = "1.64.1";
export const DEFAULT_IMAGE = `sibyl-computer:${PLAYWRIGHT_VERSION}`;

export interface ComputersConfig {
  /** SIBYL_COMPUTERS=off turns the feature off (no tools, no sandboxes). */
  enabled: boolean;
  /** Sandbox image (build it from Dockerfile.computer). */
  image: string;
  /** Docker network for sandboxes (absent: the default bridge, port published on 127.0.0.1). */
  network?: string;
  /** How sandboxes reach the gateway's egress proxy. */
  proxyHost: string;
  /** Where the egress proxy listens. */
  proxyBind: string;
  /** Proxy port (0: any free port). */
  proxyPort: number;
  /** Defaults for agents that don't set their own limits. */
  idleMinutes: number;
  dailyMinutes: number;
  /** Hard cap on one sandbox's life; it stops and starts fresh on the next action. */
  maxSessionMinutes: number;
  /** Sandboxes running at once in one workspace. */
  maxPerWorkspace: number;
  cpus: number;
  memoryMb: number;
  pids: number;
  /** Each agent's file area. */
  filesMb: number;
  /** Cost of computer time, counted toward the agent's and the owner's budgets (0: free). */
  usdPerHour: number;
  /** Where file areas and session timelines live ($SIBYL_DATA_DIR/computers). */
  dataDir: string;
}

function number(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/**
 * `orgId`: hosted organizations other than the self-hosted "owner" get their
 * own file area (and so their own sandbox label: start-up cleanup never
 * touches another organization's sandboxes) and an egress proxy on a free port.
 */
export function computersConfig(env: NodeJS.ProcessEnv, orgId = "owner"): ComputersConfig {
  const ownArea = orgId !== "owner";
  const network = env.SIBYL_COMPUTER_NETWORK?.trim();
  return {
    enabled: !/^(off|false|0|no)$/i.test(env.SIBYL_COMPUTERS?.trim() ?? ""),
    image: env.SIBYL_COMPUTER_IMAGE?.trim() || DEFAULT_IMAGE,
    ...(network ? { network } : {}),
    proxyHost: env.SIBYL_COMPUTER_PROXY_HOST?.trim() || "host.docker.internal",
    // Docker Desktop reaches the host's loopback; on Linux the bridge gateway needs a real interface.
    proxyBind: env.SIBYL_COMPUTER_PROXY_BIND?.trim() || (process.platform === "linux" ? "0.0.0.0" : "127.0.0.1"),
    proxyPort: ownArea ? 0 : Math.round(number(env, "SIBYL_COMPUTER_PROXY_PORT", 0, 0, 65_535)),
    idleMinutes: Math.round(number(env, "SIBYL_COMPUTER_IDLE_MINUTES", 5, 1, 120)),
    dailyMinutes: Math.round(number(env, "SIBYL_COMPUTER_DAILY_MINUTES", 60, 1, 1_440)),
    maxSessionMinutes: Math.round(number(env, "SIBYL_COMPUTER_MAX_SESSION_MINUTES", 60, 1, 1_440)),
    maxPerWorkspace: Math.round(number(env, "SIBYL_COMPUTER_MAX_PER_WORKSPACE", 3, 1, 100)),
    cpus: number(env, "SIBYL_COMPUTER_CPUS", 1, 0.25, 16),
    memoryMb: Math.round(number(env, "SIBYL_COMPUTER_MEMORY_MB", 1_024, 256, 16_384)),
    pids: Math.round(number(env, "SIBYL_COMPUTER_PIDS", 256, 64, 4_096)),
    filesMb: Math.round(number(env, "SIBYL_COMPUTER_FILES_MB", 200, 1, 10_240)),
    usdPerHour: number(env, "SIBYL_COMPUTER_USD_PER_HOUR", 0, 0, 100),
    dataDir: resolve(env.SIBYL_DATA_DIR?.trim() || "./data", "computers", ...(ownArea ? [orgId] : []))
  };
}
