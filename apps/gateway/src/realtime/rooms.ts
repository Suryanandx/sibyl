/**
 * Room names and participant identities.
 *
 * Every room is scoped to a workspace in its name, so a token for one
 * workspace can never be turned into a room of another:
 *
 *   sibyl.voice.<workspace>.<conversation>   1:1 voice of a chat
 *   sibyl.call.<workspace>.<callId>          group call hosted from a chat
 *   sibyl.phone.<workspace>.<id>             phone call (in or out)
 *   sibyl.stream.<workspace>.<id>            a stream an agent listens to
 *
 * Hosted Sibyl shares one LiveKit project between organizations: the
 * workspace part is then `<orgId>_<workspace>` (roomSpace), so rooms, SIP
 * dispatch prefixes and stream listings never cross organizations, and a
 * LiveKit webhook names its organization (orgOfRoom). The self-hosted
 * organization keeps plain workspace ids.
 *
 * Identities: user:<userId>, agent:sibyl, agent:<agentId>, phone:<id>, stream:<id>.
 * Phone numbers never go into room names or identities (they end up in logs).
 */

export type RoomKind = "voice" | "call" | "phone" | "stream";

const KINDS: readonly RoomKind[] = ["voice", "call", "phone", "stream"];
const PART = /^[A-Za-z0-9_-]{1,100}$/;

const SELF_HOSTED_ORG = "owner";
const SPACE = /^(o[0-9a-f]{24})_(.+)$/;

/** The room-name part for an organization's workspace. */
export function roomSpace(orgId: string, workspaceId: string): string {
  return orgId === SELF_HOSTED_ORG ? workspaceId : `${orgId}_${workspaceId}`;
}

/** The organization a room belongs to (undefined: the self-hosted organization, or not a Sibyl room). */
export function orgOfRoom(name: string): string | undefined {
  const parsed = parseRoomName(name);
  return parsed ? SPACE.exec(parsed.workspaceId)?.[1] : undefined;
}

export function roomName(kind: RoomKind, workspaceId: string, id: string): string {
  if (!PART.test(workspaceId) || !PART.test(id)) throw new Error("invalid room part");
  return `sibyl.${kind}.${workspaceId}.${id}`;
}

/** Prefix of a kind's rooms in a workspace (SIP dispatch rules, listings). */
export function roomPrefix(kind: RoomKind, workspaceId: string): string {
  if (!PART.test(workspaceId)) throw new Error("invalid workspace id");
  return `sibyl.${kind}.${workspaceId}.`;
}

export interface ParsedRoom {
  kind: RoomKind;
  workspaceId: string;
  /** Conversation, call or stream id; for inbound phone rooms whatever the dispatch rule appended. */
  id: string;
}

export function parseRoomName(name: string): ParsedRoom | undefined {
  const match = /^sibyl\.([a-z]+)\.([A-Za-z0-9_-]{1,100})\.(.{1,200})$/.exec(name);
  if (!match) return undefined;
  const kind = match[1] as RoomKind;
  if (!KINDS.includes(kind)) return undefined;
  return { kind, workspaceId: match[2]!, id: match[3]! };
}

export const SIBYL_IDENTITY = "agent:sibyl";

export function userIdentity(userId: string | undefined): string {
  return `user:${userId ?? "owner"}`;
}

export function agentIdentity(agentId: string): string {
  return agentId === "sibyl" ? SIBYL_IDENTITY : `agent:${agentId}`;
}

/** Our own voices (never listened to). */
export function isAgentIdentity(identity: string): boolean {
  return identity.startsWith("agent:");
}
