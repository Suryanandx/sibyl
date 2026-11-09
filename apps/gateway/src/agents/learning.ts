/**
 * The learning loop: after a run with several tool steps, or when the user
 * says "that's how we do it", one cheap reflection call decides whether the
 * agent should keep a new skill, improve one, or remember a fact.
 *
 * The idea follows Hermes Agent (Nous Research, MIT licence): skills the agent
 * writes from its own experience as Markdown, a small curated memory, and
 * search over past sessions. Here it runs inside Sibyl's own brain, with the
 * same skills, approvals and budgets as everything else, and every change is
 * visible, editable and revertible.
 */
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import type { AgentMemoryItem, AgentRecord, SkillDraft, SkillRecord, UsageMeter } from "@open-gpt-live/core";

/** Explicit feedback that a way of working should stick. */
export const FEEDBACK_PATTERN =
  /\b(that'?s (exactly )?how we do (it|this|things)|that'?s the way|always do it (like )?this way|do it like this (from now on|next time)|remember (this|that) (for next time|approach)|perfect,? (keep|do) (it|that) (this|that) way|from now on,? (always|do))\b/i;

export const MIN_STEPS_FOR_REFLECTION = 3;

export interface RunSummary {
  runId: string;
  task: string;
  reply: string;
  steps: Array<{ toolName: string; title: string; status: string }>;
  feedback?: string;
}

export function shouldReflect(run: Pick<RunSummary, "steps" | "feedback">): boolean {
  return run.steps.length >= MIN_STEPS_FOR_REFLECTION || Boolean(run.feedback && FEEDBACK_PATTERN.test(run.feedback));
}

export interface ReflectionResult {
  skills: Array<{ kind: "new" | "edit"; skillId?: string; draft: SkillDraft; rationale: string }>;
  memory: Array<{ text: string; rationale: string }>;
}

const MAX_SKILL_CHARS = 6_000;

export function reflectionPrompt(input: { agent: AgentRecord; run: RunSummary; skills: SkillRecord[]; memory: AgentMemoryItem[] }): string {
  const { agent, run } = input;
  const steps = run.steps.map((step, i) => `${i + 1}. ${step.title} (${step.toolName}) → ${step.status}`).join("\n") || "(no tool steps)";
  const skills = input.skills.map((skill) => `- id ${skill.id} · ${skill.name}: ${skill.description}`).join("\n") || "(none)";
  const memory = input.memory.filter((m) => m.kind === "fact").slice(0, 20).map((m) => `- ${m.text}`).join("\n") || "(none)";
  return [
    `You are reviewing a finished task done by the agent "${agent.name}" to help it improve. Agent instructions:`,
    agent.instructions.slice(0, 2_000) || "(none)",
    "",
    `Task from the user: ${run.task.slice(0, 2_000)}`,
    run.feedback && run.feedback !== run.task ? `User feedback: ${run.feedback.slice(0, 1_000)}` : "",
    "Steps taken:",
    steps,
    `Final answer (excerpt): ${run.reply.slice(0, 2_000)}`,
    "",
    "Existing skills:",
    skills,
    "Existing memory:",
    memory,
    "",
    "Decide what, if anything, is worth keeping so the agent does this kind of task better next time:",
    "- a NEW skill: a reusable procedure (when it applies, the steps, tools to use, pitfalls), only if this task type will likely recur and no skill covers it;",
    "- an EDIT to an existing skill when this run found a better way (give the full new text);",
    "- MEMORY: short durable facts about the user or team (preferences, names, conventions), never one-off details or secrets.",
    "Most runs need nothing. Never invent facts that are not in the task, steps or feedback.",
    "",
    "Reply with JSON only, no prose:",
    '{"skills":[{"kind":"new"|"edit","skillId":"(edit only)","name":"kebab-case-slug","title":"…","description":"Use when …","instructions":"Markdown steps","rationale":"why"}],"memory":[{"text":"one sentence","rationale":"why"}]}',
    'Use {"skills":[],"memory":[]} when nothing is worth keeping.'
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Lenient parse of the model's JSON (code fences, trailing prose). */
export function parseReflection(text: string, existing: SkillRecord[]): ReflectionResult {
  const result: ReflectionResult = { skills: [], memory: [] };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return result;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return result;
  }
  if (!raw || typeof raw !== "object") return result;
  const record = raw as Record<string, unknown>;
  const skills = Array.isArray(record.skills) ? record.skills.slice(0, 2) : [];
  for (const item of skills) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const kind = s.kind === "edit" ? "edit" : "new";
    const target = kind === "edit" ? existing.find((skill) => skill.id === s.skillId || skill.name === s.name) : undefined;
    if (kind === "edit" && !target) continue;
    const instructions = str(s.instructions, MAX_SKILL_CHARS);
    const title = str(s.title, 120) || target?.title || "";
    const description = str(s.description, 500) || target?.description || "";
    const name = slug(str(s.name, 64) || target?.name || title);
    if (!instructions || !title || !description || !name) continue;
    result.skills.push({
      kind,
      ...(target ? { skillId: target.id } : {}),
      draft: { name: target?.name ?? name, title, description, instructions },
      rationale: str(s.rationale, 500) || "Learned from a recent task."
    });
  }
  const memory = Array.isArray(record.memory) ? record.memory.slice(0, 3) : [];
  for (const item of memory) {
    const m = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const text = str(m.text, 600);
    if (text) result.memory.push({ text, rationale: str(m.rationale, 500) || "Learned from a recent task." });
  }
  return result;
}

/** One cheap, metered model call (no tools). */
export async function reflect(input: {
  provider: ToolChatProvider;
  model: string;
  agent: AgentRecord;
  run: RunSummary;
  skills: SkillRecord[];
  memory: AgentMemoryItem[];
  meter: UsageMeter;
  ownerId: string;
  requestId: string;
  signal?: AbortSignal;
}): Promise<ReflectionResult> {
  let text = "";
  for await (const event of input.provider.streamWithTools(
    [
      { role: "system", content: "You review an assistant's finished task and reply with compact JSON only." },
      { role: "user", content: reflectionPrompt(input) }
    ],
    { model: input.model, ...(input.signal ? { signal: input.signal } : {}) }
  )) {
    if (event.type === "text") text += event.delta;
    else if (event.type === "usage") {
      input.meter.record({
        ownerId: input.ownerId,
        feature: "brain",
        model: input.model,
        costUsd: event.usage.costUsd ?? 0,
        estimated: event.usage.costUsd === undefined,
        ...(event.usage.promptTokens === undefined ? {} : { promptTokens: event.usage.promptTokens }),
        ...(event.usage.completionTokens === undefined ? {} : { completionTokens: event.usage.completionTokens }),
        requestId: input.requestId,
        agentId: input.agent.id
      });
    }
  }
  return parseReflection(text, input.skills);
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
