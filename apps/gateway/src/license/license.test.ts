import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  createGovernance,
  FEATURE_IDS,
  createMemoryStore,
  createToolRegistry,
  exportLicensePublicKey,
  signLicense,
  type LicensePayload
} from "@open-gpt-live/core";
import { createGatewayServer } from "../gateway.js";
import { createNoopMeter, createTestRuntime } from "../runtime.js";
import { findEnterpriseGateway, loadEnterpriseEntry } from "./ee-loader.js";
import { LICENSE_KV_KEY, installLicense, type LicenseRuntime } from "./index.js";

const run = promisify(execFile);
const repoRoot = resolve(__dirname, "../../../..");
const keys = generateKeyPairSync("ed25519");
const publicKeys = [exportLicensePublicKey(keys.publicKey)];
const tmp = mkdtempSync(join(tmpdir(), "sibyl-license-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function token(overrides: Partial<LicensePayload> = {}): string {
  return signLicense(
    {
      licensee: "Acme Ltd",
      edition: "enterprise",
      seats: 10,
      features: ["audit_log"],
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides
    },
    keys.privateKey
  );
}

async function install(env: NodeJS.ProcessEnv, extra: Partial<Parameters<typeof installLicense>[0]> = {}) {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const store = createMemoryStore();
  const license = await installLicense({
    env,
    store,
    tools: createToolRegistry(),
    meter: createNoopMeter(),
    ownerId: "owner",
    log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }),
    governance: createGovernance({ orgId: "owner" }),
    publicKeys,
    ...extra
  });
  return { license, logs, store };
}

describe("installLicense", () => {
  test("no key: open source edition, ee/ never loaded", async () => {
    let loaded = false;
    const { license, logs } = await install({}, { loadEntry: async () => ((loaded = true), undefined) });
    expect(license.service.state()).toMatchObject({ edition: "oss", status: "none", source: "none", features: [] });
    expect(loaded).toBe(false);
    expect(logs.find((l) => l.event === "license.loaded")?.fields).toMatchObject({ edition: "oss" });
  });

  test("licensed + ee/ present: the real ee/gateway audit log module loads", async () => {
    const { license, logs } = await install({ SIBYL_LICENSE_KEY: token() });
    expect(license.modules).toEqual(["audit-log"]);
    expect(logs.some((l) => l.event === "enterprise.audit_log_installed")).toBe(true);
    // The key never reaches the logs.
    expect(JSON.stringify(logs)).not.toContain(token().split(".")[2]!.slice(0, 20));
    const loaded = logs.find((l) => l.event === "license.loaded");
    expect(loaded?.fields).toMatchObject({ edition: "enterprise", features: ["audit_log"], licensee: "Acme Ltd" });
  });

  test("licensed but ee/ absent (simulated): still works as open source would", async () => {
    const { license, logs } = await install({ SIBYL_LICENSE_KEY: token() }, { loadEntry: async () => undefined });
    expect(license.modules).toEqual([]);
    expect(license.service.state().edition).toBe("enterprise");
    expect(logs.some((l) => l.event === "enterprise.absent")).toBe(true);
  });

  test("licence without the module's feature skips it", async () => {
    const { license } = await install({ SIBYL_LICENSE_KEY: token({ features: ["sso"] }) });
    // Only the sso module is licensed; the audit_log example stays off.
    expect(license.modules).not.toContain("example-audit");
    expect(license.modules).toContain("sso");
  });

  test("SIBYL_EDITION=oss never loads ee/", async () => {
    expect(await loadEnterpriseEntry({ env: { SIBYL_EDITION: "oss" }, searchFrom: repoRoot })).toBeUndefined();
    const { license } = await install({ SIBYL_LICENSE_KEY: token(), SIBYL_EDITION: "oss" }, {});
    expect(license.modules).toEqual([]);
  });

  test("source lookup finds ee/ in this checkout and nothing elsewhere", () => {
    expect(findEnterpriseGateway(join(repoRoot, "apps/gateway"))).toBe(join(repoRoot, "ee/gateway/index.ts"));
    expect(findEnterpriseGateway(tmp)).toBeUndefined();
  });

  test("stored key: set, validated, persisted, cleared; env key is read-only", async () => {
    const { license, store } = await install({});
    await expect(license.service.setKey("nonsense")).rejects.toMatchObject({ status: 400 });
    await expect(license.service.setKey(token({ expiresAt: new Date(Date.now() - 1000).toISOString(), issuedAt: "2020-01-01T00:00:00Z" }))).rejects.toMatchObject({ code: "expired" });
    const key = token();
    const state = await license.service.setKey(key);
    expect(state).toMatchObject({ edition: "enterprise", source: "stored", restartRequired: true });
    expect(await store.kv.get("owner", LICENSE_KV_KEY)).toBe(key);
    expect((await license.service.clearKey()).edition).toBe("oss");

    const managed = await install({ SIBYL_LICENSE_KEY: token() });
    await expect(managed.license.service.setKey(token())).rejects.toMatchObject({ status: 409 });
  });

  test("an expired env key degrades to open source without failing startup", async () => {
    const { license } = await install({ SIBYL_LICENSE_KEY: token({ issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2021-01-01T00:00:00Z" }) });
    expect(license.service.state()).toMatchObject({ edition: "oss", status: "expired", licensee: "Acme Ltd", features: [] });
    expect(license.modules).toEqual([]);
  });
});

describe("gateway wiring", () => {
  async function withGateway(license: LicenseRuntime, ownerToken: string | undefined, fn: (port: number) => Promise<void>) {
    const server = await createGatewayServer({
      port: 0,
      host: "127.0.0.1",
      providers: { llm: {} as never, stt: {} as never },
      runtime: createTestRuntime({ license }),
      ...(ownerToken ? { ownerToken } : {})
    });
    try {
      await fn(server.port);
    } finally {
      await server.close();
    }
  }

  test("GET/POST/DELETE /api/license and license.state on connect", async () => {
    const { license } = await install({});
    await withGateway(license, "owner-secret", async (port) => {
      const base = `http://127.0.0.1:${port}/api/license`;
      expect((await fetch(base)).status).toBe(401);
      const auth = { authorization: "Bearer owner-secret" };
      const initial = (await (await fetch(base, { headers: auth })).json()) as Record<string, unknown>;
      expect(initial).toMatchObject({ edition: "oss", status: "none" });
      expect(initial.catalog).toHaveLength(FEATURE_IDS.length);

      const socket = new WebSocket(`ws://127.0.0.1:${port}?token=owner-secret`);
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      await once(socket, "open");
      await waitFor(() => messages.some((m) => m.type === "license.state"));
      expect(messages.find((m) => m.type === "license.state")).toMatchObject({ edition: "oss", features: [] });

      const bad = await fetch(base, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key: "sibyl1.x.y" }) });
      expect(bad.status).toBe(400);
      const good = await fetch(base, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key: token() }) });
      expect(good.status).toBe(200);
      const body = await good.text();
      expect(body).not.toContain("sibyl1.");
      expect(JSON.parse(body)).toMatchObject({ edition: "enterprise", features: ["audit_log"], licensee: "Acme Ltd" });
      await waitFor(() => messages.some((m) => m.type === "license.state" && m.edition === "enterprise"));

      const removed = await fetch(base, { method: "DELETE", headers: auth });
      expect(((await removed.json()) as { edition: string }).edition).toBe("oss");
      socket.close();
    });
  });

  test("/api/auth/me reports the licensed features (the web app's hasFeature)", async () => {
    const { license } = await install({});
    await withGateway(license, "owner-secret", async (port) => {
      const me = async () =>
        (await (await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { authorization: "Bearer owner-secret" } })).json()) as {
          features?: string[];
        };
      expect((await me()).features).toEqual([]);
      const set = await fetch(`http://127.0.0.1:${port}/api/license`, {
        method: "POST",
        headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
        body: JSON.stringify({ key: token() })
      });
      expect(set.status).toBe(200);
      expect((await me()).features?.length).toBeGreaterThan(0);
    });
  });

  test("enterprise HTTP routes are served before the 404", async () => {
    const { license } = await install({});
    license.httpRoutes.push((request, response) => {
      if (request.url !== "/api/ee-test") return false;
      response.writeHead(200).end("ee");
      return true;
    });
    await withGateway(license, undefined, async (port) => {
      expect(await (await fetch(`http://127.0.0.1:${port}/api/ee-test`)).text()).toBe("ee");
      expect((await fetch(`http://127.0.0.1:${port}/api/nope`)).status).toBe(404);
    });
  });
});

