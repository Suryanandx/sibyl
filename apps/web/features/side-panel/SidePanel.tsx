"use client";

/**
 * The chat's side panel: what the AI is doing or made, next to the
 * conversation (its computer, a deck, a visual, a file, a page it read).
 *
 *   <SidePanelLayout conversationId={id} sources={sidePanelSources(messages)} active={active}>
 *     <main>…the chat…</main>
 *   </SidePanelLayout>
 *
 * It listens for openSidePanel()/closeSidePanel() (window events) and for
 * what the AI starts on the shared socket (auto-open.ts), keeps an Activity
 * list per conversation, names the open item in the address (`?panel=`), and
 * becomes a full-screen sheet at 900px and below.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { usePathname } from "next/navigation";
import type { GenUiAction } from "../../components/GenUiView";
import { Icon, type IconName } from "../../components/Icon";
import { uploadBlobUrl } from "../../components/AttachmentClient";
import { useGateway } from "../../lib/gateway";
import { conversationIdOf, isChatPath, paths } from "../../lib/routes";
import { editorHref } from "../slides/api";
import { autoOpenAction, createAutoOpenMemory, type AutoOpenMessage } from "./auto-open";
import { SIDE_PANEL_AUTO_EVENT, SIDE_PANEL_EVENT, SIDE_PANEL_TOGGLE_EVENT, type SidePanelItem } from "./events";
import { Pane } from "./panes";
import { isBuilding, itemLabel, kindLabel } from "./preview";
import type { SidePanelSources } from "./sources";
import { activeEntry, clampWidth, entriesOf, MIN_WIDTH, type PanelEntry } from "./state";
import { useSidePanelStore } from "./store";
import styles from "./side-panel.module.css";

/** At this width and below the panel covers the chat (a sheet). */
export const SHEET_QUERY = "(max-width: 900px)";
/** Toggle shortcut: Ctrl+\ (⌘\ on a Mac). */
export const TOGGLE_SHORTCUT = "Control+\\ Meta+\\";
const PANEL_PARAM = "panel";
/** The chat keeps at least this much room next to the panel. */
const CHAT_MIN_WIDTH = 380;

const KIND_ICON: Record<SidePanelItem["kind"], IconName> = {
  computer: "screen",
  slides: "slides",
  visual: "layers",
  file: "notes",
  media: "play",
  url: "link"
};

interface LayoutProps {
  conversationId: string | null;
  sources: SidePanelSources;
  /** The chat screen is the one on show (it stays mounted while hidden). */
  active: boolean;
  onVisualAction?: (action: GenUiAction) => void;
  children: ReactNode;
}

