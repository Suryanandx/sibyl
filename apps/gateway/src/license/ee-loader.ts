/**
 * THE single entry point from open-source code into `ee/` (see LICENSING.md).
 * scripts/check-ee-boundary.mjs allows this file, and only this file, to
 * reach `ee/gateway`.
 *
 * - Bundled gateway (esbuild, apps/gateway/build.mjs): the virtual module
 *   "sibyl-ee-entry" is resolved at build time to `ee/gateway/index.ts` when
 *   that directory exists and SIBYL_EDITION is not "oss", otherwise to
 *   ./ee-absent.ts. Deleting `ee/` therefore still builds.
 * - Source runs (tsx dev, vitest): `ee/gateway/index.ts` is looked up on disk
 *   and imported if present.
 *
 * Callers only load the entry when the licence enables at least one feature.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EnterpriseRegistrar } from "@open-gpt-live/core";

/** What `ee/gateway/index.ts` default-exports. */
export type EnterpriseEntry = (registrar: EnterpriseRegistrar) => void | Promise<void>;

declare const __SIBYL_BUNDLE__: boolean | undefined;

export interface LoadEnterpriseOptions {
  env?: NodeJS.ProcessEnv;
  /** Where to start looking for `ee/` in source runs (default: process.cwd()). */
  searchFrom?: string;
}

export async function loadEnterpriseEntry(options: LoadEnterpriseOptions = {}): Promise<EnterpriseEntry | undefined> {
  const env = options.env ?? process.env;
  if (env.SIBYL_EDITION?.trim().toLowerCase() === "oss") return undefined;
  if (typeof __SIBYL_BUNDLE__ !== "undefined" && __SIBYL_BUNDLE__) {
    const bundled = (await import("sibyl-ee-entry")) as { default?: EnterpriseEntry };
    return typeof bundled.default === "function" ? bundled.default : undefined;
  }
  const file = findEnterpriseGateway(options.searchFrom ?? process.cwd());
  if (!file) return undefined;
  const loaded = (await import(/* @vite-ignore */ file)) as { default?: EnterpriseEntry };
  return typeof loaded.default === "function" ? loaded.default : undefined;
}

/** Absolute path of `ee/gateway/index.ts` in this checkout, if present. */
export function findEnterpriseGateway(from: string): string | undefined {
  let dir = resolve(from);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "ee", "gateway", "index.ts");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
