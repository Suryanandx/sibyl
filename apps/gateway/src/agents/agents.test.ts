import type { ChatToolCall, ToolChatEvent, ToolChatMessage, ToolChatProvider } from "@open-gpt-live/adapters";
import {
  PERMISSIONS,
  authorize,
  createMemoryStore,
  createToolRegistry,
  ownerPrincipal,
  randomAvatar,
  type AgentRecord,
  type Principal,
  type Role,
  type RoutineRecord,
  type Store,
  type ToolDefinition
} from "@open-gpt-live/core";
import {
  AGENT_EVENTS,
  WS_EVENTS,
  parseClientMessage,
  type AgentInput,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createGatewayServer, type GatewayProviders } from "../gateway.js";
import { GatewayUsageMeter } from "../metering/meter.js";
import { createTestRuntime } from "../runtime.js";
import { RoutineApprovalGate, createRoutineRunner, type RunHandle } from "../routines/runner.js";
import { agentTools, isHighRisk, secretRefusal } from "./access.js";
import { FEEDBACK_PATTERN, parseReflection, shouldReflect } from "./learning.js";
import { memoryBlock } from "./prompt.js";
import type { NotificationInput } from "../notifications/service.js";
import { AgentRuntime } from "./runtime.js";

const ORG = "owner";
const NOW = Date.parse("2026-11-09T10:00:00Z");

function tool(name: string, effect: "read" | "write", extra: Partial<ToolDefinition> = {}): ToolDefinition<any, any> & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    title: name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    description: name,
    inputSchema: { type: "object" },
    effect,
    source: "builtin",
    calls,
    async run(input) {
      calls.push(input);
      return { content: `${name} ok` };
    },
    ...extra
  };
}

function user(id: string, role: Role, workspaceId = "default"): Principal {
  return { kind: "user", orgId: ORG, userId: id, workspaceRoles: { [workspaceId]: role } };
}

async function addUser(store: Store, id: string, role: Role, workspaceId = "default"): Promise<void> {
  await store.identity.users.upsert({ id, orgId: ORG, email: `${id}@x.test`, name: id, passwordHash: "x", createdAt: NOW, updatedAt: NOW } as never);
  await store.identity.memberships.upsert(ORG, { userId: id, scope: { workspaceId }, role, createdAt: NOW } as never);
}

function agentRecord(extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "ag1",
    ownerId: ORG,
    workspaceId: "default",
    createdBy: "alice",
    name: "Sales Buddy",
    description: "Follow-ups",
    avatar: randomAvatar("ag1"),
    instructions: "Write crisp follow-ups.",
    access: { mode: "inherit" },
    autonomy: "ask_first",
    learning: "ask_first",
    visibility: "workspace",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra
  };
}

function fakeProvider(script: Array<{ text?: string; calls?: ChatToolCall[]; costUsd?: number }>): ToolChatProvider & { requests: ToolChatMessage[][] } {
  const provider = {
    requests: [] as ToolChatMessage[][],
    async *streamWithTools(messages: ToolChatMessage[]): AsyncIterable<ToolChatEvent> {
      const round = script[provider.requests.length] ?? { text: "Done." };
      provider.requests.push([...messages]);
      if (round.text) yield { type: "text", delta: round.text };
      yield { type: "usage", usage: { costUsd: round.costUsd ?? 0.001 } };
      if (round.calls) yield { type: "tool_calls", calls: round.calls };
    }
  };
  return provider;
}

function setup(options: { meter?: GatewayUsageMeter } = {}) {
  const store = createMemoryStore();
  const meter = options.meter ?? new GatewayUsageMeter({ store, now: () => NOW });
  const tools = createToolRegistry();
  const notices: NotificationInput[] = [];
  let n = 0;
  const agents = new AgentRuntime({ store, ownerId: ORG, tools, meter, log: () => undefined, createId: () => `id${++n}`, now: () => NOW, notify: (x) => void notices.push(x) });
  return { store, meter, tools, agents, notices };
}

