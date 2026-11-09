import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createReadWebpageTool, htmlToText, MAX_TEXT_CHARS } from "./read-webpage.js";
import { assertPublicUrl, isBlockedAddress, type ResolveHost } from "./ssrf.js";
import { fakeFetch, testContext } from "./test-helpers.js";

const dns: Record<string, string[]> = {
  "example.com": ["93.184.215.14"],
  "news.example.org": ["2606:4700::6810:84e5"],
  "evil.example.com": ["10.0.0.1"],
  "mixed.example.com": ["93.184.215.14", "192.168.1.1"],
  "rebind.example.com": ["::ffff:127.0.0.1"]
};
const resolveHost: ResolveHost = async (host) => {
  const addresses = dns[host];
  if (!addresses) throw new Error("ENOTFOUND");
  return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("SSRF guard", () => {
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
    assert.equal((await assertPublicUrl("https://example.com/a", resolveHost)).hostname, "example.com");
  });
});

describe("read_webpage", () => {
  test("blocked targets never reach fetch", async () => {
    const fetch = fakeFetch(() => html("secret"));
    const tool = createReadWebpageTool({ fetch, resolveHost });
    for (const url of ["http://127.0.0.1", "http://169.254.169.254/latest/meta-data/", "http://evil.example.com/admin"]) {
      const result = await tool.run({ url }, testContext());
      assert.equal(result.isError, true, url);
      assert.match(result.content, /private|reserved/);
    }
    assert.equal(fetch.calls.length, 0);
  });

  test("re-checks redirects and refuses a redirect to a private IP", async () => {
    const fetch = fakeFetch((url) =>
      url === "https://example.com/go"
        ? new Response(null, { status: 302, headers: { location: "http://10.0.0.5/internal" } })
        : html("internal secret")
    );
    const result = await createReadWebpageTool({ fetch, resolveHost }).run({ url: "https://example.com/go" }, testContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /10\.0\.0\.5/);
    assert.deepEqual(fetch.calls.map((c) => c.url), ["https://example.com/go"]);
    assert.equal(fetch.calls[0]!.init!.redirect, "manual");
  });

  test("follows up to 3 redirects, then stops", async () => {
    let hops = 0;
    const fetch = fakeFetch(() => new Response(null, { status: 301, headers: { location: `/r${++hops}` } }));
    const result = await createReadWebpageTool({ fetch, resolveHost }).run({ url: "https://example.com/" }, testContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /too many redirects/);
    assert.equal(fetch.calls.length, 4);

    const okFetch = fakeFetch((url) =>
      url.endsWith("/old") ? new Response(null, { status: 301, headers: { location: "https://news.example.org/new" } }) : html("<title>New</title><p>Moved here.</p>")
    );
    const ok = await createReadWebpageTool({ fetch: okFetch, resolveHost }).run({ url: "https://example.com/old" }, testContext());
    assert.ok(!ok.isError, ok.content);
    assert.equal(ok.data!.finalUrl, "https://news.example.org/new");
  });

  test("extracts readable text, title and caps length", async () => {
    const page = `<!doctype html><html><head><title>Hello &amp; welcome</title><style>.x{color:red}</style>
      <script>alert("no")</script></head><body><nav><a href="/">Home</a> Menu</nav>
      <h1>Big   news</h1><p>First&nbsp;paragraph with <b>bold</b> text &#8212; and more.</p>
      <ul><li>One</li><li>Two</li></ul><footer>Copyright</footer></body></html>`;
    const fetch = fakeFetch(() => html(page));
    const result = await createReadWebpageTool({ fetch, resolveHost }).run({ url: "https://example.com/" }, testContext());
    assert.ok(!result.isError, result.content);
    assert.equal(result.data!.title, "Hello & welcome");
    const text = result.data!.text;
    assert.match(text, /# Big news/);
    assert.match(text, /First paragraph with bold text — and more\./);
    assert.match(text, /- One\n- Two/);
    for (const junk of ["alert", "color:red", "Menu", "Copyright"]) assert.doesNotMatch(text, new RegExp(junk));

    const long = fakeFetch(() => html(`<p>${"word ".repeat(10_000)}</p>`));
    const capped = await createReadWebpageTool({ fetch: long, resolveHost }).run({ url: "https://example.com/" }, testContext());
    assert.ok(capped.data!.text.length <= MAX_TEXT_CHARS);
    assert.equal(capped.data!.truncated, true);
  });

  test("rejects non-text content types and HTTP errors", async () => {
    const pdf = fakeFetch(() => new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
    const result = await createReadWebpageTool({ fetch: pdf, resolveHost }).run({ url: "https://example.com/a.pdf" }, testContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /unsupported content type application\/pdf/);
    const missing = fakeFetch(() => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }));
    const notFound = await createReadWebpageTool({ fetch: missing, resolveHost }).run({ url: "https://example.com/x" }, testContext());
    assert.match(notFound.content, /HTTP 404/);
  });

  test("caps the body at 2 MB", async () => {
    const chunk = new TextEncoder().encode(`<p>${"a".repeat(1024 * 1024)}</p>`);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 10) controller.close();
        else controller.enqueue(chunk);
      }
    });
    const fetch = fakeFetch(() => new Response(stream, { headers: { "content-type": "text/html" } }));
    const result = await createReadWebpageTool({ fetch, resolveHost }).run({ url: "https://example.com/" }, testContext());
    assert.equal(result.data!.truncated, true);
    assert.ok(pulls <= 4, `read ${pulls} chunks`);
  });

  test("htmlToText prefers <article>", () => {
    const { text } = htmlToText(`<div>sidebar junk</div><article><p>${"Real content. ".repeat(30)}</p></article>`);
    assert.doesNotMatch(text, /sidebar/);
    assert.match(text, /Real content/);
  });
});
