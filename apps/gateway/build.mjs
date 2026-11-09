/**
 * Gateway bundle (esbuild) → dist/server.cjs.
 *
 * Edition: SIBYL_EDITION=oss | enterprise (default: include `ee/gateway` when
 * the directory exists). The virtual module "sibyl-ee-entry" used by
 * src/license/ee-loader.ts resolves to `ee/gateway/index.ts` or to the
 * stand-in src/license/ee-absent.ts, so deleting `ee/` still builds.
 * Including the enterprise code does not enable it: that needs a licence key.
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// --ee-dir / --outfile exist for tests (simulate a checkout without ee/).
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const eeEntry = resolve(flag("--ee-dir") ?? resolve(here, "../../ee"), "gateway/index.ts");
const absent = resolve(here, "src/license/ee-absent.ts");
const requested = (process.env.SIBYL_EDITION ?? "").trim().toLowerCase();
if (requested && requested !== "oss" && requested !== "enterprise") {
  console.error(`SIBYL_EDITION must be "oss" or "enterprise" (got "${requested}")`);
  process.exit(1);
}
if (requested === "enterprise" && !existsSync(eeEntry)) {
  console.error("SIBYL_EDITION=enterprise but ee/gateway/index.ts is missing");
  process.exit(1);
}
const includeEe = requested !== "oss" && existsSync(eeEntry);

await build({
  entryPoints: [resolve(here, "src/server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: resolve(flag("--outfile") ?? resolve(here, "dist/server.cjs")),
  sourcemap: true,
  define: { __SIBYL_BUNDLE__: "true" },
  // Loaded at run time from node_modules, installed next to the bundle (see Dockerfile.gateway):
  // playwright-core (agent computers) ships its own bundles and assets; @livekit/rtc-node
  // (LiveKit realtime layer) is native WebRTC, loaded only when LIVEKIT_* is set.
  external: ["playwright-core", "@livekit/rtc-node"],
  plugins: [
    {
      name: "sibyl-ee-entry",
      setup(b) {
        b.onResolve({ filter: /^sibyl-ee-entry$/ }, () => ({ path: includeEe ? eeEntry : absent }));
      }
    }
  ]
});
console.log(`gateway built (edition: ${includeEe ? "enterprise modules included" : "open source only"})`);
