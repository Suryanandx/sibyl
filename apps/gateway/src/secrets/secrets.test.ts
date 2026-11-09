import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, createToolRegistry, type Store, type ToolContext, type ToolDefinition } from "@open-gpt-live/core";
import { parseClientMessage, parseServerMessage, SECRET_EVENTS, type ServerMessage } from "@open-gpt-live/protocol";
import { afterEach, test } from "vitest";
import { createNoopMeter } from "../runtime.js";
import { decryptValue, encryptValue, loadMasterKey } from "./crypto.js";
import { hostAllowed, normalizeHostList } from "./hosts.js";
import { installSecrets, redactSecrets, resolveSecretRefs, SECRETS_KV_KEY, type SecretsService } from "./index.js";
import { redactionNeedles } from "./redact.js";
import { SecretVault } from "./vault.js";

const VALUE = "hf_live_9f8e7d6c5b4a3210ZYXWvuts";
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

const services: SecretsService[] = [];
afterEach(() => {
  while (services.length) services.pop()!.close();
});

async function setup(options: { fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>; store?: Store; key?: Buffer } = {}) {
  const store = options.store ?? createMemoryStore();
  const tools = createToolRegistry();
  const logs: Array<[string, unknown]> = [];
  const service = (await installSecrets({
    store,
    tools,
    ownerId: "owner",
    env: {},
    key: options.key ?? randomBytes(32),
    log: (event, fields) => logs.push([event, fields]),
    resolveHost: PUBLIC,
    ...(options.fetch ? { fetch: options.fetch } : {})
  }))!;
  services.push(service);
  return { store, tools, logs, service, vault: service.vault };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    signal: new AbortController().signal,
    ownerId: "owner",
    runId: "run-1",
    store: createMemoryStore(),
    meter: createNoopMeter(),
    log: () => undefined,
    ...overrides
  };
}

function run(tool: ToolDefinition<any, any> | undefined, input: Record<string, unknown>, ctx = context()) {
  assert.ok(tool);
  return tool.run(input, ctx);
}

/* ── crypto ── */

test("encryption round-trips, uses a fresh IV, and fails with the wrong key, a different name or tampering", () => {
  const key = randomBytes(32);
  const a = encryptValue(key, "owner", "API_KEY", VALUE);
  const b = encryptValue(key, "owner", "API_KEY", VALUE);
  assert.notEqual(a, b);
  assert.ok(!a.includes(VALUE));
  assert.equal(decryptValue(key, "owner", "API_KEY", a), VALUE);
  assert.throws(() => decryptValue(randomBytes(32), "owner", "API_KEY", a));
  assert.throws(() => decryptValue(key, "owner", "OTHER_KEY", a));
  assert.throws(() => decryptValue(key, "someone", "API_KEY", a));
  const raw = Buffer.from(a.slice(3), "base64");
  raw[raw.length - 1]! ^= 1;
  assert.throws(() => decryptValue(key, "owner", "API_KEY", `v1:${raw.toString("base64")}`));
});

test("the master key is generated once into data/secret.key with mode 0600, or read from SIBYL_SECRET_KEY", () => {
  const dir = mkdtempSync(join(tmpdir(), "sibyl-secrets-"));
  try {
    const logs: string[] = [];
    const first = loadMasterKey({ SIBYL_DATA_DIR: dir }, (event) => logs.push(event));
    assert.equal(first.source, "generated");
    assert.deepEqual(logs, ["secrets.key_generated"]);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "secret.key")).mode & 0o777, 0o600);
    const second = loadMasterKey({ SIBYL_DATA_DIR: dir });
    assert.equal(second.source, "file");
    assert.ok(second.key.equals(first.key));
    assert.equal(readFileSync(join(dir, "secret.key"), "utf8").trim(), first.key.toString("base64"));

    const envKey = randomBytes(32);
    assert.ok(loadMasterKey({ SIBYL_SECRET_KEY: envKey.toString("base64"), SIBYL_DATA_DIR: dir }).key.equals(envKey));
    assert.throws(() => loadMasterKey({ SIBYL_SECRET_KEY: "short" }), /32 random bytes/);
    assert.equal(loadMasterKey({ SIBYL_STORAGE: "memory" }).source, "ephemeral");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── hosts ── */

