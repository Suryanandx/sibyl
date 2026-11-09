import type { ReactNode } from "react";
import { Icon } from "../Icon";
import { Button } from "./Button";
import { cx } from "./cx";
import styles from "./ui.module.css";

/** A short message in the bottom-right corner of the app frame, with an optional action. */
export function Toast({
  title,
  detail,
  tone = "positive",
  action,
  onDismiss
}: {
  title: ReactNode;
  detail?: ReactNode;
  tone?: "positive" | "warning" | "danger";
  action?: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className={cx(styles.toast, tone !== "positive" && styles[`tone_${tone}`])} role="status" aria-live="polite">
      <span className={styles.toastText}>
        <strong>{title}</strong>
        {detail ? <span className={styles.toastDetail}>{detail}</span> : null}
      </span>
      {action}
      <Button variant="ghost" size="sm" iconOnly aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}
