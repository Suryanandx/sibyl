import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LLMProvider, STTProvider, ToolChatEvent, ToolChatProvider } from "@open-gpt-live/adapters";
import { createMemoryStore, createToolRegistry, type ToolContext, type ToolDefinition, type UsageEvent, type UsageMeter } from "@open-gpt-live/core";
import { WS_EVENTS, type ServerMessage } from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer } from "../gateway.js";
import { createNoopMeter, createTestRuntime, type GatewayRuntime } from "../runtime.js";
import { SlidesEngineError, createSlidesClient } from "./client.js";
import { createFakeEngine } from "./fake-engine.js";
import { routeSlidesRequest, type SlidesHttpDeps } from "./http.js";
import { installSlides } from "./index.js";
import { SlidesService } from "./service.js";
import { createSlidesTools, takeSlidesArtifact } from "./tools.js";

function meterWith(usage: Array<Omit<UsageEvent, "id" | "at">>, overrides: Partial<UsageMeter> = {}): UsageMeter {
  return { ...createNoopMeter(), record: (event) => void usage.push(event), ...overrides };
}

function setup(overrides: { meter?: UsageMeter } = {}) {
  const engine = createFakeEngine({ token: "owner-secret" });
  const store = createMemoryStore();
  const usage: Array<Omit<UsageEvent, "id" | "at">> = [];
  const meter = overrides.meter ?? meterWith(usage);
  let id = 0;
  const service = new SlidesService({ client: engine.client, store, meter, model: "slides/model", usdPerSlide: 0.005, createId: () => `id-${++id}` });
  return { engine, store, usage, meter, service };
}

function context(store: ToolContext["store"], meter: UsageMeter, runId = "run-1"): ToolContext {
  return { signal: new AbortController().signal, ownerId: "owner", conversationId: "conv-1", runId, store, meter, log: () => {} };
}

/* ───────────── client ───────────── */

test("client sends the documented generate payload with the owner token", async () => {
  const engine = createFakeEngine({ token: "tok" });
  const deck = await engine.client.generate({ content: "Hello", nSlides: 5, template: "modern", instructions: "Be brief" });
  assert.deepEqual(deck, { presentationId: "pres-1", path: "/app_data/pres-1/Deck.pptx", editPath: "/presentation?id=pres-1" });
  const call = engine.calls[0]!;
  assert.equal(call.url, "/api/v1/ppt/presentation/generate");
  assert.equal(call.auth, "Bearer tok");
  assert.deepEqual(call.body, { content: "Hello", language: "English", export_as: "pptx", n_slides: 5, template: "modern", instructions: "Be brief" });

  const details = await engine.client.get("pres-1");
  assert.equal(details.slideCount, 3);
  assert.deepEqual(await engine.client.export("pres-1", "pdf"), { path: "/app_data/pres-1/Deck.pdf" });
  assert.deepEqual((await engine.client.templates()).map((t) => t.id), ["general", "modern"]);
  const file = await engine.client.download("/app_data/pres-1/Deck.pdf");
  assert.equal(await file.text(), "FILE /app_data/pres-1/Deck.pdf");
  await assert.rejects(engine.client.download("http://evil.test/x"), /outside Sibyl Slides/);
});

