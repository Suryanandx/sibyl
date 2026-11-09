/**
 * Chat tools to manage routines: the brain turns "every weekday at 8 send me
 * a summary of …" into a cron expression and calls create_routine. Changes
 * are "write" tools, so the user approves each one; the approval sentence
 * states the schedule in plain words and the cost cap.
 */
import { DEFAULT_WORKSPACE_ID, type RoutineRecord, type Store, type ToolContext, type ToolDefinition, type ToolResult, type UsageMeter } from "@open-gpt-live/core";
import type { RoutinePatch } from "@open-gpt-live/protocol";
import { creatorId } from "../agents/access.js";
import { canChangeRoutine, canCreateRoutine, canSeeRoutine, type RoutineCaller } from "./access.js";
import { describeSchedule } from "./cron.js";
import {
  DEFAULT_ROUTINE_RUN_USD,
  RoutineInputError,
  applyRoutinePatch,
  capWords,
  createRoutineRecord,
  effectiveRunCap,
  formatUsd,
  formatWhen
} from "./records.js";

export const ROUTINE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_routine",
  "list_routines",
  "update_routine",
  "pause_routine",
  "delete_routine"
]);

export interface RoutineToolsOptions {
  store: Store;
  meter: UsageMeter;
  createId(): string;
  now?(): number;
  /** The user's browser time zone (sync: approval sentences are built synchronously). */
  timezone(): string;
  /** Routine name by id (sync cache), for approval sentences. */
  routineName(id: string): string | undefined;
  /** Routines changed (refresh lists, caches). */
  onChanged?(): void;
  /** Stop an active run of a deleted routine. */
  onDeleted?(routineId: string): void;
}

/** A tool that also describes its own approval in plain words. */
type RoutineTool = ToolDefinition<any, any> & { approvalSummary?(input: Record<string, unknown>): string | undefined };

const CRON_HELP =
  "5-field cron in the user's local time: minute hour day-of-month month day-of-week. " +
  "Examples: every weekday at 8:00 → \"0 8 * * 1-5\"; every day at 18:30 → \"30 18 * * *\"; " +
  "Mondays at 9 → \"0 9 * * 1\"; first of the month at 7 → \"0 7 1 * *\"; every 2 hours → \"0 */2 * * *\".";

const ROUTINE_REF = {
  type: "string",
  description: "The routine's id or its exact name (see list_routines)."
};

