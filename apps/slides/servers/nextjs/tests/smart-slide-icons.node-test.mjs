import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let icons;
let svg;
let temporaryDirectory;
const baseUrl = "http://localhost:3000/upload";
const cloudIcon = "https://presenton-public-eu.s3.eu-central-1.amazonaws.com/static/icons/bold/leaf-bold.svg";

test.before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "presenton-smart-icons-"));
  for (const name of ["smart-slide-icons", "svg-color"]) {
    await build({
      entryPoints: [path.resolve(`lib/${name}.ts`)],
      outfile: path.join(temporaryDirectory, `${name}.mjs`),
      bundle: true,
      platform: "node",
      format: "esm",
      tsconfig: path.resolve("tsconfig.json"),
      logLevel: "silent",
    });
  }
  icons = await import(pathToFileURL(path.join(temporaryDirectory, "smart-slide-icons.mjs")).href);
  svg = await import(pathToFileURL(path.join(temporaryDirectory, "svg-color.mjs")).href);
});

test.after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("applies a community icon's declared color through the local SVG transform", () => {
  const result = new URL(icons.getSmartSlideIconSource(cloudIcon, "#FFFFFF", baseUrl), baseUrl);
  assert.equal(result.origin, "http://localhost:3000");
  assert.equal(result.pathname, "/api/update-svg");
  assert.equal(result.searchParams.get("url"), cloudIcon);
  assert.equal(result.searchParams.get("color"), "#FFFFFF");

  const markup = svg.transformSvgMarkup(
    '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill="#000000" d="M0 0h10v10z"/></svg>',
    { color: result.searchParams.get("color") },
  );
  assert.match(markup, /fill="#FFFFFF"/);
  assert.doesNotMatch(markup, /#000000|currentColor/);
});

test("replaces stale legacy paint while preserving opacity and stroke width", () => {
  const source = `/api/update-svg?url=${encodeURIComponent(cloudIcon)}&stroke=000000&fill=FF0000&strokeWidth=3&opacity=0.7`;
  const result = new URL(icons.getSmartSlideIconSource(source, "00D2FF", baseUrl), baseUrl);
  assert.equal(result.searchParams.get("color"), "#00D2FF");
  assert.equal(result.searchParams.get("stroke"), null);
  assert.equal(result.searchParams.get("fill"), null);
  assert.equal(result.searchParams.get("strokeWidth"), "3");
  assert.equal(result.searchParams.get("opacity"), "0.7");
  assert.equal(result.searchParams.get("url"), cloudIcon);
});

test("supports bundled icon paths and is stable across repeated renders", () => {
  const first = icons.getSmartSlideIconSource("/static/icons/regular/leaf.svg", "#75B798", baseUrl);
  assert.equal(icons.getSmartSlideIconSource(first, "#75B798", baseUrl), first);
});

test("leaves images, unsupported SVGs and icons without a valid color untouched", () => {
  for (const source of ["/photo.png", "https://example.com/logo.svg", "data:image/svg+xml,<svg/>"]) {
    assert.equal(icons.getSmartSlideIconSource(source, "#FFFFFF", baseUrl), source);
  }
  for (const color of [null, "", 'red; background: url("evil")']) {
    assert.equal(icons.getSmartSlideIconSource(cloudIcon, color, baseUrl), cloudIcon);
  }
});
