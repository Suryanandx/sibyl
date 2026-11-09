/**
 * Advanced usage controls — the service: settings, each person's spend, the
 * usage policy, alerts and reports, in one place.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 */
import type { EnterpriseMailer, EnterpriseSecrets } from "../../../packages/core/src/features";
import { DEFAULT_WORKSPACE_ID } from "../../../packages/core/src/workspace";
import type { Store } from "../../../packages/core/src/store";
import type { UsagePolicy } from "../../../packages/core/src/usage";
import { startOfLocalMonth } from "../../../apps/gateway/src/metering/meter";
import type { FetchLike } from "../../../apps/gateway/src/net/safe-fetch";
import { AlertSender, WEBHOOK_SECRET_NAME, issueWebhookKey, rebindWebhookKey, type AlertDelivery } from "./alerts";
import { capsFor, emptyControls, loadControls, saveControls, type Caps, type UsageControls } from "./controls";
import { RateLimiter, SpendLedger, createUsageControlsPolicy } from "./policy";
import { buildChargeback, type ChargebackReport, type ReportScope } from "./report";

type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface UsageControlsServiceOptions {
  store: Store;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  mailer?: EnterpriseMailer;
  secrets?: EnterpriseSecrets;
  log: Log;
  now?: () => number;
  /** Test seam for webhook deliveries. */
  fetch?: FetchLike;
}

/** One person on the admin screen: who, their caps and their spend. */
export interface PersonUsage {
  userId: string;
  name: string;
  email: string;
  /** Their own caps (role caps apply where these are absent). */
  caps: Caps;
  todayUsd: number;
  monthUsd: number;
}

export interface ControlsView {
  controls: UsageControls;
  people: PersonUsage[];
  roles: string[];
  email: { configured: boolean };
  webhook: { keySet: boolean; vault: boolean; privateNetwork: boolean };
}

export class UsageControlsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const ROLES = ["owner", "admin", "member", "viewer"];

export class UsageControlsService {
  readonly ledger = new SpendLedger();
  readonly limiter = new RateLimiter();
  readonly alerts: AlertSender;
  readonly policy: UsagePolicy;
  private current: UsageControls = emptyControls();
  private readonly now: () => number;

