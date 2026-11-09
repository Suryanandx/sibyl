import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import styles from "./ui.module.css";

/** A surface with a 1px border: one item, one panel. */
export function Card({
  as: Tag = "section",
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: "section" | "div" | "li" | "article" | "form" }) {
  return <Tag className={cx(styles.card, className)} {...rest} />;
}

/** Title row of a card: title (and meta) on the left, actions on the right. */
export function CardHeader({
  title,
  meta,
  actions,
  level = 3,
  className
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cx(styles.cardHead, className)}>
      <div style={{ minWidth: 0 }}>
        <Heading className={styles.cardTitle}>{title}</Heading>
        {meta ? <p className={styles.cardMeta}>{meta}</p> : null}
      </div>
      {actions ? <div className={styles.row}>{actions}</div> : null}
    </div>
  );
}
