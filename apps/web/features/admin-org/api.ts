/**
 * Calls behind Admin → Organization and Admin → Users, and the workspace
 * routes Settings → Workspace uses too (one client for both).
 * See docs/admin.md.
 */
import type { IdentityRole, OrgDefaultRole, OrgInviteView, OrgUserView, OrgUsersResponse, OrgView, WorkspaceView } from "@open-gpt-live/protocol";
import { gatewayRequest } from "../../lib/gateway-http";

const id = (value: string) => encodeURIComponent(value);

/** A budget change: an amount in USD, or null for no cap. */
export type BudgetPatch = { dailyUsd?: number | null; monthlyUsd?: number | null };

export const orgApi = {
  get: () => gatewayRequest<OrgView>("/api/admin/org", { workspaceId: null }),
  save: (patch: { name?: string; defaultWorkspaceId?: string | null; defaultRole?: OrgDefaultRole; budget?: BudgetPatch }) =>
    gatewayRequest<OrgView>("/api/admin/org", { method: "PATCH", body: patch, workspaceId: null })
};

export const usersApi = {
  list: () => gatewayRequest<OrgUsersResponse>("/api/admin/users", { workspaceId: null }),
  update: (userId: string, patch: { orgRole?: IdentityRole; active?: boolean }) =>
    gatewayRequest<{ user: OrgUserView }>(`/api/admin/users/${id(userId)}`, { method: "PATCH", body: patch, workspaceId: null }),
  remove: (userId: string) => gatewayRequest<{ ok: true }>(`/api/admin/users/${id(userId)}`, { method: "DELETE", workspaceId: null }),
  resendInvite: (inviteId: string) =>
    gatewayRequest<{ invite: OrgInviteView; url: string; emailed: boolean }>(`/api/admin/invites/${id(inviteId)}/resend`, { method: "POST", workspaceId: null }),
  revokeInvite: (inviteId: string) => gatewayRequest<{ ok: true }>(`/api/admin/invites/${id(inviteId)}`, { method: "DELETE", workspaceId: null })
};

/** The identity service's workspace routes (create needs org.settings; rename workspace.settings; delete the workspace owner). */
export const workspacesApi = {
  create: (name: string) => gatewayRequest<{ workspace: WorkspaceView }>("/api/workspaces", { method: "POST", body: { name } }),
  update: (workspaceId: string, patch: { name?: string; icon?: string; instructions?: string; budget?: BudgetPatch }) =>
    gatewayRequest<{ workspace: WorkspaceView }>(`/api/workspaces/${id(workspaceId)}`, { method: "PATCH", body: patch, workspaceId }),
  remove: (workspaceId: string) => gatewayRequest<{ ok: true }>(`/api/workspaces/${id(workspaceId)}`, { method: "DELETE", workspaceId })
};
