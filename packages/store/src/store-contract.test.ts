/**
 * One contract suite, run against the in-memory store and the SQLite store,
 * so both implementations are proven to behave identically.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryStore,
  type ApprovalRecord,
  type ArtifactRecord,
  type ConversationRecord,
  type RoutineRecord,
  type RoutineRunRecord,
  type SpaceRecord,
  type Store,
  type StoredMessage,
  type UsageEvent
} from "@open-gpt-live/core";
import { createSqliteStore, openStore, SCHEMA_VERSION } from "./index";

interface Harness {
  name: string;
  open(): { store: Store; cleanup(): void };
}

const harnesses: Harness[] = [
  { name: "memory", open: () => ({ store: createMemoryStore(), cleanup() {} }) },
  {
    name: "sqlite",
    open() {
      const dir = mkdtempSync(join(tmpdir(), "sibyl-store-"));
      const store = createSqliteStore({ file: join(dir, "sibyl.db") });
      return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    }
  }
];

const msg = (id: string, createdAt: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({
  id,
  role: "user",
  content: `content ${id}`,
  requestId: `req-${id}`,
  createdAt,
  ...extra
});

const conv = (id: string, ownerId: string, updatedAt: number, messages: StoredMessage[] = []): ConversationRecord => ({
  id,
  ownerId,
  title: `title ${id}`,
  createdAt: updatedAt,
  updatedAt,
  messages
});

const approval = (id: string, ownerId: string, createdAt: number, extra: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id,
  ownerId,
  runId: "run-1",
  toolName: "email.send",
  title: "Send email",
  summary: "Send an email to a@b.c",
  input: { to: "a@b.c", nested: { list: [1, 2, 3] } },
  status: "pending",
  createdAt,
  ...extra
});

const usage = (id: string, ownerId: string, at: number, costUsd: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  id,
  at,
  ownerId,
  feature: "voice",
  model: "m",
  costUsd,
  estimated: false,
  ...extra
});

const routine = (id: string, ownerId: string, extra: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id,
  ownerId,
  name: `routine ${id}`,
  instruction: "do it",
  cron: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...extra
});

const run = (id: string, routineId: string, ownerId: string, startedAt: number, extra: Partial<RoutineRunRecord> = {}): RoutineRunRecord => ({
  id,
  routineId,
  ownerId,
  status: "running",
  startedAt,
  costUsd: 0,
  ...extra
});

const artifact = (id: string, ownerId: string, createdAt: number, extra: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  id,
  ownerId,
  kind: "slides",
  title: `artifact ${id}`,
  version: 1,
  meta: { presentationId: id, exports: { pdf: "/x.pdf" } },
  createdAt,
  ...extra
});

const space = (id: string, ownerId: string, extra: Partial<SpaceRecord> = {}): SpaceRecord => ({
  id,
  ownerId,
  name: `space ${id}`,
  createdAt: 1,
  updatedAt: 1,
  ...extra
});

for (const harness of harnesses) {
  describe(`Store contract: ${harness.name}`, () => {
    let store: Store;
    let cleanup: () => void;

    beforeEach(() => {
      ({ store, cleanup } = harness.open());
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    describe("conversations", () => {
      it("upserts, gets with messages in order, and enforces ownership", async () => {
        const steps: StoredMessage["steps"] = [{ callId: "c1", toolName: "web.search", title: "Search", status: "ok" }];
        await store.conversations.upsert(
          conv("c1", "alice", 10, [msg("m1", 5), msg("m2", 6, { role: "assistant", ui: "<ui/>", kind: "brain", steps })])
        );
        const got = await store.conversations.get("alice", "c1");
        expect(got).toEqual(conv("c1", "alice", 10, [msg("m1", 5), msg("m2", 6, { role: "assistant", ui: "<ui/>", kind: "brain", steps })]));
        expect(await store.conversations.get("bob", "c1")).toBeUndefined();
        expect(await store.conversations.get("alice", "missing")).toBeUndefined();
      });

      it("returns copies, not live references", async () => {
        await store.conversations.upsert(conv("c1", "alice", 10, [msg("m1", 5)]));
        const got = await store.conversations.get("alice", "c1");
        got!.messages.push(msg("m2", 6));
        got!.title = "changed";
        expect(await store.conversations.get("alice", "c1")).toEqual(conv("c1", "alice", 10, [msg("m1", 5)]));
      });

      it("upsert replaces the whole record including messages", async () => {
        await store.conversations.upsert(conv("c1", "alice", 10, [msg("m1", 5), msg("m2", 6)]));
        await store.conversations.upsert({ ...conv("c1", "alice", 20, [msg("m3", 7)]), title: "renamed" });
        expect(await store.conversations.get("alice", "c1")).toEqual({ ...conv("c1", "alice", 20, [msg("m3", 7)]), title: "renamed" });
      });

      it("lists summaries by updatedAt desc with insertion-order ties and a limit", async () => {
        await store.conversations.upsert(conv("a", "alice", 10, [msg("m1", 1)]));
        await store.conversations.upsert(conv("b", "alice", 30));
        await store.conversations.upsert(conv("c", "alice", 20));
        await store.conversations.upsert(conv("d", "alice", 20));
        await store.conversations.upsert(conv("x", "bob", 99));
        const list = await store.conversations.list("alice");
        expect(list.map((c) => c.id)).toEqual(["b", "c", "d", "a"]);
        expect(list[3]).toEqual({ id: "a", ownerId: "alice", title: "title a", createdAt: 10, updatedAt: 10 });
        expect(list[3]).not.toHaveProperty("messages");
        expect((await store.conversations.list("alice", 2)).map((c) => c.id)).toEqual(["b", "c"]);
        // Re-upserting keeps the original insertion position for ties.
        await store.conversations.upsert(conv("c", "alice", 20));
        expect((await store.conversations.list("alice")).map((c) => c.id)).toEqual(["b", "c", "d", "a"]);
      });

      it("appendMessage appends and only moves updatedAt forward", async () => {
        await store.conversations.upsert(conv("c1", "alice", 100));
        await store.conversations.appendMessage("alice", "c1", msg("m1", 150));
        await store.conversations.appendMessage("alice", "c1", msg("m2", 120));
        const got = await store.conversations.get("alice", "c1");
        expect(got?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
        expect(got?.updatedAt).toBe(150);
      });

      it("appendMessage rejects unknown conversations and other owners", async () => {
        await store.conversations.upsert(conv("c1", "alice", 100));
        await expect(store.conversations.appendMessage("bob", "c1", msg("m1", 1))).rejects.toThrow("conversation not found");
        await expect(store.conversations.appendMessage("alice", "nope", msg("m1", 1))).rejects.toThrow("conversation not found");
        expect((await store.conversations.get("alice", "c1"))?.messages).toEqual([]);
      });

      it("remove only deletes the owner's conversation", async () => {
        await store.conversations.upsert(conv("c1", "alice", 100, [msg("m1", 1)]));
        await store.conversations.remove("bob", "c1");
        expect(await store.conversations.get("alice", "c1")).toBeDefined();
        await store.conversations.remove("alice", "c1");
        expect(await store.conversations.get("alice", "c1")).toBeUndefined();
        expect(await store.conversations.list("alice")).toEqual([]);
        // Re-creating the id starts with no stale messages.
        await store.conversations.upsert(conv("c1", "alice", 100));
        expect((await store.conversations.get("alice", "c1"))?.messages).toEqual([]);
      });
    });

    describe("approvals", () => {
      it("creates, gets by owner, and lists pending oldest first", async () => {
        await store.approvals.create(approval("a2", "alice", 20));
        await store.approvals.create(approval("a1", "alice", 10, { conversationId: "c1" }));
        await store.approvals.create(approval("a3", "alice", 20));
        await store.approvals.create(approval("b1", "bob", 5));
        expect(await store.approvals.get("alice", "a1")).toEqual(approval("a1", "alice", 10, { conversationId: "c1" }));
        expect(await store.approvals.get("bob", "a1")).toBeUndefined();
        expect((await store.approvals.listPending("alice")).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
      });

      it("decides only from pending, only for the owner", async () => {
        await store.approvals.create(approval("a1", "alice", 10));
        expect(await store.approvals.decide("bob", "a1", "approved", 50)).toBeUndefined();
        expect(await store.approvals.decide("alice", "missing", "approved", 50)).toBeUndefined();
        const decided = await store.approvals.decide("alice", "a1", "approved", 50);
        expect(decided).toEqual({ ...approval("a1", "alice", 10), status: "approved", decidedAt: 50 });
        expect(await store.approvals.decide("alice", "a1", "declined", 60)).toBeUndefined();
        expect(await store.approvals.get("alice", "a1")).toEqual(decided);
        expect(await store.approvals.listPending("alice")).toEqual([]);
      });

      it("defaults decidedAt to now", async () => {
        await store.approvals.create(approval("a1", "alice", 10));
        const before = Date.now();
        const decided = await store.approvals.decide("alice", "a1", "expired");
        expect(decided?.decidedAt).toBeGreaterThanOrEqual(before);
        expect(decided?.status).toBe("expired");
      });
    });

    describe("usage", () => {
      it("sums cost in [from, to) per owner with optional routine filter", async () => {
        await store.usage.insert(usage("u1", "alice", 100, 0.1));
        await store.usage.insert(usage("u2", "alice", 150, 0.2, { routineId: "r1", feature: "routine" }));
        await store.usage.insert(usage("u3", "alice", 200, 0.4));
        await store.usage.insert(usage("u4", "bob", 120, 5));
        expect(await store.usage.sum("alice", 100, 200)).toBe(0.1 + 0.2);
        expect(await store.usage.sum("alice", 0, 1000)).toBe(0.1 + 0.2 + 0.4);
        expect(await store.usage.sum("alice", 0, 1000, { routineId: "r1" })).toBe(0.2);
        expect(await store.usage.sum("alice", 0, 1000, { routineId: "" })).toBe(0.1 + 0.2 + 0.4);
        expect(await store.usage.sum("carol", 0, 1000)).toBe(0);
      });

      it("groups cost by feature", async () => {
        await store.usage.insert(usage("u1", "alice", 100, 0.1));
        await store.usage.insert(usage("u2", "alice", 110, 0.2, { feature: "brain" }));
        await store.usage.insert(usage("u3", "alice", 120, 0.3));
        await store.usage.insert(usage("u4", "alice", 500, 9));
        await store.usage.insert(usage("u5", "bob", 100, 9));
        expect(await store.usage.byFeature("alice", 100, 500)).toEqual({ voice: 0.1 + 0.3, brain: 0.2 });
        expect(await store.usage.byFeature("alice", 600, 700)).toEqual({});
      });
    });

    describe("routines", () => {
      it("upserts, lists in insertion order, gets and removes by owner", async () => {
        await store.routines.upsert(routine("r2", "alice"));
        await store.routines.upsert(routine("r1", "alice", { maxRunUsd: 0.5, conversationId: "c1" }));
        await store.routines.upsert(routine("rb", "bob"));
        await store.routines.upsert(routine("r2", "alice", { name: "renamed" }));
        expect((await store.routines.list("alice")).map((r) => [r.id, r.name])).toEqual([
          ["r2", "renamed"],
          ["r1", "routine r1"]
        ]);
        expect(await store.routines.get("alice", "r1")).toEqual(routine("r1", "alice", { maxRunUsd: 0.5, conversationId: "c1" }));
        expect(await store.routines.get("bob", "r1")).toBeUndefined();
        await store.routines.remove("bob", "r1");
        expect(await store.routines.get("alice", "r1")).toBeDefined();
        await store.routines.remove("alice", "r1");
        expect(await store.routines.get("alice", "r1")).toBeUndefined();
      });

      it("due() returns enabled routines with nextRunAt <= now for any owner", async () => {
        await store.routines.upsert(routine("r1", "alice", { nextRunAt: 100 }));
        await store.routines.upsert(routine("r2", "bob", { nextRunAt: 50 }));
        await store.routines.upsert(routine("r3", "alice", { nextRunAt: 101 }));
        await store.routines.upsert(routine("r4", "alice", { nextRunAt: 10, enabled: false }));
        await store.routines.upsert(routine("r5", "alice"));
        expect((await store.routines.due(100)).map((r) => r.id)).toEqual(["r1", "r2"]);
        await store.routines.upsert(routine("r4", "alice", { nextRunAt: 10, enabled: true }));
        expect((await store.routines.due(100)).map((r) => r.id)).toEqual(["r1", "r2", "r4"]);
      });

      it("records runs and lists newest first with a limit", async () => {
        await store.routines.insertRun(run("x1", "r1", "alice", 10));
        await store.routines.insertRun(run("x2", "r1", "alice", 30));
        await store.routines.insertRun(run("x3", "r1", "alice", 20));
        await store.routines.insertRun(run("x4", "r2", "alice", 40));
        await store.routines.insertRun(run("x5", "r1", "bob", 50));
        await store.routines.updateRun(run("x1", "r1", "alice", 10, { status: "succeeded", finishedAt: 12, costUsd: 0.3, summary: "ok" }));
        const runs = await store.routines.listRuns("alice", "r1");
        expect(runs.map((r) => r.id)).toEqual(["x2", "x3", "x1"]);
        expect(runs[2]).toEqual(run("x1", "r1", "alice", 10, { status: "succeeded", finishedAt: 12, costUsd: 0.3, summary: "ok" }));
        expect((await store.routines.listRuns("alice", "r1", 1)).map((r) => r.id)).toEqual(["x2"]);
      });
    });

    describe("artifacts", () => {
      it("creates, gets by owner and lists newest first with filters", async () => {
        await store.artifacts.create(artifact("a1", "alice", 10, { spaceId: "s1" }));
        await store.artifacts.create(artifact("a2", "alice", 30, { kind: "file" }));
        await store.artifacts.create(artifact("a3", "alice", 20, { spaceId: "s1", parentId: "a1", version: 2 }));
        await store.artifacts.create(artifact("b1", "bob", 40));
        expect(await store.artifacts.get("alice", "a3")).toEqual(artifact("a3", "alice", 20, { spaceId: "s1", parentId: "a1", version: 2 }));
        expect(await store.artifacts.get("bob", "a3")).toBeUndefined();
        expect((await store.artifacts.list("alice")).map((a) => a.id)).toEqual(["a2", "a3", "a1"]);
        expect((await store.artifacts.list("alice", { spaceId: "s1" })).map((a) => a.id)).toEqual(["a3", "a1"]);
        expect((await store.artifacts.list("alice", { kind: "file" })).map((a) => a.id)).toEqual(["a2"]);
        expect((await store.artifacts.list("alice", { kind: "slides", spaceId: "s1" })).map((a) => a.id)).toEqual(["a3", "a1"]);
      });
    });

    describe("spaces", () => {
      it("upserts, lists, gets and removes by owner", async () => {
        await store.spaces.upsert(space("s1", "alice", { instructions: "be brief" }));
        await store.spaces.upsert(space("s2", "alice"));
        await store.spaces.upsert(space("s3", "bob"));
        await store.spaces.upsert(space("s1", "alice", { template: "t" }));
        expect((await store.spaces.list("alice")).map((s) => s.id)).toEqual(["s1", "s2"]);
        expect(await store.spaces.get("alice", "s1")).toEqual(space("s1", "alice", { template: "t" }));
        expect(await store.spaces.get("bob", "s1")).toBeUndefined();
        await store.spaces.remove("bob", "s1");
        expect(await store.spaces.get("alice", "s1")).toBeDefined();
        await store.spaces.remove("alice", "s1");
        expect((await store.spaces.list("alice")).map((s) => s.id)).toEqual(["s2"]);
      });
    });

    describe("kv", () => {
      it("stores JSON values per owner", async () => {
        await store.kv.set("alice", "prefs", { voice: "a", list: [1, 2], nested: { ok: true } });
        await store.kv.set("bob", "prefs", 42);
        await store.kv.set("alice", "flag", false);
        expect(await store.kv.get("alice", "prefs")).toEqual({ voice: "a", list: [1, 2], nested: { ok: true } });
        expect(await store.kv.get("bob", "prefs")).toBe(42);
        expect(await store.kv.get("alice", "flag")).toBe(false);
        expect(await store.kv.get("alice", "missing")).toBeUndefined();
        await store.kv.set("alice", "prefs", "replaced");
        expect(await store.kv.get("alice", "prefs")).toBe("replaced");
        await store.kv.delete("alice", "prefs");
        expect(await store.kv.get("alice", "prefs")).toBeUndefined();
        expect(await store.kv.get("bob", "prefs")).toBe(42);
      });

      it("returns copies of stored values", async () => {
        await store.kv.set("alice", "obj", { n: 1 });
        const value = await store.kv.get<{ n: number }>("alice", "obj");
        value!.n = 2;
        expect(await store.kv.get("alice", "obj")).toEqual({ n: 1 });
      });
    });
  });
}

describe("SQLite store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sibyl-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists across reopen and records the schema version", async () => {
    const file = join(dir, "nested", "sibyl.db");
    const first = createSqliteStore({ file });
    await first.conversations.upsert(conv("c1", "alice", 10, [msg("m1", 5)]));
    await first.kv.set("alice", "k", { a: 1 });
    await first.close();
    await first.close(); // idempotent

    const second = createSqliteStore({ file });
    expect(await second.conversations.get("alice", "c1")).toEqual(conv("c1", "alice", 10, [msg("m1", 5)]));
    expect(await second.kv.get("alice", "k")).toEqual({ a: 1 });
    await second.close();

    const raw = new DatabaseSync(file);
    expect(raw.prepare("SELECT version FROM schema_version").all()).toEqual([{ version: SCHEMA_VERSION }]);
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    raw.close();
  });

  it("refuses a database from a newer schema", async () => {
    const file = join(dir, "sibyl.db");
    await createSqliteStore({ file }).close();
    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION + 1);
    raw.close();
    expect(() => createSqliteStore({ file })).toThrow(/newer/);
  });

  it("openStore picks memory or sqlite from the environment", async () => {
    const memory = openStore({ SIBYL_STORAGE: "memory" });
    expect(memory.kind).toBe("memory");
    await memory.store.close();
    const sqlite = openStore({ SIBYL_DATA_DIR: dir });
    expect(sqlite).toMatchObject({ kind: "sqlite", file: join(dir, "sibyl.db") });
    await sqlite.store.close();
  });
});
