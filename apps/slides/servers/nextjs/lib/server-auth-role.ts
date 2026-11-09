import { NextResponse } from "next/server";
import { desktopRequestDenied, DESKTOP_TOKEN_HEADER } from "@/lib/desktop-auth";

export type ServerAuthStatus = {
  configured: boolean;
  authenticated: boolean;
  username: string | null;
  user_id: string | null;
  role: "admin" | "user" | null;
};

function fastApiBase(): string {
  return (
    process.env.FAST_API_INTERNAL_URL?.trim() ||
    process.env.NEXT_PUBLIC_FAST_API?.trim() ||
    "http://127.0.0.1:8000"
  ).replace(/\/+$/, "");
}

export async function authStatusForRequest(
  request: Request
): Promise<ServerAuthStatus> {
  if (desktopRequestDenied(request)) {
    return { configured: true, authenticated: false, username: null, user_id: null, role: null };
  }
  const cookie = request.headers.get("cookie") || "";
  try {
    const response = await fetch(`${fastApiBase()}/api/v1/auth/status`, {
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(request.headers.get(DESKTOP_TOKEN_HEADER) ? { [DESKTOP_TOKEN_HEADER]: request.headers.get(DESKTOP_TOKEN_HEADER)! } : {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        configured: true,
        authenticated: false,
        username: null,
        user_id: null,
        role: null,
      };
    }
    return (await response.json()) as ServerAuthStatus;
  } catch {
    return {
      configured: true,
      authenticated: false,
      username: null,
      user_id: null,
      role: null,
    };
  }
}

export async function requireAdminApi(
  request: Request
): Promise<NextResponse | null> {
  const status = await authStatusForRequest(request);
  if (!status.authenticated) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }
  if (status.role !== "admin") {
    return NextResponse.json(
      { detail: "Admin access required" },
      { status: 403 }
    );
  }
  return null;
}
