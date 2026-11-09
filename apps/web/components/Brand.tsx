"use client";

/**
 * Sibyl brand marks, rendered from the official emblem.
 *
 * - <Mark>: the S emblem as a CSS mask, tinted with the current text color so
 *   it works in light and dark themes at any size.
 * - <SilverMark>: the original silver emblem (with its shading) over a soft
 *   mist, as in the brand artwork. Used for the hero.
 * - <Wordmark>: the wide-tracked SIBYL wordmark, also as a tinted mask.
 */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      className={`brandMark ${className ?? ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="Sibyl"
    />
  );
}

export function SilverMark({ size = 120 }: { size?: number }) {
  return (
    <span className="silverMark" style={{ width: size, height: size }} role="img" aria-label="Sibyl">
      <span className="silverMist" aria-hidden />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/sibyl-mark.png" alt="" width={size} height={size} />
    </span>
  );
}

export function Wordmark({ height = 12, className }: { height?: number; className?: string }) {
  // Source wordmark is 501×44.
  return (
    <span
      className={`brandWordmark ${className ?? ""}`}
      style={{ height, width: Math.round((height * 501) / 44) }}
      role="img"
      aria-label="SIBYL"
    />
  );
}