test("host binding: exact hosts, *.domain wildcards (not the apex), local, invalid patterns", () => {
  const hosts = normalizeHostList(["API.Higgsfield.ai", "*.myshopify.com", "local"]);
  assert.ok("hosts" in hosts);
  assert.deepEqual(hosts.hosts, ["api.higgsfield.ai", "*.myshopify.com", "local"]);
  assert.ok(hostAllowed(hosts.hosts, "api.higgsfield.ai"));
  assert.ok(!hostAllowed(hosts.hosts, "evil.higgsfield.ai"));
  assert.ok(!hostAllowed(hosts.hosts, "api.higgsfield.ai.evil.com"));
  assert.ok(hostAllowed(hosts.hosts, "shop-1.myshopify.com"));
  assert.ok(hostAllowed(hosts.hosts, "a.b.myshopify.com"));
  assert.ok(!hostAllowed(hosts.hosts, "myshopify.com"));
  assert.ok(!hostAllowed(hosts.hosts, "evilmyshopify.com"));
  assert.ok(hostAllowed(hosts.hosts, undefined));
  assert.ok(!hostAllowed(["api.higgsfield.ai"], undefined));
  assert.ok(!hostAllowed(["local"], "local"));
  for (const bad of ["*", "*.com", "https://api.x.com", "api.x.com/path", "localhost", "", "a..b"]) {
    assert.ok("error" in normalizeHostList([bad]), bad);
  }
  assert.ok("error" in normalizeHostList([]));
});

/* ── vault ── */

test("the vault stores only ciphertext, lists metadata only and enforces host binding", async () => {
  const { vault, store, logs } = await setup();
  const meta = await vault.set("owner", { name: "HIGGSFIELD_API_KEY", value: VALUE, service: "Higgsfield", description: "Video", allowedHosts: ["api.higgsfield.ai"] });
  assert.equal(meta.readable, true);
  assert.ok(!JSON.stringify(await store.kv.get("owner", SECRETS_KV_KEY)).includes(VALUE));
  assert.ok(!JSON.stringify(await vault.list("owner")).includes(VALUE));
  assert.ok(!JSON.stringify(logs).includes(VALUE));
  assert.equal(await vault.has("owner", "HIGGSFIELD_API_KEY"), true);

  assert.equal(await vault.resolve("owner", "HIGGSFIELD_API_KEY", { host: "api.higgsfield.ai" }), VALUE);
  await assert.rejects(vault.resolve("owner", "HIGGSFIELD_API_KEY", { host: "evil.com" }), /may not be sent to evil\.com/);
  await assert.rejects(vault.resolve("owner", "HIGGSFIELD_API_KEY", { host: undefined }), /local/);
  await assert.rejects(vault.resolve("owner", "NOPE", { host: "api.higgsfield.ai" }), /no secret named NOPE/);
  assert.equal(
    await vault.resolveRefs("owner", "Bearer ${secret:HIGGSFIELD_API_KEY}", { host: "api.higgsfield.ai" }),
    `Bearer ${VALUE}`
  );
  // Errors never contain the value.
  const error = await vault.resolve("owner", "HIGGSFIELD_API_KEY", { host: "evil.com" }).catch((e: Error) => e.message);
  assert.ok(!String(error).includes(VALUE));

  // Metadata-only update keeps the value; a new secret needs a value and hosts.
  await vault.set("owner", { name: "HIGGSFIELD_API_KEY", allowedHosts: ["api.higgsfield.ai", "local"] });
  assert.equal(await vault.resolve("owner", "HIGGSFIELD_API_KEY", { host: undefined }), VALUE);
  await assert.rejects(vault.set("owner", { name: "NEW_KEY", allowedHosts: ["a.example.com"] }), /no secret named/);
  await assert.rejects(vault.set("owner", { name: "lower_case", value: "x", allowedHosts: ["a.example.com"] }), /UPPER_SNAKE/);
  assert.equal(await vault.delete("owner", "HIGGSFIELD_API_KEY"), true);
  assert.equal(await vault.has("owner", "HIGGSFIELD_API_KEY"), false);
  // A deleted value is still redacted for the life of the process.
  assert.equal(redactSecrets("owner", `x ${VALUE} y`), "x [secret:HIGGSFIELD_API_KEY] y");
});

