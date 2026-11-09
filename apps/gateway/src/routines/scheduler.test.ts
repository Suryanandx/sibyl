import { createMemoryStore, type RoutineRecord, type RoutineRunRecord, type Store } from "@open-gpt-live/core";
import { describe, expect, test } from "vitest";
import type { RoutineRunner, RunOutcome } from "./runner.js";
import type { RoutineOutcome } from "./scheduler.js";
import { RoutineScheduler } from "./scheduler.js";

const OWNER = "owner";
const T0 = Date.parse("2026-11-09T07:59:00Z");

function routine(id: string, overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id,
    ownerId: OWNER,
    name: `Routine ${id}`,
    instruction: "do it",
    cron: "0 8 * * *",
    timezone: "UTC",
    enabled: true,
    createdAt: T0 - 1000,
    updatedAt: T0 - 1000,
    nextRunAt: T0 - 1,
    ...overrides
  };
}

function harness(runner: RoutineRunner, options: { store?: Store; now?: () => number; maxConcurrency?: number } = {}) {
  const store = options.store ?? createMemoryStore();
  let clock = T0;
  let id = 0;
  const notifications: RoutineOutcome[] = [];
  const sleeps: number[] = [];
  const scheduler = new RoutineScheduler({
    store,
    ownerId: OWNER,
    runner,
    createId: () => `run-${++id}`,
    now: options.now ?? (() => clock),
    tickMs: 60_000_000,
    maxConcurrency: options.maxConcurrency ?? 2,
    sleep: async (ms) => void sleeps.push(ms),
    notify: (n) => void notifications.push(n)
  });
  return {
    store,
    scheduler,
    notifications,
    sleeps,
    setClock: (value: number) => void (clock = value)
  };
}

const ok: RoutineRunner = async () => ({ status: "succeeded", summary: "done" });

