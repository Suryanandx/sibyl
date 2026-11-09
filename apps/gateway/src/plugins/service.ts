/**
 * Plugins: a sibyl-plugin.json installed and removed as one unit.
 *
 * Installing (from the catalog, an https URL or a git repository's manifest):
 *  1. fetch + strictly validate the manifest (data only — no code runs);
 *  2. create its skills (source "plugin") and empty knowledge bases;
 *  3. if a required secret is missing → status "needs_secrets" (the app opens
 *     the secure key box; values go straight into the vault);
 *  4. otherwise register its MCP servers through the Connections manager
 *     (`${secret:NAME}` resolved only at connect time, host-checked);
 *  5. routine templates are offered, and created only when the user accepts.
 * Disable/enable switches skills and servers together; uninstall removes
 * everything the plugin added (non-empty knowledge bases and vault secrets
 * are kept — they hold the user's data).
 */
import { createHash } from "node:crypto";
import { availableInWorkspace, type PluginManifest, type PluginRecord, type PluginSource, type Store } from "@open-gpt-live/core";
import type { ConnectionServerInput, PluginCatalogEntryView, PluginSourceInput, PluginView } from "@open-gpt-live/protocol";
import type { KnowledgeService } from "../knowledge/service.js";
import { createRoutineRecord, RoutineInputError } from "../routines/records.js";
import type { RoutineService } from "../routines/service.js";
import type { SecretVault } from "../secrets/vault.js";
import type { SkillsService } from "../skills/service.js";
import { stdioAllowed, type ConnectionsManager } from "../tools/connections.js";
import catalogJson from "./catalog.json";
import { fetchManifestText, gitManifestUrl, type ManifestFetchDeps } from "./fetch.js";
import { ManifestError, parseManifestText, summarize, validateManifest } from "./manifest.js";

const STATE_PREFIX = "plugins.state.";
export const MAX_PLUGINS = 50;

type Log = (event: string, fields?: Record<string, unknown>) => void;

export class PluginError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

/** What a plugin added, so uninstall removes exactly that. */
interface InstallState {
  skillIds: string[];
  servers: string[];
  knowledgeBases: Array<{ id: string; workspaceId: string }>;
  /** Template index → routine id. */
  routines: Record<string, string>;
}

export interface PluginServiceOptions {
  store: Store;
  ownerId: string;
  skills: SkillsService;
  knowledge?: KnowledgeService;
  connections?: ConnectionsManager;
  vault?: SecretVault;
  routines?: RoutineService;
  env?: NodeJS.ProcessEnv;
  fetch?: ManifestFetchDeps;
  log?: Log;
  now?: () => number;
  createId?: () => string;
}

let catalogCache: PluginManifest[] | undefined;

/** The curated catalog (validated once; a broken entry is a build bug). */
export function loadPluginCatalog(): PluginManifest[] {
  catalogCache ??= (catalogJson as { plugins: unknown[] }).plugins.map((entry) => validateManifest(entry));
  return catalogCache;
}

/** MCP server name for a plugin's server key (≤ 32 chars, [a-zA-Z0-9_-]). */
export function pluginServerName(pluginId: string, key: string): string {
  const name = `${pluginId}-${key}`;
  if (name.length <= 32 && pluginId !== key) return name;
  if (pluginId === key && pluginId.length <= 32) return pluginId;
  const hash = createHash("sha256").update(`${pluginId}/${key}`).digest("hex").slice(0, 6);
  return `${pluginId.slice(0, 32 - key.length - 8)}-${hash}-${key}`.slice(0, 32);
}

export class PluginService {
  private readonly now: () => number;

