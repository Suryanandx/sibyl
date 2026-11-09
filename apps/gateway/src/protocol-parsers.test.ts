/**
 * Every parser in @open-gpt-live/protocol returns the same shape:
 * `{ success: true, data }` or `{ success: false, error }` (area parsers
 * return undefined for message types that aren't theirs). One success and
 * one failure path per parser.
 */
import assert from "node:assert/strict";
import {
  AGENT_AUTONOMY_VALUES,
  AGENT_EVENTS,
  AGENT_KIND_VALUES,
  AGENT_LEARNING_VALUES,
  AGENT_VISIBILITY_VALUES,
  CONNECTIONS_EVENTS,
  IDENTITY_EVENTS,
  ROUTINE_EVENTS,
  SECRET_EVENTS,
  WS_EVENTS,
  parseAgentInput,
  parseAgentsClientMessage,
  parseAgentsServerMessage,
  parseAttachments,
  parseClientMessage,
  parseConnectionServerInput,
  parseConnectionsClientMessage,
  parseConnectionsServerMessage,
  parseIdentityClientMessage,
  parseIdentityServerMessage,
  parseKnowledgeDocInput,
  parseMonitorEventsQuery,
  parseMonitorInput,
  parseMonitorPause,
  parsePluginInstallInput,
  parseRoutinePatch,
  parseSecretsClientMessage,
  parseSecretsServerMessage,
  parseServerMessage,
  parseSkillInput,
  type ParseResult
} from "@open-gpt-live/protocol";
import { test } from "vitest";

function accepts<T>(result: ParseResult<T> | undefined): T {
  assert.ok(result, "parser did not claim the message");
  if (!result.success) assert.fail(`expected success, got error: ${result.error}`);
  return result.data;
}

function rejects<T>(result: ParseResult<T> | undefined, error: RegExp): void {
  assert.ok(result, "parser did not claim the message");
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error, error);
}

const catalog = { llm: [{ id: "m", label: "M" }], stt: [{ id: "s", label: "S" }], tts: [{ id: "t", label: "T" }] };
const settings = { llmModel: "m", sttModel: "s", genUi: true, speak: false };
const capabilities = { provider: "openrouter", genUi: true, tts: true, realtimeStt: false };

test("session settings and catalog", () => {
  assert.deepEqual(accepts(parseClientMessage({ type: WS_EVENTS.SESSION_UPDATE, settings: { llmModel: "m", speak: true } })), {
    type: WS_EVENTS.SESSION_UPDATE,
    settings: { llmModel: "m", speak: true }
  });
  rejects(parseClientMessage({ type: WS_EVENTS.SESSION_UPDATE, settings: { speak: "yes" } }), /^session\.update speak must be a boolean$/);
  rejects(parseClientMessage({ type: WS_EVENTS.SESSION_UPDATE, settings: "x" }), /^session\.update settings must be an object$/);

  assert.deepEqual(accepts(parseServerMessage({ type: WS_EVENTS.SESSION_CONFIG, settings, catalog, capabilities })), {
    type: WS_EVENTS.SESSION_CONFIG,
    settings,
    catalog,
    capabilities
  });
  rejects(parseServerMessage({ type: WS_EVENTS.SESSION_CONFIG, settings: { ...settings, speak: 1 }, catalog, capabilities }), /requires complete settings/);
  rejects(parseServerMessage({ type: WS_EVENTS.SESSION_CONFIG, settings, catalog: { ...catalog, stt: [{ id: "s" }] }, capabilities }), /requires a model catalog/);
  rejects(parseServerMessage({ type: WS_EVENTS.SESSION_CONFIG, settings, catalog: { ...catalog, voice: "x" }, capabilities }), /requires a model catalog/);
  // An invalid preset is dropped, not fatal.
  const config = accepts(
    parseServerMessage({
      type: WS_EVENTS.SESSION_CONFIG,
      settings,
      catalog: {
        ...catalog,
        presets: [
          { id: "cheapest", label: "Cheapest", settings: { llmModel: "m" } },
          { id: "bad", label: "Bad", settings: { speak: 1 } }
        ]
      },
      capabilities
    })
  );
  assert.deepEqual(config.type === WS_EVENTS.SESSION_CONFIG ? config.catalog.presets?.map((p) => p.id) : undefined, ["cheapest"]);
});

