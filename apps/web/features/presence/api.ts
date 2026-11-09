"use client";

/** Browser side of /api/presence (agents in Slack and Teams; notification channels). */
import type {
  PresenceAgentState,
  PresenceBindingInput,
  PresenceChannelList,
  PresenceChannelRef,
  PresenceDirectAllow,
  PresenceDirectInput,
  PresenceProvider,
  PresenceRespondMode,
  PresenceWorkspaceSettings
} from "@open-gpt-live/protocol";
import { gatewayRequest } from "../../lib/gateway-http";

const agentPath = (agentId: string) => `/api/presence/agents/${encodeURIComponent(agentId)}`;

export function fetchAgentPresence(agentId: string): Promise<PresenceAgentState> {
  return gatewayRequest(agentPath(agentId));
}

export function addBinding(agentId: string, input: PresenceBindingInput): Promise<PresenceAgentState> {
  return gatewayRequest(`${agentPath(agentId)}/bindings`, { method: "POST", body: input });
}

export function updateBinding(agentId: string, bindingId: string, respond: PresenceRespondMode): Promise<PresenceAgentState> {
  return gatewayRequest(`${agentPath(agentId)}/bindings/${encodeURIComponent(bindingId)}`, { method: "PATCH", body: { respond } });
}

export function removeBinding(agentId: string, bindingId: string): Promise<PresenceAgentState> {
  return gatewayRequest(`${agentPath(agentId)}/bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE" });
}

export function setAgentNotify(agentId: string, notify: PresenceProvider[]): Promise<PresenceAgentState> {
  return gatewayRequest(`${agentPath(agentId)}/settings`, { method: "PUT", body: { notify } });
}

export function setDirect(agentId: string, provider: PresenceProvider, input: PresenceDirectInput): Promise<PresenceAgentState> {
  return gatewayRequest(`${agentPath(agentId)}/direct/${provider}`, { method: "PUT", body: input });
}

export function removeDirect(agentId: string, provider: PresenceProvider): Promise<PresenceAgentState> {
  return gatewayRequest(`${agentPath(agentId)}/direct/${provider}`, { method: "DELETE" });
}

export const DIRECT_RESPOND_OPTIONS: Array<{ id: PresenceRespondMode; label: string }> = [
  { id: "all", label: "Every direct message (unless another agent is named)" },
  { id: "mentions", label: "Only when the message starts with its name" }
];

export const DIRECT_ALLOW_OPTIONS: Array<{ id: PresenceDirectAllow; label: string }> = [
  { id: "members", label: "People in this workspace (matched by e-mail)" },
  { id: "anyone", label: "Anyone in the Slack workspace or Microsoft 365 organization" }
];

export function fetchChannels(provider: PresenceProvider, teamId?: string): Promise<PresenceChannelList> {
  const query = new URLSearchParams({ provider, ...(teamId ? { teamId } : {}) });
  return gatewayRequest(`/api/presence/channels?${query.toString()}`);
}

export function fetchPresenceSettings(): Promise<PresenceWorkspaceSettings> {
  return gatewayRequest("/api/presence/settings");
}

export function savePresenceSettings(input: { slack?: PresenceChannelRef | null; teams?: PresenceChannelRef | null }): Promise<PresenceWorkspaceSettings> {
  return gatewayRequest("/api/presence/settings", { method: "PUT", body: input });
}

export const PROVIDER_NAMES: Record<PresenceProvider, string> = { slack: "Slack", teams: "Microsoft Teams" };

export const RESPOND_OPTIONS: Array<{ id: PresenceRespondMode; label: string }> = [
  { id: "mentions", label: "When @mentioned, then in the thread" },
  { id: "all", label: "Every new message" }
];

/** "Slack #support" / "Teams Product › General". */
export function placeLabel(binding: { provider: PresenceProvider; channelId: string; channelName?: string; teamName?: string }): string {
  return binding.provider === "slack" ? `#${binding.channelName ?? binding.channelId}` : `${binding.teamName ?? "Team"} › ${binding.channelName ?? "channel"}`;
}
