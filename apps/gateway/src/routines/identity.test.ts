/**
 * Routines run as their creator, in their workspace: the creator's personal
 * connections work, and a creator who lost access (or a routine whose
 * workspace is gone or out of reach) fails the run instead of running with
 * more rights.
 */
import { randomBytes } from "node:crypto";
import type { ToolChatEvent, ToolChatProvider } from "@open-gpt-live/adapters";
import {
  PERMISSIONS,
  clearPolicies,
  createMemoryStore,
  createToolRegistry,
  registerPolicy,
  type Role,
  type RoutineRecord,
  type RoutineRunRecord,
  type Store
} from "@open-gpt-live/core";
import { afterEach, describe, expect, test } from "vitest";
import { googleConnector } from "../connectors/google/index.js";
import { ConnectorService } from "../connectors/service.js";
import { authorizeParams, startFakeVendor, userPrincipal } from "../connectors/testing.js";
import { GatewayUsageMeter } from "../metering/meter.js";
import { SecretVault } from "../secrets/vault.js";
import { RoutineApprovalGate, createRoutineRunner, type RunHandle } from "./runner.js";

const ORG = "owner";
const NOW = 1_800_000_000_000;
const GOOGLE_SCOPES = googleConnector.groups.flatMap((g) => g.scopes).concat(["openid", "email", "profile"]).join(" ");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  clearPolicies();
  while (cleanup.length) await cleanup.pop()!();
});

async function addUser(store: Store, id: string, roles: Record<string, Role>): Promise<void> {
  await store.identity.users.upsert({ id, orgId: ORG, email: `${id}@x.test`, name: id, passwordHash: "x", createdAt: NOW });
  await store.identity.memberships.upsert(ORG, { userId: id, scope: "org", role: "member", createdAt: NOW } as never);
  for (const [workspaceId, role] of Object.entries(roles)) {
    await store.identity.memberships.upsert(ORG, { userId: id, scope: { workspaceId }, role, createdAt: NOW } as never);
  }
}

/** First round: search the creator's Gmail; second round: answer with what came back. */
function gmailBrain(): ToolChatProvider & { seen: string[] } {
  const brain = {
    seen: [] as string[],
    async *streamWithTools(messages: Array<{ role: string; content: unknown }>): AsyncIterable<ToolChatEvent> {
      const last = messages[messages.length - 1]!;
      if (last.role === "tool") {
        brain.seen.push(String(last.content));
        yield { type: "text", delta: `Summary: ${String(last.content).slice(0, 200)}` };
      } else {
        yield { type: "tool_calls", calls: [{ id: "c1", name: "google_gmail_search", arguments: JSON.stringify({ query: "is:unread" }) }] };
      }
      yield { type: "usage", usage: { costUsd: 0.001 } };
    }
  };
  return brain as never;
}

