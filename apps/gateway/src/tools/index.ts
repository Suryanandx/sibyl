/**
 * Installs Sibyl's tools into the runtime's registry: built-ins (unless
 * SIBYL_BUILTIN_TOOLS=false), MCP servers from mcp.config.json, then the
 * persisted per-tool switches. Returns a close() for clean shutdown.
 */
import type { Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import { loadGatewayRuntimeConfig, OPENROUTER_DEFAULTS } from "../config.js";
import { createBuiltinTools, type BuiltinToolsOptions } from "./builtin/index.js";
import { connectMcpServers, type McpConnectionOptions } from "./mcp/client.js";
import { loadMcpConfig } from "./mcp/config.js";
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
}

export interface InstalledTools {
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

  try {
    const config = loadMcpConfig(env, input.cwd);
    if (config && config.servers.length > 0) {
      const set = await connectMcpServers(config.servers, {
        log,
        connectTimeoutMs: positiveInt(env.SIBYL_MCP_CONNECT_TIMEOUT_MS),
        callTimeoutMs: positiveInt(env.SIBYL_MCP_CALL_TIMEOUT_MS),
        ...input.mcp
      });
      closers.push(set.close);
      for (const tool of set.tools) {
        try {
          tools.register(tool);
        } catch (error) {
          log("mcp.tool_skipped", { tool: tool.name, error: (error as Error).message });
        }
      }
      log("tools.mcp_installed", { config: config.path, servers: config.servers.length, tools: set.tools.length });
    }
  } catch (error) {
    // A broken config must not stop the gateway.
    log("tools.mcp_config_failed", { error: (error as Error).message });
  }

  try {
    const disabled = await applyToolSwitches(tools, input.store, input.ownerId);
    if (disabled.length) log("tools.disabled", { tools: disabled });
  } catch (error) {
    log("tools.switches_failed", { error: (error as Error).message });
  }

  return {
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

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export { setToolEnabled, loadDisabledTools, applyToolSwitches, DISABLED_TOOLS_KEY } from "./switches.js";
