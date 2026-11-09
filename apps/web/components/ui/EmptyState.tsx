import type { ReactNode } from "react";
import { cx } from "./cx";
import styles from "./ui.module.css";

/** A quiet empty / unavailable state. `compact` sits inside a card or list. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  compact = false,
  className
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cx(styles.empty, compact && styles.compact, className)}>
      {icon ? <span className={styles.emptyIcon}>{icon}</span> : null}
      <p className={styles.emptyTitle}>{title}</p>
      {children ? <div className={styles.emptyText}>{children}</div> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}
