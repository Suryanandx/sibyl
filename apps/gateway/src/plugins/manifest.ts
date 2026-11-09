/**
 * sibyl-plugin.json validation (manifest version 1). Strict: unknown keys are
 * rejected at every level, every string is length-capped, and every
 * `${secret:NAME}` an MCP server uses must be declared under `secrets`.
 * A manifest is data only — there is no field that runs code in the gateway.
 */
import { checkSkillFiles, SKILL_LIMITS, SKILL_NAME, type PluginSummaryView } from "@open-gpt-live/protocol";
import type { PluginManifest, PluginMcpServerSpec, PluginSecretSpec, PluginSkillSpec } from "@open-gpt-live/core";
import { parseCron } from "../routines/cron.js";

export const MANIFEST_VERSION = 1;
export const MAX_MANIFEST_BYTES = 256 * 1024;
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SERVER_KEY = /^[a-zA-Z0-9_-]{1,24}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_REF = /\$\{secret:([A-Za-z0-9_]{1,64})\}/g;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;

export class ManifestError extends Error {}

type Obj = Record<string, unknown>;

function object(value: unknown, where: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ManifestError(`${where} must be an object`);
  return value as Obj;
}

function only(value: Obj, keys: string[], where: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra) throw new ManifestError(`${where}: unknown field "${extra}"`);
}

function text(value: unknown, where: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new ManifestError(`${where} must be a non-empty string`);
  if (value.length > max) throw new ManifestError(`${where} is longer than ${max} characters`);
  return value.trim();
}

function list(value: unknown, where: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ManifestError(`${where} must be a list`);
  if (value.length > max) throw new ManifestError(`${where} has more than ${max} entries`);
  return value;
}

function httpsUrl(value: unknown, where: string): string {
  const raw = text(value, where, 2048)!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ManifestError(`${where} must be a URL`);
  }
  if (url.protocol !== "https:") throw new ManifestError(`${where} must use https`);
  if (url.username || url.password) throw new ManifestError(`${where} must not contain credentials`);
  return raw;
}

function stringRecord(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = object(value, where);
  if (Object.keys(record).length > 30) throw new ManifestError(`${where} has too many entries`);
  for (const [key, item] of Object.entries(record)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new ManifestError(`${where}: invalid key "${key}"`);
    if (typeof item !== "string" || item.length > 4096) throw new ManifestError(`${where}.${key} must be a string`);
  }
  return record as Record<string, string>;
}

