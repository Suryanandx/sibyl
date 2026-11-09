/**
 * The audit log — Sibyl Enterprise (licence feature `audit_log`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Every audit event from the runtime's Governance becomes one row in the
 * store's append-only `audit` collection. Rows are numbered 1, 2, 3, … and
 * hash-chained: each row's hash covers its content and the previous row's
 * hash (SHA-256 over a canonical JSON form). Changing, inserting or removing
 * any row breaks the chain from there on, and `verify()` says where.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AuditEntryInput, AuditQuery, AuditRecord, Store } from "../../../packages/core/src/index";

/** Domain separator for the entry hash (bump when the hashed form changes). */
export const AUDIT_HASH_VERSION = "sibyl-audit-v1";
const PAGE = 1000;

/** JSON with object keys sorted at every level (the form that is hashed). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The hash of an entry: everything except `hash` itself, chained through `prevHash`. */
export function entryHash(record: Omit<AuditRecord, "hash">): string {
  const { hash: _ignored, ...content } = record as AuditRecord;
  return createHash("sha256").update(`${AUDIT_HASH_VERSION}\n${canonicalJson(content)}`).digest("hex");
}

export interface VerifyResult {
  ok: boolean;
  /** Entries checked. */
  checked: number;
  lastSeq: number;
  lastHash: string;
  /** The first problem found. */
  problem?: { seq: number; reason: "hash_mismatch" | "chain_broken" | "gap"; message: string };
}

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private head: { seq: number; hash: string } | undefined;
  private readonly listeners = new Set<(record: AuditRecord) => void>();

  constructor(
    private readonly options: {
      store: Store;
      orgId: string;
      log: (event: string, fields?: Record<string, unknown>) => void;
      createId?: () => string;
    }
  ) {}

  /** The Governance sink: queue the event (appends happen one at a time, in order). */
  readonly sink = (entry: AuditEntryInput): void => {
    this.queue = this.queue
      .then(() => this.append(entry))
      .then(
        (record) => {
          for (const listener of this.listeners) listener(record);
        },
        (error: unknown) => {
          // Never lose silently: the gateway log says an audit write failed.
          this.options.log("audit.append_failed", { action: entry.action, error: error instanceof Error ? error.message : String(error) });
        }
      );
  };

  /** Called after each appended entry (webhook streaming). */
  onAppended(listener: (record: AuditRecord) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Wait until every queued event is written. */
  flush(): Promise<void> {
    return this.queue;
  }

  private async append(entry: AuditEntryInput): Promise<AuditRecord> {
    // Another gateway process may have appended meanwhile: re-read the head and retry.
    for (let attempt = 0; ; attempt += 1) {
      if (!this.head || attempt > 0) {
        const last = await this.options.store.audit.last(this.options.orgId);
        this.head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: "" };
      }
      const content: Omit<AuditRecord, "hash"> = {
        orgId: this.options.orgId,
        seq: this.head.seq + 1,
        id: this.options.createId?.() ?? randomUUID(),
        at: entry.at,
        action: entry.action,
        actor: entry.actor,
        ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
        ...(entry.target ? { target: entry.target } : {}),
        outcome: entry.outcome,
        ...(entry.details ? { details: entry.details } : {}),
        ...(entry.ip ? { ip: entry.ip } : {}),
        prevHash: this.head.hash
      };
      const record: AuditRecord = { ...content, hash: entryHash(content) };
      try {
        await this.options.store.audit.append(record);
        this.head = { seq: record.seq, hash: record.hash };
        return record;
      } catch (error) {
        if (attempt >= 3) throw error;
      }
    }
  }

  query(query: AuditQuery): Promise<AuditRecord[]> {
    return this.options.store.audit.list(this.options.orgId, query);
  }

  /** Walk the whole chain from the first entry. */
  async verify(): Promise<VerifyResult> {
    await this.flush();
    let previous = { seq: 0, hash: "" };
    let checked = 0;
    for (;;) {
      const page = await this.options.store.audit.scan(this.options.orgId, previous.seq, PAGE);
      for (const record of page) {
        checked += 1;
        if (record.seq !== previous.seq + 1) {
          return fail(checked, previous, record.seq, "gap", `Entry ${previous.seq + 1} is missing (the next one is ${record.seq}).`);
        }
        if (record.prevHash !== previous.hash) {
          return fail(checked, previous, record.seq, "chain_broken", `Entry ${record.seq} does not point at entry ${previous.seq}.`);
        }
        if (entryHash(record) !== record.hash) {
          return fail(checked, previous, record.seq, "hash_mismatch", `Entry ${record.seq} was changed after it was written.`);
        }
        previous = { seq: record.seq, hash: record.hash };
      }
      if (page.length < PAGE) break;
    }
    return { ok: true, checked, lastSeq: previous.seq, lastHash: previous.hash };
  }

  /** Entries for an export, newest first, page by page. */
  async *exportPages(query: AuditQuery, max = 100_000): AsyncGenerator<AuditRecord[]> {
    let beforeSeq = query.beforeSeq;
    let total = 0;
    while (total < max) {
      const page = await this.query({ ...query, ...(beforeSeq !== undefined ? { beforeSeq } : {}), limit: Math.min(PAGE, max - total) });
      if (page.length === 0) return;
      yield page;
      total += page.length;
      beforeSeq = page[page.length - 1]!.seq;
      if (page.length < PAGE) return;
    }
  }
}

function fail(checked: number, previous: { seq: number; hash: string }, seq: number, reason: NonNullable<VerifyResult["problem"]>["reason"], message: string): VerifyResult {
  return { ok: false, checked, lastSeq: previous.seq, lastHash: previous.hash, problem: { seq, reason, message } };
}

/* ───────────── export formats ───────────── */

export const CSV_COLUMNS = [
  "seq",
  "time",
  "action",
  "outcome",
  "actor_kind",
  "actor_user_id",
  "actor_email",
  "actor_name",
  "workspace_id",
  "target_kind",
  "target_id",
  "target_name",
  "ip",
  "details",
  "prev_hash",
  "hash"
] as const;

/** One CSV cell: quoted when needed; a leading =, +, -, @ is defused so spreadsheets don't run it as a formula. */
export function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(record: AuditRecord): string {
  return [
    record.seq,
    new Date(record.at).toISOString(),
    record.action,
    record.outcome,
    record.actor.kind,
    record.actor.userId,
    record.actor.email,
    record.actor.name,
    record.workspaceId,
    record.target?.kind,
    record.target?.id,
    record.target?.name,
    record.ip,
    record.details ? canonicalJson(record.details) : "",
    record.prevHash,
    record.hash
  ]
    .map((cell) => csvCell(typeof cell === "number" ? String(cell) : cell))
    .join(",");
}
