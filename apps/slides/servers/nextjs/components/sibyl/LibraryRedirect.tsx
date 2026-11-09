"use client";

import { useEffect } from "react";
import { SibylWaiting } from "./SibylLoader";

/** Replace the current entry with the Sibyl app's deck library. */
export function LibraryRedirect({ appUrl }: { appUrl: string }) {
  useEffect(() => {
    let base = "";
    try {
      if (appUrl && new URL(appUrl).origin !== window.location.origin) {
        base = appUrl.replace(/\/+$/, "");
      }
    } catch {
      base = "";
    }
    window.location.replace(`${base}/library/slides`);
  }, [appUrl]);
  return (
    <div className="flex min-h-full items-center justify-center p-10">
      <SibylWaiting message="Opening your decks…" />
    </div>
  );
}
