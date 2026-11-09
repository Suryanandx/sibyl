/**
 * /api/presence — agents in Slack and Teams (routes in the protocol's
 * "Presence" block).
 *
 * - Vendor callbacks are not signed in; each checks its own proof first:
 *   Slack events their v0 signature (on the raw body), Graph notifications
 *   their clientState; Graph's validation handshake echoes `validationToken`.
 *   They answer at once (Slack wants 3 s, Graph 3 s) and work afterwards.
 * - Everything else runs behind the gateway's identity gate (route map in
 *   identity/http.ts); the handler then checks the finer rules (who may edit
 *   the agent, who may set the workspace's notifications channel).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parsePresenceAgentSettings,
  parsePresenceBindingInput,
  parsePresenceDirectInput,
  parsePresenceRespond,
  parsePresenceWorkspaceSettings
} from "@open-gpt-live/protocol";
import {
  BodyTooLargeError,
  corsGuard,
  headerValue,
  isUnder,
  queryParam,
  readBody,
  readJsonObject,
  requestCaller,
  requestPath,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendJson,
  type ApiOptions
} from "../http/index.js";
import { SLACK_EVENTS_PATH } from "../connectors/slack/index.js";
import { PresenceError, type CallbackReply, type PresenceService } from "./service.js";
import { SLACK_EVENTS_MAX_BYTES } from "./slack.js";
import { TEAMS_LIFECYCLE_PATH, TEAMS_NOTIFICATIONS_PATH, TEAMS_NOTIFICATION_MAX_BYTES } from "./teams.js";

const METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface PresenceHttpOptions extends ApiOptions {
  presence: PresenceService | undefined;
}

export function isPresencePath(path: string): boolean {
  return isUnder(path, "/api/presence");
}

/** Vendor callbacks: no sign-in (signature / clientState instead). */
export function isPresenceCallbackPath(path: string): boolean {
  return path === SLACK_EVENTS_PATH || path === TEAMS_NOTIFICATIONS_PATH || path === TEAMS_LIFECYCLE_PATH;
}

export function handlePresenceHttp(options: PresenceHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isPresencePath(path)) return false;
  return runRoute(response, options.log, "presence.http_failed", serve(options, request, response, path));
}

