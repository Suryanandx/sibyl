/**
 * Installs Sibyl's tools into the runtime's registry: built-ins (unless
 * SIBYL_BUILTIN_TOOLS=false), MCP servers from mcp.config.json, then the
 * persisted per-tool switches. MCP servers are owned by the ConnectionsManager
 * (also servers added in the app). Returns a close() for clean shutdown.
 */
import type { Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import { loadGatewayRuntimeConfig, OPENROUTER_DEFAULTS } from "../config.js";
import { createBuiltinTools, type BuiltinToolsOptions } from "./builtin/index.js";
import { ConnectionsManager, type ResolveSecrets } from "./connections.js";
import type { McpConnectionOptions } from "./mcp/client.js";
import { loadMcpConfig, type McpServerConfig } from "./mcp/config.js";
import { applyToolSwitches } from "./switches.js";

export interface InstallToolsInput {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  cwd?: string;
  /** Test seams. */
  builtin?: BuiltinToolsOptions;
  mcp?: Partial<McpConnectionOptions>;
  /** Resolves `${secret:NAME}` references in MCP env/header values at connect time. */
  resolveSecrets?: ResolveSecrets;
}

export interface InstalledTools {
  /** Runtime management of MCP servers and tool switches (Connections screen). */
  connections: ConnectionsManager;
  close(): Promise<void>;
}

export async function installSibylTools(input: InstallToolsInput): Promise<InstalledTools> {
  const { tools, env, log } = input;
  const closers: Array<() => Promise<void>> = [];

  if (!isFalse(env.SIBYL_BUILTIN_TOOLS)) {
    const builtins = createBuiltinTools({ openRouter: webSearchConfig(env, log), ...input.builtin });
    for (const tool of builtins) tools.register(tool);
    log("tools.builtin_installed", { tools: builtins.map((tool) => tool.name) });
  }

  // MCP servers: mcp.config.json plus servers added in the app (Connections).
  let fileServers: McpServerConfig[] = [];
  let configPath: string | undefined;
  let configError: string | undefined;
  try {
    const config = loadMcpConfig(env, input.cwd);
    fileServers = config?.servers ?? [];
    configPath = config?.path;
  } catch (error) {
    // A broken config must not stop the gateway.
    configError = (error as Error).message;
    log("tools.mcp_config_failed", { error: configError });
  }
  const connections = new ConnectionsManager({
    tools,
    store: input.store,
    ownerId: input.ownerId,
    env,
    log,
    fileServers,
    configPath,
    configError,
    mcp: input.mcp,
    resolveSecrets: input.resolveSecrets
  });
  try {
    await connections.start();
    const mcpTools = tools.list({ source: "mcp" }).length;
    if (mcpTools || fileServers.length) log("tools.mcp_installed", { config: configPath, tools: mcpTools });
  } catch (error) {
    log("tools.mcp_failed", { error: (error as Error).message });
  }
  closers.push(() => connections.close());

  try {
    const disabled = await applyToolSwitches(tools, input.store, input.ownerId);
    if (disabled.length) log("tools.disabled", { tools: disabled });
  } catch (error) {
    log("tools.switches_failed", { error: (error as Error).message });
  }

  return {
    connections,
    close: async () => {
      await Promise.all(closers.map((close) => close().catch(() => undefined)));
    }
  };
}

/** web_search needs OpenRouter (the web plugin); other providers don't get it. */
function webSearchConfig(env: NodeJS.ProcessEnv, log: InstallToolsInput["log"]): BuiltinToolsOptions["openRouter"] {
  try {
    const config = loadGatewayRuntimeConfig(env);
    if (config.provider !== "openrouter" || !config.llm.apiKey) {
      log("tools.web_search_unavailable", { reason: "needs OPENROUTER_API_KEY" });
      return undefined;
    }
    return {
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl,
      model: env.SIBYL_WEB_SEARCH_MODEL?.trim() || OPENROUTER_DEFAULTS.llmModel,
      extraHeaders: config.extraHeaders
    };
  } catch (error) {
    log("tools.web_search_unavailable", { reason: (error as Error).message });
    return undefined;
  }
}

function isFalse(value: string | undefined): boolean {
  return /^(false|0|no|off)$/i.test(value?.trim() ?? "");
}


export { setToolEnabled, loadDisabledTools, applyToolSwitches, DISABLED_TOOLS_KEY } from "./switches.js";
export { ConnectionsManager } from "./connections.js";
