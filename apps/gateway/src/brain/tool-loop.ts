/**
 * The deep brain's tool-calling loop.
 *
 * Each round streams one model turn. Text deltas go straight to `onText` (the
 * gateway routes them through SpeechUiSplitter, so the spoken gist and the
 * OpenUI visual work as before). When the model asks for tools, reads run in
 * parallel, writes wait for the user's approval one by one, results are fed
 * back, and the next round starts. After `maxRounds` the model must answer.
 *
 * This is the one place tools run (chat, voice deep work, routines, monitors,
 * slides), so the organization's governance is applied here: the model must
 * be allowed, blocked tools are refused, a write a policy marks waits for an
 * admin's second approval after the person's own, and write actions and
 * approvals go to the audit log.
 */
import type { ChatToolCall, ToolChatMessage, ToolChatProvider } from "@open-gpt-live/adapters";
import {
  AUDIT_ACTIONS,
  auditActor,
  needsApproval,
  toFunctionTools,
  type Governance,
  type ModelUsage,
  type Principal,
  type Store,
  type ToolDefinition,
  type ToolResult,
  type UsageMeter
} from "@open-gpt-live/core";
import type { ToolLinkView } from "@open-gpt-live/protocol";
import type { ApprovalOutcome } from "./approvals.js";
import { redactSecrets } from "../secrets/redact.js";

export const MAX_TOOL_ROUNDS = 6;
export const MAX_TOOL_CONTENT_CHARS = 12_000;

/**
 * Sent with the last round only (tools are off then). Without it the model
 * plans another search it can no longer make ("I'll look that up…") and
 * stops without the answer — or the visual — that was asked for.
 */
export const FINAL_ROUND_NOTE =
  "You can't call any more tools in this turn. Finish the answer now with what you have: include any table, chart or other visual the user asked for, and briefly say what you couldn't find. If you already answered part of it above, don't repeat that part — only add what's missing. Don't describe further lookups.";

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
  /** Who the run acts for, and in which workspace (passed into every tool's context). */
  principal?: Principal;
  workspaceId?: string;
  /** Permission check before a call runs; returns why it is refused, or undefined. */
  authorizeTool?(tool: ToolDefinition<any, any>): string | undefined;
  /** Organization policy and audit (absent: no policy, nothing recorded). */
  governance?: Governance;
  store: Store;
  meter: UsageMeter;
  log(event: string, fields?: Record<string, unknown>): void;
  onText(delta: string): void;
  onToolStarted(call: { callId: string; toolName: string; title: string }): void;
  onToolFinished(call: { callId: string; toolName: string; title: string; status: ToolCallStatus; summary?: string; link?: ToolLinkView }): void;
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
  ].join("\n") + toolGuidance(tools);
}

/**
 * Extra system-prompt guidance a tool family carries (e.g. how to build slide
 * decks), included once while any of its tools is enabled.
 */
function toolGuidance(tools: ToolDefinition<any, any>[]): string {
  const seen = new Set<string>();
  for (const tool of tools) {
    const guidance = (tool as { promptGuidance?: unknown }).promptGuidance;
    if (typeof guidance === "string" && guidance.trim()) seen.add(guidance);
  }
  return [...seen].join("");
}

/** Thrown when an organization policy does not allow the run's model. */
export class ModelNotAllowedError extends Error {
  constructor(readonly model: string, reason: string) {
    super(reason);
    this.name = "ModelNotAllowedError";
  }
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxRounds = input.maxRounds ?? MAX_TOOL_ROUNDS;
  const scope = { ...(input.principal ? { principal: input.principal } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) };
  const modelDecision = input.governance?.modelDecision(input.model, scope);
  if (modelDecision && !modelDecision.allowed) {
    input.governance!.audit({
      action: AUDIT_ACTIONS.MODEL_BLOCKED,
      outcome: "denied",
      actor: auditActor(input.principal),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      target: { kind: "model", id: input.model },
      details: { runId: input.runId }
    });
    throw new ModelNotAllowedError(input.model, modelDecision.reason ?? `The model ${input.model} is not allowed.`);
  }
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const functionTools = toFunctionTools(input.tools);
  const messages = [...input.messages];
  const steps: ToolLoopResult["steps"] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    if (input.signal.aborted) return { rounds: round - 1, steps, aborted: true };
    const finalRound = round === maxRounds;
    let text = "";
    let calls: ChatToolCall[] = [];

