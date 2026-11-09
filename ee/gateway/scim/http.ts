/**
 * SCIM HTTP routes — Sibyl Enterprise (licence feature `scim`).
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 *   /scim/v2/Users[/:id], /scim/v2/Groups[/:id]      Bearer SCIM token
 *   /scim/v2/ServiceProviderConfig, /ResourceTypes, /Schemas
 *   GET/POST /api/scim/tokens, DELETE /api/scim/tokens/:id   org.settings
 *
 * The SCIM endpoints are server-to-server (no cookies, no CORS); a wrong or
 * missing token gets 401.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpRouteHandler } from "../../../packages/core/src/index";
import { BodyTooLargeError, bearer, readJson, requestPath, requestUrl } from "../../../apps/gateway/src/http/index";
import { adminRoute, type IdentityContext } from "../directory/context";
import { GROUP_SCHEMA, LIST_SCHEMA, ScimError, ScimService, USER_SCHEMA } from "./service";
import type { ScimTokens } from "./tokens";

const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const CONTENT_TYPE = "application/scim+json; charset=utf-8";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function scimRoutes(context: IdentityContext, tokens: ScimTokens): HttpRouteHandler {
  const service = new ScimService(context);
  return (request, response) => {
    const path = requestPath(request);
    if (path === "/api/scim/tokens" || path.startsWith("/api/scim/tokens/")) return tokenRoutes(context, tokens, request, response, path);
    if (path !== "/scim/v2" && !path.startsWith("/scim/v2/")) return false;
    void serve(context, tokens, service, request, response, path).catch((error: unknown) => {
      request.resume();
      if (error instanceof ScimError) return scimError(response, error.status, error.message, error.scimType);
      if (error instanceof BodyTooLargeError) return scimError(response, 413, "The request is too large.");
      if (error instanceof SyntaxError) return scimError(response, 400, "The body isn't valid JSON.", "invalidSyntax");
      context.log("scim.http_failed", { error: error instanceof Error ? error.message : String(error) });
      scimError(response, 500, "Something went wrong.");
    });
    return true;
  };
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": CONTENT_TYPE, "cache-control": "no-store", ...headers });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

function scimError(response: ServerResponse, status: number, detail: string, scimType?: string): void {
  send(response, status, { schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });
}

async function serve(context: IdentityContext, tokens: ScimTokens, service: ScimService, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const tokenId = await tokens.verify(bearer(request));
  if (!tokenId) {
    request.resume();
    return send(response, 401, { schemas: [ERROR_SCHEMA], status: "401", detail: "A valid SCIM bearer token is required." }, { "www-authenticate": 'Bearer realm="sibyl-scim"' });
  }
  const method = request.method ?? "GET";
  const [, , , resource, id, extra] = path.split("/"); // "", "scim", "v2", resource, id
  const url = requestUrl(request);
  const baseUrl = `${context.bridge().gatewayUrl(request)}/scim/v2`;
  const query = {
    ...(url.searchParams.get("filter") !== null ? { filter: url.searchParams.get("filter")! } : {}),
    ...(url.searchParams.get("startIndex") !== null ? { startIndex: url.searchParams.get("startIndex")! } : {}),
    ...(url.searchParams.get("count") !== null ? { count: url.searchParams.get("count")! } : {}),
    ...(url.searchParams.get("excludedAttributes") !== null ? { excludedAttributes: url.searchParams.get("excludedAttributes")! } : {})
  };
  const body = async () => {
    const parsed = await readJson(request, 1024 * 1024);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ScimError(400, "Send a JSON object.", "invalidSyntax");
    return parsed as Record<string, unknown>;
  };
  if (extra !== undefined || (id !== undefined && !ID.test(id))) {
    request.resume();
    throw new ScimError(404, "Not found.");
  }

  if (resource === "Users") {
    if (!id && method === "GET") {
      request.resume();
      return send(response, 200, await service.listUsers(query, baseUrl));
    }
    if (!id && method === "POST") {
      const user = await service.createUser(await body());
      return send(response, 201, await service.userResource(user, baseUrl), { location: `${baseUrl}/Users/${user.id}` });
    }
    if (id && method === "GET") {
      request.resume();
      return send(response, 200, await service.userResource(await service.getUser(id), baseUrl));
    }
    if (id && method === "PUT") return send(response, 200, await service.userResource(await service.replaceUser(id, await body()), baseUrl));
    if (id && method === "PATCH") return send(response, 200, await service.userResource(await service.patchUser(id, await body()), baseUrl));
    if (id && method === "DELETE") {
      request.resume();
      await service.getUser(id);
      await service.deactivate(id);
      return send(response, 204, undefined);
    }
  }

  if (resource === "Groups") {
    if (!id && method === "GET") {
      request.resume();
      return send(response, 200, await service.listGroups(query, baseUrl));
    }
    if (!id && method === "POST") {
      const group = await service.createGroup(await body());
      return send(response, 201, service.groupResource(group, await service.userMap(), baseUrl), { location: `${baseUrl}/Groups/${group.id}` });
    }
    if (id && method === "GET") {
      request.resume();
      return send(response, 200, service.groupResource(await service.getGroup(id), await service.userMap(), baseUrl));
    }
    if (id && method === "PUT") return send(response, 200, service.groupResource(await service.replaceGroup(id, await body()), await service.userMap(), baseUrl));
    if (id && method === "PATCH") return send(response, 200, service.groupResource(await service.patchGroup(id, await body()), await service.userMap(), baseUrl));
    if (id && method === "DELETE") {
      request.resume();
      await service.deleteGroup(id);
      return send(response, 204, undefined);
    }
  }

  if (method === "GET" && !id) {
    request.resume();
    if (resource === "ServiceProviderConfig") return send(response, 200, serviceProviderConfig(baseUrl));
    if (resource === "ResourceTypes") return send(response, 200, list(resourceTypes(baseUrl)));
    if (resource === "Schemas") return send(response, 200, list(schemas()));
  }
  request.resume();
  throw new ScimError(404, "Not found.");
}

function list(resources: unknown[]): unknown {
  return { schemas: [LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources };
}

function serviceProviderConfig(baseUrl: string): unknown {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "A SCIM token from Admin → Provisioning (SCIM).", primary: true }],
    meta: { resourceType: "ServiceProviderConfig", location: `${baseUrl}/ServiceProviderConfig` }
  };
}

function resourceTypes(baseUrl: string): unknown[] {
  return [
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA, meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` } },
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP_SCHEMA, meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/Group` } }
  ];
}

function schemas(): unknown[] {
  const attribute = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
    name,
    type,
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: "readWrite",
    returned: "default",
    uniqueness: "none",
    ...extra
  });
  return [
    {
      id: USER_SCHEMA,
      name: "User",
      attributes: [
        attribute("userName", "string", { required: true, uniqueness: "server" }),
        attribute("displayName", "string"),
        attribute("name", "complex", { subAttributes: [attribute("formatted", "string"), attribute("givenName", "string"), attribute("familyName", "string")] }),
        attribute("emails", "complex", { multiValued: true, subAttributes: [attribute("value", "string"), attribute("type", "string"), attribute("primary", "boolean")] }),
        attribute("active", "boolean"),
        attribute("externalId", "string", { caseExact: true })
      ]
    },
    {
      id: GROUP_SCHEMA,
      name: "Group",
      attributes: [
        attribute("displayName", "string", { required: true, uniqueness: "server" }),
        attribute("members", "complex", { multiValued: true, subAttributes: [attribute("value", "string"), attribute("display", "string", { mutability: "readOnly" })] }),
        attribute("externalId", "string", { caseExact: true })
      ]
    }
  ];
}

/* ───────────── token administration ───────────── */

function tokenRoutes(context: IdentityContext, tokens: ScimTokens, request: IncomingMessage, response: ServerResponse, path: string): true {
  return adminRoute(context, request, response, "scim.tokens_http_failed", async ({ reply, body }) => {
    const id = path.split("/")[4];
    const baseUrl = `${context.bridge().gatewayUrl(request)}/scim/v2`;
    if (!id && request.method === "GET") {
      request.resume();
      return reply(200, { tokens: await tokens.list(), baseUrl });
    }
    if (!id && request.method === "POST") {
      const input = await body();
      const created = await tokens.create(input.label);
      context.log("scim.token_created", { tokenId: created.token.id });
      return reply(201, { ...created, baseUrl });
    }
    if (id && ID.test(id) && request.method === "DELETE") {
      request.resume();
      await tokens.revoke(id);
      context.log("scim.token_revoked", { tokenId: id });
      return reply(200, { ok: true });
    }
    request.resume();
    reply(404, { error: "not_found" });
  });
}
