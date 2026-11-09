import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createMemoryStore, createToolRegistry, ownerPrincipal, type Principal, type ToolContext, type UsageMeter } from "@open-gpt-live/core";
import { createSqliteStore } from "@open-gpt-live/store";
import { parseKnowledgeDocInput } from "@open-gpt-live/protocol";
import { createNoopMeter } from "../runtime.js";
import { UploadService } from "../uploads/service.js";
import { protectedRoutePermission } from "../identity/http.js";
import { chunkText } from "./chunk.js";
import { EmbeddingsClient } from "./embeddings.js";
import { KnowledgeService } from "./service.js";
import { createKnowledgeTools } from "./tools.js";

const PUBLIC_HOST = async () => [{ address: "93.184.216.34", family: 4 }];

function service(options: { store?: ReturnType<typeof createMemoryStore>; meter?: UsageMeter; embeddings?: EmbeddingsClient; fetch?: (url: string) => Promise<Response> } = {}) {
  const store = options.store ?? createMemoryStore();
  const dir = mkdtempSync(join(tmpdir(), "sibyl-kb-"));
  const uploads = new UploadService({ store, ownerId: "owner", dir, maxBytes: 1024 * 1024 });
  const knowledge = new KnowledgeService({
    store,
    ownerId: "owner",
    meter: options.meter ?? createNoopMeter(),
    uploads,
    ...(options.embeddings ? { embeddings: options.embeddings } : {}),
    web: { fetch: (input) => (options.fetch ?? (async () => new Response("nope", { status: 404 })))(String(input)), resolveHost: PUBLIC_HOST }
  });
  return { store, uploads, knowledge };
}

function context(store: ReturnType<typeof createMemoryStore>, overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, ownerId: "owner", runId: "r1", principal: ownerPrincipal("owner", "local"), store, meter: createNoopMeter(), log: () => undefined, ...overrides };
}

describe("chunking", () => {
  test("keeps headings and page labels, overlaps, and caps size", () => {
    const page = (n: number) => `--- Page ${n} ---\n# Section ${n}\n\n${"Refunds are processed within fourteen days of the request. ".repeat(80)}`;
    const chunks = chunkText([page(1), page(2)].join("\n\n"), { maxTokens: 200, overlapTokens: 40 });
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks[0]!.label).toBe("Page 1 · Section 1");
    expect(chunks.at(-1)!.label).toContain("Page 2");
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(820);
  });

  test("short text is one chunk; empty text none", () => {
    expect(chunkText("Hello world")).toEqual([{ text: "Hello world" }]);
    expect(chunkText("   \n\n ")).toEqual([]);
  });
});

