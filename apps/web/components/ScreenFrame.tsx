"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { Icon } from "./Icon";
import { useShell } from "./AppFrame";
import { PlaceTabs, placeTabsBarClass, usePlaceTabs } from "./PlaceTabs";
import frameStyles from "./ScreenFrame.module.css";

export interface ScreenNavItem {
  id: string;
  label: string;
  href: string;
  icon?: ReactNode;
  /** Shown but not usable (e.g. an Enterprise section). */
  note?: string;
  /** A heading for a run of items (Settings → "Admin"); none: the top of the list. */
  group?: string;
}

/**
 * One screen inside the app frame: title, optional subtitle and actions, an
 * optional section nav (Settings, Admin) and a scrolling body.
 *
 * The frame owns the screen's title and subtitle: screens never render their
 * own <h1>. Screen-specific actions go in `actions` (top bar) or in a
 * <Toolbar> at the top of the body.
 *
 * On a phone the rail is hidden: the header gets a back button, and a screen
 * with sections shows either the section list (`atIndex`) or one section.
 */
export function ScreenFrame({
  title,
  subtitle,
  actions,
  nav,
  navLabel,
  current,
  atIndex = false,
  back,
  className,
  children
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Section nav entries (left column on desktop). */
  nav?: ScreenNavItem[];
  navLabel?: string;
  /** The open section id. */
  current?: string;
  /** Phone: show the section list instead of a section. */
  atIndex?: boolean;
  /** Phone back button (defaults to the chat). */
  back?: { href: string; label: string };
  className?: string;
  children?: ReactNode;
}) {
  const shell = useShell();
  const backTo = back ?? { href: shell.chatPath, label: "Back to chat" };
  const hasNav = Boolean(nav?.length);
  const navId = useId();
  const placeTabs = usePlaceTabs();
  // Screens with a section nav (Settings) don't take their group's tabs.
  const tabs = hasNav ? null : placeTabs;
  const navGroups = groupNav(nav ?? []);

  return (
    <div className={`screen${hasNav ? " hasNav" : ""}${atIndex ? " atIndex" : ""}${className ? ` ${className}` : ""}`}>
      {hasNav ? (
        <nav className="screenNav" aria-label={navLabel ?? "Sections"}>
          <div className="screenNavHead">
            <Link className="iconBtn screenBack" href={shell.chatPath} aria-label="Back to chat">
              <Icon name="chevronDown" className="iconLeft" />
            </Link>
            <h1 className="screenNavTitle">{navLabel}</h1>
          </div>
          {navGroups.map((group) => (
            <div key={group.name ?? ""} className={group.name ? frameStyles.navGroup : undefined}>
              {group.name ? (
                <p className={frameStyles.navGroupTitle} id={`${navId}-${group.name}`}>
                  {group.name}
                </p>
              ) : null}
              <ul aria-labelledby={group.name ? `${navId}-${group.name}` : undefined}>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      className={`screenNavItem${item.id === current ? " active" : ""}`}
                      href={item.href}
                      aria-current={item.id === current ? "page" : undefined}
                    >
                      {item.icon ? <span className="screenNavIcon">{item.icon}</span> : null}
                      <span className="screenNavLabel">{item.label}</span>
                      {item.note ? <span className="screenNavNote">{item.note}</span> : null}
                      <Icon name="chevronDown" size={16} className="screenNavChevron iconRight" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      ) : null}
      <main className="screenMain" id="main" tabIndex={-1}>
        {/* Same geometry as the chat: a 64px top bar, then the canvas card. */}
        <header className={`topbar screenTopbar${tabs ? ` ${placeTabsBarClass}` : ""}`}>
          <Link className="iconBtn screenBack" href={backTo.href} aria-label={backTo.label} title={backTo.label}>
            <Icon name="chevronDown" className="iconLeft" />
          </Link>
          <div className="topTitle">
            {hasNav ? <h2 className="titleText">{title}</h2> : <h1 className="titleText">{title}</h1>}
          </div>
          {tabs ? <PlaceTabs view={tabs} /> : null}
          {actions ? <div className="topActions">{actions}</div> : null}
        </header>
        <div className="screenCanvas">
          <div className="screenBody">
            {subtitle ? <p className="screenLead">{subtitle}</p> : null}
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Consecutive nav items with the same `group`, in order. */
function groupNav(items: ScreenNavItem[]): Array<{ name?: string; items: ScreenNavItem[] }> {
  const groups: Array<{ name?: string; items: ScreenNavItem[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.group) last.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }
  return groups;
}

/** A quiet empty / offline / unavailable state inside a screen body. */
export { EmptyState as ScreenNotice } from "./ui";
