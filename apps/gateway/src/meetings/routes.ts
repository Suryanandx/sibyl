/**
 * The meetings routes a guest (no account) may call: checked by the meeting's
 * guest-link key or lobby ticket instead of a sign-in. Kept dependency-free:
 * the identity gate (identity/http.ts) and the handler (http.ts) share it.
 *
 *   POST /api/meetings/:id/preview {key}
 *   POST /api/meetings/:id/lobby {key, name}
 *   GET  /api/meetings/:id/lobby/:ticket
 */
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const TICKET = /^[A-Za-z0-9_-]{1,100}$/;

export function isMeetingGuestRoute(method: string, path: string): boolean {
  const parts = path.split("/");
  // ["", "api", "meetings", id, …]
  if (parts.length < 5 || parts[1] !== "api" || parts[2] !== "meetings" || !ID.test(parts[3] ?? "")) return false;
  if (parts.length === 5 && method === "POST" && (parts[4] === "preview" || parts[4] === "lobby")) return true;
  return parts.length === 6 && method === "GET" && parts[4] === "lobby" && TICKET.test(parts[5] ?? "");
}