test("connection servers", () => {
  assert.deepEqual(accepts(parseConnectionServerInput({ name: "weather", transport: "http", url: " https://x.test/mcp ", headers: { Authorization: null } })), {
    name: "weather",
    transport: "http",
    url: "https://x.test/mcp",
    headers: { Authorization: null }
  });
  assert.deepEqual(accepts(parseConnectionServerInput({ name: "fs", transport: "stdio", command: "npx", args: ["a"] })), {
    name: "fs",
    transport: "stdio",
    command: "npx",
    args: ["a"],
    env: {}
  });
  rejects(parseConnectionServerInput({ name: "fs", transport: "stdio", command: "npx", args: [], env: { "bad key": "x" } }), /env key "bad key" is not allowed/);
  rejects(parseConnectionServerInput({ name: "x", transport: "ftp" }), /transport must be/);
  rejects(parseConnectionServerInput("x"), /server must be an object/);
  const save = accepts(
    parseConnectionsClientMessage({ type: CONNECTIONS_EVENTS.SERVER_SAVE, requestId: "r1", server: { name: "w", transport: "http", url: "https://x.test" } })
  );
  assert.equal(save.type, CONNECTIONS_EVENTS.SERVER_SAVE);
  rejects(
    parseConnectionsClientMessage({ type: CONNECTIONS_EVENTS.SERVER_SAVE, requestId: "r1", server: { name: "w", transport: "http", url: "nope" } }),
    new RegExp(`^${CONNECTIONS_EVENTS.SERVER_SAVE.replace(/\./g, "\\.")} url is not a valid URL$`)
  );
  rejects(parseConnectionsClientMessage({ type: CONNECTIONS_EVENTS.SERVER_TEST, requestId: "r1", server: { name: "w" } }), /transport must be/);
  assert.equal(parseConnectionsClientMessage({ type: "something.else" }), undefined);
  accepts(parseConnectionsServerMessage({ type: CONNECTIONS_EVENTS.RESULT, requestId: "r1", ok: true }));
  rejects(parseConnectionsServerMessage({ type: CONNECTIONS_EVENTS.RESULT, requestId: "r1", ok: "yes" }), /invalid/);
});

test("attachments and routine patches", () => {
  assert.equal(accepts(parseAttachments(undefined)), undefined);
  assert.deepEqual(accepts(parseAttachments([{ id: "a1", name: "n.txt", mime: "text/plain" }])), [{ id: "a1", name: "n.txt", mime: "text/plain" }]);
  rejects(parseAttachments("x"), /must be an array/);
  assert.deepEqual(accepts(parseRoutinePatch({ name: " Daily ", enabled: false })), { name: "Daily", enabled: false });
  rejects(parseRoutinePatch({}), /must change something/);
  rejects(parseRoutinePatch({ maxRunUsd: 500 }), /maxRunUsd/);
  assert.deepEqual(accepts(parseClientMessage({ type: ROUTINE_EVENTS.ROUTINE_UPDATE, routineId: "r1", patch: { enabled: true } })), {
    type: ROUTINE_EVENTS.ROUTINE_UPDATE,
    routineId: "r1",
    patch: { enabled: true }
  });
  rejects(parseClientMessage({ type: ROUTINE_EVENTS.ROUTINE_UPDATE, routineId: "r1", patch: { enabled: "on" } }), /^routine\.update enabled must be a boolean$/);
});

