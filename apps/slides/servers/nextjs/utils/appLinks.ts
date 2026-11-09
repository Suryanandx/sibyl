/**
 * Links to the Sibyl app (outside the /slides base path). The shell records
 * the app base (empty = same origin; SIBYL_APP_URL when the editor is opened
 * directly on the engine origin) in window.__sibylAppBase.
 */
declare global {
  interface Window {
    __sibylAppBase?: string;
  }
}

export function appHref(path: string): string {
  const base = typeof window !== "undefined" ? window.__sibylAppBase ?? "" : "";
  return `${base}${path}`;
}

export function goToLibrary(): void {
  const space =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("space") : null;
  window.location.assign(appHref(`/library/slides${space ? `?space=${encodeURIComponent(space)}` : ""}`));
}
