import assert from "node:assert/strict";
import type { LLMProvider, STTProvider, ToolChatOptions, ToolChatProvider } from "@open-gpt-live/adapters";
import { DEFAULT_WORKSPACE_ID, createMemoryStore, type Store, type ToolDefinition } from "@open-gpt-live/core";
import { IDENTITY_EVENTS, WS_EVENTS, type AuthMeResponse, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayServerHandle } from "../gateway.js";
import { createTestRuntime } from "../runtime.js";
import { hashPassword, verifyPassword } from "./crypto.js";
import { LoginRateLimiter } from "./rate-limit.js";
import { IdentityError, IdentityService } from "./service.js";
import { permissionForMessage, permissionTable } from "./ws.js";

const PASSWORD = "correct horse battery";

async function freshService(store: Store = createMemoryStore(), ownerToken?: string) {
  let n = 0;
  const identity = new IdentityService({ store, orgId: "owner", ...(ownerToken ? { ownerToken } : {}), createId: () => `id${++n}` });
  return { store, identity };
}

/** Owner + a member invited into "default" with `role`. */
async function withPeople(role: "admin" | "member" | "viewer" = "member") {
  const { store, identity } = await freshService();
  const owner = await identity.setup({ email: "owner@example.com", name: "Olive", password: PASSWORD }, { ownerTokenOk: false });
  const ownerAuth = (await identity.resolveSession(owner.token))!;
  const { url } = await identity.createInvite(ownerAuth.principal, { workspaceId: DEFAULT_WORKSPACE_ID, role }, "http://app");
  const token = url.split("/invite/")[1]!;
  const joined = await identity.acceptInvite(token, { name: "Max", email: "max@example.com", password: PASSWORD }, undefined);
  const memberAuth = (await identity.resolveSession(joined.token!))!;
  return { store, identity, owner, ownerAuth, member: joined, memberAuth };
}

