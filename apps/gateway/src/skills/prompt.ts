/**
 * What the brain's system prompt gains from v0.4 workspace features, per turn:
 *
 * - "## Skills": only enabled skills' names + one-line descriptions (at most
 *   25 skills / ~2,000 characters); the body is loaded with use_skill.
 * - "## Relevant knowledge": up to 4 keyword-search snippets (~1,800
 *   characters) from the workspace's automatically searched bases.
 *
 * Both are skipped when the caller lacks the permission or the tool is off,
 * and any failure leaves the prompt unchanged. When an agent with limited
 * access answers, both stay within its skills and knowledge bases.
 */
import { authorize, DEFAULT_WORKSPACE_ID, PERMISSIONS, type Principal, type SkillRecord, type ToolContext, type ToolRegistry } from "@open-gpt-live/core";
import type { KnowledgeService } from "../knowledge/service.js";
import type { SkillsService } from "./service.js";

const MAX_LISTED = 25;
const LIST_CHARS = 2_000;
const DESCRIPTION_CHARS = 180;

export function skillsPromptBlock(skills: SkillRecord[]): string {
  if (skills.length === 0) return "";
  let block =
    "\n\n## Skills\nInstruction packs for specific tasks. When the user's request matches one, call use_skill with its name first and follow the instructions it returns:\n";
  let listed = 0;
  for (const skill of skills) {
    if (listed >= MAX_LISTED) break;
    const description = skill.description.replace(/\s+/g, " ").trim();
    const line = `- ${skill.name}: ${description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS - 1)}…` : description}\n`;
    if (block.length + line.length > LIST_CHARS) break;
    block += line;
    listed += 1;
  }
  return listed > 0 ? block : "";
}

export interface WorkspaceContextInput {
  skills?: SkillsService;
  knowledge?: KnowledgeService;
  tools?: ToolRegistry;
  principal?: Principal;
  workspaceId?: string;
  /** The user's latest message (for the knowledge search). */
  query?: string;
  /** The agent answering (its knowledge and skill limits, as its tool calls carry them). */
  agent?: ToolContext["agent"];
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export async function withWorkspaceContext(prompt: string, input: WorkspaceContextInput): Promise<string> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const allowed = (permission: string) => !input.principal || authorize(input.principal, permission, { workspaceId });
  const toolOn = (name: string) => !input.tools || input.tools.isEnabled(name);
  let extra = "";
  if (input.skills && toolOn("use_skill") && allowed(PERMISSIONS.SKILLS_USE)) {
    try {
      const skillIds = input.agent?.skillIds;
      extra += skillsPromptBlock((await input.skills.enabled(workspaceId)).filter((skill) => !skillIds || skillIds.includes(skill.id)));
    } catch (error) {
      input.log?.("skills.prompt_failed", { error: (error as Error).message });
    }
  }
  if (input.knowledge && input.query && allowed(PERMISSIONS.KNOWLEDGE_VIEW)) {
    try {
      extra += await input.knowledge.promptBlock(workspaceId, input.query.slice(0, 500), input.agent?.knowledgeBaseIds);
    } catch (error) {
      input.log?.("knowledge.prompt_failed", { error: (error as Error).message });
    }
  }
  return extra ? `${prompt}${extra}` : prompt;
}
