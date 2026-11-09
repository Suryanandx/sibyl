/**
 * Tools: the one way Sibyl's brain does things in the world.
 *
 * Built-in tools, MCP servers and the slides service all register here. The
 * deep brain sees the registry as OpenAI-style function tools; anything with
 * effect "write" pauses for an approval before it runs.
 */
import type { Store } from "./store";
import type { UsageMeter } from "./usage";
import type { Principal } from "./permissions";
import type { Governance } from "./governance";
import type { AgentRecord } from "./agents";

export type ToolEffect = "read" | "write";

/** Where a tool comes from (shown in the UI, used for per-source switches). */
export type ToolSource = "builtin" | "mcp" | "slides" | (string & {});

export interface ToolDefinition<Input = Record<string, unknown>, Output = unknown> {
  /** Unique, snake_case, ≤ 64 chars (OpenAI function-name rules). */
  name: string;
  /** Short human label, e.g. "Search the web". */
  title: string;
  /** What it does and when to use it — written for the model. */
  description: string;
  /** JSON Schema (object) for the input. */
  inputSchema: Record<string, unknown>;
  /** "write" tools (send, create, delete, spend) need an approval first. */
  effect: ToolEffect;
  source: ToolSource;
  /** Optional MCP server / provider id for grouping and toggles. */
  provider?: string;
  /**
   * "high": hard to take back — send, delete, share outside the organization,
   * move money. The approval card says so, and agents always ask before these
   * whatever their autonomy.
   */
  risk?: "high";
  /**
   * Optional, "write" tools only: does this particular call need an approval?
   * Absent means always. For tools whose effect is spending money, where a
   * small amount may go ahead (create_video asks above
   * SIBYL_MEDIA_APPROVE_ABOVE_USD). High-risk tools always ask.
   */
  approvalNeeded?(input: Input): boolean;
  /**
   * Optional: is the tool usable for this caller right now (e.g. a connector
   * tool needs a connection the person may use)? Absent means always.
   * Must be synchronous and cheap — it runs every time tools are offered.
   */
  isAvailable?(context: ToolAvailabilityScope): boolean;
  run(input: Input, context: ToolContext): Promise<ToolResult<Output>>;
}

/** Who tools are offered to: the caller, the workspace and, when an agent runs, that agent. */
export interface ToolAvailabilityScope {
  principal?: Principal;
  workspaceId?: string;
  /** The agent the tools are offered to (absent: Sibyl herself). */
  agent?: Pick<AgentRecord, "id" | "computer">;
}

export interface ToolContext {
  signal: AbortSignal;
  ownerId: string;
  conversationId?: string;
  /** The brain run this call belongs to (deep-work request id or routine run id). */
  runId: string;
  /** Who the call acts for (absent: routines and other server-side runs). Check with authorize(). */
  principal?: Principal;
  /** Workspace the call runs in (absent: the default workspace). */
  workspaceId?: string;
  /**
   * Set when an agent runs the call: tools that read knowledge bases or
   * skills should stay within these ids (absent list: no extra limit).
   */
  agent?: { id: string; knowledgeBaseIds?: string[]; skillIds?: string[] };
  store: Store;
  meter: UsageMeter;
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface ToolResult<Output = unknown> {
  /** Text the model reads (keep it compact; truncate large payloads). */
  content: string;
  /** Structured data for the UI or follow-up tools. */
  data?: Output;
  /** True when the call failed; content explains why. */
  isError?: boolean;
  /** Files or decks produced (e.g. a slides deck). */
  artifacts?: ArtifactRef[];
}

export interface ArtifactRef {
  id: string;
  kind: "slides" | "file" | "media";
  title: string;
}

export interface ToolRegistry {
  register(tool: ToolDefinition<any, any>): void;
  unregister(name: string): void;
  get(name: string): ToolDefinition<any, any> | undefined;
  list(filter?: { source?: ToolSource; provider?: string; enabledOnly?: boolean }): ToolDefinition<any, any>[];
  /** Per-tool on/off switch (persisted by whoever owns the registry). */
  setEnabled(name: string, enabled: boolean): void;
  isEnabled(name: string): boolean;
}

/** Simple in-process registry. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const disabled = new Set<string>();
  return {
    register(tool) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
        throw new Error(`Invalid tool name: ${tool.name}`);
      }
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    },
    unregister(name) {
      tools.delete(name);
    },
    get(name) {
      return tools.get(name);
    },
    list(filter = {}) {
      return [...tools.values()].filter(
        (tool) =>
          (!filter.source || tool.source === filter.source) &&
          (!filter.provider || tool.provider === filter.provider) &&
          (!filter.enabledOnly || !disabled.has(tool.name))
      );
    },
    setEnabled(name, enabled) {
      if (enabled) disabled.delete(name);
      else disabled.add(name);
    },
    isEnabled(name) {
      return tools.has(name) && !disabled.has(name);
    }
  };
}

/** OpenAI-compatible function-tool spec for chat/completions `tools`. */
export function toFunctionTools(tools: ToolDefinition<any, any>[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.effect === "write"
        ? `${tool.description}\n(${tool.approvalNeeded ? "May need" : "Needs"} the user's approval before it runs.)`
        : tool.description,
      parameters: tool.inputSchema
    }
  }));
}

/** Does this call wait for an approval? Write tools do, unless approvalNeeded() says this call needn't. */
export function needsApproval(
  tool: Pick<ToolDefinition<any, any>, "name" | "effect" | "risk" | "approvalNeeded">,
  input: Record<string, unknown>
): boolean {
  if (tool.effect !== "write") return false;
  if (isHighRiskTool(tool) || !tool.approvalNeeded) return true;
  try {
    return tool.approvalNeeded(input) !== false;
  } catch {
    return true;
  }
}

/**
 * Hard-to-undo actions always ask, whatever an agent's or monitor's autonomy:
 * tools tagged `risk: "high"`, plus write actions whose names say they move
 * money, delete, or share outside the organization. One definition for the
 * whole product (agents, monitors, approval cards).
 */
export const HIGH_RISK_NAME =
  /(^|[_-])(delete|remove|destroy|erase|wipe|purge|drop|pay|payment|payout|transfer|send_money|refund|charge|purchase|buy|share|publish|invite|grant)([_-]|$)/i;

export function isHighRiskTool(tool: Pick<ToolDefinition, "name" | "effect" | "risk">): boolean {
  if (tool.risk === "high") return true;
  return tool.effect === "write" && HIGH_RISK_NAME.test(tool.name);
}

/**
 * Tools that can actually run for this caller right now (e.g. a connector
 * tool needs a connection they may use, and no organization policy blocks
 * it). Chat, routines and monitors all offer the model only these.
 */
export function usableTools<T extends Pick<ToolDefinition, "isAvailable" | "name" | "effect" | "source" | "provider" | "risk">>(
  tools: T[],
  scope: ToolAvailabilityScope & { governance?: Pick<Governance, "toolDecision"> }
): T[] {
  const { governance, ...who } = scope;
  return tools.filter((tool) => (!tool.isAvailable || tool.isAvailable(who)) && (!governance || governance.toolDecision(tool, who).allowed));
}
