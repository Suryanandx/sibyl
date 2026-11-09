/**
 * Calling the Slack Web API through the connector HTTP client.
 *
 * Slack answers most failures with HTTP 200 and `{ ok: false, error }`; this
 * maps them onto the framework's errors so the usual handling applies (401:
 * reconnect, 403: missing permission, 404: not found, 429: rate limit).
 * Reads use GET with query parameters, writes POST JSON (Slack accepts both
 * with a Bearer token).
 */
import { ConnectorHttpError } from "../http-client.js";
import { ConnectorError, type ConnectorActionContext } from "../types.js";

export interface SlackResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  response_metadata?: { next_cursor?: string; messages?: string[] };
  [key: string]: unknown;
}

type Params = Record<string, string | number | boolean | undefined | unknown[] | Record<string, unknown>>;

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "no_permission"]);
const NOT_FOUND = new Set(["channel_not_found", "thread_not_found", "message_not_found", "user_not_found", "users_not_found"]);

/** One Web API method. `write` POSTs JSON; reads send query parameters. */
export async function slackCall<T extends SlackResponse = SlackResponse>(
  ctx: ConnectorActionContext,
  method: string,
  params: Params = {},
  options: { write?: boolean; as?: "user" } = {}
): Promise<T> {
  const url = `${ctx.base("slack")}/${method}`;
  const response = options.write
    ? await ctx.http.request<T>({ method: "POST", url, body: params, headers: { "content-type": "application/json; charset=utf-8" }, ...(options.as ? { as: options.as } : {}) })
    : await ctx.http.request<T>({ method: "GET", url, query: flatQuery(params), ...(options.as ? { as: options.as } : {}) });
  const data = response.data;
  if (!data || typeof data !== "object") throw new ConnectorHttpError(502, "Slack returned an unexpected response.");
  if (data.ok) return data;
  throw slackError(data);
}

export function slackError(data: SlackResponse): Error {
  const error = String(data.error ?? "unknown_error");
  if (AUTH_ERRORS.has(error)) return new ConnectorHttpError(401, "HTTP 401", error);
  if (error === "missing_scope") return new ConnectorHttpError(403, "HTTP 403", `missing_scope${data.needed ? `: ${data.needed}` : ""}`);
  if (error === "not_allowed_token_type") return new ConnectorError("wrong_token", "Slack doesn't allow this with the app's token. Switch on \"Search messages\" and reconnect Slack.");
  if (error === "not_in_channel") return new ConnectorError("not_in_channel", "The Slack app isn't in that channel. Invite it there first (/invite @your-app in Slack).");
  if (error === "is_archived") return new ConnectorError("archived", "That Slack channel is archived.");
  if (error === "ratelimited") return new ConnectorHttpError(429, "HTTP 429", error);
  if (NOT_FOUND.has(error)) return new ConnectorHttpError(404, "HTTP 404", error);
  return new ConnectorHttpError(400, "HTTP 400", error);
}

function flatQuery(params: Params): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    out[key] = typeof value === "object" ? JSON.stringify(value) : value;
  }
  return out;
}

/** Display names for user ids (at most `max` lookups; unknown ids stay as they are). */
export async function slackUserNames(ctx: ConnectorActionContext, ids: Iterable<string>, max = 15): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set([...ids].filter((id) => /^[UWB][A-Z0-9]{1,20}$/.test(id)))].slice(0, max);
  await Promise.all(
    unique.map(async (id) => {
      try {
        const info = await slackCall<SlackResponse & { user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } } }>(ctx, "users.info", { user: id });
        const name = info.user?.profile?.display_name || info.user?.real_name || info.user?.profile?.real_name || info.user?.name;
        if (name) names.set(id, name);
      } catch {
        // Missing users:read or a deleted user: keep the id.
      }
    })
  );
  return names;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  reactions?: Array<{ name: string; count: number }>;
}

/** The model-facing view of messages, with author names. */
export async function messageViews(ctx: ConnectorActionContext, messages: SlackMessage[]) {
  const names = await slackUserNames(ctx, messages.map((m) => m.user ?? "").filter(Boolean));
  return messages.map((m) => ({
    ts: m.ts,
    author: m.user ? (names.get(m.user) ?? m.user) : (m.username ?? (m.bot_id ? "a bot" : undefined)),
    text: m.text,
    ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
    ...(m.reply_count ? { replies: m.reply_count } : {}),
    ...(m.reactions?.length ? { reactions: m.reactions.map((r) => `${r.name}×${r.count}`) } : {})
  }));
}

/** Channel ids are C…, G… (private, legacy) or D… (direct messages). */
export function requireChannelId(value: unknown, key = "channel"): string {
  if (typeof value !== "string" || !/^[CGD][A-Z0-9]{1,30}$/.test(value.trim())) throw new ConnectorError("bad_input", `"${key}" must be a Slack channel id like C0123456789 (use slack_list_channels).`);
  return value.trim();
}

/** Message timestamps look like 1712345678.123456. */
export function requireTs(value: unknown, key: string): string {
  if (typeof value !== "string" || !/^\d{6,12}\.\d{1,8}$/.test(value.trim())) throw new ConnectorError("bad_input", `"${key}" must be a Slack message timestamp like 1712345678.123456.`);
  return value.trim();
}