const input = (extra: Partial<AgentInput> = {}): AgentInput => ({
  name: "Research Dot",
  description: "Researches",
  avatar: randomAvatar("r"),
  instructions: "Cite sources.",
  access: { mode: "inherit" },
  autonomy: "ask_first",
  learning: "ask_first",
  visibility: "private",
  ...extra
});

describe("agent access", () => {
  const read = tool("web_search", "read");
  const write = tool("send_email", "write");
  const mcp = tool("crm_update", "write", { provider: "crm", source: "mcp" });

  test("inherit = what the creator may use; never more than the creator or the caller", () => {
    const agent = agentRecord();
    const names = (creator: Principal | undefined, caller?: Principal) =>
      agentTools({ agent, tools: [read, write, mcp], creator, ...(caller ? { caller } : {}), workspaceId: "default" }).map((t) => t.name);
    expect(names(user("alice", "member"))).toEqual(["web_search", "send_email", "crm_update"]);
    // A viewer creator can't write, so neither can their agent.
    expect(names(user("alice", "viewer"))).toEqual(["web_search"]);
    // A shared agent used by a viewer can't write on their behalf.
    expect(names(user("alice", "admin"), user("bob", "viewer"))).toEqual(["web_search"]);
    // Creator gone: nothing.
    expect(names(undefined)).toEqual([]);
  });

  test("controlled = intersection of the allowlists (tools and connectors) with the creator's rights", () => {
    const agent = agentRecord({ access: { mode: "controlled", tools: ["web_search", "send_email"], connectors: ["crm"], knowledgeBaseIds: [], skillIds: [], secrets: ["CRM_KEY"] } });
    const allowed = agentTools({ agent, tools: [read, write, mcp, tool("weather", "read")], creator: user("alice", "member"), workspaceId: "default" });
    expect(allowed.map((t) => t.name)).toEqual(["web_search", "send_email", "crm_update"]);
    expect(agentTools({ agent, tools: [read, write, mcp], creator: user("alice", "viewer"), workspaceId: "default" }).map((t) => t.name)).toEqual(["web_search"]);
    expect(secretRefusal(agent, { headers: { Authorization: "Bearer ${secret:CRM_KEY}" } })).toBeUndefined();
    expect(secretRefusal(agent, { url: "https://x.test?k=${secret:BANK_TOKEN}" })).toMatch(/BANK_TOKEN/);
    expect(secretRefusal(agentRecord(), { url: "${secret:BANK_TOKEN}" })).toBeUndefined();
  });

  test("high-risk actions are flagged by tag or by a fixed list of names", () => {
    expect(isHighRisk(tool("transfer_money", "write"))).toBe(true);
    expect(isHighRisk(tool("transfer", "write"))).toBe(true);
    expect(isHighRisk(tool("delete_file", "write"))).toBe(true);
    expect(isHighRisk(tool("share_document", "write"))).toBe(true);
    expect(isHighRisk(tool("send_email", "write"))).toBe(false);
    expect(isHighRisk(tool("send_email", "write", { risk: "high" }))).toBe(true);
    expect(isHighRisk(tool("delete_search", "read"))).toBe(false);
  });

  test("access shrinks at run time when the creator loses rights", async () => {
    const { store, agents, tools } = setup();
    const write = tool("send_email", "write");
    tools.register(write);
    await addUser(store, "alice", "member");
    await store.agents.upsert(agentRecord());
    const turn = await agents.prepareTurn({ agent: agentRecord() });
    const wrapped = turn.tools([write]).find((t) => t.name === "send_email")!;
    expect(wrapped).toBeDefined();
    // Alice is demoted to viewer: the next turn has no write tool.
    await store.identity.memberships.upsert(ORG, { userId: "alice", scope: { workspaceId: "default" }, role: "viewer", createdAt: NOW } as never);
    const later = await agents.prepareTurn({ agent: agentRecord() });
    expect(later.tools([write]).map((t) => t.name)).not.toContain("send_email");
  });
});

