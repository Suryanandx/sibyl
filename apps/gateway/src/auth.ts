/**
 * Single-owner login: when SIBYL_OWNER_TOKEN is set, the WebSocket upgrade
 * must carry `?token=<value>`. Compared in constant time (both sides are
 * hashed first, so the lengths never leak either).
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function tokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://gateway.invalid").searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

export function tokensMatch(expected: string, provided: string | undefined): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  // Always compare, even when nothing was provided, so timing doesn't tell.
  const equal = timingSafeEqual(digest(expected), digest(provided ?? ""));
  return equal && provided !== undefined;
}

/** True when the upgrade request may open a session. */
export function isAuthorized(ownerToken: string | undefined, requestUrl: string | undefined): boolean {
  if (!ownerToken) return true;
  return tokensMatch(ownerToken, tokenFromUrl(requestUrl));
}
