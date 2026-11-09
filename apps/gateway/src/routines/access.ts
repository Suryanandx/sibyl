/**
 * Who may see, change and run a routine. One set of rules for the chat
 * tools, the WebSocket handlers and the runner:
 *
 * - A routine lives in one workspace (older records: `default`) and was
 *   created by one person (older records: the org owner).
 * - Seeing it needs `routines.use` in that workspace; changing your own needs
 *   the same, changing someone else's needs `routines.manage`.
 * - Each run acts as the creator with their *current* rights; a creator who
 *   lost access (or a deleted workspace) fails the run.
 */
import { DEFAULT_WORKSPACE_ID, PERMISSIONS, authorize, type ApprovalRecord, type Principal, type RoutineRecord, type Store } from "@open-gpt-live/core";
import { actingPrincipal, creatorId } from "../agents/access.js";

/** The person (or token) acting on routines, and the workspace they act in. */
export interface RoutineCaller {
  principal: Principal;
  workspaceId: string;
}

export function routineWorkspace(routine: Pick<RoutineRecord, "workspaceId">): string {
  return routine.workspaceId ?? DEFAULT_WORKSPACE_ID;
}

/** Did this caller create the routine? (Records without a creator belong to the owner.) */
export function isRoutineCreator(principal: Principal, routine: Pick<RoutineRecord, "createdBy">): boolean {
  if (routine.createdBy === undefined) return principal.kind !== "user";
  return routine.createdBy === creatorId(principal);
}

export function canSeeRoutine(caller: RoutineCaller, routine: Pick<RoutineRecord, "workspaceId">): boolean {
  return routineWorkspace(routine) === caller.workspaceId && authorize(caller.principal, PERMISSIONS.ROUTINES_USE, { workspaceId: caller.workspaceId });
}

export function canChangeRoutine(caller: RoutineCaller, routine: Pick<RoutineRecord, "workspaceId" | "createdBy">): boolean {
  if (!canSeeRoutine(caller, routine)) return false;
  return isRoutineCreator(caller.principal, routine) || authorize(caller.principal, PERMISSIONS.ROUTINES_MANAGE, { workspaceId: caller.workspaceId });
}

export function canCreateRoutine(caller: RoutineCaller): boolean {
  return authorize(caller.principal, PERMISSIONS.ROUTINES_MANAGE, { workspaceId: caller.workspaceId });
}

/**
 * May this caller see and decide a routine run's approval? It is decided in
 * the approval's workspace (the routine's), by someone who may change the
 * routine there (its creator, or routines.manage) and run write tools there.
 */
export function canDecideRoutineApproval(principal: Principal, record: Pick<ApprovalRecord, "workspaceId">, routine: RoutineRecord): boolean {
  const workspaceId = record.workspaceId ?? routineWorkspace(routine);
  if (routineWorkspace(routine) !== workspaceId) return false;
  return authorize(principal, PERMISSIONS.TOOLS_WRITE, { workspaceId }) && canChangeRoutine({ principal, workspaceId }, routine);
}

/** The creator's current principal for a run, or why the run can't happen. */
export function routinePrincipal(store: Store, routine: RoutineRecord): Promise<Principal | string> {
  return actingPrincipal(store, routine.ownerId, {
    createdBy: routine.createdBy,
    workspaceId: routineWorkspace(routine),
    permission: PERMISSIONS.ROUTINES_USE,
    feature: "routines"
  });
}
