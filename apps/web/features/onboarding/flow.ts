/**
 * Onboarding logic without React: step order, which steps are optional,
 * the suggested first prompts and the progress ring. Tested in flow.test.ts.
 */
import { ONBOARDING_STEPS, type OnboardingStepId } from "@open-gpt-live/protocol";

export const STEP_LABELS: Record<OnboardingStepId, string> = {
  profile: "Welcome",
  model: "Model access",
  style: "Style",
  tools: "Tools",
  agent: "First agent",
  knowledge: "Knowledge",
  team: "Team",
  start: "First conversation"
};

/** Steps people may skip (Skip button). The model step can be skipped too, with a note. */
const OPTIONAL = new Set<OnboardingStepId>(["model", "tools", "agent", "knowledge", "team"]);

export function isOptional(step: OnboardingStepId): boolean {
  return OPTIONAL.has(step);
}

export function isStep(value: string | undefined): value is OnboardingStepId {
  return (ONBOARDING_STEPS as readonly string[]).includes(value ?? "");
}

export function welcomePath(step: OnboardingStepId): string {
  return `/welcome/${step}`;
}

/** The step after `current` (undefined: it was the last). */
export function nextStep(steps: readonly OnboardingStepId[], current: OnboardingStepId): OnboardingStepId | undefined {
  const index = steps.indexOf(current);
  if (index < 0) return steps[0];
  return steps[index + 1];
}

/** The step before `current` (undefined: it was the first). */
export function previousStep(steps: readonly OnboardingStepId[], current: OnboardingStepId): OnboardingStepId | undefined {
  const index = steps.indexOf(current);
  return index > 0 ? steps[index - 1] : undefined;
}

/** Where someone opening /welcome resumes: their current step when it is still theirs, else the first not done. */
export function resumeStep(
  steps: readonly OnboardingStepId[],
  current: OnboardingStepId | undefined,
  done: readonly OnboardingStepId[]
): OnboardingStepId {
  if (current && steps.includes(current)) return current;
  return steps.find((step) => !done.includes(step)) ?? steps[steps.length - 1] ?? "start";
}

/** 1-based position and total, for "Step 3 of 8". */
export function stepPosition(steps: readonly OnboardingStepId[], step: OnboardingStepId): { index: number; total: number } {
  return { index: Math.max(0, steps.indexOf(step)) + 1, total: steps.length };
}

export interface PromptFacts {
  /** Connector ids with a working connection (google, microsoft, slack, …). */
  connected: readonly string[];
  /** Names of knowledge bases with documents. */
  knowledge: readonly string[];
  /** The agent created during onboarding (or the first one). */
  agentName?: string;
}

export interface SuggestedPrompt {
  text: string;
  /** What it uses, shown as a small label. */
  uses?: string;
}

const GENERAL: SuggestedPrompt[] = [
  { text: "Plan my week. Ask me a few questions first." },
  { text: "Explain how you can help me, with three examples" },
  { text: "Show me global smartphone market share as a chart" }
];

/** First prompts built from what the person connected; at most four, the general ones fill up. */
export function suggestedPrompts(facts: PromptFacts): SuggestedPrompt[] {
  const out: SuggestedPrompt[] = [];
  if (facts.connected.includes("google")) {
    out.push({ text: "What's on my calendar this week?", uses: "Google" });
    out.push({ text: "Summarize the important emails I got today", uses: "Gmail" });
  }
  if (facts.connected.includes("microsoft")) {
    out.push({ text: "What meetings do I have tomorrow?", uses: "Outlook" });
    if (!facts.connected.includes("google")) out.push({ text: "Summarize my unread Outlook email", uses: "Outlook" });
  }
  if (facts.connected.includes("slack")) out.push({ text: "Draft a short update for my team in Slack", uses: "Slack" });
  if (facts.knowledge.length) out.push({ text: `What's in ${facts.knowledge[0]}? Give me a short overview.`, uses: "Knowledge" });
  if (facts.agentName) out.push({ text: `Introduce ${facts.agentName} and what it can do for me`, uses: facts.agentName });
  for (const prompt of GENERAL) {
    if (out.length >= 4) break;
    out.push(prompt);
  }
  return out.slice(0, 4);
}

/** Circumference and filled length of a progress ring of radius r. */
export function ringDash(done: number, total: number, radius: number): { length: number; filled: number } {
  const length = 2 * Math.PI * radius;
  const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return { length, filled: length * fraction };
}