/** The chat plus its side panel. */
export function SidePanelLayout({ conversationId, sources, active, onVisualAction, children }: LayoutProps) {
  const state = useSidePanelStore();
  const { dispatch } = state;
  const sheet = useMediaQuery(SHEET_QUERY);
  const pathname = usePathname() ?? "/";
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusOnOpenRef = useRef(false);
  /** How the next state change is written to the address: a new history entry, or in place. */
  const historyModeRef = useRef<"push" | "replace">("replace");
  /** The `?panel=` the page was opened with, until its chat is on screen. */
  const urlKeyRef = useRef<string | null | undefined>(undefined);
  const [urlReady, setUrlReady] = useState(false);

  useEffect(() => state.hydrate(), [state.hydrate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each conversation has its own Activity list.
  useEffect(() => {
    dispatch({ type: "conversation", id: conversationId });
  }, [conversationId, dispatch]);

  /* ── opening and closing ── */

  const rememberFocus = useCallback(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !panelRef.current?.contains(focused)) returnFocusRef.current = focused;
  }, []);

  const close = useCallback(
    (user: boolean) => {
      const hadFocus = panelRef.current?.contains(document.activeElement) ?? false;
      historyModeRef.current = "replace";
      dispatch({ type: "close", user });
      if (hadFocus) {
        const back = returnFocusRef.current;
        returnFocusRef.current = null;
        requestAnimationFrame(() => (back?.isConnected ? back : document.querySelector<HTMLElement>(".composer textarea"))?.focus());
      }
    },
    [dispatch]
  );

  useEffect(() => {
    const onOpen = (event: Event) => {
      const item = (event as CustomEvent<SidePanelItem | null>).detail;
      if (!item) return close(true);
      rememberFocus();
      focusOnOpenRef.current = true;
      historyModeRef.current = "push";
      dispatch({ type: "open", item, at: Date.now() });
    };
    const onAuto = (event: Event) => {
      const item = (event as CustomEvent<SidePanelItem>).detail;
      if (!item) return;
      historyModeRef.current = "replace";
      dispatch({ type: "open", item, auto: true, at: Date.now() });
    };
    window.addEventListener(SIDE_PANEL_EVENT, onOpen);
    window.addEventListener(SIDE_PANEL_AUTO_EVENT, onAuto);
    return () => {
      window.removeEventListener(SIDE_PANEL_EVENT, onOpen);
      window.removeEventListener(SIDE_PANEL_AUTO_EVENT, onAuto);
    };
  }, [close, dispatch, rememberFocus]);

  // What the AI starts on the shared socket.
  const { subscribe } = useGateway();
  const memory = useMemo(createAutoOpenMemory, []);
  useEffect(
    () =>
      subscribe((message) => {
        const action = autoOpenAction(message as AutoOpenMessage, memory, Date.now());
        if (!action) return;
        historyModeRef.current = "replace";
        dispatch(action);
      }),
    [subscribe, memory, dispatch]
  );

  const toggle = useCallback(() => {
    if (useSidePanelStore.getState().open) return close(true);
    rememberFocus();
    focusOnOpenRef.current = true;
    historyModeRef.current = "push";
    dispatch({ type: "toggle" });
  }, [close, dispatch, rememberFocus]);

  useEffect(() => {
    window.addEventListener(SIDE_PANEL_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(SIDE_PANEL_TOGGLE_EVENT, toggle);
  }, [toggle]);

  // Keyboard: Ctrl/⌘+\ toggles; Esc closes (from inside the panel, or the sheet).
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "\\" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        toggle();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented || !useSidePanelStore.getState().open) return;
      const inside = panelRef.current?.contains(document.activeElement) ?? false;
      // An open popup inside a visual (select, date picker) closes first.
      if (!inside && !sheet) return;
      if (document.querySelector("[role=dialog][aria-modal=true]:not([data-side-panel])")) return;
      event.preventDefault();
      close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close, sheet, toggle]);

  /* ── the address: ?panel=<kind>:<id> ── */

  const entries = entriesOf(state);
  const entry = state.open ? activeEntry(state) : null;
  const shownKey = entry?.key ?? null;

  // The address the page opened with names an item: show it once its chat is on screen.
  useEffect(() => {
    if (!state.loaded || urlReady) return;
    if (urlKeyRef.current === undefined) urlKeyRef.current = new URLSearchParams(window.location.search).get(PANEL_PARAM);
    const key = urlKeyRef.current;
    if (!key || !key.includes(":")) return setUrlReady(true);
    if ((conversationIdOf(window.location.pathname) ?? null) !== (conversationId ?? null)) return;
    historyModeRef.current = "replace";
    dispatch({ type: "show", key, at: Date.now() });
    setUrlReady(true);
  }, [state.loaded, urlReady, conversationId, dispatch]);

  // Panel → address.
  useEffect(() => {
    if (!urlReady || !active || !isChatPath(window.location.pathname)) return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get(PANEL_PARAM);
    if ((current ?? null) === shownKey || (current && !current.includes(":") && !shownKey)) return;
    if (shownKey) url.searchParams.set(PANEL_PARAM, shownKey);
    else url.searchParams.delete(PANEL_PARAM);
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (historyModeRef.current === "push" && shownKey) window.history.pushState(window.history.state, "", next);
    else window.history.replaceState(window.history.state, "", next);
    historyModeRef.current = "replace";
  }, [urlReady, active, shownKey, pathname, conversationId]);

  // Address → panel (Back / Forward).
  useEffect(() => {
    if (!active) return;
    const onPop = () => {
      const key = new URLSearchParams(window.location.search).get(PANEL_PARAM);
      historyModeRef.current = "replace";
      if (key?.includes(":")) dispatch({ type: "show", key, at: Date.now() });
      else if (useSidePanelStore.getState().open) dispatch({ type: "close", user: false });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [active, dispatch]);

  /* ── focus ── */

  useLayoutEffect(() => {
    if (!entry || !focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [entry]);

  /* ── width ── */

  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? state.width;
  const style = { "--side-panel-width": `${width}px` } as CSSProperties;

  if (!active) return <div className={styles.workspace}>{children}</div>;

  return (
    <div className={styles.workspace} style={style} data-panel-open={entry && !sheet ? "" : undefined}>
      {children}
      {entry ? (
        <PanelFrame
          ref={panelRef}
          headingRef={headingRef}
          entry={entry}
          entries={entries}
          sheet={sheet}
          width={width}
          sources={sources}
          onVisualAction={onVisualAction}
          onSelect={(key) => {
            historyModeRef.current = "replace";
            dispatch({ type: "select", key });
          }}
          onClose={() => close(true)}
          onResize={setDragWidth}
          onResizeEnd={(value) => {
            setDragWidth(null);
            dispatch({ type: "width", width: value });
          }}
        />
      ) : null}
    </div>
  );
}

interface FrameProps {
  entry: PanelEntry;
  entries: PanelEntry[];
  sheet: boolean;
  width: number;
  sources: SidePanelSources;
  headingRef: React.RefObject<HTMLHeadingElement>;
  onVisualAction?: (action: GenUiAction) => void;
  onSelect(key: string): void;
  onClose(): void;
  onResize(width: number): void;
  onResizeEnd(width: number): void;
}

const PanelFrame = forwardRef<HTMLElement, FrameProps>(function PanelFrame(
  { entry, entries, sheet, width, sources, headingRef, onVisualAction, onSelect, onClose, onResize, onResizeEnd },
  ref
) {
  const headingId = useId();
  const { agents } = useGateway();
  const agentName = entry.item.kind === "computer" ? agents.agents.find((agent) => agent.id === (entry.item as { agentId: string }).agentId)?.name : undefined;
  const nameOf = (candidate: PanelEntry) =>
    itemLabel(candidate.item, candidate.item.kind === "computer" ? agents.agents.find((agent) => agent.id === (candidate.item as { agentId: string }).agentId)?.name : undefined);
  const title = itemLabel(entry.item, agentName);

  // The chat keeps CHAT_MIN_WIDTH; the panel never passes MAX_WIDTH.
  const maxWidth = () => clampWidth(window.innerWidth - CHAT_MIN_WIDTH);
  const resizeTo = (value: number) => Math.min(maxWidth(), clampWidth(value));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = (handle.parentElement as HTMLElement).getBoundingClientRect().right;
    let latest = width;
    const move = (moveEvent: PointerEvent) => {
      latest = resizeTo(right - moveEvent.clientX);
      onResize(latest);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onResizeEnd(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onHandleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 24;
    const next =
      event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth() : null;
    if (next === null) return;
    event.preventDefault();
    onResizeEnd(resizeTo(next));
  };

  // The sheet is modal: Tab stays inside it.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!sheet || event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea, iframe, [tabindex]:not([tabindex='-1'])")].filter(
      (element) => element.offsetParent !== null
    );
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <aside
      ref={ref}
      id="side-panel"
      className={`${styles.panel}${sheet ? ` ${styles.sheet}` : ""}`}
      aria-labelledby={headingId}
      {...(sheet ? { role: "dialog", "aria-modal": true, "data-side-panel": "" } : { role: "complementary" })}
      onKeyDown={onKeyDown}
    >
      {!sheet ? (
        <div
          className={styles.handle}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the side panel"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={typeof window === "undefined" ? undefined : maxWidth()}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onHandleKey}
        />
      ) : null}
      <header className={styles.header}>
        <span className={styles.headerIcon} aria-hidden>
          <Icon name={KIND_ICON[entry.item.kind]} size={16} />
        </span>
        <div className={styles.headerText}>
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.title} title={title}>
            {title}
          </h2>
          <span className={styles.kind}>{isBuilding(entry) ? "Working…" : kindLabel(entry.item)}</span>
        </div>
        <FullPageButton entry={entry} sources={sources} />
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close the side panel" title="Close (Esc)">
          <Icon name="close" size={16} />
        </button>
      </header>
      {entries.length > 1 ? <ActivityTabs entries={entries} activeKey={entry.key} nameOf={nameOf} onSelect={onSelect} /> : null}
      <div className={styles.body} role="region" aria-label={title} id="side-panel-body">
        <Pane key={entry.key} entry={entry} sources={sources} onVisualAction={onVisualAction} />
      </div>
    </aside>
  );
});

/** The Activity list: everything shown in this conversation, one tab each. */
function ActivityTabs({
  entries,
  activeKey,
  nameOf,
  onSelect
}: {
  entries: PanelEntry[];
  activeKey: string;
  nameOf(entry: PanelEntry): string;
  onSelect(key: string): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Newest first.
  const ordered = [...entries].reverse();
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = ordered.findIndex((entry) => entry.key === activeKey);
    const next =
      event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? ordered.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = ordered[(next + ordered.length) % ordered.length]!;
    onSelect(target.key);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(target.key)}"]`)?.focus());
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label="Activity in this chat" ref={listRef} onKeyDown={onKeyDown}>
      {ordered.map((entry) => {
        const selected = entry.key === activeKey;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            data-key={entry.key}
            aria-selected={selected}
            aria-controls="side-panel-body"
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => onSelect(entry.key)}
            title={`${kindLabel(entry.item)}: ${nameOf(entry)}`}
          >
            <Icon name={KIND_ICON[entry.item.kind]} size={13} />
            <span>{nameOf(entry)}</span>
            {isBuilding(entry) ? <i className={styles.dot} aria-label="working" /> : null}
            {entry.status === "failed" ? <i className={`${styles.dot} ${styles.failed}`} aria-label="failed" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** "Open in full page": the item's own screen, the editor, the file or the site in a new tab. */
function FullPageButton({ entry, sources }: { entry: PanelEntry; sources: SidePanelSources }) {
  const item = entry.item;
  let href: string | undefined;
  let newTab = false;
  if (isBuilding(entry) || entry.status === "failed") return null;
  if (item.kind === "computer") href = paths.agentComputer(item.agentId);
  else if (item.kind === "slides") {
    const artifact = sources.decks[item.artifactId] ?? entry.artifact;
    href = (artifact && editorHref(artifact)) || paths.slides;
    newTab = Boolean(artifact?.editUrl);
  } else if (item.kind === "url") {
    href = item.url;
    newTab = true;
  }
  if (item.kind === "file" || item.kind === "media") {
    const open = () => void uploadBlobUrl(item.uploadId).then((url) => window.open(url, "_blank", "noopener"), () => undefined);
    return (
      <button type="button" className={styles.iconButton} onClick={open} aria-label="Open in a new tab" title="Open in a new tab">
        <Icon name="share" size={16} />
      </button>
    );
  }
  if (!href) return null;
  return (
    <a
      className={styles.iconButton}
      href={href}
      aria-label={newTab ? "Open in a new tab" : "Open in full page"}
      title={newTab ? "Open in a new tab" : "Open in full page"}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      <Icon name="share" size={16} />
    </a>
  );
}

/** The topbar button: shows how many things are in this chat's Activity list and toggles the panel. */
export function SidePanelToggle({ className }: { className?: string }) {
  const state = useSidePanelStore();
  const count = entriesOf(state).length;
  if (!count) return null;
  return (
    <button
      type="button"
      className={className}
      aria-pressed={state.open}
      aria-controls={state.open ? "side-panel" : undefined}
      aria-keyshortcuts={TOGGLE_SHORTCUT}
      title={`${state.open ? "Hide" : "Show"} activity (Ctrl+\\ or ⌘\\)`}
      onClick={() => window.dispatchEvent(new Event(SIDE_PANEL_TOGGLE_EVENT))}
    >
      <Icon name="activity" size={16} />
      <span className="hideSm">Activity</span>
      <span className={styles.count}>{count}</span>
    </button>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
