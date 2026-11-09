/**
 * Microsoft Teams through Microsoft Graph change notifications.
 *
 * Why Graph and not the Bot Framework: the agent works through the existing
 * Microsoft 365 connection (one Entra app, delegated permissions, tokens in
 * the vault) — no Azure Bot resource, no Teams app package to sideload, no
 * second credential. The trade-off: replies are posted as the connected
 * account (use a dedicated account such as "Sibyl" for the workspace
 * connection), and an "@mention" means mentioning that account.
 *
 * - Subscribing: POST /subscriptions for `/teams/{t}/channels/{c}/messages`
 *   (changeType "created", no resource data, so no encryption certificate is
 *   needed); Graph checks the notification URLs first by POSTing a
 *   `validationToken` that must be echoed as text/plain within 10 s.
 * - Channel-message subscriptions live at most an hour without resource
 *   data: they are renewed on the scheduler well before they expire (and on
 *   `reauthorizationRequired` lifecycle events); a removed one is recreated.
 * - Every notification carries the subscription's `clientState`; Sibyl keeps
 *   only its SHA-256 and compares in constant time.
 * - Notifications carry ids only; the message is then read with the
 *   connection (ChannelMessage.Read.All) and checked like a Slack event.
 * https://learn.microsoft.com/graph/change-notifications-delivery-webhooks
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { messageText, type GraphChatMessage } from "../connectors/microsoft/files-teams.js";
import type { ConnectorActionContext } from "../connectors/types.js";
import type { InboundMessage } from "./inbound.js";

export const TEAMS_NOTIFICATIONS_PATH = "/api/presence/teams/notifications";
export const TEAMS_LIFECYCLE_PATH = "/api/presence/teams/lifecycle";
/** Asked-for lifetime of a subscription (channel messages allow 60 minutes without resource data). */
export const TEAMS_SUBSCRIPTION_MINUTES = 55;
/** Renew when less than this is left. */
export const TEAMS_RENEW_BEFORE_MS = 20 * 60_000;
export const TEAMS_NOTIFICATION_MAX_BYTES = 256 * 1024;

export interface GraphNotification {
  subscriptionId: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  lifecycleEvent?: string;
  tenantId?: string;
}

export function parseGraphNotifications(body: Buffer): GraphNotification[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  const list = (value as { value?: unknown } | null)?.value;
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && typeof (item as { subscriptionId?: unknown }).subscriptionId === "string")
    .slice(0, 200)
    .map((item) => ({
      subscriptionId: String(item.subscriptionId),
      ...(typeof item.clientState === "string" ? { clientState: item.clientState } : {}),
      ...(typeof item.changeType === "string" ? { changeType: item.changeType } : {}),
      ...(typeof item.resource === "string" ? { resource: item.resource } : {}),
      ...(typeof item.lifecycleEvent === "string" ? { lifecycleEvent: item.lifecycleEvent } : {}),
      ...(typeof item.tenantId === "string" ? { tenantId: item.tenantId } : {})
    }));
}

/** teams('T')/channels('C')/messages('M')[/replies('R')] (also with slashes instead of the quote form). */
export function parseMessageResource(resource: string): { teamId: string; channelId: string; messageId: string; replyId?: string } | undefined {
  const quoted = /teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)(?:\/replies\('([^']+)'\))?/i.exec(resource);
  const slashed = quoted ? undefined : /teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)(?:\/replies\/([^/]+))?/i.exec(resource);
  const match = quoted ?? slashed;
  if (!match) return undefined;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return { teamId: decode(match[1]!), channelId: decode(match[2]!), messageId: decode(match[3]!), ...(match[4] ? { replyId: decode(match[4]) } : {}) };
}

export function newClientState(): { value: string; hash: string } {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: hashClientState(value) };
}

export function hashClientState(value: string): string {
  return createHash("sha256").update(`sibyl.presence.clientState\u0000${value}`).digest("hex");
}

