import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
  authorize,
  canAccessWorkspace,
  clearPolicies,
  effectiveWorkspaceRole,
  ownerPrincipal,
  permissionsFor,
  registerPolicy,
  requirePermission,
  type Principal
} from "./permissions";

const user = (orgRole: Principal["orgRole"], workspaceRoles: Principal["workspaceRoles"] = {}): Principal => ({
  kind: "user",
  orgId: "owner",
  userId: "u1",
  ...(orgRole ? { orgRole } : {}),
  workspaceRoles
});

afterEach(() => clearPolicies());

describe("built-in roles", () => {
  it("nest: Owner ⊇ Admin ⊇ Member ⊇ Viewer", () => {
    const { owner, admin, member, viewer } = WORKSPACE_ROLE_PERMISSIONS;
    for (const p of viewer) expect(member.has(p)).toBe(true);
    for (const p of member) expect(admin.has(p)).toBe(true);
    for (const p of admin) expect(owner.has(p)).toBe(true);
    expect(member.size).toBeGreaterThan(viewer.size);
    expect(admin.size).toBeGreaterThan(member.size);
  });

  it("viewer is read-only", () => {
    const viewer = user("member", { default: "viewer" });
    expect(authorize(viewer, PERMISSIONS.CHAT_USE)).toBe(true);
    expect(authorize(viewer, PERMISSIONS.KNOWLEDGE_VIEW)).toBe(true);
    for (const p of [
      PERMISSIONS.TOOLS_WRITE,
      PERMISSIONS.MODELS_CHOOSE,
      PERMISSIONS.WORKSPACE_SETTINGS,
      PERMISSIONS.KNOWLEDGE_EDIT,
      PERMISSIONS.ROUTINES_MANAGE,
      PERMISSIONS.SECRETS_MANAGE,
      PERMISSIONS.MCP_MANAGE,
      PERMISSIONS.MEMBERS_INVITE
    ]) {
      expect(authorize(viewer, p), p).toBe(false);
    }
  });

  it("members can't manage members; admins can", () => {
    expect(authorize(user("member", { default: "member" }), PERMISSIONS.MEMBERS_MANAGE)).toBe(false);
    expect(authorize(user("member", { default: "member" }), PERMISSIONS.MEMBERS_INVITE)).toBe(false);
    expect(authorize(user("member", { default: "admin" }), PERMISSIONS.MEMBERS_MANAGE)).toBe(true);
  });

  it("org owner/admin reach every workspace; org members only their own", () => {
    expect(authorize(user("owner"), PERMISSIONS.WORKSPACE_SETTINGS, { workspaceId: "anything" })).toBe(true);
    expect(authorize(user("admin"), PERMISSIONS.MEMBERS_MANAGE, { workspaceId: "ws2" })).toBe(true);
    const member = user("member", { default: "member" });
    expect(authorize(member, PERMISSIONS.CHAT_USE, { workspaceId: "ws2" })).toBe(false);
    expect(canAccessWorkspace(member, "ws2")).toBe(false);
    expect(canAccessWorkspace(member, "default")).toBe(true);
  });

  it("uses the higher of org-derived and workspace role", () => {
    expect(effectiveWorkspaceRole(user("admin", { ws: "viewer" }), "ws")).toBe("admin");
    expect(effectiveWorkspaceRole(user("member", { ws: "owner" }), "ws")).toBe("owner");
    expect(effectiveWorkspaceRole(user("viewer"), "ws")).toBeUndefined();
  });

  it("org permissions come from the org role only", () => {
    expect(authorize(user("member", { default: "owner" }), PERMISSIONS.ORG_SETTINGS)).toBe(false);
    expect(authorize(user("admin"), PERMISSIONS.ORG_SETTINGS)).toBe(true);
    expect(authorize(user("admin"), PERMISSIONS.ORG_BILLING)).toBe(false);
    expect(authorize(user("owner"), PERMISSIONS.ORG_BILLING)).toBe(true);
  });

  it("owner token and local mode can do everything", () => {
    for (const kind of ["token", "local"] as const) {
      expect(permissionsFor(ownerPrincipal("owner", kind), "ws9")).toEqual([...ALL_PERMISSIONS]);
    }
  });

  it("denies unknown permissions and missing principals", () => {
    expect(authorize(user("owner"), "nope.nothing")).toBe(false);
    expect(authorize(undefined, PERMISSIONS.CHAT_USE)).toBe(false);
    expect(() => requirePermission(user("viewer"), PERMISSIONS.CHAT_USE)).toThrow(/permission/);
  });
});

describe("policies", () => {
  it("deny wins and allow can grant", () => {
    const member = user("member", { default: "member" });
    const off = registerPolicy(({ permission }) => (permission === PERMISSIONS.TOOLS_WRITE ? "deny" : undefined));
    registerPolicy(({ permission, principal }) => (permission === PERMISSIONS.MCP_MANAGE && principal.userId === "u1" ? "allow" : undefined));
    expect(authorize(member, PERMISSIONS.TOOLS_WRITE)).toBe(false);
    expect(authorize(member, PERMISSIONS.MCP_MANAGE)).toBe(true);
    off();
    expect(authorize(member, PERMISSIONS.TOOLS_WRITE)).toBe(true);
  });
});