test("secrets messages", () => {
  assert.deepEqual(accepts(parseSecretsClientMessage({ type: SECRET_EVENTS.PROVIDE, id: "s1", value: "v", allowedHosts: [" api.x.test "] })), {
    type: SECRET_EVENTS.PROVIDE,
    id: "s1",
    value: "v",
    allowedHosts: ["api.x.test"]
  });
  assert.deepEqual(accepts(parseSecretsClientMessage({ type: SECRET_EVENTS.PROVIDE, id: "s1", value: "v" })), { type: SECRET_EVENTS.PROVIDE, id: "s1", value: "v" });
  rejects(parseSecretsClientMessage({ type: SECRET_EVENTS.PROVIDE, id: "s1", value: "v", allowedHosts: [] }), /^secret\.provide allowedHosts must be 1–10 host strings$/);
  rejects(parseSecretsClientMessage({ type: SECRET_EVENTS.UPDATE, name: "API_KEY", allowedHosts: [""] }), /^secret\.update allowedHosts must be 1–10 host strings$/);
  assert.equal(parseSecretsClientMessage({ type: "x" }), undefined);
  accepts(parseSecretsServerMessage({ type: SECRET_EVENTS.RESOLVED, id: "s1", name: "API_KEY", status: "saved" }));
  rejects(parseSecretsServerMessage({ type: SECRET_EVENTS.RESOLVED, id: "s1", name: "API_KEY", status: "maybe" }), /invalid secret\.resolved/);
});

test("identity messages", () => {
  assert.deepEqual(accepts(parseIdentityClientMessage({ type: IDENTITY_EVENTS.SESSION_WORKSPACE, workspaceId: "default" })), {
    type: IDENTITY_EVENTS.SESSION_WORKSPACE,
    workspaceId: "default"
  });
  rejects(parseIdentityClientMessage({ type: IDENTITY_EVENTS.SESSION_WORKSPACE, workspaceId: "../x" }), /workspaceId/);
  accepts(parseIdentityServerMessage({ type: IDENTITY_EVENTS.SESSION_IDENTITY, workspaceId: "default", permissions: [], principal: "local", user: null }));
  rejects(
    parseIdentityServerMessage({ type: IDENTITY_EVENTS.SESSION_IDENTITY, workspaceId: "default", permissions: [], principal: "robot", user: null }),
    /malformed/
  );
});

test("monitor bodies and queries", () => {
  const monitor = {
    name: " Deals ",
    source: { kind: "rss", url: "https://x.test/feed" },
    schedule: { everyMinutes: 15 },
    condition: { filter: [{ path: "title", op: "contains", value: "deal" }], ask: "Is it big?" },
    actions: [
      { kind: "notify", channels: ["inbox"] },
      { kind: "task", instruction: " Draft a reply " }
    ]
  };
  assert.deepEqual(accepts(parseMonitorInput(monitor)), {
    name: "Deals",
    source: { kind: "rss", url: "https://x.test/feed" },
    schedule: { everyMinutes: 15 },
    condition: { filter: [{ path: "title", op: "contains", value: "deal" }], ask: "Is it big?" },
    actions: [
      { kind: "notify", channels: ["inbox"] },
      { kind: "task", instruction: "Draft a reply" }
    ]
  });
  rejects(parseMonitorInput({ ...monitor, name: "" }), /^name is required$/);
  rejects(parseMonitorInput({ ...monitor, source: { kind: "tool", toolName: "bad name" } }), /source\.toolName/);
  rejects(parseMonitorInput({ ...monitor, condition: { ask: "x".repeat(1_001) } }), /condition\.ask is too long/);
  rejects(parseMonitorInput({ ...monitor, actions: [{ kind: "task", instruction: "" }] }), /^actions\[0\]\.instruction is required$/);
  assert.deepEqual(accepts(parseMonitorPause({ paused: true })), { paused: true });
  rejects(parseMonitorPause({ paused: "yes" }), /paused must be true or false/);
  const query = (entries: Record<string, string>) => parseMonitorEventsQuery(new URLSearchParams(entries));
  assert.deepEqual(accepts(query({})), { limit: 50 });
  assert.deepEqual(accepts(query({ monitorId: "m1", before: "10", limit: "5" })), { monitorId: "m1", before: 10, limit: 5 });
  rejects(query({ limit: "500" }), /limit must be 1 to 200/);
});

