/**
 * Advanced usage controls — chargeback report by workspace and person, and
 * its CSV export.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Built from the usage events themselves (every model call is one event with
 * its cost, person and workspace), so the totals are exactly what the meter
 * recorded. Spend recorded without a workspace or person (older records,
 * background work) shows as "unattributed".
 */
import type { UsageEvent } from "../../../packages/core/src/usage";

export const UNATTRIBUTED = "unattributed";

export interface ChargebackRow {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** Model calls recorded. */
  calls: number;
  costUsd: number;
  /** Cost per feature (voice, brain, routine, …). */
  byFeature: Record<string, number>;
}

export interface ChargebackReport {
  from: number;
  to: number;
  rows: ChargebackRow[];
  workspaces: Array<{ workspaceId: string; workspaceName: string; calls: number; costUsd: number }>;
  totalUsd: number;
  calls: number;
}

export interface Names {
  workspace(id: string): string;
  user(id: string): { name: string; email: string };
}

/** Which rows a caller may see: everything, or per workspace "all" / "own" (their own rows only). */
export type ReportScope = { all: true } | { all: false; workspaces: (workspaceId: string) => "all" | "own" | "none"; userId: string };

export function buildChargeback(events: readonly UsageEvent[], range: { from: number; to: number }, names: Names, scope: ReportScope): ChargebackReport {
  const rows = new Map<string, ChargebackRow>();
  for (const event of events) {
    if (event.at < range.from || event.at >= range.to) continue;
    const workspaceId = event.workspaceId ?? UNATTRIBUTED;
    const userId = event.userId ?? UNATTRIBUTED;
    if (!scope.all) {
      const access = event.workspaceId ? scope.workspaces(event.workspaceId) : "none";
      if (access === "none" || (access === "own" && userId !== scope.userId)) continue;
    }
    const key = `${workspaceId}\u0000${userId}`;
    let row = rows.get(key);
    if (!row) {
      const user = userId === UNATTRIBUTED ? { name: "Unattributed", email: "" } : names.user(userId);
      row = {
        workspaceId,
        workspaceName: workspaceId === UNATTRIBUTED ? "Unattributed" : names.workspace(workspaceId),
        userId,
        userName: user.name,
        userEmail: user.email,
        calls: 0,
        costUsd: 0,
        byFeature: {}
      };
      rows.set(key, row);
    }
    row.calls += 1;
    row.costUsd += event.costUsd;
    row.byFeature[event.feature] = (row.byFeature[event.feature] ?? 0) + event.costUsd;
  }
  const sorted = [...rows.values()]
    .map((row) => ({ ...row, costUsd: round(row.costUsd), byFeature: Object.fromEntries(Object.entries(row.byFeature).map(([k, v]) => [k, round(v)])) }))
    .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName) || b.costUsd - a.costUsd || a.userName.localeCompare(b.userName));
  const workspaces = new Map<string, { workspaceId: string; workspaceName: string; calls: number; costUsd: number }>();
  for (const row of rows.values()) {
    const total = workspaces.get(row.workspaceId) ?? { workspaceId: row.workspaceId, workspaceName: row.workspaceName, calls: 0, costUsd: 0 };
    total.calls += row.calls;
    total.costUsd += row.costUsd;
    workspaces.set(row.workspaceId, total);
  }
  const totalUsd = [...rows.values()].reduce((sum, row) => sum + row.costUsd, 0);
  return {
    from: range.from,
    to: range.to,
    rows: sorted,
    workspaces: [...workspaces.values()].map((w) => ({ ...w, costUsd: round(w.costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
    totalUsd: round(totalUsd),
    calls: sorted.reduce((sum, row) => sum + row.calls, 0)
  };
}

const CSV_COLUMNS = ["workspace_id", "workspace", "user_id", "user", "email", "calls", "cost_usd", "voice_usd", "brain_usd", "routine_usd", "other_usd"];

/** RFC 4180 CSV, one row per workspace and person. Cells that a spreadsheet would run as a formula are quoted with a leading '. */
export function chargebackCsv(report: ChargebackReport): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of report.rows) {
    const known = (row.byFeature.voice ?? 0) + (row.byFeature.brain ?? 0) + (row.byFeature.routine ?? 0);
    lines.push(
      [
        row.workspaceId,
        row.workspaceName,
        row.userId,
        row.userName,
        row.userEmail,
        String(row.calls),
        usd(row.costUsd),
        usd(row.byFeature.voice ?? 0),
        usd(row.byFeature.brain ?? 0),
        usd(row.byFeature.routine ?? 0),
        usd(Math.max(0, row.costUsd - known))
      ]
        .map(cell)
        .join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function usd(value: number): string {
  return round(value).toFixed(6);
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
