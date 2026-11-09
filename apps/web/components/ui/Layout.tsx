import type { HTMLAttributes, ReactNode } from "react";
import { buttonClass } from "./Button";
import { cx } from "./cx";
import styles from "./ui.module.css";

/** Vertical stack with the standard gap. */
export function Stack({ className, gap, style, ...rest }: HTMLAttributes<HTMLDivElement> & { gap?: number }) {
  return <div className={cx(styles.stack, className)} style={gap === undefined ? style : { ...style, gap }} {...rest} />;
}

/** Horizontal row that wraps. */
export function Row({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.row, className)} {...rest} />;
}

export function Spacer() {
  return <span className={styles.spacer} />;
}

/** The row under the screen title: filters or tabs on the left, actions on the right. */
export function Toolbar({ start, end, className }: { start?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <div className={cx(styles.toolbar, className)}>
      {start ? <div className={styles.toolbarStart}>{start}</div> : null}
      {end ? <div className={styles.toolbarEnd}>{end}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cx(styles.sectionTitle, className)}>{children}</h2>;
}

/** Secondary text (loading, hints, "nothing yet"). */
export function Muted({ children, className, as: Tag = "p" }: { children: ReactNode; className?: string; as?: "p" | "span" }) {
  return <Tag className={cx(styles.muted, className)}>{children}</Tag>;
}

/**
 * A list on the left and the open item on the right. On a phone only one
 * shows: the list, or (when `open`) the item with its own back link.
 */
export function Split({ open, list, detail, className }: { open: boolean; list: ReactNode; detail: ReactNode; className?: string }) {
  return (
    <div className={cx(styles.split, className)} data-open={open ? "true" : "false"}>
      {list}
      {detail}
    </div>
  );
}

/** "← Bases" at the top of the open item; shown on phones only. */
export function SplitBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={cx(buttonClass({ variant: "link", size: "sm" }), styles.splitBack)} onClick={onClick}>
      ← {label}
    </button>
  );
}

/** A selectable entry in a list (a knowledge base, a skill). */
export function ListItem({
  title,
  meta,
  current,
  onSelect
}: {
  title: ReactNode;
  meta?: ReactNode;
  current: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button type="button" className={styles.listItem} aria-current={current} onClick={onSelect}>
        <span className={styles.listItemTitle}>{title}</span>
        {meta ? <span className={styles.listItemMeta}>{meta}</span> : null}
      </button>
    </li>
  );
}

export function ListItems({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className={styles.listItems} aria-label={label}>
      {children}
    </ul>
  );
}
