"use client";

const CUE = /(\[[a-z][a-z' -]{0,30}\])/i;

/**
 * Renders a spoken reply, showing emotion cues like [laughs] as subtle
 * inline chips instead of raw brackets.
 */
export function SpokenText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(CUE).filter((part) => part.length > 0);
  return (
    <p className={className}>
      {parts.map((part, index) =>
        CUE.test(part) && part.startsWith("[") ? (
          <span key={index} className="cue">
            {part.slice(1, -1)}
          </span>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </p>
  );
}
