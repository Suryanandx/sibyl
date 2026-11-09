import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryStore, DEFAULT_WORKSPACE_ID, ORG_SETTINGS_KV_KEY, type IdentityBridge, type Store } from "../../../packages/core/src/index";
import { afterEach, describe, expect, it } from "vitest";
import { identityContext } from "../directory/context";
import { scimRoutes } from "./http";
import { parseFilter } from "./service";
import { ScimTokens } from "./tokens";

const ORG = "owner";
const setupContext = async (store: Store) => ({ context: identityContext({ store, ownerId: ORG, log: () => undefined, env: {} }) });
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function setup() {
  const store = createMemoryStore();
  for (const id of [DEFAULT_WORKSPACE_ID, "ws_eng"]) await store.workspaces.upsert({ id, ownerId: ORG, name: id, createdAt: 0, updatedAt: 0 });
  await store.identity.users.upsert({ id: "boss", orgId: ORG, email: "boss@acme.test", name: "Boss", passwordHash: "scrypt$x", createdAt: 0 });
  await store.identity.memberships.upsert(ORG, { userId: "boss", scope: "org", role: "owner" });
  const ended: string[] = [];
  const context = identityContext({ store, ownerId: ORG, log: () => undefined, env: {} });
  let base = "";
  context.setBridge({
    orgId: ORG,
    allowedOrigins: [],
    gatewayUrl: () => base,
    changed: () => undefined,
    endSessions: async (userId: string) => void ended.push(userId),
    authenticate: async () => undefined
  } as unknown as IdentityBridge);
  await context.directory.updateSettings({ groupRoles: [{ group: "Engineers", workspaceId: "ws_eng", role: "admin" }] });
  const tokens = new ScimTokens({ store, orgId: ORG });
  const { secret } = await tokens.create("test");
  const route = scimRoutes(context, tokens);
  const server = createServer((request, response) => {
    if (!route(request, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scim = async (method: string, path: string, body?: unknown, token = secret) => {
    const response = await fetch(`${base}/scim/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  return { store, scim, ended, tokens };
}

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

describe("SCIM filters", () => {
  it("accepts attribute eq \"value\" only", () => {
    expect(parseFilter('userName eq "a@b.test"', ["username"])).toEqual(["username", "a@b.test"]);
    expect(parseFilter('userName Eq "a\\"b"', ["username"])).toEqual(["username", 'a"b']);
    expect(() => parseFilter('userName sw "a"', ["username"])).toThrow(/eq/);
    expect(() => parseFilter('title eq "x"', ["username"])).toThrow(/not supported/);
  });
});

describe("SCIM 2.0", () => {
  it("needs a valid bearer token (hashed at rest)", async () => {
    const { scim, store } = await setup();
    expect((await scim("GET", "/Users", undefined, "scim_nope")).status).toBe(401);
    expect(JSON.stringify(await store.kv.get(ORG, "ee.scim.v1"))).not.toMatch(/scim_[A-Za-z0-9_-]{20,}/);
    expect((await scim("GET", "/ServiceProviderConfig")).body.patch).toEqual({ supported: true });
  });

  it("creates, finds, replaces, patches and deactivates users", async () => {
    const { scim, store, ended } = await setup();
    const created = await scim("POST", "/Users", { schemas: [USER], userName: "Ann@Acme.test", externalId: "e1", name: { givenName: "Ann", familyName: "Lee" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userName: "ann@acme.test", displayName: "Ann Lee", active: true, externalId: "e1" });
    const id = created.body.id as string;
    expect((await store.identity.memberships.listForUser(ORG, id)).map((m) => m.role)).toEqual(["member", "member"]);

    expect((await scim("POST", "/Users", { schemas: [USER], userName: "ann@acme.test" })).body.scimType).toBe("uniqueness");
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "ANN@acme.test"')}`)).body.totalResults).toBe(1);
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "e1"')}`)).body.Resources[0].id).toBe(id);
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "zz@acme.test"')}`)).body.totalResults).toBe(0);
    expect((await scim("GET", "/Users?startIndex=2&count=1")).body).toMatchObject({ totalResults: 2, itemsPerPage: 1, startIndex: 2 });

    const replaced = await scim("PUT", `/Users/${id}`, { schemas: [USER], userName: "ann.lee@acme.test", displayName: "Ann L.", active: true });
    expect(replaced.body).toMatchObject({ userName: "ann.lee@acme.test", displayName: "Ann L." });

    // Okta form.
    let patched = await scim("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] });
    expect(patched.body.active).toBe(false);
    expect(ended).toEqual([id]);
    // Entra form ("False" as a string, capitalised op).
    patched = await scim("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: "True" }] });
    expect(patched.body.active).toBe(true);
    expect((await scim("PATCH", `/Users/${id}`, { Operations: [{ op: "replace", path: "active", value: false }] })).status).toBe(400);

    expect((await scim("DELETE", `/Users/${id}`)).status).toBe(204);
    expect((await scim("GET", `/Users/${id}`)).body.active).toBe(false);
    expect((await scim("GET", "/Users/nope")).status).toBe(404);
    // The last owner can't be turned off.
    expect((await scim("DELETE", "/Users/boss")).status).toBe(409);
  });

  it("provisions someone removed from the organization again: same id, a fresh account", async () => {
    const { scim, store } = await setup();
    const first = await scim("POST", "/Users", { schemas: [USER], userName: "carl@acme.test", externalId: "old-ext" });
    const id = first.body.id as string;
    await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Engineers", members: [{ value: id }] });
    // Admin → Users → Remove (what the open-source org service does).
    for (const m of await store.identity.memberships.listForUser(ORG, id)) await store.identity.memberships.remove(ORG, id, m.scope);
    await store.identity.users.upsert({ ...(await store.identity.users.get(ORG, id))!, disabledAt: 5, removedAt: 5 });
    expect((await scim("GET", `/Users/${id}`)).status).toBe(404);
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('userName eq "carl@acme.test"')}`)).body.totalResults).toBe(0);

    const again = await scim("POST", "/Users", { schemas: [USER], userName: "carl@acme.test", externalId: "new-ext" });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id, userName: "carl@acme.test", active: true, externalId: "new-ext", groups: [] });
    const user = (await store.identity.users.get(ORG, id))!;
    expect(user.removedAt).toBeUndefined();
    expect(user.disabledAt).toBeUndefined();
    // Only the default access, nothing of the old group's admin role.
    expect((await store.identity.memberships.listForUser(ORG, id)).map((m) => (m.scope === "org" ? "org" : m.scope.workspaceId)).sort()).toEqual([DEFAULT_WORKSPACE_ID, "org"]);
    expect((await scim("GET", `/Users?filter=${encodeURIComponent('externalId eq "old-ext"')}`)).body.totalResults).toBe(0);
    // A live account still can't be created twice.
    expect((await scim("POST", "/Users", { schemas: [USER], userName: "carl@acme.test" })).status).toBe(409);
  });

  it("new accounts follow Admin → Organization's defaults until the directory sets its own", async () => {
    const { scim, store } = await setup();
    const landing = async (email: string) => {
      const id = (await scim("POST", "/Users", { schemas: [USER], userName: email })).body.id as string;
      return (await store.identity.memberships.listForUser(ORG, id)).filter((m) => m.scope !== "org").map((m) => [(m.scope as { workspaceId: string }).workspaceId, m.role]);
    };
    expect(await landing("d1@acme.test")).toEqual([[DEFAULT_WORKSPACE_ID, "member"]]);
    // Changed later in Admin → Organization: SCIM accounts follow.
    await store.kv.set(ORG, ORG_SETTINGS_KV_KEY, { defaultWorkspaceId: "ws_eng", defaultRole: "viewer" });
    expect(await landing("d2@acme.test")).toEqual([["ws_eng", "viewer"]]);
    const { context } = await setupContext(store);
    expect(await context.directory.settingsView()).toMatchObject({ defaultWorkspaceId: "ws_eng", defaultRole: "viewer", followsOrganization: { workspace: true, role: true } });
    // The directory's own choice wins, until it is set back to follow (null).
    await context.directory.updateSettings({ defaultRole: "admin" });
    expect(await landing("d3@acme.test")).toEqual([["ws_eng", "admin"]]);
    await context.directory.updateSettings({ defaultRole: null });
    expect(await landing("d4@acme.test")).toEqual([["ws_eng", "viewer"]]);
  });

  it("older saved settings keep only what differs from the defaults", async () => {
    const store = createMemoryStore();
    // Saved before: the workspace and role were written every time.
    await store.kv.set(ORG, "ee.directory.v1", { settings: { defaultWorkspaceId: DEFAULT_WORKSPACE_ID, defaultRole: "admin", jitProvisioning: false, groupRoles: [] }, users: {}, groups: {} });
    await store.kv.set(ORG, ORG_SETTINGS_KV_KEY, { defaultWorkspaceId: "ws_eng", defaultRole: "viewer" });
    const { context } = await setupContext(store);
    expect(await context.directory.settingsView()).toMatchObject({ defaultWorkspaceId: "ws_eng", defaultRole: "admin", jitProvisioning: false, followsOrganization: { workspace: true, role: false } });
  });

  it("groups map to workspace roles", async () => {
    const { scim, store } = await setup();
    const a = (await scim("POST", "/Users", { schemas: [USER], userName: "a@acme.test" })).body.id as string;
    const b = (await scim("POST", "/Users", { schemas: [USER], userName: "b@acme.test" })).body.id as string;
    const roleIn = async (userId: string) => (await store.identity.memberships.listForUser(ORG, userId)).find((m) => m.scope !== "org" && m.scope.workspaceId === "ws_eng")?.role;

    const group = await scim("POST", "/Groups", { schemas: [GROUP], displayName: "engineers", members: [{ value: a }] });
    expect(group.status).toBe(201);
    expect(await roleIn(a)).toBe("admin");
    const gid = group.body.id as string;
    await scim("PATCH", `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: b }] }] });
    expect(await roleIn(b)).toBe("admin");
    await scim("PATCH", `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: "remove", path: `members[value eq "${a}"]` }] });
    expect(await roleIn(a)).toBeUndefined();
    expect((await scim("GET", `/Groups?filter=${encodeURIComponent('displayName eq "Engineers"')}&excludedAttributes=members`)).body.Resources[0]).not.toHaveProperty("members");
    expect((await scim("GET", `/Users/${b}`)).body.groups).toEqual([expect.objectContaining({ value: gid, display: "engineers" })]);
    expect((await scim("POST", "/Groups", { schemas: [GROUP], displayName: "Engineers" })).status).toBe(409);
    expect((await scim("DELETE", `/Groups/${gid}`)).status).toBe(204);
    expect(await roleIn(b)).toBeUndefined();
  });
});
