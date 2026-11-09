import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryStore,
  createToolRegistry,
  isHighRiskTool,
  usableTools,
  type AgentRecord,
  type Store,
  type ToolContext,
  type UsageMeter
} from "@open-gpt-live/core";
import { COMPUTER_EVENTS, parseAgentComputerSettings, parseAgentInput, parseClientMessage, parseServerMessage, type ServerMessage } from "@open-gpt-live/protocol";
import { createNoopMeter } from "../runtime.js";
import { computersConfig, type ComputersConfig } from "./config.js";
import { DockerDriver, dockerSocketPath, type Sandbox, type SandboxDriver, type SandboxSpec } from "./docker.js";
import { EgressProxy } from "./egress-proxy.js";
import { FileArea, safeFileName } from "./files.js";
import { ComputerService, type ActionOutcome } from "./service.js";
import { requestAllowed, type BrowserSession, type SessionEvents } from "./session.js";
import { Timeline } from "./timeline.js";
import { createComputerTools, onSite } from "./tools.js";

const OWNER = "owner";

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    ownerId: OWNER,
    workspaceId: "default",
    createdBy: "user-1",
    name: "Bee",
    description: "",
    avatar: { seed: "s", kind: "dot", palette: "sun", eyes: "round", mouth: "smile", accessory: "none" },
    instructions: "",
    access: { mode: "inherit" },
    autonomy: "ask_first",
    learning: "off",
    visibility: "private",
    computer: { enabled: true, idleMinutes: 2, dailyMinutes: 10 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as AgentRecord;
}

/* ───────────── pure helpers ───────────── */

describe("request guard", () => {
  it("never lets a form go out unless a write action was approved", () => {
    expect(requestAllowed("idle", "POST", "document")).toBe(false);
    expect(requestAllowed("read", "POST", "document")).toBe(false);
    expect(requestAllowed("write", "POST", "document")).toBe(true);
  });
  it("blocks data-sending requests during read actions only", () => {
    expect(requestAllowed("read", "POST", "fetch")).toBe(false);
    expect(requestAllowed("read", "PUT", "xhr")).toBe(false);
    expect(requestAllowed("idle", "POST", "fetch")).toBe(true);
    expect(requestAllowed("read", "GET", "fetch")).toBe(true);
    expect(requestAllowed("read", "GET", "document")).toBe(true);
  });
});

describe("onSite", () => {
  it("matches the host and its subdomains, ignoring www and scheme", () => {
    expect(onSite("https://www.example.com/a", "example.com")).toBe(true);
    expect(onSite("https://shop.example.com/a", "example.com")).toBe(true);
    expect(onSite("https://example.com/a", "https://example.com/login")).toBe(true);
    expect(onSite("https://evil-example.com/", "example.com")).toBe(false);
    expect(onSite("https://example.com.evil.io/", "example.com")).toBe(false);
    expect(onSite("about:blank", "example.com")).toBe(false);
    expect(onSite("https://example.com", "")).toBe(false);
  });
});

describe("config", () => {
  it("has safe defaults and ignores bad values", () => {
    const config = computersConfig({ SIBYL_COMPUTER_IDLE_MINUTES: "abc", SIBYL_COMPUTER_MAX_PER_WORKSPACE: "0", SIBYL_DATA_DIR: "/tmp/x" });
    expect(config.enabled).toBe(true);
    expect(config.idleMinutes).toBe(5);
    expect(config.maxPerWorkspace).toBe(3);
    expect(config.image).toMatch(/^sibyl-computer:\d+\.\d+\.\d+$/);
    expect(config.dataDir).toBe("/tmp/x/computers");
    expect(computersConfig({ SIBYL_COMPUTERS: "off" }).enabled).toBe(false);
  });
});

describe("docker driver", () => {
  it("reports unavailable clearly instead of running anything on the host", async () => {
    expect(dockerSocketPath({ DOCKER_HOST: "tcp://10.0.0.5:2375" })).toEqual({ error: expect.stringContaining("not a unix socket") });
    const driver = new DockerDriver(computersConfig({}), { DOCKER_HOST: "unix:///nonexistent/docker.sock" });
    const check = await driver.check();
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.reason).toMatch(/Docker is not running/);
  });
});

