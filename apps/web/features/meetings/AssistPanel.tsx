"use client";

/**
 * The meeting's companion panel: Comments (reactions, replies; workspace
 * members), Ask AI (answered from the transcript so far) and Keyword (the
 * words said most, to search and highlight). Comments live on the meeting
 * page; the room shows Ask AI and Keyword.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { MeetingCommentView, MeetingSegmentView, MeetingView } from "@open-gpt-live/protocol";
import { Icon } from "../../components/Icon";
import { Button, EmptyState, Notice } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { meetingsApi } from "./api";
import { clock, initials, keywordsOf } from "./speakers";
import styles from "./meetings.module.css";

export type AssistTab = "comments" | "ask" | "keyword";

const REACTIONS = ["👍", "❤️", "🎉", "😄", "🤔", "👀"];

export function AssistPanel({
  meeting,
  segments,
  tabs,
  onKeyword,
  positionMs,
  onSeek
}: {
  meeting: MeetingView;
  segments: MeetingSegmentView[];
  tabs: readonly AssistTab[];
  /** A keyword was picked: search and highlight it in the transcript. */
  onKeyword(word: string): void;
  positionMs?: number;
  onSeek?(ms: number): void;
}) {
  const [tab, setTab] = useState<AssistTab>(tabs[0]!);
  return (
    <div className={styles.panel}>
      <div className={styles.tabBar} role="tablist" aria-label="Comments and AI">
        {tabs.includes("comments") ? (
          <button type="button" role="tab" aria-selected={tab === "comments"} onClick={() => setTab("comments")}>
            <Icon name="chat" size={16} />
            Comments
          </button>
        ) : null}
        {tabs.includes("ask") ? (
          <button type="button" role="tab" aria-selected={tab === "ask"} onClick={() => setTab("ask")}>
            <Icon name="sparkle" size={16} />
            Ask AI
          </button>
        ) : null}
        {tabs.includes("keyword") ? (
          <button type="button" role="tab" aria-selected={tab === "keyword"} onClick={() => setTab("keyword")}>
            <Icon name="hash" size={16} />
            Keyword
          </button>
        ) : null}
      </div>
      {tab === "comments" ? <Comments meeting={meeting} {...(positionMs !== undefined ? { positionMs } : {})} {...(onSeek ? { onSeek } : {})} /> : null}
      {tab === "ask" ? <AskAi meeting={meeting} hasTranscript={segments.length > 0} /> : null}
      {tab === "keyword" ? <Keywords segments={segments} onKeyword={onKeyword} /> : null}
    </div>
  );
}

/* ───────────── comments ───────────── */

