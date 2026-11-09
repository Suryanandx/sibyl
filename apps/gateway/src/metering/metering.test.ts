import assert from "node:assert/strict";
import { once } from "node:events";
import type { LLMProvider, ProviderCallOptions, TTSProvider } from "@open-gpt-live/adapters";
import { DEFAULT_OWNER_ID, createMemoryStore, type UsageEvent } from "@open-gpt-live/core";
import { WS_EVENTS, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import {
  GatewayUsageMeter,
  budgetLimitsFromEnv,
  buildUsageView,
  checkTurnBudget,
  createMeteredFetch,
  meterProviders
} from "./index.js";

const OWNER = DEFAULT_OWNER_ID;
// Mid-month, mid-day local time so day/month boundaries are predictable.
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();

function event(partial: Partial<UsageEvent> & { costUsd: number; at: number }): UsageEvent {
  return { id: `e${Math.random()}`, ownerId: OWNER, feature: "voice", model: "m", estimated: false, ...partial };
}

test("meter blocks when an estimate would cross the daily cap and downgrades at 85%", () => {
  const meter = new GatewayUsageMeter({ store: createMemoryStore(), limits: { dailyUsd: 1 }, now: () => NOW });
  assert.deepEqual(meter.check({ ownerId: OWNER, estimateUsd: 0.1 }), { allowed: true });
  meter.record({ ownerId: OWNER, feature: "voice", model: "m", costUsd: 0.8, estimated: false });
  assert.deepEqual(meter.check({ ownerId: OWNER, estimateUsd: 0.05 }), { allowed: true, downgrade: true });
  const blocked = meter.check({ ownerId: OWNER, estimateUsd: 0.25 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.allowed === false && blocked.scope, "daily");
  meter.record({ ownerId: OWNER, feature: "brain", model: "b", costUsd: 0.2, estimated: false });
  // At the cap even a free call is blocked.
  assert.equal(meter.check({ ownerId: OWNER, estimateUsd: 0 }).allowed, false);
  // Next day the daily cap resets.
  const tomorrow = NOW + 24 * 60 * 60 * 1000;
  assert.deepEqual(meter.check({ ownerId: OWNER, estimateUsd: 0.1, now: tomorrow }), { allowed: true });
});

test("meter enforces monthly and routine caps", () => {
  const meter = new GatewayUsageMeter({
    store: createMemoryStore(),
    limits: { monthlyUsd: 5, perRoutineRunUsd: 0.5, perRoutineDailyUsd: 1 },
    now: () => NOW
  });
  meter.record({ ownerId: OWNER, feature: "routine", model: "m", costUsd: 0.9, estimated: false, routineId: "r1" });
  const runCap = meter.check({ ownerId: OWNER, estimateUsd: 0.1, routineId: "r1", routineRunUsdSoFar: 0.45 });
  assert.equal(runCap.allowed === false && runCap.scope, "routine_run");
  const dailyCap = meter.check({ ownerId: OWNER, estimateUsd: 0.2, routineId: "r1" });
  assert.equal(dailyCap.allowed === false && dailyCap.scope, "routine_daily");
  // Other routines are unaffected by r1's daily spend.
  assert.equal(meter.check({ ownerId: OWNER, estimateUsd: 0.2, routineId: "r2" }).allowed, true);
  meter.record({ ownerId: OWNER, feature: "voice", model: "m", costUsd: 4.2, estimated: false });
  const monthly = meter.check({ ownerId: OWNER, estimateUsd: 0.1 });
  assert.equal(monthly.allowed === false && monthly.scope, "monthly");
  assert.match(monthly.allowed === false ? monthly.message : "", /SIBYL_BUDGET_MONTHLY_USD/);
});

test("meter rebuilds today and month totals from the store and persists new events", async () => {
  const store = createMemoryStore();
  const lastMonth = new Date(2026, 9, 20, 12).getTime();
  const earlierThisMonth = new Date(2026, 10, 3, 9).getTime();
  const earlierToday = new Date(2026, 10, 15, 8).getTime();
  await store.usage.insert(event({ costUsd: 3, at: lastMonth }));
  await store.usage.insert(event({ costUsd: 0.5, at: earlierThisMonth, feature: "brain" }));
  await store.usage.insert(event({ costUsd: 0.25, at: earlierToday, feature: "tts" }));

  const meter = new GatewayUsageMeter({ store, now: () => NOW });
  await meter.load([OWNER]);
  const totals = meter.totals(OWNER);
  assert.equal(totals.todayUsd, 0.25);
  assert.equal(totals.monthUsd, 0.75);
  assert.deepEqual(totals.byFeature, { brain: 0.5, tts: 0.25 });

  meter.record({ ownerId: OWNER, feature: "stt", model: "s", costUsd: 0.01, estimated: true, sessionId: "s1" });
  await meter.flush();
  assert.equal(await store.usage.sum(OWNER, earlierToday, NOW + 1), 0.26);
  assert.equal(meter.sessionUsd("s1"), 0.01);
});

test("budget limits come from env and ignore invalid values", () => {
  const warnings: string[] = [];
  const limits = budgetLimitsFromEnv(
    {
      SIBYL_BUDGET_DAILY_USD: "2",
      SIBYL_BUDGET_MONTHLY_USD: "nope",
      SIBYL_BUDGET_ROUTINE_RUN_USD: "0.25",
      SIBYL_BUDGET_ROUTINE_DAILY_USD: ""
    },
    (name) => warnings.push(name)
  );
  assert.deepEqual(limits, { dailyUsd: 2, perRoutineRunUsd: 0.25 });
  assert.deepEqual(warnings, ["usage.invalid_budget"]);
});

const catalog: ModelCatalog = {
  voice: [
    { id: "voice/pricey", label: "Pricey", costPer100Turns: 1 },
    { id: "voice/cheap", label: "Cheap", costPer100Turns: 0.1 }
  ],
  llm: [
    { id: "llm/pricey", label: "Pricey", costPer100Turns: 5 },
    { id: "llm/cheap", label: "Cheap", costPer100Turns: 0.5 }
  ],
  stt: [{ id: "stt/a", label: "STT", costPer100Turns: 0.06 }],
  tts: [{ id: "tts/a", label: "TTS", costPer100Turns: 0.16, voices: ["v"] }],
  presets: [{ id: "cheapest", label: "Cheapest", settings: { voiceModel: "voice/cheap", llmModel: "llm/cheap" } }]
};

test("metered providers record actual cost when reported and estimates otherwise", async () => {
  const meter = new GatewayUsageMeter({ store: createMemoryStore(), now: () => NOW });
  const llm: LLMProvider = {
    async *streamText(_messages, options?: ProviderCallOptions) {
      yield { delta: "hello" };
      if (options?.model === "llm/pricey") options.onUsage?.({ costUsd: 0.002, promptTokens: 100, completionTokens: 5 });
    }
  };
  const tts: TTSProvider = {
    async *synthesize() {
      yield { audio: new Uint8Array([1, 2]), mimeType: "audio/mpeg", format: "mp3" };
    }
  };
  const providers = meterProviders(
    { llm, tts, stt: { transcribe: async () => ({ text: "x" }) } },
    { meter, ownerId: OWNER, catalog: () => catalog }
  );
  for await (const _ of providers.llm.streamText([{ role: "user", content: "hi" }], {
    model: "llm/pricey",
    meta: { feature: "brain", sessionId: "s1", requestId: "r1" }
  })) {
    // drain
  }
  for await (const _ of providers.tts!.synthesize({ text: "x".repeat(160) }, { model: "tts/a", meta: { sessionId: "s1" } })) {
    // drain
  }
  const totals = meter.totals(OWNER);
  assert.equal(totals.byFeature.brain, 0.002);
  // 160 characters is one typical turn of TTS: costPer100Turns / 100.
  assert.ok(Math.abs((totals.byFeature.tts ?? 0) - 0.0016) < 1e-9);
  assert.ok(Math.abs(meter.sessionUsd("s1") - 0.0036) < 1e-9);
  // Opt-out for callers that record their own usage.
  for await (const _ of providers.llm.streamText([{ role: "user", content: "hi" }], { meta: { metering: "off" } })) {
    // drain
  }
  assert.equal(meter.totals(OWNER).byFeature.voice, undefined);
});

test("metered fetch captures /models pricing and records scout probes", async () => {
  const meter = new GatewayUsageMeter({ store: createMemoryStore(), now: () => NOW });
  const fake = (async (url: string) =>
    url.endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "a/b", pricing: { prompt: "0.000001", completion: "0.000002" } }] }))
      : new Response("data: {}\n\n")) as unknown as typeof fetch;
  const metered = createMeteredFetch({ meter, ownerId: OWNER, fetchImpl: fake });
  await metered("https://openrouter.ai/api/v1/models");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(meter.pricing.size, 1);
  await metered("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "a/b", messages: [{ role: "user", content: "x".repeat(400) }] })
  });
  const scout = meter.totals(OWNER).byFeature.scout ?? 0;
  // (100 + 4 overhead) prompt tokens × 1e-6 + 40 completion × 2e-6.
  assert.ok(Math.abs(scout - (104 * 0.000001 + 40 * 0.000002)) < 1e-12);
});