describe("protocol", () => {
  it("validates computer settings on agents", () => {
    expect(parseAgentComputerSettings({ enabled: true, idleMinutes: 5 })).toEqual({ success: true, data: { enabled: true, idleMinutes: 5 } });
    expect(parseAgentComputerSettings(undefined)).toEqual({ success: true, data: undefined });
    expect(parseAgentComputerSettings({ enabled: true, dailyMinutes: 0 })).toMatchObject({ success: false, error: expect.stringMatching(/dailyMinutes/) });
    expect(parseAgentComputerSettings({ enabled: "yes" })).toMatchObject({ success: false, error: expect.stringMatching(/enabled/) });
    const agent = parseAgentInput({
      name: "Bee",
      description: "",
      instructions: "",
      avatar: { seed: "s", kind: "dot", palette: "p", eyes: "e", mouth: "m", accessory: "a" },
      access: { mode: "inherit" },
      autonomy: "ask_first",
      learning: "off",
      visibility: "private",
      computer: { enabled: true, idleMinutes: 3 }
    });
    expect(agent.success ? agent.data.computer : agent.error).toEqual({ enabled: true, idleMinutes: 3 });
  });
  it("parses the computer messages both ways", () => {
    expect(parseClientMessage({ type: "computer.watch", agentId: "a-1" }).success).toBe(true);
    expect(parseClientMessage({ type: "computer.stop", agentId: "../x" }).success).toBe(false);
    expect(parseClientMessage({ type: "computer.timeline.request", agentId: "a-1", runId: "r1" }).success).toBe(true);
    expect(parseServerMessage({ type: "computer.frame", agentId: "a", mimeType: "image/jpeg", data: "AAAA", width: 1, height: 1, at: 1 }).success).toBe(true);
    expect(parseServerMessage({ type: "computer.status", status: { agentId: "a", state: "off", usedSecondsToday: 0, dailyMinutes: 1, idleMinutes: 1 } }).success).toBe(true);
    expect(parseServerMessage({ type: "computer.status", status: { agentId: "a", state: "dancing" } }).success).toBe(false);
  });
});

/* ───────────── files & timeline ───────────── */

describe("file area and timeline", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sibyl-computers-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps file names safe and respects the quota", async () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName(".env")).toBeUndefined();
    expect(safeFileName("report <final>.pdf")).toBe("report _final_.pdf");
    const files = new FileArea(dir, 10);
    const first = await files.write("a1", "notes.txt", new TextEncoder().encode("hello"));
    expect(first).toEqual({ name: "notes.txt", bytes: 5 });
    expect((await files.write("a1", "notes.txt", new TextEncoder().encode("12345"))).name).toBe("notes (2).txt");
    await expect(files.write("a1", "more.txt", new TextEncoder().encode("x"))).rejects.toThrow(/full/);
    expect(await files.readText("a1", "notes.txt")).toEqual({ text: "hello", truncated: false });
    expect(await files.path("a1", "../notes.txt")).toBeUndefined();
    expect((await files.list("a1")).map((f) => f.name).sort()).toEqual(["notes (2).txt", "notes.txt"]);
  });

  it("stores runs with thumbnails and lists them newest first", async () => {
    const timeline = new Timeline(dir);
    const base = { agentId: "a1", tool: "computer_open", label: "Opened", status: "ok" as const };
    await timeline.add({ ...base, id: "x1", runId: "run-1", at: 10 }, Buffer.from("jpg"));
    await timeline.add({ ...base, id: "x2", runId: "run-1", at: 20 });
    await timeline.add({ ...base, id: "x3", runId: "run-2", at: 30 });
    expect(await timeline.runs("a1")).toEqual([
      { runId: "run-2", startedAt: 30, endedAt: 30, actions: 1 },
      { runId: "run-1", startedAt: 10, endedAt: 20, actions: 2 }
    ]);
    const actions = await timeline.actions("a1", "run-1");
    expect(actions[0]?.thumb).toBe(Buffer.from("jpg").toString("base64"));
    expect(actions[1]?.thumb).toBeUndefined();
    expect(await timeline.actions("a1", "../etc")).toEqual([]);
  });
});

/* ───────────── egress proxy ───────────── */

