"use client";

import { useEffect, useState } from "react";
import type { SignupOptionsView, SignupResult } from "@open-gpt-live/protocol";
import { refreshAppSession } from "../../lib/app-session";
import { signupApi } from "./api";

/** The server's ways in (null until loaded or when the gateway predates sign-up). */
export function useSignupOptions(): SignupOptionsView | null {
  const [options, setOptions] = useState<SignupOptionsView | null>(null);
  useEffect(() => {
    let live = true;
    signupApi
      .options()
      .then((value) => live && setOptions(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return options;
}

/** A verified sign-up or sign-in: name the organization, choose one, or go in. */
export async function goAfterSignup(result: SignupResult): Promise<void> {
  if (result.next === "org") return window.location.assign("/signup/org");
  if (result.next === "choose") return window.location.assign("/login?choose=1");
  await refreshAppSession();
  window.location.replace(result.path || "/");
}
