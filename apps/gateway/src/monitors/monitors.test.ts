import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolChatEvent, ToolChatProvider } from "@open-gpt-live/adapters";
import {
  createMemoryStore,
  createToolRegistry,
  ownerPrincipal,
  randomAvatar,
  type MonitorRecord,
  type Principal,
  type Store,
  type ToolDefinition,
  type UsageEvent
} from "@open-gpt-live/core";
import { MONITOR_EVENTS, NOTIFICATION_EVENTS, parseMonitorInput, type MonitorInput, type ServerMessage } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { AgentRuntime } from "../agents/runtime.js";
import { GatewayUsageMeter } from "../metering/meter.js";
import { installNotifications } from "../notifications/index.js";
import type { NotificationInput } from "../notifications/service.js";
import { RoutineApprovalGate } from "../routines/runner.js";
import { RoutineScheduler } from "../routines/scheduler.js";
import { SecretVault } from "../secrets/vault.js";
import { parseMatches } from "./ask.js";
import { evaluate } from "./engine.js";
import { handleMonitorsHttp } from "./http.js";
import { applyFilters, diffItems, extractList, passesFilter, readState, rememberItems, toItems } from "./items.js";
import { estimateMonthlyCost, everyWords } from "./records.js";
import { MAX_CONSECUTIVE_FAILURES, MonitorService, signBody, verifySignature } from "./service.js";
import { parseFeed } from "./sources.js";
import { createMonitorTools, toolInputToMonitorInput } from "./tools.js";

const NOW = Date.parse("2026-11-09T08:00:00Z");
const OWNER = "owner";

/* ───────────── helpers ───────────── */

function scripted(replies: string[], costUsd = 0.001): ToolChatProvider & { requests: Array<{ content: string }> } {
  const provider = {
    requests: [] as Array<{ content: string }>,
    async *streamWithTools(messages: Array<{ role: string; content: unknown }>): AsyncIterable<ToolChatEvent> {
      provider.requests.push({ content: String(messages[messages.length - 1]?.content ?? "") });
      const reply = replies[provider.requests.length - 1] ?? "{\"matches\":[]}";
      yield { type: "text", delta: reply };
      yield { type: "usage", usage: { costUsd } };
    }
  };
  return provider as never;
}

interface Deal {
  id: string;
  name: string;
  amount: number;
  stage: string;
  url?: string;
}

function dealsTool(deals: { current: Deal[] | Error }): ToolDefinition {
  return {
    name: "crm_search_deals",
    title: "Search deals",
    description: "Search CRM deals.",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    source: "builtin",
    async run(_input, context) {
      if (!context.principal) throw new Error("no principal");
      if (deals.current instanceof Error) return { content: deals.current.message, isError: true };
      return { content: "deals", data: { results: deals.current } };
    }
  };
}

function setup(options: { replies?: string[]; env?: NodeJS.ProcessEnv; deals?: Deal[]; vault?: boolean } = {}) {
  let now = NOW;
  let id = 0;
  const store = createMemoryStore();
  const meter = new GatewayUsageMeter({ store, limits: {}, now: () => now });
  const recorded: UsageEvent[] = [];
  const original = meter.record.bind(meter);
  meter.record = (event) => {
    recorded.push({ id: "x", at: now, ...event } as UsageEvent);
    original(event);
  };
  const tools = createToolRegistry();
  const deals = { current: (options.deals ?? []) as Deal[] | Error };
  tools.register(dealsTool(deals));
  tools.register({
    name: "send_email",
    title: "Send email",
    description: "Send.",
    inputSchema: { type: "object" },
    effect: "write",
    source: "builtin",
    run: async () => ({ content: "sent" })
  });
  const mail: Array<{ to: string; subject: string; text: string }> = [];
  const vault = options.vault ? new SecretVault({ store, key: randomBytes(32) }) : undefined;
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  // The one notifications path, with the shared mailer's transport faked.
  const notifications = installNotifications({
    store,
    ownerId: OWNER,
    env: options.env ?? {},
    log: () => undefined,
    now: () => now,
    ...(options.env?.SIBYL_SMTP_URL ? { transport: async () => ({ sendMail: async (message: { to: string; subject: string; text: string }) => void mail.push(message) }) } : {})
  });
  const service = new MonitorService({
    store,
    tools,
    meter,
    ownerId: OWNER,
    env: options.env ?? {},
    log: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    createId: () => `id-${++id}`,
    now: () => now,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    notifications,
    ...(vault ? { vault: () => vault } : {})
  });
  const provider = scripted(options.replies ?? []);
  service.configure({ provider, model: () => "brain/deep", askModel: () => "small/model", systemPrompt: "BRAIN" });
  for (const tool of createMonitorTools(service)) tools.register(tool);
  const owner = { principal: ownerPrincipal(OWNER, "local"), workspaceId: "default" };
  return {
    store,
    meter,
    recorded,
    tools,
    deals,
    mail,
    notifications,
    vault,
    logs,
    service,
    provider,
    owner,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now
  };
}

