/**
 * Sibyl single-owner auth for the Slides web server.
 *
 * When SIBYL_OWNER_TOKEN is set, every page and API route requires it. The
 * browser keeps the token in localStorage ("sibyl.ownerToken", shared with the
 * Sibyl chat app on the same origin) and sends it as `Authorization: Bearer`;
 * a `sibyl_slides_token` cookie (path /slides) carries it for page loads,
 * <img>, EventSource and the export browser, which cannot set headers.
 *
 * Copyright Sibyl contributors. Licensed under the Apache License, Version 2.0.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const OWNER_TOKEN_COOKIE = "sibyl_slides_token";

export function ownerToken(): string {
  return process.env.SIBYL_OWNER_TOKEN?.trim() ?? "";
}

export function ownerLoginRequired(): boolean {
  return ownerToken().length > 0;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison (fixed-length digests: no content or length leak). */
export function ownerTokenMatches(provided: string | null | undefined): boolean {
  const expected = ownerToken();
  if (!expected) return true;
  return timingSafeEqual(digest(expected), digest(provided ?? ""));
}

export function tokenFromRequestParts(
  authorization: string | null | undefined,
  cookieValue: string | null | undefined
): string | null {
  const auth = authorization?.trim() ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return cookieValue?.trim() || null;
}
