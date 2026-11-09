"use client";

/**
 * The Sibyl app shell around the Slides editor: the same left rail as the
 * Sibyl chat (apps/web), a slim top bar with the way back to the deck library
 * (/library/slides), and the shared light/dark preference ("sibyl.theme").
 *
 * Rail entries point at the main app's routes (outside the /slides base path),
 * so they are plain <a> links.
 */
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { THEME_KEY } from "./session";
import { withBasePath } from "@/utils/basePath";

export const LIBRARY_PATH = "/library/slides";

// Routes owned by the Sibyl app (see apps/slides/API.md, "Routing contract"),
// in the same order as the app's own rail.
export const RAIL: Array<{ href: string; label: string; icon: IconName; active?: boolean }> = [
  { href: "/", label: "Chat", icon: "chat" },
  { href: "/?panel=history", label: "History", icon: "history" },
  { href: LIBRARY_PATH, label: "Slides", icon: "slides", active: true },
  { href: "/routines", label: "Routines", icon: "routines" },
  { href: "/inbox", label: "Inbox", icon: "inbox" },
  { href: "/integrations", label: "Integrations", icon: "connections" },
  { href: "/settings", label: "Settings", icon: "sliders" },
];

/**
 * Base for links to the Sibyl app. Relative (same origin) when the editor is
 * reached through the app's /slides proxy; the absolute SIBYL_APP_URL when it
 * is opened directly on the engine's own origin.
 */
function useAppBase(appUrl: string): string {
  const [base, setBase] = useState("");
  useEffect(() => {
    if (!appUrl) return;
    try {
      const app = new URL(appUrl);
      if (app.origin !== window.location.origin) {
        const next = app.origin + app.pathname.replace(/\/+$/, "");
        window.__sibylAppBase = next;
        setBase(next);
      }
    } catch {
      // Invalid SIBYL_APP_URL: keep relative links.
    }
  }, [appUrl]);
  return base;
}

/** /library/slides, keeping the deck's space when the editor URL carries one. */
function useLibraryHref(base: string): string {
  const [space, setSpace] = useState<string | null>(null);
  useEffect(() => {
    setSpace(new URLSearchParams(window.location.search).get("space"));
  }, []);
  const query = space ? "?space=" + encodeURIComponent(space) : "";
  return base + LIBRARY_PATH + query;
}

/** Routes rendered without chrome (export renderer, embedded previews). */
const BARE_ROUTES = ["/pdf-maker", "/template-preview"];

type Theme = "light" | "dark";

export function SibylShell({ children, appUrl = "" }: { children: ReactNode; appUrl?: string }) {
  const pathname = usePathname() || "/";
  const appBase = useAppBase(appUrl);
  const libraryHref = useLibraryHref(appBase);
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    // Follow theme changes made in another Sibyl tab.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY) return;
      const next: Theme =
        event.newValue === "dark" || event.newValue === "light"
          ? event.newValue
          : matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (BARE_ROUTES.some((route) => pathname.startsWith(route))) return <>{children}</>;

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
    setTheme(next);
  };

  return (
    <div className="sibylApp">
      <nav className="rail" aria-label="Sibyl">
        <a className="railLogo" href={appBase + "/"} aria-label="Sibyl — chat" title="Sibyl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBasePath("/brand/sibyl-mark.png")} alt="" width={24} height={24} />
        </a>
        {RAIL.map((item) => (
          <a
            key={item.label}
            href={item.href === LIBRARY_PATH ? libraryHref : appBase + item.href}
            className={`railBtn${item.active ? " active" : ""}`}
            aria-label={item.label}
            title={item.label}
            aria-current={item.active ? "page" : undefined}
          >
            <Icon name={item.icon} />
          </a>
        ))}
        <span className="railSpacer" />
        <button
          type="button"
          className="railBtn"
          aria-label="Switch theme"
          title="Switch theme"
          onClick={toggleTheme}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </nav>
      <div className="sibylMain">
        <header className="sibylTopBar">
          <a className="sibylGhostBtn sibylBack" href={libraryHref} title="Back to your decks">
            <Icon name="back" size={16} />
            <span>Slides</span>
          </a>
          <a className="sibylMobileMark" href={appBase + "/"} aria-label="Sibyl — chat">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withBasePath("/brand/sibyl-mark.png")} alt="" width={20} height={20} />
          </a>
          <span className="sibylTopSpacer" />
          <button
            type="button"
            className="sibylIconBtn sibylMobileOnly"
            onClick={toggleTheme}
            aria-label="Switch theme"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
          </button>
        </header>
        <div className="sibylContent">{children}</div>
      </div>
    </div>
  );
}
