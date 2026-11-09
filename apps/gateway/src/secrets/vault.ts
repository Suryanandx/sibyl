/**
 * The secrets vault: API keys and tokens the user stored for integrations.
 *
 * Secrets live per owner in `store.kv` under `secrets.v1`, each value
 * encrypted with AES-256-GCM (see crypto.ts). Only metadata leaves this
 * module, except through `resolve` / `resolveRefs`, which hand a value to
 * server-side code that sends it to a host the secret allows. Decrypted
 * values are kept in memory only to redact them from tool output.
 */
import { AUDIT_ACTIONS, type AuditActor, type AuditEvent, type Store } from "@open-gpt-live/core";
import { decryptValue, encryptValue } from "./crypto.js";
import { hostAllowed, LOCAL_HOST, normalizeHostList } from "./hosts.js";
import { redactionNeedles, redactWith, registerRedactor, type RedactionEntry } from "./redact.js";

export const SECRETS_KV_KEY = "secrets.v1";
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_VALUE_CHARS = 8_192;
export const MAX_SECRETS = 200;
/** `${secret:NAME}` references inside tool inputs and MCP configs. */
export const SECRET_REF = /\$\{secret:([A-Za-z0-9_]{1,64})\}/g;
const LAST_USED_WRITE_MS = 60_000;

export interface StoredSecret {
  name: string;
  service: string;
  description: string;
  allowedHosts: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  ciphertext: string;
}

/** What the browser, the model and logs may see. Never the value. */
export interface SecretMeta {
  name: string;
  service: string;
  description: string;
  allowedHosts: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  /** False when the value can't be decrypted (the master key changed). */
  readable: boolean;
}

export interface SetSecretInput {
  name: string;
  /** Omit to keep the current value (metadata-only update). */
  value?: string;
  service?: string;
  description?: string;
  allowedHosts?: string[];
}

export class SecretError extends Error {}

interface OwnerState {
  records: Map<string, StoredSecret>;
  /** Decrypted values (undefined when unreadable). */
  values: Map<string, string | undefined>;
  /** Replaced or deleted values: still redacted for the life of the process. */
  retired: Array<{ name: string; value: string }>;
  redaction: RedactionEntry[];
}

export interface SecretVaultOptions {
  store: Store;
  key: Buffer;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Audit trail: secret use and changes are recorded by name (never the value). */
  audit?: (event: AuditEvent) => void;
}

export class SecretVault {
  private readonly owners = new Map<string, Promise<OwnerState>>();
  private readonly loaded = new Map<string, OwnerState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly unregister: () => void;
  private readonly listeners = new Set<(ownerId: string) => void>();

  constructor(private readonly options: SecretVaultOptions) {
    this.now = options.now ?? Date.now;
    this.unregister = registerRedactor((ownerId, text) => this.redactLoaded(ownerId, text));
  }

  /** Load an owner's secrets now (so redaction is ready before any tool runs). */
  async preload(ownerId: string): Promise<void> {
    await this.state(ownerId);
  }