  constructor(private readonly options: PluginServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private get store(): Store {
    return this.options.store;
  }

  private get ownerId(): string {
    return this.options.ownerId;
  }

  get stdioAllowed(): boolean {
    return this.options.connections?.allowStdio ?? stdioAllowed(this.options.env ?? process.env);
  }

  async list(workspaceId: string): Promise<{ installed: PluginView[]; catalog: PluginCatalogEntryView[] }> {
    const records = (await this.store.plugins.list(this.ownerId)).filter((record) => availableInWorkspace(record, workspaceId));
    const installedIds = new Set((await this.store.plugins.list(this.ownerId)).map((record) => record.id));
    return {
      installed: await Promise.all(records.map((record) => this.view(record))),
      catalog: loadPluginCatalog().map((manifest) => ({ ref: manifest.id, summary: summarize(manifest), installed: installedIds.has(manifest.id) }))
    };
  }

  async get(workspaceId: string, id: string): Promise<PluginView> {
    return this.view(await this.require(workspaceId, id));
  }

  /** Fetch and validate a manifest without installing it (the confirm step). */
  async preview(source: PluginSourceInput): Promise<{ manifest: PluginManifest; source: PluginSource }> {
    if (source.kind === "catalog") {
      const manifest = loadPluginCatalog().find((entry) => entry.id === source.ref);
      if (!manifest) throw new PluginError("That plugin is not in the catalog.", 404, "not_found");
      return { manifest, source: { kind: "catalog", ref: manifest.id } };
    }
    const url = source.kind === "git" ? gitManifestUrl(source.ref) : source.ref;
    const { text } = await fetchManifestText(url, this.options.fetch ?? {});
    return { manifest: parseManifestText(text), source: { kind: source.kind, ref: source.ref } };
  }

  async install(workspaceId: string, input: { source: PluginSourceInput; scope: "workspace" | "all" }): Promise<PluginView> {
    const { manifest, source } = await this.preview(input.source);
    return this.installManifest(workspaceId, manifest, source, input.scope);
  }

  async installManifest(workspaceId: string, manifest: PluginManifest, source: PluginSource, scope: "workspace" | "all"): Promise<PluginView> {
    const existing = await this.store.plugins.get(this.ownerId, manifest.id);
    const keepEnabled = existing?.enabled ?? true;
    if (existing) {
      // Reinstall / update: replace what the old version added.
      if (!availableInWorkspace(existing, workspaceId)) throw new PluginError("This plugin is installed in another workspace.", 409, "installed_elsewhere");
      await this.removeParts(existing.id, { keepKnowledge: true });
    } else if ((await this.store.plugins.list(this.ownerId)).length >= MAX_PLUGINS) {
      throw new PluginError(`There can be at most ${MAX_PLUGINS} plugins.`, 409, "limit");
    }
    const now = this.now();
    const scopedWorkspace = scope === "all" ? undefined : workspaceId;
    const state: InstallState = { skillIds: [], servers: [], knowledgeBases: [], routines: {} };
    const record: PluginRecord = {
      id: manifest.id,
      ownerId: this.ownerId,
      ...(scopedWorkspace ? { workspaceId: scopedWorkspace } : {}),
      manifest,
      source,
      enabled: keepEnabled,
      status: "ready",
      installedAt: existing?.installedAt ?? now,
      updatedAt: now
    };
    try {
      for (const spec of manifest.skills ?? []) {
        const name = await this.freeSkillName(spec.name, manifest.id);
        const skill = await this.options.skills.create(
          workspaceId,
          {
            name,
            title: spec.title,
            description: spec.description,
            instructions: spec.instructions,
            ...(spec.tools ? { tools: spec.tools } : {}),
            ...(spec.files ? { files: spec.files } : {}),
            enabled: keepEnabled
          },
          { source: "plugin", pluginId: manifest.id, version: manifest.version, workspaceId: scopedWorkspace ?? null }
        );
        state.skillIds.push(skill.id);
      }
      if (manifest.knowledgeBases?.length && this.options.knowledge) {
        const current = await this.options.knowledge.listBases(workspaceId);
        for (const spec of manifest.knowledgeBases) {
          if (current.some((base) => base.name === spec.name)) continue; // Reuse, don't own.
          const base = await this.options.knowledge.createBase(workspaceId, spec);
          state.knowledgeBases.push({ id: base.id, workspaceId });
        }
      }
    } catch (error) {
      await this.saveState(manifest.id, state);
      await this.removeParts(manifest.id, { keepKnowledge: false });
      throw error;
    }
    await this.saveState(manifest.id, state);
    await this.store.plugins.upsert(record);
    this.options.log?.("plugins.installed", { id: manifest.id, version: manifest.version, source: source.kind, skills: state.skillIds.length });
    return this.view(await this.finalize(record));
  }

  /** Store a secret from the secure key box, then finish the install when nothing is missing. */
  async provideSecret(workspaceId: string, id: string, input: { name: unknown; value: unknown; allowedHosts?: unknown }): Promise<PluginView> {
    const record = await this.require(workspaceId, id);
    const vault = this.requireVault();
    const spec = record.manifest.secrets?.find((secret) => secret.name === input.name);
    if (!spec) throw new PluginError("This plugin doesn't use that secret.", 404, "unknown_secret");
    if (typeof input.value !== "string" || !input.value.trim()) throw new PluginError("Enter the key.", 400, "invalid");
    const hosts = input.allowedHosts === undefined ? spec.allowedHosts : input.allowedHosts;
    if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === "string")) throw new PluginError("allowedHosts must be a list of hosts.", 400, "invalid");
    try {
      await vault.set(this.ownerId, { name: spec.name, value: input.value, service: record.manifest.name, description: spec.description, allowedHosts: hosts as string[] });
    } catch (error) {
      throw new PluginError((error as Error).message, 400, "invalid_secret");
    }
    return this.view(await this.finalize(record));
  }

  /** Re-check secrets (e.g. added on the Secrets screen) and retry registering servers. */
  async recheck(workspaceId: string, id: string): Promise<PluginView> {
    return this.view(await this.finalize(await this.require(workspaceId, id)));
  }

  async setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<PluginView> {
    const record = await this.require(workspaceId, id);
    const state = await this.state(id);
    for (const skillId of state.skillIds) await this.options.skills.setEnabledById(skillId, enabled);
    for (const server of state.servers) {
      await this.options.connections?.setServerEnabled(server, enabled).catch((error: unknown) => {
        this.options.log?.("plugins.server_toggle_failed", { id, server, error: (error as Error).message });
      });
    }
    const next: PluginRecord = { ...record, enabled, updatedAt: this.now() };
    await this.store.plugins.upsert(next);
    return this.view(next);
  }

  async uninstall(workspaceId: string, id: string): Promise<{ keptKnowledgeBases: string[] }> {
    const record = await this.require(workspaceId, id);
    const kept = await this.removeParts(record.id, { keepKnowledge: false });
    await this.store.plugins.remove(this.ownerId, record.id);
    await this.store.kv.delete(this.ownerId, STATE_PREFIX + record.id);
    this.options.log?.("plugins.uninstalled", { id: record.id });
    return { keptKnowledgeBases: kept };
  }

  /**
   * Create a routine from one of the plugin's templates (the user confirmed
   * it). `createdBy` is that user (routines run as their creator, with their
   * current rights).
   */
  async addRoutine(workspaceId: string, id: string, index: number, createdBy: string): Promise<PluginView> {
    const record = await this.require(workspaceId, id);
    const template = record.manifest.routines?.[index];
    if (!template) throw new PluginError("That routine template doesn't exist.", 404, "not_found");
    const state = await this.state(id);
    if (state.routines[String(index)] && (await this.store.routines.get(this.ownerId, state.routines[String(index)]!))) {
      throw new PluginError("This routine was already created.", 409, "exists");
    }
    const routines = this.options.routines;
    try {
      const routine = createRoutineRecord(
        { name: template.name, instruction: template.instruction, cron: template.cron, timezone: routines?.getTimezone() ?? "UTC" },
        { id: this.options.createId?.() ?? `rt_${createHash("sha256").update(`${id}/${index}/${this.now()}`).digest("hex").slice(0, 16)}`, ownerId: this.ownerId, now: this.now(), workspaceId, createdBy }
      );
      await this.store.routines.upsert(routine);
      routines?.changed();
      state.routines[String(index)] = routine.id;
      await this.saveState(id, state);
    } catch (error) {
      if (error instanceof RoutineInputError) throw new PluginError(error.message, 400, "invalid_routine");
      throw error;
    }
    return this.view(record);
  }

  /* ───────────── internals ───────────── */

  /** Register MCP servers when every required secret is present; set the status. */
  private async finalize(record: PluginRecord): Promise<PluginRecord> {
    const manifest = record.manifest;
    const servers = Object.entries(manifest.mcpServers ?? {});
    const missing = await this.missingSecrets(manifest);
    let next: PluginRecord = { ...record, updatedAt: this.now() };
    delete next.error;
    if (servers.length > 0 && !this.options.connections) {
      next = { ...next, status: "error", error: "MCP connections are not available on this gateway." };
    } else if ((manifest.secrets?.length ?? 0) > 0 && !this.options.vault) {
      next = { ...next, status: "error", error: "Secrets are not available on this gateway (check SIBYL_SECRET_KEY)." };
    } else if (missing.length > 0) {
      next = { ...next, status: "needs_secrets" };
    } else {
      const state = await this.state(record.id);
      const errors: string[] = [];
      for (const [key, spec] of servers) {
        const name = pluginServerName(manifest.id, key);
        const input: ConnectionServerInput =
          spec.transport === "http"
            ? { name, transport: "http", url: spec.url, headers: { ...(spec.headers ?? {}) }, catalogId: `plugin:${manifest.id}` }
            : { name, transport: "stdio", command: spec.command, args: [...(spec.args ?? [])], env: { ...(spec.env ?? {}) }, catalogId: `plugin:${manifest.id}` };
        try {
          await this.saveServer(input, state.servers.includes(name));
          if (!state.servers.includes(name)) state.servers.push(name);
          if (!record.enabled) await this.options.connections!.setServerEnabled(name, false);
        } catch (error) {
          errors.push(`${key}: ${(error as Error).message}`);
        }
      }
      await this.saveState(record.id, state);
      next = errors.length ? { ...next, status: "error", error: errors.join(" ").slice(0, 500) } : { ...next, status: "ready" };
    }
    await this.store.plugins.upsert(next);
    return next;
  }

  private async saveServer(input: ConnectionServerInput, known: boolean): Promise<void> {
    const connections = this.options.connections!;
    try {
      await connections.saveServer(input, known ? input.name : undefined);
    } catch (error) {
      // Registered by an earlier install whose state was lost: replace it.
      if (!known && /already exists/.test((error as Error).message)) await connections.saveServer(input, input.name);
      else throw error;
    }
  }

  private async missingSecrets(manifest: PluginManifest): Promise<string[]> {
    const vault = this.options.vault;
    const required = (manifest.secrets ?? []).filter((secret) => !secret.optional);
    if (!vault) return required.map((secret) => secret.name);
    const missing: string[] = [];
    for (const secret of required) if (!(await vault.has(this.ownerId, secret.name))) missing.push(secret.name);
    return missing;
  }

  /** Remove skills, servers, routines and (empty) knowledge bases. Returns names of kept bases. */
  private async removeParts(id: string, options: { keepKnowledge: boolean }): Promise<string[]> {
    const state = await this.state(id);
    for (const skillId of state.skillIds) await this.options.skills.removeById(skillId);
    for (const server of state.servers) {
      await this.options.connections?.removeServer(server).catch((error: unknown) => {
        this.options.log?.("plugins.server_remove_failed", { id, server, error: (error as Error).message });
      });
    }
    const kept: string[] = [];
    if (!options.keepKnowledge) {
      for (const routineId of Object.values(state.routines)) {
        if (this.options.routines) await this.options.routines.discard(routineId).catch(() => undefined);
        else await this.store.routines.remove(this.ownerId, routineId).catch(() => undefined);
      }
      for (const base of state.knowledgeBases) {
        const record = await this.store.knowledge.getBase(this.ownerId, base.id);
        if (!record) continue;
        const docs = await this.store.knowledge.listDocs(this.ownerId, base.id);
        if (docs.length > 0) {
          kept.push(record.name);
          continue;
        }
        if (this.options.knowledge) await this.options.knowledge.removeBase(base.workspaceId, base.id).catch(() => undefined);
        else await this.store.knowledge.removeBase(this.ownerId, base.id);
      }
    }
    await this.saveState(id, {
      skillIds: [],
      servers: [],
      knowledgeBases: options.keepKnowledge ? state.knowledgeBases : [],
      routines: options.keepKnowledge ? state.routines : {}
    });
    return kept;
  }

  private async freeSkillName(name: string, pluginId: string): Promise<string> {
    const taken = new Set((await this.store.skills.list(this.ownerId)).map((skill) => skill.name));
    if (!taken.has(name)) return name;
    const prefixed = `${pluginId}-${name}`.slice(0, 64).replace(/-+$/, "");
    if (!taken.has(prefixed)) return prefixed;
    throw new PluginError(`A skill named "${name}" already exists. Rename it before installing this plugin.`, 409, "name_taken");
  }

  private async view(record: PluginRecord): Promise<PluginView> {
    const state = await this.state(record.id);
    const vault = this.options.vault;
    const secrets = await Promise.all(
      (record.manifest.secrets ?? []).map(async (secret) => ({
        name: secret.name,
        description: secret.description,
        allowedHosts: secret.allowedHosts,
        ...(secret.howToGet ? { howToGet: secret.howToGet } : {}),
        ...(secret.docsUrl ? { docsUrl: secret.docsUrl } : {}),
        ...(secret.optional ? { optional: true } : {}),
        present: vault ? await vault.has(this.ownerId, secret.name) : false
      }))
    );
    return {
      id: record.id,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      summary: summarize(record.manifest),
      source: record.source,
      enabled: record.enabled,
      status: record.status,
      ...(record.error ? { error: record.error } : {}),
      secrets,
      routines: (record.manifest.routines ?? []).map((routine, index) => ({
        index,
        name: routine.name,
        instruction: routine.instruction,
        cron: routine.cron,
        ...(state.routines[String(index)] ? { routineId: state.routines[String(index)] } : {})
      })),
      servers: state.servers,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt
    };
  }

  private async require(workspaceId: string, id: string): Promise<PluginRecord> {
    const record = await this.store.plugins.get(this.ownerId, id);
    if (!record || !availableInWorkspace(record, workspaceId)) throw new PluginError("That plugin is not installed here.", 404, "not_found");
    return record;
  }

  private requireVault(): SecretVault {
    if (!this.options.vault) throw new PluginError("Secrets are not available on this gateway (check SIBYL_SECRET_KEY).", 503, "secrets_unavailable");
    return this.options.vault;
  }

  private async state(id: string): Promise<InstallState> {
    const stored = await this.store.kv.get<Partial<InstallState>>(this.ownerId, STATE_PREFIX + id);
    return {
      skillIds: Array.isArray(stored?.skillIds) ? stored.skillIds : [],
      servers: Array.isArray(stored?.servers) ? stored.servers : [],
      knowledgeBases: Array.isArray(stored?.knowledgeBases) ? stored.knowledgeBases : [],
      routines: stored?.routines && typeof stored.routines === "object" ? stored.routines : {}
    };
  }

  private async saveState(id: string, state: InstallState): Promise<void> {
    await this.store.kv.set(this.ownerId, STATE_PREFIX + id, state);
  }
}

export { ManifestError };