const dealInput = (extra: Partial<MonitorInput> = {}): MonitorInput => ({
  name: "Big deals in Negotiation",
  source: { kind: "tool", toolName: "crm_search_deals", input: { query: "open" } },
  schedule: { everyMinutes: 15 },
  condition: {
    filter: [
      { path: "stage", op: "changed", value: "negotiation" },
      { path: "amount", op: "gt", value: 50000 }
    ]
  },
  actions: [{ kind: "notify", channels: ["inbox"] }],
  ...extra
});

async function check(env: ReturnType<typeof setup>, id: string): Promise<MonitorRecord> {
  await env.service.runCheck(id, new AbortController().signal);
  return (await env.store.monitors.get(OWNER, id))!;
}

/* ───────────── items, filters, diff ───────────── */

describe("items and filters", () => {
  test("extracts lists and keys items by id, dedupe path or hash", () => {
    expect(extractList({ results: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(extractList({ data: { items: [{ id: 2 }] } })).toEqual([{ id: 2 }]);
    expect(extractList({ text: "hi" })).toEqual([{ text: "hi" }]);
    const items = toItems([{ id: "a", title: "One", url: "https://x.test/a" }, { ref: { n: 7 }, name: "Two" }, { id: "a", title: "dup" }], undefined);
    expect(items.map((i) => i.key)).toEqual(["a", expect.stringMatching(/^[0-9a-f]{24}$/)]);
    expect(items[0]).toMatchObject({ title: "dup" });
    expect(toItems([{ ref: { n: 7 } }], "ref.n")[0]!.key).toBe("7");
  });

  test("filter ops", () => {
    const item = { amount: "60,000", stage: "Negotiation", tags: ["vip", "eu"], closes: "2026-12-01" };
    const prev = { seen: false, value: undefined };
    expect(passesFilter(item, { path: "amount", op: "gt", value: 50000 }, prev)).toBe(true);
    expect(passesFilter(item, { path: "stage", op: "eq", value: "negotiation" }, prev)).toBe(true);
    expect(passesFilter(item, { path: "tags", op: "contains", value: "VIP" }, prev)).toBe(true);
    expect(passesFilter(item, { path: "stage", op: "in", value: ["won", "negotiation"] }, prev)).toBe(true);
    expect(passesFilter(item, { path: "closes", op: "lt", value: "2027-01-01" }, prev)).toBe(true);
    expect(passesFilter(item, { path: "missing", op: "exists" }, prev)).toBe(false);
    expect(passesFilter(item, { path: "stage", op: "changed", value: "negotiation" }, { seen: true, value: "Qualified" })).toBe(true);
    expect(passesFilter(item, { path: "stage", op: "changed" }, { seen: true, value: "Negotiation" })).toBe(false);
  });

  test("diff finds new items; changed ones only when the monitor watches changes", () => {
    const monitor = { source: { kind: "rss" as const, url: "https://x.test/feed" }, condition: {} };
    const first = toItems([{ id: "1", t: "a" }, { id: "2", t: "b" }], undefined);
    const state = rememberItems(monitor, undefined, first);
    const next = toItems([{ id: "1", t: "a2" }, { id: "2", t: "b" }, { id: "3", t: "c" }], undefined);
    expect(diffItems(monitor, next, state).candidates.map((i) => i.key)).toEqual(["3"]);
    const watching = { ...monitor, condition: { filter: [{ path: "t", op: "changed" as const }] } };
    const tracked = rememberItems(watching, undefined, first);
    const candidates = diffItems(watching, next, tracked).candidates;
    expect(candidates.map((i) => i.key)).toEqual(["1", "3"]);
    expect(applyFilters(watching, candidates, tracked).map((i) => i.key)).toEqual(["1", "3"]);
    expect(readState(tracked)?.values?.["k:1"]).toEqual({ t: "a" });
  });

  test("parses RSS and Atom feeds", () => {
    const rss = `<?xml version="1.0"?><rss><channel><title>Blog</title>
      <item><title><![CDATA[Launch &amp; more]]></title><link>https://blog.test/launch</link><guid>g1</guid><pubDate>Mon, 09 Nov 2026 07:00:00 GMT</pubDate><description>&lt;p&gt;We launched&lt;/p&gt;</description></item>
      <item><title>Second</title><link>/second</link></item></channel></rss>`;
    expect(parseFeed(rss, "https://blog.test/feed")).toEqual([
      { id: "g1", title: "Launch & more", url: "https://blog.test/launch", published: "Mon, 09 Nov 2026 07:00:00 GMT", summary: "We launched" },
      { id: "https://blog.test/second", title: "Second", url: "https://blog.test/second" }
    ]);
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:1</id><title>Post</title><link rel="alternate" href="https://a.test/p"/><updated>2026-11-09T00:00:00Z</updated><summary>Hi</summary></entry></feed>`;
    expect(parseFeed(atom)).toEqual([{ id: "urn:1", title: "Post", url: "https://a.test/p", published: "2026-11-09T00:00:00Z", summary: "Hi" }]);
    expect(parseFeed("<html><body>nope</body></html>")).toBeUndefined();
  });

  test("parses the model's matches defensively", () => {
    expect([...parseMatches("```json\n{\"matches\":[{\"i\":1,\"why\":\"big\"},{\"i\":9},{\"i\":\"0\"}]}\n```", 3)]).toEqual([
      [1, "big"],
      [0, ""]
    ]);
    expect(parseMatches("no json", 3).size).toBe(0);
  });

  test("test mode evaluates everything; the model only sees filtered candidates, capped", async () => {
    const monitor = {
      id: "m",
      source: { kind: "rss", url: "https://x.test" },
      condition: { filter: [{ path: "n", op: "gte", value: 1 }], ask: "odd?" },
      dedupe: {},
      name: "n"
    } as unknown as MonitorRecord;
    const raw = Array.from({ length: 30 }, (_, n) => ({ id: String(n), n }));
    const seen: number[] = [];
    const result = await evaluate({
      monitor,
      raw,
      mode: "check",
      ask: async (items) => {
        seen.push(items.length);
        return new Map([[0, "yes"]]);
      }
    });
    // First check of a polled monitor is a baseline.
    expect(result).toMatchObject({ baseline: true, matches: [] });
    const second = await evaluate({ monitor: { ...monitor, state: { v: 1, seen: {} } }, raw, mode: "check", ask: async (items) => (seen.push(items.length), new Map([[0, "yes"]])) });
    expect(seen).toEqual([20]);
    expect(second).toMatchObject({ candidates: 29, deferred: 9 });
    expect(second.matches.map((m) => m.item.key)).toEqual(["1"]);
    expect(Object.keys(second.nextState!.seen)).toHaveLength(21); // 9 deferred stay unseen
  });
});

/* ───────────── protocol + words ───────────── */

describe("monitor input", () => {
  test("strict parser", () => {
    const rejects = (input: unknown, error: RegExp) => expect(parseMonitorInput(input)).toMatchObject({ success: false, error: expect.stringMatching(error) });
    expect(parseMonitorInput(dealInput())).toMatchObject({ success: true, data: { name: "Big deals in Negotiation" } });
    rejects({ ...dealInput(), schedule: { everyMinutes: 2 } }, /everyMinutes/);
    rejects({ ...dealInput(), source: { kind: "rss", url: "ftp://x" } }, /http/);
    rejects({ ...dealInput(), condition: { filter: [{ path: "a b", op: "eq", value: 1 }] } }, /path/);
    rejects({ ...dealInput(), actions: [] }, /actions/);
    rejects({ ...dealInput(), actions: [{ kind: "notify", channels: ["pager"] }] }, /channels/);
    rejects({ ...dealInput(), budget: { dailyUsd: 0 } }, /dailyUsd/);
  });

  test("frequency words and cost estimate", () => {
    expect(everyWords(15)).toBe("every 15 minutes");
    expect(everyWords(60)).toBe("every hour");
    expect(everyWords(1440)).toBe("once a day");
    const base = { source: { kind: "rss" as const, url: "x" }, schedule: { everyMinutes: 60 }, actions: [{ kind: "notify" as const, channels: ["inbox" as const] }] };
    expect(estimateMonthlyCost({ ...base, condition: {} }, { askUsd: 0.001, taskUsd: 0.05 })).toEqual({ typicalMonthUsd: 0, maxMonthUsd: 0 });
    expect(estimateMonthlyCost({ ...base, condition: { ask: "x" } }, { askUsd: 0.001, taskUsd: 0.05 })).toEqual({ typicalMonthUsd: 0.072, maxMonthUsd: 0.72 });
    expect(estimateMonthlyCost({ ...base, condition: { ask: "x" }, budget: { dailyUsd: 0.01 } }, { askUsd: 0.001, taskUsd: 0 }).maxMonthUsd).toBe(0.3);
  });
});

/* ───────────── the service ───────────── */

describe("MonitorService checks", () => {
  test("baseline, then fires on a deal moving to Negotiation; inbox + email; metered", async () => {
    const env = setup({
      env: { SIBYL_SMTP_URL: "smtp://x", SIBYL_MONITOR_EMAIL: "owner@x.test" },
      deals: [
        { id: "d1", name: "Acme", amount: 80000, stage: "Qualified", url: "https://crm.test/d1" },
        { id: "d2", name: "Tiny", amount: 1000, stage: "Qualified" }
      ]
    });
    const pushed: ServerMessage[] = [];
    env.service.subscribe({ send: (m) => void pushed.push(m), principal: () => env.owner.principal, workspaceId: () => "default" });
    env.notifications.subscribe({ send: (m) => void pushed.push(m), principal: () => env.owner.principal, workspaceId: () => "default" });
    const { monitor } = await env.service.create(env.owner, dealInput({ actions: [{ kind: "notify", channels: ["inbox", "email"] }] }));
    expect(monitor).toMatchObject({ frequency: "every 15 minutes", status: "active", mine: true });

    let record = await check(env, monitor.id);
    expect(record.lastFiredAt).toBeUndefined();
    expect(await env.store.monitors.listEvents(OWNER)).toEqual([]);

    env.deals.current = [
      { id: "d1", name: "Acme", amount: 80000, stage: "Negotiation", url: "https://crm.test/d1" },
      { id: "d2", name: "Tiny", amount: 1000, stage: "Negotiation" }
    ];
    env.advance(15 * 60_000);
    record = await check(env, monitor.id);
    expect(record.lastFiredAt).toBe(env.now());
    const [event] = await env.store.monitors.listEvents(OWNER);
    expect(event).toMatchObject({ kind: "fired", summary: "1 new match for “Big deals in Negotiation”: Acme.", links: ["https://crm.test/d1"] });
    expect(event!.actions).toEqual([
      { kind: "notify", channel: "inbox", status: "sent" },
      { kind: "notify", channel: "email", status: "sent" }
    ]);
    expect(env.mail).toEqual([expect.objectContaining({ to: "owner@x.test", subject: expect.stringContaining("Acme"), text: expect.stringContaining("https://crm.test/d1") })]);
    const live = pushed.find((m) => m.type === NOTIFICATION_EVENTS.NOTIFICATION);
    expect(live).toMatchObject({ notification: { kind: "monitor_fired", title: event!.summary, links: { monitorId: monitor.id } }, unread: { total: 1 } });
    // The notice is stored once, for the creator, through the one notifications path.
    expect(await env.store.notifications.list(OWNER)).toEqual([expect.objectContaining({ kind: "monitor_fired", recipientUserId: "owner", workspaceId: "default" })]);
    expect(pushed.some((m) => m.type === MONITOR_EVENTS.STATUS)).toBe(true);

    // Same data again: nothing new.
    record = await check(env, monitor.id);
    expect(await env.store.monitors.listEvents(OWNER)).toHaveLength(1);
    expect(env.provider.requests).toHaveLength(0); // no ask: the model was never called
  });

  test("plain-language ask runs only on new candidates, is metered as monitor, emails the creator", async () => {
    const env = setup({ replies: ["{\"matches\":[{\"i\":0,\"why\":\"mentions pricing\"}]}"], env: { SIBYL_SMTP_URL: "smtp://x", SIBYL_MONITOR_EMAIL: "me@x.test" } });
    env.deals.current = [{ id: "a", name: "Old", amount: 1, stage: "x" }];
    const input = dealInput({ condition: { ask: "Is it about pricing?" }, actions: [{ kind: "notify", channels: ["email"] }] });
    const { monitor } = await env.service.create(env.owner, input);
    await check(env, monitor.id);
    env.deals.current = [
      { id: "a", name: "Old", amount: 1, stage: "x" },
      { id: "b", name: "Pricing change", amount: 2, stage: "x" }
    ];
    const record = await check(env, monitor.id);
    expect(env.provider.requests).toHaveLength(1);
    expect(env.provider.requests[0]!.content).toContain("Pricing change");
    expect(env.provider.requests[0]!.content).not.toContain("\"Old\"");
    expect(env.recorded.filter((e) => e.feature === "monitor")).toEqual([expect.objectContaining({ monitorId: monitor.id, model: "small/model", costUsd: 0.001 })]);
    expect(record.spend?.dayUsd).toBeCloseTo(0.001);
    expect(env.mail).toEqual([expect.objectContaining({ to: "me@x.test", text: expect.stringContaining("Why: mentions pricing") })]);
  });

  test("daily budget stops the model; candidates wait for later", async () => {
    const env = setup({ replies: ["{\"matches\":[{\"i\":0}]}"] });
    const { monitor } = await env.service.create(env.owner, dealInput({ condition: { ask: "anything?" }, budget: { dailyUsd: 0.0001 } }));
    await check(env, monitor.id);
    env.deals.current = [{ id: "n", name: "New", amount: 1, stage: "x" }];
    const record = await check(env, monitor.id);
    expect(env.provider.requests).toHaveLength(0);
    expect(record.lastError).toMatch(/Daily budget/);
    expect(readState(record.state)?.seen["k:n"]).toBeUndefined();
  });

  test("failures back off, then auto-pause with the reason in the inbox", async () => {
    const env = setup();
    const { monitor } = await env.service.create(env.owner, dealInput());
    env.deals.current = new Error("HTTP 503 upstream");
    let record = await check(env, monitor.id);
    expect(record).toMatchObject({ failureCount: 1, lastError: expect.stringContaining("503"), enabled: true });
    expect(record.nextCheckAt).toBe(env.now() + 30 * 60_000);
    for (let i = 2; i <= MAX_CONSECUTIVE_FAILURES; i += 1) record = await check(env, monitor.id);
    expect(record).toMatchObject({ enabled: false, pausedReason: expect.stringContaining(`${MAX_CONSECUTIVE_FAILURES} failed checks`) });
    expect(record.nextCheckAt).toBeUndefined();
    const [event] = await env.store.monitors.listEvents(OWNER);
    expect(event).toMatchObject({ kind: "paused", actions: [{ kind: "notify", channel: "inbox", status: "sent" }] });
    expect(await env.store.notifications.list(OWNER)).toEqual([expect.objectContaining({ kind: "monitor_paused", links: { monitorId: monitor.id } })]);
    const view = (await env.service.list(env.owner)).monitors[0]!;
    expect(view.status).toBe("paused");
    // Resume clears the streak.
    const resumed = await env.service.pause(env.owner, monitor.id, false);
    expect(resumed).toMatchObject({ enabled: true, status: "active" });
  });

  test("runs on the routine scheduler as a second job type, with leases", async () => {
    const env = setup({ deals: [{ id: "a", name: "A", amount: 1, stage: "x" }] });
    const scheduler = new RoutineScheduler({
      store: env.store,
      ownerId: OWNER,
      runner: async () => ({ status: "succeeded" }),
      createId: () => "run",
      now: env.now,
      tickMs: 1_000_000
    });
    scheduler.addJobType(env.service.jobType);
    const { monitor } = await env.service.create(env.owner, dealInput());
    await scheduler.start();
    await scheduler.idle();
    let record = (await env.store.monitors.get(OWNER, monitor.id))!;
    expect(record.lastCheckedAt).toBe(NOW);
    expect(record.leaseUntil).toBeUndefined();
    expect(record.nextCheckAt).toBe(NOW + 15 * 60_000);
    // A stale lease (crash) is cleared on the next tick.
    await env.store.monitors.upsert({ ...record, leaseUntil: NOW - 1, nextCheckAt: NOW + 10 ** 9 });
    await scheduler.tick();
    record = (await env.store.monitors.get(OWNER, monitor.id))!;
    expect(record.leaseUntil).toBeUndefined();
    expect(await scheduler.runJobNow("monitor", monitor.id)).toBeUndefined();
    await scheduler.idle();
    await scheduler.stop();
  });

  test("dry run shows what would fire without saving or notifying", async () => {
    const env = setup({ deals: [{ id: "a", name: "Huge", amount: 90000, stage: "Negotiation" }] });
    const result = await env.service.test(env.owner, { input: dealInput() });
    expect(result).toMatchObject({ ok: true, fetched: 1, candidates: 1, matches: [{ key: "a", title: "Huge" }] });
    expect(await env.store.monitors.list(OWNER)).toEqual([]);
    expect(await env.store.monitors.listEvents(OWNER)).toEqual([]);
  });

  test("validation: write tools and private URLs can't be watched; unavailable channels are refused", async () => {
    const env = setup();
    await expect(env.service.create(env.owner, dealInput({ source: { kind: "tool", toolName: "send_email", input: {} } }))).rejects.toThrow(/changes things/);
    await expect(env.service.create(env.owner, dealInput({ source: { kind: "tool", toolName: "create_monitor", input: {} } }))).rejects.toThrow(/changes things|can't be watched/);
    await expect(env.service.create(env.owner, dealInput({ source: { kind: "rss", url: "http://127.0.0.1/feed" } }))).rejects.toThrow(/can't be watched/);
    await expect(env.service.create(env.owner, dealInput({ actions: [{ kind: "notify", channels: ["slack"] }] }))).rejects.toThrow(/Slack/);
    const { channels, sources } = await env.service.list(env.owner);
    expect(channels.find((c) => c.channel === "slack")).toMatchObject({ available: false });
    expect(sources.map((s) => s.toolName)).toEqual(["crm_search_deals"]);
  });
});

/* ───────────── people and privacy ───────────── */

describe("permissions and privacy", () => {
  async function people(store: Store) {
    const user = (id: string) => ({ id, orgId: OWNER, email: `${id}@x.test`, name: id, passwordHash: "x", createdAt: 1, updatedAt: 1 });
    for (const id of ["alice", "bob", "vera", "adam"]) await store.identity.users.upsert(user(id) as never);
    await store.identity.memberships.upsert(OWNER, { userId: "alice", scope: { workspaceId: "default" }, role: "member", createdAt: 1 } as never);
    await store.identity.memberships.upsert(OWNER, { userId: "bob", scope: { workspaceId: "default" }, role: "member", createdAt: 1 } as never);
    await store.identity.memberships.upsert(OWNER, { userId: "vera", scope: { workspaceId: "default" }, role: "viewer", createdAt: 1 } as never);
    await store.identity.memberships.upsert(OWNER, { userId: "adam", scope: { workspaceId: "default" }, role: "admin", createdAt: 1 } as never);
    const principal = (id: string, role: "member" | "viewer" | "admin"): Principal => ({ kind: "user", orgId: OWNER, userId: id, email: `${id}@x.test`, workspaceRoles: { default: role } });
    return {
      alice: { principal: principal("alice", "member"), workspaceId: "default" },
      bob: { principal: principal("bob", "member"), workspaceId: "default" },
      vera: { principal: principal("vera", "viewer"), workspaceId: "default" },
      adam: { principal: principal("adam", "admin"), workspaceId: "default" }
    };
  }

  test("creator-only details and events; admins can pause; viewers can't create", async () => {
    const env = setup({ deals: [{ id: "a", name: "A", amount: 99999, stage: "Qualified" }] });
    const p = await people(env.store);
    await expect(env.service.create(p.vera, dealInput())).rejects.toThrow(/monitors.manage/);
    const { monitor } = await env.service.create(p.alice, dealInput());
    expect(monitor.createdBy).toBe("alice");
    await check(env, monitor.id);
    env.deals.current = [{ id: "a", name: "A", amount: 99999, stage: "Negotiation" }];
    await check(env, monitor.id);
    expect(await env.service.events(p.alice, { limit: 10 })).toHaveLength(1);
    expect(await env.service.events(p.bob, { limit: 10 })).toHaveLength(0);
    await expect(env.service.events(p.bob, { monitorId: monitor.id, limit: 10 })).rejects.toThrow();
    expect((await env.service.list(p.bob)).monitors).toHaveLength(0);
    const adminView = (await env.service.list(p.adam)).monitors[0]!;
    expect(adminView).toMatchObject({ mine: false, condition: {} });
    await expect(env.service.update(p.adam, monitor.id, dealInput())).rejects.toThrow(/created this monitor/);
    expect((await env.service.pause(p.adam, monitor.id, true)).enabled).toBe(false);
    await expect(env.service.pause(p.bob, monitor.id, false)).rejects.toThrow();
  });

  test("a creator who lost access pauses the monitor", async () => {
    const env = setup();
    const p = await people(env.store);
    const { monitor } = await env.service.create(p.bob, dealInput());
    await env.store.identity.memberships.remove(OWNER, "bob", { workspaceId: "default" });
    const record = await check(env, monitor.id);
    expect(record).toMatchObject({ enabled: false, pausedReason: expect.stringContaining("no longer has access") });
  });
});

/* ───────────── tasks and autonomy ───────────── */

describe("task action", () => {
  async function taskSetup(autonomy: "ask_first" | "act_then_tell", budget?: { dailyUsd: number }) {
    const env = setup({ deals: [{ id: "a", name: "A", amount: 99999, stage: "Qualified" }] });
    let round = 0;
    const brain: ToolChatProvider = {
      async *streamWithTools() {
        round += 1;
        if (round === 1) yield { type: "tool_calls", calls: [{ id: "c1", name: "send_email", arguments: "{\"to\":\"x@y.z\"}" }] };
        else yield { type: "text", delta: "Drafted and sent the follow-up." };
        yield { type: "usage", usage: { costUsd: 0.002 } };
      }
    };
    const approvals: string[] = [];
    const gate = new RoutineApprovalGate({
      store: env.store,
      ownerId: OWNER,
      createId: () => `ap-${approvals.length + 1}`,
      now: env.now,
      log: () => undefined,
      onRequested: (view) => void approvals.push(view.summary)
    });
    // A routines stand-in that only exposes the approval gate.
    (env.service as unknown as { options: { routines: unknown } }).options.routines = { approvals: gate, scheduler: undefined };
    env.service.configure({ provider: brain, model: () => "brain/deep", systemPrompt: "BRAIN" });
    // The real agents runtime, wired as in runtime.ts.
    const notices: NotificationInput[] = [];
    const agents = new AgentRuntime({ store: env.store, ownerId: OWNER, tools: env.tools, meter: env.meter, log: () => undefined, now: env.now, notify: (n) => void notices.push(n) });
    env.service.agents = agents;
    await env.store.agents.upsert({
      id: "agent-1",
      ownerId: OWNER,
      workspaceId: "default",
      createdBy: "local",
      name: "Sales Buddy",
      description: "Follow-ups",
      avatar: randomAvatar("agent-1"),
      instructions: "Write crisp follow-ups.",
      access: { mode: "inherit" },
      autonomy,
      learning: "off",
      visibility: "workspace",
      ...(budget ? { budget } : {}),
      createdAt: NOW,
      updatedAt: NOW
    });
    const sent: unknown[] = [];
    env.tools.unregister("send_email");
    env.tools.register({ name: "send_email", title: "Send email", description: "Send.", inputSchema: { type: "object" }, effect: "write", source: "builtin", run: async (input) => (sent.push(input), { content: "sent" }) });
    return { env, approvals, gate, notices, sent };
  }

  async function fireTask(env: ReturnType<typeof setup>) {
    const { monitor } = await env.service.create(env.owner, dealInput({ agentId: "agent-1", actions: [{ kind: "task", instruction: "Send a follow-up" }] }));
    await check(env, monitor.id);
    env.deals.current = [{ id: "a", name: "A", amount: 99999, stage: "Negotiation" }];
    await check(env, monitor.id);
    return monitor.id;
  }

  test("act-then-tell agent runs the write without asking, posts an inbox notice and spends its own budget", async () => {
    const { env, approvals, notices, sent } = await taskSetup("act_then_tell");
    const id = await fireTask(env);
    const [event] = await env.store.monitors.listEvents(OWNER);
    expect(event!.actions).toEqual([{ kind: "task", status: "started" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(approvals).toEqual([]);
    expect(sent).toEqual([{ to: "x@y.z" }]);
    expect(notices).toEqual([
      expect.objectContaining({ kind: "agent_action", title: expect.stringMatching(/^Sales Buddy /), links: expect.objectContaining({ agentId: "agent-1" }) })
    ]);
    const record = (await env.store.monitors.get(OWNER, id))!;
    const conversation = await env.store.conversations.get(OWNER, record.conversationId!);
    expect(conversation!.messages.at(-1)!.content).toBe("Drafted and sent the follow-up.");
    // The agent's prompt block and model rounds: its instructions reach the brain, its spend counts toward its budget.
    expect(env.recorded.some((e) => e.feature === "monitor" && e.monitorId === id)).toBe(true);
    expect(env.meter.agentTotals(OWNER, "agent-1").todayUsd).toBeCloseTo(0.004);
    expect((await env.store.agentMemory.list(OWNER, "agent-1", { kind: "run" })).length).toBe(1);
  });

  test("ask-first agent sends the write to the approval inbox", async () => {
    const { env, approvals, gate, sent } = await taskSetup("ask_first");
    await fireTask(env);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(approvals).toHaveLength(1);
    const pending = await env.store.approvals.listPending(OWNER);
    expect(pending[0]).toMatchObject({ toolName: "send_email", routineId: expect.stringMatching(/^monitor:/) });
    expect(env.service.jobType.liveRunIds!().has(pending[0]!.runId)).toBe(true);
    await gate.decide(pending[0]!.id, "decline");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });

  test("the agent's own budget stops the task", async () => {
    const { env } = await taskSetup("act_then_tell", { dailyUsd: 0.001 });
    const id = await fireTask(env);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The first round (0.002) uses up the agent's day; the next round is not started.
    const record = (await env.store.monitors.get(OWNER, id))!;
    const conversation = await env.store.conversations.get(OWNER, record.conversationId!);
    expect(conversation!.messages.at(-1)!.content).toMatch(/^Task stopped: /);
    expect(conversation!.messages.at(-1)!.content).not.toContain("Drafted and sent");
  });
});

/* ───────────── chat tools ───────────── */

describe("chat tools", () => {
  test("create_monitor turns the brain's input into a monitor; the approval says frequency and cost", async () => {
    const env = setup();
    const tool = env.tools.get("create_monitor") as ToolDefinition & { approvalSummary(input: Record<string, unknown>): string };
    const input = {
      name: "Big deals",
      source: { kind: "tool", toolName: "crm_search_deals", input: {} },
      everyMinutes: 30,
      filter: [{ path: "amount", op: "gt", value: 50000 }],
      ask: "Did it move to Negotiation?"
    };
    expect(tool.effect).toBe("write");
    const summary = tool.approvalSummary(input);
    expect(summary).toContain("every 30 minutes");
    expect(summary).toContain("tell you (inbox)");
    expect(summary).toMatch(/Estimated cost: about \$[\d.]+ a month \(at most \$[\d.]+\)/);
    expect(toolInputToMonitorInput({ ...input, everyMinutes: 1 })).toMatchObject({ success: false, error: expect.stringMatching(/everyMinutes/) });
    const result = await tool.run(input, { signal: new AbortController().signal, ownerId: OWNER, runId: "r", store: env.store, meter: env.meter, log: () => undefined });
    expect(result.isError).toBeFalsy();
    const list = await env.tools.get("list_monitors")!.run({}, { signal: new AbortController().signal, ownerId: OWNER, runId: "r", store: env.store, meter: env.meter, log: () => undefined });
    expect(list.content).toContain("Big deals");
    const pause = await env.tools.get("pause_monitor")!.run({ monitor: "Big deals" }, { signal: new AbortController().signal, ownerId: OWNER, runId: "r", store: env.store, meter: env.meter, log: () => undefined });
    expect(pause.content).toBe("Paused “Big deals”.");
    const removed = await env.tools.get("delete_monitor")!.run({ monitor: "big deals" }, { signal: new AbortController().signal, ownerId: OWNER, runId: "r", store: env.store, meter: env.meter, log: () => undefined });
    expect(removed.content).toBe("Deleted “Big deals”.");
  });
});

/* ───────────── HTTP + webhooks ───────────── */

describe("HTTP", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function serve(env: ReturnType<typeof setup>, principal: Principal | undefined) {
    server = createServer((request, response) => {
      if (!handleMonitorsHttp({ monitors: env.service, authenticate: async () => (principal ? { principal } : undefined) }, request, response)) {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  test("API: create, list, pause, events, delete", async () => {
    const env = setup();
    const base = await serve(env, env.owner.principal);
    expect((await fetch(`${base}/api/monitors`, { method: "POST", body: JSON.stringify({ name: "" }) })).status).toBe(400);
    const created = await fetch(`${base}/api/monitors`, { method: "POST", body: JSON.stringify(dealInput()) });
    expect(created.status).toBe(201);
    const { monitor } = (await created.json()) as { monitor: { id: string } };
    const list = (await (await fetch(`${base}/api/monitors`)).json()) as { monitors: unknown[]; sources: unknown[]; channels: unknown[] };
    expect(list.monitors).toHaveLength(1);
    const paused = await fetch(`${base}/api/monitors/${monitor.id}/pause`, { method: "POST", body: JSON.stringify({ paused: true }) });
    expect(((await paused.json()) as { monitor: { status: string } }).monitor.status).toBe("paused");
    expect((await fetch(`${base}/api/monitors/${monitor.id}/run`, { method: "POST" })).status).toBe(409);
    expect((await (await fetch(`${base}/api/monitors/events?limit=5`)).json()) as unknown).toEqual({ events: [] });
    expect((await fetch(`${base}/api/monitors/events?limit=500`)).status).toBe(400);
    expect((await fetch(`${base}/api/monitors/${monitor.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/api/monitors/${monitor.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("unauthenticated API calls are refused", async () => {
    const env = setup();
    const base = await serve(env, undefined);
    expect((await fetch(`${base}/api/monitors`)).status).toBe(401);
  });

  test("webhook: signed deliveries fire, bad signatures are refused, retries don't fire twice", async () => {
    const env = setup({ vault: true });
    const base = await serve(env, env.owner.principal);
    const created = await fetch(`${base}/api/monitors`, {
      method: "POST",
      body: JSON.stringify(dealInput({ source: { kind: "webhook" }, condition: { filter: [{ path: "amount", op: "gt", value: 50000 }] } }))
    });
    const { monitor, webhook } = (await created.json()) as { monitor: { id: string; frequency: string }; webhook: { path: string; secret: string; secretRef: string } };
    expect(monitor.frequency).toBe("whenever the webhook is called");
    expect(webhook.secret).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.stringify({ deals: [{ id: "w1", name: "Webhook deal", amount: 70000 }, { id: "w2", name: "Small", amount: 5 }] });
    expect((await fetch(`${base}${webhook.path}`, { method: "POST", body, headers: { "x-sibyl-signature": "sha256=" + "0".repeat(64) } })).status).toBe(401);
    const ok = await fetch(`${base}${webhook.path}`, { method: "POST", body, headers: { "x-sibyl-signature": signBody(webhook.secret, body) } });
    expect(ok.status).toBe(202);
    await env.service.idle();
    await fetch(`${base}${webhook.path}`, { method: "POST", body, headers: { "x-sibyl-signature": signBody(webhook.secret, body) } });
    await env.service.idle();
    const events = await env.store.monitors.listEvents(OWNER);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ items: [{ key: "w1", title: "Webhook deal" }] });
    // Deleting the monitor removes its generated secret.
    await fetch(`${base}/api/monitors/${monitor.id}`, { method: "DELETE" });
    expect(await env.vault!.has(OWNER, webhook.secretRef)).toBe(false);
  });

  test("signature helper", () => {
    const body = Buffer.from("{}");
    expect(verifySignature("k", body, signBody("k", body))).toBe(true);
    expect(verifySignature("k", body, signBody("k", body).replace("sha256=", ""))).toBe(true);
    expect(verifySignature("other", body, signBody("k", body))).toBe(false);
    expect(verifySignature("k", body, undefined)).toBe(false);
  });
});