describe("egress proxy", () => {
  let proxy: EgressProxy;
  let upstream: Server;
  const blocked: string[] = [];

  beforeEach(async () => {
    blocked.length = 0;
    upstream = createServer((_req, res) => res.end("upstream ok"));
    upstream.on("connect", () => undefined);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    proxy = new EgressProxy({
      bind: "127.0.0.1",
      port: 0,
      onBlocked: (_user, target) => blocked.push(target),
      // "public.test" resolves to a public address; everything else to what it says.
      resolveHost: async (host) => [{ address: host === "public.test" ? "93.184.216.34" : "10.0.0.1", family: 4 }],
      // The tunnel goes to the local upstream (stands in for the internet).
      connect: () => connect({ host: "127.0.0.1", port: upstreamPort })
    });
    await proxy.start();
  });
  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function rawConnect(target: string, auth?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect({ host: "127.0.0.1", port: proxy.port }, () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${auth}\r\n` : ""}\r\n`);
      });
      socket.once("data", (data) => {
        resolve(data.toString("utf8").split("\r\n")[0]!);
        socket.destroy();
      });
      socket.once("error", reject);
    });
  }

  it("asks for credentials", async () => {
    expect(await rawConnect("public.test:443")).toMatch(/^HTTP\/1.1 407/);
    expect(await rawConnect("public.test:443", Buffer.from("nobody:wrong").toString("base64"))).toMatch(/^HTTP\/1.1 407/);
  });

  it("tunnels to public addresses and refuses private, loopback and link-local ones", async () => {
    const creds = proxy.issue();
    const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
    expect(await rawConnect("public.test:443", auth)).toBe("HTTP/1.1 200 Connection Established");
    for (const target of ["169.254.169.254:80", "127.0.0.1:3000", "localhost:3000", "[::1]:443", "intranet.corp:443", "10.1.2.3:22"]) {
      expect(await rawConnect(target, auth), target).toMatch(/^HTTP\/1.1 403/);
    }
    expect(blocked).toHaveLength(6);
    proxy.revoke(creds.username);
    expect(await rawConnect("public.test:443", auth)).toMatch(/^HTTP\/1.1 407/);
  });

  it("refuses plain-http requests to private addresses", async () => {
    const creds = proxy.issue();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path: "http://169.254.169.254/latest/meta-data/",
          headers: { "proxy-authorization": `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}` }
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

/* ───────────── service ───────────── */

class FakeDriver implements SandboxDriver {
  started: SandboxSpec[] = [];
  stopped = 0;
  available = true;
  async check() {
    return this.available ? ({ ok: true } as const) : ({ ok: false, reason: "Docker is not running" } as const);
  }
  async start(spec: SandboxSpec): Promise<Sandbox> {
    this.started.push(spec);
    return { id: `sbx-${this.started.length}`, endpoint: "ws://fake", stop: async () => void (this.stopped += 1) };
  }
  async cleanup() {
    return 0;
  }
}

function fakeBrowser(events: SessionEvents): BrowserSession {
  let url = "about:blank";
  const fake = {
    lastFrame: undefined,
    url: () => url,
    title: async () => "Fake",
    queue: <T>(work: () => Promise<T>) => work(),
    thumbnail: async () => Buffer.from("thumb"),
    close: async () => undefined,
    go(next: string) {
      url = next;
      events.frame({ data: "AAAA", width: 10, height: 10, at: 1 });
    }
  };
  return fake as unknown as BrowserSession;
}

describe("computer service", () => {
  let dir: string;
  let store: Store;
  let driver: FakeDriver;
  let service: ComputerService;
  let now: number;
  let notices: Array<{ title: string; kind: string }>;
  let proxy: EgressProxy;

  const config = (): ComputersConfig => ({ ...computersConfig({ SIBYL_DATA_DIR: dir }), maxPerWorkspace: 1 });
  const context = (agentId = "agent-1"): ToolContext => ({
    signal: new AbortController().signal,
    ownerId: OWNER,
    runId: "run-1",
    agent: { id: agentId },
    store,
    meter: createNoopMeter(),
    log: () => undefined
  });
  const open = (ctx: ToolContext): Promise<ReturnType<ComputerService["act"]> extends Promise<infer R> ? R : never> =>
    service.act(ctx, "computer_open", async (browser): Promise<ActionOutcome> => {
      (browser as unknown as { go(url: string): void }).go("https://example.com/");
      return { content: "Opened", label: "Opened example.com" };
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sibyl-computers-svc-"));
    store = createMemoryStore();
    driver = new FakeDriver();
    now = Date.UTC(2026, 10, 9, 12);
    notices = [];
    proxy = new EgressProxy({ bind: "127.0.0.1", port: 0 });
    await proxy.start();
    const cfg = config();
    service = new ComputerService({
      store,
      ownerId: OWNER,
      meter: createNoopMeter() as UsageMeter,
      config: cfg,
      driver,
      proxy,
      files: new FileArea(cfg.dataDir, 1024 * 1024),
      timeline: new Timeline(cfg.dataDir),
      log: () => undefined,
      notify: (input) => void notices.push({ title: input.title, kind: input.kind }),
      now: () => now,
      openBrowser: async (_sandbox, events) => fakeBrowser(events)
    });
    await store.agents.upsert(agentRecord());
  });
  afterEach(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses without an agent that has a computer", async () => {
    const plain = await service.act({ ...context(), agent: undefined }, "computer_open", async () => ({ content: "", label: "" }));
    expect(plain).toMatchObject({ isError: true, content: expect.stringContaining("Only an agent") });
    await store.agents.upsert(agentRecord({ id: "agent-2", computer: { enabled: false } }));
    expect(await service.act(context("agent-2"), "computer_open", async () => ({ content: "", label: "" }))).toMatchObject({ isError: true, content: expect.stringContaining("has no computer") });
    expect(driver.started).toHaveLength(0);
  });

  it("reports unavailable with the reason and never starts a sandbox", async () => {
    driver.available = false;
    const result = await open(context());
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining("Docker is not running") });
    expect(driver.started).toHaveLength(0);
    expect((await service.status("agent-1")).state).toBe("unavailable");
  });

  it("starts on demand with the egress proxy, records the timeline and streams to watchers", async () => {
    const seen: ServerMessage[] = [];
    const unwatch = service.watch("agent-1", { send: (m) => seen.push(m), allowed: async () => true });
    const result = await open(context());
    expect(result).toEqual({ content: "Opened" });
    expect(driver.started[0]?.proxy.server).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(driver.started[0]?.proxy.username).toMatch(/^sbx-/);
    await open(context());
    expect(driver.started).toHaveLength(1); // one sandbox per agent
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen.some((m) => m.type === COMPUTER_EVENTS.ACTION && m.action.label === "Opened example.com")).toBe(true);
    expect(seen.some((m) => m.type === COMPUTER_EVENTS.FRAME)).toBe(true);
    const timeline = await service.timeline("agent-1");
    expect(timeline.runId).toBe("run-1");
    expect(timeline.actions).toHaveLength(2);
    expect(timeline.actions[0]?.thumb).toBe(Buffer.from("thumb").toString("base64"));
    expect((await service.status("agent-1")).state).toBe("running");
    unwatch();
  });

  it("limits sandboxes per workspace", async () => {
    await store.agents.upsert(agentRecord({ id: "agent-2" }));
    await open(context());
    const second = await open(context("agent-2"));
    expect(second).toMatchObject({ isError: true, content: expect.stringContaining("already running in this workspace") });
  });

  it("stops when idle and meters the time used", async () => {
    await open(context());
    now += 60_000;
    await service.runChecks();
    expect(service.runningAgents()).toEqual(["agent-1"]);
    now += 61_000; // idle 2 min
    await service.runChecks();
    expect(service.runningAgents()).toEqual([]);
    expect(driver.stopped).toBe(1);
    const status = await service.status("agent-1");
    expect(status).toMatchObject({ state: "off", usedSecondsToday: 121 });
    const actions = (await service.timeline("agent-1")).actions;
    expect(actions.at(-1)).toMatchObject({ tool: "computer_stop", detail: expect.stringContaining("idle") });
  });

  it("pauses cleanly at the daily limit and tells the creator", async () => {
    await store.agents.upsert(agentRecord({ computer: { enabled: true, idleMinutes: 120, dailyMinutes: 1 } }));
    await open(context());
    now += 65_000;
    await service.runChecks();
    expect(service.runningAgents()).toEqual([]);
    expect(notices).toEqual([{ kind: "budget_blocked", title: "Bee's computer paused" }]);
    expect((await service.status("agent-1")).state).toBe("paused");
    const again = await open(context());
    expect(again).toMatchObject({ isError: true, content: expect.stringContaining("used up") });
    expect(driver.started).toHaveLength(1);
    now += 24 * 3_600_000; // next day
    expect((await open(context())).isError).toBeUndefined();
  });

  it("stops when the agent's computer is turned off or the agent is deleted", async () => {
    await open(context());
    await store.agents.upsert(agentRecord({ computer: { enabled: false } }));
    await service.reconcile();
    expect(service.runningAgents()).toEqual([]);
    expect(await service.stop("agent-1", "again")).toBe(false);
  });
});

