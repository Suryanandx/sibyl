import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, auditActor, createGovernance, type AuditEntryInput, type GovernedTool } from "./governance";
import { usableTools } from "./tools";

const read: GovernedTool = { name: "web_search", effect: "read", source: "builtin" };
const write: GovernedTool = { name: "send_email", effect: "write", source: "connector", provider: "google" };

describe("governance", () => {
  it("without a licence (no sinks, no policies) records nothing and allows everything", async () => {
    const governance = createGovernance({ orgId: "owner" });
    expect(governance.auditing).toBe(false);
    governance.audit({ action: AUDIT_ACTIONS.SIGN_IN });
    expect(governance.toolDecision(write)).toEqual({ allowed: true });
    expect(governance.modelDecision("any/model")).toEqual({ allowed: true });
    // A second approval nobody can answer is declined, never silently approved.
    expect(await governance.secondApproval({ tool: { ...write, title: "Send" }, input: {}, runId: "r", signal: new AbortController().signal })).toBe("declined");
  });

  it("fills time, organization, actor and outcome, and isolates broken sinks", () => {
    const errors: string[] = [];
    const governance = createGovernance({ orgId: "org1", now: () => 42, onError: (where) => errors.push(where) });
    const seen: AuditEntryInput[] = [];
    const off = governance.registerAuditSink((entry) => void seen.push(entry));
    governance.registerAuditSink(() => {
      throw new Error("down");
    });
    governance.audit({ action: AUDIT_ACTIONS.SIGN_IN, actor: auditActor({ kind: "user", orgId: "org1", userId: "u1", email: "a@b.c", workspaceRoles: {} }) });
    expect(seen).toEqual([{ action: "auth.sign_in", orgId: "org1", at: 42, actor: { kind: "user", userId: "u1", email: "a@b.c" }, outcome: "success" }]);
    expect(errors).toEqual(["audit"]);
    off();
    governance.audit({ action: AUDIT_ACTIONS.SIGN_OUT });
    expect(seen).toHaveLength(1);
    expect(auditActor(undefined)).toEqual({ kind: "system" });
  });

  it("combines tool policies: a block wins, second approval only for writes, models by allowlist", () => {
    const governance = createGovernance({ orgId: "owner" });
    const off = governance.registerToolPolicy({
      tool: (tool) => (tool.name === "web_search" ? { allowed: false, reason: "No web." } : { secondApproval: true }),
      model: (model) => (model === "ok/model" ? undefined : { allowed: false })
    });
    expect(governance.toolDecision(read)).toEqual({ allowed: false, reason: "No web." });
    expect(governance.toolDecision(write)).toEqual({ allowed: true, secondApproval: true });
    expect(governance.toolDecision({ name: "lookup", effect: "read", source: "builtin" })).toEqual({ allowed: true });
    expect(governance.modelDecision("ok/model").allowed).toBe(true);
    expect(governance.modelDecision("other/model")).toMatchObject({ allowed: false });
    // usableTools leaves blocked tools out (and still honours isAvailable).
    const tools = [read, write, { ...write, name: "x", isAvailable: () => false }].map((t) => ({ ...t, title: t.name }));
    expect(usableTools(tools, { governance }).map((t) => t.name)).toEqual(["send_email"]);
    expect(usableTools(tools, {}).map((t) => t.name)).toEqual(["web_search", "send_email"]);
    off();
    expect(governance.toolDecision(read)).toEqual({ allowed: true });
  });

  it("a policy that throws blocks instead of allowing", () => {
    const governance = createGovernance({ orgId: "owner" });
    governance.registerToolPolicy({
      tool: () => {
        throw new Error("bug");
      }
    });
    expect(governance.toolDecision(read).allowed).toBe(false);
  });
});
