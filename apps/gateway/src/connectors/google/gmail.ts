/** Gmail actions (Gmail API v1, users/me). */
import {
  bool,
  emailList,
  int,
  objectSchema,
  optionalInt,
  optionalString,
  rawEmail,
  requireId,
  requireString,
  seg,
  str,
  strList,
  stringList
} from "../common.js";
import { htmlToText } from "../trim.js";
import type { ConnectorAction, ConnectorActionContext } from "../types.js";

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

const users = (ctx: ConnectorActionContext) => `${ctx.base("gmail")}/gmail/v1/users/me`;

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** Prefer text/plain; fall back to text/html as text. Lists attachment names. */
function bodyOf(part: GmailPart | undefined): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  let plain = "";
  let html = "";
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename) attachments.push(p.filename);
    else if (p.mimeType === "text/plain" && !plain) plain = decode(p.body?.data);
    else if (p.mimeType === "text/html" && !html) html = decode(p.body?.data);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  return { text: plain || htmlToText(html), attachments };
}

function summary(message: GmailMessage) {
  return {
    id: message.id,
    threadId: message.threadId,
    from: header(message, "From"),
    to: header(message, "To"),
    subject: header(message, "Subject"),
    date: header(message, "Date"),
    snippet: message.snippet,
    labels: message.labelIds,
    unread: message.labelIds?.includes("UNREAD") || undefined
  };
}

function full(message: GmailMessage) {
  const body = bodyOf(message.payload);
  return {
    ...summary(message),
    cc: header(message, "Cc"),
    messageIdHeader: header(message, "Message-ID"),
    body: body.text,
    attachments: body.attachments.length ? body.attachments : undefined
  };
}

function draftInput(input: Record<string, unknown>) {
  return {
    to: emailList(input, "to", true),
    cc: emailList(input, "cc"),
    bcc: emailList(input, "bcc"),
    subject: requireString(input, "subject", 500),
    body: requireString(input, "body", 50_000)
  };
}

/** Reply headers so a draft lands in the right thread. */
async function replyHeaders(ctx: ConnectorActionContext, threadId: string | undefined) {
  if (!threadId) return {};
  const thread = await ctx.http.get<{ messages?: GmailMessage[] }>(`${users(ctx)}/threads/${seg(threadId)}`, { format: "metadata", metadataHeaders: "Message-ID" });
  const last = thread.messages?.[thread.messages.length - 1];
  const id = last ? header(last, "Message-ID") : undefined;
  return id ? { inReplyTo: id, references: id } : {};
}

const messageFields = {
  to: strList("Recipients (e-mail addresses)."),
  cc: strList("Cc recipients."),
  bcc: strList("Bcc recipients."),
  subject: str("Subject line."),
  body: str("Plain-text body."),
  threadId: str("Reply within this Gmail thread (id from gmail_search).")
};