describe("passwords", () => {
  it("hashes with scrypt and a per-user salt", async () => {
    const a = await hashPassword("secret password");
    const b = await hashPassword("secret password");
    expect(a).toMatch(/^scrypt\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("secret password", a)).toBe(true);
    expect(await verifyPassword("wrong password", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("rate-limits failed logins per IP + email", () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ perAccount: 3, now: () => now });
    for (let i = 0; i < 3; i += 1) limiter.fail("1.1.1.1", "a@x.io");
    expect(limiter.retryAfter("1.1.1.1", "a@x.io")).toBeGreaterThan(0);
    expect(limiter.retryAfter("1.1.1.1", "b@x.io")).toBe(0);
    now += 16 * 60_000;
    expect(limiter.retryAfter("1.1.1.1", "a@x.io")).toBe(0);
  });
});

describe("IdentityService", () => {
  it("runs in local mode until the owner account exists, then only once", async () => {
    const { identity } = await freshService();
    expect(await identity.mode()).toBe("local");
    expect((await identity.authenticate({}))?.principal.kind).toBe("local");
    await identity.setup({ email: "Owner@Example.com", name: "", password: PASSWORD }, { ownerTokenOk: false });
    expect(await identity.mode()).toBe("signin");
    expect(await identity.authenticate({})).toBeUndefined();
    await expect(identity.setup({ email: "b@example.com", name: "B", password: PASSWORD }, { ownerTokenOk: true })).rejects.toMatchObject({ code: "already_set_up" });
  });

  it("needs the owner token for setup when SIBYL_OWNER_TOKEN is set, and keeps the token working", async () => {
    const { identity } = await freshService(createMemoryStore(), "tok");
    expect(await identity.mode()).toBe("setup");
    expect(await identity.authenticate({})).toBeUndefined();
    expect((await identity.authenticate({ bearerToken: "tok" }))?.principal).toMatchObject({ kind: "token", orgRole: "owner" });
    await expect(identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false })).rejects.toMatchObject({ code: "owner_token_required" });
    await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: true });
    expect((await identity.authenticate({ bearerToken: "tok" }))?.principal.kind).toBe("token");
  });

  it("signs in, rejects wrong passwords and limits attempts", async () => {
    const { identity } = await freshService();
    await identity.setup({ email: "o@example.com", name: "O", password: PASSWORD }, { ownerTokenOk: false });
    const ok = (await identity.login({ email: " O@EXAMPLE.com", password: PASSWORD }, "ip")) as { token: string };
    expect((await identity.resolveSession(ok.token))?.principal).toMatchObject({ kind: "user", orgRole: "owner", workspaceRoles: { default: "owner" } });
    for (let i = 0; i < 5; i += 1) {
      await expect(identity.login({ email: "o@example.com", password: "wrong wrong" }, "ip")).rejects.toMatchObject({ code: "invalid_credentials" });
    }
    await expect(identity.login({ email: "o@example.com", password: PASSWORD }, "ip")).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await identity.logout(ok.token);
    expect(await identity.resolveSession(ok.token)).toBeUndefined();
  });

  it("invites are one-time and carry the workspace and role", async () => {
    const { identity, ownerAuth, memberAuth } = await withPeople("viewer");
    expect(memberAuth.principal).toMatchObject({ orgRole: "member", workspaceRoles: { default: "viewer" } });
    const { url } = await identity.createInvite(ownerAuth.principal, { workspaceId: "default", role: "member", email: "z@example.com" }, "http://app");
    const token = url.split("/invite/")[1]!;
    expect(await identity.previewInvite(token)).toMatchObject({ role: "member", email: "z@example.com", status: "pending", invitedByName: "Olive" });
    await expect(identity.acceptInvite(token, { email: "other@example.com", name: "Z", password: PASSWORD }, undefined)).rejects.toMatchObject({ code: "wrong_email" });
    await identity.acceptInvite(token, { name: "Z", password: PASSWORD }, undefined);
    await expect(identity.acceptInvite(token, { name: "Z2", password: PASSWORD }, undefined)).rejects.toMatchObject({ code: "invite_used" });
    expect((await identity.previewInvite(token)).status).toBe("accepted");
  });

  it("a member can't invite or manage members; an admin can't promote above themselves", async () => {
    const { identity, ownerAuth, memberAuth, member } = await withPeople("member");
    await expect(identity.createInvite(memberAuth.principal, { workspaceId: "default", role: "viewer" }, "http://app")).rejects.toMatchObject({ status: 403 });
    await expect(identity.setMemberRole(memberAuth.principal, "default", member.user.id, "admin")).rejects.toMatchObject({ status: 403 });
    await expect(identity.removeMember(memberAuth.principal, "default", ownerAuth.principal.userId!)).rejects.toMatchObject({ status: 403 });
    await identity.setMemberRole(ownerAuth.principal, "default", member.user.id, "admin");
    const admin = (await identity.refresh(memberAuth))!;
    await expect(identity.setMemberRole(admin.principal, "default", member.user.id, "owner")).rejects.toMatchObject({ status: 403 });
    await expect(identity.setMemberRole(admin.principal, "default", ownerAuth.principal.userId!, "viewer")).rejects.toMatchObject({ status: 403 });
  });

  it("never removes or demotes the last owner", async () => {
    const { identity, ownerAuth, member } = await withPeople("member");
    const ws = await identity.createWorkspace(ownerAuth.principal, { name: "Sales" });
    // The creator is the workspace owner and the org owner: no one else is.
    await expect(identity.setMemberRole(ownerAuth.principal, ws.id, ownerAuth.principal.userId!, "member")).rejects.toMatchObject({ code: "last_owner" });
    await expect(identity.removeMember(ownerAuth.principal, ws.id, ownerAuth.principal.userId!)).rejects.toMatchObject({ code: "last_owner" });
    await identity.setMemberRole(ownerAuth.principal, ws.id, member.user.id, "owner");
    await identity.removeMember(ownerAuth.principal, ws.id, ownerAuth.principal.userId!);
  });

  it("denies cross-workspace access and protects the default workspace", async () => {
    const { identity, ownerAuth, memberAuth } = await withPeople("member");
    const sales = await identity.createWorkspace(ownerAuth.principal, { name: "Sales" });
    expect((await identity.listWorkspaces(memberAuth.principal)).map((w) => w.id)).toEqual(["default"]);
    await expect(identity.listMembers(memberAuth.principal, sales.id)).rejects.toMatchObject({ status: 404 });
    await expect(identity.updateWorkspace(memberAuth.principal, sales.id, { name: "Mine" })).rejects.toMatchObject({ status: 404 });
    await expect(identity.createWorkspace(memberAuth.principal, { name: "Nope" })).rejects.toMatchObject({ status: 403 });
    await expect(identity.deleteWorkspace(ownerAuth.principal, "default")).rejects.toMatchObject({ code: "default_workspace" });
    await identity.updateWorkspace(ownerAuth.principal, sales.id, { name: "Sales EU", instructions: "Be brief." });
    await identity.deleteWorkspace(ownerAuth.principal, sales.id);
    expect((await identity.listWorkspaces(ownerAuth.principal)).map((w) => w.id)).toEqual(["default"]);
  });

  it("IdentityError carries an HTTP status", () => {
    expect(new IdentityError(409, "x", "y").status).toBe(409);
  });
});