/** Validate a parsed sibyl-plugin.json and return the normalised manifest. */
export function validateManifest(input: unknown): PluginManifest {
  const root = object(input, "sibyl-plugin.json");
  only(root, ["$schema", "manifestVersion", "id", "name", "version", "description", "author", "homepage", "license", "skills", "mcpServers", "secrets", "routines", "knowledgeBases"], "sibyl-plugin.json");
  if (root.manifestVersion !== MANIFEST_VERSION) throw new ManifestError(`manifestVersion must be ${MANIFEST_VERSION}`);
  const id = text(root.id, "id", 64)!;
  if (!PLUGIN_ID.test(id)) throw new ManifestError("id must be lowercase letters, digits and dashes (1–64)");
  const version = text(root.version, "version", 48)!;
  if (!VERSION.test(version)) throw new ManifestError("version must be semver, e.g. 1.0.0");
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id,
    name: text(root.name, "name", 80)!,
    version,
    description: text(root.description, "description", 500)!
  };
  const author = text(root.author, "author", 120, true);
  if (author) manifest.author = author;
  if (root.homepage !== undefined) manifest.homepage = httpsUrl(root.homepage, "homepage");
  const license = text(root.license, "license", 64, true);
  if (license) manifest.license = license;

  const skills: PluginSkillSpec[] = [];
  const names = new Set<string>();
  list(root.skills, "skills", 20).forEach((item, index) => {
    const where = `skills[${index}]`;
    const skill = object(item, where);
    only(skill, ["name", "title", "description", "instructions", "tools", "files"], where);
    const name = text(skill.name, `${where}.name`, 64)!;
    if (!SKILL_NAME.test(name)) throw new ManifestError(`${where}.name must be lowercase letters, digits and dashes`);
    if (names.has(name)) throw new ManifestError(`${where}.name "${name}" is used twice`);
    names.add(name);
    const spec: PluginSkillSpec = {
      name,
      title: text(skill.title, `${where}.title`, SKILL_LIMITS.titleChars)!,
      description: text(skill.description, `${where}.description`, SKILL_LIMITS.descriptionChars)!,
      instructions: text(skill.instructions, `${where}.instructions`, SKILL_LIMITS.instructionsChars)!
    };
    if (skill.tools !== undefined) {
      const tools = list(skill.tools, `${where}.tools`, SKILL_LIMITS.tools);
      if (!tools.every((tool) => typeof tool === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(tool))) throw new ManifestError(`${where}.tools must be tool names`);
      spec.tools = tools as string[];
    }
    if (skill.files !== undefined) {
      const files = checkSkillFiles(skill.files);
      if (!files.success) throw new ManifestError(`${where}.files: ${files.error}`);
      spec.files = files.data;
    }
    skills.push(spec);
  });
  if (skills.length) manifest.skills = skills;

  const secrets: PluginSecretSpec[] = [];
  list(root.secrets, "secrets", 10).forEach((item, index) => {
    const where = `secrets[${index}]`;
    const secret = object(item, where);
    only(secret, ["name", "description", "allowedHosts", "howToGet", "docsUrl", "optional"], where);
    const name = text(secret.name, `${where}.name`, 64)!;
    if (!SECRET_NAME.test(name)) throw new ManifestError(`${where}.name must be UPPER_SNAKE_CASE`);
    if (secrets.some((other) => other.name === name)) throw new ManifestError(`${where}.name "${name}" is declared twice`);
    const hosts = list(secret.allowedHosts, `${where}.allowedHosts`, 10);
    if (hosts.length === 0 || !hosts.every((host) => typeof host === "string" && (host === "local" || HOST.test(host)))) {
      throw new ManifestError(`${where}.allowedHosts must list the hosts the key may be sent to (or "local")`);
    }
    const spec: PluginSecretSpec = { name, description: text(secret.description, `${where}.description`, 300)!, allowedHosts: hosts as string[] };
    const howToGet = text(secret.howToGet, `${where}.howToGet`, 600, true);
    if (howToGet) spec.howToGet = howToGet;
    if (secret.docsUrl !== undefined) spec.docsUrl = httpsUrl(secret.docsUrl, `${where}.docsUrl`);
    if (secret.optional !== undefined) {
      if (typeof secret.optional !== "boolean") throw new ManifestError(`${where}.optional must be a boolean`);
      if (secret.optional) spec.optional = true;
    }
    secrets.push(spec);
  });
  if (secrets.length) manifest.secrets = secrets;

  if (root.mcpServers !== undefined) {
    const servers = object(root.mcpServers, "mcpServers");
    if (Object.keys(servers).length > 5) throw new ManifestError("mcpServers has more than 5 entries");
    const out: Record<string, PluginMcpServerSpec> = {};
    for (const [key, value] of Object.entries(servers)) {
      const where = `mcpServers.${key}`;
      if (!SERVER_KEY.test(key)) throw new ManifestError(`${where}: the key must be letters, digits, - or _ (≤ 24)`);
      const server = object(value, where);
      if (server.transport === "http") {
        only(server, ["transport", "url", "headers"], where);
        const headers = stringRecord(server.headers, `${where}.headers`);
        out[key] = { transport: "http", url: httpsUrl(server.url, `${where}.url`), ...(headers ? { headers } : {}) };
      } else if (server.transport === "stdio") {
        only(server, ["transport", "command", "args", "env"], where);
        const command = text(server.command, `${where}.command`, 200)!;
        if (/[\s;&|`$<>]/.test(command)) throw new ManifestError(`${where}.command must be a single program name (e.g. npx)`);
        const args = list(server.args, `${where}.args`, 30);
        if (!args.every((arg) => typeof arg === "string" && arg.length <= 500)) throw new ManifestError(`${where}.args must be strings`);
        const env = stringRecord(server.env, `${where}.env`);
        out[key] = { transport: "stdio", command, ...(args.length ? { args: args as string[] } : {}), ...(env ? { env } : {}) };
      } else {
        throw new ManifestError(`${where}.transport must be "http" or "stdio"`);
      }
    }
    // Every secret an MCP server references must be declared (so it can be asked for).
    for (const [key, server] of Object.entries(out)) {
      const values = server.transport === "http" ? [server.url, ...Object.values(server.headers ?? {})] : [...(server.args ?? []), ...Object.values(server.env ?? {})];
      for (const value of values) {
        for (const match of value.matchAll(SECRET_REF)) {
          if (!secrets.some((secret) => secret.name === match[1])) throw new ManifestError(`mcpServers.${key} uses \${secret:${match[1]}}, which is not declared under secrets`);
        }
      }
      if (server.transport === "http" && /\$\{secret:/.test(server.url)) throw new ManifestError(`mcpServers.${key}.url must not contain secrets (use headers)`);
      if (server.transport === "stdio" && (server.args ?? []).some((arg) => /\$\{secret:/.test(arg))) {
        throw new ManifestError(`mcpServers.${key}.args must not contain secrets (use env)`);
      }
    }
    if (Object.keys(out).length) manifest.mcpServers = out;
  }

  const routines = list(root.routines, "routines", 10).map((item, index) => {
    const where = `routines[${index}]`;
    const routine = object(item, where);
    only(routine, ["name", "instruction", "cron"], where);
    const cron = text(routine.cron, `${where}.cron`, 120)!;
    try {
      parseCron(cron);
    } catch (error) {
      throw new ManifestError(`${where}.cron: ${(error as Error).message}`);
    }
    return { name: text(routine.name, `${where}.name`, 120)!, instruction: text(routine.instruction, `${where}.instruction`, 4000)!, cron };
  });
  if (routines.length) manifest.routines = routines;

  const bases = list(root.knowledgeBases, "knowledgeBases", 5).map((item, index) => {
    const where = `knowledgeBases[${index}]`;
    const base = object(item, where);
    only(base, ["name", "description"], where);
    const description = text(base.description, `${where}.description`, 500, true);
    return { name: text(base.name, `${where}.name`, 80)!, ...(description ? { description } : {}) };
  });
  if (bases.length) manifest.knowledgeBases = bases;
  return manifest;
}

/** Parse JSON text (size-capped) into a validated manifest. */
export function parseManifestText(raw: string): PluginManifest {
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) throw new ManifestError(`sibyl-plugin.json is larger than ${MAX_MANIFEST_BYTES / 1024} KB`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    throw new ManifestError("sibyl-plugin.json is not valid JSON");
  }
  return validateManifest(parsed);
}

export function summarize(manifest: PluginManifest): PluginSummaryView {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    ...(manifest.author ? { author: manifest.author } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
    skills: (manifest.skills ?? []).map((skill) => ({ name: skill.name, title: skill.title, description: skill.description })),
    mcpServers: Object.entries(manifest.mcpServers ?? {}).map(([key, server]) => ({
      key,
      transport: server.transport,
      target: server.transport === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ")
    })),
    secrets: (manifest.secrets ?? []).map((secret) => ({ name: secret.name, description: secret.description, ...(secret.optional ? { optional: true } : {}) })),
    routines: (manifest.routines ?? []).map((routine) => ({ name: routine.name, cron: routine.cron })),
    knowledgeBases: (manifest.knowledgeBases ?? []).map((base) => ({ name: base.name, ...(base.description ? { description: base.description } : {}) }))
  };
}
