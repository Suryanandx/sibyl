import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoots = ["app", "components", "lib"];
const runtimeExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);

async function listFiles(directory, extensions = null) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listFiles(entryPath, extensions);
        return !extensions || extensions.has(path.extname(entry.name))
          ? [entryPath]
          : [];
      }),
    )
  ).flat();
}

test("runtime source does not load remote font services", async () => {
  const files = (
    await Promise.all(
      runtimeRoots.map((root) =>
        listFiles(path.join(projectDirectory, root), runtimeExtensions),
      ),
    )
  ).flat();
  const remoteFontPattern =
    /fonts\.googleapis\.com|fonts\.gstatic\.com|next\/font\/google/i;
  const violations = [];

  for (const file of files) {
    if (remoteFontPattern.test(await readFile(file, "utf8"))) {
      violations.push(path.relative(projectDirectory, file));
    }
  }

  assert.deepEqual(violations, []);
});

test("the local font catalog points to checked-in vendor assets", async () => {
  const catalogPath = path.join(
    projectDirectory,
    "components/slide-editor/text/local-fonts.ts",
  );
  const source = await readFile(catalogPath, "utf8");
  const entries = source.match(/^\s+(?:font|staticFont)\("/gm) ?? [];
  assert.equal(entries.length, 12);
  assert.doesNotMatch(source, /fonts\.googleapis|fonts\.gstatic/i);

  const fontFiles = await listFiles(
    path.join(projectDirectory, "public/vendor/fonts"),
  );
  assert.equal(fontFiles.length, 38);
  const totalBytes = (
    await Promise.all(fontFiles.map((file) => stat(file)))
  ).reduce((sum, info) => sum + info.size, 0);
  assert.ok(totalBytes <= 12 * 1024 * 1024, `fonts are ${totalBytes} bytes`);

  await Promise.all(
    [
      "sans_serif/inter/Inter[opsz,wght].ttf",
      "sans_serif/montserrat/Montserrat[wght].ttf",
      "serif/playfairdisplay/PlayfairDisplay[wght].ttf",
      "handwritten/caveat/Caveat[wght].ttf",
    ].map((asset) =>
      access(path.join(projectDirectory, "public/vendor/fonts", asset)),
    ),
  );
});

test("every catalog font file exists and fonts.json matches the catalog", async () => {
  const source = await readFile(
    path.join(projectDirectory, "components/slide-editor/text/local-fonts.ts"),
    "utf8",
  );
  const catalogBlock = source.slice(
    source.indexOf("export const LOCAL_FONT_OPTIONS"),
    source.indexOf("export const REMOVED_FONT_FAMILIES"),
  );
  const families = [...catalogBlock.matchAll(/^\s+(?:font|staticFont)\("([^"]+)", "([^"]+)", "([^"]+)", (.+)\),$/gm)];
  assert.equal(families.length, 12);
  for (const [, , category, directory, files] of families) {
    for (const [, file] of files.matchAll(/"([^"]+\.ttf)"/g)) {
      await access(path.join(projectDirectory, "public/vendor/fonts", category, directory, file));
    }
  }
  const fontsJson = JSON.parse(
    await readFile(path.join(projectDirectory, "../fastapi/assets/fonts.json"), "utf8"),
  );
  assert.deepEqual(
    fontsJson.map((entry) => entry.font_name).sort(),
    families.map(([, family]) => family).sort(),
  );
  for (const entry of fontsJson) {
    await access(path.join(projectDirectory, "public", entry.font_url));
  }
});
