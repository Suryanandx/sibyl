"use client";

/**
 * The app frame: the one rail plus a content area, the same on every screen.
 *
 * Places are screens with their own address; the chat is special only in that
 * it stays mounted (hidden) while another screen is shown, so a voice turn, a
 * queued message or a streaming reply keeps going while you check Routines.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { ThemeProvider, useSystemThemeMode } from "@openuidev/react-ui";
import { AppRail } from "./AppRail";
import { NotificationToast } from "./Inbox";
import { SignIn } from "./SignIn";
import { VisualInspector } from "./VisualInspector";
import { ChatScreen } from "../screens/chat/ChatScreen";
import { useOnboardingGate } from "../features/onboarding/useOnboardingGate";
import { useGateway } from "../lib/gateway";
import { chatPath, isChatPath, legacyRedirect, placeOf } from "../lib/routes";
import { sibylDarkTheme, sibylLightTheme } from "../lib/sibyl-theme";

const THEME_KEY = "sibyl.theme";

export interface Shell {
  /** The chat's current address (/ or /c/<id>): where the Chat link goes. */
  chatPath: string;
  chatPathRef: MutableRefObject<string>;
  setChatPath(path: string): void;
  /** The chat history list (a drawer below desktop widths). */
  historyOpen: boolean;
  setHistoryOpen(open: boolean | ((open: boolean) => boolean)): void;
  themeMode: "light" | "dark";
  toggleTheme(): void;
}

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell() needs <AppShell>.");
  return shell;
}

/** Mounted by app/layout.tsx around every page. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const gateway = useGateway();
  const place = placeOf(pathname);

  // ── chat address ──
  const chatPathRef = useRef<string>("/");
  const [chatPathState, setChatPathState] = useState("/");
  const setChatPath = useCallback((path: string) => {
    if (chatPathRef.current === path) return;
    chatPathRef.current = path;
    setChatPathState(path);
  }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  // First render: remember the chat named in the address.
  const initialised = useRef(false);
  if (!initialised.current && typeof window !== "undefined") {
    initialised.current = true;
    if (isChatPath(window.location.pathname)) chatPathRef.current = window.location.pathname;
  }
  useEffect(() => {
    setChatPathState(chatPathRef.current);
  }, []);

  // ── old ?panel= links → screens ──
  useEffect(() => {
    const redirect = () => {
      const target = legacyRedirect(window.location);
      if (!target) return;
      if (target.conversationId) setChatPath(chatPath(target.conversationId));
      if (target.openHistory) setHistoryOpen(true);
      router.replace(target.to);
    };
    redirect();
    window.addEventListener("popstate", redirect);
    return () => window.removeEventListener("popstate", redirect);
  }, [pathname, router, setChatPath]);

  // Leaving the chat closes its history drawer.
  useEffect(() => {
    if (place !== "chat") setHistoryOpen(false);
  }, [place]);

  // ── theme: system by default, the user can pin light or dark ──
  const [themePref, setThemePref] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") setThemePref(stored);
    } catch {
      // ignore
    }
  }, []);
  const systemMode = useSystemThemeMode();
  const themeMode: "light" | "dark" = themePref === "system" ? systemMode : themePref;
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);
  const toggleTheme = useCallback(() => {
    const next = themeMode === "dark" ? "light" : "dark";
    setThemePref(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // ignore
    }
  }, [themeMode]);

  // First run and unfinished onboarding: /setup or /welcome/<step> (features/onboarding).
  useOnboardingGate(Boolean(place) && !gateway.signIn);

  const shell = useMemo<Shell>(
    () => ({
      chatPath: chatPathState,
      chatPathRef,
      setChatPath,
      historyOpen,
      setHistoryOpen,
      themeMode,
      toggleTheme
    }),
    [chatPathState, setChatPath, historyOpen, themeMode, toggleTheme]
  );

  // Not part of the frame (sign-in pages, not found): the page alone.
  if (!place) return <>{children}</>;

  if (gateway.signIn) {
    return <SignIn failed={gateway.signIn.failed} onSubmit={gateway.submitOwnerToken} />;
  }

  return (
    <ShellContext.Provider value={shell}>
      <ThemeProvider mode={themeMode} lightTheme={sibylLightTheme} darkTheme={sibylDarkTheme}>
        <div className="app">
          <a className="skipLink" href="#main">
            Skip to content
          </a>
          <AppRail place={place} />
          <ChatScreen active={place === "chat"} />
          {place !== "chat" ? <div className="screenSlot">{children}</div> : null}
          <NotificationToast notification={gateway.notifications.toast} onDismiss={gateway.notifications.dismissToast} onOpen={(href) => router.push(href)} />
          <VisualInspector />
        </div>
      </ThemeProvider>
    </ShellContext.Provider>
  );
}
