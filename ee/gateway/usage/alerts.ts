/**
 * Advanced usage controls — alerts by email (the gateway's one mailer) and a
 * signed webhook (fetchPublic, key in the vault).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Each (person, day or month, threshold) alerts once; the sent keys are kept
 * in the kv store so a restart doesn't repeat them.
 *
 * Webhook deliveries are POSTs with a JSON body and two headers:
 *   x-sibyl-timestamp: <unix ms>
 *   x-sibyl-signature: sha256=<hex HMAC-SHA256(key, `${timestamp}.${body}`)>
 * Receivers recompute the HMAC with the key shown once in the admin screen.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { EmailContent } from "../../../packages/core/src/email";
import type { EnterpriseMailer, EnterpriseSecrets } from "../../../packages/core/src/features";
import { usageAlertEmail } from "../../../apps/gateway/src/email/templates";
import type { Store } from "../../../packages/core/src/store";
import { fetchPublic, type FetchLike } from "../../../apps/gateway/src/net/safe-fetch";
import { money, type UsageControls } from "./controls";
import type { UsageAlert } from "./policy";

export const SENT_KV_KEY = "usage-controls.alerts-sent";
/** The vault entry holding the webhook signing key. */
export const WEBHOOK_SECRET_NAME = "SIBYL_USAGE_ALERTS_WEBHOOK_KEY";

type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface AlertSenderOptions {
  store: Store;
  ownerId: string;
  controls(): UsageControls;
  mailer?: EnterpriseMailer;
  secrets?: EnterpriseSecrets;
  /** SIBYL_USAGE_WEBHOOK_PRIVATE: the webhook may be on the internal network. */
  privateNetwork: boolean;
  appUrl?: string;
  log: Log;
  /** Test seam for the webhook transport. */
  fetch?: FetchLike;
}

export interface AlertDelivery {
  email: Array<{ to: string; ok: boolean }>;
  webhook?: { ok: boolean; status?: number; error?: string };
}

