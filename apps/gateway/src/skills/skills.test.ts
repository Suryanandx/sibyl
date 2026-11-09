import { describe, expect, test } from "vitest";
import { createMemoryStore, createToolRegistry, ownerPrincipal, type ToolContext } from "@open-gpt-live/core";
import { parseSkillInput } from "@open-gpt-live/protocol";
import { createNoopMeter } from "../runtime.js";
import { listZipEntries, readZipEntry } from "../uploads/zip.js";
import { exportSkill, importSkillFolder, importSkillMarkdown, importSkillZip, writeZip } from "./archive.js";
import { BUILTIN_SKILLS } from "./builtins.js";
import { skillsPromptBlock, withWorkspaceContext } from "./prompt.js";
import { SkillsService } from "./service.js";
import { parseSkillMd, SkillFormatError } from "./skill-md.js";
import { createSkillTools } from "./tools.js";

const SKILL_MD = `---
name: release-notes
description: >
  Use when the user asks for release notes
  from merged pull requests.
allowed-tools: [read_webpage, web_search]
version: 2.1.0
---

# Release notes

Group changes into New, Improved and Fixed.
`;

function setup() {
  const store = createMemoryStore();
  let id = 0;
  const skills = new SkillsService({ store, ownerId: "owner", createId: () => `sk_${++id}` });
  return { store, skills };
}

function ctx(store: ReturnType<typeof createMemoryStore>, workspaceId = "default"): ToolContext {
  return { signal: new AbortController().signal, ownerId: "owner", runId: "r", principal: ownerPrincipal("owner", "local"), workspaceId, store, meter: createNoopMeter(), log: () => undefined };
}

describe("SKILL.md", () => {
  test("parses front matter, block scalars and allowed-tools", () => {
    const parsed = parseSkillMd(SKILL_MD);
    expect(parsed).toMatchObject({
      name: "release-notes",
      title: "Release notes",
      description: "Use when the user asks for release notes from merged pull requests.",
      tools: ["read_webpage", "web_search"],
      version: "2.1.0"
    });
    expect(parsed.instructions.startsWith("# Release notes")).toBe(true);
  });

  test("needs a name and a description", () => {
    expect(() => parseSkillMd("---\ndescription: x\n---\nbody")).toThrow(SkillFormatError);
    expect(() => parseSkillMd("---\nname: x\n---\nbody")).toThrow(/description/);
    expect(parseSkillMd("---\ndescription: d\n---\nbody", "My Folder").name).toBe("my-folder");
  });
});

