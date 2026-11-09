/**
 * /api/realtime — behind the gateway's identity gate (route map in
 * identity/http.ts), except the LiveKit webhook, which is checked by its
 * signed token instead.
 *
 *   GET    /api/realtime                        → { url, phone }                        chat.use
 *   POST   /api/realtime/token {conversationId | callId} → { url, token, room, identity } chat.use
 *   GET    /api/realtime/calls/:id              → { id, room, conversationId? }          chat.use
 *   GET    /api/realtime/streams                → { items }                              chat.use
 *   POST   /api/realtime/streams {name, input, url?} → stream                            tools.write
 *   DELETE /api/realtime/streams/:id            → { ok }                                 tools.write
 *   GET    /api/realtime/phone                  → { phone }                              org.settings
 *   PUT    /api/realtime/phone {provider, address, number, username?, password?, agentId?, greeting?} org.settings
 *   DELETE /api/realtime/phone                  → { ok }                                 org.settings
 *   POST   /api/realtime/webhook                (LiveKit; signed)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  corsGuard,
  isUnder,
  readBody,
  readJsonObject,
  requestCaller,
  requestPath,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendError,
  sendJson,
  type ApiOptions
} from "../http/index.js";
import { RealtimeError, type RealtimeService } from "./service.js";

export interface RealtimeHttpOptions extends ApiOptions {
  realtime: RealtimeService;
}

const METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const WEBHOOK_PATH = "/api/realtime/webhook";

export function handleRealtimeHttp(options: RealtimeHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isUnder(path, "/api/realtime") || path === WEBHOOK_PATH) return false;
  return runRoute(response, options.log, "realtime.http_failed", serve(options, request, response, path));
}

/** LiveKit → gateway events (inbound phone calls, rooms closing). */
export function handleRealtimeWebhook(options: RealtimeHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  if (requestPath(request) !== WEBHOOK_PATH || request.method !== "POST") return false;
  return runRoute(
    response,
    options.log,
    "realtime.webhook_failed",
    (async () => {
      const body = (await readBody(request, 256 * 1024)).toString("utf8");
      try {
        await options.realtime.receiveWebhook(body, request.headers.authorization);
      } catch (error) {
        options.log?.("realtime.webhook_rejected", { error: error instanceof Error ? error.message : String(error) });
        sendError(response, 401, "unauthorized", "Invalid webhook signature.");
        return;
      }
      sendJson(response, 200, { ok: true });
    })()
  );
}

async function serve(options: RealtimeHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const { realtime } = options;
  const caller = requestCaller(request);
  const principal = caller?.principal;
  if (!principal) return sendError(response, 401, "unauthorized", "Sign in to continue.", cors);
  const workspaceId = requestWorkspace(request);
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const rest = path.slice("/api/realtime".length).replace(/^\//, "");
  const parts = rest.split("/");

  try {
    if (rest === "" && method === "GET") return reply(200, realtime.capability());

    if (rest === "token" && method === "POST") {
      const input = await readJsonObject(request, 4 * 1024);
      const conversationId = typeof input.conversationId === "string" && ID.test(input.conversationId) ? input.conversationId : undefined;
      const callId = typeof input.callId === "string" && ID.test(input.callId) ? input.callId : undefined;
      return reply(200, await realtime.tokenFor(principal, workspaceId, { ...(conversationId ? { conversationId } : {}), ...(callId ? { callId } : {}) }));
    }

    if (parts[0] === "calls" && parts.length === 2 && ID.test(parts[1]!) && method === "GET") {
      const call = await realtime.call(parts[1]!);
      if (!call || call.workspaceId !== workspaceId) return reply(404, { error: "not_found", message: "That call has ended or isn't in this workspace." });
      return reply(200, { id: call.id, room: realtime.roomFor("call", call.workspaceId, call.id), ...(call.conversationId ? { conversationId: call.conversationId } : {}) });
    }

    if (parts[0] === "streams") {
      if (parts.length === 1 && method === "GET") return reply(200, { items: await realtime.listStreams(workspaceId) });
      if (parts.length === 1 && method === "POST") {
        const input = await readJsonObject(request, 8 * 1024);
        const kind = input.input === "rtmp" || input.input === "whip" || input.input === "url" ? input.input : undefined;
        if (!kind) return reply(400, { error: "bad_request", message: 'input must be "url", "rtmp" or "whip".' });
        const stream = await realtime.createStream({
          principal,
          workspaceId,
          name: typeof input.name === "string" ? input.name : "Stream",
          input: kind,
          ...(typeof input.url === "string" ? { url: input.url } : {})
        });
        return reply(201, stream);
      }
      if (parts.length === 2 && ID.test(parts[1]!) && method === "DELETE") {
        const removed = await realtime.deleteStream(workspaceId, parts[1]!);
        return removed ? reply(200, { ok: true }) : reply(404, { error: "not_found", message: "Stream not found." });
      }
    }

    if (rest === "phone") {
      // Trunk credentials are passed to LiveKit and never stored here.
      if (method === "GET") return reply(200, { phone: (await realtime.phoneSettings()) ?? null });
      if (method === "DELETE") {
        await realtime.removePhone();
        return reply(200, { ok: true });
      }
      if (method === "PUT") {
        const input = await readJsonObject(request, 8 * 1024);
        const text = (key: string) => (typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string).trim() : undefined);
        const address = text("address");
        const number = text("number");
        if (!address || !number) return reply(400, { error: "bad_request", message: "address and number are required." });
        const settings = await realtime.setupPhone({
          provider: input.provider === "twilio" ? "twilio" : "other",
          address,
          number,
          workspaceId,
          ...(text("username") ? { username: text("username") } : {}),
          ...(text("password") ? { password: text("password") } : {}),
          ...(text("agentId") ? { agentId: text("agentId") } : {}),
          ...(text("greeting") ? { greeting: text("greeting") } : {})
        });
        return reply(200, { phone: settings });
      }
    }
  } catch (error) {
    if (sendBodyError(response, error, cors)) return;
    if (error instanceof RealtimeError) return reply(error.status, { error: "realtime", message: error.message });
    // LiveKit unreachable or refused: say so without leaking internals.
    options.log?.("realtime.api_failed", { path, error: error instanceof Error ? error.message : String(error) });
    return reply(502, { error: "livekit_unavailable", message: "The call service (LiveKit) didn't answer." });
  }
  request.resume();
  return reply(404, { error: "not_found" });
}
