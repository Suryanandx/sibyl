/**
 * Organizations and AI credits (hosted Sibyl; see docs/hosting.md).
 *
 * - An organization is the `ownerId` every record already carries. Self-hosted
 *   Sibyl has exactly one ("owner", DEFAULT_OWNER_ID) and no record here;
 *   hosted Sibyl (`SIBYL_MODE=hosted`) creates one per sign-up.
 * - The credits ledger is append-only: grants, purchases, charges and refunds,
 *   each with an idempotency key (unique per organization), in micro-USD so
 *   sums are exact. The balance is the sum of an organization's entries.
 */

export interface OrganizationRecord {
  id: string;
  name: string;
  createdAt: number;
  /** User id of the person who created it (its first owner). */
  createdBy?: string;
}

export type CreditEntryKind = "grant" | "purchase" | "charge" | "refund";

export interface CreditEntry {
  orgId: string;
  /** Unique per organization: the same key twice is one entry (retries, webhooks). */
  idempotencyKey: string;
  kind: CreditEntryKind;
  /** Micro-USD (1 USD = 1_000_000). Positive for grant/purchase/refund, negative for charge. */
  amountMicros: number;
  at: number;
  /** Who or what caused it: a usage event id, a payment id, "platform", … */
  reference?: string;
  /** Short human note ("Welcome credits", "brain · openai/gpt-5-mini"). */
  note?: string;
}

export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

export interface OrganizationStore {
  create(record: OrganizationRecord): Promise<void>;
  get(id: string): Promise<OrganizationRecord | undefined>;
  /** Several at once (a person's organizations); unknown ids are left out. */
  getMany(ids: string[]): Promise<OrganizationRecord[]>;
  update(record: OrganizationRecord): Promise<void>;
  count(): Promise<number>;
}

export interface CreditStore {
  /** Append one entry. false: an entry with this idempotency key already exists (nothing written). */
  append(entry: CreditEntry): Promise<boolean>;
  /** Sum of all entries (micro-USD). */
  balance(orgId: string): Promise<number>;
  /** Newest first. */
  list(orgId: string, limit?: number): Promise<CreditEntry[]>;
}

/** In-memory organizations (createMemoryStore). */
export function createMemoryOrganizationStore(): OrganizationStore {
  const records = new Map<string, OrganizationRecord>();
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    async create(record) {
      if (records.has(record.id)) throw new Error("organization already exists");
      records.set(record.id, clone(record));
    },
    async get(id) {
      const found = records.get(id);
      return found ? clone(found) : undefined;
    },
    async getMany(ids) {
      return ids.flatMap((id) => (records.has(id) ? [clone(records.get(id)!)] : []));
    },
    async update(record) {
      if (!records.has(record.id)) throw new Error("organization not found");
      records.set(record.id, clone(record));
    },
    async count() {
      return records.size;
    }
  };
}

/** In-memory credits ledger (createMemoryStore). */
export function createMemoryCreditStore(): CreditStore {
  const entries: CreditEntry[] = [];
  return {
    async append(entry) {
      if (entries.some((e) => e.orgId === entry.orgId && e.idempotencyKey === entry.idempotencyKey)) return false;
      entries.push(structuredClone(entry));
      return true;
    },
    async balance(orgId) {
      return entries.filter((e) => e.orgId === orgId).reduce((sum, e) => sum + e.amountMicros, 0);
    },
    async list(orgId, limit = 50) {
      return entries
        .filter((e) => e.orgId === orgId)
        .reverse()
        .slice(0, limit)
        .map((e) => structuredClone(e));
    }
  };
}
