"use client";

import { usePathname } from "next/navigation";
import { useAppSession } from "../lib/app-session";
import { tabOf, visibleNavGroups, type NavTab } from "../lib/nav";
import { placeOf } from "../lib/routes";
import { TabLinks } from "./ui";
import styles from "./PlaceTabs.module.css";

export interface PlaceTabsView {
  /** The group's name (the tab list's accessible name). */
  label: string;
  tabs: readonly NavTab[];
  /** The open tab's href. */
  current?: string;
}

/**
 * The tabs of the rail group the current address belongs to (Spaces:
 * Slides | Media, Library: Knowledge | Skills | Plugins | Integrations,
 * Automations: Routines | Monitors), only those the person can use.
 * Null when the group has a single tab or none.
 */
export function usePlaceTabs(): PlaceTabsView | null {
  const pathname = usePathname() ?? "/";
  const session = useAppSession();
  const place = placeOf(pathname);
  const group = visibleNavGroups(session.can, session.hasFeature).find((candidate) => candidate.place === place);
  if (!group || group.tabs.length < 2) return null;
  return { label: group.name, tabs: group.tabs, current: tabOf(pathname)?.href };
}

/** ScreenFrame shows these in the top bar of every screen, so a new screen in a group gets its tabs. */
export function PlaceTabs({ view }: { view: PlaceTabsView }) {
  return (
    <div className={styles.row}>
      <TabLinks className={styles.tabs} label={view.label} tabs={view.tabs} current={view.current} />
    </div>
  );
}

/** Class for a top bar that holds place tabs (they wrap to their own row on phones). */
export const placeTabsBarClass = styles.bar;
