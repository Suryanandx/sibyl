import type { ChatToolCall, ToolChatEvent, ToolChatProvider } from "@open-gpt-live/adapters";
import {
  createMemoryStore,
  createToolRegistry,
  type BudgetLimits,
  type RoutineRecord,
  type RoutineRunRecord,
  type ToolDefinition,
  type UsageEvent
} from "@open-gpt-live/core";
import type { ApprovalView } from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { GatewayUsageMeter } from "../metering/meter.js";
import { RoutineApprovalGate, createRoutineRunner, type RunHandle } from "./runner.js";

const OWNER = "owner";
const NOW = Date.parse("2026-11-09T08:00:00Z");

type Round = { text?: string; calls?: ChatToolCall[]; costUsd?: number; throws?: Error };

function scripted(rounds: Round[]): ToolChatProvider & { requests: number } {
  const provider = {
    requests: 0,
    async *streamWithTools(): AsyncIterable<ToolChatEvent> {
      const round = rounds[provider.requests] ?? { text: "Done." };
      provider.requests += 1;
      if (round.throws) throw round.throws;
      if (round.text) yield { type: "text", delta: round.text };
      yield { type: "usage", usage: { costUsd: round.costUsd ?? 0.01 } };
      if (round.calls) yield { type: "tool_calls", calls: round.calls };
    }
  };
  return provider;
}

function setup(rounds: Round[], options: { limits?: BudgetLimits; routine?: Partial<RoutineRecord>; tools?: ToolDefinition<any, any>[]; ttlMs?: number } = {}) {
  const store = createMemoryStore();
  const meter = new GatewayUsageMeter({ store, limits: options.limits ?? {}, now: () => NOW });
  const recorded: UsageEvent[] = [];
  const originalRecord = meter.record.bind(meter);
  meter.record = (event) => {
    recorded.push({ id: "x", at: NOW, ...event } as UsageEvent);
    originalRecord(event);
  };
  const tools = createToolRegistry();
  for (const tool of options.tools ?? []) tools.register(tool);
  const requested: ApprovalView[] = [];
  let id = 0;
  const approvals = new RoutineApprovalGate({
    store,
    ownerId: OWNER,
    createId: () => `ap-${++id}`,
    now: () => NOW,
    log: () => undefined,
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
    onRequested: (view) => void requested.push(view)
  });
  const provider = scripted(rounds);
  const runner = createRoutineRunner({
    store,
    tools,
    meter,
    provider,
    model: () => "brain/deep",
    systemPrompt: "BRAIN",
    approvals,
    excludeTools: new Set(["create_routine"]),
    createId: () => `id-${++id}`,
    now: () => NOW,
    log: () => undefined
  });
  const routine: RoutineRecord = {
    id: "r1",
    ownerId: OWNER,
    name: "Morning news",
    instruction: "Summarize the news",
    cron: "0 8 * * *",
    timezone: "Europe/Berlin",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...options.routine
  };
  const run: RoutineRunRecord = { id: "run-1", routineId: "r1", ownerId: OWNER, status: "running", startedAt: NOW, costUsd: 0 };
  const statuses: string[] = [];
  const handle: RunHandle = {
    run,
    lastAttempt: true,
    setStatus: async (status) => {
      run.status = status;
      statuses.push(status);
    },
    addCost: (usd) => void (run.costUsd += usd)
  };
  return { store, meter, recorded, approvals, requested, provider, runner, routine, run, handle, statuses };
}

function writeTool(calls: unknown[]): ToolDefinition<any, any> {
  return {
    name: "send_email",
    title: "Send an email",
    description: "send",
    inputSchema: { type: "object", properties: { to: { type: "string" } } },
    effect: "write",
    source: "builtin",
    async run(input) {
      calls.push(input);
      return { content: "sent" };
    }
  };
}

const sendCall: ChatToolCall = { id: "c1", name: "send_email", arguments: JSON.stringify({ to: "me@example.com" }) };

