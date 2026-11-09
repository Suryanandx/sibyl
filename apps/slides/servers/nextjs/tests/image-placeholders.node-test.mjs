import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

test("inserted image frames and collages use a scalable vector placeholder", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "presenton-image-placeholder-"));
  try {
    const output = path.join(directory, "insert-elements.mjs");
    await build({
      entryPoints: [path.resolve("components/slide-editor/insert/insert-elements.ts")],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      tsconfig: path.resolve("tsconfig.json"),
      logLevel: "silent",
    });
    const { createImageInsertContent } = await import(pathToFileURL(output).href);
    for (const kind of ["image", "image-frame-circle", "image-grid", "image-collage"]) {
      const content = createImageInsertContent(kind);
      const images = [
        ...(content.elements ?? []),
        ...(content.components ?? []).flatMap((component) => component.elements),
      ].filter((element) => element.type === "image");
      assert.ok(images.length > 0, kind);
      for (const image of images) {
        assert.match(image.data, /image-placeholder\.svg$/);
        const asset = await readFile(path.join("public", image.data), "utf8");
        assert.match(asset, /<svg[^>]*viewBox=/);
        assert.doesNotMatch(asset, /<image\b|data:image/);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