test("turn budget picks the Cheapest preset when close to a cap", () => {
  const meter = new GatewayUsageMeter({ store: createMemoryStore(), limits: { dailyUsd: 0.1 }, now: () => NOW });
  meter.record({ ownerId: OWNER, feature: "voice", model: "earlier", costUsd: 0.08, estimated: false });
  const budget = checkTurnBudget({
    meter,
    ownerId: OWNER,
    feature: "voice",
    model: "voice/pricey",
    catalog,
    sessionId: "s",
    requestId: "r"
  });
  assert.deepEqual(budget, { allowed: true, economy: true, model: "voice/cheap" });
  const view = buildUsageView({ meter, ownerId: OWNER, sessionId: "s", economyMode: true });
  assert.equal(view.dailyBudgetUsd, 0.1);
  assert.equal(view.economyMode, true);
});

test("gateway sends BUDGET_BLOCKED and makes no model call when the budget is spent", async () => {
  const meter = new GatewayUsageMeter({ store: createMemoryStore(), limits: { dailyUsd: 0.05 } });
  meter.record({ ownerId: OWNER, feature: "voice", model: "llm/pricey", costUsd: 0.05, estimated: false });
  let llmCalls = 0;
  const server = await createGatewayServer({
    port: 0,
    runtime: createTestRuntime({ meter }),
    modelCatalog: catalog,
    defaultSettings: { llmModel: "llm/pricey", sttModel: "stt/a" },
    providers: {
      llm: {
        async *streamText() {
          llmCalls += 1;
          yield { delta: "should not happen" };
        }
      },
      stt: { transcribe: async () => ({ text: "x" }) }
    }
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: WS_EVENTS.USER_TEXT, requestId: "t1", text: "hello" }));
    socket.send(JSON.stringify({ type: WS_EVENTS.USAGE_REQUEST }));
    await waitUntil(() => messages.some((m) => m.type === WS_EVENTS.USAGE_UPDATE));
    const blocked = messages.find((m) => m.type === WS_EVENTS.BUDGET_BLOCKED);
    assert.ok(blocked && blocked.type === WS_EVENTS.BUDGET_BLOCKED);
    assert.equal(blocked.scope, "daily");
    assert.equal(blocked.requestId, "t1");
    assert.ok(messages.some((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "t1"));
    const update = messages.find((m) => m.type === WS_EVENTS.USAGE_UPDATE);
    assert.ok(update && update.type === WS_EVENTS.USAGE_UPDATE);
    assert.equal(update.usage.todayUsd, 0.05);
    assert.equal(update.usage.dailyBudgetUsd, 0.05);
    assert.equal(llmCalls, 0);
  } finally {
    socket.close();
    await server.close();
  }
});

