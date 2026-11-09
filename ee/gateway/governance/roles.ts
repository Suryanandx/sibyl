/**
 * Custom roles and per-resource grants — Sibyl Enterprise (licence feature `custom_roles`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * - A custom role is a named set of permissions from the catalogue
 *   (packages/core/src/permissions.ts). The built-in roles stay.
 * - It is assigned to a person for the whole organization or for one
 *   workspace. While assigned, it decides that person's permissions there
 *   instead of their built-in role (a workspace assignment wins over an
 *   organization one). Their built-in role still decides which workspaces
 *   they can open and their rank. Organization owners are never limited, so
 *   nobody can lock the organization out.
 * - A grant limits one resource (today: a shared connection) to the people
 *   who match it: a built-in role, a custom role, or named people.
 *
 * Everything is enforced through `authorize()`: the module registers one
 * permission policy. Data lives in one key of the store's key-value table.
 */
import { randomUUID } from "node:crypto";
import {
  ALL_PERMISSIONS,
  AUDIT_ACTIONS,
  ORG_PERMISSIONS,
  effectiveWorkspaceRole,
  isPermission,
  isRole,
  type AuditActor,
  type EnterpriseModuleContext,
  type Permission,
  type Policy,
  type Principal,
  type Role,
  type Store
} from "../../../packages/core/src/index";
import { badRequest, notFound, stringList, text } from "../http";

export const ROLES_KV_KEY = "enterprise.roles.v1";

export interface CustomRole {
  id: string;
  name: string;
  description?: string;
  permissions: Permission[];
  createdAt: number;
  updatedAt: number;
}

/** "org" or a workspace id. */
export type AssignmentScope = "org" | (string & {});

export interface RoleAssignment {
  userId: string;
  roleId: string;
  scope: AssignmentScope;
  assignedAt: number;
}

export interface ResourceGrant {
  id: string;
  resource: { kind: "connection"; id: string; name?: string };
  /** Built-in role names (owner/admin/member/viewer) and custom role ids. */
  roles: string[];
  userIds: string[];
  updatedAt: number;
}

interface RoleData {
  roles: CustomRole[];
  assignments: RoleAssignment[];
  grants: ResourceGrant[];
}

const ROLE_ID = /^role_[a-z0-9]{6,32}$/;
const ID = /^[A-Za-z0-9_:-]{1,128}$/;
export const GRANT_RESOURCE_KINDS = ["connection"] as const;

export interface RoleBookOptions {
  store: Store;
  orgId: string;
  audit: EnterpriseModuleContext["audit"];
  now?: () => number;
  createId?: () => string;
}