describe("routine runner", () => {
  test("posts the result to the routine's own conversation and meters it as a routine", async () => {
    const s = setup([{ text: "Here is your **news**." }]);
    await s.store.routines.upsert(s.routine);
    const outcome = await s.runner(s.routine, s.handle, new AbortController().signal);
    expect(outcome).toMatchObject({ status: "succeeded", summary: "Here is your news." });
    const saved = await s.store.routines.get(OWNER, "r1");
    expect(saved?.conversationId).toBeTruthy();
    const conversation = await s.store.conversations.get(OWNER, saved!.conversationId!);
    expect(conversation?.title).toBe("Routine: Morning news");
    expect(conversation?.messages).toHaveLength(1);
    expect(conversation?.messages[0]).toMatchObject({ role: "assistant", content: "Here is your **news**.", requestId: "run-1", model: "brain/deep" });
    expect(s.recorded).toHaveLength(1);
    expect(s.recorded[0]).toMatchObject({ feature: "routine", routineId: "r1", costUsd: 0.01 });
    expect(s.run.costUsd).toBeCloseTo(0.01);

    // A second run reuses the conversation.
    await s.runner({ ...s.routine, conversationId: saved!.conversationId! }, s.handle, new AbortController().signal);
    expect((await s.store.conversations.list(OWNER))).toHaveLength(1);
  });

  test("budget_blocked before a round that would exceed the routine's cap", async () => {
    const s = setup(
      [
        { text: "Looking…", calls: [{ id: "c1", name: "lookup", arguments: "{}" }], costUsd: 0.02 },
        { text: "never" }
      ],
      {
        routine: { maxRunUsd: 0.025 },
        tools: [{ name: "lookup", title: "Look up", description: "", inputSchema: { type: "object" }, effect: "read", source: "builtin", run: async () => ({ content: "x" }) }]
      }
    );
    await s.store.routines.upsert(s.routine);
    const outcome = await s.runner(s.routine, s.handle, new AbortController().signal);
    expect(outcome.status).toBe("budget_blocked");
    expect(outcome.error).toMatch(/cost cap/);
    expect(s.provider.requests).toBe(1);
    const conversation = await s.store.conversations.get(OWNER, (await s.store.routines.get(OWNER, "r1"))!.conversationId!);
    expect(conversation?.messages[0]?.content).toMatch(/Routine stopped/);
  });

  test("the env per-run cap applies when the routine has none; owner caps too", async () => {
    const s = setup([{ text: "x" }], { limits: { perRoutineRunUsd: 0.000001 } });
    s.run.costUsd = 0.001;
    await s.store.routines.upsert(s.routine);
    expect((await s.runner(s.routine, s.handle, new AbortController().signal)).status).toBe("budget_blocked");
    expect(s.provider.requests).toBe(0);

    const daily = setup([{ text: "x" }], { limits: { dailyUsd: 0.01 } });
    daily.meter.record({ ownerId: OWNER, feature: "voice", model: "m", costUsd: 0.02, estimated: false });
    await daily.store.routines.upsert(daily.routine);
    const outcome = await daily.runner(daily.routine, daily.handle, new AbortController().signal);
    expect(outcome.status).toBe("budget_blocked");
    expect(outcome.error).toMatch(/Today's budget/);
  });

  test("a write tool pauses the run for approval and resumes when approved", async () => {
    const sent: unknown[] = [];
    const s = setup([{ calls: [sendCall] }, { text: "Email sent." }], { tools: [writeTool(sent)] });
    await s.store.routines.upsert(s.routine);
    const running = s.runner(s.routine, s.handle, new AbortController().signal);
    await waitUntil(() => s.requested.length === 1);
    expect(s.run.status).toBe("awaiting_approval");
    const pending = await s.store.approvals.listPending(OWNER);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ routineId: "r1", runId: "run-1", toolName: "send_email" });
    expect(pending[0]!.expiresAt! - pending[0]!.createdAt).toBe(24 * 60 * 60 * 1000);
    expect(sent).toHaveLength(0);

    expect(await s.approvals.decide(pending[0]!.id, "approve")).toBe("approved");
    const outcome = await running;
    expect(outcome.status).toBe("succeeded");
    expect(sent).toEqual([{ to: "me@example.com" }]);
    expect(s.statuses).toEqual(["awaiting_approval", "running"]);
  });

  test("a declined or expired approval skips the tool", async () => {
    const sent: unknown[] = [];
    const s = setup([{ calls: [sendCall] }, { text: "Could not send." }], { tools: [writeTool(sent)], ttlMs: 20 });
    await s.store.routines.upsert(s.routine);
    const outcome = await s.runner(s.routine, s.handle, new AbortController().signal);
    expect(outcome.status).toBe("succeeded");
    expect(sent).toHaveLength(0);
    const [approval] = s.requested;
    expect((await s.store.approvals.get(OWNER, approval!.id))?.status).toBe("expired");
    // Deciding after expiry reports the final status and changes nothing.
    expect(await s.approvals.decide(approval!.id, "approve")).toBe("expired");
  });

  test("excluded tools are not offered to routine runs", async () => {
    const s = setup([{ text: "ok" }], {
      tools: [{ name: "create_routine", title: "Create", description: "", inputSchema: { type: "object" }, effect: "write", source: "builtin", run: async () => ({ content: "" }) }]
    });
    let offered: string[] = [];
    const inner = s.provider.streamWithTools.bind(s.provider);
    s.provider.streamWithTools = (messages, options) => {
      offered = (options?.tools ?? []).map((tool) => tool.function.name);
      return inner(messages, options);
    };
    await s.store.routines.upsert(s.routine);
    await s.runner(s.routine, s.handle, new AbortController().signal);
    expect(offered).toEqual([]);
  });

  test("transient errors are returned for retry until the last attempt", async () => {
    const s = setup([{ throws: new Error("fetch failed") }, { throws: new Error("fetch failed") }]);
    await s.store.routines.upsert(s.routine);
    const first = await s.runner(s.routine, { ...s.handle, lastAttempt: false }, new AbortController().signal);
    expect(first).toMatchObject({ status: "failed", transient: true });
    let conversationId = (await s.store.routines.get(OWNER, "r1"))!.conversationId!;
    expect((await s.store.conversations.get(OWNER, conversationId))?.messages).toHaveLength(0);
    const last = await s.runner(s.routine, s.handle, new AbortController().signal);
    expect(last.status).toBe("failed");
    conversationId = (await s.store.routines.get(OWNER, "r1"))!.conversationId!;
    expect((await s.store.conversations.get(OWNER, conversationId))?.messages[0]?.content).toMatch(/Routine failed/);
  });
});

async function waitUntil(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
