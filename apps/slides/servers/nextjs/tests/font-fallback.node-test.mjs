import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Sibyl Slides bundles a curated font set; decks that name a family that is
// no longer bundled must render in Inter, not in a browser default.
let fonts;
let temporaryDirectory;

test.before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "sibyl-font-fallback-"));
  await build({
    entryPoints: [path.resolve("components/slide-editor/text/local-fonts.ts")],
    outfile: path.join(temporaryDirectory, "local-fonts.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: path.resolve("tsconfig.json"),
    logLevel: "silent",
  });
  fonts = await import(pathToFileURL(path.join(temporaryDirectory, "local-fonts.mjs")).href);
});

test.after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

const INTER = "/slides/vendor/fonts/sans_serif/inter/Inter[opsz,wght].ttf";

test("a removed family is served by Inter's files under its own name", () => {
  for (const family of ["Oswald", "Merriweather", "fira code", "Syne"]) {
    const option = fonts.localFontOptionForFamily(family);
    assert.ok(option, family);
    assert.ok(fonts.isRemovedFontFamily(family), family);
    const css = fonts.renderLocalFontFaceCss(option);
    assert.match(css, new RegExp(`font-family:"${option.family}"`));
    assert.ok(css.includes(INTER), css);
  }
});

test("bundled families keep their own files and are not marked removed", () => {
  for (const family of ["Inter", "Roboto", "Playfair Display", "JetBrains Mono", "Caveat"]) {
    const option = fonts.localFontOptionForFamily(family);
    assert.ok(option, family);
    assert.equal(fonts.isRemovedFontFamily(family), false);
  }
  const roboto = fonts.renderLocalFontFaceCss(fonts.localFontOptionForFamily("Roboto"));
  assert.ok(roboto.includes("/vendor/fonts/sans_serif/roboto/"));
  assert.ok(!roboto.includes("inter/Inter"));
});

test("the picker lists only bundled families", () => {
  const listed = fonts.LOCAL_FONT_OPTIONS.map((option) => option.family);
  assert.ok(listed.includes("Inter"));
  for (const family of fonts.REMOVED_FONT_FAMILIES) assert.ok(!listed.includes(family), family);
});

test("template font maps naming a removed vendor file fall back to Inter", () => {
  const options = fonts.localFontOptionsFromUnknown({
    Oswald: "/vendor/fonts/display/oswald/Oswald[wght].ttf",
  });
  assert.equal(options.length, 1);
  assert.equal(options[0].family, "Oswald");
  assert.ok(fonts.renderLocalFontFaceCss(options[0]).includes(INTER));
});

test("the Sibyl templates' variable Inter is declared for every weight", () => {
  for (const url of [
    "/app_data/templates/sibyl-graphite/static/Inter[opsz,wght].ttf",
    "/app_data/templates/sibyl-night/static/Inter.ttf",
  ]) {
    const [option] = fonts.localFontOptionsFromUnknown({ Inter: url });
    const css = fonts.renderLocalFontFaceCss(option);
    assert.match(css, /font-weight:100 900/, css);
  }
  const [staticFace] = fonts.localFontOptionsFromUnknown({ Inter: "/app_data/fonts/uploads/Inter-Bold.ttf" });
  assert.match(fonts.renderLocalFontFaceCss(staticFace), /font-weight:700/);
});

test("system families are left to the browser", () => {
  assert.equal(fonts.localFontOptionForFamily("Arial"), null);
});
