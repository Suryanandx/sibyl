"use client";

/**
 * Who is signed in, which workspace is open, and what they may do.
 *
 * This is the one place the web app asks those questions. Screens call
 * `useAppSession()`; nothing else reads roles or permissions directly.
 *
 * The data comes from the gateway's `/api/auth/me` (user, organization role,
 * workspaces and the permissions in each). It is loaded once per page and
 * shared by every component — no provider is required; `AppSessionProvider`
 * only overrides fields (tests, previews). Until it has loaded, or when the
 * gateway predates accounts, the app behaves as a single owner (everything
 * allowed): the gateway enforces the same rules either way.
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { AuthMeResponse } from "@open-gpt-live/protocol";
import { readWorkspaceId, writeWorkspaceId } from "../components/SignIn";
import { gatewayRequest } from "./gateway-http";

export type Role = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceSummary {
  id: string;
  name: string;
  icon?: string;
  /** The signed-in user's role in this workspace. */
  role: Role;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface AppSession {
  user: SessionUser | null;
  /** Role in the organization. */
  orgRole: Role;
  /** The organization's name (Admin → Organization); empty when not set. */
  orgName: string;
  workspaces: WorkspaceSummary[];
  currentWorkspaceId: string;
  currentWorkspace: WorkspaceSummary | undefined;
  /** Permission check, e.g. can("knowledge.edit"). The gateway enforces the same rules. */
  can(permission: string): boolean;
  /** Enterprise features enabled by the licence key, e.g. hasFeature("audit"). */
  hasFeature(feature: string): boolean;
  switchWorkspace(id: string): void;
}

const DEFAULT_WORKSPACE: WorkspaceSummary = { id: "default", name: "Personal", role: "owner" };

/* ───────────── shared state (one per page) ───────────── */

interface SessionState {
  status: "idle" | "loading" | "ready" | "error";
  me: AuthMeResponse | null;
  currentWorkspaceId: string;
}

let state: SessionState = { status: "idle", me: null, currentWorkspaceId: DEFAULT_WORKSPACE.id };
const listeners = new Set<() => void>();
let inFlight: Promise<AuthMeResponse | null> | null = null;

function setState(next: Partial<SessionState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (state.status === "idle") void refreshAppSession();
  return () => listeners.delete(listener);
}

const serverState: SessionState = { status: "idle", me: null, currentWorkspaceId: DEFAULT_WORKSPACE.id };

/** Choose the workspace to open: the stored one when still allowed, else the first. */
function pickWorkspace(me: AuthMeResponse | null, wanted: string | null): string {
  const ids = me?.workspaces.map((workspace) => workspace.id) ?? [];
  if (wanted && (ids.length === 0 || ids.includes(wanted))) return wanted;
  return ids[0] ?? DEFAULT_WORKSPACE.id;
}

/**
 * (Re)load who is signed in from the gateway. Call after sign-in, invites,
 * role changes or workspace edits. Resolves with the response (null when
 * the gateway could not be reached).
 */
export function refreshAppSession(): Promise<AuthMeResponse | null> {
  if (inFlight) return inFlight;
  if (state.status === "idle") setState({ status: "loading", currentWorkspaceId: readWorkspaceId() ?? state.currentWorkspaceId });
  inFlight = gatewayRequest<AuthMeResponse>("/api/auth/me", { workspaceId: null })
    .then((me) => {
      const currentWorkspaceId = pickWorkspace(me, readWorkspaceId() ?? state.currentWorkspaceId);
      if (me.authenticated) writeWorkspaceId(currentWorkspaceId);
      setState({ status: "ready", me, currentWorkspaceId });
      return me;
    })
    .catch(() => {
      setState({ status: "error" });
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The workspace gateway calls act in (the `x-sibyl-workspace` header). Before
 * the session has loaded it is the one the browser last opened, if any.
 */
export function currentWorkspaceId(): string | null {
  return state.status === "idle" ? readWorkspaceId() : state.currentWorkspaceId;
}

function switchWorkspace(id: string): void {
  if (id === state.currentWorkspaceId) return;
  const allowed = state.me?.workspaces.some((workspace) => workspace.id === id) ?? id === DEFAULT_WORKSPACE.id;
  if (!allowed) return;
  writeWorkspaceId(id);
  setState({ currentWorkspaceId: id });
}

function buildSession(current: SessionState): AppSession {
  const me = current.me;
  // Not loaded yet, gateway unreachable, or an older gateway: single owner.
  if (!me || !me.authenticated) {
    return {
      user: null,
      orgRole: "owner",
      orgName: "",
      workspaces: [DEFAULT_WORKSPACE],
      currentWorkspaceId: DEFAULT_WORKSPACE.id,
      currentWorkspace: DEFAULT_WORKSPACE,
      can: () => current.status !== "ready",
      hasFeature: () => false,
      switchWorkspace
    };
  }
  const workspaces: WorkspaceSummary[] = me.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    ...(workspace.icon ? { icon: workspace.icon } : {}),
    role: workspace.role
  }));
  const workspaceId = current.currentWorkspaceId;
  const granted = new Set(me.permissions[workspaceId] ?? []);
  const features = new Set(me.features ?? []);
  return {
    user: me.user,
    orgRole: me.orgRole ?? (me.principal === "user" ? "member" : "owner"),
    orgName: me.org?.name ?? "",
    workspaces: workspaces.length ? workspaces : [DEFAULT_WORKSPACE],
    currentWorkspaceId: workspaceId,
    currentWorkspace: workspaces.find((workspace) => workspace.id === workspaceId),
    can: (permission) => granted.has(permission),
    hasFeature: (feature) => features.has(feature),
    switchWorkspace
  };
}

/** The raw /api/auth/me response (null until loaded). For the identity screens. */
export function useAuthState(): { status: SessionState["status"]; me: AuthMeResponse | null } {
  const current = useSyncExternalStore(subscribe, () => state, () => serverState);
  return useMemo(() => ({ status: current.status, me: current.me }), [current.status, current.me]);
}

/* ───────────── React API ───────────── */

const AppSessionContext = createContext<Partial<AppSession> | null>(null);

export function AppSessionProvider({ value, children }: { value?: Partial<AppSession>; children: ReactNode }) {
  // Start loading as soon as the provider mounts.
  useEffect(() => {
    if (state.status === "idle") void refreshAppSession();
  }, []);
  return <AppSessionContext.Provider value={value ?? null}>{children}</AppSessionContext.Provider>;
}

export function useAppSession(): AppSession {
  const overrides = useContext(AppSessionContext);
  const current = useSyncExternalStore(subscribe, () => state, () => serverState);
  return useMemo(() => ({ ...buildSession(current), ...(overrides ?? {}) }), [current, overrides]);
}
