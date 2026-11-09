import type { ChatToolCall, ToolChatEvent, ToolChatProvider } from "@open-gpt-live/adapters";
import { createGovernance, createMemoryStore, type AuditEntryInput, type Governance, type ToolDefinition } from "@open-gpt-live/core";
import { describe, expect, it } from "vitest";
import { createNoopMeter } from "../runtime.js";
import { ModelNotAllowedError, runToolLoop, type ToolLoopInput } from "./tool-loop.js";

/** One round that calls `calls`, then a final answer. */
function model(calls: ChatToolCall[]): ToolChatProvider {
  let round = 0;
  return {
    async *streamWithTools(): AsyncIterable<ToolChatEvent> {
      round += 1;
      if (round === 1) yield { type: "tool_calls", calls };
      else yield { type: "text", delta: "done" };
    }
  };
}

function tool(name: string, effect: "read" | "write", ran: string[]): ToolDefinition {
  return { name, title: name, description: name, inputSchema: { type: "object" }, effect, source: "builtin", run: async () => (ran.push(name), { content: "ok" }) };
}

function loop(governance: Governance, tools: ToolDefinition[], calls: string[], extra: Partial<ToolLoopInput> = {}) {
  const finished: Array<{ toolName: string; status: string; summary?: string }> = [];
  const input: ToolLoopInput = {
    provider: model(calls.map((name, i) => ({ id: `c${i}`, name, arguments: "{}" }))),
    messages: [{ role: "user", content: "go" }],
    model: "brain/deep",
    tools,
    signal: new AbortController().signal,
    runId: "run1",
    ownerId: "owner",
    principal: { kind: "user", orgId: "owner", userId: "u1", orgRole: "member", workspaceRoles: { default: "member" } },
    workspaceId: "default",
    governance,
    store: createMemoryStore(),
    meter: createNoopMeter(),
    log: () => {},
    onText: () => {},
    onToolStarted: () => {},
    onToolFinished: (call) => void finished.push(call),
    approve: async () => "approved",
    ...extra
  };
  return { run: () => runToolLoop(input), finished };
}

describe("tool loop governance", () => {
  it("refuses a blocked tool at run time, asks an admin for marked writes, and audits writes and approvals", async () => {
    const governance = createGovernance({ orgId: "owner" });
    const audit: AuditEntryInput[] = [];
    governance.registerAuditSink((entry) => void audit.push(entry));
    governance.registerToolPolicy({ tool: (t) => (t.name === "blocked_read" ? { allowed: false, reason: "Not here." } : { secondApproval: true }) });
    const second: string[] = [];
    governance.setSecondApprover(async (request) => (second.push(request.tool.name), request.tool.name === "send_ok" ? "approved" : "declined"));
    const ran: string[] = [];
    const tools = [tool("blocked_read", "read", ran), tool("send_ok", "write", ran), tool("send_no", "write", ran)];
    const { run, finished } = loop(governance, tools, ["blocked_read", "send_ok", "send_no"]);
    await run();
    expect(ran).toEqual(["send_ok"]);
    expect(second).toEqual(["send_ok", "send_no"]);
    expect(finished.map((f) => [f.toolName, f.status, f.summary ?? ""])).toEqual([
      ["blocked_read", "declined", "Blocked by policy"],
      ["send_ok", "ok", ""],
      ["send_no", "declined", "Declined by an admin"]
    ]);
    expect(audit.map((a) => `${a.action}:${a.target?.id}:${a.outcome}`)).toEqual([
      "tool.blocked:blocked_read:denied",
      "approval.decided:send_ok:success",
      "tool.write:send_ok:success",
      "approval.decided:send_no:success"
    ]);
    expect(audit[2]).toMatchObject({ actor: { kind: "user", userId: "u1" }, workspaceId: "default", details: { runId: "run1" } });
  });

  it("refuses to run a model that is not on the allowlist", async () => {
    const governance = createGovernance({ orgId: "owner" });
    const audit: AuditEntryInput[] = [];
    governance.registerAuditSink((entry) => void audit.push(entry));
    governance.registerToolPolicy({ model: (m) => (m === "brain/deep" ? { allowed: false, reason: "Not allowed." } : undefined) });
    const { run } = loop(governance, [], []);
    await expect(run()).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(audit.map((a) => a.action)).toEqual(["model.blocked"]);
  });

  it("without policies nothing changes (open source)", async () => {
    const ran: string[] = [];
    const { run, finished } = loop(createGovernance({ orgId: "owner" }), [tool("send", "write", ran)], ["send"]);
    await run();
    expect(ran).toEqual(["send"]);
    expect(finished[0]?.status).toBe("ok");
  });
});
