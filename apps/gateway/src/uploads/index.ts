export * from "./service.js";
export * from "./types.js";
export { extractText, looksScanned, parseCsv, summariseCsv, summariseJson } from "./extract.js";
export { readArchive, DEFAULT_ARCHIVE_LIMITS, type ArchiveFile, type ArchiveLimits } from "./archive.js";
export { handleUploadsHttp, type UploadsHttpOptions } from "./http.js";
export { createUploadTools } from "./tools.js";
export { attachmentNote, pickVisionModel, prepareAttachments, supportsVision, withoutImages } from "./attachments.js";

import type { Store } from "@open-gpt-live/core";
import { UploadService, uploadOptionsFromEnv } from "./service.js";

/** One UploadService per organization (shared by the HTTP API and the read_file tool); hosted organizations share the store. */
const services = new WeakMap<Store, Map<string, UploadService>>();

export function uploadServiceFor(input: {
  store: Store;
  ownerId: string;
  env?: NodeJS.ProcessEnv;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): UploadService {
  let byOrg = services.get(input.store);
  if (!byOrg) services.set(input.store, (byOrg = new Map()));
  const existing = byOrg.get(input.ownerId);
  if (existing) return existing;
  const service = new UploadService({ store: input.store, ownerId: input.ownerId, ...uploadOptionsFromEnv(input.env ?? process.env), ...(input.log ? { log: input.log } : {}) });
  byOrg.set(input.ownerId, service);
  return service;
}