export const gmailActions: ConnectorAction[] = [
  {
    name: "gmail_search",
    group: "gmail_read",
    title: "Search Gmail",
    effect: "read",
    description:
      "Search the user's Gmail with Gmail search syntax (e.g. 'from:anna newer_than:7d', 'is:unread label:inbox', 'subject:invoice has:attachment'). Returns id, threadId, from, to, subject, date and snippet per message.",
    inputSchema: objectSchema(
      {
        query: str("Gmail search query. Empty lists the newest messages."),
        maxResults: int("How many messages (default 10).", 1, 25),
        pageToken: str("Continue from a previous search's nextPageToken.")
      },
      []
    ),
    async run(input, ctx) {
      const max = optionalInt(input, "maxResults", 1, 25, 10);
      const list = await ctx.http.get<{ messages?: Array<{ id: string }>; nextPageToken?: string; resultSizeEstimate?: number }>(`${users(ctx)}/messages`, {
        q: optionalString(input, "query", 1000),
        maxResults: max,
        pageToken: optionalString(input, "pageToken", 200)
      });
      const ids = (list.messages ?? []).map((m) => m.id);
      const messages = await Promise.all(
        ids.map((id) =>
          ctx.http.get<GmailMessage>(`${users(ctx)}/messages/${seg(id)}`, { format: "metadata" }, undefined).catch(() => undefined)
        )
      );
      const items = messages.filter((m): m is GmailMessage => Boolean(m)).map(summary);
      return { summary: `Found ${items.length} message${items.length === 1 ? "" : "s"}.`, data: { messages: items, nextPageToken: list.nextPageToken } };
    }
  },
  {
    name: "gmail_read_message",
    group: "gmail_read",
    title: "Read an e-mail",
    effect: "read",
    description: "Read one Gmail message in full (headers, plain-text body, attachment names) by its id from gmail_search.",
    inputSchema: objectSchema({ messageId: str("Message id.") }, ["messageId"]),
    async run(input, ctx) {
      const message = await ctx.http.get<GmailMessage>(`${users(ctx)}/messages/${seg(requireId(input, "messageId"))}`, { format: "full" });
      return { data: full(message) };
    }
  },
  {
    name: "gmail_read_thread",
    group: "gmail_read",
    title: "Read an e-mail thread",
    effect: "read",
    description: "Read a whole Gmail conversation (every message, oldest first) by threadId.",
    inputSchema: objectSchema({ threadId: str("Thread id.") }, ["threadId"]),
    async run(input, ctx) {
      const thread = await ctx.http.get<{ id: string; messages?: GmailMessage[] }>(`${users(ctx)}/threads/${seg(requireId(input, "threadId"))}`, { format: "full" });
      const messages = (thread.messages ?? []).map(full);
      return { summary: `${messages.length} message${messages.length === 1 ? "" : "s"} in the thread.`, data: { threadId: thread.id, messages } };
    }
  },
  {
    name: "gmail_create_draft",
    group: "gmail_draft",
    title: "Create a Gmail draft",
    effect: "write",
    description: "Save an e-mail as a draft in the user's Gmail (nothing is sent). Use threadId to draft a reply.",
    inputSchema: objectSchema(messageFields, ["to", "subject", "body"]),
    async run(input, ctx) {
      const threadId = optionalString(input, "threadId", 200);
      const raw = rawEmail({ ...draftInput(input), ...(await replyHeaders(ctx, threadId)) });
      const draft = await ctx.http.post<{ id: string; message?: { id: string; threadId?: string } }>(`${users(ctx)}/drafts`, {
        message: { raw, ...(threadId ? { threadId } : {}) }
      });
      return { summary: "Draft saved in Gmail.", data: { draftId: draft.id, messageId: draft.message?.id, threadId: draft.message?.threadId } };
    }
  },
  {
    name: "gmail_send",
    group: "gmail_send",
    title: "Send an e-mail (Gmail)",
    effect: "write",
    risk: "high",
    description: "Send an e-mail from the user's Gmail right away. Only when the user clearly wants it sent; otherwise create a draft.",
    inputSchema: objectSchema(messageFields, ["to", "subject", "body"]),
    async run(input, ctx) {
      const threadId = optionalString(input, "threadId", 200);
      const raw = rawEmail({ ...draftInput(input), ...(await replyHeaders(ctx, threadId)) });
      const sent = await ctx.http.post<{ id: string; threadId?: string }>(`${users(ctx)}/messages/send`, { raw, ...(threadId ? { threadId } : {}) });
      return { summary: "E-mail sent.", data: { messageId: sent.id, threadId: sent.threadId } };
    }
  },
  {
    name: "gmail_modify_labels",
    group: "gmail_organize",
    title: "Label or archive an e-mail",
    effect: "write",
    description:
      "Add or remove Gmail labels on a message, archive it (removes INBOX), or mark it read/unread. Label names are matched case-insensitively to the user's labels; system labels: INBOX, STARRED, IMPORTANT, UNREAD, SPAM.",
    inputSchema: objectSchema(
      {
        messageId: str("Message id."),
        addLabels: strList("Labels to add (names)."),
        removeLabels: strList("Labels to remove (names)."),
        archive: bool("Archive the message (remove it from the inbox)."),
        markRead: bool("true: mark read; false: mark unread.")
      },
      ["messageId"]
    ),
    async run(input, ctx) {
      const messageId = requireId(input, "messageId");
      const labels = await ctx.http.get<{ labels?: Array<{ id: string; name: string }> }>(`${users(ctx)}/labels`);
      const byName = new Map((labels.labels ?? []).flatMap((label) => [[label.name.toLowerCase(), label.id], [label.id.toLowerCase(), label.id]] as const));
      const resolve = (names: string[]) =>
        names.map((name) => {
          const id = byName.get(name.toLowerCase());
          if (!id) throw new Error(`There is no Gmail label named "${name}".`);
          return id;
        });
      const add = resolve(stringList(input, "addLabels"));
      const remove = resolve(stringList(input, "removeLabels"));
      if (input.archive === true) remove.push("INBOX");
      if (input.markRead === true) remove.push("UNREAD");
      if (input.markRead === false) add.push("UNREAD");
      if (!add.length && !remove.length) return "Nothing to change.";
      const message = await ctx.http.post<GmailMessage>(`${users(ctx)}/messages/${seg(messageId)}/modify`, { addLabelIds: [...new Set(add)], removeLabelIds: [...new Set(remove)] });
      return { summary: "Labels updated.", data: { id: message.id, labels: message.labelIds } };
    }
  }
];