async function serve(options: PresenceHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const service = options.presence;
  const method = request.method ?? "GET";

  if (isPresenceCallbackPath(path)) {
    // Server to server: no CORS, no cookies.
    if (!service) {
      request.resume();
      return sendJson(response, 404, { error: "not_found" });
    }
    // Graph's subscription check: echo the token as plain text (also sent as POST).
    const validationToken = queryParam(request, "validationToken");
    if (path !== SLACK_EVENTS_PATH && validationToken !== undefined) {
      request.resume();
      if (validationToken.length > 2048) return sendJson(response, 400, { error: "bad_request" });
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(validationToken);
      return;
    }
    if (method !== "POST") {
      request.resume();
      return sendJson(response, 405, { error: "method_not_allowed" });
    }
    let body: Buffer;
    try {
      body = await readBody(request, path === SLACK_EVENTS_PATH ? SLACK_EVENTS_MAX_BYTES : TEAMS_NOTIFICATION_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return sendJson(response, 413, { error: "too_large" });
      throw error;
    }
    let reply: CallbackReply;
    if (path === SLACK_EVENTS_PATH) {
      const retryNum = headerValue(request, "x-slack-retry-num");
      reply = await service.receiveSlack(
        { timestamp: headerValue(request, "x-slack-request-timestamp"), signature: headerValue(request, "x-slack-signature"), ...(retryNum ? { retryNum } : {}) },
        body
      );
    } else if (path === TEAMS_NOTIFICATIONS_PATH) {
      reply = service.receiveTeams(body);
    } else {
      reply = service.receiveTeamsLifecycle(body);
    }
    if (reply.body === undefined) {
      response.writeHead(reply.status, { "cache-control": "no-store" });
      response.end();
      return;
    }
    return sendJson(response, reply.status, reply.body);
  }

  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  if (!service) {
    request.resume();
    return reply(503, { error: "unavailable", message: "Slack and Teams presence is not available on this gateway (it needs integrations and agents)." });
  }
  // Set by the identity gate in front of this route.
  const auth = requestCaller(request);
  if (!auth) {
    request.resume();
    return reply(401, { error: "unauthorized", message: "Sign in to continue." });
  }
  const name = auth.user?.name || auth.user?.email;
  const caller = { principal: auth.principal, workspaceId: requestWorkspace(request), ...(name ? { name } : {}) };
  const segments = path.split("/").filter(Boolean).slice(2); // drop "api", "presence"
  const body = () => readJsonObject(request, 16 * 1024);

  try {
    // /api/presence/settings
    if (segments.length === 1 && segments[0] === "settings") {
      if (method === "GET") {
        request.resume();
        return reply(200, service.workspaceSettings(caller));
      }
      if (method === "PUT") {
        const input = parsePresenceWorkspaceSettings(await body());
        if (typeof input === "string") return reply(400, { error: "bad_request", message: input });
        return reply(200, await service.setWorkspaceSettings(caller, input));
      }
    }

    // /api/presence/channels?provider=&teamId=
    if (segments.length === 1 && segments[0] === "channels" && method === "GET") {
      request.resume();
      const provider = queryParam(request, "provider");
      const teamId = queryParam(request, "teamId");
      if (provider !== "slack" && provider !== "teams") return reply(400, { error: "bad_request", message: 'provider must be "slack" or "teams"' });
      if (teamId !== undefined && !/^[A-Za-z0-9_:.@-]{1,200}$/.test(teamId)) return reply(400, { error: "bad_request", message: "teamId is not valid" });
      return reply(200, await service.channels(caller, provider, teamId));
    }

    // /api/presence/agents/:agentId[/bindings[/:id] | /settings]
    if (segments[0] === "agents" && segments[1] && ID.test(segments[1])) {
      const agentId = segments[1];
      if (segments.length === 2 && method === "GET") {
        request.resume();
        return reply(200, await service.agentState(caller, agentId));
      }
      if (segments.length === 3 && segments[2] === "bindings" && method === "POST") {
        const input = parsePresenceBindingInput(await body());
        if (typeof input === "string") return reply(400, { error: "bad_request", message: input });
        return reply(201, await service.addBinding(caller, agentId, input));
      }
      if (segments.length === 4 && segments[2] === "bindings" && segments[3] && ID.test(segments[3])) {
        if (method === "PATCH") {
          const input = parsePresenceRespond(await body());
          if (typeof input === "string") return reply(400, { error: "bad_request", message: input });
          return reply(200, await service.updateBinding(caller, agentId, segments[3], input.respond));
        }
        if (method === "DELETE") {
          request.resume();
          return reply(200, await service.removeBinding(caller, agentId, segments[3]));
        }
      }
      // /api/presence/agents/:agentId/direct/:provider — direct messages (Slack DMs, Teams chats)
      if (segments.length === 4 && segments[2] === "direct" && (segments[3] === "slack" || segments[3] === "teams")) {
        const provider = segments[3];
        if (method === "PUT") {
          const input = parsePresenceDirectInput(await body());
          if (typeof input === "string") return reply(400, { error: "bad_request", message: input });
          return reply(200, await service.setDirect(caller, agentId, provider, input));
        }
        if (method === "DELETE") {
          request.resume();
          return reply(200, await service.removeDirect(caller, agentId, provider));
        }
      }
      if (segments.length === 3 && segments[2] === "settings" && method === "PUT") {
        const input = parsePresenceAgentSettings(await body());
        if (typeof input === "string") return reply(400, { error: "bad_request", message: input });
        return reply(200, await service.setAgentNotify(caller, agentId, input.notify));
      }
    }

    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof PresenceError) return reply(error.status, { error: error.code, message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}
