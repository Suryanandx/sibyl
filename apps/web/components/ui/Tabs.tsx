"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./cx";
import styles from "./ui.module.css";

export interface TabOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** Segmented control: switch between views of the same thing. */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
  className
}: {
  options: ReadonlyArray<TabOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
}) {
  return (
    <div className={cx(styles.tabs, className)} role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={styles.tab}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The same control as links between addresses (Skills | Plugins).
 * `current`: the open tab's href, when sub-addresses belong to a tab (default: the exact address).
 */
export function TabLinks({
  tabs,
  label = "Sections",
  className,
  current
}: {
  tabs: ReadonlyArray<{ href: string; label: ReactNode }>;
  label?: string;
  className?: string;
  current?: string;
}) {
  const pathname = usePathname() ?? "";
  const open = current ?? pathname;
  return (
    <nav className={cx(styles.tabs, className)} aria-label={label}>
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href} className={styles.tab} aria-current={open === tab.href ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
