/**
 * The chat's side panel: what the AI is doing or made, next to the
 * conversation. Anything in the app can show an item there:
 *
 *   openSidePanel({ kind: "computer", agentId });            // the person asked: opens
 *   openSidePanel({ kind: "media", uploadId, mediaType }, { auto: true }); // the AI started it
 *   closeSidePanel();
 *
 * The chat mounts <SidePanelLayout> around itself and <SidePanelToggle> in its
 * topbar. See docs/side-panel.md.
 */
export { openSidePanel, closeSidePanel, SIDE_PANEL_EVENT, SIDE_PANEL_AUTO_EVENT, type SidePanelItem } from "./events";
export { SidePanelLayout, SidePanelToggle } from "./SidePanel";
export { sidePanelSources, type SidePanelSources } from "./sources";
export { useSidePanelStore } from "./store";
