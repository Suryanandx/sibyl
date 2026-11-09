/**
 * Registers the wave-2 tools: memory (remember / forget / recall) unless
 * SIBYL_MEMORY=false, and read_file for uploaded files.
 */
import type { Store, ToolRegistry } from "@open-gpt-live/core";
import { createUploadTools, uploadServiceFor } from "../uploads/index.js";
import { memoryAvailable } from "./store.js";
import { createMemoryTools } from "./tools.js";

export function installMemoryAndUploadTools(input: {
  tools: ToolRegistry;
  store: Store;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
}): void {
  const installed: string[] = [];
  if (memoryAvailable(input.env)) {
    for (const tool of createMemoryTools(input.env)) {
      input.tools.register(tool);
      installed.push(tool.name);
    }
  }
  const uploads = uploadServiceFor({ store: input.store, ownerId: input.ownerId, env: input.env, log: input.log });
  for (const tool of createUploadTools(uploads)) {
    input.tools.register(tool);
    installed.push(tool.name);
  }
  input.log("tools.memory_uploads_installed", { tools: installed, uploadsDir: uploads.dir });
}
