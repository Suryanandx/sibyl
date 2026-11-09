import type { ScreenNavItem } from "../../components/ScreenFrame";
import { paths } from "../../lib/routes";
import { visibleSettingsSections } from "./sections";

/** The heading of the organization admin sections in the Settings nav. */
export const ADMIN_NAV_GROUP = "Admin";

/**
 * The one Settings nav shared by /settings/<section> and /admin/<section>:
 * the settings sections the person can open, then (for people with
 * org.settings) the organization admin sections under an "Admin" heading.
 * Admin keeps its own addresses; the rail's Settings entry covers both.
 */
export function settingsNav(can: (permission: string) => boolean, adminItems: ScreenNavItem[]): ScreenNavItem[] {
  const settings = visibleSettingsSections(can).map((item): ScreenNavItem => {
    const Icon = item.icon;
    return { id: item.id, label: item.title, href: paths.settings(item.id), icon: <Icon size={18} /> };
  });
  // Section ids repeat across the two (usage): admin ids get a prefix.
  const admin = adminItems.map((item) => ({ ...item, id: adminNavId(item.id), group: ADMIN_NAV_GROUP }));
  return [...settings, ...admin];
}

/** The nav id of an admin section (to mark it open). */
export function adminNavId(section: string): string {
  return `admin:${section}`;
}
