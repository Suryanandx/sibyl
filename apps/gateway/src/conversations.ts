/**
 * Server-side conversations: one recorder per WebSocket connection keeps the
 * live conversation in the Store and restores its LLM text history.
 *
 * - A conversation is only written once its first turn completes, so "New
 *   chat" never leaves empty conversations behind.
 * - A turn (user message + reply) is persisted when the reply's text is done;
 *   a deep-brain result is appended when the brain finishes.
 * - Writes are serialized per connection, so ordering always matches the
 *   order turns finished in.
 */
import timersPromises from "node:timers/promises";
import type { LLMMessage } from "@open-gpt-live/adapters";
import type { ConversationRecord, Store, StoredMessage } from "@open-gpt-live/core";
import type { AttachmentRef, ConversationSummary } from "@open-gpt-live/protocol";
import { attachmentNote } from "./uploads/attachments.js";

export const TITLE_MAX_LENGTH = 60;
const LIST_LIMIT = 100;
/** How long a voice turn waits for its accurate transcript before saving the caption. */
const TRANSCRIPT_WAIT_MS = 5_000;

export interface ConversationRecorderOptions {
  store: Store;
  ownerId: string;
  createId: () => string;
  /** Wall clock for stored timestamps. */
  now?: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Called after a write changed the conversation list (title, order). */
  onListChanged: (items: ConversationSummary[]) => void;
}

interface PendingTurn {
  conversationId: string;
  entry: LLMMessage;
  source: "text" | "audio";
  createdAt: number;
  /** What the user typed (when the model's entry also carries file text). */
  text?: string;
  attachments?: AttachmentRef[];
}

/** Stored user message with attachment references (extra JSON field; the store keeps it). */
type StoredWithAttachments = StoredMessage & { attachments?: AttachmentRef[] };

