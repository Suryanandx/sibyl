import { randomBytes } from "node:crypto";
import type { LLMProvider, STTProvider } from "@open-gpt-live/adapters";
import { createMemoryStore } from "@open-gpt-live/core";
import { INTEGRATIONS_EVENTS, type IntegrationsStateMessage, type ServerMessage } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayServerHandle } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import { SecretVault } from "../secrets/vault.js";
import { googleConnector } from "./google/index.js";
import { microsoftConnector } from "./microsoft/index.js";
import { ConnectorService } from "./service.js";
import { authorizeParams, startFakeVendor } from "./testing.js";

const PASSWORD = "correct horse battery";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function json(base: string, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const setCookie = response.headers.get("set-cookie");
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text, cookie: setCookie ? setCookie.split(";")[0]! : undefined };
}

async function start() {
  const store = createMemoryStore();
  const key = randomBytes(32);
  const logs: string[] = [];
  const log = (event: string, fields?: Record<string, unknown>) => void logs.push(JSON.stringify({ event, ...fields }));
  const vault = new SecretVault({ store, key, log });
  const runtime = createTestRuntime({ store });
  const google = await startFakeVendor({ clientId: "gid", clientSecret: "google-secret-value", scope: "openid email https://www.googleapis.com/auth/gmail.readonly" });
  google.route("GET", "/v1/userinfo", () => ({ json: { email: "max@example.com" } }));
  const connectors = await new ConnectorService({
    store,
    ownerId: runtime.ownerId,
    key,
    vault,
    tools: runtime.tools,
    builtins: [googleConnector, microsoftConnector],
    env: {},
    log,
    endpoints: { google: { authorizeUrl: `${google.url}/auth`, tokenUrl: `${google.url}/token`, revokeUrl: `${google.url}/revoke`, apiBases: { userinfo: google.url, gmail: google.url } } }
  }).init();
  runtime.connectors = connectors;
  const llm: LLMProvider = { async *streamText() { yield { delta: "hi" }; } };
  const stt: STTProvider = { transcribe: async () => ({ text: "x" }) };
  const server: GatewayServerHandle = await createGatewayServer({ providers: { llm, stt }, port: 0, host: "127.0.0.1", runtime, logger: { info: log, warn: log, error: log } });
  cleanup.push(() => server.close(), () => connectors.close(), () => vault.close(), () => google.close());
  const base = `http://127.0.0.1:${server.port}`;

  await json(base, "/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password: PASSWORD } });
  const ownerCookie = (await json(base, "/api/auth/login", { method: "POST", body: { email: "o@example.com", password: PASSWORD } })).cookie!;
  const join = async (role: string, email: string) => {
    const invite = await json(base, "/api/invites", { method: "POST", cookie: ownerCookie, body: { workspaceId: "default", role } });
    const token = String(invite.body.url).split("/invite/")[1]!;
    return (await json(base, `/api/invites/${token}/accept`, { method: "POST", body: { name: email, email, password: PASSWORD } })).cookie!;
  };
  const memberCookie = await join("member", "m@example.com");
  const viewerCookie = await join("viewer", "v@example.com");
  return { base, ws: `ws://127.0.0.1:${server.port}`, google, logs, ownerCookie, memberCookie, viewerCookie };
}

describe("/api/connectors behind the identity gate", () => {
  it("enforces who may set up apps, connect personal or shared accounts, and finishes OAuth only for the same session", async () => {
    const { base, ws, google, logs, ownerCookie, memberCookie, viewerCookie } = await start();

    // Viewers have no integrations.use.
    expect((await json(base, "/api/connectors", { cookie: viewerCookie })).status).toBe(403);
    // Not signed in.
    expect((await json(base, "/api/connectors")).status).toBe(401);

    const state = await json(base, "/api/connectors", { cookie: memberCookie });
    expect(state.status).toBe(200);
    expect(state.body.connectors.map((c: { id: string }) => c.id)).toEqual(["google", "microsoft", "hubspot", "salesforce"]);
    expect(state.body.connectors.find((c: { id: string }) => c.id === "hubspot")).toMatchObject({ edition: "enterprise", available: false, feature: "connector_hubspot" });
    expect(state.body.can).toEqual({ use: true, connectPersonal: true, connectShared: false, manageApps: false });
    expect(state.body.connectors[0].app.redirectUri).toBe(`${base}/api/connectors/oauth/callback`);

    // Apps: organization owners/admins only (the gate answers 403 before the handler).
    expect((await json(base, "/api/connectors/apps/google", { method: "PUT", cookie: memberCookie, body: { clientId: "gid", clientSecret: "x" } })).status).toBe(403);
    const saved = await json(base, "/api/connectors/apps/google", { method: "PUT", cookie: ownerCookie, body: { clientId: "gid", clientSecret: "google-secret-value" } });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain("google-secret-value");

    // Enterprise connectors need the licence.
    expect((await json(base, "/api/connectors/hubspot/connect", { method: "POST", cookie: memberCookie, body: { scope: "personal" } })).status).toBe(402);

    // Members can't share with the workspace; they can connect for themselves.
    const shared = await json(base, "/api/connectors/google/connect", { method: "POST", cookie: memberCookie, body: { scope: "workspace" } });
    expect(shared.status).toBe(403);
    const begun = await json(base, "/api/connectors/google/connect", { method: "POST", cookie: memberCookie, body: { scope: "personal", groups: ["gmail_read"] } });
    expect(begun.status).toBe(200);
    const params = authorizeParams(begun.body.authorizeUrl);

    // Someone else's browser can't finish the member's flow.
    const hijack = await json(base, `/api/connectors/oauth/callback?state=${params.state}&code=${google.approve(params.challenge)}`, { cookie: ownerCookie });
    expect(hijack.status).toBe(403);
    expect(hijack.text).toContain("someone else");

    const again = authorizeParams((await json(base, "/api/connectors/google/connect", { method: "POST", cookie: memberCookie, body: { scope: "personal", groups: ["gmail_read"] } })).body.authorizeUrl);
    const socket = new WebSocket(ws, { headers: { cookie: memberCookie } });
    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    cleanup.push(() => socket.close());
    socket.send(JSON.stringify({ type: INTEGRATIONS_EVENTS.REQUEST }));

    const done = await json(base, `/api/connectors/oauth/callback?state=${again.state}&code=${google.approve(again.challenge)}`, { cookie: memberCookie });
    expect(done.status).toBe(200);
    expect(done.text).toContain("Connected");
    expect(done.text).toContain("max@example.com");

    // Live status on the socket.
    const deadline = Date.now() + 3000;
    let pushed: IntegrationsStateMessage | undefined;
    while (Date.now() < deadline && !pushed) {
      pushed = messages.find((m): m is IntegrationsStateMessage => m.type === INTEGRATIONS_EVENTS.STATE && (m as IntegrationsStateMessage).connections.length === 1);
      if (!pushed) await new Promise((r) => setTimeout(r, 20));
    }
    expect(pushed?.connections[0]).toMatchObject({ connectorId: "google", scope: "personal", mine: true, status: "connected", account: "max@example.com" });

    // No token, refresh token or client secret anywhere the browser, the socket or the logs can see.
    const secrets = [...google.issued.flatMap((t) => [t.access, t.refresh!]), "google-secret-value"];
    const visible = JSON.stringify(messages) + JSON.stringify((await json(base, "/api/connectors", { cookie: memberCookie })).body) + logs.join("\n");
    for (const value of secrets) expect(visible).not.toContain(value);

    // The owner doesn't see the member's personal connection.
    expect((await json(base, "/api/connectors", { cookie: ownerCookie })).body.connections).toEqual([]);
    const id = pushed!.connections[0]!.id;
    expect((await json(base, `/api/connectors/connections/${id}`, { method: "DELETE", cookie: ownerCookie })).status).toBe(404);
    expect((await json(base, `/api/connectors/connections/${id}`, { method: "DELETE", cookie: memberCookie })).status).toBe(200);
    expect(google.revoked.length).toBe(1);
  });
});
