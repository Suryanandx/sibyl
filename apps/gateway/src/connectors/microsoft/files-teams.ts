/** OneDrive / SharePoint files, Excel and Teams actions (Microsoft Graph v1.0). */
import { int, objectSchema, optionalInt, optionalString, requireId, requireString, requireTable, seg, str, table } from "../common.js";
import { DEFAULT_READ_CHARS, MAX_READ_CHARS, fileToText, pageOfText } from "../files.js";
import { htmlToText } from "../trim.js";
import { ConnectorError, type ConnectorAction, type ConnectorActionContext } from "../types.js";

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { driveId?: string; path?: string; siteId?: string };
  lastModifiedBy?: { user?: { displayName?: string } };
}

const graph = (ctx: ConnectorActionContext) => `${ctx.base("graph")}/v1.0`;

/** /drives/{driveId}/items/{id}, or the user's own drive. */
function itemPath(ctx: ConnectorActionContext, input: Record<string, unknown>): string {
  const itemId = requireId(input, "itemId");
  const driveId = optionalString(input, "driveId", 300);
  if (driveId && /[\s/?#\\]/.test(driveId)) throw new ConnectorError("bad_input", '"driveId" is not a valid id.');
  return driveId ? `${graph(ctx)}/drives/${seg(driveId)}/items/${seg(itemId)}` : `${graph(ctx)}/me/drive/items/${seg(itemId)}`;
}

function itemView(item: DriveItem) {
  return {
    itemId: item.id,
    driveId: item.parentReference?.driveId,
    name: item.name,
    type: item.folder ? "folder" : item.file?.mimeType,
    size: item.size,
    modified: item.lastModifiedDateTime,
    modifiedBy: item.lastModifiedBy?.user?.displayName,
    link: item.webUrl
  };
}

const location = {
  itemId: str("Item id (from onedrive_search)."),
  driveId: str("Drive id (from onedrive_search; needed for SharePoint and shared files).")
};

const rangeFields = {
  ...location,
  worksheet: str("Worksheet name, e.g. Sheet1."),
  range: str("Cell range in A1 notation, e.g. A1:D20.")
};

function workbookRange(ctx: ConnectorActionContext, input: Record<string, unknown>): string {
  const sheet = requireString(input, "worksheet", 200).replace(/'/g, "''");
  const range = requireString(input, "range", 100);
  if (!/^[A-Za-z]{1,3}\d{0,7}(:[A-Za-z]{1,3}\d{0,7})?$/.test(range)) throw new ConnectorError("bad_input", '"range" must be A1 notation like A1:D20.');
  return `${itemPath(ctx, input)}/workbook/worksheets('${encodeURIComponent(sheet)}')/range(address='${range}')`;
}

export const filesActions: ConnectorAction[] = [
  {
    name: "onedrive_search",
    group: "files_read",
    title: "Search OneDrive and SharePoint",
    effect: "read",
    description: "Find files the user can access in OneDrive and SharePoint (Microsoft 365) by words in their name or content. Returns itemId and driveId for reading.",
    inputSchema: objectSchema({ query: str("Words to look for."), maxResults: int("Max files (default 15).", 1, 50) }, ["query"]),
    async run(input, ctx) {
      const result = await ctx.http.post<{ value?: Array<{ hitsContainers?: Array<{ hits?: Array<{ summary?: string; resource?: DriveItem }> }> }> }>(`${graph(ctx)}/search/query`, {
        requests: [{ entityTypes: ["driveItem"], query: { queryString: requireString(input, "query", 500) }, from: 0, size: optionalInt(input, "maxResults", 1, 50, 15) }]
      });
      const hits = (result.value ?? []).flatMap((v) => v.hitsContainers ?? []).flatMap((c) => c.hits ?? []);
      const files = hits.filter((hit) => hit.resource?.id).map((hit) => ({ ...itemView(hit.resource!), match: hit.summary ? htmlToText(hit.summary) : undefined }));
      return { summary: `Found ${files.length} file${files.length === 1 ? "" : "s"}.`, data: { files } };
    }
  },
  {
    name: "onedrive_read_file",
    group: "files_read",
    title: "Read a OneDrive/SharePoint file",
    effect: "read",
    description: "Read the text of a OneDrive or SharePoint file: Word (.docx), Excel (.xlsx), PDF, CSV, JSON and text. Long files come in pages: pass nextOffset to continue.",
    inputSchema: objectSchema(
      { ...location, offset: int("Character offset (default 0).", 0, 50_000_000), maxChars: int(`Characters to return (default ${DEFAULT_READ_CHARS}).`, 500, MAX_READ_CHARS) },
      ["itemId"]
    ),
    async run(input, ctx) {
      const path = itemPath(ctx, input);
      const item = await ctx.http.get<DriveItem>(path, { $select: "id,name,size,webUrl,lastModifiedDateTime,file,folder,parentReference,lastModifiedBy" });
      if (item.folder) return { summary: "That is a folder.", data: itemView(item) };
      // /content answers with a redirect to a pre-authenticated download URL.
      const download = await ctx.http.get<{ "@microsoft.graph.downloadUrl"?: string }>(path, { $select: "@microsoft.graph.downloadUrl" }).catch(() => ({}) as { "@microsoft.graph.downloadUrl"?: string });
      const url = download["@microsoft.graph.downloadUrl"];
      const data = url
        ? (await ctx.http.request<Buffer>({ url, unauthenticated: true, responseType: "buffer", timeoutMs: 30_000 })).data
        : (await ctx.http.request<Buffer>({ url: `${path}/content`, responseType: "buffer" })).data;
      const text = await fileToText(data, item.name ?? "file");
      if (!text) return { summary: "This file type can't be read as text.", data: itemView(item) };
      const page = pageOfText(text.text, optionalInt(input, "offset", 0, 50_000_000, 0), optionalInt(input, "maxChars", 500, MAX_READ_CHARS, DEFAULT_READ_CHARS));
      return { data: { file: itemView(item), ...page } };
    }
  },
  {
    name: "excel_read_range",
    group: "files_read",
    title: "Read an Excel range",
    effect: "read",
    description: "Read cell values from a worksheet range of an Excel workbook stored in OneDrive or SharePoint.",
    inputSchema: objectSchema(rangeFields, ["itemId", "worksheet", "range"]),
    async run(input, ctx) {
      const range = await ctx.http.get<{ address?: string; values?: unknown[][] }>(workbookRange(ctx, input), { $select: "address,values" });
      const rows = range.values ?? [];
      return { summary: `${rows.length} row${rows.length === 1 ? "" : "s"}.`, data: { address: range.address, rows } };
    }
  },
  {
    name: "excel_update_range",
    group: "excel_write",
    title: "Update an Excel range",
    effect: "write",
    description: "Overwrite cells of a worksheet range in an Excel workbook in OneDrive or SharePoint. The values must have the same shape as the range.",
    inputSchema: objectSchema({ ...rangeFields, values: table("New values, row by row (same shape as the range).") }, ["itemId", "worksheet", "range", "values"]),
    async run(input, ctx) {
      const updated = await ctx.http.patch<{ address?: string }>(workbookRange(ctx, input), { values: requireTable(input, "values") });
      return { summary: "Range updated.", data: { address: updated.address } };
    }
  }
];

export const teamsActions: ConnectorAction[] = [
  {
    name: "teams_list_teams",
    group: "teams_read",
    title: "List my Teams",
    effect: "read",
    description: "List the Microsoft Teams teams the user is a member of (id and name).",
    inputSchema: objectSchema({}, []),
    async run(_input, ctx) {
      const teams = await ctx.http.get<{ value?: Array<{ id: string; displayName?: string; description?: string }> }>(`${graph(ctx)}/me/joinedTeams`, { $select: "id,displayName,description" });
      const items = (teams.value ?? []).map((t) => ({ teamId: t.id, name: t.displayName, description: t.description }));
      return { summary: `${items.length} team${items.length === 1 ? "" : "s"}.`, data: { teams: items } };
    }
  },
  {
    name: "teams_list_channels",
    group: "teams_read",
    title: "List channels of a team",
    effect: "read",
    description: "List the channels of a Microsoft Teams team (id and name).",
    inputSchema: objectSchema({ teamId: str("Team id from teams_list_teams.") }, ["teamId"]),
    async run(input, ctx) {
      const channels = await ctx.http.get<{ value?: Array<{ id: string; displayName?: string; description?: string; membershipType?: string }> }>(
        `${graph(ctx)}/teams/${seg(requireId(input, "teamId"))}/channels`,
        { $select: "id,displayName,description,membershipType" }
      );
      const items = (channels.value ?? []).map((c) => ({ channelId: c.id, name: c.displayName, description: c.description, type: c.membershipType }));
      return { summary: `${items.length} channel${items.length === 1 ? "" : "s"}.`, data: { channels: items } };
    }
  },
  {
    name: "teams_post_message",
    group: "teams_post",
    title: "Post to a Teams channel",
    effect: "write",
    risk: "high",
    description: "Post a message to a Microsoft Teams channel as the connected user. Everyone in the channel sees it.",
    inputSchema: objectSchema(
      { teamId: str("Team id."), channelId: str("Channel id."), text: str("Message text (plain)."), subject: str("Optional subject line (starts a new thread).") },
      ["teamId", "channelId", "text"]
    ),
    async run(input, ctx) {
      const subject = optionalString(input, "subject", 200);
      const message = await ctx.http.post<{ id: string; webUrl?: string }>(
        `${graph(ctx)}/teams/${seg(requireId(input, "teamId"))}/channels/${seg(requireId(input, "channelId"))}/messages`,
        { ...(subject ? { subject } : {}), body: { contentType: "text", content: requireString(input, "text", 20_000) } }
      );
      return { summary: "Message posted.", data: { messageId: message.id, link: message.webUrl } };
    }
  },
  {
    name: "teams_reply_to_message",
    group: "teams_post",
    title: "Reply in a Teams thread",
    effect: "write",
    description: "Reply to a message in a Microsoft Teams channel (in its thread) as the connected user. The message id comes from teams_read_channel.",
    inputSchema: objectSchema({ teamId: str("Team id."), channelId: str("Channel id."), messageId: str("Id of the thread's first message."), text: str("Reply text (plain).") }, ["teamId", "channelId", "messageId", "text"]),
    async run(input, ctx) {
      const reply = await ctx.http.post<{ id: string; webUrl?: string }>(`${channelPath(ctx, input)}/messages/${seg(requireId(input, "messageId"))}/replies`, {
        body: { contentType: "text", content: requireString(input, "text", 20_000) }
      });
      return { summary: "Reply posted.", data: { messageId: reply.id, link: reply.webUrl } };
    }
  },
  {
    name: "teams_read_channel",
    group: "teams_messages_read",
    title: "Read a Teams channel",
    effect: "read",
    description: "Read the latest messages of a Microsoft Teams channel (newest first): author, text, time and message id (use it to read or reply to a thread).",
    inputSchema: objectSchema({ teamId: str("Team id."), channelId: str("Channel id."), limit: int("Messages (default 20).", 1, 50) }, ["teamId", "channelId"]),
    async run(input, ctx) {
      const page = await ctx.http.get<{ value?: GraphChatMessage[] }>(`${channelPath(ctx, input)}/messages`, { $top: optionalInt(input, "limit", 1, 50, 20) });
      const messages = (page.value ?? []).filter((m) => m.messageType === undefined || m.messageType === "message").map(messageView);
      return { summary: `${messages.length} message${messages.length === 1 ? "" : "s"}.`, data: { messages } };
    }
  },
  {
    name: "teams_read_thread",
    group: "teams_messages_read",
    title: "Read a Teams thread",
    effect: "read",
    description: "Read a Microsoft Teams channel thread: the first message and its replies, oldest first.",
    inputSchema: objectSchema({ teamId: str("Team id."), channelId: str("Channel id."), messageId: str("Id of the thread's first message.") }, ["teamId", "channelId", "messageId"]),
    async run(input, ctx) {
      const root = `${channelPath(ctx, input)}/messages/${seg(requireId(input, "messageId"))}`;
      const [first, replies] = await Promise.all([ctx.http.get<GraphChatMessage>(root), ctx.http.get<{ value?: GraphChatMessage[] }>(`${root}/replies`, { $top: 50 })]);
      const ordered = [first, ...(replies.value ?? []).slice().sort((a, b) => Date.parse(a.createdDateTime ?? "") - Date.parse(b.createdDateTime ?? ""))];
      const messages = ordered.filter((m) => m.messageType === undefined || m.messageType === "message").map(messageView);
      return { summary: `${messages.length} message${messages.length === 1 ? "" : "s"} in the thread.`, data: { messages } };
    }
  },
  {
    name: "teams_list_chats",
    group: "teams_chat",
    title: "List my Teams chats",
    effect: "read",
    description: "List the user's recent Microsoft Teams chats (one-on-one, group and meeting chats): chat id, topic and members.",
    inputSchema: objectSchema({ limit: int("Chats (default 20).", 1, 50) }),
    async run(input, ctx) {
      const page = await ctx.http.get<{ value?: Array<{ id: string; topic?: string | null; chatType?: string; members?: Array<{ displayName?: string }> }> }>(`${graph(ctx)}/me/chats`, {
        $top: optionalInt(input, "limit", 1, 50, 20),
        $expand: "members"
      });
      const chats = (page.value ?? []).map((c) => ({ chatId: c.id, topic: c.topic ?? undefined, type: c.chatType, members: (c.members ?? []).map((m) => m.displayName).filter(Boolean) }));
      return { summary: `${chats.length} chat${chats.length === 1 ? "" : "s"}.`, data: { chats } };
    }
  },
  {
    name: "teams_post_chat_message",
    group: "teams_chat",
    title: "Send a Teams chat message",
    effect: "write",
    risk: "high",
    description: "Send a message in a Microsoft Teams chat (chat id from teams_list_chats) as the connected user. Everyone in the chat sees it.",
    inputSchema: objectSchema({ chatId: str("Chat id."), text: str("Message text (plain).") }, ["chatId", "text"]),
    async run(input, ctx) {
      const message = await ctx.http.post<{ id: string; webUrl?: string }>(`${graph(ctx)}/chats/${seg(requireId(input, "chatId"))}/messages`, {
        body: { contentType: "text", content: requireString(input, "text", 20_000) }
      });
      return { summary: "Message sent.", data: { messageId: message.id, link: message.webUrl } };
    }
  }
];

/** A Teams channel or chat message (Graph chatMessage). */
export interface GraphChatMessage {
  id: string;
  replyToId?: string | null;
  messageType?: string;
  createdDateTime?: string;
  deletedDateTime?: string | null;
  webUrl?: string;
  from?: { user?: { id?: string; displayName?: string } | null; application?: { id?: string; displayName?: string } | null } | null;
  body?: { contentType?: "text" | "html"; content?: string };
  mentions?: Array<{ id?: number; mentionText?: string; mentioned?: { user?: { id?: string; displayName?: string } | null } }>;
}

/** Plain text of a message (Teams sends HTML; mentions become "@Name"). */
export function messageText(message: GraphChatMessage): string {
  const content = message.body?.content ?? "";
  return (message.body?.contentType === "html" ? htmlToText(content.replace(/<at\b[^>]*>(.*?)<\/at>/gi, "@$1")) : content).trim();
}

function messageView(message: GraphChatMessage) {
  return {
    messageId: message.id,
    author: message.from?.user?.displayName ?? message.from?.application?.displayName,
    text: messageText(message),
    at: message.createdDateTime,
    ...(message.webUrl ? { link: message.webUrl } : {})
  };
}

function channelPath(ctx: ConnectorActionContext, input: Record<string, unknown>): string {
  return `${graph(ctx)}/teams/${seg(requireId(input, "teamId"))}/channels/${seg(requireId(input, "channelId"))}`;
}
