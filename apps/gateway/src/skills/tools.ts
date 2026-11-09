/**
 * `use_skill` (read): progressive disclosure. The system prompt lists only
 * each enabled skill's name and one-line description; the brain calls this
 * to load the full instructions (and bundled files) when one is relevant.
 * Needs skills.use for the principal it runs as (none: refused); an agent
 * with limited access only loads its own skills.
 */
import { authorize, DEFAULT_WORKSPACE_ID, PERMISSIONS, type SkillRecord, type ToolDefinition } from "@open-gpt-live/core";
import type { SkillsService } from "./service.js";

/** Bundled file text returned with the instructions (per call). */
const FILES_CHARS = 24_000;

export function createSkillTools(skills: SkillsService): ToolDefinition<any, any>[] {
  const useSkill: ToolDefinition<{ name: string; file?: string }, { name: string; version?: string; files: string[] }> = {
    name: "use_skill",
    title: "Use a skill",
    description:
      "Load the full instructions of one of the skills listed under \"Skills\" in your instructions, then follow them. " +
      "Call it as soon as a skill matches the user's request (before answering). Pass `file` to read one of the skill's bundled files.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name, e.g. status-update." },
        file: { type: "string", description: "Optional: a bundled file to read (from the list this tool returns)." }
      },
      required: ["name"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    provider: "skills",
    async run(input, context) {
      const workspaceId = context.workspaceId ?? DEFAULT_WORKSPACE_ID;
      if (!context.principal) return { content: "Skills can only be used on behalf of a signed-in person.", isError: true };
      if (!authorize(context.principal, PERMISSIONS.SKILLS_USE, { workspaceId })) {
        return { content: "You don't have permission to use skills in this workspace.", isError: true };
      }
      const name = typeof input?.name === "string" ? input.name.trim().toLowerCase() : "";
      if (!name) return { content: "Say which skill to use.", isError: true };
      const allowed = context.agent?.skillIds ? new Set(context.agent.skillIds) : undefined;
      const usable = (skill: SkillRecord) => !allowed || allowed.has(skill.id);
      const skill = await skills.findByName(workspaceId, name);
      if (!skill || !skill.enabled || !usable(skill)) {
        const available = (await skills.enabled(workspaceId)).filter(usable).map((item) => item.name);
        return { content: `There is no enabled skill named "${name}". Available: ${available.join(", ") || "none"}.`, isError: true };
      }
      const files = skill.files ?? [];
      if (typeof input?.file === "string" && input.file) {
        const file = files.find((item) => item.name === input.file);
        if (!file) return { content: `The skill "${skill.name}" has no file "${input.file}". Files: ${files.map((item) => item.name).join(", ") || "none"}.`, isError: true };
        return { content: `# ${skill.name}/${file.name}\n\n${file.content.slice(0, FILES_CHARS)}`, data: { name: skill.name, ...(skill.version ? { version: skill.version } : {}), files: [file.name] } };
      }
      let body = `# Skill: ${skill.title} (${skill.name}${skill.version ? ` v${skill.version}` : ""})\n\n${skill.instructions}`;
      if (skill.tools?.length) body += `\n\nTools this skill expects: ${skill.tools.join(", ")}.`;
      if (files.length) {
        body += "\n\n## Bundled files";
        let budget = FILES_CHARS;
        for (const file of files) {
          if (file.content.length <= budget) {
            body += `\n\n### ${file.name}\n\n${file.content}`;
            budget -= file.content.length;
          } else {
            body += `\n\n### ${file.name}\n(${file.content.length} characters — call use_skill with file "${file.name}" to read it.)`;
          }
        }
      }
      return { content: body, data: { name: skill.name, ...(skill.version ? { version: skill.version } : {}), files: files.map((file) => file.name) } };
    }
  };
  return [useSkill];
}
