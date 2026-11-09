/**
 * Permissions (RBAC): one catalogue, four built-in roles, one check.
 *
 * Every WebSocket handler, HTTP route and tool call asks
 * `authorize(principal, permission, { workspaceId })`. The web app hides
 * what a person can't do, but the gateway decides.
 *
 * Roles exist at two levels:
 * - organization: an org Owner/Admin has that role in every workspace;
 *   org-only permissions (org.*, audit.view) come from the org role alone.
 * - workspace: a person's role in one workspace. The effective role is the
 *   higher of the org-derived role and the workspace role.
 *
 * Built-in roles nest: Owner ⊇ Admin ⊇ Member ⊇ Viewer. A Viewer is
 * read-only: they can talk to Sibyl and read what the workspace shares, but
 * can't change settings, run tools that write, or manage anything.
 *
 * `registerPolicy()` is the extension hook for later editions (custom roles,
 * per-resource grants, denies). Open-source code never imports those; they
 * register themselves here at start-up.
 */
import { DEFAULT_WORKSPACE_ID } from "./workspace";
import type { Role } from "./identity";

/* ───────────── Catalogue ───────────── */

export const PERMISSIONS = {
  // Chat
  CHAT_USE: "chat.use",
  CHAT_SHARE: "chat.share",
  CHAT_VIEW_ALL: "chat.view_all",
  /** Run tools with write effects (send, create, delete, spend) and decide their approvals. */
  TOOLS_WRITE: "tools.write",
  // Agents
  AGENTS_USE: "agents.use",
  AGENTS_CREATE: "agents.create",
  AGENTS_SHARE: "agents.share",
  // Knowledge
  KNOWLEDGE_VIEW: "knowledge.view",
  KNOWLEDGE_EDIT: "knowledge.edit",
  KNOWLEDGE_MANAGE: "knowledge.manage",
  // Skills & plugins
  SKILLS_USE: "skills.use",
  SKILLS_EDIT: "skills.edit",
  PLUGINS_INSTALL: "plugins.install",
  // Integrations
  INTEGRATIONS_USE: "integrations.use",
  INTEGRATIONS_CONNECT_PERSONAL: "integrations.connect_personal",
  INTEGRATIONS_CONNECT_SHARED: "integrations.connect_shared",
  // Connections (MCP)
  MCP_MANAGE: "mcp.manage",
  // Secrets
  SECRETS_USE: "secrets.use",
  SECRETS_MANAGE: "secrets.manage",
  // Routines
  ROUTINES_USE: "routines.use",
  ROUTINES_MANAGE: "routines.manage",
  // Monitors
  MONITORS_USE: "monitors.use",
  MONITORS_MANAGE: "monitors.manage",
  // Slides
  SLIDES_USE: "slides.use",
  SLIDES_MANAGE: "slides.manage",
  // Calls (realtime layer; recording itself is Sibyl Enterprise)
  /** Start, stop, list and download call recordings. */
  CALLS_RECORD: "calls.record",
  // Models & usage
  MODELS_CHOOSE: "models.choose",
  USAGE_VIEW: "usage.view",
  BUDGETS_MANAGE: "budgets.manage",
  // Workspace
  WORKSPACE_SETTINGS: "workspace.settings",
  MEMBERS_INVITE: "members.invite",
  MEMBERS_MANAGE: "members.manage",
  // Organization
  ORG_SETTINGS: "org.settings",
  ORG_BILLING: "org.billing",
  AUDIT_VIEW: "audit.view"
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/** Permissions that only the organization role grants (never a workspace role). */
export const ORG_PERMISSIONS: readonly Permission[] = [PERMISSIONS.ORG_SETTINGS, PERMISSIONS.ORG_BILLING, PERMISSIONS.AUDIT_VIEW];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/* ───────────── Built-in roles ───────────── */

const VIEWER: readonly Permission[] = [
  PERMISSIONS.CHAT_USE,
  PERMISSIONS.AGENTS_USE,
  PERMISSIONS.KNOWLEDGE_VIEW,
  PERMISSIONS.SKILLS_USE,
  PERMISSIONS.ROUTINES_USE,
  PERMISSIONS.MONITORS_USE,
  PERMISSIONS.SLIDES_USE
];

const MEMBER: readonly Permission[] = [
  ...VIEWER,
  PERMISSIONS.CHAT_SHARE,
  PERMISSIONS.TOOLS_WRITE,
  PERMISSIONS.AGENTS_CREATE,
  PERMISSIONS.KNOWLEDGE_EDIT,
  PERMISSIONS.SKILLS_EDIT,
  PERMISSIONS.INTEGRATIONS_USE,
  PERMISSIONS.INTEGRATIONS_CONNECT_PERSONAL,
  PERMISSIONS.SECRETS_USE,
  PERMISSIONS.ROUTINES_MANAGE,
  PERMISSIONS.MONITORS_MANAGE,
  PERMISSIONS.SLIDES_MANAGE,
  PERMISSIONS.MODELS_CHOOSE,
  PERMISSIONS.USAGE_VIEW
];

const ADMIN: readonly Permission[] = [
  ...MEMBER,
  PERMISSIONS.CHAT_VIEW_ALL,
  PERMISSIONS.AGENTS_SHARE,
  PERMISSIONS.KNOWLEDGE_MANAGE,
  PERMISSIONS.PLUGINS_INSTALL,
  PERMISSIONS.INTEGRATIONS_CONNECT_SHARED,
  PERMISSIONS.MCP_MANAGE,
  PERMISSIONS.SECRETS_MANAGE,
  PERMISSIONS.BUDGETS_MANAGE,
  PERMISSIONS.WORKSPACE_SETTINGS,
  PERMISSIONS.MEMBERS_INVITE,
  PERMISSIONS.MEMBERS_MANAGE,
  PERMISSIONS.CALLS_RECORD
];

/** Workspace-level permissions of each built-in role. */
export const WORKSPACE_ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  viewer: new Set(VIEWER),
  member: new Set(MEMBER),
  admin: new Set(ADMIN),
  owner: new Set(ADMIN)
};

