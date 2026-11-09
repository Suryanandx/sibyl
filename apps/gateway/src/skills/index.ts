/**
 * Skills (see docs/skills-and-plugins.md). Installed once by runtime.ts.
 */
import type { Store, ToolRegistry } from "@open-gpt-live/core";
import { SkillsService } from "./service.js";
import { createSkillTools } from "./tools.js";

export { SkillsService, SkillError, skillView, bumpPatch } from "./service.js";
export { BUILTIN_SKILLS } from "./builtins.js";
export { parseSkillMd, serializeSkillMd, parseFrontMatter, SkillFormatError, slugify } from "./skill-md.js";
export { importSkillZip, importSkillFolder, importSkillMarkdown, exportSkill, writeZip, type SkillBundle } from "./archive.js";
export { createSkillTools } from "./tools.js";
export { skillsPromptBlock, withWorkspaceContext, type WorkspaceContextInput } from "./prompt.js";
export { handleSkillsHttp, isSkillsPath, type SkillsHttpOptions } from "./http.js";

export async function installSkills(input: {
  tools: ToolRegistry;
  store: Store;
  ownerId: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<SkillsService> {
  const skills = new SkillsService({ store: input.store, ownerId: input.ownerId, log: input.log });
  await skills.ensureBuiltins().catch((error: unknown) => input.log("skills.builtins_failed", { error: (error as Error).message }));
  const tools = createSkillTools(skills);
  for (const tool of tools) input.tools.register(tool);
  input.log("skills.installed", { tools: tools.map((tool) => tool.name) });
  return skills;
}