describe("agent autonomy", () => {
  async function decide(autonomy: AgentRecord["autonomy"], target: ToolDefinition<any, any>) {
    const { store, agents, notices } = setup();
    await addUser(store, "alice", "member");
    const agent = agentRecord({ autonomy });
    const turn = await agents.prepareTurn({ agent });
    let asked = 0;
    const outcome = await turn.approve({ tool: target, input: { to: "dana@x.test" } }, async () => {
      asked += 1;
      return "declined";
    });
    if (outcome === "approved") {
      const wrapped = turn.tools([target]).find((t) => t.name === target.name)!;
      await wrapped.run({ to: "dana@x.test" }, { runId: "run1", ownerId: ORG, store, meter: undefined as never, signal: new AbortController().signal, log: () => undefined });
    }
    return { outcome, asked, notices };
  }

  test("ask_first always asks for writes", async () => {
    expect(await decide("ask_first", tool("send_email", "write"))).toMatchObject({ outcome: "declined", asked: 1 });
  });

  test("act_then_tell runs, then posts an inbox notice", async () => {
    const result = await decide("act_then_tell", tool("send_email", "write"));
    expect(result).toMatchObject({ outcome: "approved", asked: 0 });
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ kind: "agent_action", workspaceId: "default", links: { agentId: "ag1" } });
    expect(result.notices[0]!.body).toMatch(/Sales Buddy sent email/);
  });

  test("autonomous runs without asking or telling", async () => {
    const result = await decide("autonomous", tool("send_email", "write"));
    expect(result).toMatchObject({ outcome: "approved", asked: 0 });
    expect(result.notices).toHaveLength(0);
  });

  test("high-risk actions always ask, even when autonomous", async () => {
    expect(await decide("autonomous", tool("delete_file", "write"))).toMatchObject({ asked: 1 });
    expect(await decide("act_then_tell", tool("pay_invoice", "write", { risk: "high" }))).toMatchObject({ asked: 1 });
  });

  test("reads never ask", async () => {
    expect(await decide("ask_first", tool("web_search", "read"))).toMatchObject({ outcome: "approved", asked: 0 });
  });
});

describe("agent budgets", () => {
  test("spend bound to an agent counts toward its caps; it pauses at the cap", async () => {
    const { store, agents, meter } = setup();
    await addUser(store, "alice", "member");
    const agent = agentRecord({ budget: { dailyUsd: 0.05 } });
    const turn = await agents.prepareTurn({ agent });
    expect(turn.budget(0.01)).toEqual({ allowed: true });
    turn.bindRequest("req1");
    meter.record({ ownerId: ORG, feature: "brain", model: "m", costUsd: 0.045, estimated: false, requestId: "req1" });
    expect(meter.agentTotals(ORG, "ag1").todayUsd).toBeCloseTo(0.045);
    const blocked = turn.budget(0.01);
    expect(blocked).toMatchObject({ allowed: false, scope: "agent_daily" });
    expect(!blocked.allowed && blocked.message).toMatch(/Sales Buddy used its daily budget/);
    // Unbound spend doesn't count toward the agent.
    meter.record({ ownerId: ORG, feature: "brain", model: "m", costUsd: 1, estimated: false, requestId: "other" });
    expect(meter.agentTotals(ORG, "ag1").todayUsd).toBeCloseTo(0.045);
    // Spend survives a restart through the agents runtime.
    await turn.finish({ runId: "req1", task: "t", reply: "r" });
    const fresh = new GatewayUsageMeter({ store, now: () => NOW });
    const again = new AgentRuntime({ store, ownerId: ORG, tools: createToolRegistry(), meter: fresh, log: () => undefined, now: () => NOW });
    expect((await again.prepareTurn({ agent })).budget(0.01)).toMatchObject({ allowed: false, scope: "agent_daily" });
  });
});

