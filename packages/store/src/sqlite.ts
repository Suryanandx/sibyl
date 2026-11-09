/**
 * SQLite Store on Node's built-in `node:sqlite` (no native npm dependency).
 *
 * Node support: `node:sqlite` is available without a flag from Node 22.13.0
 * (and 23.4.0). Node 22.5–22.12 need `--experimental-sqlite`; the repo's
 * `engines` field already requires >= 22.13.0. Node may print an
 * ExperimentalWarning on start-up; it is harmless.
 *
 * Layout: every table keeps the full record as JSON in a `data` column plus
 * the handful of columns used for lookups, filters and ordering. New optional
 * fields on the core records therefore round-trip without a migration; a
 * migration is only needed when a field must become queryable.
 *
 * Semantics match `createMemoryStore()` exactly (ownership checks, ordering,
 * ties broken by insertion order, `decide` only from pending); the shared
 * contract tests in `store-contract.test.ts` run against both.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ApprovalRecord,
  ArtifactRecord,
  ConversationRecord,
  RoutineRecord,
  RoutineRunRecord,
  SpaceRecord,
  Store,
  StoredMessage,
  UsageEvent
} from "@open-gpt-live/core";

export interface SqliteStoreOptions {
  /** Database file path, or ":memory:". Parent directories are created. */
  file: string;
}