describe("RoutineScheduler", () => {
  test("runs a due routine once and moves nextRunAt to the next cron time", async () => {
    const calls: string[] = [];
    const h = harness(async (r, handle) => {
      calls.push(r.id);
      handle.addCost(0.01);
      return { status: "succeeded", summary: "all good" };
    });
    await h.store.routines.upsert(routine("a"));
    await h.store.routines.upsert(routine("later", { nextRunAt: T0 + 3_600_000 }));
    await h.store.routines.upsert(routine("paused", { enabled: false }));
    await h.scheduler.start();
    await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
    await h.scheduler.idle();
    await h.scheduler.tick();
    await h.scheduler.idle();

    expect(calls).toEqual(["a"]);
    const saved = await h.store.routines.get(OWNER, "a");
    expect(saved?.nextRunAt).toBe(Date.parse("2026-11-09T08:00:00Z"));
    expect(saved?.lastRunAt).toBe(T0);
    const [run] = await h.store.routines.listRuns(OWNER, "a");
    expect(run).toMatchObject({ status: "succeeded", summary: "all good", costUsd: 0.01 });
    expect(run?.leaseUntil).toBeUndefined();
    expect(h.notifications.map((n) => n.kind)).toEqual(["finished"]);
    await h.scheduler.stop();
  });

  test("a one-time task (once) runs at its time and then pauses itself", async () => {
    const calls: string[] = [];
    const h = harness(async (r) => {
      calls.push(r.id);
      return { status: "succeeded", summary: "done" };
    });
    await h.store.routines.upsert(routine("task", { once: true, cron: "0 8 9 11 *" }));
    await h.scheduler.start();
    await h.scheduler.tick();
    await h.scheduler.idle();
    h.setClock(Date.parse("2027-11-09T08:00:30Z"));
    await h.scheduler.tick();
    await h.scheduler.idle();
    expect(calls).toEqual(["task"]);
    const saved = await h.store.routines.get(OWNER, "task");
    expect(saved).toMatchObject({ enabled: false, lastRunAt: T0 });
    expect(saved?.nextRunAt).toBeUndefined();
    await h.scheduler.stop();
  });

  test("marks runs with expired leases interrupted on start; live leases block a double run", async () => {
    const store = createMemoryStore();
    await store.routines.upsert(routine("crashed", { nextRunAt: T0 + 3_600_000 }));
    await store.routines.upsert(routine("busy"));
    const stale: RoutineRunRecord = { id: "old", routineId: "crashed", ownerId: OWNER, status: "awaiting_approval", startedAt: T0 - 600_000, costUsd: 0.02, leaseUntil: T0 - 1 };
    const live: RoutineRunRecord = { id: "live", routineId: "busy", ownerId: OWNER, status: "running", startedAt: T0 - 10_000, costUsd: 0, leaseUntil: T0 + 120_000 };
    await store.routines.insertRun(stale);
    await store.routines.insertRun(live);
    await store.approvals.create({ id: "orphan", ownerId: OWNER, runId: "old", routineId: "crashed", toolName: "send", title: "Send", summary: "s", input: {}, status: "pending", createdAt: T0 - 600_000 });
    const expired: string[] = [];
    const calls: string[] = [];
    const scheduler = new RoutineScheduler({
      store,
      ownerId: OWNER,
      runner: async (r) => (calls.push(r.id), { status: "succeeded" }),
      createId: () => "new",
      now: () => T0,
      tickMs: 60_000_000,
      expireOrphanApproval: async (id) => {
        expired.push(id);
        await store.approvals.decide(OWNER, id, "expired");
      }
    });
    await scheduler.start();
    await scheduler.idle();

    const [old] = await store.routines.listRuns(OWNER, "crashed");
    expect(old).toMatchObject({ status: "interrupted", finishedAt: T0 });
    expect(old?.error).toMatch(/stopped/);
    expect(expired).toEqual(["orphan"]);
    // "busy" still has a live lease from another worker: skipped, slot advanced.
    expect(calls).toEqual([]);
    expect((await store.routines.get(OWNER, "busy"))?.nextRunAt).toBe(Date.parse("2026-11-09T08:00:00Z"));
    expect((await store.routines.listRuns(OWNER, "busy"))[0]?.status).toBe("running");
    await scheduler.stop();
  });

  test("an expired lease found later is recovered on a tick", async () => {
    let now = T0;
    const store = createMemoryStore();
    await store.routines.upsert(routine("r", { nextRunAt: T0 + 86_400_000 }));
    await store.routines.insertRun({ id: "x", routineId: "r", ownerId: OWNER, status: "running", startedAt: T0, costUsd: 0, leaseUntil: T0 + 300_000 });
    const scheduler = new RoutineScheduler({ store, ownerId: OWNER, runner: ok, createId: () => "n", now: () => now, tickMs: 60_000_000 });
    await scheduler.start();
    await scheduler.idle();
    expect((await store.routines.listRuns(OWNER, "r"))[0]?.status).toBe("running");
    now = T0 + 300_001;
    await scheduler.tick();
    expect((await store.routines.listRuns(OWNER, "r"))[0]?.status).toBe("interrupted");
    await scheduler.stop();
  });

  test("at most two runs at a time; the rest wait for a free slot", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const h = harness(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return { status: "succeeded" };
    });
    for (const id of ["a", "b", "c"]) await h.store.routines.upsert(routine(id, { nextRunAt: T0 - (id === "c" ? 1 : 10) }));
    await h.scheduler.start();
    await h.scheduler.tick();
    expect(active).toBe(2);
    expect((await h.store.routines.get(OWNER, "c"))?.nextRunAt).toBe(T0 - 1); // still due
    while (release.length) {
      release.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await h.scheduler.idle();
    expect(peak).toBe(2);
    expect((await h.store.routines.listRuns(OWNER, "c"))[0]?.status).toBe("succeeded");
    await h.scheduler.stop();
  });

  test("a transient failure is retried once with back-off", async () => {
    const outcomes: RunOutcome[] = [
      { status: "failed", error: "fetch failed", transient: true },
      { status: "succeeded", summary: "second time lucky" }
    ];
    const attempts: boolean[] = [];
    const h = harness(async (_r, handle) => {
      attempts.push(handle.lastAttempt);
      return outcomes.shift()!;
    });
    await h.store.routines.upsert(routine("a"));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(attempts).toEqual([false, true]);
    expect(h.sleeps).toEqual([60_000]);
    const runs = await h.store.routines.listRuns(OWNER, "a");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", summary: "second time lucky" });
    await h.scheduler.stop();
  });

  test("a permanent failure is not retried", async () => {
    let calls = 0;
    const h = harness(async () => (calls++, { status: "failed", error: "bad request" }));
    await h.store.routines.upsert(routine("a"));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(calls).toBe(1);
    expect(h.notifications[0]).toMatchObject({ kind: "failed" });
    expect(h.notifications[0]?.message).toContain("bad request");
    await h.scheduler.stop();
  });

  test("run now starts immediately and refuses a second concurrent run", async () => {
    let release!: () => void;
    const h = harness(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { status: "succeeded" };
    });
    await h.store.routines.upsert(routine("a", { nextRunAt: T0 + 86_400_000 }));
    await h.scheduler.start();
    expect(await h.scheduler.runNow("a")).toBeUndefined();
    await h.scheduler.tick();
    expect(h.scheduler.isRunning("a")).toBe(true);
    expect(await h.scheduler.runNow("a")).toMatch(/already running/);
    expect(await h.scheduler.runNow("missing")).toMatch(/not found/);
    release();
    await h.scheduler.idle();
    // A manual run does not move the schedule.
    expect((await h.store.routines.get(OWNER, "a"))?.nextRunAt).toBe(T0 + 86_400_000);
    await h.scheduler.stop();
  });

  test("stop interrupts active runs", async () => {
    const h = harness(
      (_r, _handle, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "interrupted", error: "stopped" })))
    );
    await h.store.routines.upsert(routine("a"));
    await h.scheduler.start();
    await h.scheduler.tick();
    await h.scheduler.stop();
    expect((await h.store.routines.listRuns(OWNER, "a"))[0]?.status).toBe("interrupted");
  });
});
