import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ownerPrincipal } from "@open-gpt-live/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  bearer,
  bindCaller,
  BodyTooLargeError,
  corsGuard,
  corsHeaders,
  httpEventLog,
  idPattern,
  isUnder,
  logRequest,
  newId,
  originAllowed,
  readJson,
  readJsonObject,
  requestCaller,
  requestPath,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendError,
  sendJson
} from "./index.js";

/** A fake request: only what the pure helpers read. */
function fakeRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers, method: "GET" } as unknown as IncomingMessage;
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A real server running `handler`; returns its base URL. */
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("request", () => {
  test("requestPath drops the query and survives garbage", () => {
    expect(requestPath(fakeRequest("/api/x?y=1"))).toBe("/api/x");
    expect(requestPath(fakeRequest("http://["))).toBe("/");
  });

  test("bearer reads the Authorization header, then ?token=", () => {
    expect(bearer(fakeRequest("/", { authorization: "Bearer  abc " }))).toBe("abc");
    expect(bearer(fakeRequest("/?token=t1"))).toBe("t1");
    expect(bearer(fakeRequest("/", { authorization: "Basic x" }))).toBeUndefined();
  });

  test("requestWorkspace: header, then ?workspaceId=, else default; bad ids fall back", () => {
    expect(requestWorkspace(fakeRequest("/?workspaceId=q", { "x-sibyl-workspace": "team-a" }))).toBe("team-a");
    expect(requestWorkspace(fakeRequest("/?workspaceId=q"))).toBe("q");
    expect(requestWorkspace(fakeRequest("/"))).toBe("default");
    expect(requestWorkspace(fakeRequest("/", { "x-sibyl-workspace": "../etc" }))).toBe("default");
  });

  test("readJson / readJsonObject: empty is {}, size capped, objects only", async () => {
    const base = await serve(async (request, response) => {
      try {
        const body = request.url === "/any" ? await readJson(request, 32) : await readJsonObject(request, 32);
        sendJson(response, 200, { body });
      } catch (error) {
        if (!sendBodyError(response, error)) sendError(response, 500, "boom");
      }
    });
    const post = (path: string, body: string) => fetch(`${base}${path}`, { method: "POST", body });
    expect(await (await post("/obj", "")).json()).toEqual({ body: {} });
    expect(await (await post("/obj", '{"a":1}')).json()).toEqual({ body: { a: 1 } });
    expect(await (await post("/any", "[1,2]")).json()).toEqual({ body: [1, 2] });
    expect((await post("/obj", "[1,2]")).status).toBe(400);
    expect((await post("/obj", "{nope")).status).toBe(400);
    const big = await post("/obj", JSON.stringify({ text: "x".repeat(100) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "too_large" });
    expect(new BodyTooLargeError()).toBeInstanceOf(Error);
  });
});

describe("response", () => {
  test("sendJson and sendError write no-store JSON with extra headers", async () => {
    const base = await serve((request, response) => {
      if (request.url === "/ok") sendJson(response, 201, { ok: true }, { "x-extra": "1" });
      else sendError(response, 404, "not_found", "Nothing here.");
    });
    const ok = await fetch(`${base}/ok`);
    expect(ok.status).toBe(201);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-extra")).toBe("1");
    expect(await ok.json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/missing`)).json()).toEqual({ error: "not_found", message: "Nothing here." });
  });
});

describe("cors", () => {
  test("originAllowed: the list when set, else the gateway's own host name", () => {
    const request = fakeRequest("/", { host: "localhost:8787" });
    expect(originAllowed(undefined, request)).toBe(true);
    expect(originAllowed("http://localhost:3000", request)).toBe(true);
    expect(originAllowed("https://evil.example", request)).toBe(false);
    expect(originAllowed("https://app.example", request, ["https://app.example"])).toBe(true);
    expect(originAllowed("http://localhost:3000", request, ["https://app.example"])).toBe(false);
  });

  test("corsHeaders allow credentials for an allowed origin only", () => {
    const allowed = corsHeaders(fakeRequest("/", { origin: "https://app.example" }), ["https://app.example"]);
    expect(allowed).toMatchObject({ "access-control-allow-origin": "https://app.example", "access-control-allow-credentials": "true", vary: "Origin" });
    expect(corsHeaders(fakeRequest("/", { origin: "https://evil.example" }), ["https://app.example"])).toBeUndefined();
    expect(corsHeaders(fakeRequest("/"))).toEqual({});
  });

  test("corsGuard refuses foreign origins and answers preflights", async () => {
    const base = await serve((request, response) => {
      const cors = corsGuard(request, response, ["https://app.example"], "GET, OPTIONS");
      if (cors) sendJson(response, 200, { ok: true }, cors);
    });
    expect((await fetch(base, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    const preflight = await fetch(base, { method: "OPTIONS", headers: { origin: "https://app.example" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    const ok = await fetch(base, { headers: { origin: "https://app.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });
});

describe("caller, ids, routes and logging", () => {
  test("bindCaller / requestCaller", () => {
    const request = fakeRequest("/");
    expect(requestCaller(request)).toBeUndefined();
    const auth = { principal: ownerPrincipal("owner", "token") };
    bindCaller(request, auth);
    expect(requestCaller(request)).toBe(auth);
  });

  test("newId: one length, optional prefix, matching idPattern", () => {
    const plain = newId();
    const prefixed = newId("up");
    expect(plain).toMatch(/^[a-f0-9]{24}$/);
    expect(prefixed).toMatch(idPattern("up"));
    expect(idPattern("up").test(plain)).toBe(false);
    expect(new Set(Array.from({ length: 50 }, () => newId())).size).toBe(50);
  });

  test("isUnder and runRoute (500 on an unexpected error, logged as the event)", async () => {
    expect(isUnder("/api/slides", "/api/slides")).toBe(true);
    expect(isUnder("/api/slides/x", "/api/slides")).toBe(true);
    expect(isUnder("/api/slidesx", "/api/slides")).toBe(false);
    const events: string[] = [];
    const base = await serve((_request, response) => {
      runRoute(response, (event) => events.push(event), "thing.http_failed", Promise.reject(new Error("kaput")));
    });
    const response = await fetch(base);
    expect(response.status).toBe(500);
    expect(events).toEqual(["thing.http_failed"]);
  });

  test("httpEventLog warns only for failures; logRequest logs info, warn on 5xx", async () => {
    const lines: Array<[string, string]> = [];
    const logger = { info: (event: string) => lines.push(["info", event]), warn: (event: string) => lines.push(["warn", event]) };
    const log = httpEventLog(logger);
    log("slides.http_failed");
    log("connectors.oauth_completed");
    expect(lines).toEqual([["warn", "slides.http_failed"], ["info", "connectors.oauth_completed"]]);
    lines.length = 0;
    const base = await serve((request, response) => {
      logRequest(logger, request, response);
      sendJson(response, request.url === "/bad" ? 502 : 200, {});
    });
    await (await fetch(`${base}/fine`)).text();
    await (await fetch(`${base}/bad`)).text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines).toEqual([["info", "http.request"], ["warn", "http.request_failed"]]);
  });
});