function Comments({ meeting, positionMs, onSeek }: { meeting: MeetingView; positionMs?: number; onSeek?(ms: number): void }) {
  const [items, setItems] = useState<MeetingCommentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [anchor, setAnchor] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  const load = useCallback(() => {
    meetingsApi
      .comments(meeting.id)
      .then(setItems)
      .catch((reason) => setError(errorText(reason)));
  }, [meeting.id]);
  useEffect(load, [load]);

  const threads = useMemo(() => {
    const all = items ?? [];
    return all.filter((comment) => !comment.parentId).map((comment) => ({ comment, replies: all.filter((reply) => reply.parentId === comment.id) }));
  }, [items]);

  async function post(event: FormEvent, parentId?: string): Promise<void> {
    event.preventDefault();
    const body = (parentId ? replyText : text).trim();
    if (!body) return;
    try {
      const created = await meetingsApi.comment(meeting.id, {
        text: body,
        ...(parentId ? { parentId } : {}),
        ...(!parentId && anchor && positionMs !== undefined ? { atMs: positionMs } : {})
      });
      setItems((current) => [...(current ?? []), created]);
      if (parentId) {
        setReplyText("");
        setReplyTo(null);
      } else setText("");
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function react(comment: MeetingCommentView, emoji: string): Promise<void> {
    try {
      const updated = await meetingsApi.react(meeting.id, comment.id, emoji);
      setItems((current) => (current ?? []).map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function remove(comment: MeetingCommentView): Promise<void> {
    try {
      await meetingsApi.deleteComment(meeting.id, comment.id);
      setItems((current) => (current ?? []).filter((item) => item.id !== comment.id && item.parentId !== comment.id));
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  const one = (comment: MeetingCommentView, reply: boolean) => (
    <div className={`${styles.comment}${reply ? ` ${styles.reply}` : ""}`} key={comment.id}>
      <span className={styles.chipFace} aria-hidden="true">
        {initials(comment.authorName)}
      </span>
      <span className={styles.commentHead}>
        <span>{comment.authorName}</span>
        {comment.atMs !== undefined ? (
          <button type="button" className={styles.time} onClick={() => onSeek?.(comment.atMs!)} disabled={!onSeek}>
            {clock(comment.atMs)}
          </button>
        ) : null}
        <span className={styles.ago}>{ago(comment.createdAt)}</span>
      </span>
      <p className={styles.commentText}>{comment.text}</p>
      <div className={styles.reactions}>
        {comment.reactions.map((reaction) => (
          <button key={reaction.emoji} type="button" className={styles.reaction} aria-pressed={reaction.mine} onClick={() => void react(comment, reaction.emoji)} aria-label={`${reaction.emoji} ${reaction.count}`}>
            {reaction.emoji} {reaction.count}
          </button>
        ))}
        <ReactionPicker onPick={(emoji) => void react(comment, emoji)} />
        {!reply ? (
          <button type="button" className={styles.reaction} onClick={() => setReplyTo(replyTo === comment.id ? null : comment.id)}>
            <Icon name="reply" size={14} />
            Reply
          </button>
        ) : null}
        {comment.mine ? (
          <button type="button" className={styles.reaction} onClick={() => void remove(comment)} aria-label="Delete comment">
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <form className={styles.composer} onSubmit={(event) => void post(event)}>
        <textarea rows={1} value={text} onChange={(event) => setText(event.target.value)} placeholder="Add a comment" aria-label="Add a comment" />
        <Button type="submit" variant="primary" size="sm" disabled={!text.trim()}>
          Post
        </Button>
      </form>
      {positionMs !== undefined ? (
        <label className={styles.small}>
          <input type="checkbox" checked={anchor} onChange={(event) => setAnchor(event.target.checked)} /> At {clock(positionMs)}
        </label>
      ) : null}
      {items === null ? <p className={styles.muted}>Loading comments…</p> : null}
      {items !== null && threads.length === 0 ? <EmptyState compact icon={<Icon name="chat" size={22} />} title="No comments yet" /> : null}
      <div>
        {threads.map(({ comment, replies }) => (
          <div key={comment.id} className={styles.thread}>
            {one(comment, false)}
            {replies.map((reply) => one(reply, true))}
            {replyTo === comment.id ? (
              <form className={`${styles.composer} ${styles.reply}`} onSubmit={(event) => void post(event, comment.id)}>
                <input autoFocus value={replyText} onChange={(event) => setReplyText(event.target.value)} placeholder={`Reply to ${comment.authorName}`} aria-label="Reply" />
                <Button type="submit" size="sm" disabled={!replyText.trim()}>
                  Reply
                </Button>
              </form>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

function ReactionPicker({ onPick }: { onPick(emoji: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative" }}>
      <button type="button" className={styles.reaction} aria-label="Add a reaction" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="smile" size={14} />
      </button>
      {open ? (
        <span className={styles.menu} style={{ bottom: "auto", top: 34, left: 0, right: "auto", display: "flex", minWidth: 0 }}>
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() => {
                setOpen(false);
                onPick(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/* ───────────── Ask AI ───────────── */

function AskAi({ meeting, hasTranscript }: { meeting: MeetingView; hasTranscript: boolean }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Array<{ q: string; a: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  async function ask(event: FormEvent): Promise<void> {
    event.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await meetingsApi.ask(meeting.id, q);
      setHistory((current) => [{ q, a: answer }, ...current]);
      setQuestion("");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className={styles.composer} onSubmit={(event) => void ask(event)}>
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about this meeting" aria-label="Ask about this meeting" />
        <Button type="submit" variant="primary" size="sm" disabled={!question.trim() || busy} aria-label="Ask">
          {busy ? "…" : <Icon name="send" size={16} />}
        </Button>
      </form>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {history.length === 0 ? (
        <p className={styles.muted}>{hasTranscript ? "Try “What did we decide?” or “What does Ada need from me?”" : "Ask once people have talked: answers come from the transcript."}</p>
      ) : null}
      {history.map((entry, index) => (
        <div key={index} style={{ display: "grid", gap: 6 }}>
          <span className={styles.question}>{entry.q}</span>
          <div className={styles.answer}>{entry.a}</div>
        </div>
      ))}
    </>
  );
}

/* ───────────── Keyword ───────────── */

function Keywords({ segments, onKeyword }: { segments: MeetingSegmentView[]; onKeyword(word: string): void }) {
  const words = useMemo(() => keywordsOf(segments.map((segment) => segment.text)), [segments]);
  if (words.length === 0) return <p className={styles.muted}>Keywords show up once enough has been said.</p>;
  return (
    <>
      <p className={styles.small}>Said most in this meeting. Pick one to find it in the transcript.</p>
      <div className={styles.keywords}>
        {words.map(({ word, count }) => (
          <button key={word} type="button" className={styles.keyword} onClick={() => onKeyword(word)}>
            # {word} <span className={styles.small}>{count}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}
