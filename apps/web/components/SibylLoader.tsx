"use client";

import { useEffect, useState } from "react";

/**
 * The animated Sibyl emblem.
 *
 * A soft light travels along the folded ribbon of the S, clipped to the real
 * emblem (the brand mask), so the animation always stays inside the logo.
 *
 * States:
 * - idle:      the plain emblem
 * - listening: the emblem breathes while Sibyl hears you
 * - thinking:  one light traces the S while waiting for the first words
 * - working:   two quicker lights (tools, deep work, building a visual)
 * - speaking:  a gentle pulse while Sibyl talks
 */
export type SibylLoaderState = "idle" | "listening" | "thinking" | "working" | "speaking";

/** Centre line of the ribbon in the 512×512 emblem (top hook, then the fold and the lower hook). */
const RIBBON =
  "M425 165 L272 68 L100 168 L95 215 L140 262 L236 200 L405 305 L405 365 L250 462 L105 372";

export function SibylLoader({
  state = "thinking",
  size = 24,
  className,
  label
}: {
  state?: SibylLoaderState;
  size?: number;
  className?: string;
  /** Accessible label; omit when the surrounding text already says what is happening. */
  label?: string;
}) {
  return (
    <span
      className={`sibylLoader ${className ?? ""}`}
      data-state={state}
      style={{ width: size, height: size }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <span className="sibylLoaderBase" />
      <svg className="sibylLoaderTrace" viewBox="0 0 512 512" aria-hidden focusable="false">
        <path d={RIBBON} pathLength={100} className="sibylTrace" />
        <path d={RIBBON} pathLength={100} className="sibylTrace second" />
      </svg>
    </span>
  );
}

const THINKING_LINES: Array<[number, string]> = [
  [0, "Thinking…"],
  [3, "Understanding what you need…"],
  [8, "Working through the details…"],
  [16, "Taking a little longer — still on it…"],
  [30, "Almost there…"]
];

const COMPOSING_LINES: Array<[number, string]> = [
  [0, "Putting it together…"],
  [6, "Writing the answer…"],
  [16, "Taking a little longer — still on it…"]
];

/**
 * The waiting state under a message: the animated emblem, a status line that
 * changes as the wait grows, and the elapsed time once it is noticeable.
 */
export function ThinkingStatus({
  phase,
  showMark = false
}: {
  /** listening: hearing you; thinking: before anything arrives; composing: tools done, answer on its way. */
  phase: "listening" | "thinking" | "composing";
  /** Show the animated emblem inline (off when the reply avatar already animates). */
  showMark?: boolean;
}) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const lines = phase === "composing" ? COMPOSING_LINES : THINKING_LINES;
  const line =
    phase === "listening"
      ? "Listening…"
      : [...lines].reverse().find(([after]) => elapsed >= after)?.[1] ?? lines[0]![1];

  return (
    <div className="thinkingStatus">
      {showMark ? (
        <SibylLoader state={phase === "listening" ? "listening" : elapsed >= 8 ? "working" : "thinking"} size={20} />
      ) : null}
      <span className="thinkingText" aria-live="polite" key={line}>
        {line}
      </span>
      {phase !== "listening" && elapsed >= 3 ? <span className="thinkingElapsed">{elapsed}s</span> : null}
    </div>
  );
}
