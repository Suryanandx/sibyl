import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const DESKTOP_COOKIE_NAME = "presenton_desktop_session";
export const DESKTOP_TOKEN_HEADER = "x-presenton-desktop-token";

export function desktopCookieHeader(): string | undefined {
  const token = process.env.PRESENTON_DESKTOP_TOKEN;
  return process.env.PRESENTON_ELECTRON === "true" && token
    ? `${DESKTOP_COOKIE_NAME}=${token}`
    : undefined;
}

export function desktopRequestDenied(request: Request): NextResponse | null {
  if (process.env.PRESENTON_ELECTRON !== "true") return null;
  const token = process.env.PRESENTON_DESKTOP_TOKEN || "";
  // Server-only environment: NEXT_PUBLIC_* values can be inlined at build
  // time, while Electron allocates its ports afresh at runtime.
  const origins = (process.env.PRESENTON_DESKTOP_ORIGINS || "").split(",").filter(Boolean);
  let hosts: string[];
  try {
    hosts = origins.map((origin) => new URL(origin).host);
  } catch {
    hosts = [];
  }
  if (token.length < 32 || hosts.length === 0) {
    return NextResponse.json({ detail: "Desktop session unavailable" }, { status: 503 });
  }
  const origin = request.headers.get("origin");
  if (!hosts.includes(request.headers.get("host") || "") ||
      (origin !== null && !origins.includes(origin))) {
    return NextResponse.json({ detail: "Forbidden desktop origin" }, { status: 403 });
  }
  const cookie = request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DESKTOP_COOKIE_NAME}=`))
    ?.slice(DESKTOP_COOKIE_NAME.length + 1);
  const supplied = Buffer.from(request.headers.get(DESKTOP_TOKEN_HEADER) || cookie || "");
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }
  return null;
}