  constructor(private readonly options: UsageControlsServiceOptions) {
    this.now = options.now ?? Date.now;
    const privateNetwork = /^(1|true|yes|on)$/i.test(options.env.SIBYL_USAGE_WEBHOOK_PRIVATE?.trim() ?? "");
    const appUrl = options.env.SIBYL_APP_URL?.trim();
    this.alerts = new AlertSender({
      store: options.store,
      ownerId: options.ownerId,
      controls: () => this.current,
      ...(options.mailer ? { mailer: options.mailer } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      privateNetwork,
      ...(appUrl ? { appUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      log: options.log
    });
    this.policy = createUsageControlsPolicy({
      controls: () => this.current,
      ledger: this.ledger,
      limiter: this.limiter,
      alert: (alert) => this.alerts.submit(alert)
    });
  }

  /** Load the settings and rebuild this month's spend per person from the usage events. */
  async init(): Promise<this> {
    this.current = await loadControls(this.options.store, this.options.ownerId);
    const now = this.now();
    const events = await this.options.store.usage.list(this.options.ownerId, startOfLocalMonth(now), now + 1);
    this.ledger.load(events, now);
    return this;
  }

  get controls(): UsageControls {
    return this.current;
  }

  async view(): Promise<ControlsView> {
    const now = this.now();
    const users = await this.options.store.identity.users.list(this.options.ownerId);
    const people: PersonUsage[] = users
      .filter((user) => !user.disabledAt)
      .map((user) => ({ userId: user.id, name: user.name, email: user.email, caps: this.current.users[user.id] ?? {}, ...this.ledger.totals(user.id, now) }));
    // The org owner acting without an account (owner token / local mode) spends too.
    for (const id of ["token", "local"]) {
      const spend = this.ledger.totals(id, now);
      if (spend.monthUsd > 0 || this.current.users[id]) {
        people.push({ userId: id, name: id === "token" ? "Owner token" : "Local mode", email: "", caps: this.current.users[id] ?? {}, ...spend });
      }
    }
    return {
      controls: this.current,
      people: people.map((p) => ({ ...p, todayUsd: round(p.todayUsd), monthUsd: round(p.monthUsd) })).sort((a, b) => b.monthUsd - a.monthUsd || a.name.localeCompare(b.name)),
      roles: ROLES,
      email: { configured: Boolean(this.options.mailer) },
      webhook: {
        keySet: this.options.secrets ? await this.options.secrets.has(WEBHOOK_SECRET_NAME) : false,
        vault: Boolean(this.options.secrets),
        privateNetwork: /^(1|true|yes|on)$/i.test(this.options.env.SIBYL_USAGE_WEBHOOK_PRIVATE?.trim() ?? "")
      }
    };
  }

  /**
   * Save new settings. A webhook needs a signing key in the vault: one is
   * issued (and returned this once) when there is none or the host changed.
   */
  async update(next: UsageControls): Promise<{ webhookKey?: string }> {
    let webhookKey: string | undefined;
    const url = next.alerts.webhookUrl;
    if (url) {
      const secrets = this.options.secrets;
      if (!secrets) throw new UsageControlsError(409, "vault_off", "Webhook alerts need the secrets vault (set SIBYL_SECRET_KEY) to sign deliveries.");
      if (!(await rebindWebhookKey(secrets, url))) webhookKey = await issueWebhookKey(secrets, url);
    }
    this.current = next;
    await saveControls(this.options.store, this.options.ownerId, next);
    this.options.log("usage_controls.updated", {
      people: Object.keys(next.users).length,
      roles: Object.keys(next.roles).length,
      perRequestUsd: next.perRequestUsd,
      allowedModels: next.allowedModels.length,
      requestsPerMinute: next.requestsPerMinute,
      webhook: Boolean(url)
    });
    return webhookKey ? { webhookKey } : {};
  }

  /** Replace the webhook signing key (returned this once). */
  async rotateWebhookKey(): Promise<string> {
    const url = this.current.alerts.webhookUrl;
    if (!url) throw new UsageControlsError(409, "no_webhook", "Set a webhook URL first.");
    if (!this.options.secrets) throw new UsageControlsError(409, "vault_off", "Webhook alerts need the secrets vault (set SIBYL_SECRET_KEY).");
    return issueWebhookKey(this.options.secrets, url);
  }

  /** Send a sample alert about the caller through every configured channel. */
  async testAlert(userId: string, workspaceId: string): Promise<AlertDelivery> {
    const now = this.now();
    const caps = capsFor(this.current, userId, undefined);
    return this.alerts.deliver({
      userId,
      workspaceId,
      period: "daily",
      thresholdPercent: this.current.alerts.thresholds[0] ?? 80,
      spentUsd: this.ledger.totals(userId, now).todayUsd,
      capUsd: caps.dailyUsd ?? 0,
      blocked: false,
      periodStart: now,
      at: now
    });
  }

  async report(range: { from: number; to: number }, scope: ReportScope): Promise<ChargebackReport> {
    const { store, ownerId } = this.options;
    const [events, users, workspaces] = await Promise.all([
      store.usage.list(ownerId, range.from, range.to),
      store.identity.users.list(ownerId),
      store.workspaces.list(ownerId)
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const workspaceById = new Map(workspaces.map((w) => [w.id, w]));
    return buildChargeback(events, range, {
      workspace: (id) => workspaceById.get(id)?.name ?? (id === DEFAULT_WORKSPACE_ID ? "Default" : id),
      user: (id) => {
        if (id === "token") return { name: "Owner token", email: "" };
        if (id === "local") return { name: "Local mode", email: "" };
        const user = userById.get(id);
        return user ? { name: user.name, email: user.email } : { name: id, email: "" };
      }
    }, scope);
  }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