  /** Called after any change (used to push `secrets.state` to open apps). */
  onChange(listener: (ownerId: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  async list(ownerId: string): Promise<SecretMeta[]> {
    const state = await this.state(ownerId);
    return [...state.records.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((record) => toMeta(record, state.values.get(record.name) !== undefined));
  }

  async has(ownerId: string, name: string): Promise<boolean> {
    return (await this.state(ownerId)).records.has(name);
  }

  async get(ownerId: string, name: string): Promise<SecretMeta | undefined> {
    const state = await this.state(ownerId);
    const record = state.records.get(name);
    return record ? toMeta(record, state.values.get(name) !== undefined) : undefined;
  }

  /** Create or update a secret. A new secret needs a value and allowed hosts. */
  async set(ownerId: string, input: SetSecretInput, actor?: AuditActor): Promise<SecretMeta> {
    const name = input.name;
    if (!SECRET_NAME.test(name)) throw new SecretError("Secret names are UPPER_SNAKE_CASE, up to 64 characters (e.g. HIGGSFIELD_API_KEY)");
    const value = input.value === undefined ? undefined : input.value.trim();
    if (value !== undefined) {
      if (!value) throw new SecretError("The secret value is empty");
      if (value.length > MAX_SECRET_VALUE_CHARS) throw new SecretError(`Secret values are limited to ${MAX_SECRET_VALUE_CHARS} characters`);
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new SecretError("The secret value contains control characters");
    }
    let hosts: string[] | undefined;
    if (input.allowedHosts !== undefined) {
      const parsed = normalizeHostList(input.allowedHosts);
      if ("error" in parsed) throw new SecretError(parsed.error);
      hosts = parsed.hosts;
    }
    const service = clean(input.service, 80);
    const description = clean(input.description, 500);

    const meta = await this.locked(ownerId, async () => {
      const state = await this.state(ownerId);
      const existing = state.records.get(name);
      if (!existing) {
        if (value === undefined) throw new SecretError(`There is no secret named ${name}`);
        if (!hosts) throw new SecretError("A new secret needs at least one allowed host");
        if (state.records.size >= MAX_SECRETS) throw new SecretError(`At most ${MAX_SECRETS} secrets can be stored`);
      }
      const at = this.now();
      const record: StoredSecret = {
        name,
        service: service ?? existing?.service ?? name,
        description: description ?? existing?.description ?? "",
        allowedHosts: hosts ?? existing!.allowedHosts,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt }),
        ciphertext: value === undefined ? existing!.ciphertext : encryptValue(this.options.key, ownerId, name, value)
      };
      const records = new Map(state.records);
      records.set(name, record);
      await this.persist(ownerId, records);
      state.records = records;
      const previous = state.values.get(name);
      if (value !== undefined) {
        if (previous !== undefined && previous !== value) state.retired.push({ name, value: previous });
        state.values.set(name, value);
      }
      state.redaction = buildRedaction(state.values, state.retired);
      return toMeta(record, state.values.get(name) !== undefined);
    });
    this.options.log?.("secrets.saved", { name, hosts: meta.allowedHosts, valueChanged: value !== undefined });
    this.options.audit?.({ action: AUDIT_ACTIONS.SECRET_SAVED, ...(actor ? { actor } : {}), target: { kind: "secret", name }, details: { hosts: meta.allowedHosts, valueChanged: value !== undefined } });
    this.emit(ownerId);
    return meta;
  }

  async delete(ownerId: string, name: string, actor?: AuditActor): Promise<boolean> {
    const removed = await this.locked(ownerId, async () => {
      const state = await this.state(ownerId);
      if (!state.records.has(name)) return false;
      const records = new Map(state.records);
      records.delete(name);
      await this.persist(ownerId, records);
      state.records = records;
      // Keep redacting a deleted value for the rest of this process: it may
      // still be echoed by a service it was sent to.
      const previous = state.values.get(name);
      if (previous !== undefined) state.retired.push({ name, value: previous });
      state.values.delete(name);
      state.redaction = buildRedaction(state.values, state.retired);
      return true;
    });
    if (removed) {
      this.options.log?.("secrets.deleted", { name });
      this.options.audit?.({ action: AUDIT_ACTIONS.SECRET_DELETED, ...(actor ? { actor } : {}), target: { kind: "secret", name } });
      this.emit(ownerId);
    }
    return removed;
  }

  /**
   * The value of `name`, only for a host the secret allows. `host: undefined`
   * means local use (a stdio MCP server's environment) and needs `local`.
   */
  async resolve(ownerId: string, name: string, context: { host: string | undefined }): Promise<string> {
    const state = await this.state(ownerId);
    const record = state.records.get(name);
    if (!record) throw new SecretError(`There is no secret named ${name}. Ask the user for it with request_secret.`);
    if (!hostAllowed(record.allowedHosts, context.host)) {
      this.options.audit?.({ action: AUDIT_ACTIONS.SECRET_USED, outcome: "denied", target: { kind: "secret", name }, details: { host: context.host ?? "local" } });
      const where = context.host === undefined ? "local tools (add \"local\" to its allowed hosts)" : context.host;
      throw new SecretError(`${name} may not be sent to ${where}; it is allowed for ${record.allowedHosts.join(", ")}`);
    }
    const value = state.values.get(name);
    if (value === undefined) {
      throw new SecretError(`${name} can't be decrypted (was SIBYL_SECRET_KEY or data/secret.key changed?). Ask the user to enter it again.`);
    }
    this.touch(ownerId, name);
    this.options.audit?.({ action: AUDIT_ACTIONS.SECRET_USED, target: { kind: "secret", name }, details: { host: context.host ?? "local" } });
    return value;
  }

  /** Replace every `${secret:NAME}` in `text`; throws if any is not allowed for the host. */
  async resolveRefs(
    ownerId: string,
    text: string,
    context: { host: string | undefined; encode?: (value: string) => string }
  ): Promise<string> {
    const names = referencedSecrets(text);
    if (names.length === 0) return text;
    const values = new Map<string, string>();
    for (const name of names) values.set(name, await this.resolve(ownerId, name, context));
    return text.replace(SECRET_REF, (_match, name: string) => {
      const value = values.get(name)!;
      return context.encode ? context.encode(value) : value;
    });
  }

  /** Replace any known value (and its encodings) with `[secret:NAME]`. */
  async redact(ownerId: string, text: string): Promise<string> {
    const state = await this.state(ownerId);
    return redactWith(state.redaction, text);
  }

  close(): void {
    this.unregister();
    this.listeners.clear();
  }

  /** Synchronous redaction for owners already loaded (the tool-loop hook). */
  private redactLoaded(ownerId: string, text: string): string {
    const loaded = this.loaded.get(ownerId);
    return loaded ? redactWith(loaded.redaction, text) : text;
  }

  private state(ownerId: string): Promise<OwnerState> {
    let pending = this.owners.get(ownerId);
    if (!pending) {
      pending = this.load(ownerId);
      this.owners.set(ownerId, pending);
      pending.catch(() => this.owners.delete(ownerId));
    }
    return pending;
  }

  private async load(ownerId: string): Promise<OwnerState> {
    const raw = await this.options.store.kv.get<{ secrets?: unknown }>(ownerId, SECRETS_KV_KEY);
    const records = new Map<string, StoredSecret>();
    const values = new Map<string, string | undefined>();
    const list = raw && Array.isArray(raw.secrets) ? raw.secrets : [];
    let unreadable = 0;
    for (const item of list) {
      const record = parseStored(item);
      if (!record) continue;
      records.set(record.name, record);
      try {
        values.set(record.name, decryptValue(this.options.key, ownerId, record.name, record.ciphertext));
      } catch {
        values.set(record.name, undefined);
        unreadable += 1;
      }
    }
    if (unreadable > 0) this.options.log?.("secrets.unreadable", { count: unreadable });
    const state: OwnerState = { records, values, retired: [], redaction: buildRedaction(values, []) };
    this.loaded.set(ownerId, state);
    return state;
  }

  private async persist(ownerId: string, records: Map<string, StoredSecret>): Promise<void> {
    await this.options.store.kv.set(ownerId, SECRETS_KV_KEY, { secrets: [...records.values()] });
  }

  private touch(ownerId: string, name: string): void {
    const at = this.now();
    void this.locked(ownerId, async () => {
      const state = await this.state(ownerId);
      const record = state.records.get(name);
      if (!record || (record.lastUsedAt !== undefined && at - record.lastUsedAt < LAST_USED_WRITE_MS)) return;
      const records = new Map(state.records);
      records.set(name, { ...record, lastUsedAt: at });
      await this.persist(ownerId, records);
      state.records = records;
    }).catch(() => undefined);
  }

  private locked<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(ownerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(ownerId, next.catch(() => undefined));
    return next;
  }

  private emit(ownerId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(ownerId);
      } catch {
        // A listener failing must not undo a save.
      }
    }
  }
}

