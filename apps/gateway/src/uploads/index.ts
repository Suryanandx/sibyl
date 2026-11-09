export * from "./service.js";
export * from "./types.js";
export { extractText, parseCsv, summariseCsv, summariseJson } from "./extract.js";
export { handleUploadsHttp, type UploadsHttpOptions } from "./http.js";
export { createUploadTools } from "./tools.js";
export { attachmentNote, pickVisionModel, prepareAttachments, supportsVision, withoutImages } from "./attachments.js";

import type { Store } from "@open-gpt-live/core";
import { UploadService, uploadOptionsFromEnv } from "./service.js";

/** One UploadService per gateway process (shared by the HTTP API and the read_file tool). */
const services = new WeakMap<Store, UploadService>();

export function uploadServiceFor(input: {
  store: Store;
  ownerId: string;
  env?: NodeJS.ProcessEnv;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): UploadService {
  const existing = services.get(input.store);
  if (existing) return existing;
  const service = new UploadService({ store: input.store, ownerId: input.ownerId, ...uploadOptionsFromEnv(input.env ?? process.env), ...(input.log ? { log: input.log } : {}) });
  services.set(input.store, service);
  return service;
}
