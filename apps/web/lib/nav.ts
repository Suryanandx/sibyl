/**
 * The rail's groups and the tabs inside them. One definition drives the
 * desktop rail, the phone menu, the tabs at the top of a screen and which
 * group is highlighted for any address (with `placeOf` in ./routes).
 *
 * A group or tab is shown only to people with at least one of its `anyOf`
 * permissions (and, for an Enterprise tab, a licence with its `feature`); a
 * group whose tabs are all hidden disappears.
 */
import type { IconName } from "../components/Icon";
import { paths, placeOf, type Place } from "./routes";

export interface NavTab {
  id: string;
  label: string;
  href: string;
  /** Hidden unless the person has at least one of these. */
  anyOf?: readonly string[];
  /** Hidden unless the licence has this feature (packages/core/src/features.ts). */
  feature?: string;
}

export type NavGroupId = Exclude<Place, "inbox">;

export interface NavGroup {
  place: NavGroupId;
  /** Visible name (phone menu) and tooltip. */
  name: string;
  /** Longer accessible name, when the name alone is vague. */
  label?: string;
  icon: IconName;
  /** Where it sits in the rail: the main list or the bottom cluster. */
  slot: "top" | "bottom";
  /** The group's own address, for groups without tabs. */
  href?: string;
  anyOf?: readonly string[];
  /** Two or more addresses shown as tabs; the group opens the first visible one. */
  tabs?: readonly NavTab[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { place: "chat", name: "Chat", icon: "chat", slot: "top", href: paths.newChat },
  { place: "agents", name: "Agents", icon: "sparkle", slot: "top", href: paths.agents, anyOf: ["agents.use", "agents.create"] },
  {
    place: "meetings",
    name: "Meetings",
    label: "Meetings and recordings",
    icon: "video",
    slot: "top",
    anyOf: ["chat.use"],
    tabs: [
      { id: "meetings", label: "Meetings", href: paths.meetings, anyOf: ["chat.use"] },
      { id: "recordings", label: "Recordings", href: paths.recordings, anyOf: ["calls.record"], feature: "recordings" }
    ]
  },
  {
    place: "spaces",
    name: "Spaces",
    label: "Spaces: slides and media",
    icon: "spaces",
    slot: "top",
    tabs: [
      { id: "slides", label: "Slides", href: paths.slides, anyOf: ["slides.use", "slides.manage"] },
      { id: "media", label: "Media", href: paths.media, anyOf: ["chat.use"] }
    ]
  },
  {
    place: "library",
    name: "Library",
    label: "Library: knowledge, skills, plugins and integrations",
    icon: "library",
    slot: "top",
    tabs: [
      { id: "knowledge", label: "Knowledge", href: paths.knowledge, anyOf: ["knowledge.view"] },
      { id: "skills", label: "Skills", href: paths.skills, anyOf: ["skills.use"] },
      { id: "plugins", label: "Plugins", href: paths.plugins, anyOf: ["skills.use"] },
      { id: "integrations", label: "Integrations", href: paths.integrations, anyOf: ["integrations.use", "mcp.manage"] }
    ]
  },
  {
    place: "automations",
    name: "Automations",
    label: "Automations: routines and monitors",
    icon: "routines",
    slot: "top",
    tabs: [
      { id: "routines", label: "Routines", href: paths.routines, anyOf: ["routines.use", "routines.manage"] },
      { id: "monitors", label: "Monitors", href: paths.monitors, anyOf: ["monitors.use", "monitors.manage"] }
    ]
  },
  { place: "settings", name: "Settings", icon: "sliders", slot: "bottom", href: paths.settings() }
];

export type Can = (permission: string) => boolean;
/** Licence features (useAppSession().hasFeature); without it, Enterprise tabs stay hidden. */
export type HasFeature = (feature: string) => boolean;

const allowed = (can: Can, anyOf?: readonly string[]) => !anyOf || anyOf.some((permission) => can(permission));
const licensed = (hasFeature: HasFeature | undefined, feature?: string) => !feature || Boolean(hasFeature?.(feature));

export interface VisibleGroup extends NavGroup {
  /** Where the rail entry goes: the group's address or its first visible tab. */
  href: string;
  tabs: readonly NavTab[];
}

/** The groups this person can use, with only the tabs they can use, in rail order. */
export function visibleNavGroups(can: Can, hasFeature?: HasFeature): VisibleGroup[] {
  const visible: VisibleGroup[] = [];
  for (const group of NAV_GROUPS) {
    if (!allowed(can, group.anyOf)) continue;
    const tabs = (group.tabs ?? []).filter((tab) => allowed(can, tab.anyOf) && licensed(hasFeature, tab.feature));
    if (group.tabs && tabs.length === 0) continue;
    const href = group.href ?? tabs[0]!.href;
    visible.push({ ...group, href, tabs });
  }
  return visible;
}

const isUnder = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/**
 * The tab an address belongs to (its group's tab with the longest matching
 * address, so /skills/plugins is Plugins, not Skills). Null for addresses
 * in a group without tabs.
 */
export function tabOf(pathname: string): NavTab | null {
  const place = placeOf(pathname);
  const group = NAV_GROUPS.find((candidate) => candidate.place === place);
  let best: NavTab | null = null;
  for (const tab of group?.tabs ?? []) {
    if (isUnder(pathname, tab.href) && (!best || tab.href.length > best.href.length)) best = tab;
  }
  return best;
}
