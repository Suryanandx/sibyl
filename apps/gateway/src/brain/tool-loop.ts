/**
 * The deep brain's tool-calling loop.
 *
 * Each round streams one model turn. Text deltas go straight to `onText` (the
 * gateway routes them through SpeechUiSplitter, so the spoken gist and the
 * OpenUI visual work as before). When the model asks for tools, reads run in
 * parallel, writes wait for the user's approval one by one, results are fed
 * back, and the next round starts. After `maxRounds` the model must answer.
 */
import type { ChatToolCall, ToolChatMessage, ToolChatProvider } from "@open-gpt-live/adapters";
import {
  toFunctionTools,
  type ModelUsage,
  type Store,
  type ToolDefinition,
  type ToolResult,
  type UsageMeter
} from "@open-gpt-live/core";
import type { ApprovalOutcome } from "./approvals.js";

export const MAX_TOOL_ROUNDS = 6;
export const MAX_TOOL_CONTENT_CHARS = 12_000;

export type ToolCallStatus = "ok" | "error" | "declined";

export interface ToolLoopInput {
  provider: ToolChatProvider;
  messages: ToolChatMessage[];
  model: string;
  extraBody?: Record<string, unknown>;
  tools: ToolDefinition<any, any>[];
  signal: AbortSignal;
  /** Deep-work request id (sent with TOOL_STARTED/FINISHED). */
  runId: string;
  ownerId: string;
  conversationId?: string;
  store: Store;
  meter: UsageMeter;
  log(event: string, fields?: Record<string, unknown>): void;
  onText(delta: string): void;
  onToolStarted(call: { callId: string; toolName: string; title: string }): void;
  onToolFinished(call: { callId: string; toolName: string; title: string; status: ToolCallStatus; summary?: string }): void;
  /** Ask the user before a "write" tool runs. */
  approve(request: { tool: ToolDefinition<any, any>; input: Record<string, unknown>; callId: string }): Promise<ApprovalOutcome>;
  maxRounds?: number;
}

export interface ToolLoopResult {
  rounds: number;
  steps: Array<{ callId: string; toolName: string; title: string; status: ToolCallStatus }>;
  aborted: boolean;
}

/** Appended to the deep brain's system prompt when tools are available. */
export function toolSystemPrompt(tools: ToolDefinition<any, any>[]): string {
  const lines = tools.map((tool) => `- ${tool.name}: ${tool.title}${tool.effect === "write" ? " (needs approval)" : ""}`);
  return [
    "",
    "",
    "## Tools",
    "You can call tools. Use them whenever the task needs fresh, real or personal data (news, prices, weather, the web, the user's files or accounts) instead of guessing or relying on memory.",
    "Call tools first, silently: do not write any of your answer until you have the results you need. Then write the answer exactly as you normally would.",
    "Tools marked \"needs approval\" change things in the world (send, create, delete, buy). They only run after the user approves a card in the chat; if the user declines, do not retry the same action — say what you would have done and continue without it.",
    "If a tool fails, try another approach or answer with what you have and say what is missing.",
    "Available tools:",
    ...lines
  ].join("\n");
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxRounds = input.maxRounds ?? MAX_TOOL_ROUNDS;
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const functionTools = toFunctionTools(input.tools);
  const messages = [...input.messages];
  const steps: ToolLoopResult["steps"] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    if (input.signal.aborted) return { rounds: round - 1, steps, aborted: true };
    const finalRound = round === maxRounds;
    let text = "";
    let calls: ChatToolCall[] = [];

    for await (const event of input.provider.streamWithTools(messages, {
      signal: input.signal,
      model: input.model,
      ...(input.extraBody ? { extraBody: input.extraBody } : {}),
      tools: functionTools,
      // Last round: no more tools, the model has to answer with what it has.
      ...(finalRound ? { toolChoice: "none" as const } : {})
    })) {
      if (input.signal.aborted) return { rounds: round, steps, aborted: true };
      if (event.type === "text") {
        text += event.delta;
        input.onText(event.delta);
      } else if (event.type === "tool_calls") {
        calls = event.calls;
      } else {
        recordUsage(input, event.usage);
      }
    }
    if (input.signal.aborted) return { rounds: round, steps, aborted: true };
    if (calls.length === 0 || finalRound) return { rounds: round, steps, aborted: false };

    messages.push({ role: "assistant", content: text || null, toolCalls: calls });
    const results = await executeCalls(input, calls, byName, steps);
    if (input.signal.aborted) return { rounds: round, steps, aborted: true };
    for (const [index, call] of calls.entries()) {
      messages.push({ role: "tool", toolCallId: call.id, content: results[index] ?? "" });
    }
    // Keep paragraphs apart when the model writes again after tool results.
    if (text && !/\n\s*$/.test(text)) input.onText("\n\n");
  }
  return { rounds: maxRounds, steps, aborted: false };
}