/** The organization's custom roles, assignments and grants (cached; every change is written through). */
export class RoleBook {
  private data: RoleData = { roles: [], assignments: [], grants: [] };
  private readonly now: () => number;
  private readonly createId: () => string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RoleBookOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => randomUUID().replace(/-/g, ""));
  }

  async load(): Promise<this> {
    const stored = await this.options.store.kv.get<RoleData>(this.options.orgId, ROLES_KV_KEY);
    if (stored) this.data = { roles: stored.roles ?? [], assignments: stored.assignments ?? [], grants: stored.grants ?? [] };
    return this;
  }

  snapshot(): RoleData {
    return structuredClone(this.data);
  }

  /* ───────────── the policy ───────────── */

  /** The permission rule registered with authorize(). Synchronous: reads the cache only. */
  readonly policy: Policy = ({ principal, permission, workspaceId, resource }) => {
    // The owner token, local mode and organization owners are never limited.
    if (principal.kind !== "user" || !principal.userId || principal.orgRole === "owner") return undefined;
    if (resource) {
      const grant = this.data.grants.find((g) => g.resource.kind === resource.kind && g.resource.id === resource.id);
      if (grant && !this.matchesGrant(principal, workspaceId, grant)) return "deny";
    }
    const orgOnly = (ORG_PERMISSIONS as readonly string[]).includes(permission);
    const role = orgOnly ? this.roleFor(principal.userId, "org") : this.roleFor(principal.userId, workspaceId) ?? this.roleFor(principal.userId, "org");
    if (!role) return undefined;
    return (role.permissions as string[]).includes(permission) ? "allow" : "deny";
  };

  private roleFor(userId: string, scope: AssignmentScope): CustomRole | undefined {
    const assignment = this.data.assignments.find((a) => a.userId === userId && a.scope === scope);
    return assignment ? this.data.roles.find((r) => r.id === assignment.roleId) : undefined;
  }

  private matchesGrant(principal: Principal, workspaceId: string, grant: ResourceGrant): boolean {
    if (principal.userId && grant.userIds.includes(principal.userId)) return true;
    const builtIn = effectiveWorkspaceRole(principal, workspaceId);
    if (builtIn && grant.roles.includes(builtIn)) return true;
    const custom = principal.userId ? this.data.assignments.filter((a) => a.userId === principal.userId && (a.scope === "org" || a.scope === workspaceId)) : [];
    return custom.some((a) => grant.roles.includes(a.roleId));
  }

  /* ───────────── roles ───────────── */

  async saveRole(actor: AuditActor, id: string | undefined, input: Record<string, unknown>): Promise<CustomRole> {
    const name = text(input.name, "Name", 60)!;
    const description = text(input.description, "Description", 300, false);
    const permissions = stringList(input.permissions, "Permissions", ALL_PERMISSIONS.length);
    const unknown = permissions.filter((p) => !isPermission(p));
    if (unknown.length) throw badRequest(`Unknown permission${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`);
    if (isRole(name.toLowerCase())) throw badRequest(`"${name}" is a built-in role name. Choose another name.`);
    const existing = id ? this.data.roles.find((r) => r.id === id) : undefined;
    if (id && !existing) throw notFound("Role not found.");
    if (this.data.roles.some((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) throw badRequest(`A role named "${name}" already exists.`);
    const at = this.now();
    const role: CustomRole = {
      id: existing?.id ?? `role_${this.createId().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16).padEnd(6, "0")}`,
      name,
      ...(description ? { description } : {}),
      permissions: ALL_PERMISSIONS.filter((p) => permissions.includes(p)),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    };
    await this.write((data) => ({ ...data, roles: existing ? data.roles.map((r) => (r.id === role.id ? role : r)) : [...data.roles, role] }));
    this.options.audit({
      action: AUDIT_ACTIONS.ROLE_CHANGED,
      actor,
      target: { kind: "role", id: role.id, name: role.name },
      details: { change: existing ? "updated" : "created", permissions: role.permissions }
    });
    return role;
  }

  async deleteRole(actor: AuditActor, id: string): Promise<void> {
    const role = this.data.roles.find((r) => r.id === id);
    if (!role) throw notFound("Role not found.");
    const assigned = this.data.assignments.filter((a) => a.roleId === id).length;
    await this.write((data) => ({
      roles: data.roles.filter((r) => r.id !== id),
      assignments: data.assignments.filter((a) => a.roleId !== id),
      grants: data.grants.map((g) => ({ ...g, roles: g.roles.filter((r) => r !== id) }))
    }));
    this.options.audit({ action: AUDIT_ACTIONS.ROLE_CHANGED, actor, target: { kind: "role", id, name: role.name }, details: { change: "deleted", unassigned: assigned } });
  }

  /* ───────────── assignments ───────────── */

  /** Assign (roleId) or clear (roleId null) a person's custom role in a scope. */
  async assign(actor: AuditActor, input: Record<string, unknown>): Promise<RoleAssignment | undefined> {
    const userId = text(input.userId, "Person", 128)!;
    const scope = text(input.scope, "Scope", 128) as AssignmentScope;
    if (!ID.test(userId) || !ID.test(scope)) throw badRequest("Invalid person or scope.");
    const roleId = input.roleId === null ? null : text(input.roleId, "Role", 64)!;
    const user = await this.options.store.identity.users.get(this.options.orgId, userId);
    if (!user || user.disabledAt !== undefined) throw notFound("That person isn't in this organization.");
    const memberships = await this.options.store.identity.memberships.listForUser(this.options.orgId, userId);
    if (memberships.some((m) => m.scope === "org" && m.role === "owner")) throw badRequest("Organization owners always keep every permission; a custom role can't be assigned to them.");
    if (scope !== "org" && !(await this.options.store.workspaces.get(this.options.orgId, scope))) throw notFound("Workspace not found.");
    const role = roleId ? this.data.roles.find((r) => r.id === roleId) : undefined;
    if (roleId && (!ROLE_ID.test(roleId) || !role)) throw notFound("Role not found.");
    const previous = this.data.assignments.find((a) => a.userId === userId && a.scope === scope);
    const next: RoleAssignment | undefined = role ? { userId, roleId: role.id, scope, assignedAt: this.now() } : undefined;
    await this.write((data) => ({
      ...data,
      assignments: [...data.assignments.filter((a) => !(a.userId === userId && a.scope === scope)), ...(next ? [next] : [])]
    }));
    this.options.audit({
      action: AUDIT_ACTIONS.ROLE_ASSIGNED,
      actor,
      ...(scope !== "org" ? { workspaceId: scope } : {}),
      target: { kind: "user", id: userId, name: user.email },
      details: { scope, from: previous?.roleId ?? null, to: next?.roleId ?? null, roleName: role?.name ?? null }
    });
    return next;
  }

  /* ───────────── grants ───────────── */

  /** Set (or with no roles and people, remove) the grant on one resource. */
  async setGrant(actor: AuditActor, input: Record<string, unknown>): Promise<ResourceGrant | undefined> {
    const resource = typeof input.resource === "object" && input.resource !== null ? (input.resource as Record<string, unknown>) : {};
    if (!(GRANT_RESOURCE_KINDS as readonly unknown[]).includes(resource.kind)) throw badRequest("Grants apply to connections.");
    const resourceId = text(resource.id, "Resource", 128)!;
    if (!ID.test(resourceId)) throw badRequest("Invalid resource id.");
    const resourceName = text(resource.name, "Resource name", 120, false);
    const roles = stringList(input.roles, "Roles", 50);
    const bad = roles.filter((r) => !isRole(r) && !this.data.roles.some((c) => c.id === r));
    if (bad.length) throw badRequest(`Unknown role${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`);
    const userIds = stringList(input.userIds, "People", 200, ID);
    const existing = this.data.grants.find((g) => g.resource.kind === resource.kind && g.resource.id === resourceId);
    const grant: ResourceGrant | undefined =
      roles.length || userIds.length
        ? {
            id: existing?.id ?? `grant_${this.createId().replace(/[^a-z0-9]/g, "").slice(0, 16)}`,
            resource: { kind: "connection", id: resourceId, ...(resourceName ? { name: resourceName } : {}) },
            roles: roles as Array<Role | string>,
            userIds,
            updatedAt: this.now()
          }
        : undefined;
    await this.write((data) => ({ ...data, grants: [...data.grants.filter((g) => g !== existing && !(g.resource.id === resourceId && g.resource.kind === resource.kind)), ...(grant ? [grant] : [])] }));
    this.options.audit({
      action: AUDIT_ACTIONS.GRANT_CHANGED,
      actor,
      target: { kind: String(resource.kind), id: resourceId, ...(resourceName ? { name: resourceName } : {}) },
      details: { change: grant ? (existing ? "updated" : "created") : "removed", roles, userIds }
    });
    return grant;
  }

  /** Serialized read-modify-write of the stored data (one writer at a time). */
  private write(change: (data: RoleData) => RoleData): Promise<void> {
    const run = this.writes.then(async () => {
      const next = change(this.data);
      await this.options.store.kv.set(this.options.orgId, ROLES_KV_KEY, next);
      this.data = next;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }
}
