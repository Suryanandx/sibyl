/**
 * SQLite organizations and the AI credits ledger (hosted Sibyl). Tables are
 * created by TENANCY_MIGRATION in sqlite.ts. The ledger is append-only: no
 * statement here updates or deletes an entry.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { CreditEntry, CreditStore, OrganizationRecord, OrganizationStore } from "@open-gpt-live/core";

export const TENANCY_MIGRATION = `
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE credit_entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    at REAL NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (org_id, idempotency_key)
  );
  CREATE INDEX credit_entries_org ON credit_entries (org_id, seq DESC);

  CREATE INDEX users_email ON users (email);

  -- Workspace and plugin ids repeat across organizations ("default", catalog ids): key them by organization + id.
  CREATE TABLE workspaces_by_org (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (owner_id, id)
  );
  INSERT INTO workspaces_by_org (id, owner_id, data) SELECT id, owner_id, data FROM workspaces ORDER BY rowid;
  DROP TABLE workspaces;
  ALTER TABLE workspaces_by_org RENAME TO workspaces;
  CREATE INDEX workspaces_owner ON workspaces (owner_id);

  CREATE TABLE plugins_by_org (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (owner_id, id)
  );
  INSERT INTO plugins_by_org (id, owner_id, data) SELECT id, owner_id, data FROM plugins ORDER BY rowid;
  DROP TABLE plugins;
  ALTER TABLE plugins_by_org RENAME TO plugins;
  CREATE INDEX plugins_owner ON plugins (owner_id);

  -- Meeting ids can come from a link (an older /call/<id> chat link): key meetings and transcripts by organization too.
  CREATE TABLE meetings_by_org (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    sort_at REAL NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (owner_id, id)
  );
  INSERT INTO meetings_by_org (id, owner_id, workspace_id, sort_at, data) SELECT id, owner_id, workspace_id, sort_at, data FROM meetings ORDER BY rowid;
  DROP TABLE meetings;
  ALTER TABLE meetings_by_org RENAME TO meetings;
  CREATE INDEX meetings_list ON meetings (owner_id, workspace_id, sort_at DESC);

  CREATE TABLE meeting_segments_by_org (
    meeting_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (owner_id, meeting_id, seq)
  );
  INSERT INTO meeting_segments_by_org (meeting_id, seq, owner_id, data) SELECT meeting_id, seq, owner_id, data FROM meeting_segments ORDER BY rowid;
  DROP TABLE meeting_segments;
  ALTER TABLE meeting_segments_by_org RENAME TO meeting_segments;
`;

type Row = Record<string, SQLInputValue>;

export function createSqliteTenancyStores(db: DatabaseSync): {
  organizations: OrganizationStore;
  credits: CreditStore;
  /** Synchronous append, for use inside the caller's transaction (usage event + its charge). */
  appendCredit(entry: CreditEntry): boolean;
} {
  const sql = {
    orgInsert: db.prepare("INSERT INTO organizations (id, created_at, data) VALUES (?, ?, ?)"),
    orgGet: db.prepare("SELECT data FROM organizations WHERE id = ?"),
    orgUpdate: db.prepare("UPDATE organizations SET data = ? WHERE id = ?"),
    orgCount: db.prepare("SELECT COUNT(*) AS n FROM organizations"),
    creditInsert: db.prepare(
      "INSERT INTO credit_entries (org_id, idempotency_key, amount_micros, at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, idempotency_key) DO NOTHING"
    ),
    creditBalance: db.prepare("SELECT COALESCE(SUM(amount_micros), 0) AS total FROM credit_entries WHERE org_id = ?"),
    creditList: db.prepare("SELECT data FROM credit_entries WHERE org_id = ? ORDER BY seq DESC LIMIT ?")
  };
  const parse = <T>(row: Row | undefined): T | undefined => (row ? (JSON.parse(String(row.data)) as T) : undefined);
  const appendCredit = (entry: CreditEntry): boolean => {
    if (!Number.isSafeInteger(entry.amountMicros)) throw new Error("credit amounts are whole micro-USD");
    const result = sql.creditInsert.run(entry.orgId, entry.idempotencyKey, entry.amountMicros, entry.at, JSON.stringify(entry));
    return Number(result.changes) > 0;
  };
  return {
    appendCredit,
    organizations: {
      async create(record) {
        sql.orgInsert.run(record.id, record.createdAt, JSON.stringify(record));
      },
      async get(id) {
        return parse<OrganizationRecord>(sql.orgGet.get(id) as Row | undefined);
      },
      async getMany(ids) {
        return ids.flatMap((id) => {
          const found = parse<OrganizationRecord>(sql.orgGet.get(id) as Row | undefined);
          return found ? [found] : [];
        });
      },
      async update(record) {
        const result = sql.orgUpdate.run(JSON.stringify(record), record.id);
        if (Number(result.changes) === 0) throw new Error("organization not found");
      },
      async count() {
        return Number((sql.orgCount.get() as Row).n);
      }
    },
    credits: {
      async append(entry: CreditEntry) {
        return appendCredit(entry);
      },
      async balance(orgId) {
        return Number((sql.creditBalance.get(orgId) as Row).total);
      },
      async list(orgId, limit = 50) {
        return (sql.creditList.all(orgId, Math.max(1, Math.min(500, limit))) as Row[]).map((row) => JSON.parse(String(row.data)) as CreditEntry);
      }
    }
  };
}