test("gateway runs a turn on the Cheapest preset near a cap and reports economy mode", async () => {
  const meter = new GatewayUsageMeter({ store: createMemoryStore(), limits: { dailyUsd: 1 } });
  meter.record({ ownerId: OWNER, feature: "brain", model: "earlier", costUsd: 0.9, estimated: false });
  const models: Array<string | undefined> = [];
  const server = await createGatewayServer({
    port: 0,
    runtime: createTestRuntime({ meter }),
    modelCatalog: catalog,
    defaultSettings: { llmModel: "llm/pricey", sttModel: "stt/a" },
    providers: {
      llm: {
        async *streamText(_messages, options?: ProviderCallOptions) {
          models.push(options?.model);
          options?.onUsage?.({ costUsd: 0.001 });
          yield { delta: "cheap answer" };
        }
      },
      stt: { transcribe: async () => ({ text: "x" }) }
    }
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: WS_EVENTS.USER_TEXT, requestId: "t2", text: "hello" }));
    await waitUntil(() =>
      messages.some((m) => m.type === WS_EVENTS.USAGE_UPDATE && m.usage.sessionUsd > 0)
    );
    assert.deepEqual(models, ["llm/cheap"]);
    const update = messages.filter((m) => m.type === WS_EVENTS.USAGE_UPDATE).at(-1);
    assert.ok(update && update.type === WS_EVENTS.USAGE_UPDATE);
    assert.equal(update.usage.economyMode, true);
    assert.equal(update.usage.sessionUsd, 0.001);
  } finally {
    socket.close();
    await server.close();
  }
});

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