describe("knowledge service", () => {
  test("pasted text is indexed in the background and searchable with citations", async () => {
    const { knowledge } = service();
    const base = await knowledge.createBase("default", { name: "Policies" });
    const doc = await knowledge.addDoc("default", base.id, { kind: "text", title: "Refund policy", text: "# Refunds\n\nCustomers may return items within 30 days for a full refund." });
    expect(doc.status).toBe("pending");
    await knowledge.idle();
    const detail = await knowledge.getBase("default", base.id);
    expect(detail.docs[0]).toMatchObject({ status: "ready", chunkCount: 1 });
    const result = await knowledge.search("default", "refund days");
    expect(result.mode).toBe("keyword");
    expect(result.hits[0]).toMatchObject({ docTitle: "Refund policy", baseName: "Policies", citation: "Refund policy › Refunds" });
  });

  test("bases are scoped to their workspace", async () => {
    const { knowledge } = service();
    const base = await knowledge.createBase("sales", { name: "Sales" });
    await expect(knowledge.getBase("default", base.id)).rejects.toThrow(/not found/);
    expect(await knowledge.listBases("default")).toEqual([]);
    expect((await knowledge.listBases("sales")).map((b) => b.name)).toEqual(["Sales"]);
  });

  test("uploads reuse the extracted text; images are refused", async () => {
    const { knowledge, uploads } = service();
    const base = await knowledge.createBase("default", { name: "Docs" });
    const upload = await uploads.save({ data: Buffer.from("# Handbook\n\nThe office opens at nine."), filename: "handbook.md" });
    await knowledge.addDoc("default", base.id, { kind: "upload", uploadId: upload.id });
    await knowledge.idle();
    expect((await knowledge.search("default", "office opens")).hits[0]?.docTitle).toBe("handbook.md");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
    const image = await uploads.save({ data: png, filename: "a.png" });
    await expect(knowledge.addDoc("default", base.id, { kind: "upload", uploadId: image.id })).rejects.toThrow(/Images/);
  });

  test("a file uploaded in another workspace can't be saved into this one", async () => {
    const { knowledge, uploads } = service();
    const base = await knowledge.createBase("default", { name: "Docs" });
    const elsewhere = await uploads.save({ data: Buffer.from("Secret plans"), filename: "plans.md", workspaceId: "sales" });
    await expect(knowledge.addDoc("default", base.id, { kind: "upload", uploadId: elsewhere.id })).rejects.toThrow(/not found/);
  });

  test("web pages go through read_webpage (SSRF guard) and failures are reported", async () => {
    const { knowledge } = service({
      fetch: async (url) =>
        url.includes("good")
          ? new Response("<html><head><title>Pricing</title></head><body><p>The pro plan costs 20 euros a month.</p></body></html>", { headers: { "content-type": "text/html" } })
          : new Response("missing", { status: 404 })
    });
    const base = await knowledge.createBase("default", { name: "Web" });
    await knowledge.addDoc("default", base.id, { kind: "url", url: "https://good.example.com/pricing" });
    await knowledge.addDoc("default", base.id, { kind: "url", url: "https://bad.example.com/" });
    await knowledge.addDoc("default", base.id, { kind: "url", url: "http://127.0.0.1/admin" });
    await knowledge.idle();
    const docs = (await knowledge.getBase("default", base.id)).docs;
    const byUrl = (part: string) => docs.find((d) => d.source.kind === "url" && d.source.url.includes(part))!;
    expect(byUrl("good")).toMatchObject({ status: "ready", title: "Pricing" });
    expect(byUrl("bad")).toMatchObject({ status: "failed" });
    expect(byUrl("127.0.0.1")).toMatchObject({ status: "failed" });
    const hit = (await knowledge.search("default", "pro plan cost")).hits[0]!;
    expect(hit.url).toBe("https://good.example.com/pricing");
  });

  test("automatic bases feed a capped prompt block (keyword only)", async () => {
    const { knowledge } = service();
    const base = await knowledge.createBase("default", { name: "Policies" });
    await knowledge.addDoc("default", base.id, { kind: "text", title: "Travel", text: "Economy class for flights under six hours. ".repeat(200) });
    await knowledge.idle();
    expect(await knowledge.promptBlock("default", "flights class")).toBe("");
    await knowledge.setAutoBaseIds("default", [base.id]);
    const block = await knowledge.promptBlock("default", "which class for flights?");
    expect(block).toContain("## Relevant knowledge");
    expect(block).toContain("[Travel]");
    expect(block.length).toBeLessThanOrEqual(1_900);
    await expect(knowledge.setAutoBaseIds("default", ["kb_other"])).rejects.toThrow(/Unknown/);
    await knowledge.removeBase("default", base.id);
    expect(await knowledge.autoBaseIds("default")).toEqual([]);
  });

  test("the auto setting lives on the workspace record when there is one", async () => {
    const { knowledge, store } = service();
    await store.workspaces.upsert({ id: "team", ownerId: "owner", name: "Team", createdAt: 1, updatedAt: 1 });
    const base = await knowledge.createBase("team", { name: "Team KB" });
    await knowledge.setAutoBaseIds("team", [base.id]);
    expect((await store.workspaces.get("owner", "team"))?.knowledgeBaseIds).toEqual([base.id]);
  });

  test("works with the SQLite store (FTS5) and survives a restart mid-index", async () => {
    const store = createSqliteStore({ file: ":memory:" });
    const { knowledge } = service({ store: store as ReturnType<typeof createMemoryStore> });
    const base = await knowledge.createBase("default", { name: "Notes" });
    await knowledge.addDoc("default", base.id, { kind: "text", title: "Onboarding", text: "New starters get a laptop on their first day." });
    await knowledge.idle();
    expect((await knowledge.search("default", "laptop")).hits[0]?.docTitle).toBe("Onboarding");
    // A text doc left pending by a restart can't be recovered.
    await store.knowledge.upsertDoc({ id: "kd_x", ownerId: "owner", knowledgeBaseId: base.id, title: "Lost", source: { kind: "text" }, status: "pending", chunkCount: 0, createdAt: 1, updatedAt: 1 });
    const fresh = service({ store: store as ReturnType<typeof createMemoryStore> }).knowledge;
    await fresh.resume();
    expect((await store.knowledge.getDoc("owner", "kd_x"))?.status).toBe("failed");
    await store.close();
  });

  test("hybrid search with embeddings is metered", async () => {
    const recorded: Array<{ costUsd: number; feature: string }> = [];
    const meter: UsageMeter = { ...createNoopMeter(), record: (event) => void recorded.push(event) };
    const vectorFor = (text: string) => (/(cat|kitten|feline)/i.test(text) ? [1, 0] : [0, 1]);
    const embeddings = new EmbeddingsClient({
      model: "test/embed",
      baseUrl: "https://example.invalid/api/v1",
      usdPerMillionTokens: 0.02,
      meter,
      ownerId: "owner",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { input: string[] };
        return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })), usage: { prompt_tokens: 10, cost: 0.000001 } }));
      }
    });
    const { knowledge } = service({ meter, embeddings });
    const base = await knowledge.createBase("default", { name: "Pets" });
    await knowledge.addDoc("default", base.id, { kind: "text", title: "Cats", text: "A kitten needs vaccinations at eight weeks." });
    await knowledge.addDoc("default", base.id, { kind: "text", title: "Cars", text: "Change the oil every ten thousand kilometres." });
    await knowledge.idle();
    const result = await knowledge.search("default", "feline");
    expect(result.mode).toBe("hybrid");
    expect(result.hits[0]?.docTitle).toBe("Cats");
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    expect(recorded.every((event) => event.feature === "tool" && event.costUsd === 0.000001)).toBe(true);
  });
});