test("knowledge, skill and plugin bodies", () => {
  assert.deepEqual(accepts(parseKnowledgeDocInput({ kind: "url", url: "https://x.test" })), { kind: "url", url: "https://x.test" });
  rejects(parseKnowledgeDocInput({ kind: "url", url: "ftp://x" }), /http\(s\) URL/);
  accepts(parseSkillInput({ name: "notes", title: "Notes", description: "d", instructions: "i" }));
  rejects(parseSkillInput({ name: "Bad Name", title: "t", description: "d", instructions: "i" }), /name must be/);
  assert.deepEqual(accepts(parsePluginInstallInput({ source: { kind: "catalog", ref: " x " } })), { source: { kind: "catalog", ref: "x" }, scope: "workspace" });
  rejects(parsePluginInstallInput({ source: { kind: "zip", ref: "x" } }), /source\.kind/);
});

test("agents", () => {
  const agent = {
    name: " Scout ",
    avatar: { kind: AGENT_KIND_VALUES[0], seed: "s", palette: "p", eyes: "e", mouth: "m", accessory: "a" },
    access: { mode: "controlled", tools: ["web_search", "web_search"] },
    autonomy: AGENT_AUTONOMY_VALUES[0],
    learning: AGENT_LEARNING_VALUES[2],
    visibility: AGENT_VISIBILITY_VALUES[0]
  };
  const parsed = accepts(parseAgentInput(agent));
  assert.equal(parsed.name, "Scout");
  assert.equal(parsed.description, "");
  assert.deepEqual(parsed.access, { mode: "controlled", tools: ["web_search"], connectors: [], knowledgeBaseIds: [], skillIds: [], secrets: [] });
  rejects(parseAgentInput({ ...agent, name: "  " }), /^name must not be empty$/);
  rejects(parseAgentInput({ ...agent, access: { mode: "controlled", tools: "all" } }), /^access tools must be a list/);
  assert.equal(accepts(parseAgentsClientMessage({ type: AGENT_EVENTS.SAVE, agent })).type, AGENT_EVENTS.SAVE);
  rejects(parseAgentsClientMessage({ type: AGENT_EVENTS.SAVE, agent: { ...agent, autonomy: "yolo" } }), /^agent\.save autonomy must be/);
  const skill = { name: "notes", title: "Notes", description: "d", instructions: "i" };
  assert.deepEqual(accepts(parseAgentsClientMessage({ type: AGENT_EVENTS.PROPOSAL_DECIDE, proposalId: "p1", decision: "approve", skill, memory: " m " })), {
    type: AGENT_EVENTS.PROPOSAL_DECIDE,
    proposalId: "p1",
    decision: "approve",
    skill,
    memory: "m"
  });
  rejects(
    parseAgentsClientMessage({ type: AGENT_EVENTS.PROPOSAL_DECIDE, proposalId: "p1", decision: "approve", skill: { ...skill, title: "" } }),
    /^agent\.proposal\.decide skill title must not be empty$/
  );
  rejects(parseAgentsClientMessage({ type: AGENT_EVENTS.MEMORY_SAVE, agentId: "a1", text: "" }), /^agent\.memory\.save text must not be empty$/);
  accepts(parseAgentsServerMessage({ type: AGENT_EVENTS.LIST, items: [], templates: [], canCreate: true, canShare: false }));
  rejects(parseAgentsServerMessage({ type: AGENT_EVENTS.LIST, items: "x", templates: [], canCreate: true, canShare: false }), /invalid agents\.list/);
});