describe("open-core boundary", () => {
  test("scripts/check-ee-boundary.mjs passes on this repository", async () => {
    const { stdout } = await run(process.execPath, [join(repoRoot, "scripts/check-ee-boundary.mjs")]);
    expect(stdout).toContain("ee boundary ok");
  });

  test("it fails on an open-source file importing from ee/", async () => {
    const { checkBoundary } = (await import(join(repoRoot, "scripts/check-ee-boundary.mjs"))) as {
      checkBoundary(root: string): Array<{ file: string; specifier: string }>;
    };
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const root = join(tmp, "repo");
    mkdirSync(join(root, "apps/web"), { recursive: true });
    mkdirSync(join(root, "ee/gateway"), { recursive: true });
    writeFileSync(join(root, "ee/gateway/index.ts"), "export default 1;\n");
    writeFileSync(join(root, "apps/web/ok.ts"), "// mentions ee/ in a comment\nimport x from \"./x\";\n");
    writeFileSync(join(root, "apps/web/bad.ts"), "import ee from \"../../ee/gateway/index\";\n");
    writeFileSync(join(root, "apps/web/bad2.ts"), "const m = await import(\"sibyl-ee-entry\");\n");
    const violations = checkBoundary(root);
    expect(violations.map((v) => v.file).sort()).toEqual(["apps/web/bad.ts", "apps/web/bad2.ts"]);
  });

  test("the gateway bundles without ee/ (simulated deletion)", async () => {
    const outfile = join(tmp, "oss", "server.cjs");
    const { stdout } = await run(process.execPath, [join(repoRoot, "apps/gateway/build.mjs"), "--ee-dir", join(tmp, "no-ee-here"), "--outfile", outfile], { env: { ...process.env, SIBYL_EDITION: "" } });
    expect(stdout).toContain("open source only");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(outfile, "utf8")).not.toContain("sibyl-audit-v1");
  }, 60_000);
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