describe("WebSocket permission map", () => {
  it("maps every message type, with chat.use as the fallback", () => {
    expect(permissionForMessage(WS_EVENTS.APPROVAL_DECISION)).toBe("tools.write");
    expect(permissionForMessage("secret.update")).toBe("secrets.manage");
    expect(permissionForMessage("something.new")).toBe("chat.use");
    expect(permissionTable().length).toBeGreaterThan(20);
  });
});

/* ───────────── end to end through the gateway ───────────── */

const catalog: ModelCatalog = {
  llm: [
    { id: "brain/deep", label: "Deep" },
    { id: "brain/other", label: "Other" }
  ],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [{ id: "tts/plain", label: "Plain", voices: ["a"] }]
};

const servers: GatewayServerHandle[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function startGateway(store: Store, toolRequests: ToolChatOptions[] = []) {
  const runtime = createTestRuntime({ store });
  const writeTool: ToolDefinition = {
    name: "send_email",
    title: "Send an email",
    description: "Sends an email.",
    inputSchema: { type: "object", properties: {} },
    effect: "write",
    source: "builtin",
    run: async () => ({ content: "sent" })
  };
  const readTool: ToolDefinition = { ...writeTool, name: "search", title: "Search", effect: "read", run: async () => ({ content: "found" }) };
  runtime.tools.register(writeTool);
  runtime.tools.register(readTool);
  const llm: LLMProvider = {
    async *streamText() {
      yield { delta: "hello" };
    }
  };
  const stt: STTProvider = { transcribe: async () => ({ text: "x" }) };
  const toolLlm: ToolChatProvider = {
    async *streamWithTools(_messages, options = {}) {
      toolRequests.push(options);
      yield { type: "text", delta: "ok" };
    }
  };
  const server = await createGatewayServer({
    providers: { llm, stt, toolLlm },
    port: 0,
    host: "127.0.0.1",
    runtime,
    modelCatalog: catalog,
    defaultSettings: { llmModel: "brain/deep", sttModel: "stt/x" }
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, ws: `ws://127.0.0.1:${server.port}`, runtime };
}

async function json(base: string, path: string, init: { method?: string; body?: unknown; cookie?: string; workspace?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.workspace ? { "x-sibyl-workspace": init.workspace } : {})
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, body: (await response.json()) as any, cookie: setCookie ? setCookie.split(";")[0]! : undefined, setCookie };
}

async function openSocket(url: string, cookie?: string) {
  const socket = new WebSocket(url, cookie ? { headers: { cookie } } : {});
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const waitFor = async (predicate: (m: ServerMessage) => boolean, ms = 3000): Promise<ServerMessage> => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out; got ${messages.map((m) => m.type).join(", ")}`);
  };
  return { socket, messages, waitFor, send: (m: unknown) => socket.send(JSON.stringify(m)) };
}

function rejected(url: string, cookie?: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, cookie ? { headers: { cookie } } : {});
    socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
  });
}

describe("gateway with accounts", () => {
  it("first-run setup, cookie sessions, login and logout", async () => {
    const { base, ws } = await startGateway(createMemoryStore());
    // Local mode: works like before (no sign-in) until the owner account exists.
    expect((await json(base, "/api/auth/me")).body).toMatchObject({ authenticated: true, mode: "local", setupAvailable: true });
    expect(await rejected(ws)).toBe(101);

    const setup = await json(base, "/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password: PASSWORD } });
    expect(setup.status).toBe(201);
    expect(setup.setCookie).toMatch(/sibyl_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
    expect((setup.body as AuthMeResponse).user).toMatchObject({ email: "o@example.com" });

    // Now people must sign in.
    expect((await json(base, "/api/auth/me")).body).toMatchObject({ authenticated: false, next: "login" });
    expect(await rejected(ws)).toBe(401);
    expect((await json(base, "/api/auth/setup", { method: "POST", body: { email: "x@example.com", password: PASSWORD } })).status).toBe(409);

    const bad = await json(base, "/api/auth/login", { method: "POST", body: { email: "o@example.com", password: "nope nope" } });
    expect(bad.status).toBe(401);
    const login = await json(base, "/api/auth/login", { method: "POST", body: { email: "o@example.com", password: PASSWORD } });
    expect(login.status).toBe(200);
    const me = await json(base, "/api/auth/me", { cookie: login.cookie! });
    expect(me.body).toMatchObject({ authenticated: true, principal: "user", orgRole: "owner" });
    expect(me.body.permissions.default).toContain("members.manage");

    const client = await openSocket(ws, login.cookie);
    const identity = await client.waitFor((m) => m.type === IDENTITY_EVENTS.SESSION_IDENTITY);
    expect(identity).toMatchObject({ workspaceId: "default", role: "owner", principal: "user" });
    client.socket.close();

    await json(base, "/api/auth/logout", { method: "POST", cookie: login.cookie! });
    expect((await json(base, "/api/auth/me", { cookie: login.cookie! })).body.authenticated).toBe(false);
    expect(await rejected(ws, login.cookie)).toBe(401);
  });

  it("keeps SIBYL_OWNER_TOKEN working as an owner-level API principal", async () => {
    const runtime = createTestRuntime();
    const llm: LLMProvider = { async *streamText() { yield { delta: "hi" }; } };
    const server = await createGatewayServer({
      providers: { llm, stt: { transcribe: async () => ({ text: "" }) } },
      port: 0,
      host: "127.0.0.1",
      runtime,
      ownerToken: "secret-token"
    });
    servers.push(server);
    const ws = `ws://127.0.0.1:${server.port}`;
    expect(await rejected(ws)).toBe(401);
    expect(await rejected(`${ws}?token=wrong`)).toBe(401);
    expect(await rejected(`${ws}?token=secret-token`)).toBe(101);
    const base = `http://127.0.0.1:${server.port}`;
    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer secret-token" } }).then((r) => r.json());
    expect(me).toMatchObject({ authenticated: true, principal: "token", next: "setup", ownerTokenRequired: true });
    const memory = await fetch(`${base}/api/memory`);
    expect(memory.status).toBe(401);
  });

  it("a viewer can chat but can't change models, decide approvals, run write tools or edit memory", async () => {
    const store = createMemoryStore();
    const toolRequests: ToolChatOptions[] = [];
    const { base, ws } = await startGateway(store, toolRequests);
    await json(base, "/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password: PASSWORD } });
    const ownerCookie = (await json(base, "/api/auth/login", { method: "POST", body: { email: "o@example.com", password: PASSWORD } })).cookie!;
    const invite = await json(base, "/api/invites", { method: "POST", cookie: ownerCookie, body: { workspaceId: "default", role: "viewer" } });
    expect(invite.status).toBe(201);
    expect(invite.body.url).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
    const token = String(invite.body.url).split("/invite/")[1]!;
    expect((await json(base, `/api/invites/${token}`)).body).toMatchObject({ role: "viewer", status: "pending" });
    const accepted = await json(base, `/api/invites/${token}/accept`, { method: "POST", body: { name: "Vic", email: "v@example.com", password: PASSWORD } });
    expect(accepted.status).toBe(200);
    const viewerCookie = accepted.cookie!;

    const viewer = await openSocket(ws, viewerCookie);
    await viewer.waitFor((m) => m.type === IDENTITY_EVENTS.SESSION_IDENTITY && (m as { role?: string }).role === "viewer");
    // Model choice is a member's call; the session keeps the default.
    viewer.send({ type: WS_EVENTS.SESSION_UPDATE, settings: { llmModel: "brain/other" } });
    await viewer.waitFor((m) => m.type === "error" && /change models/.test((m as { message: string }).message));
    viewer.send({ type: WS_EVENTS.APPROVAL_DECISION, id: "a1", decision: "approve" });
    await viewer.waitFor((m) => m.type === "error" && /permission/.test((m as { message: string }).message));
    viewer.send({ type: "secret.delete", name: "API_KEY" });
    await viewer.waitFor((m) => m.type === "error" && (m as { message: string }).message.includes("permission") && viewer.messages.filter((x) => x.type === "error").length >= 3);
    // Typed chat works, without write tools on offer.
    viewer.send({ type: WS_EVENTS.USER_TEXT, requestId: "t1", text: "hello" });
    await viewer.waitFor((m) => m.type === WS_EVENTS.LLM_DONE);
    assert.ok(toolRequests.length > 0);
    const offered = (toolRequests[0]!.tools ?? []).map((tool) => tool.function.name);
    expect(offered).toContain("search");
    expect(offered).not.toContain("send_email");
    viewer.socket.close();

    // HTTP: reading memory is fine, changing it is not.
    expect((await json(base, "/api/memory", { cookie: viewerCookie })).status).toBe(200);
    expect((await json(base, "/api/memory", { method: "POST", cookie: viewerCookie, body: { text: "x" } })).status).toBe(403);
    expect((await json(base, "/api/slides/spaces", { method: "POST", cookie: viewerCookie, body: { name: "x" } })).status).toBe(403);
    // A viewer (org member) can't manage members or invite.
    expect((await json(base, "/api/invites", { method: "POST", cookie: viewerCookie, body: { workspaceId: "default", role: "viewer" } })).status).toBe(403);
  });

  it("denies cross-workspace access over HTTP and WebSocket", async () => {
    const store = createMemoryStore();
    const { base, ws } = await startGateway(store);
    await json(base, "/api/auth/setup", { method: "POST", body: { email: "o@example.com", name: "Olive", password: PASSWORD } });
    const ownerCookie = (await json(base, "/api/auth/login", { method: "POST", body: { email: "o@example.com", password: PASSWORD } })).cookie!;
    const sales = (await json(base, "/api/workspaces", { method: "POST", cookie: ownerCookie, body: { name: "Sales" } })).body.workspace;
    expect(sales.id).toMatch(/^ws_/);
    const invite = await json(base, "/api/invites", { method: "POST", cookie: ownerCookie, body: { workspaceId: sales.id, role: "member" } });
    const token = String(invite.body.url).split("/invite/")[1]!;
    const memberCookie = (await json(base, `/api/invites/${token}/accept`, { method: "POST", body: { name: "Sam", email: "s@example.com", password: PASSWORD } })).cookie!;

    // The owner chats in the default workspace.
    await store.conversations.upsert({ id: "c-default", ownerId: "owner", title: "Secret plans", createdAt: 1, updatedAt: 1, messages: [] });

    const me = (await json(base, "/api/auth/me", { cookie: memberCookie })).body as AuthMeResponse;
    expect(me.workspaces.map((w) => w.id)).toEqual([sales.id]);
    expect((await json(base, "/api/workspaces/default/members", { cookie: memberCookie })).status).toBe(404);
    expect((await json(base, "/api/memory", { cookie: memberCookie })).status).toBe(403);
    expect((await json(base, "/api/memory", { cookie: memberCookie, workspace: sales.id })).status).toBe(200);
    // A member can't manage members, even in their own workspace.
    expect((await json(base, `/api/workspaces/${sales.id}/members/${me.user!.id}`, { method: "PATCH", cookie: memberCookie, body: { role: "admin" } })).status).toBe(403);

    const member = await openSocket(ws, memberCookie);
    await member.waitFor((m) => m.type === IDENTITY_EVENTS.SESSION_IDENTITY && (m as { workspaceId: string }).workspaceId === sales.id);
    member.send({ type: IDENTITY_EVENTS.SESSION_WORKSPACE, workspaceId: "default" });
    await member.waitFor((m) => m.type === "error" && /not a member/.test((m as { message: string }).message));
    member.send({ type: WS_EVENTS.CONVERSATION_OPEN, conversationId: "c-default" });
    await member.waitFor((m) => m.type === "error" && /not found/i.test((m as { message: string }).message));
    member.send({ type: WS_EVENTS.CONVERSATIONS_REQUEST });
    const list = await member.waitFor((m) => m.type === WS_EVENTS.CONVERSATIONS_LIST);
    expect((list as { items: unknown[] }).items).toEqual([]);

    // Removing them from the workspace ends their access right away.
    const removed = await json(base, `/api/workspaces/${sales.id}/members/${me.user!.id}`, { method: "DELETE", cookie: ownerCookie });
    expect(removed.status).toBe(200);
    await member.waitFor((m) => m.type === IDENTITY_EVENTS.SESSION_IDENTITY && (m as { permissions: string[] }).permissions.length === 0);
    member.socket.close();
  });
});
