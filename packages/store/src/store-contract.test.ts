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
  randomAvatar,
  type AgentMemoryItem,
  type AgentRecord,
  type SkillProposal,
  type ApprovalRecord,
  type ArtifactRecord,
  type AuditRecord,
  type ConversationRecord,
  type RoutineRecord,
  type RoutineRunRecord,
  type SpaceRecord,
  type Store,
  type StoredMessage,
  type UsageEvent,
  type InviteRecord,
  type MeetingComment,
  type MeetingRecord,
  type MonitorEventRecord,
  type MonitorRecord,
  type NotificationRecord,
  type SessionRecord,
  type UserRecord
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

      it("lists events in a range, oldest first, with their attribution", async () => {
        await store.usage.insert(usage("u1", "alice", 100, 0.1, { userId: "user-1", workspaceId: "w1" }));
        await store.usage.insert(usage("u2", "alice", 150, 0.2));
        await store.usage.insert(usage("u3", "alice", 300, 0.3));
        await store.usage.insert(usage("u4", "bob", 120, 9));
        const listed = await store.usage.list("alice", 100, 300);
        expect(listed.map((e) => e.id)).toEqual(["u1", "u2"]);
        expect(listed[0]).toMatchObject({ userId: "user-1", workspaceId: "w1", costUsd: 0.1 });
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

/* ───────────── Identity (v0.4): users, memberships, invites, sessions ───────────── */

for (const harness of harnesses) {
  describe(`Identity contract: ${harness.name}`, () => {
    let store: Store;
    let cleanup: () => void;
    const user = (id: string, email: string, createdAt = 1, orgId = "owner"): UserRecord => ({
      id,
      orgId,
      email,
      name: `User ${id}`,
      passwordHash: "scrypt$x",
      createdAt
    });

    beforeEach(() => {
      ({ store, cleanup } = harness.open());
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    it("stores users with lower-cased unique emails per organization", async () => {
      const { users } = store.identity;
      expect(await users.count("owner")).toBe(0);
      await users.upsert(user("u1", "Ada@Example.com", 2));
      await users.upsert(user("u2", "bob@example.com", 1));
      await users.upsert(user("u3", "ada@example.com", 1, "other-org"));
      expect(await users.count("owner")).toBe(2);
      expect((await users.list("owner")).map((u) => u.id)).toEqual(["u2", "u1"]);
      expect((await users.getByEmail("owner", " ADA@example.com "))?.id).toBe("u1");
      expect((await users.get("owner", "u1"))?.email).toBe("ada@example.com");
      expect(await users.get("other-org", "u1")).toBeUndefined();
      await expect(users.upsert(user("u4", "ada@EXAMPLE.com"))).rejects.toThrow(/already exists/);
      // Updating the same user keeps working.
      await users.upsert({ ...user("u1", "ada@example.com", 2), name: "Ada L", disabledAt: 5 });
      expect(await users.get("owner", "u1")).toMatchObject({ name: "Ada L", disabledAt: 5 });
    });

    it("records last activity, only moving forward and only within the organization", async () => {
      const { users } = store.identity;
      await users.upsert(user("u1", "ada@example.com"));
      await users.touch("owner", "u1", 100);
      expect((await users.get("owner", "u1"))?.lastActiveAt).toBe(100);
      await users.touch("owner", "u1", 50);
      expect((await users.get("owner", "u1"))?.lastActiveAt).toBe(100);
      await users.touch("other-org", "u1", 500);
      await users.touch("owner", "missing", 500);
      expect((await users.get("owner", "u1"))?.lastActiveAt).toBe(100);
      await users.touch("owner", "u1", 200);
      // Other fields are untouched.
      expect(await users.get("owner", "u1")).toMatchObject({ email: "ada@example.com", name: "User u1", lastActiveAt: 200 });
    });

    it("keeps one membership per user and scope", async () => {
      const { memberships } = store.identity;
      await memberships.upsert("owner", { userId: "u1", scope: "org", role: "owner" });
      await memberships.upsert("owner", { userId: "u1", scope: { workspaceId: "default" }, role: "member" });
      await memberships.upsert("owner", { userId: "u2", scope: { workspaceId: "default" }, role: "viewer" });
      await memberships.upsert("owner", { userId: "u1", scope: { workspaceId: "default" }, role: "admin" });
      await memberships.upsert("other", { userId: "u1", scope: "org", role: "viewer" });
      expect(await memberships.listForUser("owner", "u1")).toEqual([
        { userId: "u1", scope: "org", role: "owner" },
        { userId: "u1", scope: { workspaceId: "default" }, role: "admin" }
      ]);
      expect((await memberships.listForScope("owner", { workspaceId: "default" })).map((m) => [m.userId, m.role])).toEqual([
        ["u1", "admin"],
        ["u2", "viewer"]
      ]);
      // The whole organization, in insertion order; other organizations stay out.
      expect((await memberships.list("owner")).map((m) => [m.userId, m.scope === "org" ? "org" : m.scope.workspaceId, m.role])).toEqual([
        ["u1", "org", "owner"],
        ["u1", "default", "admin"],
        ["u2", "default", "viewer"]
      ]);
      await memberships.remove("owner", "u2", { workspaceId: "default" });
      expect(await memberships.listForScope("owner", { workspaceId: "default" })).toHaveLength(1);
      await memberships.removeScope("owner", { workspaceId: "default" });
      expect(await memberships.listForUser("owner", "u1")).toEqual([{ userId: "u1", scope: "org", role: "owner" }]);
      expect(await memberships.listForScope("other", "org")).toHaveLength(1);
    });

    it("accepts an invite exactly once and lists pending ones", async () => {
      const { invites } = store.identity;
      const invite = (id: string, createdAt: number, extra: Partial<InviteRecord> = {}): InviteRecord => ({
        id,
        orgId: "owner",
        tokenHash: `hash-${id}`,
        workspaceId: "default",
        role: "member",
        invitedBy: "u1",
        createdAt,
        expiresAt: 100,
        ...extra
      });
      await invites.create(invite("i1", 1));
      await invites.create(invite("i2", 2, { workspaceId: "ws2", email: "c@example.com" }));
      await invites.create(invite("i3", 3, { expiresAt: 10 }));
      expect((await invites.getByTokenHash("hash-i2"))?.id).toBe("i2");
      expect(await invites.getByTokenHash("nope")).toBeUndefined();
      expect((await invites.list("owner")).map((i) => i.id)).toEqual(["i3", "i2", "i1"]);
      expect((await invites.list("owner", { workspaceId: "default" })).map((i) => i.id)).toEqual(["i3", "i1"]);
      expect((await invites.list("owner", { pendingAt: 50 })).map((i) => i.id)).toEqual(["i2", "i1"]);
      expect(await invites.accept("owner", "i1", "u9", 20)).toMatchObject({ acceptedAt: 20, acceptedBy: "u9" });
      expect(await invites.accept("owner", "i1", "u10", 21)).toBeUndefined();
      expect(await invites.accept("other", "i2", "u10", 21)).toBeUndefined();
      expect((await invites.list("owner", { pendingAt: 50 })).map((i) => i.id)).toEqual(["i2"]);
      await invites.remove("owner", "i2");
      expect(await invites.get("owner", "i2")).toBeUndefined();
      expect(await invites.get("owner", "i1")).toMatchObject({ acceptedBy: "u9" });
    });

    it("finds sessions by token hash, slides expiry and prunes", async () => {
      const { sessions } = store.identity;
      const session = (id: string, userId: string, expiresAt: number): SessionRecord => ({
        id,
        tokenHash: `t-${id}`,
        userId,
        orgId: "owner",
        createdAt: 1,
        expiresAt,
        lastSeenAt: 1
      });
      await sessions.create(session("s1", "u1", 10));
      await sessions.create(session("s2", "u1", 50));
      await sessions.create(session("s3", "u2", 50));
      await sessions.touch("s1", 5, 60);
      expect(await sessions.getByTokenHash("t-s1")).toMatchObject({ lastSeenAt: 5, expiresAt: 60 });
      expect(await sessions.prune(55)).toBe(2);
      expect(await sessions.getByTokenHash("t-s2")).toBeUndefined();
      await sessions.create(session("s4", "u2", 99));
      await sessions.removeForUser("u2");
      expect(await sessions.getByTokenHash("t-s4")).toBeUndefined();
      await sessions.remove("s1");
      expect(await sessions.getByTokenHash("t-s1")).toBeUndefined();
    });

    it("keeps a conversation's creator and workspace", async () => {
      await store.conversations.upsert({ ...conv("c1", "owner", 5), workspaceId: "ws2", createdBy: "u1" });
      expect(await store.conversations.get("owner", "c1")).toMatchObject({ workspaceId: "ws2", createdBy: "u1" });
      expect((await store.conversations.list("owner", 10, { workspaceId: "ws2" }))[0]).toMatchObject({ createdBy: "u1" });
    });
  });
}

/* ───────────── Monitors (v0.4): watched sources and fired events ───────────── */

for (const harness of harnesses) {
  describe(`Monitors contract: ${harness.name}`, () => {
    let store: Store;
    let cleanup: () => void;
    beforeEach(() => {
      ({ store, cleanup } = harness.open());
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    const monitor = (id: string, ownerId: string, extra: Partial<MonitorRecord> = {}): MonitorRecord => ({
      id,
      ownerId,
      workspaceId: "default",
      createdBy: "u1",
      name: `monitor ${id}`,
      source: { kind: "rss", url: "https://example.com/feed.xml" },
      schedule: { everyMinutes: 15 },
      condition: { filter: [{ path: "title", op: "contains", value: "launch" }], ask: "Is it about a launch?" },
      actions: [{ kind: "notify", channels: ["inbox"] }],
      dedupe: {},
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      ...extra
    });
    const event = (id: string, monitorId: string, at: number, extra: Partial<MonitorEventRecord> = {}): MonitorEventRecord => ({
      id,
      monitorId,
      ownerId: "owner",
      workspaceId: "default",
      createdBy: "u1",
      at,
      kind: "fired",
      summary: `event ${id}`,
      items: [{ key: "k", title: "t", url: "https://example.com/a" }],
      links: ["https://example.com/a"],
      costUsd: 0.001,
      actions: [{ kind: "notify", channel: "inbox", status: "sent" }],
      ...extra
    });

    it("round-trips monitors with owner and workspace scoping", async () => {
      const record = monitor("m1", "owner", { agentId: "a1", budget: { dailyUsd: 0.5 }, state: { seen: { x: "h" } }, nextCheckAt: 10 });
      await store.monitors.upsert(record);
      await store.monitors.upsert(monitor("m2", "owner", { workspaceId: "ws2" }));
      await store.monitors.upsert(monitor("m3", "other"));
      expect(await store.monitors.get("owner", "m1")).toEqual(record);
      expect(await store.monitors.get("other", "m1")).toBeUndefined();
      expect((await store.monitors.list("owner")).map((m) => m.id)).toEqual(["m1", "m2"]);
      expect((await store.monitors.list("owner", { workspaceId: "ws2" })).map((m) => m.id)).toEqual(["m2"]);
      await store.monitors.upsert({ ...record, name: "renamed" });
      expect((await store.monitors.get("owner", "m1"))?.name).toBe("renamed");
    });

    it("returns due monitors: enabled with nextCheckAt ≤ now, oldest first", async () => {
      await store.monitors.upsert(monitor("late", "owner", { nextCheckAt: 30 }));
      await store.monitors.upsert(monitor("early", "owner", { nextCheckAt: 10 }));
      await store.monitors.upsert(monitor("paused", "owner", { nextCheckAt: 5, enabled: false }));
      await store.monitors.upsert(monitor("hook", "x", { source: { kind: "webhook", secretRef: "HOOK" } }));
      await store.monitors.upsert(monitor("future", "y", { nextCheckAt: 100 }));
      expect((await store.monitors.due(50)).map((m) => m.id)).toEqual(["early", "late"]);
      const { nextCheckAt: _drop, ...early } = monitor("early", "owner");
      await store.monitors.upsert(early);
      expect((await store.monitors.due(50)).map((m) => m.id)).toEqual(["late"]);
    });

    it("lists events newest first with filters, and removes them with the monitor", async () => {
      await store.monitors.upsert(monitor("m1", "owner"));
      await store.monitors.upsert(monitor("m2", "owner"));
      await store.monitors.insertEvent(event("e1", "m1", 10));
      await store.monitors.insertEvent(event("e2", "m1", 30, { runId: "run-1" }));
      await store.monitors.insertEvent(event("e3", "m2", 20, { createdBy: "u2", workspaceId: "ws2" }));
      await store.monitors.insertEvent(event("e4", "m1", 40, { ownerId: "other" }));
      expect((await store.monitors.listEvents("owner")).map((e) => e.id)).toEqual(["e2", "e3", "e1"]);
      expect((await store.monitors.listEvents("owner", { monitorId: "m1" })).map((e) => e.id)).toEqual(["e2", "e1"]);
      expect((await store.monitors.listEvents("owner", { createdBy: "u1" })).map((e) => e.id)).toEqual(["e2", "e1"]);
      expect((await store.monitors.listEvents("owner", { workspaceId: "ws2" })).map((e) => e.id)).toEqual(["e3"]);
      expect((await store.monitors.listEvents("owner", { before: 30, limit: 1 })).map((e) => e.id)).toEqual(["e3"]);
      expect((await store.monitors.listEvents("owner", { monitorId: "m1" }))[0]).toEqual(event("e2", "m1", 30, { runId: "run-1" }));
      await store.monitors.remove("other", "m1"); // not theirs: nothing happens
      expect(await store.monitors.get("owner", "m1")).toBeDefined();
      await store.monitors.remove("owner", "m1");
      expect(await store.monitors.get("owner", "m1")).toBeUndefined();
      expect((await store.monitors.listEvents("owner")).map((e) => e.id)).toEqual(["e3"]);
    });
  });
}

/* ───────────── Agents (v0.4): agents, agent memory, skill proposals ───────────── */

for (const harness of harnesses) {
  describe(`Agents contract: ${harness.name}`, () => {
    let store: Store;
    let cleanup: () => void;
    beforeEach(() => {
      ({ store, cleanup } = harness.open());
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    const agent = (id: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
      id,
      ownerId: "org",
      workspaceId: "default",
      createdBy: "u1",
      name: `Agent ${id}`,
      description: "helps",
      avatar: randomAvatar(id),
      instructions: "Be helpful.",
      access: { mode: "inherit" },
      autonomy: "ask_first",
      learning: "ask_first",
      visibility: "private",
      createdAt: 1,
      updatedAt: 1,
      ...extra
    });
    const memo = (id: string, agentId: string, text: string, updatedAt: number, kind: AgentMemoryItem["kind"] = "fact"): AgentMemoryItem => ({
      id,
      ownerId: "org",
      agentId,
      kind,
      text,
      source: "user",
      createdAt: updatedAt,
      updatedAt
    });
    const proposal = (id: string, agentId: string, createdAt: number, status: SkillProposal["status"] = "pending"): SkillProposal => ({
      id,
      ownerId: "org",
      agentId,
      kind: "new",
      skill: { name: `skill-${id}`, title: "T", description: "D", instructions: "# Steps" },
      rationale: "Worked well",
      sourceRunId: "run-1",
      status,
      createdAt
    });

    it("lists agents by workspace and visibility, ordered by name, scoped by owner", async () => {
      await store.agents.upsert(agent("b", { name: "Bravo", visibility: "workspace" }));
      await store.agents.upsert(agent("a", { name: "Alpha" }));
      await store.agents.upsert(agent("c", { name: "Charlie", createdBy: "u2" }));
      await store.agents.upsert(agent("d", { name: "Delta", workspaceId: "w2" }));
      await store.agents.upsert(agent("x", { ownerId: "other" }));
      expect((await store.agents.list("org")).map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
      expect((await store.agents.list("org", { workspaceId: "default" })).map((a) => a.id)).toEqual(["a", "b", "c"]);
      expect((await store.agents.list("org", { workspaceId: "default", visibleTo: "u1" })).map((a) => a.id)).toEqual(["a", "b"]);
      expect((await store.agents.list("org", { visibleTo: "u2" })).map((a) => a.id)).toEqual(["b", "c"]);
      expect(await store.agents.get("other", "a")).toBeUndefined();
      expect(await store.agents.get("org", "a")).toEqual(agent("a", { name: "Alpha" }));
      await store.agents.upsert(agent("a", { name: "Alpha 2", updatedAt: 5 }));
      expect((await store.agents.get("org", "a"))?.name).toBe("Alpha 2");
    });

    it("keeps agent memory per agent, newest first, with kind filter, limit and search", async () => {
      await store.agents.upsert(agent("a"));
      await store.agents.upsert(agent("b"));
      await store.agentMemory.upsert(memo("m1", "a", "The user prefers short bullet summaries", 1));
      await store.agentMemory.upsert(memo("m2", "a", "Quarterly report for the Berlin office", 3, "run"));
      await store.agentMemory.upsert(memo("m3", "a", "Team standup is on Mondays", 2));
      await store.agentMemory.upsert(memo("m4", "b", "Berlin deals pipeline", 4));
      expect((await store.agentMemory.list("org", "a")).map((m) => m.id)).toEqual(["m2", "m3", "m1"]);
      expect((await store.agentMemory.list("org", "a", { kind: "fact" })).map((m) => m.id)).toEqual(["m3", "m1"]);
      expect((await store.agentMemory.list("org", "a", { limit: 1 })).map((m) => m.id)).toEqual(["m2"]);
      expect((await store.agentMemory.search("org", "a", "berlin report")).map((m) => m.id)).toEqual(["m2"]);
      expect(await store.agentMemory.search("org", "a", "   ")).toEqual([]);
      // Edits re-index the text.
      await store.agentMemory.upsert(memo("m2", "a", "Pricing notes for Lisbon", 5, "run"));
      expect(await store.agentMemory.search("org", "a", "berlin")).toEqual([]);
      expect((await store.agentMemory.search("org", "a", "lisbon")).map((m) => m.id)).toEqual(["m2"]);
      expect(await store.agentMemory.get("other", "m1")).toBeUndefined();
      await store.agentMemory.remove("other", "m1");
      expect(await store.agentMemory.get("org", "m1")).toBeDefined();
      await store.agentMemory.remove("org", "m1");
      expect(await store.agentMemory.get("org", "m1")).toBeUndefined();
    });

    it("stores skill proposals with agent and status filters", async () => {
      await store.agents.upsert(agent("a"));
      await store.skillProposals.upsert(proposal("p1", "a", 1));
      await store.skillProposals.upsert(proposal("p2", "a", 2, "applied"));
      await store.skillProposals.upsert(proposal("p3", "b", 3));
      expect((await store.skillProposals.list("org")).map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
      expect((await store.skillProposals.list("org", { agentId: "a" })).map((p) => p.id)).toEqual(["p2", "p1"]);
      expect((await store.skillProposals.list("org", { status: "pending" })).map((p) => p.id)).toEqual(["p3", "p1"]);
      await store.skillProposals.upsert({ ...proposal("p1", "a", 1), status: "rejected", decidedAt: 9 });
      expect((await store.skillProposals.get("org", "p1"))?.status).toBe("rejected");
      await store.skillProposals.remove("org", "p3");
      expect(await store.skillProposals.get("org", "p3")).toBeUndefined();
    });

    it("removing an agent removes its memory and proposals", async () => {
      await store.agents.upsert(agent("a"));
      await store.agentMemory.upsert(memo("m1", "a", "alpha fact", 1));
      await store.skillProposals.upsert(proposal("p1", "a", 1));
      await store.agents.remove("other", "a");
      expect(await store.agents.get("org", "a")).toBeDefined();
      await store.agents.remove("org", "a");
      expect(await store.agents.get("org", "a")).toBeUndefined();
      expect(await store.agentMemory.list("org", "a")).toEqual([]);
      expect(await store.agentMemory.search("org", "a", "alpha")).toEqual([]);
      expect(await store.skillProposals.list("org", { agentId: "a" })).toEqual([]);
    });
  });
}

/* ───────────── Notifications (v0.4): one record for everything Sibyl tells people ───────────── */

for (const harness of harnesses) {
  describe(`Notifications contract: ${harness.name}`, () => {
    let store: Store;
    let cleanup: () => void;
    beforeEach(() => {
      ({ store, cleanup } = harness.open());
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    const note = (id: string, createdAt: number, extra: Partial<NotificationRecord> = {}): NotificationRecord => ({
      id,
      ownerId: "org",
      workspaceId: "default",
      kind: "routine_finished",
      title: `Note ${id}`,
      body: "Done.",
      links: { routineId: "r1" },
      createdAt,
      ...extra
    });

    it("round-trips records and scopes them by owner", async () => {
      const record = note("n1", 10, { recipientUserId: "u1", links: { monitorId: "m1", conversationId: "c1" } });
      await store.notifications.insert(record);
      await store.notifications.insert(note("x", 11, { ownerId: "other" }));
      expect(await store.notifications.get("org", "n1")).toEqual(record);
      expect(await store.notifications.get("other", "n1")).toBeUndefined();
      expect((await store.notifications.list("org")).map((n) => n.id)).toEqual(["n1"]);
    });

    it("lists newest first with workspace, recipient and kind filters and a keyset cursor", async () => {
      await store.notifications.insert(note("a", 10));
      await store.notifications.insert(note("b", 20, { recipientUserId: "u1", kind: "monitor_fired" }));
      await store.notifications.insert(note("c", 20, { recipientUserId: "u2" }));
      await store.notifications.insert(note("d", 30, { workspaceId: "ws2" }));
      expect((await store.notifications.list("org")).map((n) => n.id)).toEqual(["d", "c", "b", "a"]);
      expect((await store.notifications.list("org", { workspaceId: "default" })).map((n) => n.id)).toEqual(["c", "b", "a"]);
      expect((await store.notifications.list("org", { workspaceId: "default", recipient: "u1" })).map((n) => n.id)).toEqual(["b", "a"]);
      expect((await store.notifications.list("org", { kinds: ["monitor_fired"] })).map((n) => n.id)).toEqual(["b"]);
      expect(await store.notifications.list("org", { kinds: [] })).toEqual([]);
      // Ties on createdAt are ordered by id and never skipped by the cursor.
      const first = await store.notifications.list("org", { workspaceId: "default", limit: 2 });
      expect(first.map((n) => n.id)).toEqual(["c", "b"]);
      const last = first[first.length - 1]!;
      expect((await store.notifications.list("org", { workspaceId: "default", before: { createdAt: last.createdAt, id: last.id } })).map((n) => n.id)).toEqual(["a"]);
    });

    it("counts unread per kind and marks one, an approval's, or all read", async () => {
      await store.notifications.insert(note("a", 10));
      await store.notifications.insert(note("b", 20, { kind: "approval_needed", links: { approvalId: "ap1" } }));
      await store.notifications.insert(note("c", 30, { recipientUserId: "u2" }));
      await store.notifications.insert(note("d", 40, { workspaceId: "ws2" }));
      expect(await store.notifications.countUnread("org", { workspaceId: "default" })).toEqual({ routine_finished: 2, approval_needed: 1 });
      expect(await store.notifications.countUnread("org", { workspaceId: "default", recipient: "u1" })).toEqual({ routine_finished: 1, approval_needed: 1 });

      expect(await store.notifications.markRead("org", { ids: ["a"] }, 50)).toEqual(["a"]);
      expect(await store.notifications.markRead("org", { ids: ["a"] }, 60)).toEqual([]); // already read: unchanged
      expect((await store.notifications.get("org", "a"))?.readAt).toBe(50);
      expect(await store.notifications.markRead("other", { ids: ["b"] }, 50)).toEqual([]);

      expect(await store.notifications.markRead("org", { approvalId: "ap1" }, 70)).toEqual(["b"]);
      expect((await store.notifications.list("org", { unread: true })).map((n) => n.id).sort()).toEqual(["c", "d"]);

      // "All" for u1 in the default workspace leaves u2's and the other workspace's alone.
      expect(await store.notifications.markRead("org", { workspaceId: "default", recipient: "u1" }, 80)).toEqual([]);
      expect((await store.notifications.markRead("org", { workspaceId: "default", recipient: "u2" }, 80))).toEqual(["c"]);
      expect(await store.notifications.countUnread("org")).toEqual({ routine_finished: 1 });
      expect((await store.notifications.get("org", "c"))).toEqual(note("c", 30, { recipientUserId: "u2", readAt: 80 }));
    });

    it("keeps read state per person for broadcasts, and once for addressed records", async () => {
      await store.notifications.insert(note("all", 10));
      await store.notifications.insert(note("mine", 20, { recipientUserId: "u1" }));
      await store.notifications.insert(note("app", 30, { kind: "approval_needed", links: { approvalId: "ap1" } }));
      const unreadFor = async (reader: string) =>
        (await store.notifications.list("org", { recipient: reader, reader, unread: true })).map((n) => n.id).sort();

      // u1 reads everything they see: the broadcasts only for themselves, their own record for good.
      expect((await store.notifications.markRead("org", { recipient: "u1", reader: "u1" }, 50)).sort()).toEqual(["all", "app", "mine"]);
      expect(await unreadFor("u1")).toEqual([]);
      expect(await unreadFor("u2")).toEqual(["all", "app"]);
      expect(await store.notifications.countUnread("org", { recipient: "u2", reader: "u2" })).toEqual({ routine_finished: 1, approval_needed: 1 });
      expect(await store.notifications.countUnread("org", { recipient: "u1", reader: "u1" })).toEqual({});
      // Listed records carry the reader's own read time; the stored record is unchanged.
      const forU1 = await store.notifications.list("org", { reader: "u1", recipient: "u1" });
      expect(forU1.map((n) => [n.id, n.readAt])).toEqual([["app", 50], ["mine", 50], ["all", 50]]);
      expect((await store.notifications.list("org", { reader: "u2", recipient: "u2" })).map((n) => n.readAt)).toEqual([undefined, undefined]);
      expect((await store.notifications.get("org", "all"))?.readAt).toBeUndefined();
      // Marking again for the same reader changes nothing.
      expect(await store.notifications.markRead("org", { ids: ["all"], reader: "u1" }, 60)).toEqual([]);

      // Without a reader (an approval was decided) it is read for everyone.
      expect(await store.notifications.markRead("org", { approvalId: "ap1" }, 70)).toEqual(["app"]);
      expect(await unreadFor("u2")).toEqual(["all"]);
    });

    it("prunes records older than a cutoff, with their read marks", async () => {
      await store.notifications.insert(note("old", 10));
      await store.notifications.insert(note("edge", 100));
      await store.notifications.insert(note("new", 200));
      await store.notifications.insert(note("theirs", 10, { ownerId: "other" }));
      await store.notifications.markRead("org", { ids: ["old"], reader: "u1" }, 20);
      expect(await store.notifications.prune("org", 100)).toBe(1);
      expect((await store.notifications.list("org")).map((n) => n.id)).toEqual(["new", "edge"]);
      expect(await store.notifications.get("other", "theirs")).toBeDefined();
      expect(await store.notifications.prune("org", 100)).toBe(0);
    });
  });
}

/* ───────────── Audit log (v0.4 Enterprise) and retention deletes ───────────── */

for (const harness of harnesses) {
  describe(`Audit and retention contract: ${harness.name}`, () => {
    let store: Store;
    let cleanup: () => void;
    beforeEach(() => {
      ({ store, cleanup } = harness.open());
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    const entry = (seq: number, extra: Partial<AuditRecord> = {}): AuditRecord => ({
      orgId: "org",
      seq,
      id: `e${seq}`,
      at: seq * 10,
      action: seq % 2 ? "auth.sign_in" : "tool.write",
      actor: { kind: "user", userId: seq % 2 ? "u1" : "u2", email: "a@example.com" },
      workspaceId: "default",
      outcome: "success",
      details: { note: `entry ${seq}` },
      prevHash: seq === 1 ? "" : `h${seq - 1}`,
      hash: `h${seq}`,
      ...extra
    });

    it("appends in order, refuses a taken seq, and has no way to change rows", async () => {
      for (const seq of [1, 2, 3, 4]) await store.audit.append(entry(seq));
      await store.audit.append(entry(1, { orgId: "other" }));
      await expect(store.audit.append(entry(2))).rejects.toThrow();
      expect((await store.audit.last("org"))?.seq).toBe(4);
      expect(await store.audit.last("nobody")).toBeUndefined();
      expect((await store.audit.scan("org", 1, 2)).map((r) => r.seq)).toEqual([2, 3]);
      expect(await store.audit.scan("org", 0, 10)).toEqual([1, 2, 3, 4].map((seq) => entry(seq)));
      expect(Object.keys(store.audit).sort()).toEqual(["append", "last", "list", "scan"]);
    });

    it("filters newest first by action prefix, actor, outcome, time, text and page", async () => {
      for (const seq of [1, 2, 3, 4, 5]) await store.audit.append(entry(seq, seq === 5 ? { outcome: "denied", details: { note: "Blocked Thing" } } : {}));
      const seqs = async (query: Parameters<Store["audit"]["list"]>[1]) => (await store.audit.list("org", query)).map((r) => r.seq);
      expect(await seqs({})).toEqual([5, 4, 3, 2, 1]);
      expect(await seqs({ action: "auth." })).toEqual([5, 3, 1]);
      expect(await seqs({ action: "tool.write" })).toEqual([4, 2]);
      expect(await seqs({ action: "tool." })).toEqual([4, 2]);
      expect(await seqs({ actorUserId: "u2" })).toEqual([4, 2]);
      expect(await seqs({ outcome: "denied" })).toEqual([5]);
      expect(await seqs({ from: 20, to: 40 })).toEqual([3, 2]);
      expect(await seqs({ text: "blocked thing" })).toEqual([5]);
      expect(await seqs({ beforeSeq: 4, limit: 2 })).toEqual([3, 2]);
      expect(await seqs({ workspaceId: "ws2" })).toEqual([]);
    });

    it("removes artifacts and old notifications (data retention)", async () => {
      await store.artifacts.create({ id: "f1", ownerId: "org", kind: "file", title: "a.txt", version: 1, meta: {}, createdAt: 1 });
      await store.artifacts.remove("other", "f1");
      expect(await store.artifacts.get("org", "f1")).toBeDefined();
      await store.artifacts.remove("org", "f1");
      expect(await store.artifacts.get("org", "f1")).toBeUndefined();

      const note = (id: string, createdAt: number, ownerId = "org"): NotificationRecord => ({ id, ownerId, workspaceId: "default", kind: "routine_finished", title: id, body: "", links: {}, createdAt });
      for (const n of [note("old", 10), note("new", 100), note("theirs", 10, "other")]) await store.notifications.insert(n);
      expect(await store.notifications.prune("org", 50)).toBe(1);
      expect((await store.notifications.list("org")).map((n) => n.id)).toEqual(["new"]);
      expect(await store.notifications.get("other", "theirs")).toBeDefined();
    });

    it("hosted tenancy: organizations, an append-only credits ledger, people by email, and per-organization workspace and plugin ids", async () => {
      await store.organizations.create({ id: "oa", name: "Acme", createdAt: 1 });
      await store.organizations.create({ id: "ob", name: "Beta", createdAt: 2 });
      await expect(store.organizations.create({ id: "oa", name: "Again", createdAt: 3 })).rejects.toThrow();
      await store.organizations.update({ id: "oa", name: "Acme Inc", createdAt: 1, createdBy: "u1" });
      expect((await store.organizations.getMany(["ob", "nope", "oa"])).map((o) => o.name)).toEqual(["Beta", "Acme Inc"]);
      expect(await store.organizations.count()).toBe(2);

      const entry = (orgId: string, key: string, amountMicros: number) => ({ orgId, idempotencyKey: key, kind: amountMicros > 0 ? ("grant" as const) : ("charge" as const), amountMicros, at: 1 });
      expect(await store.credits.append(entry("oa", "g1", 5_000_000))).toBe(true);
      expect(await store.credits.append(entry("oa", "g1", 5_000_000))).toBe(false);
      expect(await store.credits.append(entry("ob", "g1", 1_000_000))).toBe(true);
      expect(await store.credits.append(entry("oa", "c1", -1_250_000))).toBe(true);
      expect(await store.credits.balance("oa")).toBe(3_750_000);
      expect(await store.credits.balance("ob")).toBe(1_000_000);
      expect((await store.credits.list("oa")).map((e) => e.idempotencyKey)).toEqual(["c1", "g1"]);

      await store.identity.users.upsert({ id: "u1", orgId: "oa", email: "Ann@Acme.test", name: "Ann", passwordHash: "x", createdAt: 1 });
      await store.identity.users.upsert({ id: "u2", orgId: "ob", email: "ann@acme.test", name: "Ann", passwordHash: "x", createdAt: 2 });
      expect((await store.identity.users.listByEmail("ANN@acme.test")).map((u) => u.orgId)).toEqual(["oa", "ob"]);

      // Every organization has a "default" workspace and may install the same catalog plugin.
      await store.workspaces.upsert({ id: "default", ownerId: "oa", name: "Acme team", createdAt: 1, updatedAt: 1 });
      await store.workspaces.upsert({ id: "default", ownerId: "ob", name: "Beta team", createdAt: 1, updatedAt: 1 });
      expect((await store.workspaces.get("oa", "default"))?.name).toBe("Acme team");
      expect((await store.workspaces.get("ob", "default"))?.name).toBe("Beta team");
      await store.workspaces.remove("ob", "default");
      expect((await store.workspaces.get("oa", "default"))?.name).toBe("Acme team");
      const plugin = (ownerId: string) => ({ id: "meeting-notes-kit", ownerId, name: "Kit", version: "1", source: { kind: "catalog", ref: "meeting-notes-kit" }, enabled: true, skillIds: [], installedAt: 1 }) as never;
      await store.plugins.upsert(plugin("oa"));
      await store.plugins.upsert(plugin("ob"));
      expect((await store.plugins.list("oa")).length).toBe(1);
      expect((await store.plugins.list("ob")).length).toBe(1);
    });
  });
}

/* ───────────── Meetings (wave C) ───────────── */

for (const harness of harnesses) {
  describe(`Meetings contract: ${harness.name}`, () => {
    let store: Store;
    let cleanup: () => void;
    beforeEach(() => {
      ({ store, cleanup } = harness.open());
    });
    afterEach(async () => {
      await store.close();
      cleanup();
    });

    const meeting = (id: string, extra: Partial<MeetingRecord> = {}): MeetingRecord => ({
      id,
      ownerId: "org",
      workspaceId: "default",
      title: `Meeting ${id}`,
      host: "u1",
      hostName: "Ada",
      status: "scheduled",
      participants: [],
      sibylRole: "participant",
      inviteKey: "k",
      createdAt: 10,
      updatedAt: 10,
      ...extra
    });

    it("stores, lists newest first per workspace and scopes by owner", async () => {
      await store.meetings.upsert(meeting("a", { scheduledAt: 50 }));
      await store.meetings.upsert(meeting("b", { startedAt: 100, status: "live" }));
      await store.meetings.upsert(meeting("c", { workspaceId: "ws2" }));
      await store.meetings.upsert(meeting("d", { ownerId: "other" }));
      expect((await store.meetings.list("org")).map((m) => m.id)).toEqual(["b", "a", "c"]);
      expect((await store.meetings.list("org", { workspaceId: "default" })).map((m) => m.id)).toEqual(["b", "a"]);
      expect((await store.meetings.list("org", { limit: 1 })).map((m) => m.id)).toEqual(["b"]);
      expect(await store.meetings.get("other", "a")).toBeUndefined();
      await store.meetings.upsert(meeting("a", { scheduledAt: 500, title: "Moved" }));
      const [first] = await store.meetings.list("org");
      expect(first).toMatchObject({ id: "a", title: "Moved" });
    });

    it("numbers transcript segments per meeting and reads what is new", async () => {
      await store.meetings.upsert(meeting("m"));
      const say = (text: string, meetingId = "m") =>
        store.meetings.appendSegment({ meetingId, ownerId: "org", speaker: "user:u1", speakerName: "Ada", kind: "person", startMs: 0, endMs: 1, text, at: 1 });
      expect((await say("one")).seq).toBe(1);
      expect((await say("two")).seq).toBe(2);
      expect((await say("other", "n")).seq).toBe(1);
      expect((await store.meetings.segments("org", "m")).map((s) => s.text)).toEqual(["one", "two"]);
      expect((await store.meetings.segments("org", "m", 1)).map((s) => s.text)).toEqual(["two"]);
      expect(await store.meetings.segments("other", "m")).toEqual([]);
    });

    it("keeps comments with replies and reactions; deleting removes replies, and the meeting removes everything", async () => {
      await store.meetings.upsert(meeting("m"));
      const comment = (id: string, createdAt: number, extra: Partial<MeetingComment> = {}): MeetingComment => ({
        id,
        ownerId: "org",
        meetingId: "m",
        authorId: "u1",
        authorName: "Ada",
        text: id,
        reactions: {},
        createdAt,
        ...extra
      });
      await store.meetings.upsertComment(comment("c1", 1));
      await store.meetings.upsertComment(comment("r1", 2, { parentId: "c1" }));
      await store.meetings.upsertComment(comment("c2", 3, { reactions: { "👍": ["u2"] } }));
      expect((await store.meetings.comments("org", "m")).map((c) => c.id)).toEqual(["c1", "r1", "c2"]);
      expect((await store.meetings.getComment("org", "c2"))?.reactions).toEqual({ "👍": ["u2"] });
      await store.meetings.removeComment("org", "c1");
      expect((await store.meetings.comments("org", "m")).map((c) => c.id)).toEqual(["c2"]);
      await store.meetings.appendSegment({ meetingId: "m", ownerId: "org", speaker: "user:u1", speakerName: "Ada", kind: "person", startMs: 0, endMs: 1, text: "hi", at: 1 });
      await store.meetings.remove("other", "m");
      expect(await store.meetings.get("org", "m")).toBeDefined();
      await store.meetings.remove("org", "m");
      expect(await store.meetings.get("org", "m")).toBeUndefined();
      expect(await store.meetings.segments("org", "m")).toEqual([]);
      expect(await store.meetings.comments("org", "m")).toEqual([]);
    });
  });
}