describe("knowledge tools", () => {
  test("search_knowledge and list_knowledge respect the workspace and permissions", async () => {
    const { knowledge, store } = service();
    const base = await knowledge.createBase("default", { name: "Policies" });
    await knowledge.addDoc("default", base.id, { kind: "text", title: "Leave", text: "Employees get 25 days of annual leave." });
    await knowledge.idle();
    const tools = createToolRegistry();
    for (const tool of createKnowledgeTools(knowledge)) tools.register(tool);
    const search = tools.get("search_knowledge")!;
    const ok = await search.run({ query: "annual leave" }, context(store));
    expect(ok.content).toContain("[1] Leave");
    const other = await search.run({ query: "annual leave" }, context(store, { workspaceId: "sales" }));
    expect(other.content).toMatch(/Nothing/);
    const stranger: Principal = { kind: "user", orgId: "owner", userId: "u2", orgRole: "member", workspaceRoles: {} };
    expect((await search.run({ query: "leave" }, context(store, { principal: stranger }))).isError).toBe(true);
    const list = await tools.get("list_knowledge")!.run({}, context(store, { principal: ownerPrincipal("owner", "local") }));
    expect(list.content).toContain("Policies");
    expect(tools.get("save_to_knowledge")!.effect).toBe("write");
  });

  test("without a principal every knowledge tool refuses (fail closed)", async () => {
    const { knowledge, store } = service();
    const base = await knowledge.createBase("default", { name: "Policies" });
    await knowledge.addDoc("default", base.id, { kind: "text", title: "Leave", text: "Employees get 25 days of annual leave." });
    await knowledge.idle();
    const { principal: _none, ...anonymous } = context(store);
    for (const tool of createKnowledgeTools(knowledge)) {
      const result = await tool.run({ query: "annual leave", uploadId: `up_${"a".repeat(24)}` }, anonymous);
      expect(result.isError, tool.name).toBe(true);
      expect(result.content).toMatch(/signed-in person/);
    }
  });

  test("an agent limited to knowledge base A can't list, search or save to base B", async () => {
    const { knowledge, store } = service();
    const a = await knowledge.createBase("default", { name: "Handbook" });
    const b = await knowledge.createBase("default", { name: "Payroll" });
    await knowledge.addDoc("default", a.id, { kind: "text", title: "Leave", text: "Employees get 25 days of annual leave." });
    await knowledge.addDoc("default", b.id, { kind: "text", title: "Salaries", text: "Annual leave payouts and salaries for every employee." });
    await knowledge.idle();
    const tools = Object.fromEntries(createKnowledgeTools(knowledge).map((tool) => [tool.name, tool]));
    const agent = context(store, { agent: { id: "agent-1", knowledgeBaseIds: [a.id], skillIds: [] } });

    // Unscoped, both bases match.
    const all = await tools.search_knowledge!.run({ query: "annual leave" }, context(store));
    expect(all.content).toContain("Salaries");
    // As the agent: only base A, even when it asks for B.
    const own = await tools.search_knowledge!.run({ query: "annual leave" }, agent);
    expect(own.content).toContain("Leave");
    expect(own.content).not.toContain("Salaries");
    const other = await tools.search_knowledge!.run({ query: "annual leave", knowledgeBaseIds: [b.id] }, agent);
    expect(other).toMatchObject({ isError: true, content: expect.stringContaining(b.id) });
    const listed = await tools.list_knowledge!.run({}, agent);
    expect(listed.content).toContain("Handbook");
    expect(listed.content).not.toContain("Payroll");
    const save = await tools.save_to_knowledge!.run({ uploadId: `up_${"a".repeat(24)}`, knowledgeBaseId: b.id }, agent);
    expect(save).toMatchObject({ isError: true, content: expect.stringMatching(/your own knowledge bases/) });
    // The "Relevant knowledge" prompt block stays within the agent's bases too.
    await knowledge.setAutoBaseIds("default", [a.id, b.id]);
    expect(await knowledge.promptBlock("default", "annual leave")).toContain("Salaries");
    const scoped = await knowledge.promptBlock("default", "annual leave", [a.id]);
    expect(scoped).toContain("Leave");
    expect(scoped).not.toContain("Salaries");
    // An agent with no bases finds nothing.
    const none = await tools.search_knowledge!.run({ query: "annual leave" }, context(store, { agent: { id: "agent-2", knowledgeBaseIds: [] } }));
    expect(none.content).toMatch(/no knowledge bases/);
  });

  test("request bodies are parsed strictly", () => {
    expect(parseKnowledgeDocInput({ kind: "text", title: "x", text: "y" }).success).toBe(true);
    expect(parseKnowledgeDocInput({ kind: "text", text: "y" }).success).toBe(false);
    expect(parseKnowledgeDocInput({ kind: "url", url: "file:///etc/passwd" }).success).toBe(false);
    expect(parseKnowledgeDocInput({ kind: "upload", uploadId: "../x" }).success).toBe(false);
    expect(parseKnowledgeDocInput({ kind: "url", url: "https://a.b", extra: 1 }).success).toBe(false);
  });

  test("routes map to the knowledge / skills / plugins permissions", () => {
    expect(protectedRoutePermission("GET", "/api/knowledge/search")?.permission).toBe("knowledge.view");
    expect(protectedRoutePermission("POST", "/api/knowledge")?.permission).toBe("knowledge.manage");
    expect(protectedRoutePermission("DELETE", "/api/knowledge/kb_1")?.permission).toBe("knowledge.manage");
    expect(protectedRoutePermission("POST", "/api/knowledge/kb_1/docs")?.permission).toBe("knowledge.edit");
    expect(protectedRoutePermission("POST", "/api/knowledge/save-upload")?.permission).toBe("knowledge.edit");
    expect(protectedRoutePermission("PUT", "/api/knowledge/settings")?.permission).toBe("workspace.settings");
    expect(protectedRoutePermission("GET", "/api/skills")?.permission).toBe("skills.use");
    expect(protectedRoutePermission("POST", "/api/skills/import")?.permission).toBe("skills.edit");
    expect(protectedRoutePermission("POST", "/api/plugins/install")?.permission).toBe("plugins.install");
    expect(protectedRoutePermission("POST", "/api/plugins/github/routines")?.permission).toBe("routines.manage");
  });
});