test("client turns failures into friendly errors", async () => {
  const engine = createFakeEngine();
  engine.failNext = 500;
  await assert.rejects(engine.client.generate({ content: "x" }), (error: unknown) => {
    assert.ok(error instanceof SlidesEngineError);
    assert.equal(error.status, 500);
    assert.match(error.message, /Sibyl Slides hit an error \(500\): engine broke/);
    return true;
  });
  const down = createSlidesClient({ baseUrl: "http://down.test", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
  await assert.rejects(down.generate({ content: "x" }), /not reachable at http:\/\/down.test/);
  const slow = createSlidesClient({
    baseUrl: "http://slow.test",
    generateTimeoutMs: 20,
    fetch: ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch
  });
  await assert.rejects(slow.generate({ content: "x" }), /did not answer within/);
  const controller = new AbortController();
  const pending = slow.templates(controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

/* ───────────── service + tools ───────────── */

test("create_slides saves a versioned artifact, meters it, and revise_slides chains a new version", async () => {
  const { store, usage, meter, service, engine } = setup();
  const tools = createSlidesTools(service);
  const create = tools.find((t) => t.name === "create_slides")! as ToolDefinition & { describeCall(input: unknown): string };
  const revise = tools.find((t) => t.name === "revise_slides")!;
  assert.equal(create.effect, "write");
  assert.equal(revise.effect, "write");
  assert.equal(tools.find((t) => t.name === "list_slides")!.effect, "read");
  assert.equal(create.describeCall({ title: "Q3 market overview", n_slides: 8 }), "Create an 8-slide deck 'Q3 market overview' (≈$0.04)");

  const result = await create.run({ title: "Q3 market overview", content: "## Slide 1\n- Revenue $4.2B", n_slides: 8, space: "Board" }, context(store, meter));
  assert.ok(!result.isError, result.content);
  const view = result.data as { id: string; version: number; editUrl: string; downloads: { pptx: string } };
  assert.equal(view.version, 1);
  assert.equal(view.editUrl, "/slides/presentation?id=pres-1");
  assert.equal(view.downloads.pptx, `/api/slides/decks/${view.id}/download?format=pptx`);
  assert.equal(takeSlidesArtifact("run-1", "create_slides")?.id, view.id);
  assert.equal(takeSlidesArtifact("run-1", "create_slides"), undefined);

  const saved = (await store.artifacts.get("owner", view.id))!;
  assert.equal(saved.kind, "slides");
  assert.equal(saved.conversationId, "conv-1");
  const space = (await store.spaces.list("owner")).find((s) => s.id === saved.spaceId)!;
  assert.equal(space.name, "Board");
  assert.equal(saved.meta.presentationId, "pres-1");
  assert.deepEqual(saved.meta.exports, { pptx: "/app_data/pres-1/Deck.pptx" });
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.feature, "slides");
  assert.equal(usage[0]!.model, "slides/model");
  assert.ok(Math.abs(usage[0]!.costUsd - 0.04) < 1e-9);
  assert.equal(usage[0]!.estimated, true);
  // The engine got the title and the real figures.
  assert.match(String((engine.calls[0]!.body as { content: string }).content), /# Q3 market overview[\s\S]*Revenue \$4\.2B/);

  const revised = await revise.run({ deck_id: view.id, instructions: "Add a slide on risks" }, context(store, meter, "run-2"));
  assert.ok(!revised.isError, revised.content);
  const v2 = revised.data as { id: string; version: number; parentId: string; spaceId: string };
  assert.equal(v2.version, 2);
  assert.equal(v2.parentId, view.id);
  assert.equal(v2.spaceId, saved.spaceId);
  const reviseBody = engine.calls.filter((c) => c.url.endsWith("/generate"))[1]!.body as { content: string; n_slides: number };
  assert.match(reviseBody.content, /Revenue \$4\.2B[\s\S]*Add a slide on risks/);
  assert.equal(reviseBody.n_slides, 3, "keeps the slide count the engine reported");

  const listed = await tools.find((t) => t.name === "list_slides")!.run({}, context(store, meter));
  assert.match(listed.content, /Q3 market overview — v2/);
  assert.match(listed.content, /Q3 market overview — v1/);
});

test("budget caps block a deck before the engine is called", async () => {
  const blocked: UsageMeter = {
    ...createNoopMeter(),
    check: () => ({ allowed: false, scope: "daily", message: "Today's budget is used up ($2.00 of $2.00)." })
  };
  const { store, service, engine } = setup({ meter: blocked });
  const create = createSlidesTools(service).find((t) => t.name === "create_slides")!;
  const result = await create.run({ title: "T", content: "C" }, context(store, blocked));
  assert.equal(result.isError, true);
  assert.match(result.content, /Can't build the deck: Today's budget is used up/);
  assert.equal(engine.calls.length, 0);
});

test("installSlides registers tools only when the engine is configured or reachable", async () => {
  const registry = createToolRegistry();
  const off = await installSlides({ tools: registry, store: createMemoryStore(), meter: createNoopMeter(), env: { SIBYL_SLIDES: "false" }, log: () => {} });
  assert.equal(off, undefined);
  const engine = createFakeEngine();
  const on = await installSlides({ tools: registry, store: createMemoryStore(), meter: createNoopMeter(), env: {}, log: () => {}, client: engine.client });
  assert.ok(on);
  assert.deepEqual(registry.list({ source: "slides" }).map((t) => t.name), ["create_slides", "revise_slides", "list_slides"]);
});

test("the engine is the source of truth for the deck model, its price and the actual cost", async () => {
  const registry = createToolRegistry();
  const usage: Array<Omit<UsageEvent, "id" | "at">> = [];
  const store = createMemoryStore();
  const engine = createFakeEngine();
  // $0.25 / $0.75 per million tokens, reported by the engine.
  engine.config = { model: "deepseek/deepseek-v4.1-flash", pricing: { prompt: 0.25e-6, completion: 0.75e-6 } };
  const service = (await installSlides({
    tools: registry,
    store,
    meter: meterWith(usage),
    env: { SIBYL_SLIDES_MODEL: "something/else" },
    log: () => {},
    client: engine.client
  }))!;
  assert.equal(service.model, "deepseek/deepseek-v4.1-flash", "the engine's model wins over gateway settings");
  // 5 slides: (10000 + 25000*5) prompt + (3000 + 4000*5) completion tokens.
  const priced = 135_000 * 0.25e-6 + 23_000 * 0.75e-6;
  assert.ok(Math.abs(service.estimateUsd(5) - priced) < 1e-12);
  const create = registry.list({ source: "slides" }).find((t) => t.name === "create_slides")!;
  const { summarizeApproval } = await import("../brain/approvals.js");
  assert.equal(summarizeApproval(create, { title: "Q3", n_slides: 5, content: "x" }), "Create a 5-slide deck 'Q3' (≈$0.05)");

  engine.costUsd = 0.0213;
  const result = await create.run({ title: "Q3", content: "Facts", n_slides: 5 }, context(store, meterWith(usage)));
  assert.ok(!result.isError, result.content);
  assert.equal(usage.at(-1)!.costUsd, 0.0213);
  assert.equal(usage.at(-1)!.estimated, false);
  assert.equal(usage.at(-1)!.model, "deepseek/deepseek-v4.1-flash");
  const saved = (await store.artifacts.list("owner", { kind: "slides" }))[0]!;
  assert.equal(saved.meta.costUsd, 0.0213);
  assert.equal(saved.meta.costEstimated, undefined);
  // Later estimates follow what builds actually cost per slide.
  assert.ok(Math.abs(service.estimateUsd(10) - 0.0426) < 1e-9);

  // An engine without cost accounting: the estimate is recorded, marked as such.
  const older = createFakeEngine();
  const olderUsage: Array<Omit<UsageEvent, "id" | "at">> = [];
  const fallback = new SlidesService({ client: older.client, store, meter: meterWith(olderUsage), model: "m", usdPerSlide: 0.004 });
  await fallback.refreshEngineConfig();
  assert.equal(fallback.model, "m");
  await fallback.create({ ownerId: "owner", title: "T", content: "C", nSlides: 5 });
  assert.equal(olderUsage[0]!.costUsd, 0.02);
  assert.equal(olderUsage[0]!.estimated, true);
});

/* ───────────── approvals through the gateway ───────────── */

test("create_slides waits for approval and TOOL_FINISHED carries the deck artifact", async () => {
  const { service } = setup();
  const runtime = createTestRuntime({ slides: service });
  for (const tool of createSlidesTools(service)) runtime.tools.register(tool);
  let round = 0;
  const toolLlm: ToolChatProvider = {
    async *streamWithTools(): AsyncIterable<ToolChatEvent> {
      round += 1;
      if (round === 1) {
        yield { type: "tool_calls", calls: [{ id: "c1", name: "create_slides", arguments: JSON.stringify({ title: "Deck", content: "Facts", n_slides: 4 }) }] };
      } else yield { type: "text", delta: "Done." };
    }
  };
  const llm: LLMProvider = {
    async *streamText(_m, options) {
      if (options?.model === "voice/fast") yield { delta: "On it.\n@brain make a deck" };
      else yield { delta: "plain" };
    }
  };
  const stt: STTProvider = { transcribe: async () => ({ text: "deck" }) };
  const gateway = await createGatewayServer({
    providers: { llm, stt, toolLlm },
    host: "127.0.0.1",
    modelCatalog: { voice: [{ id: "voice/fast", label: "V" }], llm: [{ id: "brain/deep", label: "D" }], stt: [{ id: "s", label: "S" }], tts: [] },
    live: { voicePrompt: "VOICE", brainPrompt: () => "BRAIN" },
    runtime
  });
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  const waitFor = async (p: (m: ServerMessage) => boolean, ms = 4000): Promise<ServerMessage> => {
    const start = Date.now();
    for (;;) {
      const found = messages.find(p);
      if (found) return found;
      if (Date.now() - start > ms) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await new Promise((r) => socket.once("open", r));
  try {
    await waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    socket.send(JSON.stringify({ type: WS_EVENTS.VAD_SPEECH_START, requestId: "u-1", turnMode: "live", startedAt: 1 }));
    socket.send(JSON.stringify({ type: WS_EVENTS.AUDIO_CHUNK, requestId: "u-1", chunk: Buffer.alloc(4800).toString("base64"), mimeType: "audio/pcm;rate=24000", sequence: 0, turnMode: "live" }));
    socket.send(JSON.stringify({ type: WS_EVENTS.VAD_SPEECH_END, requestId: "u-1", endedAt: 2, reason: "silence", caption: "make a deck" }));
    const request = (await waitFor((m) => m.type === WS_EVENTS.APPROVAL_REQUEST)) as unknown as { approval: { id: string; toolName: string } };
    assert.equal(request.approval.toolName, "create_slides");
    assert.equal((await runtime.store.artifacts.list("owner")).length, 0, "nothing is built before approval");
    socket.send(JSON.stringify({ type: WS_EVENTS.APPROVAL_DECISION, id: request.approval.id, decision: "approve" }));
    const finished = (await waitFor((m) => m.type === WS_EVENTS.TOOL_FINISHED)) as unknown as {
      status: string;
      artifact?: { kind: string; title: string; version: number; editUrl: string };
    };
    assert.equal(finished.status, "ok");
    assert.equal(finished.artifact?.kind, "slides");
    assert.equal(finished.artifact?.title, "Deck");
    assert.equal(finished.artifact?.version, 1);
    assert.match(finished.artifact!.editUrl, /^\/slides\/presentation\?id=/);
  } finally {
    socket.close();
    await gateway.close();
  }
});

/* ───────────── HTTP API ───────────── */

async function withApi(
  deps: Partial<SlidesHttpDeps> & { runtime: GatewayRuntime },
  run: (base: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    if (!routeSlidesRequest(req, res, deps)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

/** The real gateway (identity gate in front of /api/slides) with a slides service. */
async function withGateway(
  options: { ownerToken?: string; allowedOrigins?: string[] },
  run: (base: string, env: ReturnType<typeof setup>) => Promise<void>
): Promise<void> {
  const env = setup();
  const runtime = createTestRuntime({ slides: env.service, store: env.store });
  const llm: LLMProvider = { async *streamText() { yield { delta: "x" }; } };
  const stt: STTProvider = { transcribe: async () => ({ text: "" }) };
  const gateway = await createGatewayServer({ providers: { llm, stt }, host: "127.0.0.1", runtime, env: {}, ...options });
  try {
    await run(`http://127.0.0.1:${gateway.port}`, env);
  } finally {
    await gateway.close();
  }
}

test("HTTP API goes through the identity gate: owner token and allowed origins", async () => {
  await withGateway({ ownerToken: "secret", allowedOrigins: ["https://sibyl.test"] }, async (base) => {
    assert.equal((await fetch(`${base}/api/slides/spaces`)).status, 401);
    assert.equal((await fetch(`${base}/api/slides/spaces`, { headers: { authorization: "Bearer nope" } })).status, 401);
    const ok = await fetch(`${base}/api/slides/spaces`, { headers: { authorization: "Bearer secret", origin: "https://sibyl.test" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://sibyl.test");
    assert.equal(ok.headers.get("access-control-allow-credentials"), "true");
    assert.equal((await fetch(`${base}/api/slides/spaces?token=secret`)).status, 200);
    const evil = await fetch(`${base}/api/slides/spaces`, { headers: { authorization: "Bearer secret", origin: "https://evil.test" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(`${base}/api/slides/generate`, { method: "OPTIONS", headers: { origin: "https://sibyl.test" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
  });
});

test("slides need a session, and a viewer can browse decks but can't generate or change spaces", async () => {
  await withGateway({}, async (base) => {
    const call = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
      });
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      return { status: response.status, body: (await response.json().catch(() => null)) as any, cookie };
    };
    const password = "correct horse battery staple";
    const owner = await call("/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password } });
    assert.equal(owner.status, 201);
    // Accounts exist now: no session, no slides.
    assert.equal((await call("/api/slides/decks")).status, 401);
    assert.equal((await call("/api/slides/generate", { method: "POST", body: { prompt: "x" } })).status, 401);

    const invite = await call("/api/invites", { method: "POST", cookie: owner.cookie!, body: { workspaceId: "default", role: "viewer" } });
    const token = String(invite.body.url).split("/invite/")[1]!;
    const viewer = await call(`/api/invites/${token}/accept`, { method: "POST", body: { name: "Vic", email: "v@example.com", password } });
    assert.equal(viewer.status, 200);
    assert.equal((await call("/api/slides/decks", { cookie: viewer.cookie! })).status, 200);
    const generate = await call("/api/slides/generate", { method: "POST", cookie: viewer.cookie!, body: { prompt: "A deck" } });
    assert.equal(generate.status, 403);
    assert.equal(generate.body.permission, "slides.manage");
    assert.equal((await call("/api/slides/spaces", { method: "POST", cookie: viewer.cookie!, body: { name: "Mine" } })).status, 403);
    // The owner can.
    assert.equal((await call("/api/slides/spaces", { method: "POST", cookie: owner.cookie!, body: { name: "Board" } })).status, 201);
  });
});

test("a deck made in workspace A is invisible from workspace B", async () => {
  await withGateway({ ownerToken: "s" }, async (base, { service, store, meter }) => {
    const tools = createSlidesTools(service);
    const made = await tools[0]!.run({ title: "Alpha plan", content: "Facts", space: "Alpha space" }, { ...context(store, meter), workspaceId: "alpha" });
    const deckId = (made.data as { id: string }).id;
    assert.equal((await store.artifacts.get("owner", deckId))?.workspaceId, "alpha");
    const get = (path: string, workspace: string) => fetch(`${base}${path}`, { headers: { authorization: "Bearer s", "x-sibyl-workspace": workspace } });

    const inAlpha = (await (await get("/api/slides/decks", "alpha")).json()) as { decks: unknown[] };
    assert.equal(inAlpha.decks.length, 1);
    const inBeta = (await (await get("/api/slides/decks", "beta")).json()) as { decks: unknown[] };
    assert.equal(inBeta.decks.length, 0);
    const spacesBeta = (await (await get("/api/slides/spaces", "beta")).json()) as { spaces: unknown[]; unfiled: number };
    assert.deepEqual([spacesBeta.spaces.length, spacesBeta.unfiled], [0, 0]);
    assert.equal((await get(`/api/slides/decks/${deckId}/download?format=pptx`, "beta")).status, 404);
    assert.equal((await get(`/api/slides/decks/${deckId}/thumbnail`, "beta")).status, 404);
    assert.equal((await get(`/api/slides/decks/${deckId}/download?format=pptx`, "alpha")).status, 200);

    // The brain tools apply the same rule.
    const listed = await tools[2]!.run({}, { ...context(store, meter), workspaceId: "beta" });
    assert.equal(listed.content, "No slide decks yet.");
    const revised = await tools[1]!.run({ deck_id: deckId, instructions: "More" }, { ...context(store, meter), workspaceId: "beta" });
    assert.equal(revised.isError, true);
    // A space of A can't be renamed or removed from B.
    const alphaSpace = (await store.spaces.list("owner"))[0]!;
    const patch = await fetch(`${base}/api/slides/spaces/${alphaSpace.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer s", "x-sibyl-workspace": "beta", "content-type": "application/json" },
      body: JSON.stringify({ name: "Hijacked" })
    });
    assert.equal(patch.status, 404);
  });
});

test("HTTP API manages spaces, lists decks with versions and proxies downloads", async () => {
  const { service, meter, store } = setup();
  const runtime = createTestRuntime({ slides: service, store });
  const auth = { authorization: "Bearer s", "content-type": "application/json" };
  await withApi({ runtime }, async (base) => {
    const created = await fetch(`${base}/api/slides/spaces`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Sales", template: "modern", instructions: "For the board" }) });
    assert.equal(created.status, 201);
    const { space } = (await created.json()) as { space: { id: string; name: string; template: string } };
    assert.equal(space.template, "modern");
    const renamed = await fetch(`${base}/api/slides/spaces/${space.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "Sales team" }) });
    assert.equal(((await renamed.json()) as { space: { name: string } }).space.name, "Sales team");

    const tools = createSlidesTools(service);
    const v1 = await tools[0]!.run({ title: "Pipeline", content: "Facts", space: space.id }, context(store, meter));
    const v1Id = (v1.data as { id: string }).id;
    await tools[1]!.run({ deck_id: v1Id, instructions: "More charts" }, context(store, meter));
    // The space's template and instructions reach the engine.
    const decks = (await (await fetch(`${base}/api/slides/decks?spaceId=${space.id}`, { headers: auth })).json()) as {
      decks: Array<{ id: string; latest: { version: number }; versions: Array<{ version: number }> }>;
    };
    assert.equal(decks.decks.length, 1);
    assert.equal(decks.decks[0]!.id, v1Id);
    assert.equal(decks.decks[0]!.latest.version, 2);
    assert.deepEqual(decks.decks[0]!.versions.map((v) => v.version), [2, 1]);
    const listedSpaces = (await (await fetch(`${base}/api/slides/spaces`, { headers: auth })).json()) as { spaces: Array<{ deckCount: number }> };
    assert.equal(listedSpaces.spaces[0]!.deckCount, 2);

    const pptx = await fetch(`${base}/api/slides/decks/${v1Id}/download?format=pptx`, { headers: auth });
    assert.equal(pptx.status, 200);
    assert.match(pptx.headers.get("content-disposition") ?? "", /attachment; filename="Pipeline.pptx"/);
    assert.equal(await pptx.text(), "FILE /app_data/pres-1/Deck.pptx");
    const pdf = await fetch(`${base}/api/slides/decks/${v1Id}/download?format=pdf`, { headers: auth });
    assert.equal(await pdf.text(), "FILE /app_data/pres-1/Deck.pdf", "PDF is exported on demand");
    assert.equal((await fetch(`${base}/api/slides/decks/missing/download`, { headers: auth })).status, 404);

    const templates = (await (await fetch(`${base}/api/slides/templates`, { headers: auth })).json()) as { templates: Array<{ id: string }> };
    assert.deepEqual(templates.templates.map((t) => t.id), ["general", "modern"]);

    assert.equal((await fetch(`${base}/api/slides/spaces/${space.id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await store.spaces.list("owner")).length, 0);
  });
});

test("POST /api/slides/generate researches with the selected sources, then builds the deck (SSE)", async () => {
  const { service, store, engine } = setup();
  const runtime = createTestRuntime({ slides: service, store });
  const searched: unknown[] = [];
  const readTool = (name: string, source: string, provider?: string): ToolDefinition => ({
    name,
    title: `Use ${name}`,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    effect: "read",
    source,
    ...(provider ? { provider } : {}),
    async run(input) {
      searched.push([name, input]);
      return { content: "ACME revenue 2025: $12.5M (10-K)" };
    }
  });
  runtime.tools.register(readTool("web_search", "builtin"));
  runtime.tools.register(readTool("crm_query", "mcp", "crm"));
  runtime.tools.register({ ...readTool("crm_delete", "mcp", "crm"), effect: "write" });
  runtime.tools.register(readTool("weather", "builtin"));
  let round = 0;
  const offered: string[][] = [];
  const toolLlm: ToolChatProvider = {
    async *streamWithTools(_messages, options): AsyncIterable<ToolChatEvent> {
      round += 1;
      offered.push((options?.tools ?? []).map((t) => t.function.name));
      if (round === 1) {
        yield { type: "tool_calls", calls: [{ id: "r1", name: "crm_query", arguments: "{\"q\":\"revenue\"}" }] };
      } else {
        yield { type: "text", delta: "# ACME growth\n\n## Slide 1: Revenue\n- $12.5M in 2025 (10-K)" };
      }
    }
  };
  await withApi({ runtime, toolLlm, model: () => "brain/deep" }, async (base) => {
    const sources = (await (await fetch(`${base}/api/slides/sources`)).json()) as { sources: Array<{ id: string; tools: string[] }> };
    assert.deepEqual(
      sources.sources.map((s) => [s.id, s.tools]),
      [["tool:web_search", ["web_search"]], ["tool:weather", ["weather"]], ["mcp:crm", ["crm_query"]]]
    );

    const response = await fetch(`${base}/api/slides/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "ACME growth for the board", sources: ["mcp:crm"], nSlides: 5 })
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const events = parseSse(await response.text());
    assert.deepEqual(
      events.map((e) => (e.type === "step" ? `step:${e.step}` : e.type === "tool" ? `tool:${e.name}:${e.status}` : e.type)),
      ["job", "step:researching", "tool:crm_query:running", "tool:crm_query:ok", "step:outlining", "step:generating", "done"]
    );
    assert.deepEqual(offered[0], ["crm_query"], "only the selected read-only sources are offered");
    assert.deepEqual(searched, [["crm_query", { q: "revenue" }]]);
    const done = events.at(-1) as { artifact: { title: string; slideCount: number; editUrl: string } };
    assert.equal(done.artifact.title, "ACME growth");
    const body = engine.calls.find((c) => c.url.endsWith("/generate"))!.body as { content: string; n_slides: number };
    assert.match(body.content, /\$12\.5M in 2025/);
    assert.equal(body.n_slides, 5);
    const decks = await store.artifacts.list("owner", { kind: "slides" });
    assert.equal(decks.length, 1);
    assert.equal((await store.spaces.get("owner", decks[0]!.spaceId!))?.name, "My decks");

    // No sources: straight to the engine with the prompt; engine errors arrive as an SSE error.
    engine.failNext = 500;
    const failed = parseSse(
      await (await fetch(`${base}/api/slides/generate`, { method: "POST", body: JSON.stringify({ prompt: "Plain deck" }) })).text()
    );
    assert.deepEqual(failed.map((e) => e.type === "step" ? `step:${e.step}` : e.type), ["job", "step:outlining", "step:generating", "error"]);
    assert.match(String(failed.at(-1)!.message), /Sibyl Slides hit an error \(500\)/);

    assert.equal((await fetch(`${base}/api/slides/generate`, { method: "POST", body: "{}" })).status, 400);
  });
});

test("generate is refused up front when the budget is used up", async () => {
  const blocked: UsageMeter = { ...createNoopMeter(), check: () => ({ allowed: false, scope: "monthly", message: "This month's budget is used up." }) };
  const { service } = setup({ meter: blocked });
  const runtime = createTestRuntime({ slides: service, meter: blocked });
  await withApi({ runtime }, async (base) => {
    const response = await fetch(`${base}/api/slides/generate`, { method: "POST", body: JSON.stringify({ prompt: "x" }) });
    assert.equal(response.status, 402);
    assert.match(((await response.json()) as { message: string }).message, /month's budget/);
  });
});

test("the gateway mounts /api/slides and reports when slides are off", async () => {
  const llm: LLMProvider = { async *streamText() { yield { delta: "x" }; } };
  const stt: STTProvider = { transcribe: async () => ({ text: "" }) };
  const gateway = await createGatewayServer({ providers: { llm, stt }, host: "127.0.0.1", runtime: createTestRuntime() });
  try {
    const status = await fetch(`http://127.0.0.1:${gateway.port}/api/slides/status`);
    assert.deepEqual(await status.json(), { enabled: false, research: false });
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/api/slides/decks`)).status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/elsewhere`)).status, 404);
  } finally {
    await gateway.close();
  }
});

test("editor URLs never repeat the /slides base path", async () => {
  const { editorUrl } = await import("./service.js");
  assert.equal(editorUrl("/slides", "/presentation?id=a"), "/slides/presentation?id=a");
  assert.equal(editorUrl("/slides", "/slides/presentation?id=a"), "/slides/presentation?id=a");
  assert.equal(editorUrl("/slides", "presentation?id=a"), "/slides/presentation?id=a");
});

/* ───────────── v0.4 polish ───────────── */

test("sources list only read-only data sources, grouped Web / Your connections", async () => {
  const { service } = setup();
  const runtime = createTestRuntime({ slides: service });
  const tool = (name: string, source: string, effect: "read" | "write" = "read", provider?: string): ToolDefinition => ({
    name,
    title: name,
    description: name,
    inputSchema: { type: "object" },
    effect,
    source,
    ...(provider ? { provider } : {}),
    run: async () => ({ content: "" })
  });
  for (const name of ["wikipedia", "web_search", "read_webpage", "weather", "currency_convert", "world_time"]) runtime.tools.register(tool(name, "builtin"));
  // Read-only, but never a data source.
  for (const name of ["recall", "list_secrets", "list_routines", "read_file", "calculate"]) runtime.tools.register(tool(name, "builtin"));
  runtime.tools.register(tool("remember", "builtin", "write"));
  runtime.tools.register(tool("list_slides", "slides"));
  runtime.tools.register(tool("mcp_notion_search", "mcp", "read", "notion"));
  runtime.tools.register(tool("mcp_notion_create_page", "mcp", "write", "notion"));
  runtime.tools.register(tool("mcp_memory_read_graph", "mcp", "read", "memory"));
  runtime.tools.register(tool("mcp_vault_get_secret", "mcp", "read", "vault"));
  runtime.tools.register(tool("kb_search", "knowledge"));
  await withApi({ runtime }, async (base) => {
    const body = (await (await fetch(`${base}/api/slides/sources`)).json()) as {
      sources: Array<{ id: string; label: string; group: string; tools: string[] }>;
      groups: Array<{ id: string; label: string }>;
    };
    assert.deepEqual(body.groups.map((g) => g.label), ["Web", "Your connections"]);
    assert.deepEqual(
      body.sources.map((s) => [s.group, s.id, s.label]),
      [
        ["web", "tool:web_search", "Web search"],
        ["web", "tool:read_webpage", "Read a webpage"],
        ["web", "tool:wikipedia", "Wikipedia"],
        ["web", "tool:weather", "Weather"],
        ["web", "tool:currency_convert", "Currency rates"],
        ["web", "tool:world_time", "World time"],
        ["connections", "tool:kb_search", "kb_search"],
        ["connections", "mcp:notion", "notion"]
      ]
    );
    assert.deepEqual(body.sources.find((s) => s.id === "mcp:notion")!.tools, ["mcp_notion_search"]);
  });
  // Selecting a forbidden tool by name does nothing.
  const { selectTools } = await import("./http.js");
  assert.deepEqual(selectTools(runtime.tools, ["tool:recall", "list_secrets", "mcp:memory", "tool:web_search"]).map((t) => t.name), ["web_search"]);
});

test("a deck build keeps running when the page goes away, is listed as a job, and Stop cancels", async () => {
  const { service, store } = setup();
  const runtime = createTestRuntime({ slides: service, store });
  await withApi({ runtime }, async (base) => {
    // Leave mid-stream: read the first event, then drop the connection.
    const controller = new AbortController();
    const response = await fetch(`${base}/api/slides/generate`, { method: "POST", body: JSON.stringify({ prompt: "Left the page" }), signal: controller.signal });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const jobId = (JSON.parse(first.split("data: ")[1]!.split("\n")[0]!) as { id: string }).id;
    controller.abort();
    let jobs: Array<{ id: string; status: string; artifact?: { title: string } }> = [];
    for (let i = 0; i < 50; i += 1) {
      jobs = ((await (await fetch(`${base}/api/slides/jobs`)).json()) as { jobs: typeof jobs }).jobs;
      if (jobs.find((j) => j.id === jobId)?.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = jobs.find((j) => j.id === jobId)!;
    assert.equal(job.status, "done");
    assert.equal(job.artifact?.title, "Deck", "no title given: the engine names the deck");
    assert.equal((await store.artifacts.list("owner", { kind: "slides" })).length, 1);
    assert.equal((await fetch(`${base}/api/slides/jobs/${jobId}`, { method: "DELETE" })).status, 404, "nothing to stop");
  });
  const started = service.jobs.start("job-x", "Stopped deck");
  assert.equal(service.jobs.cancel("job-x"), true);
  assert.equal(started.controller.signal.aborted, true);
  assert.equal(service.jobs.list().find((j) => j.id === "job-x")?.status, "cancelled");
});

test("every deck gets a first-slide thumbnail from the engine, cached by the gateway", async () => {
  const { service, store, meter, engine } = setup();
  const runtime = createTestRuntime({ slides: service, store });
  const created = await createSlidesTools(service)[0]!.run({ title: "Thumbs", content: "Facts" }, context(store, meter));
  const view = created.data as { id: string; thumbnailUrl: string };
  assert.equal(view.thumbnailUrl, `/api/slides/decks/${view.id}/thumbnail`);
  assert.equal((await store.artifacts.get("owner", view.id))!.meta.thumbnail, "/api/v1/ppt/presentation/pres-1/thumbnail");
  await withApi({ runtime }, async (base) => {
    const first = await fetch(`${base}${view.thumbnailUrl}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/png");
    assert.equal(await first.text(), "PNG pres-1");
    const before = engine.calls.filter((c) => c.url.endsWith("/thumbnail")).length;
    assert.equal(await (await fetch(`${base}${view.thumbnailUrl}`)).text(), "PNG pres-1");
    assert.equal(engine.calls.filter((c) => c.url.endsWith("/thumbnail")).length, before, "served from the gateway cache");
    assert.equal((await fetch(`${base}/api/slides/decks/missing/thumbnail`)).status, 404);
  });
});

test("approval cards and the brain prompt describe slides in plain words", async () => {
  const { summarizeApproval } = await import("../brain/approvals.js");
  const { toolSystemPrompt } = await import("../brain/tool-loop.js");
  const { SLIDES_PROMPT_GUIDANCE } = await import("./tools.js");
  const { store, meter, service } = setup();
  const tools = createSlidesTools(service);
  const [create, revise] = tools as [ToolDefinition<any>, ToolDefinition<any>];
  assert.equal(summarizeApproval(create, { title: "Q3 market overview", n_slides: 8, content: "x" }), "Create an 8-slide deck 'Q3 market overview' (≈$0.04)");
  assert.equal(summarizeApproval(create, { title: "Pricing", n_slides: 5, content: "x", space: "Board" }), "Create a 5-slide deck 'Pricing' in \"Board\" (≈$0.03)");
  const v1 = await create.run({ title: "Q3 market overview", content: "Facts", n_slides: 6 }, context(store, meter));
  const id = (v1.data as { id: string }).id;
  assert.equal(
    summarizeApproval(revise, { deck_id: id, instructions: "Add a churn slide" }),
    "Make a new version of 'Q3 market overview' (3 slides, ≈$0.01): Add a churn slide"
  );
  assert.match(summarizeApproval(revise, { deck_id: "unknown", instructions: "Shorter" }), /^Make a new version of the deck \(8 slides, ≈\$0\.04\): Shorter$/);

  const prompt = toolSystemPrompt(tools);
  assert.ok(prompt.endsWith(SLIDES_PROMPT_GUIDANCE), "slides guidance is appended once");
  assert.equal(prompt.split("## Slide decks").length, 2);
  assert.ok(!toolSystemPrompt([tools[2]!]).includes("## Slide decks"), "list_slides alone does not add it");
});
