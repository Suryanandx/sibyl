/**
 * Advanced usage controls — the settings an admin edits.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * One record per organisation, kept in the kv store. Everything is optional:
 * an empty record changes nothing, and the open-source organisation budgets
 * (SIBYL_BUDGET_*) always apply first.
 */
import type { Store } from "../../../packages/core/src/store";

export const CONTROLS_KV_KEY = "usage-controls";

/** A daily and/or monthly cap in USD. */
export interface Caps {
  dailyUsd?: number;
  monthlyUsd?: number;
}

export interface AlertSettings {
  /** Percentages of a cap that send an alert (each once per day or month), e.g. [80, 100]. */
  thresholds: number[];
  /** Who gets alert email (besides the person, when notifyUser). */
  emails: string[];
  /** Also email the person who reached the threshold. */
  notifyUser: boolean;
  /** POSTed a signed JSON alert (HMAC-SHA256, the key lives in the vault). */
  webhookUrl?: string;
}

export interface UsageControls {
  /** Per person (user id), across every workspace. Overrides the role caps field by field. */
  users: Record<string, Caps>;
  /** Per role: the cap for each person whose role in the workspace they work in is this one. */
  roles: Record<string, Caps>;
  /** Largest expected cost of one request. */
  perRequestUsd?: number;
  /** Models people may use (empty: any model the gateway offers). */
  allowedModels: string[];
  /** Chat and voice requests per person per minute. */
  requestsPerMinute?: number;
  alerts: AlertSettings;
}

export const DEFAULT_THRESHOLDS = [80, 100];

export function emptyControls(): UsageControls {
  return { users: {}, roles: {}, allowedModels: [], alerts: { thresholds: [...DEFAULT_THRESHOLDS], emails: [], notifyUser: true } };
}

export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ROLE = /^[a-z0-9_-]{1,64}$/;
const MODEL = /^[A-Za-z0-9_./:@+-]{1,200}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;
const MAX_USD = 1_000_000;

function usd(value: unknown, label: string): ParseResult<number | undefined> {
  if (value === undefined || value === null || value === "") return { success: true, data: undefined };
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_USD) {
    return { success: false, error: `${label} must be a number of dollars between 0 and ${MAX_USD}.` };
  }
  return { success: true, data: Math.round(n * 1e6) / 1e6 };
}

function caps(value: unknown, label: string): ParseResult<Caps> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false, error: `${label} must be an object.` };
  const input = value as Record<string, unknown>;
  const daily = usd(input.dailyUsd, `${label} daily budget`);
  if (!daily.success) return daily;
  const monthly = usd(input.monthlyUsd, `${label} monthly budget`);
  if (!monthly.success) return monthly;
  return {
    success: true,
    data: { ...(daily.data !== undefined ? { dailyUsd: daily.data } : {}), ...(monthly.data !== undefined ? { monthlyUsd: monthly.data } : {}) }
  };
}

function capsMap(value: unknown, key: RegExp, label: string): ParseResult<Record<string, Caps>> {
  if (value === undefined) return { success: true, data: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false, error: `${label} must be an object.` };
  const out: Record<string, Caps> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1_000) return { success: false, error: `Too many ${label}.` };
  for (const [id, entry] of entries) {
    if (!key.test(id)) return { success: false, error: `${label}: "${id.slice(0, 40)}" is not a valid id.` };
    const parsed = caps(entry, `${label} ${id}`);
    if (!parsed.success) return parsed;
    // A row with no caps is the same as no row.
    if (parsed.data.dailyUsd !== undefined || parsed.data.monthlyUsd !== undefined) out[id] = parsed.data;
  }
  return { success: true, data: out };
}

