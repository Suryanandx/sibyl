"use client";

/** The meetings API (docs/meetings.md) over the one gateway HTTP client. */
import type {
  MeetingAgentRoleView,
  MeetingCalendarEventView,
  MeetingCommentView,
  MeetingLobbyEntryView,
  MeetingLobbyStatusView,
  MeetingParticipantView,
  MeetingSegmentView,
  MeetingView
} from "@open-gpt-live/protocol";
import { MEETING_SPEAKER_SLOTS } from "./speakers";
import { gatewayRequest, gatewayUrlFor, gatewayHeaders } from "../../lib/gateway-http";

const base = (id: string) => `/api/meetings/${encodeURIComponent(id)}`;

/** Hosted Sibyl: a guest link names its organization (?o=…); guests have no session to say it. */
function guestHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const org = new URLSearchParams(window.location.search).get("o");
  return org && /^o[0-9a-f]{24}$/.test(org) ? { "x-sibyl-org": org } : {};
}

export const meetingsApi = {
  list: (q = "") => gatewayRequest<{ items: MeetingView[] }>(`/api/meetings${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.items),
  create: (body: { title?: string; scheduledAt?: number; scheduledEndAt?: number; description?: string; sibylRole?: MeetingAgentRoleView; calendar?: { provider: string; eventId: string } }) =>
    gatewayRequest<MeetingView>("/api/meetings", { method: "POST", body }),
  calendar: () => gatewayRequest<{ connected: string[]; items: MeetingCalendarEventView[] }>("/api/meetings/calendar"),
  get: (id: string) => gatewayRequest<MeetingView>(base(id)),
  update: (id: string, body: Record<string, unknown>) => gatewayRequest<MeetingView>(base(id), { method: "PATCH", body }),
  remove: (id: string) => gatewayRequest(base(id), { method: "DELETE" }),
  transcript: (id: string) => gatewayRequest<{ items: MeetingSegmentView[] }>(`${base(id)}/transcript`).then((r) => r.items),
  refreshNotes: (id: string) => gatewayRequest<MeetingView>(`${base(id)}/notes`, { method: "POST" }),
  ask: (id: string, question: string) => gatewayRequest<{ answer: string }>(`${base(id)}/ask`, { method: "POST", body: { question } }).then((r) => r.answer),
  end: (id: string) => gatewayRequest<MeetingView>(`${base(id)}/end`, { method: "POST" }),
  setAgent: (id: string, agentId: string, role: MeetingAgentRoleView | null) =>
    role
      ? gatewayRequest<MeetingView>(`${base(id)}/agents/${encodeURIComponent(agentId)}`, { method: "PUT", body: { role } })
      : gatewayRequest<MeetingView>(`${base(id)}/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),
  mute: (id: string, identity: string) => gatewayRequest(`${base(id)}/participants/${encodeURIComponent(identity)}/mute`, { method: "POST" }),
  removeParticipant: (id: string, identity: string) => gatewayRequest(`${base(id)}/participants/${encodeURIComponent(identity)}/remove`, { method: "POST" }),
  lobby: (id: string) => gatewayRequest<{ items: MeetingLobbyEntryView[] }>(`${base(id)}/lobby`).then((r) => r.items),
  decide: (id: string, ticket: string, admit: boolean) => gatewayRequest(`${base(id)}/lobby/${encodeURIComponent(ticket)}`, { method: "POST", body: { admit } }),
  comments: (id: string) => gatewayRequest<{ items: MeetingCommentView[] }>(`${base(id)}/comments`).then((r) => r.items),
  comment: (id: string, body: { text: string; parentId?: string; atMs?: number }) => gatewayRequest<MeetingCommentView>(`${base(id)}/comments`, { method: "POST", body }),
  deleteComment: (id: string, commentId: string) => gatewayRequest(`${base(id)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }),
  react: (id: string, commentId: string, emoji: string) =>
    gatewayRequest<MeetingCommentView>(`${base(id)}/comments/${encodeURIComponent(commentId)}/reactions`, { method: "POST", body: { emoji } }),
  /** The Markdown export (also what "Save to knowledge" stores). */
  markdown: async (id: string): Promise<string> => {
    const response = await fetch(gatewayUrlFor(`${base(id)}/export`), { credentials: "include", headers: gatewayHeaders() });
    if (!response.ok) throw new Error("Couldn't export the meeting.");
    return response.text();
  },
  /* guests (no account) */
  preview: (id: string, key: string) =>
    gatewayRequest<{ title: string; hostName: string; status: MeetingView["status"] }>(`${base(id)}/preview`, { method: "POST", body: { key }, ownerToken: null, workspaceId: null, headers: guestHeaders() }),
  knock: (id: string, key: string, name: string) =>
    gatewayRequest<{ ticket: string }>(`${base(id)}/lobby`, { method: "POST", body: { key, name }, ownerToken: null, workspaceId: null, headers: guestHeaders() }),
  lobbyStatus: (id: string, ticket: string) =>
    gatewayRequest<MeetingLobbyStatusView>(`${base(id)}/lobby/${encodeURIComponent(ticket)}`, { ownerToken: null, workspaceId: null, headers: guestHeaders() })
};

/** A participant's speaker colour slot by identity (unknown speakers get a stable slot from their identity). */
export function colorOf(participants: readonly MeetingParticipantView[], identity: string): number {
  const known = participants.find((participant) => participant.identity === identity);
  if (known) return known.color;
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % MEETING_SPEAKER_SLOTS;
}
