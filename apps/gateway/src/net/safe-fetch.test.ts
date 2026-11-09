import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  assertPublicUrl,
  BlockedUrlError,
  decodeBody,
  FetchPublicError,
  fetchPublic,
  isBlockedAddress,
  isTextualType,
  mimeOf,
  type FetchLike,
  type ResolveHost
} from "./safe-fetch.js";

const dns: Record<string, string[]> = {
  "example.com": ["93.184.215.14"],
  "news.example.org": ["2606:4700::6810:84e5"],
  "evil.example.com": ["10.0.0.1"],
  "mixed.example.com": ["93.184.215.14", "192.168.1.1"],
  "rebind.example.com": ["::ffff:127.0.0.1"],
  "metadata.example.com": ["169.254.169.254"]
};
const resolveHost: ResolveHost = async (host) => {
  const addresses = dns[host];
  if (!addresses) throw new Error("ENOTFOUND");
  return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

function fake(route: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return route(String(input), init);
  };
  return { fetch, calls };
}

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

describe("address checks", () => {
  test("blocks private, loopback, link-local and metadata addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.10", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "224.0.0.1"]) {
      assert.equal(isBlockedAddress(address), true, address);
    }
    for (const address of ["93.184.215.14", "8.8.8.8", "2606:4700::6810:84e5"]) {
      assert.equal(isBlockedAddress(address), false, address);
    }
  });

  test("checks scheme, literal IPs, hostnames and every resolved address", async () => {
    await assert.rejects(assertPublicUrl("http://127.0.0.1/", resolveHost), /private or reserved/);
    await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data/", resolveHost), /private or reserved/);
    await assert.rejects(assertPublicUrl("http://[::1]:8080/", resolveHost), /private or reserved/);
    await assert.rejects(assertPublicUrl("http://localhost:8787/", resolveHost), /not a public hostname/);
    await assert.rejects(assertPublicUrl("http://metadata.google.internal/", resolveHost), /not a public hostname/);
    await assert.rejects(assertPublicUrl("file:///etc/passwd", resolveHost), /only http and https/);
    await assert.rejects(assertPublicUrl("ftp://example.com/", resolveHost), /only http and https/);
    await assert.rejects(assertPublicUrl("http://user:pw@example.com/", resolveHost), /credentials/);
    await assert.rejects(assertPublicUrl("http://evil.example.com/", resolveHost), /10\.0\.0\.1/);
    await assert.rejects(assertPublicUrl("http://mixed.example.com/", resolveHost), /192\.168\.1\.1/);
    await assert.rejects(assertPublicUrl("http://rebind.example.com/", resolveHost), /private/);
    await assert.rejects(assertPublicUrl("http://2130706433/", resolveHost), /private or reserved|not a public/);
    await assert.rejects(assertPublicUrl("http://unknown.example.net/", resolveHost), /could not resolve/);
    assert.equal((await assertPublicUrl("https://example.com/a", resolveHost)).hostname, "example.com");
  });
});