export function clientStateMatches(expectedHash: string, value: string | undefined): boolean {
  if (!value || value.length > 256) return false;
  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(hashClientState(value), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const graph = (ctx: ConnectorActionContext) => `${ctx.base("graph")}/v1.0`;

export async function createSubscription(
  ctx: ConnectorActionContext,
  input: { teamId: string; channelId: string; publicUrl: string; nowMs: number }
): Promise<{ id: string; expiresAt: number; clientStateHash: string }> {
  const clientState = newClientState();
  const expiration = new Date(input.nowMs + TEAMS_SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const created = await ctx.http.post<{ id?: string; expirationDateTime?: string }>(`${graph(ctx)}/subscriptions`, {
    changeType: "created",
    notificationUrl: `${input.publicUrl}${TEAMS_NOTIFICATIONS_PATH}`,
    lifecycleNotificationUrl: `${input.publicUrl}${TEAMS_LIFECYCLE_PATH}`,
    resource: `/teams/${encodeURIComponent(input.teamId)}/channels/${encodeURIComponent(input.channelId)}/messages`,
    expirationDateTime: expiration,
    clientState: clientState.value
  });
  if (!created?.id) throw new Error("Microsoft Graph did not return a subscription id.");
  return { id: created.id, expiresAt: Date.parse(created.expirationDateTime ?? expiration), clientStateHash: clientState.hash };
}

export async function renewSubscription(ctx: ConnectorActionContext, id: string, nowMs: number): Promise<number> {
  const expiration = new Date(nowMs + TEAMS_SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const renewed = await ctx.http.patch<{ expirationDateTime?: string }>(`${graph(ctx)}/subscriptions/${encodeURIComponent(id)}`, { expirationDateTime: expiration });
  return Date.parse(renewed?.expirationDateTime ?? expiration);
}

export async function deleteSubscription(ctx: ConnectorActionContext, id: string): Promise<void> {
  await ctx.http.delete(`${graph(ctx)}/subscriptions/${encodeURIComponent(id)}`);
}

/** The connected account's Graph user id. */
export async function accountUserId(ctx: ConnectorActionContext): Promise<string> {
  const me = await ctx.http.get<{ id?: string }>(`${graph(ctx)}/me`, { $select: "id" });
  if (!me?.id) throw new Error("Microsoft Graph did not return the account's id.");
  return me.id;
}

/** Read the message a notification points at. */
export async function fetchChannelMessage(ctx: ConnectorActionContext, ref: { teamId: string; channelId: string; messageId: string; replyId?: string }): Promise<GraphChatMessage> {
  const base = `${graph(ctx)}/teams/${encodeURIComponent(ref.teamId)}/channels/${encodeURIComponent(ref.channelId)}/messages/${encodeURIComponent(ref.messageId)}`;
  return ctx.http.get<GraphChatMessage>(ref.replyId ? `${base}/replies/${encodeURIComponent(ref.replyId)}` : base);
}

/** A thread's messages, oldest first (the root and up to 50 replies). */
export async function fetchThread(ctx: ConnectorActionContext, ref: { teamId: string; channelId: string; messageId: string }): Promise<GraphChatMessage[]> {
  const base = `${graph(ctx)}/teams/${encodeURIComponent(ref.teamId)}/channels/${encodeURIComponent(ref.channelId)}/messages/${encodeURIComponent(ref.messageId)}`;
  const [root, replies] = await Promise.all([ctx.http.get<GraphChatMessage>(base), ctx.http.get<{ value?: GraphChatMessage[] }>(`${base}/replies`, { $top: 50 })]);
  const sorted = (replies?.value ?? []).slice().sort((a, b) => Date.parse(a.createdDateTime ?? "") - Date.parse(b.createdDateTime ?? ""));
  return [root, ...sorted].filter((m) => m && (m.messageType === undefined || m.messageType === "message") && !m.deletedDateTime);
}

/**
 * The InboundMessage for a fetched channel message, or undefined when no
 * agent should answer: system messages, deleted ones, and the connected
 * account's own posts (the agent's replies).
 */
export function teamsInbound(
  message: GraphChatMessage,
  input: { connectionId: string; teamId: string; channelId: string; rootId: string; isReply: boolean; accountUserId: string | undefined }
): InboundMessage | undefined {
  if (message.messageType && message.messageType !== "message") return undefined;
  if (message.deletedDateTime) return undefined;
  const author = message.from?.user;
  if (!author?.id) return undefined;
  if (input.accountUserId && author.id === input.accountUserId) return undefined;
  const mentionsOfAccount = (message.mentions ?? []).filter((m) => input.accountUserId && m.mentioned?.user?.id === input.accountUserId);
  let text = messageText(message);
  for (const mention of mentionsOfAccount) {
    if (mention.mentionText) text = text.split(`@${mention.mentionText}`).join(" ");
  }
  return {
    provider: "teams",
    connectionIds: [input.connectionId],
    spaceKey: input.teamId,
    channelId: input.channelId,
    teamId: input.teamId,
    messageId: message.id,
    threadId: input.rootId,
    inThread: input.isReply,
    authorId: author.id,
    ...(author.displayName ? { authorName: author.displayName } : {}),
    text: text.replace(/\s+/g, " ").trim(),
    mentioned: mentionsOfAccount.length > 0,
    dedupeKey: `teams:${input.teamId}:${input.channelId}:${message.id}`
  };
}

/** Teams renders HTML: escape the agent's plain text and keep its line breaks. */
export function teamsHtml(agentName: string, text: string): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p><b>${escape(agentName)}</b></p><p>${escape(text).replace(/\n/g, "<br>")}</p>`;
}
