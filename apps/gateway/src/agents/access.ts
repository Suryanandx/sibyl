/**
 * Agent access: which tools an agent may use, and how its write actions run.
 *
 * Access never exceeds the creator: "inherit" is exactly what the creator's
 * principal may use (checked with authorize() each run, so it shrinks when
 * the creator loses rights), "controlled" is the intersection of that with
 * the agent's allowlists. The person talking to the agent is checked too:
 * an agent shared with a viewer can't run writes on their behalf.
 */
import {
  DEFAULT_OWNER_ID,
  DEFAULT_WORKSPACE_ID,
  PERMISSIONS,
  authorize,
  ownerPrincipal,
  type AgentRecord,
  type Permission,
  type Principal,
  type Role,
  type Store,
  type ToolDefinition
} from "@open-gpt-live/core";

/**
 * High-risk actions always ask, whatever the agent's autonomy: tools tagged
 * `risk: "high"`, plus this fixed list of write actions by name (moving
 * money, deleting, sharing outside the organization).
 */
export { HIGH_RISK_NAME, isHighRiskTool as isHighRisk } from "@open-gpt-live/core";

/** Extra permissions a tool needs beyond chat.use (writes need tools.write). */
export function toolPermissions(tool: Pick<ToolDefinition, "effect" | "provider" | "source">): Permission[] {
  const needs: Permission[] = [PERMISSIONS.CHAT_USE];
  if (tool.effect === "write") needs.push(PERMISSIONS.TOOLS_WRITE);
  if (tool.provider === "secrets") needs.push(PERMISSIONS.SECRETS_USE);
  if (tool.provider === "routines" && tool.effect === "write") needs.push(PERMISSIONS.ROUTINES_MANAGE);
  // Native connectors (Google, Microsoft, …) are integrations; MCP tools stay as open as in plain chat.
  if (tool.source === "connector") needs.push(PERMISSIONS.INTEGRATIONS_USE);
  return needs;
}

/** May this principal use the tool in the workspace? */
export function principalMayUse(principal: Principal | undefined, tool: ToolDefinition<any, any>, workspaceId: string): boolean {
  return toolPermissions(tool).every((permission) => authorize(principal, permission, { workspaceId }));
}

/** Does the agent's own access setting allow the tool (ignoring permissions)? */
export function accessAllows(agent: Pick<AgentRecord, "access">, tool: Pick<ToolDefinition, "name" | "provider">): boolean {
  if (agent.access.mode === "inherit") return true;
  const { tools, connectors } = agent.access;
  return tools.includes(tool.name) || (tool.provider !== undefined && connectors.includes(tool.provider));
}

/** Secret names referenced in a tool input as ${secret:NAME}. */
export function secretRefs(input: unknown): string[] {
  const text = typeof input === "string" ? input : safeJson(input);
  return [...text.matchAll(/\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g)].map((match) => match[1]!);
}

/** Why a call is refused (controlled access to secrets), or undefined. */
export function secretRefusal(agent: Pick<AgentRecord, "access" | "name">, input: unknown): string | undefined {
  if (agent.access.mode === "inherit") return undefined;
  const allowed = new Set(agent.access.secrets);
  const blocked = secretRefs(input).filter((name) => !allowed.has(name));
  return blocked.length ? `${agent.name} may not use the secret${blocked.length > 1 ? "s" : ""} ${blocked.join(", ")}.` : undefined;
}

/** Was this record made by the org owner (single-owner mode, owner token, or older records without a creator)? */
export function createdByOwner(createdBy: string | undefined): boolean {
  return !createdBy || createdBy === "local" || createdBy === "token" || createdBy === DEFAULT_OWNER_ID;
}

/**
 * The creator as a principal, rebuilt from their current memberships.
 * Agents made in single-owner mode (createdBy "local"/"token"/"owner") act as
 * the org owner. A disabled or deleted creator yields undefined: the agent
 * can use nothing.
 */
export async function creatorPrincipal(store: Store, orgId: string, createdBy: string): Promise<Principal | undefined> {
  if (createdByOwner(createdBy)) {
    // Single-owner installs have no user records; once accounts exist the owner token is still org owner.
    return ownerPrincipal(orgId, createdBy === "token" ? "token" : "local");
  }
  const user = await store.identity.users.get(orgId, createdBy);
  if (!user || user.disabledAt !== undefined) return undefined;
  const memberships = await store.identity.memberships.listForUser(orgId, user.id);
  const workspaceRoles: Record<string, Role> = {};
  let orgRole: Role | undefined;
  for (const membership of memberships) {
    if (membership.scope === "org") orgRole = membership.role;
    else workspaceRoles[membership.scope.workspaceId] = membership.role;
  }
  return { kind: "user", orgId, userId: user.id, email: user.email, name: user.name, ...(orgRole ? { orgRole } : {}), workspaceRoles };
}

/**
 * Who a background run (routine, monitor) acts as: its creator's *current*
 * principal, in a workspace that still exists, holding `permission` there.
 * Otherwise returns why not: the run must fail rather than act with rights
 * its creator no longer has. A missing `createdBy` (older records) is the org owner.
 */
export async function actingPrincipal(
  store: Store,
  orgId: string,
  input: { createdBy: string | undefined; workspaceId: string; permission: Permission; feature: string }
): Promise<Principal | string> {
  const { workspaceId } = input;
  if (workspaceId !== DEFAULT_WORKSPACE_ID && !(await store.workspaces.get(orgId, workspaceId))) return "Its workspace no longer exists.";
  const principal = await creatorPrincipal(store, orgId, input.createdBy ?? DEFAULT_OWNER_ID);
  if (!principal) return "The person who created it no longer has an account here.";
  if (!authorize(principal, input.permission, { workspaceId })) return `Its creator no longer has access to ${input.feature} in this workspace.`;
  return principal;
}

/** The id stored as `createdBy` for a principal. */
export function creatorId(principal: Principal): string {
  return principal.userId ?? principal.kind;
}

/**
 * Tools an agent may use in this run: allowed by its access setting, usable
 * by its creator and (when a person is talking to it) by that person too.
 */
export function agentTools(input: {
  agent: AgentRecord;
  tools: ToolDefinition<any, any>[];
  creator: Principal | undefined;
  caller?: Principal;
  workspaceId: string;
}): ToolDefinition<any, any>[] {
  const { agent, creator, caller, workspaceId } = input;
  if (!creator) return [];
  return input.tools.filter(
    (tool) =>
      accessAllows(agent, tool) &&
      principalMayUse(creator, tool, workspaceId) &&
      (!caller || principalMayUse(caller, tool, workspaceId))
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
