/**
 * /api/meetings — behind the gateway's identity gate (chat.use, route map in
 * identity/http.ts), except the three guest routes, which are checked by the
 * meeting's guest-link key or lobby ticket instead:
 *
 *   GET    /api/meetings?q=                         → { items }
 *   POST   /api/meetings {title?, scheduledAt?, scheduledEndAt?, description?, sibylRole?, calendar?} → meeting
 *   GET    /api/meetings/calendar                   → { connected, items }   (needs integrations.use)
 *   GET    /api/meetings/:id                        → meeting
 *   PATCH  /api/meetings/:id {title?, description?, scheduledAt?, scheduledEndAt?, recordingId?}   host / admin
 *   DELETE /api/meetings/:id                                                 host / admin
 *   GET    /api/meetings/:id/transcript             → { items }
 *   GET    /api/meetings/:id/export                 → text/markdown
 *   POST   /api/meetings/:id/notes                  → meeting (notes refreshed now)
 *   POST   /api/meetings/:id/ask {question}         → { answer }
 *   POST   /api/meetings/:id/end                    → meeting                host
 *   PUT    /api/meetings/:id/agents/:agentId {role} → meeting                host (+ agents.use)
 *   DELETE /api/meetings/:id/agents/:agentId        → meeting                host
 *   POST   /api/meetings/:id/participants/:identity/mute | /remove          host
 *   GET    /api/meetings/:id/lobby                  → { items }              host
 *   POST   /api/meetings/:id/lobby/:ticket {admit}  → { ok }                 host
 *   GET    /api/meetings/:id/comments               → { items }
 *   POST   /api/meetings/:id/comments {text, parentId?, atMs?}
 *   PATCH  /api/meetings/:id/comments/:cid {text}   DELETE …                 author (delete: or host)
 *   POST   /api/meetings/:id/comments/:cid/reactions {emoji}
 *
 * Guests (no account):
 *   POST   /api/meetings/:id/preview {key}          → { title, hostName, status }
 *   POST   /api/meetings/:id/lobby {key, name}      → { ticket }
 *   GET    /api/meetings/:id/lobby/:ticket          → { status, grant? }
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PERMISSIONS, authorize, isMeetingAgentRole } from "@open-gpt-live/core";
import {
  corsGuard,
  isUnder,
  readJsonObject,
  requestCaller,
  requestPath,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendError,
  sendJson,
  queryParam,
  type ApiOptions
} from "../http/index.js";
import { RealtimeError } from "../realtime/service.js";
import { upcomingEvents, type CalendarDeps } from "./calendar.js";
import { isMeetingGuestRoute } from "./routes.js";
import { MeetingError, type MeetingService } from "./service.js";

export interface MeetingsHttpOptions extends ApiOptions {
  meetings: MeetingService;
  calendar: CalendarDeps;
}

const METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const IDENTITY = /^(user|guest|phone):[A-Za-z0-9_-]{1,100}$/;

export function handleMeetingsHttp(options: MeetingsHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isUnder(path, "/api/meetings")) return false;
  return runRoute(response, options.log, "meetings.http_failed", serve(options, request, response, path));
}

async function serve(options: MeetingsHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const { meetings } = options;
  const method = request.method ?? "GET";
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const parts = path.slice("/api/meetings".length).replace(/^\//, "").split("/").filter(Boolean);
  const id = parts[0];

  try {
    // Guests: no caller; the key or ticket is the check.
    if (isMeetingGuestRoute(method, path)) {
      if (parts[1] === "preview") {
        const input = await readJsonObject(request, 2 * 1024);
        return reply(200, await meetings.preview(id!, input.key));
      }
      if (parts[1] === "lobby" && parts.length === 2) {
        const input = await readJsonObject(request, 2 * 1024);
        return reply(201, await meetings.knock(id!, input.key, input.name));
      }
      return reply(200, await meetings.lobbyStatus(id!, parts[2]!));
    }

    const principal = requestCaller(request)?.principal;
    if (!principal) return sendError(response, 401, "unauthorized", "Sign in to continue.", cors);
    const caller = { principal, workspaceId: requestWorkspace(request) };

    if (parts.length === 0) {
      if (method === "GET") return reply(200, { items: await meetings.list(caller, queryParam(request, "q") ?? "") });
      if (method === "POST") return reply(201, await meetings.create(caller, await readJsonObject(request, 16 * 1024)));
    }
    if (parts.length === 1 && id === "calendar" && method === "GET") {
      if (!authorize(principal, PERMISSIONS.INTEGRATIONS_USE, { workspaceId: caller.workspaceId })) return reply(200, { connected: [], items: [] });
      return reply(200, await upcomingEvents(options.calendar, caller, Date.now()));
    }
    if (!id || !ID.test(id)) return notFound();

    if (parts.length === 1) {
      if (method === "GET") return reply(200, await meetings.get(caller, id));
      if (method === "PATCH") return reply(200, await meetings.update(caller, id, await readJsonObject(request, 16 * 1024)));
      if (method === "DELETE") {
        await meetings.remove(caller, id);
        return reply(200, { ok: true });
      }
    }
    const [, section, sub, action] = parts;
    if (parts.length === 2 && method === "GET" && section === "transcript") return reply(200, { items: await meetings.transcript(caller, id) });
    if (parts.length === 2 && method === "GET" && section === "export") {
      const { title, text } = await meetings.markdown(caller, id);
      response.writeHead(200, {
        ...cors,
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${title.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 80) || "meeting"}.md"`,
        "cache-control": "no-store"
      });
      response.end(text);
      return;
    }
    if (parts.length === 2 && method === "POST" && section === "notes") return reply(200, await meetings.refreshNotes(caller, id));
    if (parts.length === 2 && method === "POST" && section === "ask") {
      const input = await readJsonObject(request, 8 * 1024);
      return reply(200, { answer: await meetings.ask(caller, id, input.question) });
    }
    if (parts.length === 2 && method === "POST" && section === "end") return reply(200, await meetings.end(caller, id));

    if (section === "agents" && parts.length === 3 && sub && SEGMENT.test(sub)) {
      if (method === "PUT") {
        const input = await readJsonObject(request, 1024);
        if (!isMeetingAgentRole(input.role)) return reply(400, { error: "bad_request", message: 'role must be "participant" or "notetaker".' });
        return reply(200, await meetings.setAgentRole(caller, id, sub, input.role));
      }
      if (method === "DELETE") return reply(200, await meetings.setAgentRole(caller, id, sub, null));
    }

    if (section === "participants" && parts.length === 4 && method === "POST") {
      const identity = decodeURIComponent(sub ?? "");
      if (!IDENTITY.test(identity)) return reply(400, { error: "bad_request", message: "Unknown participant." });
      request.resume();
      if (action === "mute") return reply(200, { muted: await meetings.mute(caller, id, identity) });
      if (action === "remove") {
        await meetings.removeParticipant(caller, id, identity);
        return reply(200, { ok: true });
      }
    }

    if (section === "lobby") {
      if (parts.length === 2 && method === "GET") return reply(200, { items: await meetings.lobbyWaiting(caller, id) });
      if (parts.length === 3 && method === "POST" && sub && SEGMENT.test(sub)) {
        const input = await readJsonObject(request, 1024);
        const ok = await meetings.decideKnock(caller, id, sub, input.admit === true);
        return ok ? reply(200, { ok: true }) : reply(404, { error: "not_found", message: "That person is no longer waiting." });
      }
    }

    if (section === "comments") {
      if (parts.length === 2 && method === "GET") return reply(200, { items: await meetings.comments(caller, id) });
      if (parts.length === 2 && method === "POST") return reply(201, await meetings.addComment(caller, id, await readJsonObject(request, 16 * 1024)));
      if (sub && SEGMENT.test(sub)) {
        if (parts.length === 3 && method === "PATCH") return reply(200, await meetings.editComment(caller, id, sub, (await readJsonObject(request, 16 * 1024)).text));
        if (parts.length === 3 && method === "DELETE") {
          await meetings.deleteComment(caller, id, sub);
          return reply(200, { ok: true });
        }
        if (parts.length === 4 && action === "reactions" && method === "POST") {
          return reply(200, await meetings.react(caller, id, sub, (await readJsonObject(request, 1024)).emoji));
        }
      }
    }
  } catch (error) {
    if (sendBodyError(response, error, cors)) return;
    if (error instanceof MeetingError) return reply(error.status, { error: error.code, message: error.message });
    if (error instanceof RealtimeError) return reply(error.status, { error: "realtime", message: error.message });
    throw error;
  }
  return notFound();

  function notFound(): void {
    request.resume();
    reply(404, { error: "not_found" });
  }
}
