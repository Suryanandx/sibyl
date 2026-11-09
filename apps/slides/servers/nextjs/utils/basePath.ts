/**
 * Sibyl Slides is served under /slides on the Sibyl origin. Next.js adds the
 * base path to <Link>, router navigation and /_next assets automatically, but
 * not to plain URLs (fetch, <img src>, CSS url(), window.location). Use
 * withBasePath() for those.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "/slides";

/** Paths served by the app or the engine that must live under the base path. */
const PREFIXABLE = /^\/(?:api|app_data|static|vendor|brand|_next)(?:\/|$)/;

export function hasBasePath(path: string): boolean {
  return !BASE_PATH || path === BASE_PATH || path.startsWith(`${BASE_PATH}/`);
}

/** Prefix a root-relative path with the base path (idempotent). */
export function withBasePath(path: string): string {
  if (!BASE_PATH || !path.startsWith("/") || path.startsWith("//")) return path;
  if (hasBasePath(path)) return path;
  return `${BASE_PATH}${path}`;
}

/** Like withBasePath, but only for app/engine paths (api, assets, vendor). */
export function withBasePathIfAppPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || hasBasePath(path)) return path;
  if (PREFIXABLE.test(path) || /\.[a-z0-9]{2,5}(?:[?#]|$)/i.test(path)) {
    return `${BASE_PATH}${path}`;
  }
  return path;
}