/** Ordered schema migrations; index + 1 is the schema version after it runs. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
  );
  CREATE INDEX conversations_owner_updated ON conversations (owner_id, updated_at DESC);

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    data TEXT NOT NULL
  );
  CREATE INDEX messages_conversation ON messages (conversation_id, seq);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX approvals_owner_status ON approvals (owner_id, status, created_at);

  CREATE TABLE usage_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    at REAL NOT NULL,
    feature TEXT NOT NULL,
    routine_id TEXT,
    cost_usd REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX usage_owner_at ON usage_events (owner_id, at);

  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_run_at REAL,
    data TEXT NOT NULL
  );
  CREATE INDEX routines_owner ON routines (owner_id);
  CREATE INDEX routines_due ON routines (enabled, next_run_at);

  CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    started_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX routine_runs_routine ON routine_runs (owner_id, routine_id, started_at DESC);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    space_id TEXT,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX artifacts_owner ON artifacts (owner_id, created_at DESC);

  CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX spaces_owner ON spaces (owner_id);

  CREATE TABLE kv (
    owner_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (owner_id, key)
  );
  `
];

export const SCHEMA_VERSION = MIGRATIONS.length;

type Row = Record<string, SQLInputValue>;

export function createSqliteStore(options: SqliteStoreOptions): Store {
  if (options.file !== ":memory:") mkdirSync(dirname(options.file), { recursive: true });
  const db = new DatabaseSync(options.file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  let closed = false;

  const transaction = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const prepare = (sql: string) => db.prepare(sql);
  const json = (value: unknown): string => JSON.stringify(value);
  const parse = <T>(row: Row | undefined, column = "data"): T | undefined =>
    row ? (JSON.parse(String(row[column])) as T) : undefined;
  const parseAll = <T>(rows: Row[], column = "data"): T[] => rows.map((row) => JSON.parse(String(row[column])) as T);
  const opt = (value: string | number | undefined): SQLInputValue => (value === undefined ? null : value);

  const sql = {
    convList: prepare(
      "SELECT id, owner_id, title, created_at, updated_at FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC, rowid ASC LIMIT ?"
    ),
    convGet: prepare("SELECT id, owner_id, title, created_at, updated_at FROM conversations WHERE id = ? AND owner_id = ?"),
    convUpsert: prepare(
      `INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, title = excluded.title,
         created_at = excluded.created_at, updated_at = excluded.updated_at`
    ),
    convTouch: prepare("UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?"),
    convRemove: prepare("DELETE FROM conversations WHERE id = ? AND owner_id = ?"),
    msgList: prepare("SELECT data FROM messages WHERE conversation_id = ? ORDER BY seq ASC"),
    msgInsert: prepare("INSERT INTO messages (conversation_id, data) VALUES (?, ?)"),
    msgClear: prepare("DELETE FROM messages WHERE conversation_id = ?"),

    apprInsert: prepare(
      `INSERT INTO approvals (id, owner_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, status = excluded.status,
         created_at = excluded.created_at, data = excluded.data`
    ),
    apprGet: prepare("SELECT data FROM approvals WHERE id = ? AND owner_id = ?"),
    apprPending: prepare("SELECT data FROM approvals WHERE owner_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC"),
    apprUpdate: prepare("UPDATE approvals SET status = ?, data = ? WHERE id = ?"),

    usageInsert: prepare(
      "INSERT INTO usage_events (owner_id, at, feature, routine_id, cost_usd, data) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    usageRange: prepare(
      "SELECT feature, routine_id, cost_usd FROM usage_events WHERE owner_id = ? AND at >= ? AND at < ? ORDER BY seq ASC"
    ),

    routineList: prepare("SELECT data FROM routines WHERE owner_id = ? ORDER BY rowid ASC"),
    routineGet: prepare("SELECT data FROM routines WHERE id = ? AND owner_id = ?"),
    routineUpsert: prepare(
      `INSERT INTO routines (id, owner_id, enabled, next_run_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, enabled = excluded.enabled,
         next_run_at = excluded.next_run_at, data = excluded.data`
    ),
    routineRemove: prepare("DELETE FROM routines WHERE id = ? AND owner_id = ?"),
    routineDue: prepare("SELECT data FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY rowid ASC"),
    runUpsert: prepare(
      `INSERT INTO routine_runs (id, routine_id, owner_id, started_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET routine_id = excluded.routine_id, owner_id = excluded.owner_id,
         started_at = excluded.started_at, data = excluded.data`
    ),
    runList: prepare(
      "SELECT data FROM routine_runs WHERE owner_id = ? AND routine_id = ? ORDER BY started_at DESC, rowid ASC LIMIT ?"
    ),

    artifactUpsert: prepare(
      `INSERT INTO artifacts (id, owner_id, kind, space_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, kind = excluded.kind,
         space_id = excluded.space_id, created_at = excluded.created_at, data = excluded.data`
    ),
    artifactGet: prepare("SELECT data FROM artifacts WHERE id = ? AND owner_id = ?"),
    artifactList: prepare(
      `SELECT data FROM artifacts WHERE owner_id = ?
         AND (? IS NULL OR space_id = ?) AND (? IS NULL OR kind = ?)
       ORDER BY created_at DESC, rowid ASC`
    ),

    spaceList: prepare("SELECT data FROM spaces WHERE owner_id = ? ORDER BY rowid ASC"),
    spaceGet: prepare("SELECT data FROM spaces WHERE id = ? AND owner_id = ?"),
    spaceUpsert: prepare(
      `INSERT INTO spaces (id, owner_id, data) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, data = excluded.data`
    ),
    spaceRemove: prepare("DELETE FROM spaces WHERE id = ? AND owner_id = ?"),

    kvGet: prepare("SELECT value FROM kv WHERE owner_id = ? AND key = ?"),
    kvSet: prepare(
      "INSERT INTO kv (owner_id, key, value) VALUES (?, ?, ?) ON CONFLICT (owner_id, key) DO UPDATE SET value = excluded.value"
    ),
    kvDelete: prepare("DELETE FROM kv WHERE owner_id = ? AND key = ?")
  };

  const toSummary = (row: Row): Omit<ConversationRecord, "messages"> => ({
    id: String(row.id),
    ownerId: String(row.owner_id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  });

  return {
    conversations: {
      async list(ownerId, limit = 100) {
        return (sql.convList.all(ownerId, limit) as Row[]).map(toSummary);
      },
      async get(ownerId, id) {
        const row = sql.convGet.get(id, ownerId) as Row | undefined;
        if (!row) return undefined;
        return { ...toSummary(row), messages: parseAll<StoredMessage>(sql.msgList.all(id) as Row[]) };
      },
      async upsert(record) {
        transaction(() => {
          sql.convUpsert.run(record.id, record.ownerId, record.title, record.createdAt, record.updatedAt);
          sql.msgClear.run(record.id);
          for (const message of record.messages) sql.msgInsert.run(record.id, json(message));
        });
      },
      async appendMessage(ownerId, conversationId, message) {
        transaction(() => {
          if (!sql.convGet.get(conversationId, ownerId)) throw new Error("conversation not found");
          sql.msgInsert.run(conversationId, json(message));
          sql.convTouch.run(message.createdAt, conversationId);
        });
      },
      async remove(ownerId, id) {
        sql.convRemove.run(id, ownerId);
      }
    },
    approvals: {
      async create(record) {
        sql.apprInsert.run(record.id, record.ownerId, record.status, record.createdAt, json(record));
      },
      async get(ownerId, id) {
        return parse<ApprovalRecord>(sql.apprGet.get(id, ownerId) as Row | undefined);
      },
      async listPending(ownerId) {
        return parseAll<ApprovalRecord>(sql.apprPending.all(ownerId) as Row[]);
      },
      async decide(ownerId, id, status, at = Date.now()) {
        return transaction(() => {
          const found = parse<ApprovalRecord>(sql.apprGet.get(id, ownerId) as Row | undefined);
          if (!found || found.status !== "pending") return undefined;
          const decided: ApprovalRecord = { ...found, status, decidedAt: at };
          sql.apprUpdate.run(status, json(decided), id);
          return decided;
        });
      }
    },
    usage: {
      async insert(event) {
        sql.usageInsert.run(event.ownerId, event.at, event.feature, opt(event.routineId), event.costUsd, json(event));
      },
      async sum(ownerId, from, to, filter = {}) {
        // Summed in insertion order in JS so float results match the memory store exactly.
        return (sql.usageRange.all(ownerId, from, to) as Row[])
          .filter((row) => !filter.routineId || row.routine_id === filter.routineId)
          .reduce((total, row) => total + Number(row.cost_usd), 0);
      },
      async byFeature(ownerId, from, to) {
        const out: Record<string, number> = {};
        for (const row of sql.usageRange.all(ownerId, from, to) as Row[]) {
          const feature = String(row.feature) as UsageEvent["feature"];
          out[feature] = (out[feature] ?? 0) + Number(row.cost_usd);
        }
        return out;
      }
    },
    routines: {
      async list(ownerId) {
        return parseAll<RoutineRecord>(sql.routineList.all(ownerId) as Row[]);
      },
      async get(ownerId, id) {
        return parse<RoutineRecord>(sql.routineGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.routineUpsert.run(record.id, record.ownerId, record.enabled ? 1 : 0, opt(record.nextRunAt), json(record));
      },
      async remove(ownerId, id) {
        sql.routineRemove.run(id, ownerId);
      },
      async due(now) {
        return parseAll<RoutineRecord>(sql.routineDue.all(now) as Row[]);
      },
      async insertRun(run) {
        sql.runUpsert.run(run.id, run.routineId, run.ownerId, run.startedAt, json(run));
      },
      async updateRun(run) {
        sql.runUpsert.run(run.id, run.routineId, run.ownerId, run.startedAt, json(run));
      },
      async listRuns(ownerId, routineId, limit = 20) {
        return parseAll<RoutineRunRecord>(sql.runList.all(ownerId, routineId, limit) as Row[]);
      }
    },
    artifacts: {
      async create(record) {
        sql.artifactUpsert.run(record.id, record.ownerId, record.kind, opt(record.spaceId), record.createdAt, json(record));
      },
      async get(ownerId, id) {
        return parse<ArtifactRecord>(sql.artifactGet.get(id, ownerId) as Row | undefined);
      },
      async list(ownerId, filter = {}) {
        // Empty strings mean "no filter", like the memory store's truthiness check.
        const spaceId = filter.spaceId || null;
        const kind = filter.kind || null;
        return parseAll<ArtifactRecord>(sql.artifactList.all(ownerId, spaceId, spaceId, kind, kind) as Row[]);
      }
    },
    spaces: {
      async list(ownerId) {
        return parseAll<SpaceRecord>(sql.spaceList.all(ownerId) as Row[]);
      },
      async get(ownerId, id) {
        return parse<SpaceRecord>(sql.spaceGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.spaceUpsert.run(record.id, record.ownerId, json(record));
      },
      async remove(ownerId, id) {
        sql.spaceRemove.run(id, ownerId);
      }
    },
    kv: {
      async get<T>(ownerId: string, key: string) {
        const row = sql.kvGet.get(ownerId, key) as Row | undefined;
        if (!row || row.value === null) return undefined;
        return JSON.parse(String(row.value)) as T;
      },
      async set(ownerId, key, value) {
        sql.kvSet.run(ownerId, key, value === undefined ? null : json(value));
      },
      async delete(ownerId, key) {
        sql.kvDelete.run(ownerId, key);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    }
  };
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  let version = row ? Number(row.version) : 0;
  if (version > MIGRATIONS.length) {
    throw new Error(`database schema version ${version} is newer than this Sibyl build supports (${MIGRATIONS.length})`);
  }
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]!);
      version += 1;
      db.prepare("UPDATE schema_version SET version = ?").run(version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
