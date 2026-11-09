"use client";

/**
 * Browser session glue for Sibyl Slides (runs once, before any component
 * fetches):
 *
 * - Root-relative engine/app URLs ("/api/...", "/app_data/...", "/static/...")
 *   are moved under the /slides base path, for fetch() and EventSource.
 * - The Sibyl owner token (localStorage "sibyl.ownerToken", the same key the
 *   Sibyl chat sign-in uses) is sent as `Authorization: Bearer` on same-origin
 *   requests and mirrored into the `sibyl_slides_token` cookie (path /slides)
 *   so images, EventSource and page loads are authorized too.
 *
 * Copyright Sibyl contributors. Licensed under the Apache License, Version 2.0.
 */
import { BASE_PATH, hasBasePath } from "@/utils/basePath";

export const OWNER_TOKEN_KEY = "sibyl.ownerToken";
export const OWNER_TOKEN_COOKIE = "sibyl_slides_token";
export const THEME_KEY = "sibyl.theme";

const ENGINE_PATH = /^\/(?:api|app_data|static)(?:\/|$)/;

export function readOwnerToken(): string | null {
  try {
    return window.localStorage.getItem(OWNER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeOwnerToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(OWNER_TOKEN_KEY, token);
    else window.localStorage.removeItem(OWNER_TOKEN_KEY);
  } catch {
    // Storage blocked: the cookie still carries the token for this session.
  }
  syncOwnerCookie(token);
}

export function syncOwnerCookie(token: string | null = readOwnerToken()): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  const path = BASE_PATH || "/";
  // Tokens are sent verbatim (no URL-encoding) so the engine reads the same
  // value; a token with cookie-unsafe characters works via the header only.
  const cookieSafe = token && /^[\x21-\x7E]+$/.test(token) && !/[;,"\\]/.test(token);
  document.cookie = cookieSafe
    ? `${OWNER_TOKEN_COOKIE}=${token}; Path=${path}; SameSite=Strict; Max-Age=31536000${secure}`
    : `${OWNER_TOKEN_COOKIE}=; Path=${path}; SameSite=Strict; Max-Age=0${secure}`;
}

function rebasePath(path: string): string {
  if (!BASE_PATH || hasBasePath(path) || !ENGINE_PATH.test(path)) return path;
  return `${BASE_PATH}${path}`;
}

/** Returns the rebased URL string, or null when the URL is not same-origin. */
function rebaseUrl(raw: string): { url: string; sameOrigin: boolean } {
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return { url: rebasePath(raw), sameOrigin: true };
  }
  try {
    const parsed = new URL(raw, window.location.href);
    if (parsed.origin !== window.location.origin) return { url: raw, sameOrigin: false };
    const rebased = rebasePath(parsed.pathname);
    return { url: `${parsed.origin}${rebased}${parsed.search}${parsed.hash}`, sameOrigin: true };
  } catch {
    return { url: raw, sameOrigin: false };
  }
}

declare global {
  interface Window {
    __sibylSlidesSession?: boolean;
  }
}

function install(): void {
  if (window.__sibylSlidesSession) return;
  window.__sibylSlidesSession = true;

  syncOwnerCookie();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const { url, sameOrigin } = rebaseUrl(raw);
    const token = sameOrigin ? readOwnerToken() : null;

    if (input instanceof Request) {
      const request = url === raw ? input : new Request(url, input);
      if (token && !request.headers.has("authorization")) {
        request.headers.set("authorization", `Bearer ${token}`);
      }
      return nativeFetch(request, init);
    }

    if (token) {
      const headers = new Headers(init?.headers);
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      return nativeFetch(url, { ...init, headers });
    }
    return nativeFetch(url, init);
  };

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    class RebasedEventSource extends NativeEventSource {
      constructor(target: string | URL, options?: EventSourceInit) {
        super(rebaseUrl(target.toString()).url, options);
      }
    }
    window.EventSource = RebasedEventSource as typeof EventSource;
  }
}

if (typeof window !== "undefined") install();

export function installSibylSession(): void {
  if (typeof window !== "undefined") install();
}
