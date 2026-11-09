/**
 * Audit log storage contract: an append-only list of entries per
 * organization, numbered 1, 2, 3, … (`seq`). The store has no update or
 * delete: entries are only ever appended. Each entry carries the hash of the
 * one before it (`prevHash`) and its own `hash`, so a changed or removed row
 * breaks the chain (computed and verified by the audit module, not here).
 */
import type { AuditActor, AuditDetails, AuditOutcome } from "./governance";

export interface AuditRecord {
  orgId: string;
  /** 1, 2, 3, … per organization, without gaps. */
  seq: number;
  id: string;
  at: number;
  action: string;
  actor: AuditActor;
  workspaceId?: string;
  target?: { kind: string; id?: string; name?: string };
  outcome: AuditOutcome;
  details?: AuditDetails;
  ip?: string;
  /** Hash of the previous entry ("" for the first). */
  prevHash: string;
  hash: string;
}

export interface AuditQuery {
  /** Exact action, or a prefix ending in "." (e.g. "auth."). */
  action?: string;
  actorUserId?: string;
  workspaceId?: string;
  outcome?: AuditOutcome;
  /** at ≥ from, at < to. */
  from?: number;
  to?: number;
  /** Case-insensitive text anywhere in the entry. */
  text?: string;
  /** Entries with seq below this (paging, newest first). */
  beforeSeq?: number;
  limit?: number;
}

export interface AuditStore {
  /** Append one entry; throws when its seq is already taken (another writer won). */
  append(record: AuditRecord): Promise<void>;
  /** The newest entry. */
  last(orgId: string): Promise<AuditRecord | undefined>;
  /** Matching entries, newest first (default limit 100). */
  list(orgId: string, query?: AuditQuery): Promise<AuditRecord[]>;
  /** Entries with seq > afterSeq, oldest first (verification, export, streaming). */
  scan(orgId: string, afterSeq: number, limit: number): Promise<AuditRecord[]>;
}

export function matchesAuditQuery(record: AuditRecord, query: AuditQuery): boolean {
  if (query.action) {
    const prefix = query.action.endsWith(".");
    if (prefix ? !record.action.startsWith(query.action) : record.action !== query.action) return false;
  }
  if (query.actorUserId !== undefined && record.actor.userId !== query.actorUserId) return false;
  if (query.workspaceId !== undefined && record.workspaceId !== query.workspaceId) return false;
  if (query.outcome !== undefined && record.outcome !== query.outcome) return false;
  if (query.from !== undefined && record.at < query.from) return false;
  if (query.to !== undefined && record.at >= query.to) return false;
  if (query.beforeSeq !== undefined && record.seq >= query.beforeSeq) return false;
  if (query.text && !JSON.stringify(record).toLowerCase().includes(query.text.toLowerCase())) return false;
  return true;
}

export function createMemoryAuditStore(): AuditStore {
  const byOrg = new Map<string, AuditRecord[]>();
  const rows = (orgId: string) => byOrg.get(orgId) ?? [];
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    async append(record) {
      const list = rows(record.orgId);
      if (list.some((r) => r.seq === record.seq)) throw new Error(`audit entry ${record.seq} already exists`);
      list.push(clone(record));
      byOrg.set(record.orgId, list);
    },
    async last(orgId) {
      const list = rows(orgId);
      const newest = list.reduce<AuditRecord | undefined>((top, r) => (!top || r.seq > top.seq ? r : top), undefined);
      return newest ? clone(newest) : undefined;
    },
    async list(orgId, query = {}) {
      return rows(orgId)
        .filter((r) => matchesAuditQuery(r, query))
        .sort((a, b) => b.seq - a.seq)
        .slice(0, query.limit ?? 100)
        .map(clone);
    },
    async scan(orgId, afterSeq, limit) {
      return rows(orgId)
        .filter((r) => r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map(clone);
    }
  };
}
