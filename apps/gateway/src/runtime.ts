/**
 * The gateway's shared runtime: one store, one tool registry, one usage meter.
 *
 * Wiring lives here (not in server.ts) so each capability is installed in
 * exactly one place:
 * - storage:   replace createMemoryStore() with the SQLite store
 * - metering:  replace createNoopMeter() with the real UsageMeter
 * - tools:     register built-ins / MCP / slides tools in installTools()
 */
import {
  DEFAULT_OWNER_ID,
  createMemoryStore,
  createToolRegistry,
  type Store,
  type ToolRegistry,
  type UsageMeter
} from "@open-gpt-live/core";
import { createUsageMeter } from "./metering/meter.js";
import { installSibylTools, type InstalledTools } from "./tools/index.js";

export interface GatewayRuntime {
  ownerId: string;
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export async function createRuntime(options: RuntimeOptions): Promise<GatewayRuntime> {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const meter = await createUsageMeter({ store, ownerId: DEFAULT_OWNER_ID, env: options.env, log: options.log });
  const installed = await installTools({ tools, store, meter, ownerId: DEFAULT_OWNER_ID, options });
  return {
    ownerId: DEFAULT_OWNER_ID,
    store,
    tools,
    meter,
    close: async () => {
      await installed.close();
      await store.close();
    }
  };
}

async function installTools(input: {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  ownerId: string;
  options: RuntimeOptions;
}): Promise<InstalledTools> {
  // Built-in tools, MCP servers (mcp.config.json) and persisted per-tool switches.
  // Slides register here too.
  return installSibylTools({ ...input, env: input.options.env, log: input.options.log });
}

/** Meter that records nothing and never blocks (until metering is installed). */
export function createNoopMeter(): UsageMeter {
  return {
    record() {},
    totals: () => ({ todayUsd: 0, monthUsd: 0, sessionUsd: 0, byFeature: {} }),
    check: () => ({ allowed: true }),
    limits: () => ({})
  };
}

/** Runtime for tests and embedded use: memory store, empty registry, no-op meter. */
export function createTestRuntime(overrides: Partial<GatewayRuntime> = {}): GatewayRuntime {
  return {
    ownerId: DEFAULT_OWNER_ID,
    store: createMemoryStore(),
    tools: createToolRegistry(),
    meter: createNoopMeter(),
    close: async () => {},
    ...overrides
  };
}
