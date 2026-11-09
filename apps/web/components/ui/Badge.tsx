import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import styles from "./ui.module.css";

export type Tone = "neutral" | "positive" | "warning" | "danger" | "accent" | "info" | "outline";

function toneClass(tone: Tone): string | undefined {
  return tone === "neutral" ? undefined : styles[`tone_${tone}`];
}

/** A small status pill ("Ready", "Paused", "Semantic search on"). */
export function Badge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cx(styles.badge, toneClass(tone), className)} {...rest} />;
}

/** An inline message: errors (role=alert), warnings, confirmations. */
export function Notice({
  tone = "neutral",
  action,
  className,
  children
}: {
  tone?: Exclude<Tone, "accent" | "info" | "outline">;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx(styles.notice, toneClass(tone), className)} role={tone === "danger" ? "alert" : "status"}>
      <div className={styles.noticeBody}>{children}</div>
      {action}
    </div>
  );
}
