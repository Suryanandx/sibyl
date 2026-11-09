/**
 * Sibyl's URLs. One place that knows how places map to addresses, so links,
 * refreshes and the browser's Back/Forward always agree.
 *
 * Places are screens with their own address (docs/plans/v0.4-architecture.md §8):
 *
 *   /                          new chat
 *   /c/<conversationId>        a saved conversation
 *   /library/slides[?space=…]  the Slides library (Spaces)
 *   /media                     generated images and videos (Spaces)
 *   /agents                    your agents (create, edit, review what they learned)
 *   /agents/<id>/computer      an agent's computer: live screen and what it did
 *   /knowledge                 knowledge bases
 *   /skills, /skills/plugins   skills and plugins
 *   /routines, /monitors       scheduled routines and monitors (Automations)
 *   /inbox                     approvals waiting for you
 *   /integrations              connectors (custom MCP servers for now)
 *   /settings/<section>        settings, one section per address
 *   /admin/<section>           organization admin (Sibyl Enterprise)
 *   /meetings                  meetings: upcoming, live now, past
 *   /meetings/<id>             a meeting's notes, transcript, playback and comments
 *   /meetings/recordings       call and meeting recordings (Sibyl Enterprise)
 *   /shared/meetings/<id>?t=…  notes the host shared by link (read-only, no account)
 *   /call/<id>                 a meeting's room (realtime layer; ?host=1 for the host)
 *   /join/<id>?k=…             the guest link (no account: knock, the host admits)
 *   /slides/presentation?id=…  the deck editor (Sibyl Slides engine)
 *
 * The rail groups places (apps/web/lib/nav.ts): Chat, Agents, Meetings,
 * Spaces (Slides, Media), Library (Knowledge, Skills, Plugins, Integrations),
 * Automations (Routines, Monitors) and Settings (with Admin). The inbox is a
 * bell. `placeOf` names the group an address belongs to.
 *
 * Older links used `?panel=<name>` (or `?open=<name>`) over the chat; they
 * still work: `legacyRedirect` maps them to the new addresses.
 */

export const SETTINGS_SECTIONS = [
  "workspace",
  "members",
  "security",
  "models",
  "voice",
  "memory",
  "usage",
  "secrets",
  "diagnostics",
  "licence"
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Browser tab titles; typed so every section has one. */
export const SETTINGS_SECTION_TITLES: Record<SettingsSection, string> = {
  workspace: "Workspace",
  members: "Members",
  security: "Sign-in security",
  models: "Models",
  voice: "Voice",
  memory: "Memory",
  usage: "Usage",
  secrets: "Secrets",
  diagnostics: "Diagnostics",
  licence: "Licence"
};

export const ADMIN_SECTIONS = ["org", "users", "phone", "sso", "scim", "sessions", "roles", "policies", "audit", "usage"] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** Browser tab titles; typed so every section has one. */
export const ADMIN_SECTION_TITLES: Record<AdminSection, string> = {
  org: "Organization",
  users: "Users",
  phone: "Phone",
  sso: "Single sign-on",
  scim: "Provisioning (SCIM)",
  sessions: "Session policies",
  roles: "Roles",
  policies: "Policies",
  audit: "Audit log",
  usage: "Usage controls"
};

/** A rail group (one rail entry), plus the inbox (the bell). */
export type Place = "chat" | "agents" | "meetings" | "spaces" | "library" | "automations" | "inbox" | "settings";

const CONVERSATION_PATH = /^\/c\/([A-Za-z0-9_-]{1,100})\/?$/;

export const paths = {
  newChat: "/",
  conversation: (id: string) => `/c/${encodeURIComponent(id)}`,
  slides: "/library/slides",
  media: "/media",
  agents: "/agents",
  agentComputer: (agentId: string) => `/agents/${encodeURIComponent(agentId)}/computer`,
  knowledge: "/knowledge",
  skills: "/skills",
  plugins: "/skills/plugins",
  routines: "/routines",
  monitors: "/monitors",
  inbox: "/inbox",
  integrations: "/integrations",
  settings: (section?: SettingsSection) => (section ? `/settings/${section}` : "/settings"),
  admin: (section?: AdminSection) => (section ? `/admin/${section}` : "/admin"),
  call: (callId: string, host = false) => `/call/${encodeURIComponent(callId)}${host ? "?host=1" : ""}`,
  meetings: "/meetings",
  meeting: (meetingId: string) => `/meetings/${encodeURIComponent(meetingId)}`,
  recordings: "/meetings/recordings"
} as const;

/** The conversation named by a chat address (`/c/<id>`), or null. */
export function conversationIdOf(pathname: string): string | null {
  return CONVERSATION_PATH.exec(pathname)?.[1] ?? null;
}

/** The chat path for a conversation (null → new chat). */
export function chatPath(conversationId: string | null): string {
  return conversationId ? paths.conversation(conversationId) : paths.newChat;
}

export function isChatPath(pathname: string): boolean {
  return pathname === "/" || CONVERSATION_PATH.test(pathname);
}

/** First path segment → the rail group it belongs to. */
const PLACE_BY_SEGMENT: Readonly<Record<string, Place>> = {
  agents: "agents",
  meetings: "meetings",
  call: "meetings",
  library: "spaces",
  media: "spaces",
  knowledge: "library",
  skills: "library",
  integrations: "library",
  routines: "automations",
  monitors: "automations",
  inbox: "inbox",
  settings: "settings",
  admin: "settings"
};

/** Which rail group an address belongs to (null: not part of the app frame). */
export function placeOf(pathname: string): Place | null {
  if (isChatPath(pathname)) return "chat";
  const first = pathname.split("/")[1] ?? "";
  return Object.hasOwn(PLACE_BY_SEGMENT, first) ? PLACE_BY_SEGMENT[first]! : null;
}

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}

