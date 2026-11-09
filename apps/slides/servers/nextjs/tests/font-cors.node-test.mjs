import assert from "node:assert/strict";
import test from "node:test";

import nextConfig from "../next.config.mjs";

test("bundled fonts allow CORS from sandboxed community previews", async () => {
  const rules = await nextConfig.headers();
  const fontRule = rules.find((rule) => rule.source === "/vendor/fonts/:path*");

  assert.ok(fontRule);
  assert.deepEqual(fontRule.headers, [
    { key: "Access-Control-Allow-Origin", value: "*" },
  ]);
});

test("wildcard CORS is limited to public bundled font assets", async () => {
  const rules = await nextConfig.headers();
  const corsRules = rules.filter((rule) =>
    rule.headers.some(
      (header) => header.key.toLowerCase() === "access-control-allow-origin",
    ),
  );

  assert.deepEqual(corsRules.map((rule) => rule.source), ["/vendor/fonts/:path*"]);
  assert.ok(
    corsRules.every((rule) =>
      rule.headers.every(
        (header) =>
          header.key.toLowerCase() !== "access-control-allow-credentials",
      ),
    ),
  );
});
