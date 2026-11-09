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
  const meter = createNoopMeter();
  await installTools({ tools, store, meter, options });
  return {
    ownerId: DEFAULT_OWNER_ID,
    store,
    tools,
    meter,
    close: () => store.close()
  };
}

async function installTools(_input: {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  options: RuntimeOptions;
}): Promise<void> {
  // Built-in tools, MCP servers and slides register here.
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