describe("fetchPublic", () => {
  test("blocked targets never reach the network", async () => {
    const { fetch, calls } = fake(() => new Response("secret"));
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://evil.example.com/", "http://metadata.example.com/", "http://rebind.example.com/"]) {
      await assert.rejects(fetchPublic(url, { fetch, resolveHost }), BlockedUrlError, url);
    }
    assert.equal(calls.length, 0);
  });

  test("re-checks every redirect and refuses one to a private address", async () => {
    const { fetch, calls } = fake((url) => (url === "https://example.com/go" ? redirect("http://10.0.0.5/internal") : new Response("internal")));
    await assert.rejects(fetchPublic("https://example.com/go", { fetch, resolveHost }), /10\.0\.0\.5/);
    assert.deepEqual(calls.map((c) => c.url), ["https://example.com/go"]);
    assert.equal(calls[0]!.init!.redirect, "manual");
  });

  test("follows up to maxRedirects, then stops", async () => {
    let hops = 0;
    const { fetch, calls } = fake(() => redirect(`/r${++hops}`, 301));
    await assert.rejects(fetchPublic("https://example.com/", { fetch, resolveHost }), (error) => error instanceof FetchPublicError && error.code === "too_many_redirects");
    assert.equal(calls.length, 4);
    const moved = fake((url) => (url.endsWith("/old") ? redirect("https://news.example.org/new") : new Response("here")));
    const response = await fetchPublic("https://example.com/old", { fetch: moved.fetch, resolveHost });
    assert.equal(response.url.toString(), "https://news.example.org/new");
    assert.equal((await response.text()).text, "here");
  });

  test("a non-GET request does not follow redirects and reports where it would go", async () => {
    const { fetch, calls } = fake(() => redirect("https://news.example.org/elsewhere", 307));
    const response = await fetchPublic("https://example.com/post", { method: "POST", body: "x", fetch, resolveHost });
    assert.equal(response.status, 307);
    assert.equal(response.location?.toString(), "https://news.example.org/elsewhere");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init!.method, "POST");
  });

  test("a refusal at connect time (DNS rebinding) is reported as blocked", async () => {
    const fetch: FetchLike = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EBLOCKED" } });
    };
    await assert.rejects(fetchPublic("https://example.com/", { fetch, resolveHost }), (error) => error instanceof BlockedUrlError && /private address/.test(error.message));
  });

  test("allowHosts binds every hop, httpsOnly refuses plain http", async () => {
    const { fetch, calls } = fake((url) => (url.includes("example.com") ? redirect("https://news.example.org/x") : new Response("landed")));
    const onlyExample = (url: URL) => url.hostname === "example.com";
    await assert.rejects(fetchPublic("https://example.com/", { fetch, resolveHost, allowHosts: onlyExample }), (error) => {
      return error instanceof FetchPublicError && error.code === "host_not_allowed" && error.url?.hostname === "news.example.org";
    });
    assert.equal(calls.length, 1);
    await assert.rejects(fetchPublic("http://example.com/", { fetch, resolveHost, httpsOnly: true }), (error) => error instanceof FetchPublicError && error.code === "https_required");
  });

  test("caps the body, reports a declared oversize and decodes text", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 100) controller.close();
        else controller.enqueue(chunk);
      }
    });
    const big = fake(() => new Response(stream));
    const response = await fetchPublic("https://example.com/", { fetch: big.fetch, resolveHost, maxBytes: 4096 });
    const { bytes, truncated } = await response.bytes();
    assert.equal(bytes.byteLength, 4096);
    assert.equal(truncated, true);
    assert.ok(pulls <= 6, `read ${pulls} chunks`);

    const declared = fake(() => new Response("small", { headers: { "content-length": "999999" } }));
    assert.equal((await fetchPublic("https://example.com/", { fetch: declared.fetch, resolveHost, maxBytes: 10 })).tooLarge, true);

    const latin = fake(() => new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), { headers: { "content-type": "text/plain; charset=iso-8859-1" } }));
    const page = await fetchPublic("https://example.com/", { fetch: latin.fetch, resolveHost });
    assert.equal(page.mime, "text/plain");
    assert.equal((await page.text()).text, "café");
  });

  test("time cap aborts a slow server", async () => {
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await assert.rejects(fetchPublic("https://example.com/", { fetch, resolveHost, timeoutMs: 20 }), /timeout|aborted/i);
  });
});

describe("content types", () => {
  test("mimeOf, isTextualType and decodeBody", () => {
    assert.equal(mimeOf("Text/HTML; charset=utf-8"), "text/html");
    assert.equal(mimeOf(null), "");
    assert.equal(isTextualType("application/vnd.api+json"), true);
    assert.equal(isTextualType("image/png"), false);
    const html = new TextEncoder().encode('<meta charset="utf-8"><p>ok</p>');
    assert.match(decodeBody(html, "text/html"), /ok/);
  });
});

describe("fetchPublic privateNetwork", () => {
  test("refuses a local receiver by default and reaches it only when the caller opts in", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`got ${request.method}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await assert.rejects(fetchPublic(`http://127.0.0.1:${port}/hook`, { method: "POST", body: "{}" }), BlockedUrlError);
      const response = await fetchPublic(`http://127.0.0.1:${port}/hook`, { method: "POST", body: "{}", privateNetwork: true });
      assert.equal(response.status, 200);
      assert.equal((await response.text()).text, "got POST");
      await assert.rejects(fetchPublic(`ftp://127.0.0.1:${port}/`, { privateNetwork: true }), BlockedUrlError);
      await assert.rejects(fetchPublic(`http://user:pw@127.0.0.1:${port}/`, { privateNetwork: true }), BlockedUrlError);
    } finally {
      server.close();
    }
  });
});
