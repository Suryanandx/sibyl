/**
 * meeting.* WebSocket messages (see packages/protocol, "Meetings" block).
 *
 * `meeting.task` makes a task (a one-time routine) from an action item. It
 * runs the create_routine tool through the session's own approval card, the
 * same path as when the brain asks to create a routine, so the person sees
 * exactly what will be scheduled and decides; nothing is created otherwise.
 * The tool checks the person may create routines in the workspace.
 */
import type { ToolContext, ToolDefinition } from "@open-gpt-live/core";
import { MEETING_EVENTS, type MeetingsClientMessage, type ServerMessage } from "@open-gpt-live/protocol";
import type { ApprovalOutcome } from "../brain/approvals.js";
import { MeetingError, type MeetingCaller, type MeetingService } from "./service.js";

export interface MeetingsWsContext {
  meetings: MeetingService;
  caller: MeetingCaller;
  send(message: ServerMessage): void;
  /** A registered tool by name. */
  tool(name: string): ToolDefinition<any, any> | undefined;
  /** Ask the person through the session's approval card. */
  approve(tool: ToolDefinition<any, any>, input: Record<string, unknown>, runId: string): Promise<ApprovalOutcome>;
  /** What a tool call of this session runs with. */
  toolContext(runId: string): ToolContext;
}

export async function handleMeetingsMessage(message: MeetingsClientMessage, context: MeetingsWsContext): Promise<void> {
  const { meetingId, actionId } = message;
  const result = (status: "created" | "declined" | "failed", extra: { routineId?: string; message?: string } = {}) =>
    context.send({ type: MEETING_EVENTS.TASK_RESULT, meetingId, actionId, status, ...extra });
  try {
    const tool = context.tool("create_routine");
    if (!tool) return result("failed", { message: "Tasks (routines) are turned off on this Sibyl." });
    const { input } = await context.meetings.taskInput(context.caller, meetingId, actionId);
    const runId = `meeting-task-${meetingId}-${actionId}`;
    const outcome = await context.approve(tool, input, runId);
    if (outcome !== "approved") return result("declined", { message: outcome === "expired" ? "The approval expired." : "Not created." });
    const output = await tool.run(input, context.toolContext(runId));
    const routineId = (output.data as { id?: unknown } | undefined)?.id;
    if (output.isError || typeof routineId !== "string") return result("failed", { message: output.content.slice(0, 300) });
    await context.meetings.taskCreated(meetingId, actionId, routineId);
    return result("created", { routineId });
  } catch (error) {
    return result("failed", { message: error instanceof MeetingError ? error.message : "Couldn't create the task. Try again." });
  }
}
