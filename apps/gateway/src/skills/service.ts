/**
 * Skills: named instruction packs. Created in the app, imported from a
 * SKILL.md / folder / zip, installed by plugins, or built in.
 *
 * - Names are unique per organization (slug, [a-z0-9-]).
 * - Every edit bumps the patch version and keeps the previous text in a
 *   short history (last 10), so an edit can be undone.
 * - Built-in and plugin skills can be switched on/off but are edited only
 *   by their source (duplicate a built-in to change it).
 */
import { randomUUID } from "node:crypto";
import { availableInWorkspace, type SkillRecord, type Store } from "@open-gpt-live/core";
import { SKILL_NAME, type SkillInput, type SkillVersionView, type SkillView } from "@open-gpt-live/protocol";
import { BUILTIN_SKILLS } from "./builtins.js";
import type { SkillBundle } from "./archive.js";

const HISTORY_PREFIX = "skills.history.";
const HISTORY_LIMIT = 10;
export const MAX_SKILLS = 500;

type Log = (event: string, fields?: Record<string, unknown>) => void;

export class SkillError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

interface HistoryEntry {
  version: string;
  title: string;
  description: string;
  instructions: string;
  tools?: string[];
  files?: Array<{ name: string; content: string }>;
  savedAt: number;
}

export interface SkillsServiceOptions {
  store: Store;
  ownerId: string;
  log?: Log;
  now?: () => number;
  createId?: () => string;
}

