import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let autosave;
let temporaryDirectory;

test.before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "presenton-autosave-"));
  const outputFile = path.join(temporaryDirectory, "bundle.mjs");
  await build({
    entryPoints: [path.resolve("app/(presentation-generator)/presentation/utils/autoSaveDiff.ts")],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  autosave = await import(pathToFileURL(outputFile).href);
});

test.after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

const presentation = {
  id: "presentation-id",
  title: "Original",
  n_slides: 1,
  theme: { primary: "#123456" },
  slides: [{ id: "slide-id", index: 0, content: { title: "Original" } }],
};

test("whole-deck updates exclude the template theme", () => {
  const payload = autosave.createPresentationUpdatePayload(presentation);
  assert.deepEqual(payload, {
    id: presentation.id,
    title: presentation.title,
    n_slides: presentation.n_slides,
    slides: presentation.slides,
  });
  assert.equal(Object.hasOwn(payload, "theme"), false);
});

test("template-theme hydration does not trigger a presentation update", () => {
  const snapshot = autosave.createAutoSaveSnapshot(presentation);
  const changes = autosave.getAutoSaveChanges(snapshot, {
    ...presentation,
    theme: { primary: "#abcdef" },
  });
  assert.equal(changes.metadataChanged, false);
  assert.equal(changes.structuralChange, false);
  assert.deepEqual(changes.changedSlides, []);
});

test("title, content and slide-order changes still trigger their save paths", () => {
  const snapshot = autosave.createAutoSaveSnapshot(presentation);
  assert.equal(autosave.getAutoSaveChanges(snapshot, { ...presentation, title: "Renamed" }).metadataChanged, true);
  const editedSlide = { ...presentation.slides[0], content: { title: "Edited" } };
  assert.deepEqual(autosave.getAutoSaveChanges(snapshot, { ...presentation, slides: [editedSlide] }).changedSlides, [editedSlide]);
  assert.equal(autosave.getAutoSaveChanges(snapshot, { ...presentation, slides: [...presentation.slides, { id: "new-slide", index: 1 }] }).structuralChange, true);
});