describe("learning loop", () => {
  const reflection = JSON.stringify({
    skills: [{ kind: "new", name: "Follow Up Email", title: "Follow-up email", description: "Use when writing a follow-up after a call", instructions: "1. Summary\n2. Next steps", rationale: "Recurring task" }],
    memory: [{ text: "Dana prefers short emails", rationale: "Said so" }]
  });
  const run = { runId: "run1", task: "Draft the follow-up for Dana", reply: "Here it is", steps: [1, 2, 3].map((i) => ({ toolName: `t${i}`, title: `Step ${i}`, status: "ok" })) };

  test("reflects only after ≥ 3 steps or explicit feedback", () => {
    expect(shouldReflect({ steps: run.steps })).toBe(true);
    expect(shouldReflect({ steps: run.steps.slice(0, 2) })).toBe(false);
    expect(shouldReflect({ steps: [], feedback: "Perfect, that's how we do it here." })).toBe(true);
    expect(FEEDBACK_PATTERN.test("thanks")).toBe(false);
  });

  test("parses lenient JSON and drops edits of unknown skills", () => {
    const parsed = parseReflection("```json\n" + reflection + "\n```", []);
    expect(parsed.skills[0]!.draft.name).toBe("follow-up-email");
    expect(parsed.memory[0]!.text).toBe("Dana prefers short emails");
    expect(parseReflection('{"skills":[{"kind":"edit","skillId":"nope","title":"x","description":"y","instructions":"z"}]}', []).skills).toEqual([]);
    expect(parseReflection("no json here", [])).toEqual({ skills: [], memory: [] });
  });

  test("ask_first: proposals wait; approve applies a versioned agent skill; rollback removes it", async () => {
    const { store, agents, meter } = setup();
    await addUser(store, "alice", "member");
    const agent = agentRecord();
    await store.agents.upsert(agent);
    const provider = fakeProvider([{ text: reflection, costUsd: 0.0007 }]);
    const proposals = await agents.reflectAndLearn(agent, run, { provider, model: "cheap" });
    expect(proposals.map((p) => [p.kind, p.status])).toEqual([["new", "pending"], ["memory", "pending"]]);
    // The reflection call was metered against the agent.
    expect(meter.agentTotals(ORG, "ag1").todayUsd).toBeCloseTo(0.0007);
    expect(await store.skills.list(ORG)).toEqual([]);

    const alice = user("alice", "member");
    const bob = user("bob", "member");
    expect(await agents.decideProposal(bob, "default", proposals[0]!.id, "approve")).toMatch(/creator/);
    const applied = await agents.decideProposal(alice, "default", proposals[0]!.id, "approve");
    expect(applied).toMatchObject({ status: "applied", kind: "new" });
    const [skill] = await store.skills.list(ORG);
    expect(skill).toMatchObject({ name: "follow-up-email", source: "agent", agentId: "ag1", version: "1", enabled: true });

    // The agent sees its learned skill next turn.
    const turn = await agents.prepareTurn({ agent });
    expect(turn.systemBlock).toContain("follow-up-email");
    expect(turn.tools([]).map((t) => t.name)).toContain("agent_skill");

    const memory = await agents.decideProposal(alice, "default", proposals[1]!.id, "approve", { memory: "Dana likes short, direct emails" });
    expect(memory).toMatchObject({ status: "applied", memory: "Dana likes short, direct emails" });
    expect((await prepareBlock(agents, agent))).toContain("Dana likes short, direct emails");

    expect(await agents.decideProposal(alice, "default", proposals[0]!.id, "rollback")).toMatchObject({ status: "rolled_back" });
    expect(await store.skills.list(ORG)).toEqual([]);
    expect(await agents.decideProposal(alice, "default", proposals[1]!.id, "rollback")).toMatchObject({ status: "rolled_back" });
    expect(await prepareBlock(agents, agent)).not.toContain("Dana likes");
  });

  test("automatic applies right away (edits bump the version and can be rolled back); edits to people's skills still wait", async () => {
    const { store, agents } = setup();
    await addUser(store, "alice", "member");
    const agent = agentRecord({ learning: "automatic" });
    await store.agents.upsert(agent);
    const base = { ownerId: ORG, enabled: true, createdAt: NOW, updatedAt: NOW, description: "d", title: "t" };
    await store.skills.upsert({ ...base, id: "s-agent", name: "own-skill", instructions: "v1", source: "agent", agentId: "ag1", version: "1" });
    await store.skills.upsert({ ...base, id: "s-user", name: "team-skill", instructions: "human", source: "user" });
    const result = await agents.learn(
      agent,
      {
        skills: [
          { kind: "edit", skillId: "s-agent", draft: { name: "own-skill", title: "t", description: "d", instructions: "v2" }, rationale: "better" },
          { kind: "edit", skillId: "s-user", draft: { name: "team-skill", title: "t", description: "d", instructions: "agent rewrite" }, rationale: "better" }
        ],
        memory: [{ text: "Fiscal year starts in April", rationale: "mentioned" }]
      },
      "run2"
    );
    expect(result.map((p) => p.status)).toEqual(["applied", "pending", "applied"]);
    expect(await store.skills.get(ORG, "s-agent")).toMatchObject({ instructions: "v2", version: "2" });
    expect(await store.skills.get(ORG, "s-user")).toMatchObject({ instructions: "human" });
    await agents.decideProposal(user("alice", "member"), "default", result[0]!.id, "rollback");
    expect(await store.skills.get(ORG, "s-agent")).toMatchObject({ instructions: "v1", version: "1" });
  });

  test("off: nothing is learned and agent_remember is not offered", async () => {
    const { store, agents } = setup();
    await addUser(store, "alice", "member");
    const agent = agentRecord({ learning: "off" });
    expect(await agents.learn(agent, parseReflection(reflection, []), "r")).toEqual([]);
    expect((await agents.prepareTurn({ agent })).tools([]).map((t) => t.name)).not.toContain("agent_remember");
  });

  test("finish logs the run (searchable) and reflects in the background", async () => {
    const { store, agents } = setup();
    await addUser(store, "alice", "member");
    const agent = agentRecord();
    await store.agents.upsert(agent);
    const turn = await agents.prepareTurn({ agent });
    for (const step of run.steps) turn.noteStep(step);
    const provider = fakeProvider([{ text: reflection }]);
    await turn.finish({ runId: "run1", task: "Draft the follow-up for Dana", reply: "Here it is", reflectWith: { provider, model: "cheap" } });
    await agents.settle();
    expect(provider.requests).toHaveLength(1);
    expect((await store.skillProposals.list(ORG, { agentId: "ag1" })).length).toBe(2);
    const recall = turn.tools([]).find((t) => t.name === "agent_recall")!;
    const found = await recall.run({ query: "Dana follow-up" }, { runId: "x", ownerId: ORG, store, meter: undefined as never, signal: new AbortController().signal, log: () => undefined });
    expect(found.content).toMatch(/past run.*Draft the follow-up for Dana/);
  });

  test("explicit feedback reflects on the previous task", async () => {
    const { store, agents } = setup();
    await addUser(store, "alice", "member");
    const agent = agentRecord();
    await store.agents.upsert(agent);
    const provider = fakeProvider([{ text: '{"skills":[],"memory":[]}' }]);
    const first = await agents.prepareTurn({ agent });
    await first.finish({ runId: "r1", task: "Draft the Acme recap", reply: "Done", reflectWith: { provider, model: "cheap" } });
    await agents.settle();
    expect(provider.requests).toHaveLength(0);
    const second = await agents.prepareTurn({ agent });
    await second.finish({ runId: "r2", task: "Perfect, that's how we do it.", reply: "Noted!", reflectWith: { provider, model: "cheap" } });
    await agents.settle();
    expect(provider.requests).toHaveLength(1);
    expect(String(provider.requests[0]!.at(-1)!.content)).toMatch(/Previous task — Asked: Draft the Acme recap/);
  });

  test("memory block is curated and capped", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, ownerId: ORG, agentId: "a", kind: "fact" as const, text: `fact number ${i} `.repeat(3), source: "user" as const, createdAt: i, updatedAt: i }));
    const block = memoryBlock(items);
    expect(block.length).toBeLessThanOrEqual(2_000);
    expect(block.startsWith("- fact number 0")).toBe(true);
  });
});

