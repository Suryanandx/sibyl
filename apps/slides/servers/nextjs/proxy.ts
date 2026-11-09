import { NextRequest, NextResponse } from "next/server";
import {
  OWNER_TOKEN_COOKIE,
  ownerLoginRequired,
  ownerTokenMatches,
  tokenFromRequestParts,
} from "@/lib/sibyl-owner-auth";

/**
 * Sibyl Slides request proxy (Next.js middleware).
 *
 * - Backend paths (/slides/api/v1|v2, /slides/app_data, /slides/static) are
 *   rewritten to the FastAPI engine on loopback.
 * - When SIBYL_OWNER_TOKEN is set, every API and asset request needs the
 *   owner token (Bearer header or the sibyl_slides_token cookie). Pages are
 *   gated in the root layout, which shows the Sibyl sign-in instead.
 *
 * `request.nextUrl.pathname` is relative to the /slides basePath.
 */
function getFastApiBaseUrl(): string {
  const internal = process.env.FAST_API_INTERNAL_URL?.trim();
  if (internal) return internal.replace(/\/+$/, "");
  return "http://127.0.0.1:8000";
}

function isFastApiApiPath(pathname: string): boolean {
  return (
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/") ||
    pathname === "/api/v2" ||
    pathname.startsWith("/api/v2/")
  );
}

function isFastApiAssetPath(pathname: string): boolean {
  return (
    pathname === "/app_data" ||
    pathname.startsWith("/app_data/") ||
    pathname === "/static" ||
    pathname.startsWith("/static/")
  );
}

function rewriteToFastApi(request: NextRequest): NextResponse {
  const destination = new URL(
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
    `${getFastApiBaseUrl()}/`
  );
  return NextResponse.rewrite(destination);
}

function hasOwnerToken(request: NextRequest): boolean {
  const provided = tokenFromRequestParts(
    request.headers.get("authorization"),
    request.cookies.get(OWNER_TOKEN_COOKIE)?.value
  );
  return Boolean(provided) && ownerTokenMatches(provided);
}

/**
 * Slides is part of the Sibyl app: the deck library lives in the main app at
 * /library/slides. The engine UI only serves the editor/viewer (plus the
 * internal export renderer and template previews); every other upstream
 * screen (home, dashboard, settings, upload wizard, ...) redirects there.
 */
const LIBRARY_PATH = "/library/slides";
const ENGINE_PAGES = ["/presentation", "/pdf-maker", "/template-preview"];

function isEnginePage(pathname: string): boolean {
  return ENGINE_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

/**
 * 307 to the Sibyl app's deck library. Through the app's /slides proxy the
 * browser's origin comes from X-Forwarded-Host; opened directly on the engine
 * origin it is SIBYL_APP_URL (default: the request's own origin).
 */
function libraryUrl(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0].trim();
  if (forwardedHost && forwardedHost !== request.headers.get("host")) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
      request.nextUrl.protocol.replace(":", "");
    return `${proto}://${forwardedHost}${LIBRARY_PATH}`;
  }
  const appUrl = process.env.SIBYL_APP_URL?.trim().replace(/\/+$/, "");
  if (appUrl) return `${appUrl}${LIBRARY_PATH}`;
  return `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}${LIBRARY_PATH}`;
}

function redirectToLibrary(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(libraryUrl(request), 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function isPublicFile(pathname: string): boolean {
  return /\.[a-z0-9]{2,6}$/i.test(pathname) || pathname.startsWith("/_next/");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isBackend = isFastApiApiPath(pathname) || isFastApiAssetPath(pathname);
  const isApi = pathname.startsWith("/api/");

  if (!isBackend && !isApi) {
    if (isEnginePage(pathname) || isPublicFile(pathname)) {
      return NextResponse.next();
    }
    return redirectToLibrary(request);
  }

  const publicHealth = pathname === "/api/v1/sibyl/health";
  if (
    ownerLoginRequired() &&
    request.method !== "OPTIONS" &&
    !publicHealth &&
    !hasOwnerToken(request)
  ) {
    return NextResponse.json(
      { detail: "Sibyl owner token required", ownerLogin: true },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  return isBackend ? rewriteToFastApi(request) : NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
