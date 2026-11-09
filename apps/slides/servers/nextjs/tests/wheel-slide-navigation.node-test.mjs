import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let navigation;
let temporaryDirectory;

test.before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "presenton-wheel-"));
  const outfile = path.join(temporaryDirectory, "navigation.mjs");
  await build({
    entryPoints: [
      path.resolve(
        "app/(presentation-generator)/presentation/utils/wheelSlideNavigation.ts",
      ),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  navigation = await import(pathToFileURL(outfile).href);
});

test.after(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function gesture() {
  const state = navigation.createWheelNavigationState();
  return (deltaY, now, deltaX = 0) =>
    navigation.consumeWheelNavigation(state, { deltaX, deltaY }, now);
}

test("scrolls down to advance and up to go back without a distance threshold", () => {
  assert.equal(gesture()(1, 1000), 1);
  assert.equal(gesture()(-1, 1000), -1);
});

test("a trackpad gesture and its decaying momentum select only one slide", () => {
  const scroll = gesture();
  const results = [30, 55, 80, 70, 50, 32, 18, 8, 3, 1].map(
    (delta, index) => scroll(delta, 1000 + index * 16),
  );
  assert.deepEqual(results, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("a separate mouse wheel or trackpad gesture advances again", () => {
  const scroll = gesture();
  assert.equal(scroll(20, 1000), 1);
  assert.equal(scroll(10, 1030), 0);
  assert.equal(scroll(20, 1131), 1);
});

test("reversing direction during momentum allows navigating back", () => {
  const scroll = gesture();
  assert.equal(scroll(35, 1000), 1);
  assert.equal(scroll(20, 1030), 0);
  assert.equal(scroll(-15, 1060), -1);
  assert.equal(scroll(-10, 1080), 0);
});

test("a fresh swipe can restart while the previous swipe is slowing down", () => {
  const scroll = gesture();
  assert.equal(scroll(40, 1000), 1);
  assert.equal(scroll(20, 1020), 0);
  assert.equal(scroll(10, 1040), 0);
  assert.equal(scroll(30, 1060), 1);
  assert.equal(scroll(40, 1080), 0);
});

test("horizontal scrolling and subpixel noise do not consume a gesture", () => {
  const scroll = gesture();
  assert.equal(scroll(0.5, 1000), 0);
  assert.equal(scroll(10, 1010, 20), 0);
  assert.equal(scroll(10, 1020, 10), 0);
  assert.equal(scroll(10, 1030, 2), 1);
});

test("small momentum reversals do not cause an accidental slide change", () => {
  const scroll = gesture();
  assert.equal(scroll(12, 1000), 1);
  assert.equal(scroll(8, 1020), 0);
  assert.equal(scroll(-2, 1060), 0);
});