describe("bundles", () => {
  test("zip import keeps small text files, skips binaries and refuses traversal", () => {
    const zip = writeZip([
      { name: "release-notes/SKILL.md", data: Buffer.from(SKILL_MD) },
      { name: "release-notes/template.md", data: Buffer.from("## New\n") },
      { name: "release-notes/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]) },
      { name: "__MACOSX/._SKILL.md", data: Buffer.from("junk") }
    ]);
    const bundle = importSkillZip(zip);
    expect(bundle.name).toBe("release-notes");
    expect(bundle.files).toEqual([{ name: "template.md", content: "## New\n" }]);
    expect(bundle.skipped).toEqual(["logo.png"]);

    const evil = writeZip([
      { name: "SKILL.md", data: Buffer.from(SKILL_MD) },
      { name: "../../etc/passwd", data: Buffer.from("x") }
    ]);
    expect(() => importSkillZip(evil)).toThrow(/Unsafe path/);
    expect(() => importSkillZip(writeZip([{ name: "/abs/SKILL.md", data: Buffer.from(SKILL_MD) }]))).toThrow(/Unsafe/);
    expect(() => importSkillZip(writeZip([{ name: "notes.md", data: Buffer.from("x") }]))).toThrow(/No SKILL.md/);
    expect(() => importSkillZip(Buffer.from("not a zip"))).toThrow(SkillFormatError);
  });

  test("folder import and size caps", () => {
    const bundle = importSkillFolder([
      { path: "SKILL.md", content: SKILL_MD },
      { path: "examples/one.md", content: "example" },
      { path: "big.txt", content: "x".repeat(70 * 1024) }
    ]);
    expect(bundle.files.map((file) => file.name)).toEqual(["examples/one.md"]);
    expect(bundle.skipped).toEqual(["big.txt"]);
    expect(() => importSkillFolder([{ path: "a/../../SKILL.md", content: SKILL_MD }])).toThrow(/Unsafe/);
  });

  test("export round-trips through import", () => {
    const md = exportSkill({ name: "a", title: "A", description: "d", instructions: "Do it." });
    expect(md.fileName).toBe("SKILL.md");
    expect(importSkillMarkdown(md.data.toString("utf8")).instructions).toBe("Do it.");
    const zipped = exportSkill({ name: "a", title: "A", description: "d", instructions: "Do it.", files: [{ name: "t.md", content: "T" }] });
    expect(zipped.fileName).toBe("a.zip");
    const entries = listZipEntries(zipped.data);
    expect(entries.map((entry) => entry.name)).toEqual(["a/SKILL.md", "a/t.md"]);
    expect(readZipEntry(zipped.data, entries[1]!, 100).toString()).toBe("T");
    expect(importSkillZip(zipped.data)).toMatchObject({ name: "a", title: "A", files: [{ name: "t.md", content: "T" }] });
  });
});

describe("skills service", () => {
  test("seeds built-ins once and protects them", async () => {
    const { skills } = setup();
    await skills.ensureBuiltins();
    await skills.ensureBuiltins();
    const list = await skills.list("default");
    expect(list.filter((skill) => skill.source === "builtin")).toHaveLength(BUILTIN_SKILLS.length);
    const builtin = list.find((skill) => skill.name === "status-update")!;
    await expect(skills.update("default", builtin.id, { title: "Mine" })).rejects.toThrow(/Built-in/);
    await expect(skills.remove("default", builtin.id)).rejects.toThrow(/can't be deleted/);
    expect((await skills.update("default", builtin.id, { enabled: false })).enabled).toBe(false);
    await skills.ensureBuiltins();
    expect((await skills.get("default", builtin.id)).enabled).toBe(false);
  });

  test("versions every edit and can restore", async () => {
    const { skills } = setup();
    const created = await skills.create("default", { name: "tone", title: "Tone", description: "Use for tone.", instructions: "Be warm." });
    expect(created.version).toBe("1.0.0");
    const edited = await skills.update("default", created.id, { instructions: "Be direct." });
    expect(edited.version).toBe("1.0.1");
    expect((await skills.update("default", created.id, { enabled: false })).version).toBe("1.0.1");
    expect(await skills.versions("default", created.id)).toEqual([expect.objectContaining({ version: "1.0.0" })]);
    const restored = await skills.restore("default", created.id, "1.0.0");
    expect(restored).toMatchObject({ instructions: "Be warm.", version: "1.0.2" });
    await expect(skills.create("default", { name: "tone", title: "x", description: "x", instructions: "x" })).rejects.toThrow(/already exists/);
  });

  test("workspace scoping and import as a new version", async () => {
    const { skills } = setup();
    const sales = await skills.create("sales", { name: "pitch", title: "Pitch", description: "d", instructions: "i" });
    const everywhere = await skills.create("sales", { name: "tone", title: "Tone", description: "d", instructions: "i", scope: "all" });
    expect((await skills.list("default")).map((s) => s.id)).toEqual([everywhere.id]);
    expect((await skills.list("sales")).map((s) => s.id).sort()).toEqual([sales.id, everywhere.id].sort());
    await expect(skills.get("default", sales.id)).rejects.toThrow(/not found/);
    const first = await skills.importBundle("default", importSkillMarkdown(SKILL_MD));
    expect(first).toMatchObject({ updated: false, skill: { name: "release-notes", version: "2.1.0" } });
    const again = await skills.importBundle("default", importSkillMarkdown(SKILL_MD.replace("2.1.0", "2.2.0").replace("Group", "Sort")));
    expect(again).toMatchObject({ updated: true, skill: { version: "2.2.0" } });
  });

  test("progressive disclosure: names in the prompt, body via use_skill", async () => {
    const { skills, store } = setup();
    await skills.ensureBuiltins();
    await skills.create("default", { name: "tone", title: "Tone", description: "Use when writing to customers.", instructions: "SECRET BODY TEXT" });
    const prompt = await withWorkspaceContext("BASE", { skills, workspaceId: "default" });
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("- tone: Use when writing to customers.");
    expect(prompt).not.toContain("SECRET BODY TEXT");
    expect(skillsPromptBlock([])).toBe("");

    const tools = createToolRegistry();
    for (const tool of createSkillTools(skills)) tools.register(tool);
    const result = await tools.get("use_skill")!.run({ name: "tone" }, ctx(store));
    expect(result.content).toContain("SECRET BODY TEXT");
    const withFile = await tools.get("use_skill")!.run({ name: "status-update", file: "template.md" }, ctx(store));
    expect(withFile.content).toContain("Since last update");
    expect((await tools.get("use_skill")!.run({ name: "nope" }, ctx(store))).isError).toBe(true);
    // Switched off: gone from the prompt when the tool is disabled.
    tools.setEnabled("use_skill", false);
    expect(await withWorkspaceContext("BASE", { skills, tools, workspaceId: "default" })).toBe("BASE");
  });

  test("an agent with limited skills only sees and loads its own; no principal is refused", async () => {
    const { skills, store } = setup();
    const tone = await skills.create("default", { name: "tone", title: "Tone", description: "Use when writing to customers.", instructions: "TONE BODY" });
    await skills.create("default", { name: "pricing", title: "Pricing", description: "Use for price quotes.", instructions: "PRICING BODY" });
    const scope = { id: "agent-1", knowledgeBaseIds: [], skillIds: [tone.id] };
    const prompt = await withWorkspaceContext("BASE", { skills, workspaceId: "default", agent: scope });
    expect(prompt).toContain("- tone:");
    expect(prompt).not.toContain("pricing");

    const useSkill = createSkillTools(skills)[0]!;
    expect((await useSkill.run({ name: "tone" }, { ...ctx(store), agent: scope })).content).toContain("TONE BODY");
    const refused = await useSkill.run({ name: "pricing" }, { ...ctx(store), agent: scope });
    expect(refused.isError).toBe(true);
    expect(refused.content).not.toContain("PRICING BODY");
    expect(refused.content).not.toContain("pricing,");
    const { principal: _none, ...anonymous } = ctx(store);
    expect(await useSkill.run({ name: "tone" }, anonymous)).toMatchObject({ isError: true, content: expect.stringMatching(/signed-in person/) });
  });

  test("the prompt list is capped", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `s${index}`, ownerId: "o", name: `skill-${index}`, title: "t", description: "d".repeat(300), instructions: "i", source: "user" as const, enabled: true, createdAt: 0, updatedAt: 0
    }));
    const block = skillsPromptBlock(many);
    expect(block.length).toBeLessThanOrEqual(2_000);
    expect(block.split("\n- ").length - 1).toBeLessThanOrEqual(25);
  });

  test("input parser is strict", () => {
    expect(parseSkillInput({ name: "Bad Name", title: "t", description: "d", instructions: "i" }).success).toBe(false);
    expect(parseSkillInput({ name: "ok", title: "t", description: "d", instructions: "i", extra: true }).success).toBe(false);
    expect(parseSkillInput({ title: "t" }, true)).toEqual({ success: true, data: { title: "t" } });
    expect(parseSkillInput({ name: "ok", title: "t", description: "d", instructions: "i", files: [{ name: "../x", content: "" }] }).success).toBe(false);
  });
});