export function conversationTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim() || "New conversation";
  return clean.length > TITLE_MAX_LENGTH ? `${clean.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : clean;
}

/** Rebuild the LLM text history (without the system prompt) from stored messages. */
export function historyFromMessages(messages: StoredMessage[]): LLMMessage[] {
  const visual = " (A visual with the details is on the user's screen.)";
  return messages
    .filter((message) => message.content.trim() || message.ui?.trim() || (message as StoredWithAttachments).attachments?.length)
    .map((message): LLMMessage => {
      if (message.role === "user") {
        return { role: "user", content: `${message.content}${attachmentNote((message as StoredWithAttachments).attachments)}` };
      }
      const ui = message.ui?.trim() ? visual : "";
      return {
        role: "assistant",
        content: message.kind === "brain" ? `[deep brain] ${message.content.trim()}${ui}` : `${message.content}${ui}`
      };
    });
}

export class ConversationRecorder {
  /** The live conversation (may not exist in the store until its first turn). */
  conversationId: string;
  private readonly pending = new Map<string, PendingTurn>();
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: ConversationRecorderOptions) {
    this.now = options.now ?? Date.now;
    this.conversationId = options.createId();
  }

  /** Start a fresh, not-yet-stored conversation. */
  startNew(): string {
    this.pending.clear();
    this.conversationId = this.options.createId();
    return this.conversationId;
  }

  /** Switch to a stored conversation; undefined when it does not exist. */
  async open(id: string): Promise<ConversationRecord | undefined> {
    await this.flush();
    const record = await this.options.store.conversations.get(this.options.ownerId, id);
    if (!record) return undefined;
    this.pending.clear();
    this.conversationId = record.id;
    return record;
  }

  async list(): Promise<ConversationSummary[]> {
    await this.flush();
    return this.listNow();
  }

  /** Delete a conversation; returns true when it was the live one. */
  async remove(id: string): Promise<boolean> {
    await this.flush();
    await this.options.store.conversations.remove(this.options.ownerId, id);
    return id === this.conversationId;
  }

  /**
   * A user turn entered the history. `entry` is read again when the turn is
   * saved, so a late accurate transcript replaces the on-device caption.
   * Earlier turns that never got a reply (interrupted) are saved on their own
   * when still in the history, so the store matches what the model sees.
   */
  beginTurn(
    requestId: string,
    entry: LLMMessage,
    source: "text" | "audio",
    inHistory: (entry: LLMMessage) => boolean,
    extra: { text?: string; attachments?: AttachmentRef[] } = {}
  ): void {
    for (const [id, turn] of this.pending) {
      this.pending.delete(id);
      if (inHistory(turn.entry)) this.enqueue(() => this.write(turn.conversationId, [this.userMessage(id, turn)]));
    }
    this.pending.set(requestId, {
      conversationId: this.conversationId,
      entry,
      source,
      createdAt: this.now(),
      ...(extra.text !== undefined ? { text: extra.text } : {}),
      ...(extra.attachments?.length ? { attachments: extra.attachments } : {})
    });
  }

  /** The turn was not meant for the assistant (silence/noise): forget it. */
  dropTurn(requestId: string): void {
    this.pending.delete(requestId);
  }

  /** The reply's text is complete: save the user message and the reply. */
  completeReply(
    requestId: string,
    reply: { content: string; ui?: string; model?: string },
    transcriptReady?: Promise<void>
  ): void {
    const turn = this.pending.get(requestId);
    this.pending.delete(requestId);
    const conversationId = turn?.conversationId ?? this.conversationId;
    const replyCreatedAt = this.now();
    this.enqueue(async () => {
      if (turn && transcriptReady) {
        await Promise.race([transcriptReady.catch(() => undefined), timersPromises.setTimeout(TRANSCRIPT_WAIT_MS, undefined, { ref: false })]);
      }
      const messages: StoredMessage[] = [];
      if (turn) messages.push(this.userMessage(requestId, turn));
      if (reply.content.trim() || reply.ui?.trim()) {
        messages.push({
          id: this.options.createId(),
          role: "assistant",
          content: reply.content,
          requestId,
          ...(reply.ui?.trim() ? { ui: reply.ui } : {}),
          ...(reply.model ? { model: reply.model } : {}),
          createdAt: Math.max(replyCreatedAt, turn?.createdAt ?? 0)
        });
      }
      await this.write(conversationId, messages);
    });
  }

  /** A deep-brain run finished: append its result card. */
  brainResult(
    brainId: string,
    parentRequestId: string,
    result: { content: string; ui?: string; task: string; model?: string },
    conversationId = this.conversationId
  ): void {
    const createdAt = this.now();
    this.enqueue(() =>
      this.write(conversationId, [
        {
          id: this.options.createId(),
          role: "assistant",
          kind: "brain",
          content: result.content,
          requestId: brainId,
          task: result.task,
          ...(result.ui?.trim() ? { ui: result.ui } : {}),
          ...(result.model ? { model: result.model } : {}),
          createdAt
        }
      ]).then(() => this.options.log("conversation.brain_saved", { conversationId, brainId, parentRequestId }))
    );
  }

  /** A turn was merged into the next one: remove what was saved for it. */
  retract(requestId: string): void {
    const turn = this.pending.get(requestId);
    this.pending.delete(requestId);
    const conversationId = turn?.conversationId ?? this.conversationId;
    this.enqueue(async () => {
      const { store, ownerId } = this.options;
      const record = await store.conversations.get(ownerId, conversationId);
      if (!record || !record.messages.some((message) => message.requestId === requestId)) return;
      const messages = record.messages.filter((message) => message.requestId !== requestId);
      if (messages.length === 0) await store.conversations.remove(ownerId, conversationId);
      else await store.conversations.upsert({ ...record, messages });
      this.options.onListChanged(await this.listNow());
    });
  }

  /** Wait for queued writes (tests, and before reads). */
  flush(): Promise<void> {
    return this.queue;
  }

  private userMessage(requestId: string, turn: PendingTurn): StoredMessage {
    const message: StoredWithAttachments = {
      id: this.options.createId(),
      role: "user",
      content: turn.text ?? (typeof turn.entry.content === "string" ? turn.entry.content : textOf(turn.entry.content)),
      requestId,
      source: turn.source,
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      createdAt: turn.createdAt
    };
    return message;
  }

  private async write(conversationId: string, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const { store, ownerId } = this.options;
    const existing = await store.conversations.get(ownerId, conversationId);
    if (existing) {
      for (const message of messages) await store.conversations.appendMessage(ownerId, conversationId, message);
    } else {
      const firstUser = messages.find((message) => message.role === "user");
      if (!firstUser) {
        // A reply for a conversation that was deleted meanwhile: don't resurrect it.
        return;
      }
      const createdAt = messages[0]!.createdAt;
      await store.conversations.upsert({
        id: conversationId,
        ownerId,
        title: conversationTitle(
          firstUser.content.trim() ||
            ((firstUser as StoredWithAttachments).attachments ?? []).map((file) => file.name).join(", ")
        ),
        createdAt,
        updatedAt: Math.max(...messages.map((message) => message.createdAt)),
        messages
      });
    }
    this.options.onListChanged(await this.listNow());
  }

  private async listNow(): Promise<ConversationSummary[]> {
    const items = await this.options.store.conversations.list(this.options.ownerId, LIST_LIMIT);
    return items.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.options.log("conversation.save_failed", {
        conversationId: this.conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

function textOf(parts: Exclude<LLMMessage["content"], string>): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join(" ");
}
