/**
 * The gateway's shared runtime: one store, one tool registry, one usage meter.
 *
 * Wiring lives here (not in server.ts) so each capability is installed in
 * exactly one place:
 * - storage:   SQLite store via openStore() (SIBYL_STORAGE=memory for none)
 * - metering:  createUsageMeter() over the store, budgets from SIBYL_BUDGET_*
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
import type { ConnectionsManager } from "./tools/connections.js";
import { openStore } from "@open-gpt-live/store";
import { installSlides, type SlidesService } from "./slides/index.js";
import { installMemoryAndUploadTools } from "./memory/install.js";

export interface GatewayRuntime {
  ownerId: string;
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  /** Sibyl Slides (engine client + decks), when the engine is configured. */
  slides?: SlidesService;
  /** MCP servers and tool switches managed from the app (absent in bare test runtimes). */
  connections?: ConnectionsManager;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export async function createRuntime(options: RuntimeOptions): Promise<GatewayRuntime> {
  // SQLite in $SIBYL_DATA_DIR/sibyl.db (default ./data); SIBYL_STORAGE=memory keeps nothing on disk.
  const { store, kind, file } = openStore(options.env);
  options.log("store.opened", { kind, ...(file ? { file } : {}) });
  const tools = createToolRegistry();
  const meter = await createUsageMeter({ store, ownerId: DEFAULT_OWNER_ID, env: options.env, log: options.log });
  const installed = await installTools({ tools, store, meter, ownerId: DEFAULT_OWNER_ID, options });
  return {
    ownerId: DEFAULT_OWNER_ID,
    store,
    tools,
    meter,
    ...(installed.slides ? { slides: installed.slides } : {}),
    connections: installed.connections,
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
}): Promise<InstalledTools & { slides?: SlidesService }> {
  // Slides first, so the persisted per-tool switches below apply to them too.
  const slides = await installSlides({ ...input, env: input.options.env, log: input.options.log });
  // Memory (remember/forget/recall, unless SIBYL_MEMORY=false) and read_file for uploads.
  installMemoryAndUploadTools({ tools: input.tools, store: input.store, ownerId: input.ownerId, env: input.options.env, log: input.options.log });
  // Built-in tools, MCP servers (mcp.config.json) and persisted per-tool switches.
  const installed = await installSibylTools({ ...input, env: input.options.env, log: input.options.log });
  return slides ? { ...installed, slides } : installed;
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