/** Names referenced as `${secret:NAME}` in a string (deduplicated). */
export function referencedSecrets(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(SECRET_REF)) names.add(match[1]!);
  return [...names];
}

function buildRedaction(values: Map<string, string | undefined>, retired: Array<{ name: string; value: string }>): RedactionEntry[] {
  const entries: RedactionEntry[] = [];
  for (const [name, value] of values) {
    if (value !== undefined) entries.push({ name, needles: redactionNeedles(value) });
  }
  for (const { name, value } of retired) entries.push({ name, needles: redactionNeedles(value) });
  return entries;
}

function toMeta(record: StoredSecret, readable: boolean): SecretMeta {
  return {
    name: record.name,
    service: record.service,
    description: record.description,
    allowedHosts: [...record.allowedHosts],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    readable
  };
}

function parseStored(item: unknown): StoredSecret | undefined {
  if (!item || typeof item !== "object") return undefined;
  const r = item as Record<string, unknown>;
  if (typeof r.name !== "string" || !SECRET_NAME.test(r.name) || typeof r.ciphertext !== "string") return undefined;
  const hosts = Array.isArray(r.allowedHosts) ? r.allowedHosts.filter((h): h is string => typeof h === "string") : [];
  return {
    name: r.name,
    service: typeof r.service === "string" ? r.service : r.name,
    description: typeof r.description === "string" ? r.description : "",
    allowedHosts: hosts,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    ...(typeof r.lastUsedAt === "number" ? { lastUsedAt: r.lastUsedAt } : {}),
    ciphertext: r.ciphertext
  };
}

function clean(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

export { LOCAL_HOST };
