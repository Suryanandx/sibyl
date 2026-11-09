import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  getRuntimePlatformArch,
  validateSharpRuntime,
} = require("./sync-presentation-export.cjs");

function writePackage(root, packageName, packageJson) {
  const packageDirectory = path.join(
    root,
    "node_modules",
    ...packageName.split("/"),
  );
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify(packageJson)}\n`,
  );
}

function makeSharpRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "presenton-sharp-runtime-"));
  writePackage(root, "sharp", {
    version: "0.35.3",
    optionalDependencies: {
      "@img/sharp-darwin-arm64": "0.35.3",
      "@img/sharp-libvips-darwin-arm64": "1.3.2",
    },
  });
  return root;
}

test("getRuntimePlatformArch distinguishes glibc and musl Linux", () => {
  const glibcReport = {
    getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }),
  };
  const muslReport = { getReport: () => ({ header: {} }) };

  assert.equal(getRuntimePlatformArch("linux", "x64", glibcReport), "linux-x64");
  assert.equal(
    getRuntimePlatformArch("linux", "arm64", muslReport),
    "linuxmusl-arm64",
  );
  assert.equal(getRuntimePlatformArch("darwin", "arm64"), "darwin-arm64");
});

test("validateSharpRuntime rejects a runtime missing the target native package", () => {
  const root = makeSharpRuntime();
  try {
    assert.deepEqual(validateSharpRuntime(root, "darwin-arm64"), {
      ok: false,
      reason: "Missing @img/sharp-darwin-arm64 0.35.3 for darwin-arm64.",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateSharpRuntime rejects native packages from another Sharp release", () => {
  const root = makeSharpRuntime();
  try {
    writePackage(root, "@img/sharp-darwin-arm64", { version: "0.34.5" });
    assert.deepEqual(validateSharpRuntime(root, "darwin-arm64"), {
      ok: false,
      reason: "Expected @img/sharp-darwin-arm64 0.35.3, found 0.34.5.",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateSharpRuntime accepts matching native and libvips packages", () => {
  const root = makeSharpRuntime();
  try {
    writePackage(root, "@img/sharp-darwin-arm64", { version: "0.35.3" });
    writePackage(root, "@img/sharp-libvips-darwin-arm64", { version: "1.3.2" });
    assert.deepEqual(validateSharpRuntime(root, "darwin-arm64"), {
      ok: true,
      sharpVersion: "0.35.3",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reusing a pinned export package refreshes its application runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "presenton-export-runner-"));
  try {
    const runtime = path.join(root, "presentation-export");
    const scripts = path.join(root, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ presentationExportVersion: "v1.0.34" }));
    fs.copyFileSync(fileURLToPath(new URL("./sync-presentation-export.cjs", import.meta.url)), path.join(scripts, "sync-presentation-export.cjs"));
    const runner = fs.readFileSync(fileURLToPath(new URL("./run-presentation-export.mjs", import.meta.url)), "utf8");
    fs.writeFileSync(path.join(scripts, "run-presentation-export.mjs"), runner);
    writePackage(runtime, "@presenton/export-core", { version: "1.0.34" });
    const platform = getRuntimePlatformArch();
    const native = `@img/sharp-${platform}`;
    writePackage(runtime, "sharp", { version: "0.35.3", optionalDependencies: { [native]: "0.35.3" } });
    writePackage(runtime, native, { version: "0.35.3" });
    fs.writeFileSync(path.join(runtime, "runner.mjs"), "// stale runner");
    fs.writeFileSync(path.join(runtime, "presenton-export-version.json"), JSON.stringify({ version: "v1.0.34", package: "presenton-export-core-opensource-1.0.34.tgz" }));
    const output = execFileSync(process.execPath, [path.join(scripts, "sync-presentation-export.cjs")], { encoding: "utf8", env: { ...process.env, EXPORT_RUNTIME_VERSION: "" } });
    assert.match(output, /Using export-core 1\.0\.34/);
    assert.equal(fs.readFileSync(path.join(runtime, "runner.mjs"), "utf8"), runner);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
