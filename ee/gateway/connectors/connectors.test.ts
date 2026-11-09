/**
 * Sibyl Enterprise — tests for the HubSpot and Salesforce connectors and
 * their licence gating. Licensed under the Sibyl Enterprise License.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createEnterpriseRegistry, createFeatureGate, type FeatureId } from "../../../packages/core/src/features";
import { createMemoryStore } from "../../../packages/core/src/store";
import { createGovernance } from "../../../packages/core/src/governance";
import { createToolRegistry, type ToolContext, type ToolRegistry } from "../../../packages/core/src/tools";
import type { Principal } from "../../../packages/core/src/permissions";
import { googleConnector } from "../../../apps/gateway/src/connectors/google/index";
import { microsoftConnector } from "../../../apps/gateway/src/connectors/microsoft/index";
import { ConnectorService, type EndpointOverride } from "../../../apps/gateway/src/connectors/service";
import { authorizeParams, startFakeVendor, userPrincipal, type FakeVendor } from "../../../apps/gateway/src/connectors/testing";
import { SecretVault } from "../../../apps/gateway/src/secrets/vault";
import registerEnterprise from "../index";

const owner = userPrincipal("u-owner", { default: "owner" }, "owner");
const member = userPrincipal("u-member", { default: "member" }, "member");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function gate(features: FeatureId[]) {
  return createFeatureGate({
    valid: true,
    payload: { licensee: "Acme", edition: "enterprise", seats: 10, features, issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }
  });
}

async function setup(features: FeatureId[], endpoints: Record<string, EndpointOverride> = {}) {
  const store = createMemoryStore();
  const key = randomBytes(32);
  const vault = new SecretVault({ store, key });
  const tools: ToolRegistry = createToolRegistry();
  const service = await new ConnectorService({ store, ownerId: "owner", key, vault, tools, builtins: [googleConnector, microsoftConnector], env: {}, log() {}, endpoints, sleep: async () => {} }).init();
  const registry = createEnterpriseRegistry();
  registerEnterprise(registry);
  const installed = await registry.install({
    gate: gate(features),
    ownerId: "owner",
    env: {},
    store,
    tools,
    meter: { record() {}, totals: () => ({ todayUsd: 0, monthUsd: 0, sessionUsd: 0, byFeature: {} }), check: () => ({ allowed: true }), limits: () => ({}) },
    log() {},
    governance: createGovernance({ orgId: "owner" })
  });
  cleanup.push(() => service.close(), () => vault.close(), () => installed.close());
  return { service, tools, installed, vault };
}

function context(principal: Principal): ToolContext {
  return {
    signal: new AbortController().signal,
    ownerId: "owner",
    runId: "r",
    principal,
    workspaceId: "default",
    store: createMemoryStore(),
    meter: { record() {}, totals: () => ({ todayUsd: 0, monthUsd: 0, sessionUsd: 0, byFeature: {} }), check: () => ({ allowed: true }), limits: () => ({}) },
    log() {}
  };
}

describe("enterprise connector gating", () => {
  it("HubSpot and Salesforce are absent without their licence features", async () => {
    const { service, tools, installed } = await setup(["audit_log"]);
    expect(installed.installed).not.toContain("connector-hubspot");
    expect(tools.list().some((tool) => tool.name.startsWith("hubspot_") || tool.name.startsWith("salesforce_"))).toBe(false);
    const view = (await service.stateFor(owner, "default")).connectors.filter((c) => c.edition === "enterprise");
    expect(view.map((c) => [c.id, c.available])).toEqual([
      ["hubspot", false],
      ["salesforce", false]
    ]);
  });

  it("each licensed feature adds exactly its connector; closing the module removes it", async () => {
    const { service, tools, installed } = await setup(["connector_hubspot"]);
    expect(installed.installed).toContain("connector-hubspot");
    expect(tools.get("hubspot_search")).toMatchObject({ effect: "read", provider: "hubspot" });
    expect(tools.get("hubspot_create")).toMatchObject({ effect: "write" });
    expect(tools.get("salesforce_query")).toBeUndefined();
    expect((await service.stateFor(owner, "default")).connectors.find((c) => c.id === "hubspot")).toMatchObject({ available: true, authKinds: ["oauth2", "apiKey"] });
    await installed.close();
    expect(tools.get("hubspot_search")).toBeUndefined();
  });
});

describe("HubSpot", () => {
  let api: FakeVendor;

  it("connects with a private app token and runs CRM actions", async () => {
    api = await startFakeVendor({ clientId: "hs", clientSecret: "hs-secret" });
    cleanup.push(() => api.close());
    const token = "pat-na1-0123456789abcdef";
    api.validTokens.add(token);
    api.route("GET", "/account-info/v3/details", () => ({ json: { portalId: 4242, uiDomain: "app.hubspot.com" } }));
    let search: any;
    api.route("POST", "/crm/v3/objects/contacts/search", (req) => {
      search = JSON.parse(req.body);
      return { json: { total: 1, results: [{ id: "101", properties: { email: "ana@acme.com", firstname: "Ana" } }] } };
    });
    let note: any;
    api.route("POST", "/crm/v3/objects/notes", (req) => {
      note = JSON.parse(req.body);
      return { json: { id: "n1" } };
    });
    api.route("PUT", "/crm/v4/objects/contacts/101/associations/default/companies/55", () => ({ json: {} }));
    const { service, tools } = await setup(["connector_hubspot"], { hubspot: { apiBases: { api: api.url } } });

    await expect(service.connectApiKey({ principal: member, binding: "b" }, { connectorId: "hubspot", scope: "personal", workspaceId: "default", credentials: { token: "pat-wrong" } })).rejects.toMatchObject({ code: "rejected" });
    const connection = await service.connectApiKey({ principal: member, binding: "b" }, { connectorId: "hubspot", scope: "personal", workspaceId: "default", credentials: { token } });
    expect(connection).toMatchObject({ authKind: "apiKey", account: "HubSpot portal 4242", status: "connected" });
    expect(JSON.stringify(await service.stateFor(member, "default"))).not.toContain(token);

    const result = await tools.get("hubspot_search")!.run({ object: "contacts", query: "ana", filters: [{ property: "lifecyclestage", operator: "EQ", value: "lead" }] }, context(member));
    expect(result.content).toContain("ana@acme.com");
    expect(search).toMatchObject({ query: "ana", filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "lead" }] }], limit: 10 });

    await tools.get("hubspot_add_note")!.run({ body: "Call went well", contactIds: ["101"], dealIds: ["7"] }, context(member));
    expect(note.associations).toEqual([
      { to: { id: "101" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] },
      { to: { id: "7" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] }
    ]);
    const associated = await tools.get("hubspot_associate")!.run({ fromObject: "contacts", fromId: "101", toObject: "companies", toId: "55" }, context(member));
    expect(associated.isError).toBeFalsy();
    expect(api.requests.filter((r) => r.path.startsWith("/crm")).every((r) => r.headers.authorization === `Bearer ${token}`)).toBe(true);
  });

  it("connects with OAuth (no PKCE) and refreshes", async () => {
    api = await startFakeVendor({ clientId: "hs", clientSecret: "hs-secret", scope: "oauth crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read" });
    cleanup.push(() => api.close());
    api.route("GET", "/account-info/v3/details", () => ({ json: { portalId: 7 } }));
    api.route("GET", "/crm/v3/objects/deals/9", () => ({ json: { id: "9", properties: { dealname: "Renewal", amount: "5000" } } }));
    const { service, tools } = await setup(["connector_hubspot"], { hubspot: { authorizeUrl: `${api.url}/auth`, tokenUrl: `${api.url}/token`, apiBases: { api: api.url } } });
    await service.setApp(owner, "hubspot", { clientId: "hs", clientSecret: "hs-secret" });
    const begun = await service.beginOAuth({ principal: member, binding: "b" }, { connectorId: "hubspot", scope: "personal", groups: ["crm_read"], workspaceId: "default" }, "http://gw/cb");
    const params = authorizeParams(begun.authorizeUrl);
    expect(params.challenge).toBe("");
    expect(params.scope).toBe("oauth crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read");
    await service.completeOAuth({ state: params.state, code: api.approve("") }, async () => ({ ok: true }));
    api.validTokens.clear(); // the access token expired early
    const deal = await tools.get("hubspot_get")!.run({ object: "deals", id: "9" }, context(member));
    expect(deal.content).toContain("Renewal");
    expect(api.requests.filter((r) => r.path === "/token")).toHaveLength(2);
  });
});

describe("Salesforce", () => {
  it("OAuth with the instance URL from the token, SOQL paging and logging a call", async () => {
    const api = await startFakeVendor({ clientId: "sf", clientSecret: "sf-secret", scope: "api refresh_token openid", tokenExtra: (url) => ({ instance_url: url }) });
    cleanup.push(() => api.close());
    api.route("GET", "/services/oauth2/userinfo", () => ({ json: { preferred_username: "max@acme.com", name: "Max" } }));
    api.route("GET", "/services/data/v61.0/query", () => ({ json: { totalSize: 3, done: false, nextRecordsUrl: "/services/data/v61.0/query/01g-2000", records: [{ Id: "006000000000001AAA", Name: "A" }, { Id: "006000000000002AAA", Name: "B" }] } }));
    api.route("GET", "/services/data/v61.0/query/01g-2000", () => ({ json: { totalSize: 3, done: true, records: [{ Id: "006000000000003AAA", Name: "C" }] } }));
    let task: any;
    api.route("POST", "/services/data/v61.0/sobjects/Task", (req) => {
      task = JSON.parse(req.body);
      return { status: 201, json: { id: "00T000000000001AAA", success: true } };
    });
    api.route("PATCH", "/services/data/v61.0/sobjects/Opportunity/006000000000001AAA", () => ({ status: 204 }));
    const { service, tools } = await setup(["connector_salesforce"], { salesforce: { authorizeUrl: `${api.url}/auth`, tokenUrl: `${api.url}/token`, revokeUrl: `${api.url}/revoke`, apiBases: { instance: api.url } } });
    await service.setApp(owner, "salesforce", { clientId: "sf", clientSecret: "sf-secret", settings: { loginHost: "test.salesforce.com" } });
    const begun = await service.beginOAuth({ principal: owner, binding: "b" }, { connectorId: "salesforce", scope: "workspace", workspaceId: "default" }, "http://gw/cb");
    const params = authorizeParams(begun.authorizeUrl);
    expect(params.challenge).not.toBe("");
    const { connection } = await service.completeOAuth({ state: params.state, code: api.approve(params.challenge) }, async () => ({ ok: true }));
    expect(connection).toMatchObject({ scope: "workspace", account: "max@acme.com", metadata: { instanceUrl: api.url } });

    const rows = await tools.get("salesforce_query")!.run({ soql: "SELECT Id, Name FROM Opportunity" }, context(member));
    expect((rows.data as { records: unknown[] }).records).toHaveLength(3);
    const refused = await tools.get("salesforce_query")!.run({ soql: "DELETE FROM Account" }, context(member));
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toMatch(/SELECT/);

    const logged = await tools.get("salesforce_log_activity")!.run({ type: "call", subject: "Renewal call", whatId: "006000000000001AAA", dueDate: "2026-11-09" }, context(member));
    expect(logged.content).toContain("Call logged");
    expect(task).toEqual({ Subject: "Renewal call", ActivityDate: "2026-11-09", Status: "Completed", Priority: "Normal", TaskSubtype: "Call", WhatId: "006000000000001AAA" });
    const updated = await tools.get("salesforce_update_record")!.run({ object: "Opportunity", id: "006000000000001AAA", fields: { StageName: "Closed Won" } }, context(member));
    expect(updated.isError).toBeFalsy();
  });

  it("refuses an instance URL outside Salesforce", async () => {
    const api = await startFakeVendor({ clientId: "sf", clientSecret: "sf-secret", tokenExtra: () => ({ instance_url: "https://evil.example.com" }) });
    cleanup.push(() => api.close());
    const { service } = await setup(["connector_salesforce"], { salesforce: { authorizeUrl: `${api.url}/auth`, tokenUrl: `${api.url}/token` } });
    await service.setApp(owner, "salesforce", { clientId: "sf", clientSecret: "sf-secret" });
    const params = authorizeParams((await service.beginOAuth({ principal: owner, binding: "b" }, { connectorId: "salesforce", scope: "personal", workspaceId: "default" }, "http://gw/cb")).authorizeUrl);
    await expect(service.completeOAuth({ state: params.state, code: api.approve(params.challenge) }, async () => ({ ok: true }))).rejects.toMatchObject({ code: "bad_metadata" });
    expect(service.store.list()).toEqual([]);
  });
});
