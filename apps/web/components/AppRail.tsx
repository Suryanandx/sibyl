"use client";

import Link from "next/link";
import { Icon } from "./Icon";
import { InboxBell } from "./Inbox";
import { SibylLoader } from "./SibylLoader";
import { useShell } from "./AppFrame";
import { GettingStarted } from "../features/onboarding/GettingStarted";
import { useGateway } from "../lib/gateway";
import { useAppSession } from "../lib/app-session";
import { visibleNavGroups, type VisibleGroup } from "../lib/nav";
import type { Place } from "../lib/routes";
import styles from "./AppRail.module.css";

export interface RailEntry extends VisibleGroup {
  /** Accessible label and tooltip. */
  label: string;
}

/** The rail groups this person can use (the rail and the phone menu), in order. */
export function useRailEntries(): RailEntry[] {
  const shell = useShell();
  const session = useAppSession();
  return visibleNavGroups(session.can).map((group) => ({
    ...group,
    // Chat goes back to the conversation you were in.
    href: group.place === "chat" ? shell.chatPath : group.href,
    label: group.label ?? group.name
  }));
}

/**
 * The one Sibyl rail, shared by every screen so the app always feels like one
 * product: the Sibyl emblem (new chat), the inbox bell, the groups, then
 * Getting started, Settings, the theme and the connection at the bottom.
 */
export function AppRail({ place }: { place: Place }) {
  const shell = useShell();
  const gateway = useGateway();
  const entries = useRailEntries();
  const status = gateway.status;
  const link = (entry: RailEntry) => <RailLink key={entry.place} entry={entry} current={place === entry.place} />;

  return (
    <nav className="rail" aria-label="Sibyl">
      <Link className="railLogo" href="/" aria-label="Sibyl, new chat" title="Sibyl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/sibyl-mark.png" alt="" width={24} height={24} />
      </Link>
      <InboxBell className="railBtn" count={gateway.inboxCount} current={place === "inbox"} />
      <span className={styles.divider} aria-hidden />
      {entries.filter((entry) => entry.slot === "top").map(link)}
      {place === "chat" ? (
        <button
          type="button"
          className={`railBtn railHistory${shell.historyOpen ? " open" : ""}`}
          aria-label="Chat history"
          aria-expanded={shell.historyOpen}
          title="Chat history"
          onClick={() => shell.setHistoryOpen((open) => !open)}
        >
          <Icon name="history" />
        </button>
      ) : null}
      <span className="railSpacer" />
      <GettingStarted />
      {entries.filter((entry) => entry.slot === "bottom").map(link)}
      <button type="button" className="railBtn" aria-label="Switch theme" title="Switch theme" onClick={shell.toggleTheme}>
        <Icon name={shell.themeMode === "dark" ? "sun" : "moon"} />
      </button>
      <span
        className={`railStatus ${status}`}
        role="img"
        title={gateway.connected ? "Connected" : status === "reconnecting" ? "Reconnecting" : "Offline"}
        aria-label={gateway.connected ? "Connected" : status === "reconnecting" || status === "connecting" ? "Connecting" : "Offline"}
      >
        <SibylLoader size={16} state="idle" />
      </span>
    </nav>
  );
}

function RailLink({ entry, current }: { entry: RailEntry; current: boolean }) {
  return (
    <Link
      className={`railBtn${current ? " active" : ""}`}
      href={entry.href}
      aria-label={entry.label}
      title={entry.name}
      aria-current={current ? "true" : undefined}
    >
      <Icon name={entry.icon} />
    </Link>
  );
}

export function AdminIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6Z M9 12l2 2 4-4" />
    </svg>
  );
}
