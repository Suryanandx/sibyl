/** Slack actions: channels, history, threads, posting, reactions and search (Slack Web API). */
import { bool, int, objectSchema, optionalInt, optionalString, requireString, str } from "../common.js";
import { ConnectorError, type ConnectorAction } from "../types.js";
import { messageViews, requireChannelId, requireTs, slackCall, type SlackMessage, type SlackResponse } from "./api.js";

const MAX_TEXT = 12_000;

interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

const channelField = { channel: str("Channel id, e.g. C0123456789 (from slack_list_channels).") };

export const slackActions: ConnectorAction[] = [
  {
    name: "list_channels",
    group: "read",
    title: "List Slack channels",
    effect: "read",
    description: "List the Slack channels the app can see (public, and private ones it was added to): id, name, whether the app is a member, topic. Use the id with the other Slack actions.",
    inputSchema: objectSchema({ query: str("Only channels whose name contains this text."), maxResults: int("Max channels (default 100).", 1, 500) }),
    async run(input, ctx) {
      const query = optionalString(input, "query", 80)?.toLowerCase().replace(/^#/, "");
      const max = optionalInt(input, "maxResults", 1, 500, 100);
      const channels: SlackChannel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20 && channels.length < max; page += 1) {
        const result = await slackCall<SlackResponse & { channels?: SlackChannel[] }>(ctx, "conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 200,
          ...(cursor ? { cursor } : {})
        });
        channels.push(...(result.channels ?? []).filter((c) => !query || (c.name ?? "").toLowerCase().includes(query)));
        cursor = result.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      const items = channels.slice(0, max).map((c) => ({
        id: c.id,
        name: c.name,
        private: Boolean(c.is_private),
        appIsMember: Boolean(c.is_member),
        members: c.num_members,
        topic: c.topic?.value || c.purpose?.value || undefined
      }));
      return { summary: `${items.length} channel${items.length === 1 ? "" : "s"}.`, data: { channels: items } };
    }
  },
  {
    name: "read_channel",
    group: "read",
    title: "Read a Slack channel",
    effect: "read",
    description: "Read the latest messages of a Slack channel (newest first), with authors, thread timestamps and reply counts. The app must be in the channel.",
    inputSchema: objectSchema({ ...channelField, limit: int("Messages (default 20).", 1, 100), oldest: str("Only messages after this Slack timestamp.") }, ["channel"]),
    async run(input, ctx) {
      const oldest = optionalString(input, "oldest", 40);
      const result = await slackCall<SlackResponse & { messages?: SlackMessage[] }>(ctx, "conversations.history", {
        channel: requireChannelId(input.channel),
        limit: optionalInt(input, "limit", 1, 100, 20),
        ...(oldest ? { oldest: requireTs(oldest, "oldest") } : {})
      });
      const messages = await messageViews(ctx, (result.messages ?? []).filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast"));
      return { summary: `${messages.length} message${messages.length === 1 ? "" : "s"}.`, data: { messages } };
    }
  },
  {
    name: "read_thread",
    group: "read",
    title: "Read a Slack thread",
    effect: "read",
    description: "Read a Slack thread: the parent message and its replies, oldest first.",
    inputSchema: objectSchema({ ...channelField, threadTs: str("Timestamp of the thread's parent message."), limit: int("Messages (default 50).", 1, 200) }, ["channel", "threadTs"]),
    async run(input, ctx) {
      const result = await slackCall<SlackResponse & { messages?: SlackMessage[] }>(ctx, "conversations.replies", {
        channel: requireChannelId(input.channel),
        ts: requireTs(input.threadTs, "threadTs"),
        limit: optionalInt(input, "limit", 1, 200, 50)
      });
      const messages = await messageViews(ctx, result.messages ?? []);
      return { summary: `${messages.length} message${messages.length === 1 ? "" : "s"} in the thread.`, data: { messages } };
    }
  },
  {
    name: "post_message",
    group: "write",
    title: "Post to a Slack channel",
    effect: "write",
    risk: "high",
    description: "Post a new message to a Slack channel as the Sibyl app. Everyone in the channel sees it (Slack Connect channels include people outside the organization).",
    inputSchema: objectSchema({ ...channelField, text: str("Message text (Slack mrkdwn: *bold*, _italic_, <url|label>).") }, ["channel", "text"]),
    async run(input, ctx) {
      const result = await slackCall<SlackResponse & { ts?: string; channel?: string }>(ctx, "chat.postMessage", { channel: requireChannelId(input.channel), text: requireString(input, "text", MAX_TEXT) }, { write: true });
      return { summary: "Message posted.", data: { channel: result.channel, ts: result.ts } };
    }
  },
  {
    name: "reply_in_thread",
    group: "write",
    title: "Reply in a Slack thread",
    effect: "write",
    description: "Reply in a Slack thread as the Sibyl app (the thread's parent timestamp comes from slack_read_channel or slack_read_thread).",
    inputSchema: objectSchema(
      { ...channelField, threadTs: str("Timestamp of the thread's parent message."), text: str("Reply text (Slack mrkdwn)."), alsoToChannel: bool("Also show the reply in the channel.") },
      ["channel", "threadTs", "text"]
    ),
    async run(input, ctx) {
      const result = await slackCall<SlackResponse & { ts?: string; channel?: string }>(
        ctx,
        "chat.postMessage",
        {
          channel: requireChannelId(input.channel),
          thread_ts: requireTs(input.threadTs, "threadTs"),
          text: requireString(input, "text", MAX_TEXT),
          ...(input.alsoToChannel === true ? { reply_broadcast: true } : {})
        },
        { write: true }
      );
      return { summary: "Reply posted.", data: { channel: result.channel, ts: result.ts } };
    }
  },
  {
    name: "add_reaction",
    group: "reactions",
    title: "React to a Slack message",
    effect: "write",
    description: 'Add an emoji reaction to a Slack message, e.g. "eyes" or "white_check_mark" (name without colons).',
    inputSchema: objectSchema({ ...channelField, ts: str("Timestamp of the message."), emoji: str("Emoji name without colons.") }, ["channel", "ts", "emoji"]),
    async run(input, ctx) {
      const emoji = requireString(input, "emoji", 80).replace(/^:|:$/g, "");
      if (!/^[a-z0-9_+'-]{1,80}$/.test(emoji)) throw new ConnectorError("bad_input", '"emoji" must be an emoji name like "eyes".');
      try {
        await slackCall(ctx, "reactions.add", { channel: requireChannelId(input.channel), timestamp: requireTs(input.ts, "ts"), name: emoji }, { write: true });
      } catch (error) {
        // Already there: nothing to do.
        if (error instanceof Error && /already_reacted/.test(String((error as { detail?: string }).detail ?? error.message))) return { summary: "Already reacted.", data: { emoji } };
        throw error;
      }
      return { summary: `Reacted with :${emoji}:.`, data: { emoji } };
    }
  },
  {
    name: "search_messages",
    group: "search",
    title: "Search Slack messages",
    effect: "read",
    description: "Search Slack messages the connecting person can see (Slack search syntax, e.g. `budget in:#finance from:@maria after:2026-10-01`). Runs as the person who connected Slack.",
    inputSchema: objectSchema({ query: str("Search query."), maxResults: int("Max results (default 20).", 1, 100) }, ["query"]),
    async run(input, ctx) {
      const result = await slackCall<SlackResponse & { messages?: { total?: number; matches?: Array<SlackMessage & { channel?: { id?: string; name?: string }; permalink?: string }> } }>(
        ctx,
        "search.messages",
        { query: requireString(input, "query", 500), count: optionalInt(input, "maxResults", 1, 100, 20), sort: "timestamp" },
        { as: "user" }
      );
      const matches = result.messages?.matches ?? [];
      const views = await messageViews(ctx, matches);
      const items = views.map((view, index) => ({ ...view, channel: matches[index]?.channel?.name, channelId: matches[index]?.channel?.id, link: matches[index]?.permalink }));
      return { summary: `Found ${result.messages?.total ?? items.length} message${items.length === 1 ? "" : "s"}.`, data: { messages: items } };
    }
  }
];
