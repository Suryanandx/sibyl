import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { calculateTool, evaluateExpression, formatNumber } from "./calculate.js";
import { createCurrencyTool } from "./currency.js";
import { createBuiltinTools } from "./index.js";
import { createWeatherTool } from "./weather.js";
import { createWebSearchTool } from "./web-search.js";
import { createWikipediaTool } from "./wikipedia.js";
import { createWorldTimeTool, resolveTimeZone } from "./world-time.js";
import { fakeFetch, json, testContext } from "./test-helpers.js";

describe("calculate", () => {
  const cases: Array<[string, number]> = [
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["2 ^ 3 ^ 2", 512],
    ["2 ** 10", 1024],
    ["-2 ^ 2", -4],
    ["2 * -3", -6],
    ["10 ÷ 4", 2.5],
    ["6 × 7", 42],
    ["10 − 3", 7],
    ["200 * 15%", 30],
    ["50%", 0.5],
    ["10 % 3", 1],
    ["10 mod 4", 2],
    ["5!", 120],
    ["sqrt(16) + abs(-3)", 7],
    ["round(3.14159, 2)", 3.14],
    ["log(1000)", 3],
    ["log(8, 2)", 3],
    ["ln(e)", 1],
    ["max(1, 5, 3)", 5],
    ["2pi", 2 * Math.PI],
    ["2(3 + 4)", 14],
    ["sin(rad(90))", 1],
    ["1e3 + 1_000", 2000],
    [".5 + .25", 0.75]
  ];
  for (const [expression, expected] of cases) {
    test(expression, () => {
      assert.ok(Math.abs(evaluateExpression(expression) - expected) < 1e-9, `${expression} → ${evaluateExpression(expression)}`);
    });
  }

  test("formats away float noise", () => {
    assert.equal(formatNumber(evaluateExpression("0.1 + 0.2")), "0.3");
  });

  test("rejects unsafe or bad input without throwing from the tool", async () => {
    for (const bad of ["process.exit()", "constructor", "1 +", "(1 + 2", "1 / 0", "foo(2)", "2 $ 3", "sqrt", "this"]) {
      const result = await calculateTool.run({ expression: bad }, testContext());
      assert.equal(result.isError, true, bad);
    }
    assert.throws(() => evaluateExpression("(".repeat(500) + "1" + ")".repeat(500)));
  });

  test("tool output", async () => {
    const result = await calculateTool.run({ expression: "1250 * 1.07^2" }, testContext());
    assert.equal(result.content, "1250 * 1.07^2 = 1431.125");
    assert.equal(calculateTool.effect, "read");
  });
});

describe("world_time", () => {
  const now = () => new Date("2026-07-01T12:00:00Z");
  const tool = createWorldTimeTool(now);

  test("resolves cities, abbreviations and IANA names", () => {
    assert.equal(resolveTimeZone("Tokyo"), "Asia/Tokyo");
    assert.equal(resolveTimeZone("new york, USA"), "America/New_York");
    assert.equal(resolveTimeZone("Europe/Lisbon"), "Europe/Lisbon");
    assert.equal(resolveTimeZone("Reykjavik"), "Atlantic/Reykjavik");
    assert.equal(resolveTimeZone("Atlantis"), undefined);
  });

  test("current time and differences", async () => {
    const result = await tool.run({ locations: ["London", "Tokyo", "Los Angeles"] }, testContext());
    assert.ok(!result.isError, result.content);
    const entries = result.data!.entries;
    assert.equal(entries[0]!.utcOffset, "UTC+01:00"); // BST
    assert.equal(entries[1]!.diffMinutes, 8 * 60);
    assert.equal(entries[2]!.diffMinutes, -8 * 60);
    assert.match(result.content, /8h ahead of London/);
  });

  test("converts a wall-clock time", async () => {
    const result = await tool.run({ locations: ["New York", "Asia/Kolkata"], time: "09:00", date: "2026-01-15" }, testContext());
    assert.equal(result.data!.instant, "2026-01-15T14:00:00.000Z");
    assert.match(result.data!.entries[1]!.iso, /^2026-01-15T19:30:00\+05:30$/);
  });

  test("unknown place is a friendly error", async () => {
    const result = await tool.run({ locations: ["Atlantis"] }, testContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /Atlantis/);
  });
});

