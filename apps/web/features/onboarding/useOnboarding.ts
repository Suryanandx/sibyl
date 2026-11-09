"use client";

/**
 * The person's onboarding state (steps, profile, checklist), loaded once per
 * page and shared by the /welcome screens, the rail's Getting started
 * checklist and the app shell's redirect. Same pattern as lib/app-session.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { OnboardingPatch, OnboardingView } from "@open-gpt-live/protocol";
import { fetchOnboarding, patchOnboarding } from "./api";

interface State {
  status: "idle" | "loading" | "ready" | "error";
  view: OnboardingView | null;
}

let state: State = { status: "idle", view: null };
const serverState: State = { status: "idle", view: null };
const listeners = new Set<() => void>();
let inFlight: Promise<OnboardingView | null> | null = null;

function setState(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** (Re)load onboarding from the gateway; null when it isn't available (signed out, older gateway). */
export function refreshOnboarding(): Promise<OnboardingView | null> {
  if (inFlight) return inFlight;
  if (state.status === "idle") setState({ status: "loading" });
  inFlight = fetchOnboarding()
    .then((view) => {
      setState({ status: "ready", view });
      return view;
    })
    .catch(() => {
      setState({ status: "error" });
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Apply a change and keep the shared view in sync. */
export async function updateOnboarding(patch: OnboardingPatch): Promise<OnboardingView> {
  const view = await patchOnboarding(patch);
  setState({ status: "ready", view });
  return view;
}

/** Replace the shared view with an answer the caller already has (e.g. after saving the profile). */
export function setOnboardingView(view: OnboardingView): void {
  setState({ status: "ready", view });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOnboarding(options: { load?: boolean } = {}): State {
  const current = useSyncExternalStore(subscribe, () => state, () => serverState);
  const load = options.load ?? true;
  useEffect(() => {
    if (load && state.status === "idle") void refreshOnboarding();
  }, [load]);
  return current;
}
