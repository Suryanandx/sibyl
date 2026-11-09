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

/** A channel's messages and replies. */
export function channelMessagesResource(teamId: string, channelId: string): string {
  return `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
}

/**
 * Every chat the connected account is in (1:1, group and meeting chats).
 * Delegated `Chat.Read` / `Chat.ReadWrite` is enough for the signed-in
 * account's own user id; the tenant-wide `/chats/getAllMessages` would need
 * application permissions, which the Microsoft 365 connection doesn't use.
 */
export function accountChatsResource(userId: string): string {
  return `/users/${encodeURIComponent(userId)}/chats/getAllMessages`;
}

export async function createSubscription(
  ctx: ConnectorActionContext,
  input: { resource: string; publicUrl: string; nowMs: number }
): Promise<{ id: string; expiresAt: number; clientStateHash: string }> {
  const clientState = newClientState();
  const expiration = new Date(input.nowMs + TEAMS_SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const created = await ctx.http.post<{ id?: string; expirationDateTime?: string }>(`${graph(ctx)}/subscriptions`, {
    changeType: "created",
    notificationUrl: `${input.publicUrl}${TEAMS_NOTIFICATIONS_PATH}`,
    lifecycleNotificationUrl: `${input.publicUrl}${TEAMS_LIFECYCLE_PATH}`,
    resource: input.resource,
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

/* ───────────── chats (direct messages to agents, 1:1 notices) ───────────── */

/** chats('19:…')/messages('M') (also with slashes). */
export function parseChatResource(resource: string): { chatId: string; messageId: string } | undefined {
  const match = /chats\('([^']+)'\)\/messages\('([^']+)'\)/i.exec(resource) ?? /chats\/([^/]+)\/messages\/([^/?]+)/i.exec(resource);
  if (!match) return undefined;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return { chatId: decode(match[1]!), messageId: decode(match[2]!) };
}

const chatPath = (ctx: ConnectorActionContext, chatId: string) => `${graph(ctx)}/chats/${encodeURIComponent(chatId)}`;

export async function fetchChatMessage(ctx: ConnectorActionContext, ref: { chatId: string; messageId: string }): Promise<GraphChatMessage> {
  return ctx.http.get<GraphChatMessage>(`${chatPath(ctx, ref.chatId)}/messages/${encodeURIComponent(ref.messageId)}`);
}

/** "oneOnOne", "group" or "meeting". */
export async function fetchChatType(ctx: ConnectorActionContext, chatId: string): Promise<string | undefined> {
  return (await ctx.http.get<{ chatType?: string }>(chatPath(ctx, chatId), { $select: "chatType" }))?.chatType;
}

/** The chat's latest messages, oldest first. */
export async function fetchChatHistory(ctx: ConnectorActionContext, chatId: string, top = 20): Promise<GraphChatMessage[]> {
  const page = await ctx.http.get<{ value?: GraphChatMessage[] }>(`${chatPath(ctx, chatId)}/messages`, { $top: top });
  return (page?.value ?? [])
    .filter((m) => m && (m.messageType === undefined || m.messageType === "message") && !m.deletedDateTime)
    .sort((a, b) => Date.parse(a.createdDateTime ?? "") - Date.parse(b.createdDateTime ?? ""));
}

export async function postChatMessage(ctx: ConnectorActionContext, chatId: string, html: string): Promise<void> {
  await ctx.http.post(`${chatPath(ctx, chatId)}/messages`, { body: { contentType: "html", content: html } });
}

/** A person's e-mail (mail, else user principal name) from their Entra user id (User.ReadBasic.All). */
export async function userEmail(ctx: ConnectorActionContext, userId: string): Promise<string | undefined> {
  const user = await ctx.http.get<{ mail?: string | null; userPrincipalName?: string | null }>(`${graph(ctx)}/users/${encodeURIComponent(userId)}`, { $select: "mail,userPrincipalName" });
  return user?.mail || user?.userPrincipalName || undefined;
}

/**
 * The 1:1 chat between the connected account and a person (by e-mail).
 * Graph returns the existing chat when there is one, else creates it.
 */
export async function oneOnOneChat(ctx: ConnectorActionContext, accountUserId: string, email: string): Promise<string> {
  const member = (who: string) => ({
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: ["owner"],
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${who.replace(/'/g, "''")}')`
  });
  const chat = await ctx.http.post<{ id?: string }>(`${graph(ctx)}/chats`, { chatType: "oneOnOne", members: [member(accountUserId), member(email)] });
  if (!chat?.id) throw new Error("Microsoft Graph did not return a chat id.");
  return chat.id;
}

/**
 * The InboundMessage for a chat message, or undefined: system messages,
 * deleted ones, the account's own posts, and meeting chats (meetings have
 * their own place in Sibyl).
 */
export function teamsChatInbound(
  message: GraphChatMessage,
  input: { connectionId: string; chatId: string; chatType: string | undefined; accountUserId: string | undefined }
): InboundMessage | undefined {
  if (input.chatType !== "oneOnOne" && input.chatType !== "group") return undefined;
  if (message.messageType && message.messageType !== "message") return undefined;
  if (message.deletedDateTime) return undefined;
  const author = message.from?.user;
  if (!author?.id || (input.accountUserId && author.id === input.accountUserId)) return undefined;
  const mentionsOfAccount = (message.mentions ?? []).filter((m) => input.accountUserId && m.mentioned?.user?.id === input.accountUserId);
  let text = messageText(message);
  for (const mention of mentionsOfAccount) {
    if (mention.mentionText) text = text.split(`@${mention.mentionText}`).join(" ");
  }
  const direct = input.chatType === "oneOnOne" ? "one" : "group";
  return {
    provider: "teams",
    connectionIds: [input.connectionId],
    spaceKey: "chats",
    channelId: input.chatId,
    messageId: message.id,
    // Chats have no threads: the chat is the conversation.
    threadId: "chat",
    inThread: false,
    authorId: author.id,
    ...(author.displayName ? { authorName: author.displayName } : {}),
    text: text.replace(/\s+/g, " ").trim(),
    mentioned: direct === "one" || mentionsOfAccount.length > 0,
    dedupeKey: `teams-chat:${input.chatId}:${message.id}`,
    direct
  };
}