export class SkillsService {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: SkillsServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `sk_${randomUUID().replace(/-/g, "").slice(0, 20)}`);
  }

  private get store(): Store {
    return this.options.store;
  }

  private get ownerId(): string {
    return this.options.ownerId;
  }

  /** Insert missing built-ins; refresh outdated ones (keeping the on/off switch). */
  async ensureBuiltins(): Promise<void> {
    const now = this.now();
    for (const builtin of BUILTIN_SKILLS) {
      const existing = await this.store.skills.get(this.ownerId, builtin.id);
      if (existing && existing.version === builtin.version) continue;
      const clash = (await this.store.skills.list(this.ownerId)).find((skill) => skill.name === builtin.name && skill.id !== builtin.id);
      if (clash) continue; // The user already has a skill with this name.
      await this.store.skills.upsert({
        id: builtin.id,
        ownerId: this.ownerId,
        name: builtin.name,
        title: builtin.title,
        description: builtin.description,
        instructions: builtin.instructions,
        ...(builtin.tools ? { tools: builtin.tools } : {}),
        ...(builtin.files ? { files: builtin.files } : {}),
        source: "builtin",
        enabled: existing?.enabled ?? true,
        version: builtin.version,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
    }
  }

  async list(workspaceId: string): Promise<SkillView[]> {
    const skills = await this.store.skills.list(this.ownerId);
    return skills
      .filter((skill) => availableInWorkspace(skill, workspaceId))
      .sort((a, b) => sourceRank(a) - sourceRank(b) || a.title.localeCompare(b.title))
      .map(skillView);
  }

  /** Enabled skills visible in the workspace (what the brain may use). */
  async enabled(workspaceId: string): Promise<SkillRecord[]> {
    return (await this.store.skills.list(this.ownerId))
      .filter((skill) => skill.enabled && availableInWorkspace(skill, workspaceId))
      .sort((a, b) => sourceRank(a) - sourceRank(b) || a.name.localeCompare(b.name));
  }

  async get(workspaceId: string, id: string): Promise<SkillView> {
    return skillView(await this.require(workspaceId, id));
  }

  async getRecord(workspaceId: string, id: string): Promise<SkillRecord> {
    return this.require(workspaceId, id);
  }

  async findByName(workspaceId: string, name: string): Promise<SkillRecord | undefined> {
    const wanted = name.trim().toLowerCase();
    return (await this.store.skills.list(this.ownerId)).find((skill) => skill.name === wanted && availableInWorkspace(skill, workspaceId));
  }

  async create(
    workspaceId: string,
    input: SkillInput,
    origin: { source?: SkillRecord["source"]; pluginId?: string; version?: string; workspaceId?: string | null } = {}
  ): Promise<SkillView> {
    if (!SKILL_NAME.test(input.name)) throw new SkillError("The name must be lowercase letters, digits and dashes.", 400, "invalid_name");
    const all = await this.store.skills.list(this.ownerId);
    if (all.length >= MAX_SKILLS) throw new SkillError(`There can be at most ${MAX_SKILLS} skills.`, 409, "limit");
    if (all.some((skill) => skill.name === input.name)) throw new SkillError(`A skill named "${input.name}" already exists.`, 409, "name_taken");
    const now = this.now();
    // origin.workspaceId: null = every workspace (plugins installed for all).
    const scoped = origin.workspaceId === null ? undefined : origin.workspaceId ?? (input.scope === "all" ? undefined : workspaceId);
    const record: SkillRecord = {
      id: this.createId(),
      ownerId: this.ownerId,
      ...(scoped ? { workspaceId: scoped } : {}),
      name: input.name,
      title: input.title,
      description: input.description,
      instructions: input.instructions,
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(input.files?.length ? { files: input.files } : {}),
      source: origin.source ?? "user",
      ...(origin.pluginId ? { pluginId: origin.pluginId } : {}),
      enabled: input.enabled ?? true,
      version: origin.version ?? "1.0.0",
      createdAt: now,
      updatedAt: now
    };
    await this.store.skills.upsert(record);
    return skillView(record);
  }

  async update(workspaceId: string, id: string, patch: Partial<SkillInput>, options: { version?: string; allowManaged?: boolean } = {}): Promise<SkillView> {
    const skill = await this.require(workspaceId, id);
    const contentKeys = (["name", "title", "description", "instructions", "tools", "files", "scope"] as const).filter((key) => patch[key] !== undefined);
    if (contentKeys.length > 0 && skill.source !== "user" && !options.allowManaged) {
      throw new SkillError(
        skill.source === "builtin" ? "Built-in skills can only be switched on or off. Duplicate it to make your own version." : "This skill comes from a plugin; it can only be switched on or off.",
        409,
        "managed"
      );
    }
    if (patch.name !== undefined && patch.name !== skill.name) {
      if (!SKILL_NAME.test(patch.name)) throw new SkillError("The name must be lowercase letters, digits and dashes.", 400, "invalid_name");
      if ((await this.store.skills.list(this.ownerId)).some((other) => other.name === patch.name)) {
        throw new SkillError(`A skill named "${patch.name}" already exists.`, 409, "name_taken");
      }
    }
    const next: SkillRecord = { ...skill, updatedAt: this.now() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.instructions !== undefined) next.instructions = patch.instructions;
    if (patch.tools !== undefined) {
      if (patch.tools.length) next.tools = patch.tools;
      else delete next.tools;
    }
    if (patch.files !== undefined) {
      if (patch.files.length) next.files = patch.files;
      else delete next.files;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.scope !== undefined) {
      if (patch.scope === "all") delete next.workspaceId;
      else next.workspaceId = workspaceId;
    }
    const contentChanged =
      next.title !== skill.title ||
      next.description !== skill.description ||
      next.instructions !== skill.instructions ||
      JSON.stringify(next.tools ?? []) !== JSON.stringify(skill.tools ?? []) ||
      JSON.stringify(next.files ?? []) !== JSON.stringify(skill.files ?? []);
    if (contentChanged) {
      await this.pushHistory(skill);
      next.version = options.version ?? bumpPatch(skill.version);
    }
    await this.store.skills.upsert(next);
    return skillView(next);
  }

  async remove(workspaceId: string, id: string, options: { allowManaged?: boolean } = {}): Promise<void> {
    const skill = await this.require(workspaceId, id);
    if (skill.source !== "user" && !options.allowManaged) {
      throw new SkillError(skill.source === "builtin" ? "Built-in skills can't be deleted; switch it off instead." : "Uninstall the plugin to remove its skills.", 409, "managed");
    }
    await this.store.skills.remove(this.ownerId, skill.id);
    await this.store.kv.delete(this.ownerId, HISTORY_PREFIX + skill.id);
  }

  /** Remove a plugin's skill regardless of workspace (uninstall). */
  async removeById(id: string): Promise<void> {
    await this.store.skills.remove(this.ownerId, id);
    await this.store.kv.delete(this.ownerId, HISTORY_PREFIX + id);
  }

  async setEnabledById(id: string, enabled: boolean): Promise<void> {
    const skill = await this.store.skills.get(this.ownerId, id);
    if (skill && skill.enabled !== enabled) await this.store.skills.upsert({ ...skill, enabled, updatedAt: this.now() });
  }

  async versions(workspaceId: string, id: string): Promise<SkillVersionView[]> {
    const skill = await this.require(workspaceId, id);
    const history = await this.history(skill.id);
    return history.map((entry) => ({ version: entry.version, title: entry.title, description: entry.description, savedAt: entry.savedAt })).reverse();
  }

  async restore(workspaceId: string, id: string, version: string): Promise<SkillView> {
    const skill = await this.require(workspaceId, id);
    if (skill.source !== "user") throw new SkillError("Only your own skills have a version history.", 409, "managed");
    const entry = (await this.history(skill.id)).find((item) => item.version === version);
    if (!entry) throw new SkillError(`Version ${version} was not found.`, 404, "not_found");
    return this.update(workspaceId, id, {
      title: entry.title,
      description: entry.description,
      instructions: entry.instructions,
      tools: entry.tools ?? [],
      files: entry.files ?? []
    });
  }

  /** Import a bundle: creates the skill, or adds a new version of your skill with the same name. */
  async importBundle(workspaceId: string, bundle: SkillBundle, scope: "workspace" | "all" = "workspace"): Promise<{ skill: SkillView; updated: boolean; skipped: string[] }> {
    const input: SkillInput = {
      name: bundle.name,
      title: bundle.title,
      description: bundle.description,
      instructions: bundle.instructions.slice(0, 40_000),
      ...(bundle.tools ? { tools: bundle.tools } : {}),
      files: bundle.files,
      scope
    };
    const existing = (await this.store.skills.list(this.ownerId)).find((skill) => skill.name === bundle.name);
    if (existing) {
      if (existing.source !== "user" || !availableInWorkspace(existing, workspaceId)) {
        throw new SkillError(`A skill named "${bundle.name}" already exists here and can't be replaced by an import.`, 409, "name_taken");
      }
      const { scope: _scope, name: _name, ...patch } = input;
      const skill = await this.update(workspaceId, existing.id, patch, bundle.version && bundle.version !== existing.version ? { version: bundle.version } : {});
      return { skill, updated: true, skipped: bundle.skipped };
    }
    return { skill: await this.create(workspaceId, input, bundle.version ? { version: bundle.version } : {}), updated: false, skipped: bundle.skipped };
  }

  private async require(workspaceId: string, id: string): Promise<SkillRecord> {
    const skill = await this.store.skills.get(this.ownerId, id);
    if (!skill || !availableInWorkspace(skill, workspaceId)) throw new SkillError("That skill was not found.", 404, "not_found");
    return skill;
  }

  private async history(id: string): Promise<HistoryEntry[]> {
    const stored = await this.store.kv.get<HistoryEntry[]>(this.ownerId, HISTORY_PREFIX + id);
    return Array.isArray(stored) ? stored : [];
  }

  private async pushHistory(skill: SkillRecord): Promise<void> {
    if (skill.source !== "user") return;
    const history = await this.history(skill.id);
    history.push({
      version: skill.version ?? "1.0.0",
      title: skill.title,
      description: skill.description,
      instructions: skill.instructions,
      ...(skill.tools ? { tools: skill.tools } : {}),
      ...(skill.files ? { files: skill.files } : {}),
      savedAt: this.now()
    });
    await this.store.kv.set(this.ownerId, HISTORY_PREFIX + skill.id, history.slice(-HISTORY_LIMIT));
  }
}

function sourceRank(skill: SkillRecord): number {
  return skill.source === "user" ? 0 : skill.source === "plugin" ? 1 : 2;
}

export function bumpPatch(version: string | undefined): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return "1.0.1";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function skillView(skill: SkillRecord): SkillView {
  return {
    id: skill.id,
    ...(skill.workspaceId ? { workspaceId: skill.workspaceId } : {}),
    name: skill.name,
    title: skill.title,
    description: skill.description,
    instructions: skill.instructions,
    ...(skill.tools ? { tools: skill.tools } : {}),
    ...(skill.files ? { files: skill.files } : {}),
    source: skill.source,
    ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
    ...(skill.agentId ? { agentId: skill.agentId } : {}),
    enabled: skill.enabled,
    ...(skill.version ? { version: skill.version } : {}),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt
  };
}
