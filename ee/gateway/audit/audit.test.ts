/**
 * Audit log tests — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createGovernance, createMemoryStore, type EnterpriseSecrets } from "../../../packages/core/src/index";
import { createSqliteStore } from "../../../packages/store/src/index";
import { auditQueryFrom } from "./index";
import { AuditLog, CSV_COLUMNS, canonicalJson, csvCell, csvRow, entryHash } from "./log";
import { AuditStreamer, STREAM_SECRET_NAME, signBody } from "./stream";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sqlite() {
  const dir = mkdtempSync(join(tmpdir(), "sibyl-audit-"));
  dirs.push(dir);
  const file = join(dir, "sibyl.db");
  return { store: createSqliteStore({ file }), file };
}

describe("audit log", () => {
  it("chains every entry to the previous one and verifies the whole chain", async () => {
    const { store, file } = sqlite();
    const governance = createGovernance({ orgId: "owner", now: () => 1_700_000_000_000 });
    const log = new AuditLog({ store, orgId: "owner", log: () => {} });
    governance.registerAuditSink(log.sink);
    governance.audit({ action: "auth.sign_in", actor: { kind: "user", userId: "u1", email: "a@x.io" }, ip: "127.0.0.1" });
    governance.audit({ action: "tool.write", workspaceId: "default", target: { kind: "tool", id: "send_email" }, details: { runId: "r1", tags: ["a", "b"] } });
    governance.audit({ action: "policy.changed", outcome: "success" });
    await log.flush();
    const rows = await store.audit.scan("owner", 0, 10);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]!.prevHash).toBe("");
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(rows.every((r) => entryHash(r) === r.hash)).toBe(true);
    expect(await log.verify()).toMatchObject({ ok: true, checked: 3, lastSeq: 3, lastHash: rows[2]!.hash });

    // Tamper with one stored row (as someone with database access could): verify says where.
    await store.close();
    const raw = new DatabaseSync(file);
    const data = JSON.parse(String((raw.prepare("SELECT data FROM audit_log WHERE seq = 2").get() as { data: string }).data));
    data.target.id = "something_else";
    raw.prepare("UPDATE audit_log SET data = ? WHERE seq = 2").run(JSON.stringify(data));
    raw.close();
    const reopened = createSqliteStore({ file });
    const check = await new AuditLog({ store: reopened, orgId: "owner", log: () => {} }).verify();
    expect(check).toMatchObject({ ok: false, checked: 2, lastSeq: 1, problem: { seq: 2, reason: "hash_mismatch" } });

    // A deleted row is a gap.
    const raw2 = new DatabaseSync(file);
    raw2.prepare("UPDATE audit_log SET data = ? WHERE seq = 2").run(JSON.stringify({ ...data, target: { kind: "tool", id: "send_email" } }));
    raw2.prepare("DELETE FROM audit_log WHERE seq = 2").run();
    raw2.close();
    expect(await new AuditLog({ store: reopened, orgId: "owner", log: () => {} }).verify()).toMatchObject({ ok: false, problem: { seq: 3, reason: "gap" } });
    await reopened.close();
  });

  it("continues the chain after a restart and pages exports newest first", async () => {
    const store = createMemoryStore();
    const governance = createGovernance({ orgId: "owner" });
    const first = new AuditLog({ store, orgId: "owner", log: () => {} });
    const off = governance.registerAuditSink(first.sink);
    for (let i = 0; i < 3; i += 1) governance.audit({ action: "auth.sign_in" });
    await first.flush();
    off();
    const second = new AuditLog({ store, orgId: "owner", log: () => {} });
    governance.registerAuditSink(second.sink);
    governance.audit({ action: "auth.sign_out" });
    await second.flush();
    expect(await second.verify()).toMatchObject({ ok: true, checked: 4 });
    const pages: number[][] = [];
    for await (const page of second.exportPages({ action: "auth." })) pages.push(page.map((r) => r.seq));
    expect(pages).toEqual([[4, 3, 2, 1]]);
  });

  it("writes CSV that spreadsheets can't execute, and canonical JSON is key-order independent", async () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    const row = csvRow({ orgId: "o", seq: 1, id: "e", at: 0, action: "auth.sign_in", actor: { kind: "user", email: "-x@y.z" }, outcome: "success", details: { n: 1 }, prevHash: "", hash: "h" });
    expect(row.split(",")).toHaveLength(CSV_COLUMNS.length);
    expect(row).toContain("'-x@y.z");
  });

  it("parses list and export filters", () => {
    expect(auditQueryFrom(new URLSearchParams("action=auth.&actor=u1&outcome=denied&from=2026-01-01&q=x&before=9"))).toEqual({
      action: "auth.",
      actorUserId: "u1",
      outcome: "denied",
      from: Date.parse("2026-01-01"),
      text: "x",
      beforeSeq: 9
    });
    expect(() => auditQueryFrom(new URLSearchParams("outcome=maybe"))).toThrow();
  });
});

describe("audit streaming", () => {
  function fakeVault(): EnterpriseSecrets & { values: Map<string, { value?: string; hosts?: string[] }> } {
    const values = new Map<string, { value?: string; hosts?: string[] }>();
    return {
      values,
      async set(input) {
        const current = values.get(input.name) ?? {};
        values.set(input.name, { value: input.value ?? current.value, hosts: input.allowedHosts ?? current.hosts });
      },
      async resolve(name, host) {
        const entry = values.get(name);
        if (!entry?.value || !entry.hosts?.includes(host ?? "")) throw new Error("not allowed");
        return entry.value;
      },
      async has(name) {
        return values.has(name);
      },
      async delete(name) {
        values.delete(name);
      }
    };
  }

  it("signs batches with HMAC, resumes from its cursor, and backs off on failure", async () => {
    const store = createMemoryStore();
    const governance = createGovernance({ orgId: "owner" });
    const log = new AuditLog({ store, orgId: "owner", log: () => {} });
    governance.registerAuditSink(log.sink);
    governance.audit({ action: "auth.sign_in" }); // before streaming: not replayed
    await log.flush();
    const vault = fakeVault();
    const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let status = 200;
    const streamer = await new AuditStreamer({
      store,
      orgId: "owner",
      secrets: vault,
      head: async () => (await store.audit.last("owner"))?.seq ?? 0,
      log: () => {},
      now: () => 1000,
      debounceMs: 60_000,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url, init) => {
        requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
        return new Response("ok", { status });
      }
    }).load();
    await expect(streamer.configure({ url: "http://siem.example.com/hook" })).rejects.toThrow(/https/);
    const view = await streamer.configure({ url: "https://siem.example.com/hook" });
    expect(view).toMatchObject({ configured: true, enabled: true, cursor: 1 });
    expect(view.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(vault.values.get(STREAM_SECRET_NAME)?.hosts).toEqual(["siem.example.com"]);

    governance.audit({ action: "tool.write" });
    governance.audit({ action: "policy.changed" });
    await log.flush();
    await streamer.drain();
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(JSON.parse(sent.body).entries.map((e: { seq: number }) => e.seq)).toEqual([2, 3]);
    expect(sent.headers["x-sibyl-timestamp"]).toBe("1000");
    expect(sent.headers["x-sibyl-signature"]).toBe(`sha256=${createHmac("sha256", view.secret!).update(`1000.${sent.body}`).digest("hex")}`);
    expect(signBody(view.secret!, "1000", sent.body)).toBe(sent.headers["x-sibyl-signature"]);
    expect(streamer.view().cursor).toBe(3);

    status = 500;
    governance.audit({ action: "auth.sign_out" });
    await log.flush();
    await streamer.drain();
    expect(streamer.view()).toMatchObject({ cursor: 3, lastError: "the webhook answered HTTP 500" });
    status = 200;
    await streamer.drain();
    expect(streamer.view().cursor).toBe(4);
    expect(streamer.view().lastError).toBeUndefined();
    expect(await streamer.test()).toEqual({ ok: true, status: 200 });
    streamer.close();
  });

  it("refuses private webhook addresses (fetchPublic's SSRF guard)", async () => {
    const store = createMemoryStore();
    const streamer = await new AuditStreamer({ store, orgId: "owner", secrets: fakeVault(), head: async () => 0, log: () => {}, resolveHost: async () => [{ address: "10.0.0.5", family: 4 }] }).load();
    await streamer.configure({ url: "https://internal.example.com/hook", enabled: false });
    const result = await streamer.test();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private/);
  });
});
