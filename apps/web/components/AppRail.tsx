"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { InboxIcon } from "./Inbox";
import { RoutinesIcon } from "./RoutinesPanel";
import { SecretsIcon } from "./SecretsPanel";

/**
 * The one Sibyl rail, shared by every screen (chat, Slides library, …) so the
 * app always feels like one product. On the chat screen each item opens its
 * panel directly; elsewhere items link back to the chat with `/?open=<item>`.
 */
export type RailItem = "history" | "routines" | "inbox" | "connections" | "secrets" | "settings";

const THEME_KEY = "sibyl.theme";

export function AppRail({
  active,
  onOpen,
  onNewChat,
  onToggleTheme,
  themeMode,
  inboxCount = 0,
  openItem,
  status
}: {
  active: "chat" | "slides";
  /** Present on the chat screen: open a panel in place. */
  onOpen?: (item: RailItem) => void;
  onNewChat?: () => void;
  onToggleTheme?: () => void;
  themeMode?: "light" | "dark";
  inboxCount?: number;
  /** Panel currently open (highlighted). */
  openItem?: RailItem | null;
  /** Connection status slot at the bottom (chat screen). */
  status?: ReactNode;
}) {
  const [localTheme, setLocalTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    if (themeMode) return;
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    setLocalTheme(current);
  }, [themeMode]);
  const mode = themeMode ?? localTheme;

  const toggleTheme = () => {
    if (onToggleTheme) return onToggleTheme();
    const next = mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setLocalTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // ignore
    }
  };

  const item = (key: RailItem, label: string, icon: ReactNode, badge?: number) => {
    const className = `railBtn${badge !== undefined ? " inboxBtn" : ""}${openItem === key ? " active" : ""}`;
    const content = (
      <>
        {icon}
        {badge ? <span className="inboxBadge" aria-hidden>{badge > 9 ? "9+" : badge}</span> : null}
      </>
    );
    return onOpen ? (
      <button type="button" className={className} aria-label={label} title={label} onClick={() => onOpen(key)}>
        {content}
      </button>
    ) : (
      <a className={className} href={`/?panel=${key}`} aria-label={label} title={label}>
        {content}
      </a>
    );
  };

  return (
    <nav className="rail" aria-label="Sibyl">
      {onNewChat ? (
        <button type="button" className="railLogo" onClick={onNewChat} aria-label="Sibyl — new chat" title="Sibyl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/sibyl-mark.png" alt="" width={24} height={24} />
        </button>
      ) : (
        <a className="railLogo" href="/" aria-label="Sibyl — chat" title="Sibyl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/sibyl-mark.png" alt="" width={24} height={24} />
        </a>
      )}
      <a
        className={`railBtn${active === "chat" && !openItem ? " active" : ""}`}
        href="/"
        aria-label="Chat"
        title="Chat"
        aria-current={active === "chat" ? "page" : undefined}
        onClick={(event) => {
          if (active === "chat") event.preventDefault();
        }}
      >
        <Icon name="chat" />
      </a>
      {item("history", "History", <Icon name="history" />)}
      <a
        className={`railBtn${active === "slides" ? " active" : ""}`}
        href="/library/slides"
        aria-label="Slides"
        title="Slides"
        aria-current={active === "slides" ? "page" : undefined}
      >
        <Icon name="slides" />
      </a>
      {item("routines", "Routines", <RoutinesIcon />)}
      {item("inbox", inboxCount > 0 ? `Inbox, ${inboxCount} waiting` : "Inbox", <InboxIcon />, inboxCount)}
      {item("connections", "Connections", <Icon name="plug" />)}
      {item("secrets", "Secrets", <SecretsIcon />)}
      {item("settings", "Models & voice", <Icon name="sliders" />)}
      <span className="railSpacer" />
      <button type="button" className="railBtn" aria-label="Switch theme" title="Switch theme" onClick={toggleTheme}>
        <Icon name={mode === "dark" ? "sun" : "moon"} />
      </button>
      {status}
    </nav>
  );
}
