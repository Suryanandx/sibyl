/**
 * Slack Events API: request signing (v0), the URL check, and turning
 * `app_mention` / channel `message` events into InboundMessages.
 *
 * Signature: `v0=` + hex HMAC-SHA256(signing secret, `v0:<timestamp>:<raw body>`)
 * in `X-Slack-Signature`, `X-Slack-Request-Timestamp` within five minutes of
 * now (replays are refused). Checked on the raw bytes, before parsing.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessage } from "./inbound.js";

export const SLACK_TIMESTAMP_TOLERANCE_S = 5 * 60;
export const SLACK_EVENTS_MAX_BYTES = 512 * 1024;

export type SignatureCheck = "ok" | "missing" | "stale" | "mismatch";

export function verifySlackSignature(input: { secret: string; timestamp: string | undefined; signature: string | undefined; body: Buffer; nowMs: number }): SignatureCheck {
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !signature.startsWith("v0=")) return "missing";
  if (Math.abs(Math.floor(input.nowMs / 1000) - Number(timestamp)) > SLACK_TIMESTAMP_TOLERANCE_S) return "stale";
  const expected = Buffer.from(slackSignature(input.secret, timestamp, input.body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? "ok" : "mismatch";
}

/** The `X-Slack-Signature` value for a body (also used by tests to sign events). */
export function slackSignature(secret: string, timestamp: string, body: Buffer | string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
}

export interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
}

export type SlackEnvelope =
  | { type: "url_verification"; challenge: string }
  | { type: "event_callback"; team_id: string; api_app_id?: string; event_id: string; event: SlackEvent; authorizations?: Array<{ user_id?: string; is_bot?: boolean }> }
  | { type: "other" };

export function parseSlackEnvelope(body: Buffer): SlackEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.type === "url_verification") return typeof v.challenge === "string" && v.challenge.length <= 500 ? { type: "url_verification", challenge: v.challenge } : undefined;
  if (v.type === "event_callback") {
    if (typeof v.team_id !== "string" || typeof v.event_id !== "string" || !v.event || typeof v.event !== "object") return undefined;
    return {
      type: "event_callback",
      team_id: v.team_id,
      ...(typeof v.api_app_id === "string" ? { api_app_id: v.api_app_id } : {}),
      event_id: v.event_id,
      event: v.event as SlackEvent,
      ...(Array.isArray(v.authorizations) ? { authorizations: v.authorizations as Array<{ user_id?: string; is_bot?: boolean }> } : {})
    };
  }
  return { type: "other" };
}

/**
 * The message an event carries, or undefined when it is not one an agent
 * answers: bots (including our own replies), edits, joins, DMs, and plain
 * messages that @mention the app (Slack also sends those as app_mention).
 */
export function slackInbound(envelope: Extract<SlackEnvelope, { type: "event_callback" }>, input: { connectionIds: string[]; botUserId?: string }): InboundMessage | undefined {
  const event = envelope.event;
  if (event.type !== "app_mention" && event.type !== "message") return undefined;
  if (event.bot_id || event.app_id || !event.user || (input.botUserId && event.user === input.botUserId)) return undefined;
  if (event.subtype && event.subtype !== "thread_broadcast") return undefined;
  if (!event.channel || !/^[CG][A-Z0-9]{1,30}$/.test(event.channel) || !event.ts) return undefined;
  if (event.type === "message" && event.channel_type && event.channel_type !== "channel" && event.channel_type !== "group") return undefined;
  const raw = event.text ?? "";
  const mention = input.botUserId ? new RegExp(`<@${input.botUserId}(?:\\|[^>]*)?>`, "g") : undefined;
  const mentioned = event.type === "app_mention";
  // The app_mention event answers these; skip the duplicate message event.
  if (!mentioned && mention && mention.test(raw)) return undefined;
  const text = (mention ? raw.replace(mention, " ") : raw).replace(/\s+/g, " ").trim();
  const threadId = event.thread_ts ?? event.ts;
  return {
    provider: "slack",
    connectionIds: input.connectionIds,
    spaceKey: envelope.team_id,
    channelId: event.channel,
    messageId: event.ts,
    threadId,
    inThread: Boolean(event.thread_ts && event.thread_ts !== event.ts),
    authorId: event.user,
    text,
    mentioned,
    // One message can arrive as app_mention and as message; key on the message, not the event.
    dedupeKey: `slack:${envelope.team_id}:${event.channel}:${event.ts}`
  };
}

/** Slack mrkdwn needs &, < and > escaped in plain text. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
