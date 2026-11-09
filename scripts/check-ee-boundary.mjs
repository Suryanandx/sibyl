#!/usr/bin/env node
/**
 * Open-core import boundary (see LICENSING.md).
 *
 * Fails when any source file outside `ee/` imports, requires or re-exports a
 * module that resolves into `ee/`. The single documented exception is the
 * gateway's enterprise loader, which reaches `ee/gateway` only through the
 * build-time virtual module "sibyl-ee-entry" or a runtime path lookup.
 *
 *   node scripts/check-ee-boundary.mjs           → exit 0 / 1
 *   node scripts/check-ee-boundary.mjs --root X  → check another tree (tests)
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Files allowed to reach into ee/ (paths relative to the repo root, posix). */
export const ALLOWED_ENTRY_POINTS = ["apps/gateway/src/license/ee-loader.ts", "apps/gateway/build.mjs"];

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".next-build", "dist", "coverage", ".claude", ".turbo", "output", ".venv", "data"]);
/** Specifiers in import/export-from/require()/import() statements. */
const SPECIFIER = /(?:\bimport\s*(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+(?:type\s+)?[\w*{}\s,$]+\s+from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["'`]([^"'`]+)["'`]/g;

export function checkBoundary(root) {
  const eeDir = resolve(root, "ee");
  const violations = [];
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel === "ee" || rel.startsWith("ee/")) continue;
    if (ALLOWED_ENTRY_POINTS.includes(rel)) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (!pointsIntoEe(specifier, file, root, eeDir)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      violations.push({ file: rel, line, specifier });
    }
  }
  return violations;
}

/** Blank out comments (keeping line numbers) so prose mentioning ee/ is ignored. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\"'`])\/\/[^\n]*/g, (_, before) => before);
}

function pointsIntoEe(specifier, file, root, eeDir) {
  if (specifier === "sibyl-ee-entry") return true;
  if (/^@sibyl\/ee\b|^@open-gpt-live\/ee\b/.test(specifier)) return true;
  let target;
  if (specifier.startsWith(".")) target = resolve(dirname(file), specifier);
  else if (specifier.startsWith("/")) target = resolve(specifier);
  else if (specifier === "ee" || specifier.startsWith("ee/")) target = resolve(root, specifier);
  else return false;
  return target === eeDir || target.startsWith(eeDir + sep);
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield join(dir, entry.name);
    }
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const rootFlag = process.argv.indexOf("--root");
  const root = resolve(rootFlag > -1 ? process.argv[rootFlag + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
  const violations = checkBoundary(root);
  if (violations.length > 0) {
    console.error("Open-source code must not import from ee/ (see LICENSING.md). Violations:");
    for (const v of violations) console.error(`  ${v.file}:${v.line}  "${v.specifier}"`);
    console.error(`Only ${ALLOWED_ENTRY_POINTS.join(", ")} may load enterprise code.`);
    process.exit(1);
  }
  console.log("ee boundary ok: no open-source file imports from ee/");
}