export function createRoutineTools(options: RoutineToolsOptions): RoutineTool[] {
  const now = options.now ?? Date.now;
  const envCap = (): number | undefined => options.meter.limits().perRoutineRunUsd;
  const defaultCap = (): number | undefined => (envCap() === undefined ? DEFAULT_ROUTINE_RUN_USD : undefined);
  const changed = (): void => options.onChanged?.();

  /** Who is asking; routine tools never run without a principal (fail closed). */
  const callerOf = (context: ToolContext): RoutineCaller | undefined =>
    context.principal ? { principal: context.principal, workspaceId: context.workspaceId ?? DEFAULT_WORKSPACE_ID } : undefined;
  const NO_CALLER = "Routines can only be managed by a signed-in person.";
  /** The routines this caller may see in their workspace. */
  const visible = async (context: ToolContext, caller: RoutineCaller): Promise<RoutineRecord[]> =>
    (await context.store.routines.list(context.ownerId)).filter((routine) => canSeeRoutine(caller, routine));
  /** A routine the caller may change, by id or exact name. */
  const resolve = async (context: ToolContext, ref: unknown): Promise<RoutineRecord | string> => {
    const caller = callerOf(context);
    if (!caller) return NO_CALLER;
    if (typeof ref !== "string" || !ref.trim()) return "Say which routine (its id or exact name).";
    const all = await visible(context, caller);
    const found = pick(all, ref);
    if (typeof found === "string") return found;
    return canChangeRoutine(caller, found) ? found : `Only its creator or someone who may manage routines can change "${found.name}".`;
  };
  const pick = (all: RoutineRecord[], ref: string): RoutineRecord | string => {
    const needle = ref.trim().toLowerCase();
    const byId = all.find((routine) => routine.id === ref.trim());
    if (byId) return byId;
    const byName = all.filter((routine) => routine.name.toLowerCase() === needle);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) return `Several routines are called "${ref}"; use the id from list_routines.`;
    return `No routine "${ref}". Use list_routines to see them.`;
  };
  const nameOf = (ref: unknown): string => {
    if (typeof ref !== "string") return "a routine";
    return `“${options.routineName(ref) ?? ref}”`;
  };
  const fail = (content: string): ToolResult => ({ content, isError: true });

  const create: RoutineTool = {
    name: "create_routine",
    title: "Create a routine",
    description:
      "Schedule a recurring task Sibyl runs on its own (e.g. a morning news summary). " +
      "Each run follows the instruction with the available tools and posts the result to the routine's own chat. " +
      CRON_HELP +
      " Leave timezone empty to use the user's own time zone.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. \"Morning news\"." },
        instruction: {
          type: "string",
          description: "What to do on each run, written as a complete, self-contained task."
        },
        cron: { type: "string", description: CRON_HELP },
        timezone: { type: "string", description: "IANA time zone, e.g. \"Europe/Berlin\". Optional." },
        maxRunUsd: {
          type: "number",
          description: "Optional cost cap per run in USD (e.g. 0.1). Defaults to the configured routine cap."
        },
        agentId: {
          type: "string",
          description: "Optional: run as one of the user's agents (its id). When an agent creates the routine, it runs as that agent."
        },
        once: {
          type: "boolean",
          description: "Optional: a one-time task. It runs at the next time the schedule matches, then pauses itself."
        }
      },
      required: ["name", "instruction", "cron"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "routines",
    approvalSummary(input) {
      const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : options.timezone();
      const cap = typeof input.maxRunUsd === "number" ? input.maxRunUsd : effectiveRunCap({ maxRunUsd: defaultCap() }, envCap());
      const what = typeof input.instruction === "string" ? truncate(input.instruction.trim(), 140) : "";
      const when = input.once === true ? `once, ${describeSchedule(String(input.cron ?? ""), timezone)}` : describeSchedule(String(input.cron ?? ""), timezone);
      return `Sibyl will create the ${input.once === true ? "task" : "routine"} “${String(input.name ?? "Untitled")}” to run ${when}, with ${capWords(cap)}${what ? `: ${what}` : "."}`;
    },
    async run(input, context) {
      const caller = callerOf(context);
      if (!caller) return fail(NO_CALLER);
      if (!canCreateRoutine(caller)) return fail("You don't have permission to create routines in this workspace.");
      try {
        const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : options.timezone();
        const maxRunUsd = typeof input.maxRunUsd === "number" ? input.maxRunUsd : defaultCap();
        // An agent creating a routine makes it run as itself; otherwise an explicit agent id must exist.
        const agentId = context.agent?.id ?? (typeof input.agentId === "string" && input.agentId.trim() ? input.agentId.trim() : undefined);
        if (agentId && !context.agent) {
          const agent = await context.store.agents.get(context.ownerId, agentId);
          if (!agent || agent.workspaceId !== caller.workspaceId) return fail(`Could not create the routine: there is no agent "${agentId}".`);
        }
        const record = createRoutineRecord(
          {
            name: input.name,
            instruction: input.instruction,
            cron: input.cron,
            timezone,
            ...(maxRunUsd === undefined ? {} : { maxRunUsd }),
            ...(agentId ? { agentId } : {}),
            ...(input.once === true ? { once: true } : {})
          },
          { id: options.createId(), ownerId: context.ownerId, now: now(), workspaceId: caller.workspaceId, createdBy: creatorId(caller.principal) }
        );
        await context.store.routines.upsert(record);
        changed();
        const cap = effectiveRunCap(record, envCap());
        return {
          content:
            `Created routine "${record.name}" (id ${record.id}). It runs ${describeSchedule(record.cron, record.timezone)}; ` +
            `next run ${formatWhen(record.nextRunAt, record.timezone)}. It has ${capWords(cap)}. ` +
            `Results are posted to a chat called "Routine: ${record.name}", and the user can manage it under Routines.`,
          data: { id: record.id, nextRunAt: record.nextRunAt }
        };
      } catch (error) {
        if (error instanceof RoutineInputError) return fail(`Could not create the routine: ${error.message}`);
        throw error;
      }
    }
  };

  const list: RoutineTool = {
    name: "list_routines",
    title: "List routines",
    description: "List the user's scheduled routines with their schedule, next run, last result and cost cap.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    source: "builtin",
    provider: "routines",
    async run(_input, context) {
      const caller = callerOf(context);
      if (!caller) return fail(NO_CALLER);
      const routines = await visible(context, caller);
      if (routines.length === 0) return { content: "The user has no routines yet." };
      const lines = await Promise.all(
        routines.map(async (routine) => {
          const [last] = await context.store.routines.listRuns(context.ownerId, routine.id, 1);
          const status = routine.enabled ? `next run ${formatWhen(routine.nextRunAt, routine.timezone)}` : "paused";
          const lastRun = last ? `; last run ${last.status}${last.costUsd > 0 ? ` (${formatUsd(last.costUsd)})` : ""}` : "";
          return `- ${routine.name} (id ${routine.id}): ${describeSchedule(routine.cron, routine.timezone)}, ${status}${lastRun}; ${capWords(effectiveRunCap(routine, envCap()))}. Instruction: ${truncate(routine.instruction, 200)}`;
        })
      );
      return { content: lines.join("\n"), data: routines.map((routine) => ({ id: routine.id, name: routine.name })) };
    }
  };

  const update: RoutineTool = {
    name: "update_routine",
    title: "Change a routine",
    description: `Change a routine's name, instruction, schedule, time zone or cost cap. Only pass what changes. ${CRON_HELP}`,
    inputSchema: {
      type: "object",
      properties: {
        routine: ROUTINE_REF,
        name: { type: "string" },
        instruction: { type: "string" },
        cron: { type: "string", description: CRON_HELP },
        timezone: { type: "string", description: "IANA time zone." },
        maxRunUsd: { type: "number", description: "Cost cap per run in USD." }
      },
      required: ["routine"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "routines",
    approvalSummary(input) {
      const changes: string[] = [];
      if (typeof input.name === "string") changes.push(`rename it to “${input.name}”`);
      if (typeof input.cron === "string" || typeof input.timezone === "string") {
        const cron = typeof input.cron === "string" ? input.cron : undefined;
        const tz = typeof input.timezone === "string" ? input.timezone : options.timezone();
        changes.push(cron ? `run it ${describeSchedule(cron, tz)}` : `use the time zone ${tz}`);
      }
      if (typeof input.instruction === "string") changes.push(`change its instruction to “${truncate(input.instruction, 100)}”`);
      if (typeof input.maxRunUsd === "number") changes.push(`set ${capWords(input.maxRunUsd)}`);
      return `Sibyl will change the routine ${nameOf(input.routine)}: ${changes.join("; ") || "no changes"}.`;
    },
    async run(input, context) {
      const routine = await resolve(context, input.routine);
      if (typeof routine === "string") return fail(routine);
      const patch: RoutinePatch = {};
      for (const key of ["name", "instruction", "cron", "timezone"] as const) {
        if (typeof input[key] === "string") patch[key] = input[key];
      }
      if (typeof input.maxRunUsd === "number") patch.maxRunUsd = input.maxRunUsd;
      try {
        const next = applyRoutinePatch(routine, patch, now());
        await context.store.routines.upsert(next);
        changed();
        return {
          content: `Updated "${next.name}": runs ${describeSchedule(next.cron, next.timezone)}, next run ${formatWhen(next.nextRunAt, next.timezone)}, ${capWords(effectiveRunCap(next, envCap()))}.`
        };
      } catch (error) {
        if (error instanceof RoutineInputError) return fail(`Could not update the routine: ${error.message}`);
        throw error;
      }
    }
  };

  const pause: RoutineTool = {
    name: "pause_routine",
    title: "Pause or resume a routine",
    description: "Pause a routine (it stops running until resumed) or resume a paused one.",
    inputSchema: {
      type: "object",
      properties: {
        routine: ROUTINE_REF,
        paused: { type: "boolean", description: "true to pause (default), false to resume." }
      },
      required: ["routine"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "routines",
    approvalSummary(input) {
      return input.paused === false
        ? `Sibyl will resume the routine ${nameOf(input.routine)}.`
        : `Sibyl will pause the routine ${nameOf(input.routine)}; it won't run until resumed.`;
    },
    async run(input, context) {
      const routine = await resolve(context, input.routine);
      if (typeof routine === "string") return fail(routine);
      const enabled = input.paused === false;
      const next = applyRoutinePatch(routine, { enabled }, now());
      await context.store.routines.upsert(next);
      changed();
      return {
        content: enabled
          ? `Resumed "${next.name}"; next run ${formatWhen(next.nextRunAt, next.timezone)}.`
          : `Paused "${next.name}".`
      };
    }
  };

  const remove: RoutineTool = {
    name: "delete_routine",
    title: "Delete a routine",
    description: "Delete a routine for good. Its chat with past results stays.",
    inputSchema: {
      type: "object",
      properties: { routine: ROUTINE_REF },
      required: ["routine"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "routines",
    approvalSummary(input) {
      return `Sibyl will delete the routine ${nameOf(input.routine)}; it will not run again.`;
    },
    async run(input, context) {
      const routine = await resolve(context, input.routine);
      if (typeof routine === "string") return fail(routine);
      await context.store.routines.remove(context.ownerId, routine.id);
      options.onDeleted?.(routine.id);
      changed();
      return { content: `Deleted the routine "${routine.name}".` };
    }
  };

  return [create, list, update, pause, remove];
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