function webhookUrl(value: unknown): ParseResult<string | undefined> {
  if (value === undefined || value === null || value === "") return { success: true, data: undefined };
  if (typeof value !== "string" || value.length > 2_000) return { success: false, error: "The webhook URL is not valid." };
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { success: false, error: "The webhook URL is not valid." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { success: false, error: "The webhook URL must start with https://." };
  if (url.username || url.password) return { success: false, error: "Put no user name or password in the webhook URL." };
  return { success: true, data: url.toString() };
}

/** Validate settings from the admin screen (unknown fields are dropped). */
export function parseControls(value: unknown): ParseResult<UsageControls> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false, error: "Settings must be an object." };
  const input = value as Record<string, unknown>;
  const users = capsMap(input.users, ID, "people");
  if (!users.success) return users;
  const roles = capsMap(input.roles, ROLE, "roles");
  if (!roles.success) return roles;
  const perRequest = usd(input.perRequestUsd, "The per-request cap");
  if (!perRequest.success) return perRequest;

  const models = input.allowedModels ?? [];
  if (!Array.isArray(models) || models.length > 500 || !models.every((m) => typeof m === "string" && MODEL.test(m.trim()))) {
    return { success: false, error: "Allowed models must be a list of model ids." };
  }
  let rpm: number | undefined;
  if (input.requestsPerMinute !== undefined && input.requestsPerMinute !== null && input.requestsPerMinute !== "") {
    const n = Number(input.requestsPerMinute);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) return { success: false, error: "Requests per minute must be a whole number from 1 to 10000." };
    rpm = n;
  }

  const alertsIn = (input.alerts ?? {}) as Record<string, unknown>;
  if (typeof alertsIn !== "object" || Array.isArray(alertsIn)) return { success: false, error: "Alerts must be an object." };
  const thresholds = alertsIn.thresholds ?? DEFAULT_THRESHOLDS;
  if (!Array.isArray(thresholds) || thresholds.length > 10 || !thresholds.every((t) => Number.isInteger(t) && (t as number) >= 1 && (t as number) <= 100)) {
    return { success: false, error: "Alert thresholds must be whole percentages from 1 to 100." };
  }
  const emails = alertsIn.emails ?? [];
  if (!Array.isArray(emails) || emails.length > 50 || !emails.every((e) => typeof e === "string" && EMAIL.test(e.trim()))) {
    return { success: false, error: "Alert emails must be a list of email addresses." };
  }
  const hook = webhookUrl(alertsIn.webhookUrl);
  if (!hook.success) return hook;

  return {
    success: true,
    data: {
      users: users.data,
      roles: roles.data,
      ...(perRequest.data !== undefined ? { perRequestUsd: perRequest.data } : {}),
      allowedModels: [...new Set((models as string[]).map((m) => m.trim()))],
      ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}),
      alerts: {
        thresholds: [...new Set(thresholds as number[])].sort((a, b) => a - b),
        emails: [...new Set((emails as string[]).map((e) => e.trim().toLowerCase()))],
        notifyUser: alertsIn.notifyUser === undefined ? true : alertsIn.notifyUser === true,
        ...(hook.data ? { webhookUrl: hook.data } : {})
      }
    }
  };
}

/** Dollars for messages: small budgets keep four decimals ("$0.0073 of $0.0120"). */
export function money(value: number): string {
  if (value === 0) return "$0";
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** The caps that apply to one person: their own, field by field over their role's. */
export function capsFor(controls: UsageControls, userId: string, role: string | undefined): Caps {
  const own = controls.users[userId] ?? {};
  const byRole = role ? controls.roles[role] ?? {} : {};
  const dailyUsd = own.dailyUsd ?? byRole.dailyUsd;
  const monthlyUsd = own.monthlyUsd ?? byRole.monthlyUsd;
  return { ...(dailyUsd !== undefined ? { dailyUsd } : {}), ...(monthlyUsd !== undefined ? { monthlyUsd } : {}) };
}

export async function loadControls(store: Store, ownerId: string): Promise<UsageControls> {
  const saved = await store.kv.get(ownerId, CONTROLS_KV_KEY);
  if (saved === undefined) return emptyControls();
  const parsed = parseControls(saved);
  return parsed.success ? parsed.data : emptyControls();
}

export async function saveControls(store: Store, ownerId: string, controls: UsageControls): Promise<void> {
  await store.kv.set(ownerId, CONTROLS_KV_KEY, controls);
}
