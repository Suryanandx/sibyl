/**
 * Where connections live.
 *
 * - Connection records (no secrets): `store.kv` key `connectors.connections.v1`.
 * - Credentials (access/refresh tokens, API keys): `connectors.credentials.v1`,
 *   each entry AES-256-GCM encrypted with the secrets vault's master key
 *   (SIBYL_SECRET_KEY / data/secret.key), bound to the connection id.
 *   They are kept apart from the named secrets on purpose: the Secrets panel
 *   and the `api_request` tool can't see or use them, so one person's
 *   personal token can't be borrowed by anyone else's chat.
 * - Org app settings (allowed groups, tenant, login host):
 *   `connectors.apps.v1`. Client ID/secret are vault secrets.
 *
 * Decrypted credentials stay in memory, registered with the process-wide
 * redactor so they are scrubbed from any tool output the model reads.
 */
import type { Store } from "@open-gpt-live/core";
import { decryptValue, encryptValue } from "../secrets/crypto.js";
import { redactionNeedles, redactWith, registerRedactor, type RedactionEntry } from "../secrets/redact.js";
import type { ConnectionRecord, StoredCredentials } from "./types.js";

export const CONNECTIONS_KV_KEY = "connectors.connections.v1";
export const CREDENTIALS_KV_KEY = "connectors.credentials.v1";
export const APPS_KV_KEY = "connectors.apps.v1";

export interface AppConfig {
  /** Groups members may switch on (absent: all). */
  allowedGroups?: string[];
  /** Values for the connector's app settings (tenant, login host). */
  settings?: Record<string, string>;
  updatedAt?: number;
}

export class ConnectionStore {
  private records = new Map<string, ConnectionRecord>();
  private credentials = new Map<string, StoredCredentials>();
  private apps: Record<string, AppConfig> = {};
  private redaction: RedactionEntry[] = [];
  /** Old values stay redacted for the life of the process. */
  private retired: string[] = [];
  private readonly unregisterRedactor: () => void;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      store: Store;
      ownerId: string;
      key: Buffer;
      log: (event: string, fields?: Record<string, unknown>) => void;
    }
  ) {
    this.unregisterRedactor = registerRedactor((ownerId, text) => (ownerId === this.options.ownerId ? redactWith(this.redaction, text) : text));
  }

  async load(): Promise<void> {
    const { store, ownerId, key } = this.options;
    const records = (await store.kv.get<ConnectionRecord[]>(ownerId, CONNECTIONS_KV_KEY)) ?? [];
    this.records = new Map(records.filter((record) => record && typeof record.id === "string").map((record) => [record.id, record]));
    const encrypted = (await store.kv.get<Record<string, string>>(ownerId, CREDENTIALS_KV_KEY)) ?? {};
    for (const [id, ciphertext] of Object.entries(encrypted)) {
      try {
        this.credentials.set(id, JSON.parse(decryptValue(key, ownerId, credentialName(id), ciphertext)) as StoredCredentials);
      } catch {
        // Wrong master key or tampered value: the connection has to be made again.
        const record = this.records.get(id);
        if (record) this.records.set(id, { ...record, status: "reconnect", statusMessage: "Stored sign-in can't be decrypted (was the secrets key changed?). Reconnect." });
        this.options.log("connectors.credentials_unreadable", { connectionId: id });
      }
    }
    this.apps = (await store.kv.get<Record<string, AppConfig>>(ownerId, APPS_KV_KEY)) ?? {};
    this.rebuildRedaction();
  }

  list(): ConnectionRecord[] {
    return [...this.records.values()];
  }

  get(id: string): ConnectionRecord | undefined {
    return this.records.get(id);
  }

  credentialsOf(id: string): StoredCredentials | undefined {
    return this.credentials.get(id);
  }

  app(connectorId: string): AppConfig {
    return this.apps[connectorId] ?? {};
  }

  async setApp(connectorId: string, config: AppConfig): Promise<void> {
    this.apps = { ...this.apps, [connectorId]: config };
    await this.queue(() => this.options.store.kv.set(this.options.ownerId, APPS_KV_KEY, this.apps));
  }

  async put(record: ConnectionRecord, credentials?: StoredCredentials): Promise<void> {
    this.records.set(record.id, record);
    if (credentials) {
      const previous = this.credentials.get(record.id);
      if (previous) this.retire(previous, credentials);
      this.credentials.set(record.id, credentials);
      this.rebuildRedaction();
    }
    await this.persist(Boolean(credentials));
  }

  /** Update the record only (status, last used) — cheap, no credential write. */
  async touch(record: ConnectionRecord): Promise<void> {
    if (!this.records.has(record.id)) return;
    this.records.set(record.id, record);
    await this.persist(false);
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
    const previous = this.credentials.get(id);
    if (previous) this.retire(previous, {});
    this.credentials.delete(id);
    this.rebuildRedaction();
    await this.persist(true);
  }

  close(): void {
    this.unregisterRedactor();
  }

  private retire(previous: StoredCredentials, next: StoredCredentials): void {
    const keep = new Set(secretValues(next));
    for (const value of secretValues(previous)) if (!keep.has(value)) this.retired.push(value);
  }

  private rebuildRedaction(): void {
    const values = [...[...this.credentials.values()].flatMap(secretValues), ...this.retired];
    this.redaction = values.filter((value) => value.length >= 8).map((value) => ({ name: "connector_credential", needles: redactionNeedles(value) }));
  }

  private persist(withCredentials: boolean): Promise<void> {
    const { store, ownerId, key } = this.options;
    const records = [...this.records.values()];
    const encrypted = withCredentials
      ? Object.fromEntries([...this.credentials.entries()].map(([id, value]) => [id, encryptValue(key, ownerId, credentialName(id), JSON.stringify(value))]))
      : undefined;
    return this.queue(async () => {
      await store.kv.set(ownerId, CONNECTIONS_KV_KEY, records);
      if (encrypted) await store.kv.set(ownerId, CREDENTIALS_KV_KEY, encrypted);
    });
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const next = this.writes.then(task, task);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

function credentialName(id: string): string {
  return `connector:${id}`;
}

function secretValues(credentials: StoredCredentials): string[] {
  return [credentials.accessToken, credentials.refreshToken, ...Object.values(credentials.apiKey ?? {})].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}
