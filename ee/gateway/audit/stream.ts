/**
 * Audit streaming to a webhook (SIEM) — Sibyl Enterprise (licence feature `audit_log`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * New audit entries are POSTed in order, in batches of up to 100, as
 * `{ "entries": [...] }` to one HTTPS URL. Each request is signed:
 *
 *   x-sibyl-timestamp: <unix ms>
 *   x-sibyl-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *
 * The signing secret lives in the secrets vault (AUDIT_WEBHOOK_SECRET,
 * allowed only for the webhook's host) and is shown once when created.
 * Delivery goes through the gateway's SSRF-guarded fetchPublic (no private
 * addresses). A cursor (the last delivered seq) survives restarts; failures
 * back off up to 15 minutes and are shown in Admin → Audit log.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { AuditRecord, EnterpriseSecrets, Store } from "../../../packages/core/src/index";
import { fetchPublic, type FetchLike, type ResolveHost } from "../../../apps/gateway/src/net/safe-fetch";
import { badRequest } from "../http";

export const STREAM_KV_KEY = "enterprise.audit_stream.v1";
export const STREAM_SECRET_NAME = "AUDIT_WEBHOOK_SECRET";
const BATCH = 100;
const DEBOUNCE_MS = 1_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface StreamConfig {
  url: string;
  enabled: boolean;
  /** Last delivered seq. */
  cursor: number;
  lastDeliveredAt?: number;
  lastError?: string;
  failures?: number;
}

export interface StreamView {
  configured: boolean;
  url?: string;
  enabled?: boolean;
  cursor?: number;
  lastDeliveredAt?: number;
  lastError?: string;
  /** Present only in the reply that created or rotated the secret. */
  secret?: string;
}

export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export class AuditStreamer {
  private config: StreamConfig | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      store: Store;
      orgId: string;
      secrets?: EnterpriseSecrets;
      /** Newest seq when streaming is switched on (history is not replayed). */
      head(): Promise<number>;
      log: (event: string, fields?: Record<string, unknown>) => void;
      now?: () => number;
      fetch?: FetchLike;
      resolveHost?: ResolveHost;
      debounceMs?: number;
    }
  ) {}

  async load(): Promise<this> {
    this.config = await this.options.store.kv.get<StreamConfig>(this.options.orgId, STREAM_KV_KEY);
    if (this.config?.enabled) this.schedule(0);
    return this;
  }

  view(): StreamView {
    const c = this.config;
    if (!c) return { configured: false };
    return {
      configured: true,
      url: c.url,
      enabled: c.enabled,
      cursor: c.cursor,
      ...(c.lastDeliveredAt ? { lastDeliveredAt: c.lastDeliveredAt } : {}),
      ...(c.lastError ? { lastError: c.lastError } : {})
    };
  }

  /** A new entry was appended. */
  notify(): void {
    if (this.config?.enabled) this.schedule(this.options.debounceMs ?? DEBOUNCE_MS);
  }

  /** Set the URL / switch on or off; creates (or rotates) the signing secret. */
  async configure(input: Record<string, unknown>): Promise<StreamView> {
    const vault = this.options.secrets;
    if (!vault) throw badRequest("Audit streaming needs the secrets vault (SIBYL_SECRET_KEY or data/secret.key).");
    const url = typeof input.url === "string" ? input.url.trim() : this.config?.url;
    if (!url) throw badRequest("Enter the webhook URL.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw badRequest("The webhook URL is not valid.");
    }
    if (parsed.protocol !== "https:") throw badRequest("The webhook URL must use https.");
    if (parsed.username || parsed.password) throw badRequest("Put credentials in the signing secret, not the URL.");
    const enabled = input.enabled === undefined ? (this.config?.enabled ?? true) : input.enabled === true;
    const hostChanged = this.config ? new URL(this.config.url).host !== parsed.host : true;
    let secret: string | undefined;
    if (input.rotateSecret === true || !(await vault.has(STREAM_SECRET_NAME))) {
      secret = randomBytes(32).toString("base64url");
      await vault.set({ name: STREAM_SECRET_NAME, value: secret, allowedHosts: [parsed.host], service: "Audit log webhook", description: "Signs audit log deliveries (Admin → Audit log)." });
    } else if (hostChanged) {
      await vault.set({ name: STREAM_SECRET_NAME, allowedHosts: [parsed.host] });
    }
    const switchedOn = enabled && !this.config?.enabled;
    const next: StreamConfig = {
      url: parsed.toString(),
      enabled,
      cursor: switchedOn || hostChanged ? await this.options.head() : (this.config?.cursor ?? 0)
    };
    await this.save(next);
    if (enabled) this.schedule(0);
    return { ...this.view(), ...(secret ? { secret } : {}) };
  }

  async remove(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.config = undefined;
    await this.options.store.kv.delete(this.options.orgId, STREAM_KV_KEY);
    await this.options.secrets?.delete(STREAM_SECRET_NAME);
  }

  /** Send one signed test request (not an audit entry). */
  async test(): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!this.config) throw badRequest("Set up the webhook first.");
    try {
      const status = await this.post({ test: true, sentAt: new Date(this.now()).toISOString() });
      return { ok: status >= 200 && status < 300, status };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Deliver everything after the cursor (tests and the timer). */
  async drain(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = this.deliver().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delayMs);
    this.timer.unref?.();
  }

  private async deliver(): Promise<void> {
    while (this.config?.enabled && !this.closed) {
      const config = this.config;
      const entries: AuditRecord[] = await this.options.store.audit.scan(this.options.orgId, config.cursor, BATCH);
      if (entries.length === 0) return;
      try {
        const status = await this.post({ entries });
        if (status < 200 || status >= 300) throw new Error(`the webhook answered HTTP ${status}`);
        await this.save({ ...config, cursor: entries[entries.length - 1]!.seq, lastDeliveredAt: this.now(), failures: 0 });
        delete this.config!.lastError;
      } catch (error) {
        const failures = (config.failures ?? 0) + 1;
        await this.save({ ...config, lastError: errorText(error).slice(0, 300), failures });
        this.options.log("audit.stream_failed", { failures, error: errorText(error) });
        this.schedule(Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(failures - 1, 5)));
        return;
      }
    }
  }

  private async post(payload: unknown): Promise<number> {
    const config = this.config!;
    const secret = await this.options.secrets!.resolve(STREAM_SECRET_NAME, new URL(config.url).host);
    const body = JSON.stringify(payload);
    const timestamp = String(this.now());
    const response = await fetchPublic(config.url, {
      method: "POST",
      body,
      httpsOnly: true,
      timeoutMs: 15_000,
      headers: { "content-type": "application/json", "x-sibyl-timestamp": timestamp, "x-sibyl-signature": signBody(secret, timestamp, body) },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.resolveHost ? { resolveHost: this.options.resolveHost } : {})
    });
    await response.discard();
    return response.status;
  }

  private async save(next: StreamConfig): Promise<void> {
    if (!next.lastError) delete next.lastError;
    await this.options.store.kv.set(this.options.orgId, STREAM_KV_KEY, next);
    this.config = next;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
