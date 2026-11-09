/**
 * Uploaded files: bytes under `<dataDir>/uploads/<id>/file`, extracted text in
 * `<id>/extracted.txt`, and an ArtifactRecord (kind "file") in the store.
 *
 * Ids are generated here and validated on every read; file names from the
 * browser are display-only and never touch the filesystem.
 *
 * Every upload belongs to the workspace it was sent in (records without one:
 * the default workspace). Reads that name a workspace only find its files.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DEFAULT_WORKSPACE_ID, inWorkspace, type ArtifactRecord, type Store } from "@open-gpt-live/core";
import type { FileParts } from "@open-gpt-live/protocol";
import { idPattern, newId } from "../http/ids.js";
import { extractText } from "./extract.js";
import { cleanFileName, detectType, refusalFor, type UploadKind } from "./types.js";

export const DEFAULT_UPLOAD_MAX_MB = 20;
const UPLOAD_ID = idPattern("up");

/** Which uploads a read may see: the owner (default: the service's) and, when set, one workspace. */
export interface UploadScope {
  ownerId?: string;
  workspaceId?: string;
}

export interface UploadView {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: UploadKind;
  summary: string;
  pages?: number;
  parts?: FileParts;
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
  parts?: FileParts;
  /** Characters of extracted text. */
  chars: number;
  /** Extracted text file, relative to the upload's folder. */
  textPath: string;
  extractError?: string;
}

/** Text read from a file by a vision / OCR model, with what it cost. */
export interface ModelText {
  text: string;
  model: string;
  engine?: string;
  costUsd: number;
  estimated: boolean;
  createdAt: number;
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
    this.createId = options.createId ?? (() => newId("up"));
  }

  /** Folder of one upload; throws for anything that isn't a well-formed id inside `dir`. */
  folderFor(id: string): string {
    if (!isUploadId(id)) throw new UploadError("Invalid file id.", 400, "invalid_id");
    const folder = resolve(this.dir, id);
    if (!folder.startsWith(this.dir + sep)) throw new UploadError("Invalid file id.", 400, "invalid_id");
    return folder;
  }

  async save(input: { data: Buffer; filename?: string; conversationId?: string; workspaceId?: string; maxBytes?: number }): Promise<UploadView> {
    const maxBytes = input.maxBytes ?? this.maxBytes;
    if (input.data.byteLength === 0) throw new UploadError("The file is empty.", 400, "empty");
    if (input.data.byteLength > maxBytes) {
      throw new UploadError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413, "too_large");
    }
    const name = cleanFileName(input.filename);
    const type = detectType(input.data, name);
    if (!type) throw new UploadError(refusalFor(input.data, name), 415, "unsupported_type");
    const id = this.createId();
    const folder = this.folderFor(id);
    await mkdir(folder, { recursive: true });
    try {
      await writeFile(join(folder, "file"), input.data, { mode: 0o600 });
      let text = "";
      let summary: string = type.kind;
      let pages: number | undefined;
      let parts: FileParts | undefined;
      let extractError: string | undefined;
      try {
        const extraction = await extractText(type.kind, input.data, name);
        text = extraction.text;
        summary = extraction.summary;
        pages = extraction.pages;
        parts = extraction.parts;
      } catch (error) {
        extractError = (error as Error).message;
        summary = `${type.label}, text could not be read`;
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
        ...(parts ? { parts } : {}),
        chars: text.length,
        textPath: "extracted.txt",
        ...(extractError ? { extractError } : {})
      };
      const createdAt = this.now();
      const record: ArtifactRecord = {
        id,
        ownerId: this.options.ownerId,
        workspaceId: input.workspaceId || DEFAULT_WORKSPACE_ID,
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

  /** The upload's record, or undefined when unknown / not the owner's / in another workspace / not a file. */
  async get(id: string, scope: UploadScope = {}): Promise<UploadView | undefined> {
    if (!isUploadId(id)) return undefined;
    const record = await this.options.store.artifacts.get(scope.ownerId ?? this.options.ownerId, id);
    if (!record || record.kind !== "file" || !isUploadMeta(record.meta)) return undefined;
    if (scope.workspaceId && !inWorkspace(record, scope.workspaceId)) return undefined;
    return toView(record);
  }

  async readBytes(id: string): Promise<Buffer> {
    return readFile(join(this.folderFor(id), "file"));
  }

  /**
   * Text a model read from the file (knowledge OCR of images and scanned PDFs),
   * kept next to the file so re-indexing doesn't pay again.
   */
  async readModelText(id: string): Promise<ModelText | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.folderFor(id), "model-text.json"), "utf8")) as ModelText;
      return typeof parsed.text === "string" && typeof parsed.model === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async writeModelText(id: string, value: ModelText): Promise<void> {
    await writeFile(join(this.folderFor(id), "model-text.json"), JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  }

  async readText(id: string): Promise<string> {
    try {
      return await readFile(join(this.folderFor(id), "extracted.txt"), "utf8");
    } catch {
      return "";
    }
  }

  /** Delete an upload: its files and its record (data retention). False when it isn't an upload of this owner. */
  async remove(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await rm(this.folderFor(id), { recursive: true, force: true });
    await this.options.store.artifacts.remove(this.options.ownerId, id);
    this.options.log?.("uploads.removed", { id });
    return true;
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
    ...(meta.parts ? { parts: meta.parts } : {}),
    chars: meta.chars ?? 0,
    createdAt: record.createdAt
  };
}