/** Run one round's calls: reads in parallel, writes one by one (each approved). */
async function executeCalls(
  input: ToolLoopInput,
  calls: ChatToolCall[],
  byName: Map<string, ToolDefinition<any, any>>,
  steps: ToolLoopResult["steps"]
): Promise<string[]> {
  const results: string[] = new Array(calls.length).fill("");
  const reads: Array<Promise<void>> = [];
  const writes: number[] = [];

  calls.forEach((call, index) => {
    const tool = byName.get(call.name);
    if (tool?.effect === "write") writes.push(index);
    else reads.push(runCall(input, call, tool, steps).then((content) => void (results[index] = content)));
  });
  await Promise.all(reads);
  for (const index of writes) {
    if (input.signal.aborted) break;
    const call = calls[index]!;
    results[index] = await runCall(input, call, byName.get(call.name), steps);
  }
  return results;
}

async function runCall(
  input: ToolLoopInput,
  call: ChatToolCall,
  tool: ToolDefinition<any, any> | undefined,
  steps: ToolLoopResult["steps"]
): Promise<string> {
  const title = tool?.title ?? call.name;
  const finish = (status: ToolCallStatus, content: string, summary?: string): string => {
    steps.push({ callId: call.id, toolName: call.name, title, status });
    input.onToolFinished({ callId: call.id, toolName: call.name, title, status, ...(summary ? { summary } : {}) });
    input.log("tool.finished", { runId: input.runId, callId: call.id, toolName: call.name, status });
    return truncateContent(content);
  };

  input.onToolStarted({ callId: call.id, toolName: call.name, title });
  input.log("tool.started", { runId: input.runId, callId: call.id, toolName: call.name });
  if (!tool) {
    return finish("error", `Error: there is no tool named "${call.name}". Use one of the listed tools.`, "Unknown tool");
  }

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments must be a JSON object");
    args = parsed as Record<string, unknown>;
  } catch (error) {
    return finish("error", `Error: invalid arguments for ${tool.name} (${errorMessage(error)}). Send a valid JSON object.`, "Invalid arguments");
  }

  if (tool.effect === "write") {
    const outcome = await input.approve({ tool, input: args, callId: call.id });
    if (outcome !== "approved") {
      const why = outcome === "declined" ? "The user declined this action" : "The approval request expired without an answer";
      return finish(
        "declined",
        `${why}, so ${tool.name} did NOT run and nothing was changed. Do not retry it; tell the user briefly and continue without it.`,
        outcome === "declined" ? "Declined" : "Approval expired"
      );
    }
  }

  try {
    const result: ToolResult = await tool.run(args, {
      signal: input.signal,
      ownerId: input.ownerId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      runId: input.runId,
      store: input.store,
      meter: input.meter,
      log: (event, fields) => input.log(event, { toolName: tool.name, callId: call.id, ...fields })
    });
    const content = result.content || (result.data === undefined ? "(no output)" : safeJson(result.data));
    return finish(result.isError ? "error" : "ok", result.isError ? `Error: ${content}` : content);
  } catch (error) {
    return finish("error", `Error: ${tool.name} failed: ${errorMessage(error)}`, "Failed");
  }
}

function recordUsage(input: ToolLoopInput, usage: ModelUsage): void {
  try {
    input.meter.record({
      ownerId: input.ownerId,
      feature: "brain",
      model: input.model,
      costUsd: usage.costUsd ?? 0,
      estimated: usage.costUsd === undefined,
      ...(usage.promptTokens === undefined ? {} : { promptTokens: usage.promptTokens }),
      ...(usage.completionTokens === undefined ? {} : { completionTokens: usage.completionTokens }),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      requestId: input.runId
    });
  } catch (error) {
    input.log("brain.usage_record_failed", { error: errorMessage(error) });
  }
}

export function truncateContent(content: string, max = MAX_TOOL_CONTENT_CHARS): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n…[truncated ${content.length - max} characters]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