describe("weather", () => {
  test("geocodes then forecasts (metric)", async () => {
    const fetch = fakeFetch((url) => {
      if (url.startsWith("https://geocoding-api.open-meteo.com")) {
        return json({ results: [
          { name: "Paris", latitude: 33.66, longitude: -95.55, country: "United States", country_code: "US", admin1: "Texas" },
          { name: "Paris", latitude: 48.85, longitude: 2.35, country: "France", country_code: "FR", admin1: "Île-de-France" }
        ] });
      }
      return json({
        timezone: "Europe/Paris",
        current: { time: "2026-11-09T10:00", temperature_2m: 11.2, apparent_temperature: 9.8, relative_humidity_2m: 80, precipitation: 0, weather_code: 3, wind_speed_10m: 12, is_day: 1 },
        daily: {
          time: ["2026-11-09", "2026-11-10"],
          weather_code: [3, 61],
          temperature_2m_max: [13, 12],
          temperature_2m_min: [7, 8],
          precipitation_probability_max: [10, 80],
          precipitation_sum: [0, 4.2]
        }
      });
    });
    const result = await createWeatherTool(fetch).run({ location: "Paris, France", days: 2 }, testContext());
    assert.ok(!result.isError, result.content);
    assert.equal(result.data!.place.country, "France");
    assert.match(fetch.calls[1]!.url, /latitude=48\.85/);
    assert.match(fetch.calls[1]!.url, /forecast_days=2/);
    assert.doesNotMatch(fetch.calls[1]!.url, /fahrenheit/);
    assert.match(result.content, /Now: overcast, 11.2°C/);
    assert.match(result.content, /2026-11-10: light rain, 8–12°C, 80% chance/);
  });

  test("imperial units and unknown place", async () => {
    const fetch = fakeFetch((url) => (url.includes("geocoding") ? json({}) : json({ daily: {} })));
    const missing = await createWeatherTool(fetch).run({ location: "Nowhereville" }, testContext());
    assert.equal(missing.isError, true);
    const coords = await createWeatherTool(fetch).run({ latitude: 40, longitude: -74, units: "imperial" }, testContext());
    assert.ok(!coords.isError);
    assert.match(fetch.calls.at(-1)!.url, /temperature_unit=fahrenheit/);
  });

  test("network failure is an error result, not a throw", async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const result = await createWeatherTool(fetch).run({ location: "Oslo" }, testContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /fetch failed/);
  });
});

describe("currency_convert", () => {
  test("converts to several currencies", async () => {
    const fetch = fakeFetch(() => json({ amount: 1, base: "USD", date: "2026-11-06", rates: { EUR: 0.9, JPY: 150.5 } }));
    const result = await createCurrencyTool(fetch).run({ amount: 100, from: "usd", to: ["eur", "JPY"] }, testContext());
    assert.ok(!result.isError, result.content);
    assert.equal(fetch.calls[0]!.url, "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR%2CJPY");
    assert.deepEqual(result.data!.converted, { EUR: 90, JPY: 15050 });
    assert.match(result.content, /100 USD = 90 EUR/);
  });

  test("unsupported currency lists supported ones", async () => {
    const fetch = fakeFetch((url) =>
      url.endsWith("/currencies") ? json({ EUR: "Euro", USD: "US Dollar" }) : json({ message: "not found" }, 404)
    );
    const result = await createCurrencyTool(fetch).run({ from: "USD", to: "XYZ" as unknown as string[] }, testContext());
    assert.equal(result.isError, true);
    assert.match(result.content, /Supported: EUR, USD/);
    const invalid = await createCurrencyTool(fetch).run({ from: "dollars", to: ["EUR"] }, testContext());
    assert.equal(invalid.isError, true);
    assert.match(invalid.content, /invalid code/);
  });
});

describe("wikipedia", () => {
  test("search + summary with a proper User-Agent", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/search/page")) {
        return json({ pages: [
          { title: "Ada Lovelace", key: "Ada_Lovelace", excerpt: "<span>Ada</span> Lovelace was", description: "English mathematician" },
          { title: "Lovelace (film)", key: "Lovelace_(film)", description: "2013 film" }
        ] });
      }
      return json({
        type: "standard",
        title: "Ada Lovelace",
        description: "English mathematician (1815–1852)",
        extract: "Augusta Ada King, Countess of Lovelace, was an English mathematician.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Ada_Lovelace" } }
      });
    });
    const result = await createWikipediaTool(fetch).run({ query: "ada lovelace" }, testContext());
    assert.ok(!result.isError, result.content);
    assert.match(fetch.calls[0]!.url, /^https:\/\/en\.wikipedia\.org\/w\/rest\.php\/v1\/search\/page\?q=ada\+lovelace/);
    assert.equal(fetch.calls[1]!.url, "https://en.wikipedia.org/api/rest_v1/page/summary/Ada_Lovelace?redirect=true");
    assert.equal((fetch.calls[0]!.init!.headers as Record<string, string>)["user-agent"], "Sibyl/0.3 (open-source assistant)");
    assert.match(result.content, /Countess of Lovelace/);
    assert.match(result.content, /Other matches: Lovelace \(film\)/);
  });

  test("no results and bad language", async () => {
    const fetch = fakeFetch(() => json({ pages: [] }));
    const none = await createWikipediaTool(fetch).run({ query: "zzzz" }, testContext());
    assert.match(none.content, /no articles/);
    const bad = await createWikipediaTool(fetch).run({ query: "x", lang: "../evil" }, testContext());
    assert.equal(bad.isError, true);
  });
});