/** Organization-only permissions of each built-in org role. */
export const ORG_ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  viewer: new Set(),
  member: new Set(),
  admin: new Set([PERMISSIONS.ORG_SETTINGS]),
  owner: new Set([PERMISSIONS.ORG_SETTINGS, PERMISSIONS.ORG_BILLING, PERMISSIONS.AUDIT_VIEW])
};

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleRank(role: Role): number {
  return RANK[role];
}

/** The higher of two roles (undefined counts as no role). */
export function higherRole(a: Role | undefined, b: Role | undefined): Role | undefined {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/* ───────────── Principal ───────────── */

/**
 * Who is acting.
 * - "user":  a signed-in person (session cookie).
 * - "token": the SIBYL_OWNER_TOKEN API principal (owner of the organization).
 * - "local": single-owner local mode (no users yet, no owner token) — owner.
 */
export interface Principal {
  kind: "user" | "token" | "local";
  /** Organization (store ownerId). */
  orgId: string;
  userId?: string;
  email?: string;
  name?: string;
  /** Role in the organization (absent: no org role). */
  orgRole?: Role;
  /** Explicit workspace roles by workspace id. */
  workspaceRoles: Readonly<Record<string, Role>>;
}

/** Owner-level principal for the API token or local mode. */
export function ownerPrincipal(orgId: string, kind: "token" | "local"): Principal {
  return { kind, orgId, orgRole: "owner", workspaceRoles: {} };
}

/**
 * The role a principal has in a workspace: org Owner/Admin carry into every
 * workspace; org Member/Viewer only reach workspaces they are members of.
 */
export function effectiveWorkspaceRole(principal: Principal, workspaceId: string): Role | undefined {
  const fromOrg = principal.orgRole === "owner" || principal.orgRole === "admin" ? principal.orgRole : undefined;
  return higherRole(fromOrg, principal.workspaceRoles[workspaceId]);
}

/** Every permission the principal has in a workspace (for the web app's `can()`). */
export function permissionsFor(principal: Principal, workspaceId: string = DEFAULT_WORKSPACE_ID): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => authorize(principal, permission, { workspaceId }));
}

/* ───────────── Policies (extension hook) ───────────── */

export interface PolicyContext {
  principal: Principal;
  permission: Permission | string;
  workspaceId: string;
  /** What the built-in roles decided. */
  builtIn: boolean;
  /** Optional resource (e.g. { kind: "connection", id }) for per-resource grants. */
  resource?: { kind: string; id: string };
}

/** "deny" always wins; "allow" grants; undefined leaves the decision to others. */
export type PolicyDecision = "allow" | "deny" | undefined;
export type Policy = (context: PolicyContext) => PolicyDecision;

const policies = new Set<Policy>();

/** Add a policy (custom roles, per-resource grants, denies). Returns an unregister function. */
export function registerPolicy(policy: Policy): () => void {
  policies.add(policy);
  return () => {
    policies.delete(policy);
  };
}

/** Test helper: drop every registered policy. */
export function clearPolicies(): void {
  policies.clear();
}

/* ───────────── The check ───────────── */

export interface AuthorizeOptions {
  /** Workspace the action is in (default: "default"). Ignored for org permissions. */
  workspaceId?: string;
  resource?: { kind: string; id: string };
}

/** True when the principal may do `permission` (in the workspace). Pure apart from registered policies. */
export function authorize(principal: Principal | undefined, permission: Permission | string, options: AuthorizeOptions = {}): boolean {
  if (!principal) return false;
  const workspaceId = options.workspaceId || DEFAULT_WORKSPACE_ID;
  const builtIn = builtInDecision(principal, permission, workspaceId);
  if (policies.size === 0) return builtIn;
  let allowed = builtIn;
  for (const policy of policies) {
    const decision = policy({ principal, permission, workspaceId, builtIn, ...(options.resource ? { resource: options.resource } : {}) });
    if (decision === "deny") return false;
    if (decision === "allow") allowed = true;
  }
  return allowed;
}

function builtInDecision(principal: Principal, permission: string, workspaceId: string): boolean {
  if (!isPermission(permission)) return false;
  if ((ORG_PERMISSIONS as readonly string[]).includes(permission)) {
    return principal.orgRole ? ORG_ROLE_PERMISSIONS[principal.orgRole].has(permission) : false;
  }
  const role = effectiveWorkspaceRole(principal, workspaceId);
  return role ? WORKSPACE_ROLE_PERMISSIONS[role].has(permission) : false;
}

/** May the principal open this workspace at all (any role in it)? */
export function canAccessWorkspace(principal: Principal | undefined, workspaceId: string): boolean {
  return Boolean(principal && effectiveWorkspaceRole(principal, workspaceId));
}

/** Thrown by `requirePermission` (HTTP 403 / WS error). */
export class PermissionDeniedError extends Error {
  constructor(readonly permission: string, readonly workspaceId?: string) {
    super(`You don't have permission to do that (${permission}).`);
    this.name = "PermissionDeniedError";
  }
}

export function requirePermission(principal: Principal | undefined, permission: Permission, options: AuthorizeOptions = {}): void {
  if (!authorize(principal, permission, options)) throw new PermissionDeniedError(permission, options.workspaceId);
}
