"use client";

/**
 * Browser client for the gateway's monitors API (routes listed in
 * @open-gpt-live/protocol, "Monitors"). Calls go through the shared gateway
 * client (session cookie, owner token and workspace).
 */
import type {
  MonitorEventView,
  MonitorInput,
  MonitorSaveResponse,
  MonitorStatusView,
  MonitorTestResult,
  MonitorView,
  MonitorsListResponse
} from "@open-gpt-live/protocol";
import { gatewayRequest, type GatewayRequest } from "../../lib/gateway-http";

export type MonitorsRequest = <T>(path: string, init?: GatewayRequest) => Promise<T>;

export interface MonitorsApi {
  list(): Promise<MonitorsListResponse>;
  create(input: MonitorInput): Promise<MonitorSaveResponse>;
  update(id: string, input: MonitorInput): Promise<MonitorSaveResponse>;
  pause(id: string, paused: boolean): Promise<MonitorView>;
  runNow(id: string): Promise<void>;
  /** Dry run of a saved monitor (id) or of the form as it is (input). */
  test(target: { id: string } | { input: MonitorInput }): Promise<MonitorTestResult>;
  remove(id: string): Promise<void>;
  events(query?: { monitorId?: string; before?: number; limit?: number }): Promise<MonitorEventView[]>;
  statuses(): Promise<MonitorStatusView[]>;
}

export function createMonitorsApi(request: MonitorsRequest = gatewayRequest): MonitorsApi {
  const id = (value: string) => encodeURIComponent(value);
  return {
    list: () => request<MonitorsListResponse>("/api/monitors"),
    create: (input) => request<MonitorSaveResponse>("/api/monitors", { method: "POST", body: input }),
    update: (monitorId, input) => request<MonitorSaveResponse>(`/api/monitors/${id(monitorId)}`, { method: "PATCH", body: input }),
    pause: async (monitorId, paused) => (await request<{ monitor: MonitorView }>(`/api/monitors/${id(monitorId)}/pause`, { method: "POST", body: { paused } })).monitor,
    runNow: async (monitorId) => {
      await request<{ ok: true }>(`/api/monitors/${id(monitorId)}/run`, { method: "POST" });
    },
    test: (target) =>
      "id" in target
        ? request<MonitorTestResult>(`/api/monitors/${id(target.id)}/test`, { method: "POST" })
        : request<MonitorTestResult>("/api/monitors/test", { method: "POST", body: target.input }),
    remove: async (monitorId) => {
      await request<{ ok: true }>(`/api/monitors/${id(monitorId)}`, { method: "DELETE" });
    },
    events: async (query = {}) => {
      const params = new URLSearchParams();
      if (query.monitorId) params.set("monitorId", query.monitorId);
      if (query.before !== undefined) params.set("before", String(query.before));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return (await request<{ events: MonitorEventView[] }>(`/api/monitors/events${suffix}`)).events;
    },
    statuses: async () => (await request<{ statuses: MonitorStatusView[] }>("/api/monitors/status")).statuses
  };
}

/** Merge a live status (monitors.status over the WebSocket or a poll) into a monitor view. */
export function withStatus(monitor: MonitorView, status: MonitorStatusView | undefined): MonitorView {
  if (!status || status.id !== monitor.id) return monitor;
  const next: MonitorView = { ...monitor, status: status.status, enabled: status.enabled, costMonthUsd: status.costMonthUsd };
  for (const key of ["lastCheckedAt", "lastFiredAt", "nextCheckAt", "lastError", "pausedReason"] as const) {
    if (status[key] === undefined) delete next[key];
    else (next as unknown as Record<string, unknown>)[key] = status[key];
  }
  return next;
}
