"use client";

/**
 * Browser side of /api/connectors. Requests carry the session cookie, the
 * stored owner token and the current workspace (lib/gateway-http.ts). Nothing
 * here ever receives a token or a client secret.
 */
import type { IntegrationConnectionView, IntegrationsState } from "@open-gpt-live/protocol";
import { gatewayHttpUrl, gatewayRequest } from "../../lib/gateway-http";

export function fetchIntegrations(): Promise<IntegrationsState> {
  return gatewayRequest<IntegrationsState>("/api/connectors");
}

export interface ConnectInput {
  scope: "personal" | "workspace";
  groups: string[];
  /** API-key connections (e.g. a HubSpot private app token). */
  credentials?: Record<string, string>;
}

export function startConnect(connectorId: string, input: ConnectInput): Promise<{ authorizeUrl?: string; connection?: IntegrationConnectionView }> {
  return gatewayRequest(`/api/connectors/${encodeURIComponent(connectorId)}/connect`, { method: "POST", body: input });
}

export function reconnect(connectionId: string, groups?: string[]): Promise<{ authorizeUrl: string }> {
  return gatewayRequest(`/api/connectors/connections/${encodeURIComponent(connectionId)}/reconnect`, { method: "POST", body: groups ? { groups } : {} });
}

export function updateConnection(connectionId: string, groups: string[]): Promise<{ connection: IntegrationConnectionView }> {
  return gatewayRequest(`/api/connectors/connections/${encodeURIComponent(connectionId)}`, { method: "PATCH", body: { groups } });
}

export function testConnection(connectionId: string): Promise<{ connection: IntegrationConnectionView }> {
  return gatewayRequest(`/api/connectors/connections/${encodeURIComponent(connectionId)}/test`, { method: "POST", body: {} });
}

export function disconnect(connectionId: string): Promise<{ ok: boolean }> {
  return gatewayRequest(`/api/connectors/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
}

export interface AppInput {
  clientId?: string;
  clientSecret?: string;
  settings?: Record<string, string>;
  allowedGroups?: string[] | null;
  /** Further app secrets by name (e.g. Slack's SIGNING_SECRET); write-only. */
  secrets?: Record<string, string>;
}

export function saveApp(connectorId: string, input: AppInput): Promise<IntegrationsState> {
  return gatewayRequest<IntegrationsState>(`/api/connectors/apps/${encodeURIComponent(connectorId)}`, { method: "PUT", body: input });
}

export function removeApp(connectorId: string): Promise<IntegrationsState> {
  return gatewayRequest<IntegrationsState>(`/api/connectors/apps/${encodeURIComponent(connectorId)}`, { method: "DELETE" });
}

/**
 * Open the vendor's consent page in a popup (the callback page tells us when
 * it is done); fall back to a full-page redirect when popups are blocked.
 */
export function openConsent(authorizeUrl: string): Window | null {
  const width = 520;
  const height = 680;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  const popup = window.open(authorizeUrl, "sibyl-connect", `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (!popup) window.location.assign(authorizeUrl);
  return popup;
}

/** The callback page posts `{ source: "sibyl-integrations", ok }` from the gateway's origin. */
export function isConsentMessage(event: MessageEvent): event is MessageEvent<{ source: "sibyl-integrations"; ok: boolean; connectorId?: string }> {
  let gatewayOrigin = "";
  try {
    gatewayOrigin = new URL(gatewayHttpUrl()).origin;
  } catch {
    gatewayOrigin = "";
  }
  const data = event.data as { source?: unknown } | null;
  return event.origin === gatewayOrigin && Boolean(data && typeof data === "object" && data.source === "sibyl-integrations");
}
