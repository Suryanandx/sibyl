/**
 * Uploaded files: bytes under `<dataDir>/uploads/<id>/file`, extracted text in
 * `<id>/extracted.txt`, and an ArtifactRecord (kind "file") in the store.
 *
 * Ids are generated here and validated on every read; file names from the
 * browser are display-only and never touch the filesystem.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ArtifactRecord, Store } from "@open-gpt-live/core";
import { extractText } from "./extract.js";
import { cleanFileName, detectType, type UploadKind } from "./types.js";

export const DEFAULT_UPLOAD_MAX_MB = 20;
const UPLOAD_ID = /^up_[a-f0-9]{24}$/;

export interface UploadView {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: UploadKind;
  summary: string;
  pages?: number;
  chars: number;
  createdAt: number;
}

export interface UploadMeta {
  name: string;
  mime: string;
  size: number;
  kind: UploadKind;
  summary: string;
  pages?: number;
  /** Characters of extracted text. */
  chars: number;
  /** Extracted text file, relative to the upload's folder. */
  textPath: string;
  extractError?: string;
}

export class UploadError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export interface UploadServiceOptions {
  store: Store;
  ownerId: string;
  /** Folder for uploads (default `$SIBYL_DATA_DIR/uploads`). */
  dir: string;
  maxBytes: number;
  now?: () => number;
  createId?: () => string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export function uploadOptionsFromEnv(env: NodeJS.ProcessEnv): { dir: string; maxBytes: number } {
  const dataDir = env.SIBYL_DATA_DIR?.trim() || "./data";
  const mb = Number(env.SIBYL_UPLOAD_MAX_MB);
  return {
    dir: resolve(dataDir, "uploads"),
    maxBytes: Math.round((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_UPLOAD_MAX_MB) * 1024 * 1024)
  };
}

export function isUploadId(id: unknown): id is string {
  return typeof id === "string" && UPLOAD_ID.test(id);
}

export class UploadService {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: UploadServiceOptions) {
    this.dir = resolve(options.dir);
    this.maxBytes = options.maxBytes;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `up_${randomUUID().replace(/-/g, "").slice(0, 24)}`);
  }

  /** Folder of one upload; throws for anything that isn't a well-formed id inside `dir`. */
  folderFor(id: string): string {
    if (!isUploadId(id)) throw new UploadError("Invalid file id.", 400, "invalid_id");
    const folder = resolve(this.dir, id);
    if (!folder.startsWith(this.dir + sep)) throw new UploadError("Invalid file id.", 400, "invalid_id");
    return folder;
  }

  async save(input: { data: Buffer; filename?: string; conversationId?: string }): Promise<UploadView> {
    if (input.data.byteLength === 0) throw new UploadError("The file is empty.", 400, "empty");
    if (input.data.byteLength > this.maxBytes) {
      throw new UploadError(`The file is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB.`, 413, "too_large");
    }
    const name = cleanFileName(input.filename);
    const type = detectType(input.data, name);
    if (!type) {
      throw new UploadError(
        "Unsupported file type. Sibyl accepts images (PNG, JPEG, WebP, GIF), PDF, text, Markdown, CSV, JSON, DOCX and XLSX.",
        415,
        "unsupported_type"
      );
    }
    const id = this.createId();
    const folder = this.folderFor(id);
    await mkdir(folder, { recursive: true });
    try {
      await writeFile(join(folder, "file"), input.data, { mode: 0o600 });
      let text = "";
      let summary: string = type.kind;
      let pages: number | undefined;
      let extractError: string | undefined;
      try {
        const extraction = await extractText(type.kind, input.data);
        text = extraction.text;
        summary = extraction.summary;
        pages = extraction.pages;
      } catch (error) {
        extractError = (error as Error).message;
        summary = `${type.kind}, text could not be read`;
        this.options.log?.("upload.extract_failed", { id, kind: type.kind, error: extractError });
      }
      await writeFile(join(folder, "extracted.txt"), text, { encoding: "utf8", mode: 0o600 });
      const meta: UploadMeta = {
        name,
        mime: type.mime,
        size: input.data.byteLength,
        kind: type.kind,
        summary,
        ...(pages !== undefined ? { pages } : {}),
        chars: text.length,
        textPath: "extracted.txt",
        ...(extractError ? { extractError } : {})
      };
      const createdAt = this.now();
      const record: ArtifactRecord = {
        id,
        ownerId: this.options.ownerId,
        kind: "file",
        title: name,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        version: 1,
        meta: meta as unknown as Record<string, unknown>,
        createdAt
      };
      await this.options.store.artifacts.create(record);
      this.options.log?.("upload.saved", { id, kind: type.kind, size: meta.size, chars: meta.chars });
      return toView(record);
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** The upload's record, or undefined when unknown / not the owner's / not a file. */
  async get(id: string, ownerId = this.options.ownerId): Promise<UploadView | undefined> {
    if (!isUploadId(id)) return undefined;
    const record = await this.options.store.artifacts.get(ownerId, id);
    if (!record || record.kind !== "file" || !isUploadMeta(record.meta)) return undefined;
    return toView(record);
  }

  async readBytes(id: string): Promise<Buffer> {
    return readFile(join(this.folderFor(id), "file"));
  }

  async readText(id: string): Promise<string> {
    try {
      return await readFile(join(this.folderFor(id), "extracted.txt"), "utf8");
    } catch {
      return "";
    }
  }
}

function isUploadMeta(meta: Record<string, unknown>): boolean {
  return typeof meta.name === "string" && typeof meta.mime === "string" && typeof meta.kind === "string";
}

function toView(record: ArtifactRecord): UploadView {
  const meta = record.meta as unknown as UploadMeta;
  return {
    id: record.id,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    kind: meta.kind,
    summary: meta.summary,
    ...(meta.pages !== undefined ? { pages: meta.pages } : {}),
    chars: meta.chars ?? 0,
    createdAt: record.createdAt
  };
}
