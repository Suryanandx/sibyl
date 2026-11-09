import { createMemoryStore, createToolRegistry, type ToolContext, type ToolDefinition } from "@open-gpt-live/core";
import { describe, expect, test } from "vitest";
import { summarizeApproval } from "../brain/approvals.js";
import { createNoopMeter } from "../runtime.js";
import { RoutineService } from "./service.js";

const OWNER = "owner";
const NOW = Date.parse("2026-11-09T12:00:00Z");

async function setup(limits: { perRoutineRunUsd?: number } = {}) {
  const store = createMemoryStore();
  const tools = createToolRegistry();
  const meter = { ...createNoopMeter(), limits: () => limits };
  let id = 0;
  const service = new RoutineService({ store, tools, meter, ownerId: OWNER, env: { TZ: "UTC" }, log: () => undefined, createId: () => `id-${++id}`, now: () => NOW });
  await service.init();
  await service.setTimezone("Europe/Berlin");
  const context: ToolContext = { signal: new AbortController().signal, ownerId: OWNER, runId: "run", store, meter, log: () => undefined };
  const tool = (name: string) => tools.get(name) as ToolDefinition<any, any> & { approvalSummary?(input: Record<string, unknown>): string };
  return { store, tools, service, context, tool };
}

describe("routine chat tools", () => {
  test("are registered with the right effects", async () => {
    const { tools } = await setup();
    const effects = Object.fromEntries(tools.list().map((t) => [t.name, t.effect]));
    expect(effects).toEqual({
      create_routine: "write",
      list_routines: "read",
      update_routine: "write",
      pause_routine: "write",
      delete_routine: "write"
    });
  });

  test("create_routine: approval states the schedule in plain words and the cost cap", async () => {
    const { tool } = await setup();
    const input = { name: "Morning news", instruction: "Summarize tech news", cron: "0 8 * * 1-5" };
    const summary = summarizeApproval(tool("create_routine"), input);
    expect(summary).toContain("every weekday at 08:00 (Europe/Berlin)");
    expect(summary).toContain("a cost cap of $0.25 per run");
    expect(summary).toContain("Morning news");

    const withEnvCap = await setup({ perRoutineRunUsd: 0.5 });
    expect(summarizeApproval(withEnvCap.tool("create_routine"), input)).toContain("$0.50 per run");
    expect(summarizeApproval(withEnvCap.tool("create_routine"), { ...input, maxRunUsd: 0.1 })).toContain("$0.10 per run");
  });

  test("create_routine stores the routine in the browser's time zone with its next run", async () => {
    const { tool, store, context } = await setup();
    const result = await tool("create_routine").run(
      { name: "Morning news", instruction: "Summarize tech news", cron: "0 8 * * 1-5" },
      context
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/every weekday at 08:00/);
    const [routine] = await store.routines.list(OWNER);
    expect(routine).toMatchObject({ name: "Morning news", timezone: "Europe/Berlin", cron: "0 8 * * 1-5", enabled: true, maxRunUsd: 0.25 });
    // Tue 10 Nov 2026 08:00 Berlin = 07:00Z.
    expect(routine?.nextRunAt).toBe(Date.parse("2026-11-10T07:00:00Z"));
  });

  test("create_routine rejects a bad schedule without storing anything", async () => {
    const { tool, store, context } = await setup();
    const bad = await tool("create_routine").run({ name: "x", instruction: "y", cron: "every morning" }, context);
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/5 fields/);
    const badZone = await tool("create_routine").run({ name: "x", instruction: "y", cron: "0 8 * * *", timezone: "Mars/Base" }, context);
    expect(badZone.isError).toBe(true);
    expect(await store.routines.list(OWNER)).toHaveLength(0);
  });

  test("list, update, pause/resume and delete by name or id", async () => {
    const { tool, store, context, service } = await setup();
    await tool("create_routine").run({ name: "Digest", instruction: "Daily digest", cron: "0 18 * * *" }, context);
    const id = (await store.routines.list(OWNER))[0]!.id;

    expect((await tool("list_routines").run({}, context)).content).toMatch(/Digest \(id .*every day at 18:00/);

    // Names in approval sentences come from the cache.
    await service.list();
    expect(summarizeApproval(tool("pause_routine"), { routine: id })).toBe("Sibyl will pause the routine “Digest”; it won't run until resumed.");
    expect(summarizeApproval(tool("update_routine"), { routine: id, cron: "0 7 * * *" })).toContain("every day at 07:00 (Europe/Berlin)");

    const updated = await tool("update_routine").run({ routine: "digest", cron: "0 7 * * *", maxRunUsd: 0.05 }, context);
    expect(updated.isError).toBeFalsy();
    expect(await store.routines.get(OWNER, id)).toMatchObject({ cron: "0 7 * * *", maxRunUsd: 0.05, nextRunAt: Date.parse("2026-11-10T06:00:00Z") });

    await tool("pause_routine").run({ routine: id }, context);
    const paused = await store.routines.get(OWNER, id);
    expect(paused?.enabled).toBe(false);
    expect(paused?.nextRunAt).toBeUndefined();
    await tool("pause_routine").run({ routine: id, paused: false }, context);
    expect((await store.routines.get(OWNER, id))?.nextRunAt).toBeDefined();

    expect((await tool("delete_routine").run({ routine: "nope" }, context)).isError).toBe(true);
    await tool("delete_routine").run({ routine: "Digest" }, context);
    expect(await store.routines.list(OWNER)).toHaveLength(0);
  });

  test("the browser time zone persists across restarts", async () => {
    const store = createMemoryStore();
    const make = () => new RoutineService({ store, tools: createToolRegistry(), meter: createNoopMeter(), ownerId: OWNER, env: { TZ: "UTC" }, log: () => undefined });
    const first = make();
    await first.init();
    expect(first.getTimezone()).toBe("UTC");
    expect(await first.setTimezone("Asia/Tokyo")).toBe(true);
    expect(await first.setTimezone("Not/AZone")).toBe(false);
    const second = make();
    await second.init();
    expect(second.getTimezone()).toBe("Asia/Tokyo");
  });
});
