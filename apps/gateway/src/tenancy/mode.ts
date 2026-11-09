/**
 * Deployment mode and organization ids.
 *
 * - Self-hosted (default): one organization, "owner" (DEFAULT_OWNER_ID).
 * - Hosted (`SIBYL_MODE=hosted`): many organizations, created at sign-up,
 *   each with an id like `o3f9c0d2a7b14e6f8a9c1d2e3` (letter "o" + 24 hex).
 *
 * Vendor callbacks that carry no sign-in (monitor webhooks, Slack events,
 * Teams notifications) reach an organization through a path prefix:
 * `/o/<orgId>/api/...`. The self-hosted organization has no prefix, so its
 * addresses are unchanged.
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_OWNER_ID } from "@open-gpt-live/core";

export type DeploymentMode = "self-hosted" | "hosted";

/** Header the web app may send to say which organization a signed-out request is for (sign-in, two-step). */
export const ORG_HEADER = "x-sibyl-org";
export const ORG_ID = /^o[0-9a-f]{24}$/;
const PREFIX = /^\/o\/(o[0-9a-f]{24})(\/.*)$/;

export function deploymentMode(env: NodeJS.ProcessEnv): DeploymentMode {
  const raw = env.SIBYL_MODE?.trim().toLowerCase();
  if (!raw || raw === "self-hosted" || raw === "selfhosted" || raw === "self") return "self-hosted";
  if (raw === "hosted") return "hosted";
  throw new Error(`SIBYL_MODE must be "self-hosted" (default) or "hosted", not "${raw}"`);
}

export function isHosted(env: NodeJS.ProcessEnv): boolean {
  return deploymentMode(env) === "hosted";
}

export function newOrgId(): string {
  return `o${randomBytes(12).toString("hex")}`;
}

export function isOrgId(value: unknown): value is string {
  return typeof value === "string" && ORG_ID.test(value);
}

/** A gateway path as an organization's vendor callback sees it: unchanged for the self-hosted organization. */
export function tenantPath(orgId: string, path: string): string {
  return orgId === DEFAULT_OWNER_ID ? path : `/o/${orgId}${path}`;
}

/** `/o/<org>/rest` → { orgId, path: "/rest" }; undefined when the path has no organization prefix. */
export function splitTenantPath(path: string): { orgId: string; path: string } | undefined {
  const match = PREFIX.exec(path);
  return match ? { orgId: match[1]!, path: match[2]! } : undefined;
}