async function prepareBlock(agents: AgentRuntime, agent: AgentRecord): Promise<string> {
  return (await agents.prepareTurn({ agent })).systemBlock;
}

describe("agent CRUD and permissions", () => {
  test("members create private agents; sharing needs agents.share; viewers can't create", async () => {
    const { agents } = setup();
    const member = user("m", "member");
    const viewer = user("v", "viewer");
    const admin = user("a", "admin");
    expect(authorize(viewer, PERMISSIONS.AGENTS_USE)).toBe(true);
    expect(await agents.save(viewer, "default", input())).toMatch(/permission/);
    expect(await agents.save(member, "default", input({ visibility: "workspace" }))).toMatch(/admins/);
    const mine = await agents.save(member, "default", input());
    expect(mine).toMatchObject({ createdBy: "m", visibility: "private", workspaceId: "default" });
    const shared = await agents.save(admin, "default", input({ name: "Team Writer", visibility: "workspace" }));
    expect(typeof shared).toBe("object");
    // Private agents are their creator's alone.
    expect((await agents.list(viewer, "default")).map((a) => a.name)).toEqual(["Team Writer"]);
    expect((await agents.list(member, "default")).map((a) => a.name)).toEqual(["Research Dot", "Team Writer"]);
    // Only the creator (or an admin) edits.
    const id = (shared as AgentRecord).id;
    expect(await agents.save(member, "default", input({ id, name: "Hijack", visibility: "workspace" }))).toMatch(/admins|only edit/);
    expect(await agents.remove(member, "default", id)).toMatch(/only delete/);
    expect(await agents.remove(admin, "default", id)).toBeUndefined();
    // Avatars from the browser are normalized.
    const odd = await agents.save(member, "default", input({ avatar: { ...randomAvatar("q"), palette: "neon" } }));
    expect((odd as AgentRecord).avatar.palette).not.toBe("neon");
  });

  test("@mention picks a visible agent and strips the name", async () => {
    const { agents } = setup();
    const owner = ownerPrincipal(ORG, "local");
    await agents.save(owner, "default", input({ name: "Sales Buddy" }));
    await agents.save(owner, "default", input({ name: "Sales" }));
    expect(await agents.findByMention(owner, "default", "@Sales Buddy, draft the follow-up")).toMatchObject({ agent: { name: "Sales Buddy" }, text: "draft the follow-up" });
    expect(await agents.findByMention(owner, "default", "@salesbuddy draft")).toMatchObject({ agent: { name: "Sales Buddy" }, text: "draft" });
    expect(await agents.findByMention(owner, "default", "@Sales: hi")).toMatchObject({ agent: { name: "Sales" }, text: "hi" });
    expect(await agents.findByMention(owner, "default", "@Nobody hi")).toBeUndefined();
    expect(await agents.findByMention(owner, "default", "email me@sales.com")).toBeUndefined();
  });

  test("protocol: strict agent messages", () => {
    expect(parseClientMessage({ type: "agent.save", agent: input() }).success).toBe(true);
    expect(parseClientMessage({ type: "agent.save", agent: { ...input(), autonomy: "yolo" } }).success).toBe(false);
    expect(parseClientMessage({ type: "agent.save", agent: { ...input(), name: "" } }).success).toBe(false);
    expect(parseClientMessage({ type: "agent.save", agent: { ...input(), access: { mode: "controlled", tools: [1] } } }).success).toBe(false);
    expect(parseClientMessage({ type: "agent.select", agentId: null }).success).toBe(true);
    expect(parseClientMessage({ type: "user.text", text: "hi", agentId: "../x" }).success).toBe(false);
    expect(parseClientMessage({ type: "user.text", text: "hi", agentId: "ag1" })).toMatchObject({ success: true, data: { agentId: "ag1" } });
    expect(parseClientMessage({ type: "agent.proposal.decide", proposalId: "p1", decision: "rollback" }).success).toBe(true);
    expect(parseClientMessage({ type: "agent.proposal.decide", proposalId: "p1", decision: "approve", skill: { name: "Bad Name", title: "t", description: "d", instructions: "i" } }).success).toBe(false);
  });
});

