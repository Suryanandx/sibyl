/**
 * The animated Sibyl emblem (ported from apps/web/components/SibylLoader.tsx).
 * A soft light travels along the folded ribbon of the S, clipped to the brand
 * mask. Used for every loading state in Sibyl Slides.
 */
export type SibylLoaderState = "idle" | "listening" | "thinking" | "working" | "speaking";

/** Centre line of the ribbon in the 512×512 emblem. */
const RIBBON =
  "M425 165 L272 68 L100 168 L95 215 L140 262 L236 200 L405 305 L405 365 L250 462 L105 372";

export function SibylLoader({
  state = "thinking",
  size = 24,
  className,
  label,
}: {
  state?: SibylLoaderState;
  size?: number;
  className?: string;
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

/** Emblem plus a status line, centered: the standard Sibyl waiting state. */
export function SibylWaiting({
  message,
  size = 40,
  state = "thinking",
  className,
}: {
  message?: string;
  size?: number;
  state?: SibylLoaderState;
  className?: string;
}) {
  return (
    <div className={`sibylWaiting ${className ?? ""}`} role="status" aria-live="polite">
      <SibylLoader state={state} size={size} />
      {message ? <span className="sibylWaitingText">{message}</span> : null}
    </div>
  );
}

/** Full-screen waiting state. */
export function SibylSplash({ message }: { message?: string }) {
  return (
    <div className="sibylSplash">
      <SibylWaiting message={message} size={48} className="h-full" />
    </div>
  );
}