export class AlertSender {
  private sent = new Map<string, number>();
  private loaded: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AlertSenderOptions) {}

  /** Queue an alert (deduplicated). Never throws. */
  submit(alert: UsageAlert): void {
    this.queue = this.queue
      .then(() => this.deliverOnce(alert))
      .catch((error: unknown) => this.options.log("usage_controls.alert_failed", { error: errorText(error) }));
  }

  /** Wait for queued alerts (tests, shutdown). */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async deliverOnce(alert: UsageAlert): Promise<void> {
    await (this.loaded ??= this.load());
    // A changed cap starts its thresholds afresh.
    const key = `${alert.userId}|${alert.period}|${alert.periodStart}|${alert.thresholdPercent}|${alert.capUsd}`;
    if (this.sent.has(key)) return;
    this.sent.set(key, alert.at);
    await this.save(alert.at);
    const delivery = await this.deliver(alert);
    this.options.log("usage_controls.alert_sent", {
      userId: alert.userId,
      period: alert.period,
      thresholdPercent: alert.thresholdPercent,
      blocked: alert.blocked,
      email: delivery.email.map((e) => (e.ok ? "sent" : "failed")),
      ...(delivery.webhook ? { webhook: delivery.webhook.ok ? "sent" : "failed", webhookStatus: delivery.webhook.status } : {})
    });
  }

  /** Send one alert now through every configured channel (also "Send a test alert"). */
  async deliver(alert: UsageAlert): Promise<AlertDelivery> {
    const controls = this.options.controls();
    const user = await this.options.store.identity.users.get(this.options.ownerId, alert.userId).catch(() => undefined);
    const name = user?.name || user?.email || describeUser(alert.userId);
    const workspace = alert.workspaceId ? await this.options.store.workspaces.get(this.options.ownerId, alert.workspaceId).catch(() => undefined) : undefined;
    const content = composeAlert(alert, name, workspace?.name ?? alert.workspaceId, this.options.appUrl);
    const subject = content.subject;

    const recipients = new Set(controls.alerts.emails);
    if (controls.alerts.notifyUser && user?.email) recipients.add(user.email);
    const email: AlertDelivery["email"] = [];
    if (this.options.mailer) {
      for (const to of recipients) {
        try {
          await this.options.mailer.send({ to, email: content });
          email.push({ to, ok: true });
        } catch (error) {
          this.options.log("usage_controls.email_failed", { error: errorText(error) });
          email.push({ to, ok: false });
        }
      }
    } else if (recipients.size > 0) {
      this.options.log("usage_controls.email_unavailable", { message: "SIBYL_SMTP_URL is not set; alert email was not sent" });
    }

    const webhookUrl = controls.alerts.webhookUrl;
    if (!webhookUrl) return { email };
    const payload = {
      type: "usage.alert",
      id: randomUUID(),
      at: new Date(alert.at).toISOString(),
      user: { id: alert.userId, ...(user ? { name: user.name, email: user.email } : {}) },
      ...(alert.workspaceId ? { workspace: { id: alert.workspaceId, ...(workspace ? { name: workspace.name } : {}) } } : {}),
      period: alert.period,
      thresholdPercent: alert.thresholdPercent,
      blocked: alert.blocked,
      spentUsd: round(alert.spentUsd),
      capUsd: round(alert.capUsd),
      message: subject
    };
    return { email, webhook: await this.postWebhook(webhookUrl, payload) };
  }

  private async postWebhook(url: string, payload: unknown): Promise<NonNullable<AlertDelivery["webhook"]>> {
    const secrets = this.options.secrets;
    if (!secrets) return { ok: false, error: "The secrets vault is off, so webhook alerts can't be signed." };
    try {
      const host = new URL(url).hostname;
      const key = await secrets.resolve(WEBHOOK_SECRET_NAME, host);
      const body = JSON.stringify(payload);
      const timestamp = String(Date.now());
      const response = await fetchPublic(url, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-sibyl-timestamp": timestamp,
          "x-sibyl-signature": signPayload(key, timestamp, body)
        },
        timeoutMs: 10_000,
        maxBytes: 16 * 1024,
        privateNetwork: this.options.privateNetwork,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {})
      });
      await response.discard();
      if (!response.ok) this.options.log("usage_controls.webhook_failed", { status: response.status });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      this.options.log("usage_controls.webhook_failed", { error: errorText(error) });
      return { ok: false, error: errorText(error).slice(0, 200) };
    }
  }

  private async load(): Promise<void> {
    const saved = await this.options.store.kv.get<Record<string, number>>(this.options.ownerId, SENT_KV_KEY).catch(() => undefined);
    if (saved && typeof saved === "object") {
      for (const [key, at] of Object.entries(saved)) if (typeof at === "number") this.sent.set(key, at);
    }
  }

  /** Keep only this and last month's keys. */
  private async save(now: number): Promise<void> {
    const cutoff = now - 62 * 24 * 60 * 60 * 1000;
    for (const [key, at] of this.sent) if (at < cutoff) this.sent.delete(key);
    await this.options.store.kv.set(this.options.ownerId, SENT_KV_KEY, Object.fromEntries(this.sent));
  }
}

/** `sha256=<hex>` over `${timestamp}.${body}`. */
export function signPayload(key: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Create (or replace) the webhook signing key in the vault, bound to the webhook's host. Returns the key once. */
export async function issueWebhookKey(secrets: EnterpriseSecrets, webhookUrl: string): Promise<string> {
  const key = randomBytes(32).toString("hex");
  await secrets.set({
    name: WEBHOOK_SECRET_NAME,
    value: key,
    service: "Sibyl usage alerts",
    description: "Signs usage alert webhooks (advanced usage controls).",
    allowedHosts: [new URL(webhookUrl).hostname]
  });
  return key;
}

/** Point the existing key at a new webhook host (value unchanged). */
export async function rebindWebhookKey(secrets: EnterpriseSecrets, webhookUrl: string): Promise<boolean> {
  if (!(await secrets.has(WEBHOOK_SECRET_NAME))) return false;
  const host = new URL(webhookUrl).hostname;
  try {
    await secrets.resolve(WEBHOOK_SECRET_NAME, host);
    return true;
  } catch {
    // Different host: a fresh key is issued by the caller.
    return false;
  }
}

/** The alert email, written by the shared template (apps/gateway/src/email/templates.ts). */
export function composeAlert(alert: UsageAlert, name: string, workspace: string | undefined, appUrl?: string): EmailContent {
  return usageAlertEmail({
    name,
    period: alert.period === "daily" ? "daily" : "monthly",
    thresholdPercent: alert.thresholdPercent,
    blocked: alert.blocked,
    spent: money(alert.spentUsd),
    cap: money(alert.capUsd),
    ...(workspace ? { workspace } : {}),
    ...(appUrl ? { settingsUrl: `${appUrl.replace(/\/+$/, "")}/admin/usage` } : {})
  });
}

function describeUser(userId: string): string {
  return userId === "token" || userId === "local" ? "The organisation owner" : `User ${userId}`;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
