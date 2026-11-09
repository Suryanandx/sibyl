/**
 * @open-gpt-live/store — persistent Store implementations.
 *
 * `openStore()` is what the gateway calls: SQLite in `<dataDir>/sibyl.db`, or
 * the in-memory store when `SIBYL_STORAGE=memory`.
 */
import { join } from "node:path";
import { createMemoryStore, type Store } from "@open-gpt-live/core";
import { createSqliteStore } from "./sqlite";

export { createSqliteStore, SCHEMA_VERSION, type SqliteStoreOptions } from "./sqlite";

export const DATABASE_FILE = "sibyl.db";

export interface OpenStoreResult {
  store: Store;
  kind: "sqlite" | "memory";
  /** Database file path when kind is "sqlite". */
  file?: string;
}

/** Pick the store from the environment (`SIBYL_STORAGE`, `SIBYL_DATA_DIR`). */
export function openStore(env: NodeJS.ProcessEnv): OpenStoreResult {
  if (env.SIBYL_STORAGE?.trim().toLowerCase() === "memory") {
    return { store: createMemoryStore(), kind: "memory" };
  }
  const dataDir = env.SIBYL_DATA_DIR?.trim() || "./data";
  const file = join(dataDir, DATABASE_FILE);
  return { store: createSqliteStore({ file }), kind: "sqlite", file };
}
