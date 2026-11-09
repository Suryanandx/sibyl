/**
 * End to end through the gateway: the /api/knowledge, /api/skills and
 * /api/plugins routes behind the authorize() gate, and the brain prompt
 * gaining the skills list and "Relevant knowledge".
 */
import type { ToolChatProvider } from "@open-gpt-live/adapters";
import { createToolRegistry, type ToolRegistry } from "@open-gpt-live/core";
import { WS_EVENTS, type ServerMessage } from "@open-gpt-live/protocol";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer } from "../gateway.js";
import { createNoopMeter, createTestRuntime } from "../runtime.js";
import { createKnowledgeTools, KnowledgeService } from "../knowledge/index.js";
import { createSkillTools, SkillsService } from "../skills/index.js";
import { PluginService } from "./service.js";

function runtimeWithFeatures(tools: ToolRegistry = createToolRegistry()) {
  const base = createTestRuntime({ tools });
  const knowledge = new KnowledgeService({ store: base.store, ownerId: base.ownerId, meter: createNoopMeter() });
  const skills = new SkillsService({ store: base.store, ownerId: base.ownerId });
  const plugins = new PluginService({ store: base.store, ownerId: base.ownerId, skills, knowledge, env: {} });
  for (const tool of [...createKnowledgeTools(knowledge), ...createSkillTools(skills)]) tools.register(tool);
  return { ...base, knowledge, skills, plugins };
}

test("knowledge, skills and plugins HTTP APIs", async () => {
  const runtime = runtimeWithFeatures();
  const gateway = await createGatewayServer({
    providers: { llm: { async *streamText() {} }, stt: { async transcribe() { return { text: "" }; } } },
    host: "127.0.0.1",
    env: {},
    ownerToken: "s3cret",
    runtime
  });
  const base = `http://127.0.0.1:${gateway.port}`;
  const auth = { Authorization: "Bearer s3cret", "Content-Type": "application/json" };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) => {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  try {
    expect((await call("GET", "/api/knowledge", undefined, {})).status).toBe(401);

    const created = await call("POST", "/api/knowledge", { name: "Policies" });
    expect(created.status).toBe(201);
    const kb = created.body.base.id as string;
    const doc = await call("POST", `/api/knowledge/${kb}/docs`, { kind: "text", title: "Expenses", text: "Meals are reimbursed up to 30 euros per day." });
    expect(doc.status).toBe(201);
    expect((await call("POST", `/api/knowledge/${kb}/docs`, { kind: "text", text: "no title" })).status).toBe(400);
    await runtime.knowledge.idle();
    expect((await call("GET", `/api/knowledge/${kb}`)).body.docs[0].status).toBe("ready");
    const search = await call("GET", `/api/knowledge/search?q=${encodeURIComponent("meals reimbursed")}`);
    expect(search.body.hits[0]).toMatchObject({ docTitle: "Expenses", baseName: "Policies" });
    // Another workspace sees nothing.
    expect((await call("GET", `/api/knowledge/${kb}`, undefined, { ...auth, "x-sibyl-workspace": "sales" })).status).toBe(404);
    expect((await call("PUT", "/api/knowledge/settings", { autoBaseIds: [kb] })).body.autoBaseIds).toEqual([kb]);

    const imported = await fetch(`${base}/api/skills/import`, {
      method: "POST",
      headers: { Authorization: "Bearer s3cret", "Content-Type": "text/markdown", "X-Filename": "SKILL.md" },
      body: "---\nname: expense-check\ndescription: Use when checking an expense claim against policy.\n---\n\nCompare each line with the policy."
    });
    expect(imported.status).toBe(201);
    const skillId = ((await imported.json()) as { skill: { id: string } }).skill.id;
    const exported = await fetch(`${base}/api/skills/${skillId}/export`, { headers: auth });
    expect(exported.headers.get("content-disposition")).toContain("SKILL.md");
    expect(await exported.text()).toContain("name: expense-check");

    const list = await call("GET", "/api/plugins");
    expect(list.body.catalog.map((entry: { ref: string }) => entry.ref)).toContain("github");
    const preview = await call("POST", "/api/plugins/preview", { source: { kind: "catalog", ref: "meeting-notes-kit" } });
    expect(preview.body.summary.skills).toHaveLength(2);
    const installed = await call("POST", "/api/plugins/install", { source: { kind: "catalog", ref: "meeting-notes-kit" } });
    expect(installed.status).toBe(201);
    expect((await call("POST", "/api/plugins/install", { source: { kind: "url", ref: "http://10.0.0.1/x.json" } })).status).toBe(422);
    // A routine added from the plugin runs as whoever added it (here: the owner token).
    const added = await call("POST", "/api/plugins/meeting-notes-kit/routines", { index: 0 });
    expect(added.status).toBe(201);
    const routine = await runtime.store.routines.get(runtime.ownerId, added.body.plugin.routines[0].routineId);
    expect(routine).toMatchObject({ createdBy: "token", workspaceId: "default" });
    expect((await call("DELETE", "/api/plugins/meeting-notes-kit")).status).toBe(200);
  } finally {
    await gateway.close();
  }
});

test("typed chat gets the skills list and relevant knowledge in its system prompt", async () => {
  const runtime = runtimeWithFeatures();
  await runtime.skills.create("default", { name: "expense-check", title: "Expense check", description: "Use when checking an expense claim.", instructions: "BODY ONLY VIA TOOL" });
  const kb = await runtime.knowledge.createBase("default", { name: "Policies" });
  await runtime.knowledge.addDoc("default", kb.id, { kind: "text", title: "Expenses", text: "Meals are reimbursed up to 30 euros per day." });
  await runtime.knowledge.idle();
  await runtime.knowledge.setAutoBaseIds("default", [kb.id]);

  const prompts: string[] = [];
  const toolLlm: ToolChatProvider = {
    async *streamWithTools(messages) {
      prompts.push(String((messages[0] as { content: string }).content));
      yield { type: "text", delta: "ok" };
    }
  };
  const gateway = await createGatewayServer({
    providers: { llm: { async *streamText() {} }, stt: { async transcribe() { return { text: "" }; } }, toolLlm },
    host: "127.0.0.1",
    systemPrompt: "SYSTEM",
    modelCatalog: { voice: [{ id: "voice/fast", label: "Fast" }], llm: [{ id: "brain/deep", label: "Deep" }], stt: [{ id: "stt/x", label: "STT" }], tts: [{ id: "tts/x", label: "TTS", voices: ["a"] }] },
    env: { SIBYL_MEMORY: "false" },
    runtime
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise((resolve) => socket.once("open", resolve));
  try {
    socket.send(JSON.stringify({ type: WS_EVENTS.USER_TEXT, requestId: "t1", text: "How much can I claim for meals?" }));
    for (let i = 0; i < 300 && !messages.some((m) => m.type === WS_EVENTS.LLM_DONE); i += 1) await new Promise((r) => setTimeout(r, 10));
    const prompt = prompts[0]!;
    expect(prompt.startsWith("SYSTEM")).toBe(true);
    expect(prompt).toContain("- expense-check: Use when checking an expense claim.");
    expect(prompt).not.toContain("BODY ONLY VIA TOOL");
    expect(prompt).toContain("## Relevant knowledge");
    expect(prompt).toContain("[Expenses]");
  } finally {
    socket.close();
    await gateway.close();
  }
});
