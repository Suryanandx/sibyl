/**
 * SQLite implementation of the identity collections (users, memberships,
 * invites, sessions). Tables are created by migration 3 in sqlite.ts; like
 * the other tables they keep the record as JSON plus lookup columns.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  DuplicateEmailError,
  membershipScopeKey,
  normalizeEmail,
  type IdentityStore,
  type InviteRecord,
  type MembershipRecord,
  type SessionRecord,
  type UserRecord
} from "@open-gpt-live/core";

/** Migration 3: identity tables + conversations.created_by. */
export const IDENTITY_MIGRATION = `
  ALTER TABLE conversations ADD COLUMN created_by TEXT;

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE UNIQUE INDEX users_org_email ON users (org_id, email);

  CREATE TABLE memberships (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id, scope)
  );
  CREATE INDEX memberships_scope ON memberships (org_id, scope);

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX invites_org ON invites (org_id, workspace_id, created_at DESC);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    expires_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);
  CREATE INDEX sessions_expiry ON sessions (expires_at);
`;

type Row = Record<string, SQLInputValue>;

export function createSqliteIdentityStore(db: DatabaseSync, transaction: <T>(fn: () => T) => T): IdentityStore {
  const prepare = (sql: string) => db.prepare(sql);
  const json = (value: unknown): string => JSON.stringify(value);
  const parse = <T>(row: Row | undefined): T | undefined => (row ? (JSON.parse(String(row.data)) as T) : undefined);
  const parseAll = <T>(rows: Row[]): T[] => rows.map((row) => JSON.parse(String(row.data)) as T);

  const sql = {
    userCount: prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ?"),
    userList: prepare("SELECT data FROM users WHERE org_id = ? ORDER BY created_at ASC, rowid ASC"),
    userGet: prepare("SELECT data FROM users WHERE id = ? AND org_id = ?"),
    userByEmail: prepare("SELECT data FROM users WHERE org_id = ? AND email = ?"),
    userAllByEmail: prepare("SELECT data FROM users WHERE email = ? ORDER BY created_at ASC, rowid ASC"),
    userUpsert: prepare(
      `INSERT INTO users (id, org_id, email, created_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET org_id = excluded.org_id, email = excluded.email,
         created_at = excluded.created_at, data = excluded.data`
    ),
    userTouch: prepare(
      `UPDATE users SET data = json_set(data, '$.lastActiveAt', ?)
       WHERE id = ? AND org_id = ? AND COALESCE(json_extract(data, '$.lastActiveAt'), 0) < ?`
    ),

    memList: prepare("SELECT data FROM memberships WHERE org_id = ? ORDER BY rowid ASC"),
    memForUser: prepare("SELECT data FROM memberships WHERE org_id = ? AND user_id = ? ORDER BY rowid ASC"),
    memForScope: prepare("SELECT data FROM memberships WHERE org_id = ? AND scope = ? ORDER BY rowid ASC"),
    memUpsert: prepare(
      `INSERT INTO memberships (org_id, user_id, scope, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (org_id, user_id, scope) DO UPDATE SET data = excluded.data`
    ),
    memRemove: prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ? AND scope = ?"),
    memRemoveScope: prepare("DELETE FROM memberships WHERE org_id = ? AND scope = ?"),

    invInsert: prepare("INSERT INTO invites (id, org_id, token_hash, workspace_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?)"),
    invByToken: prepare("SELECT data FROM invites WHERE token_hash = ?"),
    invGet: prepare("SELECT data FROM invites WHERE id = ? AND org_id = ?"),
    invList: prepare(
      "SELECT data FROM invites WHERE org_id = ? AND (? IS NULL OR workspace_id = ?) ORDER BY created_at DESC, rowid ASC"
    ),
    invUpdate: prepare("UPDATE invites SET data = ? WHERE id = ?"),
    invRemove: prepare("DELETE FROM invites WHERE id = ? AND org_id = ?"),

    sesInsert: prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at, data) VALUES (?, ?, ?, ?, ?)"),
    sesByToken: prepare("SELECT data FROM sessions WHERE token_hash = ?"),
    sesGet: prepare("SELECT data FROM sessions WHERE id = ?"),
    sesUpdate: prepare("UPDATE sessions SET expires_at = ?, data = ? WHERE id = ?"),
    sesRemove: prepare("DELETE FROM sessions WHERE id = ?"),
    sesRemoveUser: prepare("DELETE FROM sessions WHERE user_id = ?"),
    sesPrune: prepare("DELETE FROM sessions WHERE expires_at <= ?")
  };

  return {
    users: {
      async count(orgId) {
        return Number((sql.userCount.get(orgId) as Row).n);
      },
      async list(orgId) {
        return parseAll<UserRecord>(sql.userList.all(orgId) as Row[]);
      },
      async get(orgId, id) {
        return parse<UserRecord>(sql.userGet.get(id, orgId) as Row | undefined);
      },
      async getByEmail(orgId, email) {
        return parse<UserRecord>(sql.userByEmail.get(orgId, normalizeEmail(email)) as Row | undefined);
      },
      async upsert(record) {
        const stored: UserRecord = { ...record, email: normalizeEmail(record.email) };
        transaction(() => {
          const clash = parse<UserRecord>(sql.userByEmail.get(stored.orgId, stored.email) as Row | undefined);
          if (clash && clash.id !== stored.id) throw new DuplicateEmailError();
          sql.userUpsert.run(stored.id, stored.orgId, stored.email, stored.createdAt, json(stored));
        });
      },
      async touch(orgId, id, at) {
        sql.userTouch.run(at, id, orgId, at);
      },
      async listByEmail(email) {
        return parseAll<UserRecord>(sql.userAllByEmail.all(normalizeEmail(email)) as Row[]);
      }
    },
    memberships: {
      async list(orgId) {
        return parseAll<MembershipRecord>(sql.memList.all(orgId) as Row[]);
      },
      async listForUser(orgId, userId) {
        return parseAll<MembershipRecord>(sql.memForUser.all(orgId, userId) as Row[]);
      },
      async listForScope(orgId, scope) {
        return parseAll<MembershipRecord>(sql.memForScope.all(orgId, membershipScopeKey(scope)) as Row[]);
      },
      async upsert(orgId, record) {
        sql.memUpsert.run(orgId, record.userId, membershipScopeKey(record.scope), json(record));
      },
      async remove(orgId, userId, scope) {
        sql.memRemove.run(orgId, userId, membershipScopeKey(scope));
      },
      async removeScope(orgId, scope) {
        sql.memRemoveScope.run(orgId, membershipScopeKey(scope));
      }
    },
    invites: {
      async create(record) {
        sql.invInsert.run(record.id, record.orgId, record.tokenHash, record.workspaceId, record.createdAt, json(record));
      },
      async getByTokenHash(tokenHash) {
        return parse<InviteRecord>(sql.invByToken.get(tokenHash) as Row | undefined);
      },
      async get(orgId, id) {
        return parse<InviteRecord>(sql.invGet.get(id, orgId) as Row | undefined);
      },
      async list(orgId, filter = {}) {
        const workspaceId = filter.workspaceId || null;
        return parseAll<InviteRecord>(sql.invList.all(orgId, workspaceId, workspaceId) as Row[]).filter(
          (invite) => filter.pendingAt === undefined || (invite.acceptedAt === undefined && invite.expiresAt > filter.pendingAt)
        );
      },
      async accept(orgId, id, userId, at) {
        return transaction(() => {
          const found = parse<InviteRecord>(sql.invGet.get(id, orgId) as Row | undefined);
          if (!found || found.acceptedAt !== undefined) return undefined;
          const accepted: InviteRecord = { ...found, acceptedAt: at, acceptedBy: userId };
          sql.invUpdate.run(json(accepted), id);
          return accepted;
        });
      },
      async remove(orgId, id) {
        sql.invRemove.run(id, orgId);
      }
    },
    sessions: {
      async create(record) {
        sql.sesInsert.run(record.id, record.tokenHash, record.userId, record.expiresAt, json(record));
      },
      async getByTokenHash(tokenHash) {
        return parse<SessionRecord>(sql.sesByToken.get(tokenHash) as Row | undefined);
      },
      async touch(id, lastSeenAt, expiresAt) {
        transaction(() => {
          const found = parse<SessionRecord>(sql.sesGet.get(id) as Row | undefined);
          if (!found) return;
          sql.sesUpdate.run(expiresAt, json({ ...found, lastSeenAt, expiresAt }), id);
        });
      },
      async remove(id) {
        sql.sesRemove.run(id);
      },
      async removeForUser(userId) {
        sql.sesRemoveUser.run(userId);
      },
      async prune(now) {
        return Number(sql.sesPrune.run(now).changes);
      }
    }
  };
}