describe("web_search", () => {
  const config = { apiKey: "sk-test", baseUrl: "https://openrouter.ai/api/v1", model: "cheap/model", extraHeaders: { "X-Title": "Sibyl" } };

  test("uses the OpenRouter web plugin and returns cited results", async () => {
    const fetch = fakeFetch(() =>
      json({
        model: "cheap/model",
        choices: [{
          message: {
            content: "The strike is on Nov 12.",
            annotations: [
              { type: "url_citation", url_citation: { url: "https://news.example/a", title: "Strike set", content: "Workers   will strike on 12 November." } },
              { type: "url_citation", url_citation: { url: "https://news.example/a", title: "dup" } },
              { type: "url_citation", url_citation: { url: "https://other.example/b", title: "Metro info" } }
            ]
          }
        }],
        usage: { prompt_tokens: 2400, completion_tokens: 40, cost: 0.0074 }
      })
    );
    const context = testContext();
    const result = await createWebSearchTool({ ...config, fetch }).run({ query: "Lisbon metro strike", max_results: 3 }, context);
    assert.ok(!result.isError, result.content);
    const body = JSON.parse(String(fetch.calls[0]!.init!.body));
    assert.equal(fetch.calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.deepEqual(body.plugins, [{ id: "web", engine: "exa", max_results: 3 }]);
    assert.equal(body.model, "cheap/model");
    assert.deepEqual(body.usage, { include: true });
    const headers = fetch.calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer sk-test");
    assert.equal(headers["X-Title"], "Sibyl");
    assert.equal(result.data!.results.length, 2);
    assert.equal(result.data!.results[0]!.snippet, "Workers will strike on 12 November.");
    assert.match(result.content, /Digest: The strike is on Nov 12\./);
    assert.match(result.content, /1\. Strike set — https:\/\/news\.example\/a/);
    assert.equal(context.recorded.length, 1);
    assert.equal(context.recorded[0]!.feature, "tool");
    assert.equal(context.recorded[0]!.costUsd, 0.0074);
    assert.equal(context.recorded[0]!.estimated, false);
    assert.equal(context.recorded[0]!.requestId, "run-1");
  });

  test("budget block and HTTP errors are friendly", async () => {
    const fetch = fakeFetch(() => json({ error: { message: "Invalid API key" } }, 401));
    const blocked = await createWebSearchTool({ ...config, fetch }).run(
      { query: "x" },
      testContext({ meter: { record() {}, totals: () => ({ todayUsd: 0, monthUsd: 0, byFeature: {} }), limits: () => ({}), check: () => ({ allowed: false, scope: "daily", message: "Daily budget reached" }) } })
    );
    assert.equal(blocked.isError, true);
    assert.match(blocked.content, /Daily budget reached/);
    assert.equal(fetch.calls.length, 0);
    const failed = await createWebSearchTool({ ...config, fetch }).run({ query: "x" }, testContext());
    assert.equal(failed.isError, true);
    assert.match(failed.content, /HTTP 401 \(Invalid API key\)/);
  });
});

test("built-in set: all read-only builtins with valid names; web_search only with OpenRouter", () => {
  const without = createBuiltinTools();
  assert.deepEqual(without.map((t) => t.name), ["read_webpage", "weather", "currency_convert", "world_time", "calculate", "wikipedia"]);
  const withSearch = createBuiltinTools({ openRouter: { apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "m" } });
  assert.equal(withSearch[0]!.name, "web_search");
  for (const tool of withSearch) {
    assert.equal(tool.effect, "read");
    assert.equal(tool.source, "builtin");
    assert.equal((tool.inputSchema as { type: string }).type, "object");
    assert.ok(tool.description.length > 40);
  }
});