    // After tool rounds, the last round must answer: tell the model so (request only, never stored).
    const request = finalRound && round > 1 ? [...messages, { role: "system" as const, content: FINAL_ROUND_NOTE }] : messages;
    for await (const event of input.provider.streamWithTools(request, {
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
  const finish = (status: ToolCallStatus, content: string, summary?: string, link?: ToolLinkView): string => {
    steps.push({ callId: call.id, toolName: call.name, title, status });
    input.onToolFinished({ callId: call.id, toolName: call.name, title, status, ...(summary ? { summary } : {}), ...(link ? { link } : {}) });
    input.log("tool.finished", { runId: input.runId, callId: call.id, toolName: call.name, status });
    // Defence in depth: mask any stored secret value before the model reads it.
    return truncateContent(redactSecrets(input.ownerId, content));
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

  const refused = input.authorizeTool?.(tool);
  if (refused) {
    return finish("declined", `${tool.name} did NOT run: ${refused} Tell the user briefly and continue without it.`, "Not allowed");
  }

  const governance = input.governance;
  const scope = { ...(input.principal ? { principal: input.principal } : {}), ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) };
  const audit = (action: string, outcome: "success" | "failure" | "denied", details: Record<string, string | number | boolean | null> = {}) =>
    governance?.audit({
      action,
      outcome,
      actor: auditActor(input.principal),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      target: { kind: "tool", id: tool.name, name: tool.title },
      details: { runId: input.runId, ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...details }
    });
  // Checked again at run time: policies can change while a run is under way.
  const policy = governance?.toolDecision(tool, scope);
  if (policy && !policy.allowed) {
    audit(AUDIT_ACTIONS.TOOL_BLOCKED, "denied", { reason: policy.reason ?? null });
    return finish("declined", `${tool.name} did NOT run: ${policy.reason ?? "an organization policy blocks it."} Tell the user briefly and continue without it.`, "Blocked by policy");
  }

  if (needsApproval(tool, args)) {
    let outcome = await input.approve({ tool, input: args, callId: call.id });
    audit(AUDIT_ACTIONS.APPROVAL_DECIDED, outcome === "approved" ? "success" : "denied", { decision: outcome, stage: "first" });
    if (outcome === "approved" && policy?.secondApproval && governance) {
      // The person approved; the organization's policy also wants an admin's approval.
      outcome = await governance.secondApproval({
        tool,
        input: args,
        ...scope,
        runId: input.runId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        signal: input.signal
      });
      if (outcome !== "approved") {
        return finish(
          "declined",
          `An organization admin ${outcome === "declined" ? "declined" : "did not approve"} this action in time, so ${tool.name} did NOT run and nothing was changed. Do not retry it; tell the user briefly and continue without it.`,
          outcome === "declined" ? "Declined by an admin" : "Admin approval expired"
        );
      }
    }
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
      ...(input.principal ? { principal: input.principal } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      runId: input.runId,
      store: input.store,
      meter: input.meter,
      log: (event, fields) => input.log(event, { toolName: tool.name, callId: call.id, ...fields })
    });
    const content = result.content || (result.data === undefined ? "(no output)" : safeJson(result.data));
    if (tool.effect === "write") audit(AUDIT_ACTIONS.TOOL_WRITE, result.isError ? "failure" : "success");
    return finish(result.isError ? "error" : "ok", result.isError ? `Error: ${content}` : content, undefined, result.isError ? undefined : pageLinkOf(result.data));
  } catch (error) {
    if (tool.effect === "write") audit(AUDIT_ACTIONS.TOOL_WRITE, "failure");
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

/**
 * The public page a tool read (read_webpage returns `{ url, finalUrl, title }`),
 * so the chat can offer it as a link. Only http(s) addresses.
 */
export function pageLinkOf(data: unknown): ToolLinkView | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const raw = typeof record.finalUrl === "string" ? record.finalUrl : typeof record.url === "string" ? record.url : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const title = typeof record.title === "string" ? record.title.trim().slice(0, 200) : "";
  return { url: url.toString(), ...(title ? { title } : {}) };
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

/**
 * The loop as a plain text stream, for callers that consume
 * `AsyncIterable<{ delta }>` (the typed-chat reply path). Tool events still go
 * through the input's callbacks.
 */
export function toolLoopStream(input: Omit<ToolLoopInput, "onText">): AsyncIterable<{ delta: string }> {
  return {
    [Symbol.asyncIterator]() {
      const queue: string[] = [];
      let finished = false;
      let failure: unknown;
      let wake: (() => void) | undefined;
      const notify = (): void => {
        wake?.();
        wake = undefined;
      };
      void runToolLoop({
        ...input,
        onText: (delta) => {
          queue.push(delta);
          notify();
        }
      }).then(
        () => {
          finished = true;
          notify();
        },
        (error: unknown) => {
          failure = error;
          finished = true;
          notify();
        }
      );
      return {
        async next(): Promise<IteratorResult<{ delta: string }>> {
          while (queue.length === 0 && !finished) {
            await new Promise<void>((resolve) => (wake = resolve));
          }
          if (queue.length > 0) return { value: { delta: queue.shift()! }, done: false };
          if (failure) throw failure;
          return { value: undefined, done: true };
        }
      };
    }
  };
}
