"use client";

import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";
import { cx } from "./cx";
import styles from "./ui.module.css";

/**
 * A modal dialog, for the few short tasks that need one (confirm an
 * install, enter a key). Escape and the backdrop close it; focus moves in
 * on open and back to where it was on close. With `onSubmit` the panel is a
 * form, so Enter submits.
 */
export function Dialog({
  title,
  onClose,
  onSubmit,
  actions,
  wide = false,
  children
}: {
  title: ReactNode;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Buttons in the footer, right-aligned (primary last). */
  actions?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("input, textarea, select, button:not([disabled]), [href]");
    (first ?? panel)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);

  const body = (
    <>
      <h2 id={titleId} className={styles.dialogTitle}>
        {title}
      </h2>
      {children}
      {actions ? <div className={styles.dialogActions}>{actions}</div> : null}
    </>
  );
  const common = {
    className: cx(styles.dialog, wide && styles.wide),
    role: "dialog",
    "aria-modal": true,
    "aria-labelledby": titleId,
    tabIndex: -1,
    onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation()
  } as const;

  return (
    <div className={styles.overlay} onMouseDown={() => onClose()}>
      {onSubmit ? (
        <form
          {...common}
          ref={(node) => {
            panelRef.current = node;
          }}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event);
          }}
        >
          {body}
        </form>
      ) : (
        <div
          {...common}
          ref={(node) => {
            panelRef.current = node;
          }}
        >
          {body}
        </div>
      )}
    </div>
  );
}
