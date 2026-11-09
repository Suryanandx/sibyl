"use client";

/**
 * The Getting started checklist in the app rail: a progress ring that opens
 * a short list. Items tick themselves from what is really set up (the
 * gateway works that out); each one links to where it is done. Shown until
 * everything is done or the person dismisses it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { ringDash, welcomePath } from "./flow";
import { refreshOnboarding, updateOnboarding, useOnboarding } from "./useOnboarding";
import styles from "./onboarding.module.css";

const RADIUS = 8;

/**
 * `rail`: a ring button in the desktop rail with a floating panel.
 * `row`: a row in the phone menu (the rail is hidden there) that opens the list in place.
 */
export function GettingStarted({ variant = "rail" }: { variant?: "rail" | "row" }) {
  const pathname = usePathname();
  const { view } = useOnboarding();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Things change elsewhere (a tool connected in a popup, a file added): re-check on focus and on every screen change.
  useEffect(() => {
    const onFocus = () => void refreshOnboarding();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    void refreshOnboarding();
    setOpen(false);
  }, [pathname]);

  // Close on Escape or a click outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const checklist = view?.checklist;
  if (!view || !checklist?.visible) return null;
  const { length, filled } = ringDash(checklist.doneCount, checklist.total, RADIUS);
  const label = `Getting started, ${checklist.doneCount} of ${checklist.total} done`;

  const ring = (
    <svg width={22} height={22} viewBox="0 0 22 22" aria-hidden>
      <circle cx={11} cy={11} r={RADIUS} className={styles.ringTrack} />
      <circle cx={11} cy={11} r={RADIUS} className={styles.ringFill} strokeDasharray={`${filled} ${length}`} transform="rotate(-90 11 11)" />
    </svg>
  );

  return (
    <div className={variant === "row" ? styles.checklistRowWrap : styles.checklistWrap} ref={wrapRef}>
      {variant === "row" ? (
        <button
          ref={buttonRef}
          type="button"
          className={`sidebarPlace ${styles.rowBtn}`}
          aria-label={label}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          {ring}
          <span className="itemLabel">Getting started</span>
          <span className="itemMeta">
            {checklist.doneCount}/{checklist.total}
          </span>
        </button>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className={`railBtn ${styles.ringBtn}`}
          aria-label={label}
          title={label}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          {ring}
          <span className={styles.ringCount} aria-hidden>
            {checklist.doneCount}
          </span>
        </button>
      )}
      {open ? (
        <section id={panelId} className={variant === "row" ? styles.checklistInline : styles.checklist} aria-label="Getting started">
          <header className={styles.checklistHead}>
            <h2>Getting started</h2>
            <span>
              {checklist.doneCount} of {checklist.total}
            </span>
          </header>
          <ul className={styles.checklistItems}>
            {checklist.items.map((item) => (
              <li key={item.id}>
                <Link href={item.href} className={styles.checklistItem} data-done={item.done ? "true" : "false"} onClick={() => setOpen(false)}>
                  <span className={styles.check} aria-hidden>
                    {item.done ? <Icon name="check" size={12} strokeWidth={2.4} /> : null}
                  </span>
                  <span>{item.label}</span>
                  <span className={styles.srOnly}>{item.done ? "(done)" : "(to do)"}</span>
                </Link>
              </li>
            ))}
          </ul>
          <footer className={styles.checklistFoot}>
            {view.pending ? (
              <Link href={welcomePath(view.current)} className={styles.checklistContinue} onClick={() => setOpen(false)}>
                Continue setup
              </Link>
            ) : (
              <span />
            )}
            <button
              type="button"
              className={styles.textButton}
              onClick={() => {
                setOpen(false);
                void updateOnboarding({ checklistDismissed: true }).catch(() => undefined);
              }}
            >
              Dismiss
            </button>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
