"use client";

/**
 * Browser client for the Sibyl Enterprise admin APIs (roles, policies,
 * second approvals, audit log). Shapes are in @open-gpt-live/protocol
 * ("Enterprise governance"); calls go through the shared gateway client.
 */
import type {
  AdminAuditListResponse,
  AdminAuditStreamView,
  AdminAuditVerifyResponse,
  AdminCustomRoleView,
  AdminPoliciesState,
  AdminPoliciesView,
  AdminRolesState,
  AdminSecondApprovalItem
} from "@open-gpt-live/protocol";
import { gatewayDownload, gatewayRequest } from "../../lib/gateway-http";

const id = (value: string) => encodeURIComponent(value);

export interface AuditFilters {
  action?: string;
  outcome?: string;
  q?: string;
  before?: number;
}

function auditQuery(filters: AuditFilters & { format?: string; limit?: number }): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const governanceApi = {
  roles: () => gatewayRequest<AdminRolesState>("/api/admin/roles"),
  saveRole: async (roleId: string | undefined, input: { name: string; description?: string; permissions: string[] }) =>
    (await gatewayRequest<{ role: AdminCustomRoleView }>(roleId ? `/api/admin/roles/${id(roleId)}` : "/api/admin/roles", { method: roleId ? "PATCH" : "POST", body: input })).role,
  deleteRole: (roleId: string) => gatewayRequest<{ ok: true }>(`/api/admin/roles/${id(roleId)}`, { method: "DELETE" }),
  assign: (input: { userId: string; scope: string; roleId: string | null }) => gatewayRequest<unknown>("/api/admin/roles/assignments", { method: "PUT", body: input }),
  setGrant: (input: { resource: { kind: "connection"; id: string; name?: string }; roles: string[]; userIds: string[] }) =>
    gatewayRequest<unknown>("/api/admin/roles/grants", { method: "PUT", body: input }),

  policies: () => gatewayRequest<AdminPoliciesState>("/api/admin/policies"),
  savePolicies: async (input: Partial<AdminPoliciesView>) => (await gatewayRequest<{ policies: AdminPoliciesView }>("/api/admin/policies", { method: "PUT", body: input })).policies,
  runRetention: async () => (await gatewayRequest<{ result: { chats: number; uploads: number; notifications: number } }>("/api/admin/policies/retention/run", { method: "POST" })).result,
  approvals: async () => (await gatewayRequest<{ items: AdminSecondApprovalItem[] }>("/api/admin/approvals")).items,
  decide: (approvalId: string, decision: "approve" | "decline") => gatewayRequest<{ status: string }>(`/api/admin/approvals/${id(approvalId)}`, { method: "POST", body: { decision } }),

  audit: (filters: AuditFilters) => gatewayRequest<AdminAuditListResponse>(`/api/admin/audit${auditQuery({ ...filters, limit: 50 })}`),
  verify: () => gatewayRequest<AdminAuditVerifyResponse>("/api/admin/audit/verify"),
  exportAudit: (format: "csv" | "jsonl", filters: AuditFilters) =>
    gatewayDownload(`/api/admin/audit/export${auditQuery({ ...filters, before: undefined, format })}`, `sibyl-audit.${format}`),
  stream: () => gatewayRequest<AdminAuditStreamView>("/api/admin/audit/stream"),
  saveStream: (input: { url?: string; enabled?: boolean; rotateSecret?: boolean }) => gatewayRequest<AdminAuditStreamView>("/api/admin/audit/stream", { method: "PUT", body: input }),
  removeStream: () => gatewayRequest<{ ok: true }>("/api/admin/audit/stream", { method: "DELETE" }),
  testStream: () => gatewayRequest<{ ok: boolean; status?: number; error?: string }>("/api/admin/audit/stream/test", { method: "POST" })
};

/** "knowledge.edit" → "Knowledge"; groups the permission catalogue by area. */
export function permissionArea(permission: string): string {
  const area = permission.split(".")[0] ?? permission;
  const names: Record<string, string> = {
    chat: "Chat",
    tools: "Chat",
    agents: "Agents",
    knowledge: "Knowledge",
    skills: "Skills & plugins",
    plugins: "Skills & plugins",
    integrations: "Integrations",
    mcp: "Connections (MCP)",
    secrets: "Secrets",
    routines: "Routines",
    monitors: "Monitors",
    slides: "Slides",
    models: "Models & usage",
    usage: "Models & usage",
    budgets: "Models & usage",
    workspace: "Workspace",
    members: "Workspace",
    org: "Organization",
    audit: "Organization"
  };
  return names[area] ?? area;
}

export function groupPermissions<T extends { id: string }>(permissions: T[]): Array<{ area: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const permission of permissions) {
    const area = permissionArea(permission.id);
    groups.set(area, [...(groups.get(area) ?? []), permission]);
  }
  return [...groups].map(([area, items]) => ({ area, items }));
}