test("a vault opened with the wrong key marks secrets unreadable and refuses to resolve them", async () => {
  const store = createMemoryStore();
  const first = new SecretVault({ store, key: randomBytes(32) });
  await first.set("owner", { name: "API_KEY", value: VALUE, allowedHosts: ["api.example.com"] });
  first.close();
  const second = new SecretVault({ store, key: randomBytes(32) });
  try {
    const [meta] = await second.list("owner");
    assert.equal(meta?.readable, false);
    await assert.rejects(second.resolve("owner", "API_KEY", { host: "api.example.com" }), /can't be decrypted/);
  } finally {
    second.close();
  }
});

test("redact catches raw, base64 (any alignment), base64url, URL-encoded and JSON-escaped values", async () => {
  const { vault } = await setup();
  const value = "s3cr3t/v+lue=with spaces&\"quotes\"";
  await vault.set("owner", { name: "WEIRD_KEY", value, allowedHosts: ["api.example.com"] });
  await vault.set("owner", { name: "API_KEY", value: VALUE, allowedHosts: ["api.example.com"] });
  const forms = [
    VALUE,
    Buffer.from(VALUE).toString("base64"),
    Buffer.from(VALUE).toString("base64url"),
    Buffer.from(`user:${VALUE}`).toString("base64"), // Basic auth: value at an offset
    Buffer.from(`ab:${VALUE}:tail`).toString("base64"),
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, "+"),
    JSON.stringify(value).slice(1, -1),
    value
  ];
  for (const form of forms) {
    const out = await vault.redact("owner", `before ${form} after`);
    assert.match(out, /\[secret:(API_KEY|WEIRD_KEY)\]/, form);
    assert.ok(!out.includes(VALUE) && !out.includes(value), form);
    // The sync hook the tool loop uses agrees.
    assert.equal(redactSecrets("owner", `before ${form} after`), out);
  }
  // Base64 cores never leave long runs of the encoded value behind.
  const basic = await vault.redact("owner", Buffer.from(`user:${VALUE}`).toString("base64"));
  assert.ok(basic.replace(/\[secret:API_KEY\]/g, "").length <= 12, basic);
  assert.deepEqual(redactionNeedles("abc"), []);
  assert.equal(redactSecrets("someone-else", VALUE), VALUE);
});

test("resolveSecretRefs fills MCP configs: stdio needs \"local\", HTTP servers need their host", async () => {
  const { vault } = await setup();
  await vault.set("owner", { name: "SHOPIFY_TOKEN", value: VALUE, allowedHosts: ["*.myshopify.com", "local"] });
  await vault.set("owner", { name: "REMOTE_ONLY", value: "remote-value-123", allowedHosts: ["mcp.example.com"] });
  const env = await resolveSecretRefs({ SHOPIFY_TOKEN: "${secret:SHOPIFY_TOKEN}", PLAIN: "x" }, { host: undefined, ownerId: "owner", vault });
  assert.deepEqual(env, { SHOPIFY_TOKEN: VALUE, PLAIN: "x" });
  assert.deepEqual(await resolveSecretRefs(["--token", "${secret:SHOPIFY_TOKEN}"], { host: "store.myshopify.com", ownerId: "owner", vault }), ["--token", VALUE]);
  await assert.rejects(resolveSecretRefs({ A: "${secret:REMOTE_ONLY}" }, { host: undefined, ownerId: "owner", vault }), /local/);
  await assert.rejects(resolveSecretRefs("${secret:SHOPIFY_TOKEN}", { host: "evil.com", ownerId: "owner", vault }), /may not be sent/);
});

