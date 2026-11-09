"use client";

/**
 * The app shell's onboarding redirect (components/AppFrame.tsx):
 * - a fresh self-hosted install without accounts goes to /setup once, to
 *   create the owner account (or continue without one, into onboarding);
 * - someone who started onboarding and didn't finish goes back to their step
 *   once per browser session (after that the checklist offers "Continue setup").
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthState } from "../../lib/app-session";
import { welcomePath } from "./flow";
import { useOnboarding } from "./useOnboarding";

const SETUP_OFFERED = "sibyl.onboarding.setupOffered";
const RESUMED = "sibyl.onboarding.resumed";

/** sessionStorage flag: true the first time it is taken in this browser session. */
function once(key: string): boolean {
  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

/** The person is in onboarding in this session: leaving it (Finish later, a "Set up" link) must not bounce them back. */
export function markOnboardingVisited(): void {
  once(RESUMED);
  once(SETUP_OFFERED);
}

export function useOnboardingGate(enabled: boolean): void {
  const router = useRouter();
  const { me } = useAuthState();
  const signedIn = Boolean(me?.authenticated) && me?.principal !== "token";
  const { view } = useOnboarding({ load: enabled && signedIn });

  useEffect(() => {
    if (!enabled || !me?.authenticated || !view) return;
    if (view.fresh && me.principal === "local" && me.setupAvailable) {
      if (once(SETUP_OFFERED)) window.location.replace("/setup");
      return;
    }
    if (view.pending && once(RESUMED)) router.replace(welcomePath(view.current));
  }, [enabled, me, view, router]);
}