async function setup() {
  const store = createMemoryStore();
  const key = randomBytes(32);
  const vault = new SecretVault({ store, key, log: () => undefined });
  const tools = createToolRegistry();
  const google = await startFakeVendor({ clientId: "google-client", clientSecret: "google-secret-value", scope: GOOGLE_SCOPES });
  const connectors = await new ConnectorService({
    store,
    ownerId: ORG,
    key,
    vault,
    tools,
    builtins: [googleConnector],
    env: {},
    log: () => undefined,
    now: () => NOW,
    endpoints: {
      google: {
        authorizeUrl: `${google.url}/auth`,
        tokenUrl: `${google.url}/token`,
        revokeUrl: `${google.url}/revoke`,
        apiBases: { gmail: google.url, calendar: google.url, drive: google.url, docs: google.url, sheets: google.url, userinfo: google.url }
      }
    }
  }).init();
  cleanup.push(() => connectors.close(), () => vault.close(), () => google.close());
  google.route("GET", "/v1/userinfo", () => ({ json: { email: "max@example.com", name: "Max" } }));
  google.route("GET", "/gmail/v1/users/me/messages", () => ({ json: { messages: [{ id: "m1" }], resultSizeEstimate: 1 } }));
  google.route("GET", "/gmail/v1/users/me/messages/m1", () => ({
    json: { id: "m1", threadId: "t1", snippet: "Quarterly numbers attached", payload: { headers: [{ name: "Subject", value: "Q3 report" }] } }
  }));

  // Max, a member of "default", connects his own Gmail.
  await addUser(store, "u-max", { default: "member" });
  await store.workspaces.upsert({ id: "sales", ownerId: ORG, name: "Sales", createdAt: NOW, updatedAt: NOW } as never);
  const max = userPrincipal("u-max", { default: "member" }, "member");
  await connectors.setApp(userPrincipal("u-owner", { default: "owner" }, "owner"), "google", { clientId: "google-client", clientSecret: "google-secret-value" });
  const { authorizeUrl } = await connectors.beginOAuth({ principal: max, binding: "b", name: "Max" }, { connectorId: "google", scope: "personal", groups: ["gmail_read"], workspaceId: "default" }, "http://gateway.test/cb");
  const params = authorizeParams(authorizeUrl);
  await connectors.completeOAuth({ state: params.state, code: google.approve(params.challenge) }, async () => ({ ok: true }));

  const meter = new GatewayUsageMeter({ store, limits: {}, now: () => NOW });
  let id = 0;
  const brain = gmailBrain();
  const runner = createRoutineRunner({
    store,
    tools,
    meter,
    provider: brain,
    model: () => "brain/deep",
    systemPrompt: "BRAIN",
    approvals: new RoutineApprovalGate({ store, ownerId: ORG, createId: () => `ap-${++id}`, now: () => NOW, log: () => undefined }),
    createId: () => `id-${++id}`,
    now: () => NOW,
    log: () => undefined
  });
  const run = async (routine: Partial<RoutineRecord>) => {
    const record: RoutineRecord = {
      id: "r1",
      ownerId: ORG,
      name: "Morning inbox",
      instruction: "Summarise my Gmail",
      cron: "0 8 * * *",
      timezone: "UTC",
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...routine
    };
    await store.routines.upsert(record);
    const runRecord: RoutineRunRecord = { id: `run-${++id}`, routineId: record.id, ownerId: ORG, status: "running", startedAt: NOW, costUsd: 0 };
    const handle: RunHandle = { run: runRecord, lastAttempt: true, setStatus: async () => undefined, addCost: (usd) => void (runRecord.costUsd += usd) };
    const outcome = await runner(record, handle, new AbortController().signal);
    const conversationId = (await store.routines.get(ORG, record.id))?.conversationId;
    const conversation = conversationId ? await store.conversations.get(ORG, conversationId) : undefined;
    return { outcome, conversation };
  };
  return { store, brain, run };
}

describe("routines run as their creator", () => {
  test("a member's routine uses that member's personal connection, and its chat is theirs in the routine's workspace", async () => {
    const env = await setup();
    const { outcome, conversation } = await env.run({ workspaceId: "default", createdBy: "u-max" });
    expect(outcome.status).toBe("succeeded");
    expect(env.brain.seen.join("\n")).toContain("Q3 report");
    expect(conversation?.messages.at(-1)?.content).toContain("Q3 report");
    expect(conversation).toMatchObject({ workspaceId: "default", createdBy: "u-max" });
  });

  test("the owner's routine can't reach a member's personal connection", async () => {
    const env = await setup();
    const { outcome } = await env.run({ workspaceId: "default" });
    expect(outcome.status).toBe("succeeded");
    // The tool isn't even offered: no usable connection for the owner.
    expect(env.brain.seen.join("\n")).toMatch(/no tool named "google_gmail_search"/);
    expect(env.brain.seen.join("\n")).not.toContain("Q3 report");
  });

  test("a creator who lost routines.use fails the run with the reason", async () => {
    const env = await setup();
    registerPolicy(({ principal, permission }) => (principal.userId === "u-max" && permission === PERMISSIONS.ROUTINES_USE ? "deny" : undefined));
    const { outcome } = await env.run({ workspaceId: "default", createdBy: "u-max" });
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer has access to routines/) });
    expect(env.brain.seen).toEqual([]);
  });

  test("a creator removed from the workspace, or from the organization, fails the run", async () => {
    const env = await setup();
    await env.store.identity.memberships.remove(ORG, "u-max", { workspaceId: "default" });
    expect((await env.run({ workspaceId: "default", createdBy: "u-max" })).outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer has access/) });
    const user = (await env.store.identity.users.get(ORG, "u-max"))!;
    await env.store.identity.users.upsert({ ...user, disabledAt: NOW });
    expect((await env.run({ workspaceId: "default", createdBy: "u-max" })).outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer has an account/) });
  });

  test("a routine in a workspace its creator can't reach, or one that is gone, does not run", async () => {
    const env = await setup();
    expect((await env.run({ workspaceId: "sales", createdBy: "u-max" })).outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer has access/) });
    expect((await env.run({ workspaceId: "deleted-ws", createdBy: "u-max" })).outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/workspace no longer exists/) });
    expect(env.brain.seen).toEqual([]);
  });
});