/* ── tools ── */

test("list_secrets and request_secret (existing) never show values", async () => {
  const { vault, tools } = await setup();
  await vault.set("owner", { name: "API_KEY", value: VALUE, service: "Example", allowedHosts: ["api.example.com"] });
  const listed = await run(tools.get("list_secrets"), {});
  assert.match(listed.content, /API_KEY \(Example\) → api\.example\.com/);
  assert.ok(!JSON.stringify(listed).includes(VALUE));
  const again = await run(tools.get("request_secret"), { name: "API_KEY", service: "Example", description: "x", allowedHosts: ["api.example.com"] });
  assert.match(again.content, /already saved/);
  assert.equal(tools.get("request_secret")?.effect, "read");
  assert.equal(tools.get("api_request")?.effect, "write");
  // Nobody connected: the prompt can't be shown.
  const unavailable = await run(tools.get("request_secret"), { name: "OTHER_KEY", service: "Example", description: "x", allowedHosts: ["api.example.com"] });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content, /Secrets in the app/);
  const bad = await run(tools.get("request_secret"), { name: "x", service: "s", description: "d", allowedHosts: ["api.example.com"] });
  assert.equal(bad.isError, true);
});

test("api_request resolves secrets server-side for allowed hosts and redacts echoes", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const { vault, tools } = await setup({
    fetch: async (url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(url), headers, ...(init?.body ? { body: String(init.body) } : {}) });
      return new Response(JSON.stringify({ echo: headers.authorization, b64: Buffer.from(VALUE).toString("base64"), url: String(url) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  await vault.set("owner", { name: "API_KEY", value: VALUE, allowedHosts: ["api.example.com"] });
  const result = await run(tools.get("api_request"), {
    method: "POST",
    url: "https://api.example.com/v1/jobs?key=${secret:API_KEY}",
    headers: { Authorization: "Bearer ${secret:API_KEY}" },
    query: { mode: "fast" },
    body: { prompt: "a cat", token: "${secret:API_KEY}" }
  });
  assert.equal(result.isError, false, result.content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.authorization, `Bearer ${VALUE}`);
  assert.equal(new URL(calls[0]!.url).searchParams.get("key"), VALUE);
  assert.equal(new URL(calls[0]!.url).searchParams.get("mode"), "fast");
  assert.deepEqual(JSON.parse(calls[0]!.body!), { prompt: "a cat", token: VALUE });
  assert.equal(calls[0]!.headers["content-type"], "application/json");
  assert.ok(!result.content.includes(VALUE));
  assert.ok(!result.content.includes(Buffer.from(VALUE).toString("base64")));
  assert.match(result.content, /\[secret:API_KEY\]/);
  assert.match(result.content, /^HTTP 200/);
});

test("api_request refuses hosts a secret doesn't allow, plain http, private addresses and secrets in the host", async () => {
  let fetched = 0;
  const { vault, tools, service } = await setup({ fetch: async () => (fetched++, new Response("ok")) });
  await vault.set("owner", { name: "API_KEY", value: VALUE, allowedHosts: ["api.example.com", "*.example.org"] });
  const tool = tools.get("api_request");
  const evil = await run(tool, { url: "https://evil.com/", headers: { Authorization: "${secret:API_KEY}" } });
  assert.equal(evil.isError, true);
  assert.match(evil.content, /may not be sent to evil\.com/);
  const apex = await run(tool, { url: "https://example.org/", headers: { Authorization: "${secret:API_KEY}" } });
  assert.equal(apex.isError, true);
  const http = await run(tool, { url: "http://api.example.com/", headers: { Authorization: "${secret:API_KEY}" } });
  assert.match(http.content, /only sent over https/);
  const inHost = await run(tool, { url: "https://${secret:API_KEY}.example.org/" });
  assert.equal(inHost.isError, true);
  assert.equal(fetched, 0);
  const sub = await run(tool, { url: "https://eu.example.org/x", headers: { "X-Key": "${secret:API_KEY}" } });
  assert.equal(sub.isError, false, sub.content);
  assert.equal(fetched, 1);

  // SSRF guard: a host resolving to a private address is blocked.
  service.close();
  services.length = 0;
  const privateTools = createToolRegistry();
  const privateService = (await installSecrets({
    store: createMemoryStore(),
    tools: privateTools,
    ownerId: "owner",
    env: {},
    key: randomBytes(32),
    log: () => undefined,
    resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
    fetch: async () => (fetched++, new Response("internal"))
  }))!;
  services.push(privateService);
  const blocked = await run(privateTools.get("api_request"), { url: "https://intranet.example.com/" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content, /blocked/);
  const literal = await run(privateTools.get("api_request"), { url: "https://169.254.169.254/latest/meta-data" });
  assert.match(literal.content, /blocked/);
  assert.equal(fetched, 1);
});

test("api_request does not follow redirects that would carry a secret to another host", async () => {
  const seen: string[] = [];
  const { vault, tools } = await setup({
    fetch: async (url, init) => {
      const target = new URL(String(url));
      seen.push(`${target.hostname}${target.pathname} ${(init?.headers as Record<string, string>)["x-key"] ?? "-"}`);
      if (target.pathname === "/start") return new Response(null, { status: 302, headers: { location: "https://api.example.com/next" } });
      if (target.pathname === "/next") return new Response(null, { status: 302, headers: { location: "https://collector.evil.com/steal" } });
      return new Response("landed");
    }
  });
  await vault.set("owner", { name: "API_KEY", value: VALUE, allowedHosts: ["api.example.com"] });
  const result = await run(tools.get("api_request"), { url: "https://api.example.com/start", headers: { "X-Key": "${secret:API_KEY}" } });
  assert.equal(result.isError, true);
  assert.match(result.content, /not followed/);
  assert.deepEqual(seen, [`api.example.com/start ${VALUE}`, `api.example.com/next ${VALUE}`]);
  assert.ok(!result.content.includes(VALUE));

  // Without secrets the same redirect is followed.
  const open = await run(tools.get("api_request"), { url: "https://api.example.com/start" });
  assert.equal(open.isError, false, open.content);
  assert.match(open.content, /landed/);
});

/* ── protocol ── */

test("protocol: strict secrets parsers, and server messages can never carry a value", () => {
  assert.ok(parseClientMessage({ type: SECRET_EVENTS.PROVIDE, id: "p1", value: VALUE, allowedHosts: ["api.example.com"] }).success);
  const bad = parseClientMessage({ type: SECRET_EVENTS.PROVIDE, id: "p1", value: "" });
  assert.ok(!bad.success);
  const tooLong = parseClientMessage({ type: SECRET_EVENTS.PROVIDE, id: "p1", value: "x".repeat(9000) });
  assert.ok(!tooLong.success && !tooLong.error.includes("xxxx"));
  assert.ok(!parseClientMessage({ type: SECRET_EVENTS.UPDATE, name: "lower" }).success);
  assert.ok(!parseClientMessage({ type: SECRET_EVENTS.UPDATE, name: "OK_NAME", allowedHosts: [] }).success);
  assert.ok(parseClientMessage({ type: SECRET_EVENTS.DELETE, name: "OK_NAME" }).success);
  assert.ok(parseClientMessage({ type: SECRET_EVENTS.LIST }).success);
  const leaked = parseServerMessage({
    type: SECRET_EVENTS.STATE,
    secrets: [{ name: "A", service: "s", allowedHosts: [], value: VALUE }]
  });
  assert.ok(!leaked.success);
  assert.ok(
    !parseServerMessage({
      type: SECRET_EVENTS.REQUEST,
      request: { id: "1", runId: "r", name: "A_KEY", service: "s", description: "d", allowedHosts: ["a.b.com"], docsUrl: "javascript:alert(1)", replace: false, createdAt: 1, expiresAt: 2 }
    }).success
  );
  const sent: ServerMessage = { type: SECRET_EVENTS.RESOLVED, id: "1", name: "A_KEY", status: "saved" };
  assert.ok(parseServerMessage(sent).success);
});
