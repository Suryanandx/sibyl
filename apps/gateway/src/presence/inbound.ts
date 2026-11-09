/**
 * Inbound channel messages, the same shape for Slack and Teams, and the one
 * rule that picks which agent answers.
 *
 * - @mentioned (the Slack app / the Teams account): the agent whose name
 *   follows the mention ("@Sibyl Research …"), else the channel's first agent.
 * - A reply in a thread an agent takes part in: that agent.
 * - A new top-level message in a channel where an agent answers everything
 *   ("all"): that agent (the channel's first such agent).
 * - Anything else is ignored.
 *
 * Direct messages (Slack DMs and group DMs with the app, Teams chats with
 * the account) go to the agents that answer direct messages instead:
 * - the agent whose name starts the message;
 * - else the agent already talking in this conversation (a 1:1 DM, or a
 *   thread of a group DM);
 * - else (1:1, or a group message that @mentions the app/account) the first
 *   agent that answers every direct message ("all").
 * In group chats nothing else is answered: people there talk to each other.
 */
import type { PresenceProvider } from "@open-gpt-live/protocol";
import type { PresenceBinding } from "./store.js";

export interface InboundMessage {
  provider: PresenceProvider;
  /** Connections that may have received it (Slack: every connection of that Slack workspace). */
  connectionIds: string[];
  /** Key that names the vendor-side space for thread tracking (Slack team id / Teams team id). */
  spaceKey: string;
  channelId: string;
  teamId?: string;
  /** Slack ts / Teams message id of this message. */
  messageId: string;
  /** Root of its thread (the message itself when it starts one). */
  threadId: string;
  /** A reply inside an existing thread. */
  inThread: boolean;
  authorId: string;
  authorName?: string;
  /** The text with the mention of the app/account removed. */
  text: string;
  mentioned: boolean;
  /** Unique per delivery (Slack event_id / Teams message id) for retries. */
  dedupeKey: string;
  /** A direct message: "one" (1:1 with the app/account) or "group" (a group DM / group chat). */
  direct?: "one" | "group";
  /** Slack 1:1: the thread the person wrote in (the reply goes there; absent: the conversation itself). */
  replyIn?: string;
}

export interface BindingPick {
  binding: PresenceBinding;
  /** The text with a leading agent name removed. */
  text: string;
  reason: "mention" | "thread" | "all";
}

export function pickBinding(input: {
  message: InboundMessage;
  /** Active bindings in the message's channel on one of its connections. */
  candidates: PresenceBinding[];
  /** The binding that takes part in the message's thread, if any. */
  threadBindingId: string | undefined;
  agentName(agentId: string): string | undefined;
}): BindingPick | undefined {
  const { message } = input;
  const candidates = [...input.candidates].sort((a, b) => a.createdAt - b.createdAt);
  if (candidates.length === 0) return undefined;
  if (message.direct) return pickDirect(message, candidates, input.threadBindingId, input.agentName);
  if (message.mentioned) {
    for (const binding of candidates) {
      const rest = afterName(message.text, input.agentName(binding.agentId));
      if (rest !== undefined) return { binding, text: rest, reason: "mention" };
    }
    // In a thread an agent already answers in, it keeps answering there.
    const inThread = message.inThread && input.threadBindingId ? candidates.find((b) => b.id === input.threadBindingId) : undefined;
    return { binding: inThread ?? candidates[0]!, text: message.text, reason: "mention" };
  }
  if (message.inThread) {
    const binding = input.threadBindingId ? candidates.find((b) => b.id === input.threadBindingId) : undefined;
    return binding ? { binding, text: message.text, reason: "thread" } : undefined;
  }
  const all = candidates.find((b) => b.respond === "all");
  return all ? { binding: all, text: message.text, reason: "all" } : undefined;
}

function pickDirect(message: InboundMessage, candidates: PresenceBinding[], threadBindingId: string | undefined, agentName: (agentId: string) => string | undefined): BindingPick | undefined {
  for (const binding of candidates) {
    const rest = afterName(message.text, agentName(binding.agentId));
    if (rest !== undefined) return { binding, text: rest, reason: "mention" };
  }
  const talking = threadBindingId ? candidates.find((b) => b.id === threadBindingId) : undefined;
  if (talking && (message.direct === "one" || message.inThread || message.mentioned)) return { binding: talking, text: message.text, reason: "thread" };
  if (message.direct === "group" && !message.mentioned) return undefined;
  const all = candidates.find((b) => b.respond === "all");
  return all ? { binding: all, text: message.text, reason: "all" } : undefined;
}

/** "Research, what's new?" → "what's new?" when the agent is "Research" (also "@Research", "research:"). */
export function afterName(text: string, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const body = text.trimStart().replace(/^@/, "");
  const lower = body.toLowerCase();
  for (const candidate of [name, name.replace(/\s+/g, ""), name.replace(/\s+/g, "-"), name.replace(/\s+/g, "_")]) {
    const n = candidate.toLowerCase();
    if (n && lower.startsWith(n) && (lower.length === n.length || /[\s,.:;!?]/.test(lower[n.length]!))) {
      return body.slice(n.length).replace(/^[\s,.:;!?]+/, "").trim();
    }
  }
  return undefined;
}

/** Bounded set of recently seen delivery ids (vendor retries are dropped). */
export class RecentIds {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number
  ) {}

  /** True the first time an id is seen (within the TTL). */
  add(id: string): boolean {
    const at = this.now();
    const previous = this.seen.get(id);
    if (previous !== undefined && at - previous < this.ttlMs) return false;
    this.seen.set(id, at);
    if (this.seen.size > this.max) {
      for (const [key, when] of this.seen) {
        if (this.seen.size <= this.max && at - when < this.ttlMs) break;
        this.seen.delete(key);
      }
    }
    return true;
  }
}
