/**
 * SQLite call log (the phone line's calls, see packages/core/src/calls.ts).
 * The table is created by CALLS_MIGRATION in sqlite.ts.
 */
import type { DatabaseSync } from "node:sqlite";
import type { CallLogRecord, CallLogStore } from "@open-gpt-live/core";

export const CALLS_MIGRATION = `
  CREATE TABLE call_log (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    started_at REAL NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (owner_id, id)
  );
  CREATE INDEX call_log_list ON call_log (owner_id, workspace_id, started_at DESC);
`;

export function createSqliteCallLogStore(db: DatabaseSync): CallLogStore {
  const upsert = db.prepare(
    `INSERT INTO call_log (id, owner_id, workspace_id, direction, started_at, data) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_id, id) DO UPDATE SET workspace_id = excluded.workspace_id, direction = excluded.direction,
       started_at = excluded.started_at, data = excluded.data`
  );
  const get = db.prepare("SELECT data FROM call_log WHERE owner_id = ? AND id = ?");
  const list = db.prepare(
    `SELECT data FROM call_log WHERE owner_id = ? AND (? IS NULL OR workspace_id = ?) AND (? IS NULL OR direction = ?)
       AND (? IS NULL OR started_at < ?) ORDER BY started_at DESC, rowid DESC LIMIT ?`
  );
  const remove = db.prepare("DELETE FROM call_log WHERE owner_id = ? AND id = ?");
  const parse = (row: unknown): CallLogRecord | undefined => (row ? (JSON.parse(String((row as { data: string }).data)) as CallLogRecord) : undefined);
  return {
    async upsert(record) {
      upsert.run(record.id, record.ownerId, record.workspaceId, record.direction, record.startedAt, JSON.stringify(record));
    },
    async get(ownerId, id) {
      return parse(get.get(ownerId, id));
    },
    async list(ownerId, query = {}) {
      const workspaceId = query.workspaceId ?? null;
      const direction = query.direction ?? null;
      const before = query.before ?? null;
      return list
        .all(ownerId, workspaceId, workspaceId, direction, direction, before, before, query.limit ?? 100)
        .map((row) => parse(row)!);
    },
    async remove(ownerId, id) {
      remove.run(ownerId, id);
    }
  };
}