export function isAdminSection(value: string | undefined): value is AdminSection {
  return ADMIN_SECTIONS.includes(value as AdminSection);
}

/** Tabs of the old "Models & voice" dialog → settings sections. */
const LEGACY_SETTINGS_TABS: Record<string, SettingsSection> = {
  presets: "models",
  models: "models",
  voice: "voice",
  memory: "memory",
  usage: "usage",
  diagnostics: "diagnostics"
};

export interface LegacyRedirect {
  /** Where to go instead (replace the history entry). */
  to: string;
  /** `?panel=history` asked for the chat history list. */
  openHistory?: boolean;
  /** A conversation named in the old link, kept as the live chat. */
  conversationId?: string;
}

/**
 * Old `?panel=` / `?open=` links (from bookmarks, the Slides editor, …) →
 * the new address. Null when the location isn't a legacy link.
 */
export function legacyRedirect(location: { pathname: string; search: string }): LegacyRedirect | null {
  const params = new URLSearchParams(location.search);
  const panel = params.get("panel") ?? params.get("open");
  // `?panel=<kind>:<id>` is the chat's side panel (features/side-panel), not a legacy link.
  if (panel === null || panel.includes(":")) return null;
  const conversationId = conversationIdOf(location.pathname) ?? undefined;
  const keep = conversationId ? { conversationId } : {};
  switch (panel) {
    case "history":
      return { to: chatPath(conversationId ?? null), openHistory: true, ...keep };
    case "routines":
      return { to: paths.routines, ...keep };
    case "inbox":
      return { to: paths.inbox, ...keep };
    case "connections":
    case "integrations":
      return { to: paths.integrations, ...keep };
    case "secrets":
      return { to: paths.settings("secrets"), ...keep };
    case "settings":
      return { to: paths.settings(LEGACY_SETTINGS_TABS[params.get("tab") ?? ""] ?? "models"), ...keep };
    default:
      // Unknown panel: drop the parameter, stay where we are.
      return { to: isChatPath(location.pathname) ? location.pathname : "/", ...keep };
  }
}

export function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
