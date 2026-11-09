/**
 * ZIP archives as a set of files: used for a ZIP attached to a chat (the text
 * of every readable file) and for bulk-adding to knowledge (each readable file
 * becomes its own document). Zip-bomb limits: entries are inflated one at a
 * time with a byte cap each, a cap on the archive's total, and on the count.
 */
import { cleanFileName, detectType, refusalFor, type DetectedType } from "./types.js";
import { listZipEntries, readZipEntry, ZipError } from "./zip.js";

export interface ArchiveLimits {
  /** Largest single file inside (default: the upload limit). */
  maxEntryBytes: number;
  /** All files inside together. */
  maxTotalBytes: number;
  /** Files taken from one archive. */
  maxFiles: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFiles: 200
};

export interface ArchiveFile {
  /** Path inside the archive (display only; never touches the filesystem). */
  path: string;
  /** File name without folders. */
  name: string;
  data: Buffer;
  type: DetectedType;
}

export interface ArchiveContents {
  files: ArchiveFile[];
  skipped: Array<{ name: string; reason: string }>;
}

/** Noise that archivers add; ignored without a mention. */
const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

export function readArchive(data: Buffer, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveContents {
  const entries = listZipEntries(data);
  const files: ArchiveFile[] = [];
  const skipped: ArchiveContents["skipped"] = [];
  let total = 0;
  const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
  for (const entry of entries) {
    if (entry.name.endsWith("/") || IGNORED.test(entry.name)) continue;
    const path = entry.name.replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 300);
    const name = cleanFileName(path);
    const skip = (reason: string) => skipped.push({ name: path, reason });
    if (files.length >= limits.maxFiles) {
      skip(`more than ${limits.maxFiles} files in one archive`);
      continue;
    }
    if (entry.flags & 1) {
      skip("encrypted");
      continue;
    }
    if (entry.size > limits.maxEntryBytes) {
      skip(`larger than ${mb(limits.maxEntryBytes)}`);
      continue;
    }
    if (total + entry.size > limits.maxTotalBytes) {
      skip(`the archive holds more than ${mb(limits.maxTotalBytes)} in total`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readZipEntry(data, entry, limits.maxEntryBytes);
    } catch (error) {
      skip(error instanceof ZipError && /too large|buffer|output length/i.test(error.message) ? `larger than ${mb(limits.maxEntryBytes)}` : "could not be unpacked");
      continue;
    }
    if (bytes.byteLength === 0) {
      skip("empty");
      continue;
    }
    total += bytes.byteLength;
    if (total > limits.maxTotalBytes) {
      skip(`the archive holds more than ${mb(limits.maxTotalBytes)} in total`);
      continue;
    }
    const type = detectType(bytes, name);
    if (!type) {
      skip(refusalFor(bytes, name));
      continue;
    }
    if (type.kind === "zip") {
      skip("archives inside archives aren't opened");
      continue;
    }
    files.push({ path, name, data: bytes, type });
  }
  return { files, skipped };
}
