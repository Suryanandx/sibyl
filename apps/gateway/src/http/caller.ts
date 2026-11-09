/**
 * Who is calling, bound to the request by the identity gate
 * (gateProtectedRoute) so handlers behind it read the same answer instead of
 * authenticating again.
 */
import type { IncomingMessage } from "node:http";
import type { Authenticated } from "../identity/service.js";

// One map per process, even when this file is loaded twice (source runs load
// ee/ modules as CommonJS next to the ESM gateway): enterprise routes behind
// the gate must see the caller the gate bound.
const CALLERS = Symbol.for("sibyl.http.callers");
const registry = globalThis as typeof globalThis & { [CALLERS]?: WeakMap<IncomingMessage, Authenticated> };
const callers = (registry[CALLERS] ??= new WeakMap<IncomingMessage, Authenticated>());

export function bindCaller(request: IncomingMessage, auth: Authenticated): void {
  callers.set(request, auth);
}

/** The caller the gate authenticated (undefined: the request did not pass the gate). */
export function requestCaller(request: IncomingMessage): Authenticated | undefined {
  return callers.get(request);
}
