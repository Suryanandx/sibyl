/**
 * Sibyl's URLs. One place that knows how app state maps to addresses, so
 * links, refreshes and the browser's Back/Forward always agree.
 *
 *   /                          new chat
 *   /c/<conversationId>        a saved conversation
 *   …?panel=routines           a panel over the current chat
 *   …?panel=settings&tab=usage the Models & voice dialog on a tab
 *   /library/slides[?space=…]  the Slides library
 *   /slides/presentation?id=…  the deck editor (Sibyl Slides engine)
 */
export type RoutePanel = "routines" | "inbox" | "connections" | "secrets" | "settings";

export interface AppRoute {
  conversationId: string | null;
  panel: RoutePanel | null;
  tab: string | null;
}

const PANELS: readonly RoutePanel[] = ["routines", "inbox", "connections", "secrets", "settings"];
const CONVERSATION_PATH = /^\/c\/([A-Za-z0-9_-]{1,100})\/?$/;

export function parseRoute(location: { pathname: string; search: string }): AppRoute {
  const match = CONVERSATION_PATH.exec(location.pathname);
  const params = new URLSearchParams(location.search);
  // `open` is the older spelling used by links from other screens.
  const rawPanel = params.get("panel") ?? params.get("open");
  const panel = PANELS.includes(rawPanel as RoutePanel) ? (rawPanel as RoutePanel) : null;
  const tab = panel === "settings" ? params.get("tab") : null;
  return { conversationId: match?.[1] ?? null, panel, tab };
}

export function buildRoute(route: AppRoute): string {
  const path = route.conversationId ? `/c/${encodeURIComponent(route.conversationId)}` : "/";
  const params = new URLSearchParams();
  if (route.panel) params.set("panel", route.panel);
  if (route.panel === "settings" && route.tab) params.set("tab", route.tab);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Link to a panel or chat from screens outside the chat (e.g. the Slides library). */
export function appHref(panel?: RoutePanel | "history"): string {
  if (!panel || panel === "history") return panel === "history" ? "/?panel=history" : "/";
  return buildRoute({ conversationId: null, panel, tab: null });
}

export function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