describe("routines run as an agent", () => {
  test("the agent's prompt, tools and autonomy shape the run", async () => {
    const { store, agents, meter, tools } = setup();
    await addUser(store, "alice", "member");
    const send = tool("send_email", "write");
    const search = tool("web_search", "read");
    tools.register(send);
    tools.register(search);
    const agent = agentRecord({ autonomy: "act_then_tell", access: { mode: "controlled", tools: ["send_email"], connectors: [], knowledgeBaseIds: [], skillIds: [], secrets: [] } });
    await store.agents.upsert(agent);
    const provider = fakeProvider([{ calls: [{ id: "c1", name: "send_email", arguments: '{"to":"dana@x.test"}' }] }, { text: "Sent." }]);
    let n = 0;
    const approvals = new RoutineApprovalGate({ store, ownerId: ORG, createId: () => `ap${++n}`, now: () => NOW, log: () => undefined });
    const runner = createRoutineRunner({ store, tools, meter, provider, model: () => "brain", systemPrompt: "BRAIN", approvals, createId: () => `id${++n}`, now: () => NOW, log: () => undefined, agents });
    const routine: RoutineRecord = { id: "r1", ownerId: ORG, name: "Daily follow-ups", instruction: "Send follow-ups", cron: "0 8 * * *", timezone: "UTC", enabled: true, agentId: "ag1", createdAt: NOW, updatedAt: NOW };
    const handle: RunHandle = {
      run: { id: "run1", routineId: "r1", ownerId: ORG, status: "running", startedAt: NOW, costUsd: 0 },
      lastAttempt: true,
      async setStatus() {},
      addCost() {}
    };
    const outcome = await runner(routine, handle, new AbortController().signal);
    expect(outcome.status).toBe("succeeded");
    const system = String(provider.requests[0]![0]!.content);
    expect(system).toContain("## You are Sales Buddy");
    expect(system).toContain("send_email");
    expect(system).not.toContain("web_search");
    // act_then_tell: ran without an approval, and told the inbox.
    expect(send.calls).toHaveLength(1);
    expect(await store.approvals.listPending(ORG)).toEqual([]);
    expect(meter.agentTotals(ORG, "ag1").todayUsd).toBeGreaterThan(0);
  });

  test("a routine whose agent is gone fails cleanly", async () => {
    const { store, agents, meter, tools } = setup();
    const approvals = new RoutineApprovalGate({ store, ownerId: ORG, createId: () => "ap", now: () => NOW, log: () => undefined });
    const runner = createRoutineRunner({ store, tools, meter, provider: fakeProvider([]), model: () => "brain", systemPrompt: "B", approvals, createId: () => "x", now: () => NOW, log: () => undefined, agents });
    const outcome = await runner(
      { id: "r1", ownerId: ORG, name: "n", instruction: "i", cron: "0 8 * * *", timezone: "UTC", enabled: true, agentId: "gone", createdAt: NOW, updatedAt: NOW },
      { run: { id: "run1", routineId: "r1", ownerId: ORG, status: "running", startedAt: NOW, costUsd: 0 }, lastAttempt: true, async setStatus() {}, addCost() {} },
      new AbortController().signal
    );
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/agent/) });
  });
});

