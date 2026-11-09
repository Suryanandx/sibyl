/**
 * The side panel's one public entry point: a window event, so any part of the
 * app (chat, media, slides, agents) can show something next to the chat
 * without importing the panel or the chat screen.
 */

/** What the side panel can show. Each item is one entry in the panel's Activity list. */
export type SidePanelItem =
  | { kind: "media"; uploadId: string; mediaType: "image" | "video" | "audio"; title?: string; jobId?: string }
  | { kind: "computer"; agentId: string; runId?: string }
  | { kind: "slides"; artifactId: string; title?: string }
  | { kind: "visual"; requestId: string; title?: string }
  | { kind: "file"; uploadId: string; name: string; mime: string }
  | { kind: "url"; url: string; title?: string };

export type SidePanelKind = SidePanelItem["kind"];

/** `detail` is the item to show, or `null` to close the panel. */
export const SIDE_PANEL_EVENT = "sibyl:side-panel";
/**
 * Same as SIDE_PANEL_EVENT, but something the AI started rather than the
 * person: the panel only opens if they haven't closed it in this conversation
 * (otherwise the item just joins the Activity list).
 */
export const SIDE_PANEL_AUTO_EVENT = "sibyl:side-panel:auto";

/** Show or hide the panel (the chat's Activity button; Ctrl/⌘+\). */
export const SIDE_PANEL_TOGGLE_EVENT = "sibyl:side-panel:toggle";

/** Show an item in the chat's side panel (opens it; the person asked for it). */
export function openSidePanel(item: SidePanelItem, options: { auto?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SidePanelItem>(options.auto ? SIDE_PANEL_AUTO_EVENT : SIDE_PANEL_EVENT, { detail: item }));
}

/** Close the chat's side panel. */
export function closeSidePanel(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SidePanelItem | null>(SIDE_PANEL_EVENT, { detail: null }));
}
