/**
 * The part of the system prompt an agent adds: who it is, how it works, what
 * it remembers, which skills and knowledge it has, and how it may act.
 */
import { AGENT_MEMORY_MAX_CHARS, type AgentMemoryItem, type AgentRecord, type SkillRecord } from "@open-gpt-live/core";

/** Curated memory lines, newest first, cut at the character cap. */
export function memoryBlock(items: AgentMemoryItem[], maxChars = AGENT_MEMORY_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    if (item.kind !== "fact") continue;
    const line = `- ${item.text.replace(/\s+/g, " ").trim()}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

const AUTONOMY_TEXT: Record<AgentRecord["autonomy"], string> = {
  ask_first: "Every action that changes something (send, create, update, delete, spend) waits for the user's approval card.",
  act_then_tell:
    "You may run actions that change things without asking first; the user is told in their inbox after each one. High-risk actions (moving money, deleting, sharing outside the organization) still need approval.",
  autonomous:
    "You work on your own within your budget: actions run without asking, except high-risk ones (moving money, deleting, sharing outside the organization), which always need approval."
};

export function agentSystemBlock(input: {
  agent: AgentRecord;
  memory: AgentMemoryItem[];
  skills: SkillRecord[];
  knowledgeBases: Array<{ id: string; name: string }>;
  voice?: boolean;
}): string {
  const { agent } = input;
  const parts: string[] = [
    "",
    "",
    `## You are ${agent.name}`,
    `You are ${agent.name}, one of the user's own agents in Sibyl${agent.description ? `: ${agent.description}` : "."} ` +
      `Speak as ${agent.name} (never call yourself Sibyl), and follow your instructions below over any generic style guidance.`
  ];
  if (agent.instructions.trim()) parts.push("", "### Your instructions", agent.instructions.trim());
  if (input.voice && agent.voice?.style) parts.push("", `Your voice and personality: ${agent.voice.style}.`);
  const memory = memoryBlock(input.memory);
  if (memory) parts.push("", "### What you remember (curated; may be outdated)", memory);
  if (input.skills.length) {
    parts.push(
      "",
      "### Your skills",
      "Load a skill's full steps with agent_skill before doing that kind of task:",
      ...input.skills.map((skill) => `- ${skill.name}: ${skill.description}${skill.source === "agent" ? " (learned)" : ""}`)
    );
  }
  if (input.knowledgeBases.length) {
    parts.push("", "### Knowledge", `Search these with agent_knowledge_search: ${input.knowledgeBases.map((kb) => kb.name).join(", ")}.`);
  }
  parts.push(
    "",
    "### How you act",
    AUTONOMY_TEXT[agent.autonomy],
    "Use agent_recall to look up how you handled similar requests before."
  );
  return parts.join("\n");
}