describe("gateway: chatting with an agent", () => {
  async function withGateway(run: (client: { send(m: unknown): void; waitFor(p: (m: ServerMessage) => boolean): Promise<ServerMessage>; messages: ServerMessage[] }, ctx: { provider: ReturnType<typeof fakeProvider>; send: ReturnType<typeof tool> }) => Promise<void>, agentExtra: Partial<AgentRecord> = {}) {
    const store = createMemoryStore();
    const tools = createToolRegistry();
    const sendTool = tool("send_email", "write");
    tools.register(sendTool);
    const meter = new GatewayUsageMeter({ store });
    const agents = new AgentRuntime({ store, ownerId: ORG, tools, meter, log: () => undefined });
    await store.agents.upsert(agentRecord({ createdBy: "local", ...agentExtra }));
    const runtime = createTestRuntime({ store, tools, meter, agents });
    const provider = fakeProvider([{ calls: [{ id: "c1", name: "send_email", arguments: '{"to":"dana@x.test"}' }] }, { text: "Done, Dana has it." }]);
    const providers: GatewayProviders = {
      llm: { async *streamText() { yield { delta: "plain" }; } },
      stt: { async transcribe() { return { text: "" }; } },
      tts: {
        async *synthesize(input) {
          yield { audio: new TextEncoder().encode(`voice:${input.voice}`), mimeType: "audio/mpeg", format: "mp3" };
        }
      },
      toolLlm: provider
    };
    const gateway = await createGatewayServer({ providers, host: "127.0.0.1", runtime, modelCatalog: { llm: [{ id: "m", label: "M" }], stt: [], tts: [] } });
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const messages: ServerMessage[] = [];
    const waiters: Array<{ p: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      messages.push(message);
      for (const w of [...waiters]) if (w.p(message)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(message);
      }
    });
    await new Promise((resolve) => socket.once("open", resolve));
    try {
      await run(
        {
          send: (m) => socket.send(JSON.stringify(m)),
          waitFor: (p) => {
            const found = messages.find(p);
            return found ? Promise.resolve(found) : new Promise((resolve) => waiters.push({ p, resolve }));
          },
          messages
        },
        { provider, send: sendTool }
      );
    } finally {
      socket.close();
      await agents.settle();
      await gateway.close();
    }
  }

  test("@mention answers as the agent; ask_first shows an approval card", async () => {
    await withGateway(async (client, { provider }) => {
      client.send({ type: "user.text", requestId: "q1", text: "@Sales Buddy send Dana the recap" });
      const turn = await client.waitFor((m) => m.type === AGENT_EVENTS.TURN);
      expect(turn).toMatchObject({ requestId: "q1", agentId: "ag1", name: "Sales Buddy" });
      const approval = await client.waitFor((m) => m.type === WS_EVENTS.APPROVAL_REQUEST);
      client.send({ type: "approval.decision", id: (approval as { approval: { id: string } }).approval.id, decision: "approve" });
      await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "q1");
      const system = String(provider.requests[0]![0]!.content);
      expect(system).toContain("## You are Sales Buddy");
      // The mention is not sent to the model.
      expect(JSON.stringify(provider.requests[0]!.at(-1))).toContain("send Dana the recap");
      expect(JSON.stringify(provider.requests[0]!.at(-1))).not.toContain("@Sales");
    });
  });

  test("agentId + act_then_tell runs the write without a card; agents.list works over the socket", async () => {
    await withGateway(
      async (client, { send }) => {
        client.send({ type: "agents.request" });
        const list = await client.waitFor((m) => m.type === AGENT_EVENTS.LIST);
        expect(list).toMatchObject({ canCreate: true, canShare: true, items: [{ id: "ag1", mine: true, canEdit: true }] });
        expect((list as { templates: unknown[] }).templates.length).toBe(4);
        client.send({ type: "user.text", requestId: "q2", text: "send Dana the recap", agentId: "ag1" });
        await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "q2");
        expect(send.calls).toHaveLength(1);
        expect(client.messages.some((m) => m.type === WS_EVENTS.APPROVAL_REQUEST)).toBe(false);
      },
      { autonomy: "act_then_tell" }
    );
  });

  test("voice preview answers with a spoken sample", async () => {
    await withGateway(async (client) => {
      client.send({ type: "agent.voice.preview", requestId: "v1", ttsVoice: "nova", name: "Sales Buddy" });
      const sample = await client.waitFor((m) => m.type === AGENT_EVENTS.VOICE_SAMPLE);
      expect(sample).toMatchObject({ requestId: "v1", mimeType: "audio/mpeg" });
      expect(Buffer.from((sample as { audio: string }).audio, "base64").toString()).toBe("voice:nova");
    });
  });

  test("an unknown agentId is refused", async () => {
    await withGateway(async (client) => {
      client.send({ type: "user.text", requestId: "q3", text: "hi", agentId: "nope" });
      const error = await client.waitFor((m) => m.type === "error");
      expect(error).toMatchObject({ message: expect.stringMatching(/agent/) });
    });
  });
});