/* ───────────── tools ───────────── */

describe("computer tools", () => {
  const tools = createComputerTools({ service: {} as ComputerService, files: {} as FileArea, vault: () => undefined });
  const byName = (name: string) => tools.find((tool) => tool.name === name)!;

  it("are offered only to agents with a computer", () => {
    const registry = createToolRegistry();
    for (const tool of tools) registry.register(tool);
    const all = registry.list();
    expect(usableTools(all, {})).toHaveLength(0);
    expect(usableTools(all, { agent: { id: "a", computer: { enabled: false } } })).toHaveLength(0);
    expect(usableTools(all, { agent: { id: "a", computer: { enabled: true } } })).toHaveLength(tools.length);
  });

  it("make sending, uploading and buying write actions; buying is high risk", () => {
    const writes = tools.filter((tool) => tool.effect === "write").map((tool) => tool.name).sort();
    expect(writes).toEqual(["computer_purchase", "computer_submit", "computer_upload"]);
    expect(isHighRiskTool(byName("computer_purchase"))).toBe(true);
    expect(isHighRiskTool(byName("computer_submit"))).toBe(false);
    expect(byName("computer_purchase").approvalSummary?.({ site: "shop.example.com", amount: "€24.90", description: "2 cables" })).toBe(
      "Pay €24.90 on shop.example.com from the agent's browser: 2 cables."
    );
    expect(byName("computer_submit").approvalSummary?.({ site: "example.com", description: "Sign in as ana" })).toContain("Submit on example.com");
  });
});
