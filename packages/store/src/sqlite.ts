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
  AuditQuery,
  AuditRecord,
  AgentMemoryItem,
  AgentRecord,
  SkillProposal,
  ApprovalRecord,
  ArtifactRecord,
  ConversationRecord,
  KnowledgeBaseRecord,
  KnowledgeChunk,
  KnowledgeDocRecord,
  MeetingComment,
  MeetingRecord,
  MeetingSegment,
  MonitorEventRecord,
  MonitorRecord,
  NotificationKind,
  NotificationQuery,
  NotificationRecord,
  PluginRecord,
  SkillRecord,
  WorkspaceRecord,
  RoutineRecord,
  RoutineRunRecord,
  SpaceRecord,
  Store,
  StoredMessage,
  UsageEvent
} from "@open-gpt-live/core";
import { meetingSortAt } from "@open-gpt-live/core";
import { createSqliteIdentityStore, IDENTITY_MIGRATION } from "./identity";
import { createSqliteTenancyStores, TENANCY_MIGRATION } from "./tenancy";

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
  `,
  // 2: workspaces, knowledge bases (FTS5 keyword search), skills, plugins.
  `
  ALTER TABLE conversations ADD COLUMN workspace_id TEXT;
  CREATE INDEX conversations_owner_workspace ON conversations (owner_id, workspace_id, updated_at DESC);

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX workspaces_owner ON workspaces (owner_id);

  CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX knowledge_bases_owner ON knowledge_bases (owner_id, workspace_id);

  CREATE TABLE knowledge_docs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases (id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX knowledge_docs_base ON knowledge_docs (owner_id, knowledge_base_id, created_at DESC);

  CREATE TABLE knowledge_chunks (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    doc_id TEXT NOT NULL REFERENCES knowledge_docs (id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX knowledge_chunks_doc ON knowledge_chunks (doc_id, ordinal);
  CREATE INDEX knowledge_chunks_base ON knowledge_chunks (owner_id, knowledge_base_id);

  CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    text, label, chunk_id UNINDEXED, owner_id UNINDEXED, knowledge_base_id UNINDEXED,
    tokenize = 'porter unicode61'
  );

  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX skills_owner ON skills (owner_id, name);

  CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX plugins_owner ON plugins (owner_id);
  `,
  // 3: users, memberships, invites, sessions; conversations.created_by.
  IDENTITY_MIGRATION,
  // Monitors (v0.4): watched sources and the events they fired.
  `
  CREATE TABLE monitors (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_check_at REAL,
    data TEXT NOT NULL
  );
  CREATE INDEX monitors_owner ON monitors (owner_id, workspace_id);
  CREATE INDEX monitors_due ON monitors (enabled, next_check_at);

  CREATE TABLE monitor_events (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX monitor_events_monitor ON monitor_events (owner_id, monitor_id, at DESC);
  CREATE INDEX monitor_events_owner ON monitor_events (owner_id, workspace_id, at DESC);
  `,
  // Agents (v0.4): agents, per-agent memory (FTS5 search over it), learned-skill proposals.
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    visibility TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX agents_owner_workspace ON agents (owner_id, workspace_id);

  CREATE TABLE agent_memory (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    updated_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX agent_memory_agent ON agent_memory (owner_id, agent_id, updated_at DESC);

  CREATE VIRTUAL TABLE agent_memory_fts USING fts5(
    text, item_id UNINDEXED, owner_id UNINDEXED, agent_id UNINDEXED,
    tokenize = 'porter unicode61'
  );

  CREATE TABLE skill_proposals (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX skill_proposals_agent ON skill_proposals (owner_id, agent_id, created_at DESC);
  `,
  // Notifications (v0.4): one record for everything Sibyl tells people about.
  `
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    recipient_user_id TEXT,
    kind TEXT NOT NULL,
    approval_id TEXT,
    created_at REAL NOT NULL,
    read_at REAL,
    data TEXT NOT NULL
  );
  CREATE INDEX notifications_feed ON notifications (owner_id, workspace_id, created_at DESC, id DESC);
  CREATE INDEX notifications_unread ON notifications (owner_id, workspace_id, read_at);
  CREATE INDEX notifications_approval ON notifications (owner_id, approval_id);
  `,
  // Audit log (v0.4 Enterprise): append-only, one hash-chained row per event.
  `
  CREATE TABLE audit_log (
    org_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at REAL NOT NULL,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    workspace_id TEXT,
    outcome TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (org_id, seq)
  );
  CREATE INDEX audit_log_action ON audit_log (org_id, action, seq DESC);
  CREATE INDEX audit_log_at ON audit_log (org_id, at);
  `,
  // Notifications: per-person read marks for broadcasts (records without a recipient).
  `
  CREATE TABLE notification_reads (
    notification_id TEXT NOT NULL,
    reader TEXT NOT NULL,
    read_at REAL NOT NULL,
    PRIMARY KEY (notification_id, reader)
  );
  CREATE INDEX notifications_created ON notifications (owner_id, created_at);
  `,
  // Meetings (wave C): the record, its transcript segments (numbered per meeting) and comments.
  `
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    sort_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX meetings_list ON meetings (owner_id, workspace_id, sort_at DESC);

  CREATE TABLE meeting_segments (
    meeting_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (meeting_id, seq)
  );

  CREATE TABLE meeting_comments (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    parent_id TEXT,
    created_at REAL NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX meeting_comments_meeting ON meeting_comments (meeting_id, created_at);
  `,
  // Hosted Sibyl: organizations, the AI credits ledger, users by email across organizations.
  TENANCY_MIGRATION
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
      `SELECT id, owner_id, workspace_id, created_by, title, created_at, updated_at FROM conversations
       WHERE owner_id = ? AND (? IS NULL OR COALESCE(workspace_id, 'default') = ?)
       ORDER BY updated_at DESC, rowid ASC LIMIT ?`
    ),
    convGet: prepare("SELECT id, owner_id, workspace_id, created_by, title, created_at, updated_at FROM conversations WHERE id = ? AND owner_id = ?"),
    convUpsert: prepare(
      `INSERT INTO conversations (id, owner_id, workspace_id, created_by, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, workspace_id = excluded.workspace_id, created_by = excluded.created_by,
         title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at`
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
    usageEvents: prepare("SELECT data FROM usage_events WHERE owner_id = ? AND at >= ? AND at < ? ORDER BY seq ASC"),

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
    artifactRemove: prepare("DELETE FROM artifacts WHERE id = ? AND owner_id = ?"),
    auditInsert: prepare("INSERT INTO audit_log (org_id, seq, at, action, actor_user_id, workspace_id, outcome, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    auditLast: prepare("SELECT data FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1"),
    auditScan: prepare("SELECT data FROM audit_log WHERE org_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"),
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

    monitorList: prepare(
      "SELECT data FROM monitors WHERE owner_id = ? AND (? IS NULL OR workspace_id = ?) ORDER BY rowid ASC"
    ),
    monitorGet: prepare("SELECT data FROM monitors WHERE id = ? AND owner_id = ?"),
    monitorUpsert: prepare(
      `INSERT INTO monitors (id, owner_id, workspace_id, enabled, next_check_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, workspace_id = excluded.workspace_id,
         enabled = excluded.enabled, next_check_at = excluded.next_check_at, data = excluded.data`
    ),
    monitorRemove: prepare("DELETE FROM monitors WHERE id = ? AND owner_id = ?"),
    monitorEventsRemove: prepare("DELETE FROM monitor_events WHERE monitor_id = ? AND owner_id = ?"),
    monitorDue: prepare(
      "SELECT data FROM monitors WHERE enabled = 1 AND next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at ASC, rowid ASC"
    ),
    monitorEventInsert: prepare(
      `INSERT INTO monitor_events (id, monitor_id, owner_id, workspace_id, created_by, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data = excluded.data`
    ),
    monitorEventList: prepare(
      `SELECT data FROM monitor_events WHERE owner_id = ?
         AND (? IS NULL OR monitor_id = ?) AND (? IS NULL OR workspace_id = ?) AND (? IS NULL OR created_by = ?)
         AND (? IS NULL OR at < ?)
       ORDER BY at DESC, rowid ASC LIMIT ?`
    ),

    notificationInsert: prepare(
      `INSERT INTO notifications (id, owner_id, workspace_id, recipient_user_id, kind, approval_id, created_at, read_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, workspace_id = excluded.workspace_id,
         recipient_user_id = excluded.recipient_user_id, kind = excluded.kind, approval_id = excluded.approval_id,
         created_at = excluded.created_at, read_at = excluded.read_at, data = excluded.data`
    ),
    notificationGet: prepare("SELECT data FROM notifications WHERE id = ? AND owner_id = ?"),

    kvGet: prepare("SELECT value FROM kv WHERE owner_id = ? AND key = ?"),
    kvSet: prepare(
      "INSERT INTO kv (owner_id, key, value) VALUES (?, ?, ?) ON CONFLICT (owner_id, key) DO UPDATE SET value = excluded.value"
    ),
    kvDelete: prepare("DELETE FROM kv WHERE owner_id = ? AND key = ?"),

    wsList: prepare("SELECT data FROM workspaces WHERE owner_id = ? ORDER BY rowid ASC"),
    wsGet: prepare("SELECT data FROM workspaces WHERE id = ? AND owner_id = ?"),
    wsUpsert: prepare(
      "INSERT INTO workspaces (id, owner_id, data) VALUES (?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET data = excluded.data"
    ),
    wsRemove: prepare("DELETE FROM workspaces WHERE id = ? AND owner_id = ?"),

    kbList: prepare("SELECT data FROM knowledge_bases WHERE owner_id = ? AND (? IS NULL OR workspace_id = ?) ORDER BY rowid ASC"),
    kbGet: prepare("SELECT data FROM knowledge_bases WHERE id = ? AND owner_id = ?"),
    kbUpsert: prepare(
      `INSERT INTO knowledge_bases (id, owner_id, workspace_id, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, workspace_id = excluded.workspace_id, data = excluded.data`
    ),
    kbRemove: prepare("DELETE FROM knowledge_bases WHERE id = ? AND owner_id = ?"),
    ftsRemoveBase: prepare("DELETE FROM knowledge_fts WHERE knowledge_base_id = ? AND owner_id = ?"),
    docList: prepare("SELECT data FROM knowledge_docs WHERE owner_id = ? AND knowledge_base_id = ? ORDER BY created_at DESC, rowid ASC"),
    docGet: prepare("SELECT data FROM knowledge_docs WHERE id = ? AND owner_id = ?"),
    docUpsert: prepare(
      `INSERT INTO knowledge_docs (id, owner_id, knowledge_base_id, created_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, knowledge_base_id = excluded.knowledge_base_id,
         created_at = excluded.created_at, data = excluded.data`
    ),
    docRemove: prepare("DELETE FROM knowledge_docs WHERE id = ? AND owner_id = ?"),
    chunkIdsForDoc: prepare("SELECT id FROM knowledge_chunks WHERE doc_id = ? AND owner_id = ?"),
    chunkDeleteDoc: prepare("DELETE FROM knowledge_chunks WHERE doc_id = ? AND owner_id = ?"),
    chunkInsert: prepare(
      "INSERT INTO knowledge_chunks (id, owner_id, knowledge_base_id, doc_id, ordinal, data) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    ftsDeleteChunk: prepare("DELETE FROM knowledge_fts WHERE chunk_id = ?"),
    ftsInsert: prepare("INSERT INTO knowledge_fts (text, label, chunk_id, owner_id, knowledge_base_id) VALUES (?, ?, ?, ?, ?)"),
    ftsSearch: prepare(
      `SELECT c.data AS data, bm25(knowledge_fts) AS rank FROM knowledge_fts
       JOIN knowledge_chunks c ON c.id = knowledge_fts.chunk_id
       WHERE knowledge_fts MATCH ? AND knowledge_fts.owner_id = ?
       ORDER BY rank LIMIT ?`
    ),
    chunkListBase: prepare("SELECT data FROM knowledge_chunks WHERE owner_id = ? AND knowledge_base_id = ? ORDER BY doc_id, ordinal"),

    skillList: prepare("SELECT data FROM skills WHERE owner_id = ? ORDER BY name ASC, rowid ASC"),
    skillGet: prepare("SELECT data FROM skills WHERE id = ? AND owner_id = ?"),
    skillUpsert: prepare(
      "INSERT INTO skills (id, owner_id, name, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, name = excluded.name, data = excluded.data"
    ),
    skillRemove: prepare("DELETE FROM skills WHERE id = ? AND owner_id = ?"),

    pluginList: prepare("SELECT data FROM plugins WHERE owner_id = ? ORDER BY rowid ASC"),
    pluginGet: prepare("SELECT data FROM plugins WHERE id = ? AND owner_id = ?"),
    pluginUpsert: prepare(
      "INSERT INTO plugins (id, owner_id, data) VALUES (?, ?, ?) ON CONFLICT (owner_id, id) DO UPDATE SET data = excluded.data"
    ),
    pluginRemove: prepare("DELETE FROM plugins WHERE id = ? AND owner_id = ?"),

    meetingUpsert: prepare(
      `INSERT INTO meetings (id, owner_id, workspace_id, sort_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, id) DO UPDATE SET workspace_id = excluded.workspace_id,
         sort_at = excluded.sort_at, data = excluded.data`
    ),
    meetingGet: prepare("SELECT data FROM meetings WHERE id = ? AND owner_id = ?"),
    meetingList: prepare(
      "SELECT data FROM meetings WHERE owner_id = ? AND (? IS NULL OR workspace_id = ?) ORDER BY sort_at DESC, rowid ASC LIMIT ?"
    ),
    meetingRemove: prepare("DELETE FROM meetings WHERE id = ? AND owner_id = ?"),
    meetingSegmentsRemove: prepare("DELETE FROM meeting_segments WHERE meeting_id = ? AND owner_id = ?"),
    meetingCommentsRemove: prepare("DELETE FROM meeting_comments WHERE meeting_id = ? AND owner_id = ?"),
    meetingSegmentLast: prepare("SELECT seq FROM meeting_segments WHERE meeting_id = ? AND owner_id = ? ORDER BY seq DESC LIMIT 1"),
    meetingSegmentInsert: prepare("INSERT INTO meeting_segments (meeting_id, seq, owner_id, data) VALUES (?, ?, ?, ?)"),
    meetingSegmentList: prepare("SELECT data FROM meeting_segments WHERE meeting_id = ? AND owner_id = ? AND seq > ? ORDER BY seq ASC"),
    meetingCommentUpsert: prepare(
      `INSERT INTO meeting_comments (id, owner_id, meeting_id, parent_id, created_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, meeting_id = excluded.meeting_id,
         parent_id = excluded.parent_id, created_at = excluded.created_at, data = excluded.data`
    ),
    meetingCommentGet: prepare("SELECT data FROM meeting_comments WHERE id = ? AND owner_id = ?"),
    meetingCommentList: prepare("SELECT data FROM meeting_comments WHERE meeting_id = ? AND owner_id = ? ORDER BY created_at ASC, rowid ASC"),
    meetingCommentRemove: prepare("DELETE FROM meeting_comments WHERE id = ? AND owner_id = ?"),
    meetingCommentRemoveReplies: prepare("DELETE FROM meeting_comments WHERE parent_id = ? AND owner_id = ?"),
    agentList: prepare("SELECT data FROM agents WHERE owner_id = ? AND (? IS NULL OR workspace_id = ?) ORDER BY rowid ASC"),
    agentGet: prepare("SELECT data FROM agents WHERE id = ? AND owner_id = ?"),
    agentUpsert: prepare(
      `INSERT INTO agents (id, owner_id, workspace_id, created_by, visibility, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, workspace_id = excluded.workspace_id,
         created_by = excluded.created_by, visibility = excluded.visibility, data = excluded.data`
    ),
    agentRemove: prepare("DELETE FROM agents WHERE id = ? AND owner_id = ?"),
    agentFtsRemoveAgent: prepare("DELETE FROM agent_memory_fts WHERE agent_id = ? AND owner_id = ?"),
    agentMemoryRemoveAgent: prepare("DELETE FROM agent_memory WHERE agent_id = ? AND owner_id = ?"),
    agentProposalsRemoveAgent: prepare("DELETE FROM skill_proposals WHERE agent_id = ? AND owner_id = ?"),
    amList: prepare(
      `SELECT data FROM agent_memory WHERE owner_id = ? AND agent_id = ? AND (? IS NULL OR kind = ?)
       ORDER BY updated_at DESC, rowid ASC LIMIT ?`
    ),
    amGet: prepare("SELECT data FROM agent_memory WHERE id = ? AND owner_id = ?"),
    amUpsert: prepare(
      `INSERT INTO agent_memory (id, owner_id, agent_id, kind, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, agent_id = excluded.agent_id, kind = excluded.kind,
         updated_at = excluded.updated_at, data = excluded.data`
    ),
    amRemove: prepare("DELETE FROM agent_memory WHERE id = ? AND owner_id = ?"),
    amFtsDelete: prepare("DELETE FROM agent_memory_fts WHERE item_id = ?"),
    amFtsInsert: prepare("INSERT INTO agent_memory_fts (text, item_id, owner_id, agent_id) VALUES (?, ?, ?, ?)"),
    amFtsSearch: prepare(
      `SELECT m.data AS data FROM agent_memory_fts
       JOIN agent_memory m ON m.id = agent_memory_fts.item_id
       WHERE agent_memory_fts MATCH ? AND agent_memory_fts.owner_id = ? AND agent_memory_fts.agent_id = ?
       ORDER BY bm25(agent_memory_fts) LIMIT ?`
    ),
    spList: prepare(
      `SELECT data FROM skill_proposals WHERE owner_id = ? AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR status = ?)
       ORDER BY created_at DESC, rowid ASC`
    ),
    spGet: prepare("SELECT data FROM skill_proposals WHERE id = ? AND owner_id = ?"),
    spUpsert: prepare(
      `INSERT INTO skill_proposals (id, owner_id, agent_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, agent_id = excluded.agent_id, status = excluded.status,
         created_at = excluded.created_at, data = excluded.data`
    ),
    spRemove: prepare("DELETE FROM skill_proposals WHERE id = ? AND owner_id = ?")
  };

  const toSummary = (row: Row): Omit<ConversationRecord, "messages"> => ({
    id: String(row.id),
    ownerId: String(row.owner_id),
    ...(row.workspace_id === null || row.workspace_id === undefined ? {} : { workspaceId: String(row.workspace_id) }),
    ...(row.created_by === null || row.created_by === undefined ? {} : { createdBy: String(row.created_by) }),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  });

  return {
    conversations: {
      async list(ownerId, limit = 100, filter = {}) {
        const workspaceId = filter.workspaceId || null;
        return (sql.convList.all(ownerId, workspaceId, workspaceId, limit) as Row[]).map(toSummary);
      },
      async get(ownerId, id) {
        const row = sql.convGet.get(id, ownerId) as Row | undefined;
        if (!row) return undefined;
        return { ...toSummary(row), messages: parseAll<StoredMessage>(sql.msgList.all(id) as Row[]) };
      },
      async upsert(record) {
        transaction(() => {
          sql.convUpsert.run(record.id, record.ownerId, opt(record.workspaceId), opt(record.createdBy), record.title, record.createdAt, record.updatedAt);
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
      },
      async list(ownerId, from, to) {
        return parseAll<UsageEvent>(sql.usageEvents.all(ownerId, from, to) as Row[]);
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
      },
      async remove(ownerId, id) {
        sql.artifactRemove.run(id, ownerId);
      }
    },
    ...createSqliteTenancyStores(db),
    audit: {
      async append(record) {
        sql.auditInsert.run(
          record.orgId,
          record.seq,
          record.at,
          record.action,
          opt(record.actor.userId),
          opt(record.workspaceId),
          record.outcome,
          json(record)
        );
      },
      async last(orgId) {
        return parse<AuditRecord>(sql.auditLast.get(orgId) as Row | undefined);
      },
      async list(orgId, query = {}) {
        const where = auditWhere(orgId, query);
        const rows = prepare(`SELECT data FROM audit_log WHERE ${where.sql} ORDER BY seq DESC LIMIT ?`).all(...where.params, query.limit ?? 100) as Row[];
        return parseAll<AuditRecord>(rows);
      },
      async scan(orgId, afterSeq, limit) {
        return parseAll<AuditRecord>(sql.auditScan.all(orgId, afterSeq, limit) as Row[]);
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
    workspaces: {
      async list(ownerId) {
        return parseAll<WorkspaceRecord>(sql.wsList.all(ownerId) as Row[]);
      },
      async get(ownerId, id) {
        return parse<WorkspaceRecord>(sql.wsGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.wsUpsert.run(record.id, record.ownerId, json(record));
      },
      async remove(ownerId, id) {
        sql.wsRemove.run(id, ownerId);
      }
    },
    knowledge: {
      async listBases(ownerId, filter = {}) {
        const workspaceId = filter.workspaceId || null;
        return parseAll<KnowledgeBaseRecord>(sql.kbList.all(ownerId, workspaceId, workspaceId) as Row[]);
      },
      async getBase(ownerId, id) {
        return parse<KnowledgeBaseRecord>(sql.kbGet.get(id, ownerId) as Row | undefined);
      },
      async upsertBase(record) {
        sql.kbUpsert.run(record.id, record.ownerId, record.workspaceId, json(record));
      },
      async removeBase(ownerId, id) {
        transaction(() => {
          sql.ftsRemoveBase.run(id, ownerId);
          sql.kbRemove.run(id, ownerId);
        });
      },
      async listDocs(ownerId, knowledgeBaseId) {
        return parseAll<KnowledgeDocRecord>(sql.docList.all(ownerId, knowledgeBaseId) as Row[]);
      },
      async getDoc(ownerId, id) {
        return parse<KnowledgeDocRecord>(sql.docGet.get(id, ownerId) as Row | undefined);
      },
      async upsertDoc(record) {
        sql.docUpsert.run(record.id, record.ownerId, record.knowledgeBaseId, record.createdAt, json(record));
      },
      async removeDoc(ownerId, id) {
        transaction(() => {
          for (const row of sql.chunkIdsForDoc.all(id, ownerId) as Row[]) sql.ftsDeleteChunk.run(String(row.id));
          sql.docRemove.run(id, ownerId);
        });
      },
      async replaceChunks(ownerId, docId, chunks) {
        transaction(() => {
          for (const row of sql.chunkIdsForDoc.all(docId, ownerId) as Row[]) sql.ftsDeleteChunk.run(String(row.id));
          sql.chunkDeleteDoc.run(docId, ownerId);
          for (const chunk of chunks) {
            sql.chunkInsert.run(chunk.id, chunk.ownerId, chunk.knowledgeBaseId, chunk.docId, chunk.ordinal, json(chunk));
            sql.ftsInsert.run(chunk.text, chunk.label ?? "", chunk.id, chunk.ownerId, chunk.knowledgeBaseId);
          }
        });
      },
      async search(ownerId, knowledgeBaseIds, query, limit = 8) {
        const match = ftsQuery(query);
        if (!match || knowledgeBaseIds.length === 0) return [];
        const ids = new Set(knowledgeBaseIds);
        // Over-fetch, then keep the requested bases (FTS5 can't index-filter UNINDEXED columns).
        const rows = sql.ftsSearch.all(match, ownerId, Math.max(limit * 8, 50)) as Row[];
        return rows
          .map((row) => ({ chunk: JSON.parse(String(row.data)) as KnowledgeChunk, score: -Number(row.rank) }))
          .filter((hit) => ids.has(hit.chunk.knowledgeBaseId))
          .slice(0, limit);
      },
      async chunks(ownerId, knowledgeBaseIds) {
        return knowledgeBaseIds.flatMap((id) => parseAll<KnowledgeChunk>(sql.chunkListBase.all(ownerId, id) as Row[]));
      }
    },
    skills: {
      async list(ownerId, filter = {}) {
        return parseAll<SkillRecord>(sql.skillList.all(ownerId) as Row[]).filter(
          (skill) => !skill.workspaceId || !filter.workspaceId || skill.workspaceId === filter.workspaceId
        );
      },
      async get(ownerId, id) {
        return parse<SkillRecord>(sql.skillGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.skillUpsert.run(record.id, record.ownerId, record.name, json(record));
      },
      async remove(ownerId, id) {
        sql.skillRemove.run(id, ownerId);
      }
    },
    plugins: {
      async list(ownerId) {
        return parseAll<PluginRecord>(sql.pluginList.all(ownerId) as Row[]);
      },
      async get(ownerId, id) {
        return parse<PluginRecord>(sql.pluginGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.pluginUpsert.run(record.id, record.ownerId, json(record));
      },
      async remove(ownerId, id) {
        sql.pluginRemove.run(id, ownerId);
      }
    },
    identity: createSqliteIdentityStore(db, transaction),
    monitors: {
      async list(ownerId, filter = {}) {
        const ws = opt(filter.workspaceId);
        return parseAll<MonitorRecord>(sql.monitorList.all(ownerId, ws, ws) as Row[]);
      },
      async get(ownerId, id) {
        return parse<MonitorRecord>(sql.monitorGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.monitorUpsert.run(record.id, record.ownerId, record.workspaceId, record.enabled ? 1 : 0, opt(record.nextCheckAt), json(record));
      },
      async remove(ownerId, id) {
        transaction(() => {
          const removed = sql.monitorRemove.run(id, ownerId);
          if (Number(removed.changes) > 0) sql.monitorEventsRemove.run(id, ownerId);
        });
      },
      async due(now) {
        return parseAll<MonitorRecord>(sql.monitorDue.all(now) as Row[]);
      },
      async insertEvent(event) {
        sql.monitorEventInsert.run(event.id, event.monitorId, event.ownerId, event.workspaceId, event.createdBy, event.at, json(event));
      },
      async listEvents(ownerId, filter = {}) {
        const monitorId = opt(filter.monitorId);
        const ws = opt(filter.workspaceId);
        const by = opt(filter.createdBy);
        const before = opt(filter.before);
        return parseAll<MonitorEventRecord>(
          sql.monitorEventList.all(ownerId, monitorId, monitorId, ws, ws, by, by, before, before, filter.limit ?? 50) as Row[]
        );
      }
    },
    notifications: {
      async insert(record) {
        sql.notificationInsert.run(
          record.id,
          record.ownerId,
          record.workspaceId,
          opt(record.recipientUserId),
          record.kind,
          opt(record.links.approvalId),
          record.createdAt,
          opt(record.readAt),
          json(record)
        );
      },
      async get(ownerId, id) {
        return parse<NotificationRecord>(sql.notificationGet.get(id, ownerId) as Row | undefined);
      },
      async list(ownerId, query = {}) {
        const where = notificationWhere(ownerId, query);
        if (query.before) {
          where.sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
          where.params.push(query.before.createdAt, query.before.createdAt, query.before.id);
        }
        // The reader's own mark on a broadcast (unless it was read for everyone).
        const readerColumn =
          query.reader === undefined
            ? "NULL"
            : "(SELECT r.read_at FROM notification_reads r WHERE r.notification_id = notifications.id AND r.reader = ?)";
        const rows = prepare(
          `SELECT data, recipient_user_id, read_at, ${readerColumn} AS reader_read_at FROM notifications WHERE ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ?`
        ).all(...(query.reader === undefined ? [] : [query.reader]), ...where.params, query.limit ?? 50) as Row[];
        return rows.map((row) => {
          const record = JSON.parse(String(row.data)) as NotificationRecord;
          if (row.read_at === null && row.recipient_user_id === null && row.reader_read_at !== null) record.readAt = Number(row.reader_read_at);
          return record;
        });
      },
      async countUnread(ownerId, query = {}) {
        const where = notificationWhere(ownerId, { ...query, unread: true });
        const rows = prepare(`SELECT kind, COUNT(*) AS n FROM notifications WHERE ${where.sql} GROUP BY kind`).all(...where.params) as Row[];
        const out: Partial<Record<NotificationKind, number>> = {};
        for (const row of rows) out[String(row.kind) as NotificationKind] = Number(row.n);
        return out;
      },
      async markRead(ownerId, query, at) {
        const where = notificationWhere(ownerId, { ...query, unread: true });
        return transaction(() => {
          const rows = prepare(`SELECT id, recipient_user_id FROM notifications WHERE ${where.sql}`).all(...where.params) as Row[];
          const markRecord = prepare("UPDATE notifications SET read_at = ?, data = json_set(data, '$.readAt', ?) WHERE id = ?");
          const markReader = prepare("INSERT OR IGNORE INTO notification_reads (notification_id, reader, read_at) VALUES (?, ?, ?)");
          for (const row of rows) {
            // A broadcast is read only for this reader; an addressed record (or no reader) for everyone.
            if (query.reader !== undefined && row.recipient_user_id === null) markReader.run(String(row.id), query.reader, at);
            else markRecord.run(at, at, String(row.id));
          }
          return rows.map((row) => String(row.id));
        });
      },
      async prune(ownerId, before) {
        return transaction(() => {
          prepare(
            "DELETE FROM notification_reads WHERE notification_id IN (SELECT id FROM notifications WHERE owner_id = ? AND created_at < ?)"
          ).run(ownerId, before);
          return Number(prepare("DELETE FROM notifications WHERE owner_id = ? AND created_at < ?").run(ownerId, before).changes);
        });
      }
    },
    meetings: {
      async upsert(record) {
        sql.meetingUpsert.run(record.id, record.ownerId, record.workspaceId, meetingSortAt(record), json(record));
      },
      async get(ownerId, id) {
        return parse<MeetingRecord>(sql.meetingGet.get(id, ownerId) as Row | undefined);
      },
      async list(ownerId, query = {}) {
        const workspaceId = query.workspaceId ?? null;
        return parseAll<MeetingRecord>(sql.meetingList.all(ownerId, workspaceId, workspaceId, query.limit ?? 200) as Row[]);
      },
      async remove(ownerId, id) {
        transaction(() => {
          if (!sql.meetingGet.get(id, ownerId)) return;
          sql.meetingSegmentsRemove.run(id, ownerId);
          sql.meetingCommentsRemove.run(id, ownerId);
          sql.meetingRemove.run(id, ownerId);
        });
      },
      async appendSegment(segment) {
        return transaction(() => {
          const last = sql.meetingSegmentLast.get(segment.meetingId, segment.ownerId) as Row | undefined;
          const stored: MeetingSegment = { ...segment, seq: Number(last?.seq ?? 0) + 1 };
          sql.meetingSegmentInsert.run(stored.meetingId, stored.seq, stored.ownerId, json(stored));
          return stored;
        });
      },
      async segments(ownerId, meetingId, afterSeq = 0) {
        return parseAll<MeetingSegment>(sql.meetingSegmentList.all(meetingId, ownerId, afterSeq) as Row[]);
      },
      async upsertComment(comment) {
        sql.meetingCommentUpsert.run(comment.id, comment.ownerId, comment.meetingId, opt(comment.parentId), comment.createdAt, json(comment));
      },
      async getComment(ownerId, id) {
        return parse<MeetingComment>(sql.meetingCommentGet.get(id, ownerId) as Row | undefined);
      },
      async comments(ownerId, meetingId) {
        return parseAll<MeetingComment>(sql.meetingCommentList.all(meetingId, ownerId) as Row[]);
      },
      async removeComment(ownerId, id) {
        transaction(() => {
          if (!sql.meetingCommentGet.get(id, ownerId)) return;
          sql.meetingCommentRemoveReplies.run(id, ownerId);
          sql.meetingCommentRemove.run(id, ownerId);
        });
      }
    },
    agents: {
      async list(ownerId, filter = {}) {
        const workspaceId = filter.workspaceId || null;
        // Sorted in JS so the order matches the memory store (localeCompare, not SQLite collation).
        return parseAll<AgentRecord>(sql.agentList.all(ownerId, workspaceId, workspaceId) as Row[])
          .filter((a) => filter.visibleTo === undefined || a.visibility === "workspace" || !filter.visibleTo || a.createdBy === filter.visibleTo)
          .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
      },
      async get(ownerId, id) {
        return parse<AgentRecord>(sql.agentGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.agentUpsert.run(record.id, record.ownerId, record.workspaceId, record.createdBy, record.visibility, json(record));
      },
      async remove(ownerId, id) {
        transaction(() => {
          if (!sql.agentGet.get(id, ownerId)) return;
          sql.agentFtsRemoveAgent.run(id, ownerId);
          sql.agentMemoryRemoveAgent.run(id, ownerId);
          sql.agentProposalsRemoveAgent.run(id, ownerId);
          sql.agentRemove.run(id, ownerId);
        });
      }
    },
    agentMemory: {
      async list(ownerId, agentId, filter = {}) {
        const kind = filter.kind ?? null;
        return parseAll<AgentMemoryItem>(sql.amList.all(ownerId, agentId, kind, kind, filter.limit ?? -1) as Row[]);
      },
      async get(ownerId, id) {
        return parse<AgentMemoryItem>(sql.amGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        transaction(() => {
          sql.amUpsert.run(record.id, record.ownerId, record.agentId, record.kind, record.updatedAt, json(record));
          sql.amFtsDelete.run(record.id);
          sql.amFtsInsert.run(record.text, record.id, record.ownerId, record.agentId);
        });
      },
      async remove(ownerId, id) {
        transaction(() => {
          if (!sql.amGet.get(id, ownerId)) return;
          sql.amFtsDelete.run(id);
          sql.amRemove.run(id, ownerId);
        });
      },
      async search(ownerId, agentId, query, limit = 8) {
        const match = ftsQuery(query);
        if (!match) return [];
        return parseAll<AgentMemoryItem>(sql.amFtsSearch.all(match, ownerId, agentId, limit) as Row[]);
      }
    },
    skillProposals: {
      async list(ownerId, filter = {}) {
        const agentId = filter.agentId || null;
        const status = filter.status || null;
        return parseAll<SkillProposal>(sql.spList.all(ownerId, agentId, agentId, status, status) as Row[]);
      },
      async get(ownerId, id) {
        return parse<SkillProposal>(sql.spGet.get(id, ownerId) as Row | undefined);
      },
      async upsert(record) {
        sql.spUpsert.run(record.id, record.ownerId, record.agentId, record.status, record.createdAt, json(record));
      },
      async remove(ownerId, id) {
        sql.spRemove.run(id, ownerId);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    }
  };
}

/** WHERE clause (and parameters) for an audit query; same semantics as matchesAuditQuery. */
function auditWhere(orgId: string, query: AuditQuery): { sql: string; params: SQLInputValue[] } {
  const clauses = ["org_id = ?"];
  const params: SQLInputValue[] = [orgId];
  const add = (clause: string, value: SQLInputValue) => {
    clauses.push(clause);
    params.push(value);
  };
  if (query.action?.endsWith(".")) {
    clauses.push("substr(action, 1, ?) = ?");
    params.push(query.action.length, query.action);
  } else if (query.action) {
    add("action = ?", query.action);
  }
  if (query.actorUserId !== undefined) add("actor_user_id = ?", query.actorUserId);
  if (query.workspaceId !== undefined) add("workspace_id = ?", query.workspaceId);
  if (query.outcome !== undefined) add("outcome = ?", query.outcome);
  if (query.from !== undefined) add("at >= ?", query.from);
  if (query.to !== undefined) add("at < ?", query.to);
  if (query.beforeSeq !== undefined) add("seq < ?", query.beforeSeq);
  if (query.text) add("instr(lower(data), ?) > 0", query.text.toLowerCase());
  return { sql: clauses.join(" AND "), params };
}

/** WHERE clause (and parameters) for a notification query; same semantics as matchesNotificationQuery. */
function notificationWhere(ownerId: string, query: NotificationQuery): { sql: string; params: SQLInputValue[] } {
  const clauses = ["owner_id = ?"];
  const params: SQLInputValue[] = [ownerId];
  if (query.workspaceId !== undefined) {
    clauses.push("workspace_id = ?");
    params.push(query.workspaceId);
  }
  if (query.recipient !== undefined) {
    clauses.push("(recipient_user_id IS NULL OR recipient_user_id = ?)");
    params.push(query.recipient);
  }
  if (query.unread) {
    clauses.push("read_at IS NULL");
    if (query.reader !== undefined) {
      // Broadcasts: unread until this reader read them.
      clauses.push(
        "(recipient_user_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = notifications.id AND r.reader = ?))"
      );
      params.push(query.reader);
    }
  }
  if (query.approvalId !== undefined) {
    clauses.push("approval_id = ?");
    params.push(query.approvalId);
  }
  for (const [column, values] of [["kind", query.kinds], ["id", query.ids]] as const) {
    if (!values) continue;
    if (values.length === 0) {
      clauses.push("0");
      continue;
    }
    clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }
  return { sql: clauses.join(" AND "), params };
}

/** Turn free text into a safe FTS5 query: quoted terms joined with OR, prefix-matched. */
function ftsQuery(text: string): string {
  const terms = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .slice(0, 24);
  return [...new Set(terms)].map((term) => `"${term}"*`).join(" OR ");
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
