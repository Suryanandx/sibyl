/**
 * Knowledge bases: per-workspace sets of documents (uploads, web pages,
 * pasted text) split into labelled chunks and searched with SQLite FTS5
 * (plus embeddings when SIBYL_EMBEDDINGS_MODEL is set).
 *
 * Adding a document returns at once with status "pending"; a small in-process
 * queue extracts, chunks and indexes it in the background ("indexing" →
 * "ready" | "failed"). Documents left pending by a restart are re-queued.
 *
 * Files go through the one upload pipeline (uploads/extract.ts). Images and
 * scanned PDFs are read by a vision / OCR model (ocr.ts, metered, cached next
 * to the upload). A ZIP becomes one document per supported file inside.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  type KnowledgeBaseRecord,
  type KnowledgeChunk,
  type KnowledgeDocRecord,
  type Store,
  type UsageMeter
} from "@open-gpt-live/core";
import type {
  FileKind,
  KnowledgeAddDocsResponse,
  KnowledgeBaseView,
  KnowledgeDocInput,
  KnowledgeDocView,
  KnowledgeHitView,
  KnowledgeSearchResponse
} from "@open-gpt-live/protocol";
import { createReadWebpageTool, type ReadWebpageDeps } from "../tools/builtin/read-webpage.js";
import { readArchive, type ArchiveLimits } from "../uploads/archive.js";
import { looksScanned } from "../uploads/extract.js";
import { UploadError, type UploadService, type UploadView } from "../uploads/service.js";
import { chunkText } from "./chunk.js";
import { cosine, type EmbeddingsClient } from "./embeddings.js";
import { OcrError, type OcrClient, type OcrResult } from "./ocr.js";

export const MAX_BASES_PER_WORKSPACE = 100;
export const MAX_DOCS_PER_BASE = 1000;
/** Bases larger than this use keyword search only (embedding scan stays cheap). */
export const MAX_EMBEDDING_SCAN_CHUNKS = 20_000;
const AUTO_KV_PREFIX = "knowledge.auto.";
const PROMPT_BLOCK_CHARS = 1_800;
const PROMPT_HITS = 4;
const SNIPPET_CHARS = 600;

type Log = (event: string, fields?: Record<string, unknown>) => void;

export class KnowledgeError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export interface KnowledgeServiceOptions {
  store: Store;
  ownerId: string;
  meter: UsageMeter;
  uploads?: UploadService;
  embeddings?: EmbeddingsClient;
  /** Vision / OCR model for images and scanned PDFs (absent: they fail with a clear reason). */
  ocr?: OcrClient;
  /** read_webpage test seams (fetch, resolveHost). */
  web?: ReadWebpageDeps;
  log?: Log;
  now?: () => number;
  createId?: (prefix: string) => string;
}

interface Job {
  docId: string;
  /** Pasted text (only for kind "text"; not stored outside the chunks). */
  text?: string;
}

export class KnowledgeService {
  readonly embeddings?: EmbeddingsClient;
  readonly ocr?: OcrClient;
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly queue: Job[] = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly options: KnowledgeServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`);
    if (options.embeddings) this.embeddings = options.embeddings;
    if (options.ocr) this.ocr = options.ocr;
  }

  private get store(): Store {
    return this.options.store;
  }

  private get ownerId(): string {
    return this.options.ownerId;
  }

  /* ───────────── bases ───────────── */

  async listBases(workspaceId: string): Promise<KnowledgeBaseView[]> {
    const bases = await this.store.knowledge.listBases(this.ownerId, { workspaceId });
    const auto = new Set(await this.autoBaseIds(workspaceId));
    return Promise.all(bases.map((base) => this.baseView(base, auto)));
  }

  async getBase(workspaceId: string, id: string): Promise<{ base: KnowledgeBaseView; docs: KnowledgeDocView[] }> {
    const base = await this.requireBase(workspaceId, id);
    const docs = await this.store.knowledge.listDocs(this.ownerId, base.id);
    return { base: await this.baseView(base, new Set(await this.autoBaseIds(workspaceId)), docs), docs: docs.map(docView) };
  }

  async createBase(workspaceId: string, input: { name?: unknown; description?: unknown }): Promise<KnowledgeBaseView> {
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const existing = await this.store.knowledge.listBases(this.ownerId, { workspaceId });
    if (existing.length >= MAX_BASES_PER_WORKSPACE) throw new KnowledgeError(`A workspace can have at most ${MAX_BASES_PER_WORKSPACE} knowledge bases.`, 409, "limit");
    const now = this.now();
    const record: KnowledgeBaseRecord = {
      id: this.createId("kb"),
      ownerId: this.ownerId,
      workspaceId,
      name,
      ...(description ? { description } : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.store.knowledge.upsertBase(record);
    return this.baseView(record, new Set(), []);
  }

  async updateBase(workspaceId: string, id: string, input: { name?: unknown; description?: unknown }): Promise<KnowledgeBaseView> {
    const base = await this.requireBase(workspaceId, id);
    const next: KnowledgeBaseRecord = { ...base, updatedAt: this.now() };
    if (input.name !== undefined) next.name = cleanName(input.name);
    if (input.description !== undefined) {
      const description = cleanDescription(input.description);
      if (description) next.description = description;
      else delete next.description;
    }
    await this.store.knowledge.upsertBase(next);
    return this.baseView(next, new Set(await this.autoBaseIds(workspaceId)));
  }

  async removeBase(workspaceId: string, id: string): Promise<void> {
    const base = await this.requireBase(workspaceId, id);
    await this.store.knowledge.removeBase(this.ownerId, base.id);
    const auto = await this.autoBaseIds(workspaceId);
    if (auto.includes(base.id)) await this.setAutoBaseIds(workspaceId, auto.filter((other) => other !== base.id));
  }

  /* ───────────── automatic search setting ───────────── */

  /** Bases searched automatically in this workspace (WorkspaceRecord.knowledgeBaseIds, else kv). */
  async autoBaseIds(workspaceId: string): Promise<string[]> {
    const workspace = await this.store.workspaces.get(this.ownerId, workspaceId);
    if (workspace) return workspace.knowledgeBaseIds ?? [];
    const stored = await this.store.kv.get<string[]>(this.ownerId, AUTO_KV_PREFIX + workspaceId);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  }

  async setAutoBaseIds(workspaceId: string, ids: unknown): Promise<string[]> {
    if (!Array.isArray(ids) || ids.length > 20 || !ids.every((id) => typeof id === "string")) {
      throw new KnowledgeError("autoBaseIds must be a list of at most 20 knowledge base ids.", 400, "invalid");
    }
    const bases = new Set((await this.store.knowledge.listBases(this.ownerId, { workspaceId })).map((base) => base.id));
    const unknown = ids.find((id) => !bases.has(id));
    if (unknown) throw new KnowledgeError(`Unknown knowledge base: ${unknown}`, 400, "unknown_base");
    const clean = [...new Set(ids as string[])];
    const workspace = await this.store.workspaces.get(this.ownerId, workspaceId);
    if (workspace) {
      await this.store.workspaces.upsert({ ...workspace, knowledgeBaseIds: clean, updatedAt: this.now() });
    } else {
      // The default workspace may have no record yet (single-owner installs).
      await this.store.kv.set(this.ownerId, AUTO_KV_PREFIX + workspaceId, clean);
    }
    return clean;
  }

  /* ───────────── documents ───────────── */

  async addDoc(workspaceId: string, knowledgeBaseId: string, input: KnowledgeDocInput): Promise<KnowledgeDocView> {
    const base = await this.requireBase(workspaceId, knowledgeBaseId);
    const docs = await this.store.knowledge.listDocs(this.ownerId, base.id);
    if (docs.length >= MAX_DOCS_PER_BASE) throw new KnowledgeError(`A knowledge base can hold at most ${MAX_DOCS_PER_BASE} documents.`, 409, "limit");
    const now = this.now();
    let record: KnowledgeDocRecord;
    const common = { id: this.createId("kd"), ownerId: this.ownerId, knowledgeBaseId: base.id, status: "pending" as const, chunkCount: 0, createdAt: now, updatedAt: now };
    if (input.kind === "upload") {
      const uploads = this.requireUploads();
      // Only files uploaded in this workspace can be saved into its knowledge.
      const upload = await uploads.get(input.uploadId, { ownerId: this.ownerId, workspaceId });
      if (!upload) throw new KnowledgeError("That file was not found.", 404, "upload_not_found");
      if (upload.kind === "zip") throw new KnowledgeError("A ZIP adds one document per file inside; use addDocs.", 400, "archive");
      if (upload.kind === "video" || upload.kind === "audio") throw new KnowledgeError("Video and audio files can't be added to knowledge (there is no text to index).", 415, "unsupported_type");
      if (upload.kind === "image" && !this.ocr) {
        throw new KnowledgeError("Images are read by a vision model, and none is set up on this gateway (SIBYL_KNOWLEDGE_OCR is off).", 415, "unsupported_type");
      }
      record = { ...common, ...uploadDocFields(upload), title: input.title ?? upload.name };
    } else if (input.kind === "url") {
      record = { ...common, title: input.title ?? safeUrlTitle(input.url), source: { kind: "url", url: input.url } };
    } else {
      record = { ...common, title: input.title, source: { kind: "text" }, mime: "text/plain" };
    }
    await this.store.knowledge.upsertDoc(record);
    await this.touchBase(base);
    this.enqueue({ docId: record.id, ...(input.kind === "text" ? { text: input.text } : {}) });
    return docView(record);
  }

  /**
   * Add a document; a ZIP upload instead adds one document per supported file
   * inside (each saved as its own upload, so chat and knowledge share it) and
   * lists the files it skipped.
   */
  async addDocs(workspaceId: string, knowledgeBaseId: string, input: KnowledgeDocInput): Promise<KnowledgeAddDocsResponse> {
    if (input.kind === "upload") {
      const uploads = this.requireUploads();
      const upload = await uploads.get(input.uploadId, { ownerId: this.ownerId, workspaceId });
      if (upload?.kind === "zip") return this.addArchive(workspaceId, knowledgeBaseId, upload);
    }
    const doc = await this.addDoc(workspaceId, knowledgeBaseId, input);
    return { doc, docs: [doc], skipped: [] };
  }

  private async addArchive(workspaceId: string, knowledgeBaseId: string, upload: UploadView): Promise<KnowledgeAddDocsResponse> {
    const uploads = this.requireUploads();
    const base = await this.requireBase(workspaceId, knowledgeBaseId);
    const room = MAX_DOCS_PER_BASE - (await this.store.knowledge.listDocs(this.ownerId, base.id)).length;
    if (room <= 0) throw new KnowledgeError(`A knowledge base can hold at most ${MAX_DOCS_PER_BASE} documents.`, 409, "limit");
    let contents: ReturnType<typeof readArchive>;
    try {
      contents = readArchive(await uploads.readBytes(upload.id), archiveLimits(uploads.maxBytes, room));
    } catch (error) {
      throw new KnowledgeError(`The ZIP could not be opened: ${(error as Error).message}`, 422, "bad_archive");
    }
    const docs: KnowledgeDocView[] = [];
    const skipped = [...contents.skipped];
    for (const file of contents.files) {
      if (file.type.kind === "video" || file.type.kind === "audio") {
        skipped.push({ name: file.path, reason: "video and audio have no text to index" });
        continue;
      }
      if (file.type.kind === "image" && !this.ocr) {
        skipped.push({ name: file.path, reason: "images need a vision model, and none is set up" });
        continue;
      }
      let saved: UploadView;
      try {
        saved = await uploads.save({ data: file.data, filename: file.name, workspaceId });
      } catch (error) {
        if (!(error instanceof UploadError)) throw error;
        skipped.push({ name: file.path, reason: error.message });
        continue;
      }
      const now = this.now();
      const record: KnowledgeDocRecord = {
        id: this.createId("kd"),
        ownerId: this.ownerId,
        knowledgeBaseId: base.id,
        status: "pending",
        chunkCount: 0,
        createdAt: now,
        updatedAt: now,
        ...uploadDocFields(saved),
        title: file.path.slice(0, 200)
      };
      await this.store.knowledge.upsertDoc(record);
      this.enqueue({ docId: record.id });
      docs.push(docView(record));
    }
    await this.touchBase(base);
    if (docs.length === 0) {
      const reasons = skipped.slice(0, 5).map((item) => `${item.name}: ${item.reason}`).join("; ");
      throw new KnowledgeError(`Nothing in the ZIP could be added${reasons ? ` (${reasons})` : ""}.`, 422, "empty_archive");
    }
    return { doc: docs[0]!, docs, skipped };
  }

  async removeDoc(workspaceId: string, knowledgeBaseId: string, docId: string): Promise<void> {
    const base = await this.requireBase(workspaceId, knowledgeBaseId);
    const doc = await this.store.knowledge.getDoc(this.ownerId, docId);
    if (!doc || doc.knowledgeBaseId !== base.id) throw new KnowledgeError("That document was not found.", 404, "not_found");
    await this.store.knowledge.removeDoc(this.ownerId, doc.id);
    await this.touchBase(base);
  }

  /** Re-index an upload or web page (pasted text is indexed once). */
  async reindexDoc(workspaceId: string, knowledgeBaseId: string, docId: string): Promise<KnowledgeDocView> {
    const base = await this.requireBase(workspaceId, knowledgeBaseId);
    const doc = await this.store.knowledge.getDoc(this.ownerId, docId);
    if (!doc || doc.knowledgeBaseId !== base.id) throw new KnowledgeError("That document was not found.", 404, "not_found");
    if (doc.source.kind === "text") throw new KnowledgeError("Pasted text can't be re-indexed; add it again instead.", 409, "not_reindexable");
    const next: KnowledgeDocRecord = { ...doc, status: "pending", updatedAt: this.now() };
    delete next.error;
    await this.store.knowledge.upsertDoc(next);
    this.enqueue({ docId: doc.id });
    return docView(next);
  }

  /** "Save to knowledge" for a chat attachment: into the given base, else the workspace's "Saved files". */
  async saveUpload(workspaceId: string, uploadId: string, knowledgeBaseId?: string): Promise<{ base: KnowledgeBaseView; doc: KnowledgeDocView }> {
    let baseId = knowledgeBaseId;
    if (!baseId) {
      const bases = await this.store.knowledge.listBases(this.ownerId, { workspaceId });
      baseId = bases.find((base) => base.name === "Saved files")?.id ?? (await this.createBase(workspaceId, { name: "Saved files", description: "Files saved from chats." })).id;
    }
    const { doc } = await this.addDocs(workspaceId, baseId, { kind: "upload", uploadId });
    const base = await this.requireBase(workspaceId, baseId);
    return { base: await this.baseView(base, new Set(await this.autoBaseIds(workspaceId))), doc };
  }

  /* ───────────── search ───────────── */

  /**
   * Keyword search (FTS5) across the workspace's bases (or the given ones),
   * re-ranked with embeddings when configured: score = 0.5·keyword + 0.5·cosine.
   */
  async search(workspaceId: string, query: string, options: { baseIds?: string[]; limit?: number; embeddings?: boolean; signal?: AbortSignal } = {}): Promise<KnowledgeSearchResponse> {
    const limit = Math.min(Math.max(options.limit ?? 6, 1), 20);
    const trimmed = query.trim().slice(0, 500);
    const bases = await this.store.knowledge.listBases(this.ownerId, { workspaceId });
    const byId = new Map(bases.map((base) => [base.id, base]));
    const ids = options.baseIds?.length ? options.baseIds.filter((id) => byId.has(id)) : bases.map((base) => base.id);
    if (!trimmed || ids.length === 0) return { query: trimmed, hits: [], mode: "keyword" };

    const keyword = await this.store.knowledge.search(this.ownerId, ids, trimmed, Math.max(limit * 4, 20));
    let ranked: Array<{ chunk: KnowledgeChunk; score: number }> = keyword;
    let mode: KnowledgeSearchResponse["mode"] = "keyword";
    if (this.embeddings && options.embeddings !== false) {
      try {
        const hybrid = await this.hybrid(ids, trimmed, keyword, options.signal);
        if (hybrid) {
          ranked = hybrid;
          mode = "hybrid";
        }
      } catch (error) {
        this.options.log?.("knowledge.embeddings_search_failed", { error: (error as Error).message });
      }
    }
    const docs = new Map<string, KnowledgeDocRecord | undefined>();
    const hits: KnowledgeHitView[] = [];
    for (const hit of ranked.slice(0, limit)) {
      if (!docs.has(hit.chunk.docId)) docs.set(hit.chunk.docId, await this.store.knowledge.getDoc(this.ownerId, hit.chunk.docId));
      const doc = docs.get(hit.chunk.docId);
      const base = byId.get(hit.chunk.knowledgeBaseId);
      if (!doc || !base) continue;
      hits.push({
        knowledgeBaseId: base.id,
        baseName: base.name,
        docId: doc.id,
        docTitle: doc.title,
        ...(hit.chunk.label ? { label: hit.chunk.label } : {}),
        citation: hit.chunk.label ? `${doc.title} › ${hit.chunk.label}` : doc.title,
        snippet: snippet(hit.chunk.text, trimmed),
        score: Math.round(hit.score * 1000) / 1000,
        ...(doc.source.kind === "url" ? { url: doc.source.url } : {})
      });
    }
    return { query: trimmed, hits, mode };
  }

  private async hybrid(
    ids: string[],
    query: string,
    keyword: Array<{ chunk: KnowledgeChunk; score: number }>,
    signal?: AbortSignal
  ): Promise<Array<{ chunk: KnowledgeChunk; score: number }> | undefined> {
    const chunks = await this.store.knowledge.chunks(this.ownerId, ids);
    const embedded = chunks.filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0);
    if (embedded.length === 0 || embedded.length > MAX_EMBEDDING_SCAN_CHUNKS) return undefined;
    const [vector] = await this.embeddings!.embed([query], signal);
    if (!vector) return undefined;
    const maxKeyword = Math.max(...keyword.map((hit) => hit.score), 0);
    const scores = new Map<string, { chunk: KnowledgeChunk; keyword: number; semantic: number }>();
    for (const hit of keyword) scores.set(hit.chunk.id, { chunk: hit.chunk, keyword: maxKeyword > 0 ? hit.score / maxKeyword : 0, semantic: 0 });
    for (const chunk of embedded) {
      const similarity = cosine(vector, chunk.embedding!);
      const entry = scores.get(chunk.id);
      if (entry) entry.semantic = similarity;
      else if (similarity > 0.2) scores.set(chunk.id, { chunk, keyword: 0, semantic: similarity });
    }
    return [...scores.values()]
      .map((entry) => ({ chunk: stripEmbedding(entry.chunk), score: 0.5 * entry.keyword + 0.5 * Math.max(0, entry.semantic) }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * "Relevant knowledge" for the system prompt: cheap keyword search over the
   * workspace's automatic bases, at most 4 snippets and ~1.8k characters.
   * `within` limits it further (an agent's own knowledge bases).
   */
  async promptBlock(workspaceId: string, query: string, within?: readonly string[]): Promise<string> {
    const text = query.trim();
    if (text.length < 3) return "";
    const ids = (await this.autoBaseIds(workspaceId)).filter((id) => !within || within.includes(id));
    if (ids.length === 0) return "";
    const result = await this.search(workspaceId, text, { baseIds: ids, limit: PROMPT_HITS, embeddings: false });
    if (result.hits.length === 0) return "";
    let block = "\n\n## Relevant knowledge\nExcerpts from this workspace's knowledge bases that may help (cite as [title › section]; use search_knowledge for more):\n";
    for (const hit of result.hits) {
      const entry = `- [${hit.citation}] ${hit.snippet.replace(/\s+/g, " ").slice(0, 400)}\n`;
      if (block.length + entry.length > PROMPT_BLOCK_CHARS) break;
      block += entry;
    }
    return block;
  }

  /* ───────────── background indexing ───────────── */

  /** Re-queue documents left pending/indexing by a restart (pasted text can't be recovered). */
  async resume(): Promise<number> {
    let queued = 0;
    for (const base of await this.store.knowledge.listBases(this.ownerId)) {
      for (const doc of await this.store.knowledge.listDocs(this.ownerId, base.id)) {
        if (doc.status !== "pending" && doc.status !== "indexing") continue;
        if (doc.source.kind === "text") {
          await this.store.knowledge.upsertDoc({ ...doc, status: "failed", error: "Indexing was interrupted by a restart. Add the text again.", updatedAt: this.now() });
          continue;
        }
        this.enqueue({ docId: doc.id });
        queued += 1;
      }
    }
    return queued;
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  private enqueue(job: Job): void {
    if (this.closed) return;
    this.queue.push(job);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const job = this.queue.shift()!;
        await this.index(job).catch((error: unknown) => {
          this.options.log?.("knowledge.index_crashed", { docId: job.docId, error: (error as Error).message });
        });
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async index(job: Job): Promise<void> {
    const doc = await this.store.knowledge.getDoc(this.ownerId, job.docId);
    if (!doc) return;
    await this.store.knowledge.upsertDoc({ ...doc, status: "indexing", updatedAt: this.now() });
    const startedAt = this.now();
    try {
      const { text, title, ocr } = await this.extract(doc, job);
      if (!text.trim()) throw new KnowledgeError("No readable text was found.", 422, "empty");
      const pieces = chunkText(text);
      let vectors: number[][] | undefined;
      if (this.embeddings) {
        try {
          vectors = await this.embeddings.embed(pieces.map((piece) => (piece.label ? `${piece.label}\n${piece.text}` : piece.text)));
        } catch (error) {
          // Keyword search still works; note it in the log only.
          this.options.log?.("knowledge.embeddings_failed", { docId: doc.id, error: (error as Error).message });
        }
      }
      const chunks: KnowledgeChunk[] = pieces.map((piece, ordinal) => ({
        id: `${doc.id}_${ordinal}`,
        ownerId: this.ownerId,
        knowledgeBaseId: doc.knowledgeBaseId,
        docId: doc.id,
        ordinal,
        text: piece.text,
        ...(piece.label ? { label: piece.label } : {}),
        ...(vectors?.[ordinal] ? { embedding: vectors[ordinal] } : {})
      }));
      // The document may have been deleted while it was indexing.
      const current = await this.store.knowledge.getDoc(this.ownerId, doc.id);
      if (!current) return;
      await this.store.knowledge.replaceChunks(this.ownerId, doc.id, chunks);
      const ready: KnowledgeDocRecord = { ...current, status: "ready", chunkCount: chunks.length, size: text.length, updatedAt: this.now() };
      if (ocr) ready.ocr = { model: ocr.model, ...(ocr.engine ? { engine: ocr.engine } : {}), costUsd: ocr.costUsd, estimated: ocr.estimated };
      else delete ready.ocr;
      if (title && current.source.kind === "url" && current.title === safeUrlTitle(current.source.url)) ready.title = title.slice(0, 200);
      delete ready.error;
      await this.store.knowledge.upsertDoc(ready);
      this.options.log?.("knowledge.indexed", { docId: doc.id, chunks: chunks.length, chars: text.length, ms: this.now() - startedAt, embedded: Boolean(vectors) });
    } catch (error) {
      const message = error instanceof KnowledgeError ? error.message : `Indexing failed: ${(error as Error).message}`;
      const current = await this.store.knowledge.getDoc(this.ownerId, doc.id);
      if (current) await this.store.knowledge.upsertDoc({ ...current, status: "failed", error: message.slice(0, 300), updatedAt: this.now() });
      this.options.log?.("knowledge.index_failed", { docId: doc.id, error: message });
    }
  }

  private async extract(doc: KnowledgeDocRecord, job: Job): Promise<{ text: string; title?: string; ocr?: OcrResult }> {
    const source = doc.source;
    if (source.kind === "text") {
      if (job.text === undefined) throw new KnowledgeError("The pasted text is no longer available. Add it again.", 409, "gone");
      return { text: job.text };
    }
    if (source.kind === "upload") {
      const uploads = this.requireUploads();
      const upload = await uploads.get(source.uploadId);
      if (!upload) throw new KnowledgeError("The uploaded file no longer exists.", 404, "upload_not_found");
      if (upload.kind === "image") {
        const ocr = await this.readWithModel(upload);
        return { text: `# ${upload.name}\n\n${ocr.text}`, ocr };
      }
      const text = await uploads.readText(source.uploadId);
      if (upload.kind === "pdf" && looksScanned(text, upload.pages)) {
        const ocr = await this.readWithModel(upload);
        return { text: ocr.text, ocr };
      }
      return { text };
    }
    // Same fetcher, SSRF guard and limits as the read_webpage tool.
    const tool = createReadWebpageTool(this.options.web ?? {});
    const controller = new AbortController();
    const result = await tool.run(
      { url: source.url },
      { signal: controller.signal, ownerId: this.ownerId, runId: `knowledge:${doc.id}`, store: this.store, meter: this.options.meter, log: () => undefined }
    );
    if (result.isError || !result.data) throw new KnowledgeError(result.content.slice(0, 300), 422, "fetch_failed");
    return { text: result.data.text, ...(result.data.title ? { title: result.data.title } : {}) };
  }

  /** Text of an image or scanned PDF from the vision / OCR model, cached next to the upload. */
  private async readWithModel(upload: UploadView): Promise<OcrResult> {
    const uploads = this.requireUploads();
    const cached = await uploads.readModelText(upload.id);
    if (cached) return { text: cached.text, model: cached.model, ...(cached.engine ? { engine: cached.engine } : {}), costUsd: cached.costUsd, estimated: cached.estimated };
    if (!this.ocr) {
      throw new KnowledgeError(
        upload.kind === "image" ? "Images are read by a vision model, and none is set up on this gateway." : "This PDF has no text layer (a scan), and no OCR model is set up on this gateway.",
        422,
        "ocr_unavailable"
      );
    }
    let result: OcrResult;
    try {
      const bytes = await uploads.readBytes(upload.id);
      result = upload.kind === "image" ? await this.ocr.readImage(bytes, upload.mime) : await this.ocr.readPdf(bytes, upload.name, upload.pages);
    } catch (error) {
      if (error instanceof OcrError) {
        const what = upload.kind === "image" ? "the image" : "the scanned PDF";
        throw new KnowledgeError(error.code === "budget" ? `Budget reached, so ${what} was not read. ${error.message}` : error.message, 422, `ocr_${error.code}`);
      }
      throw error;
    }
    await uploads.writeModelText(upload.id, { ...result, createdAt: this.now() });
    this.options.log?.("knowledge.ocr", { uploadId: upload.id, kind: upload.kind, model: result.model, engine: result.engine ?? null, costUsd: result.costUsd, chars: result.text.length });
    return result;
  }

  /* ───────────── helpers ───────────── */

  private requireUploads(): UploadService {
    if (!this.options.uploads) throw new KnowledgeError("File uploads are not available on this gateway.", 503, "uploads_unavailable");
    return this.options.uploads;
  }

  private async requireBase(workspaceId: string, id: string): Promise<KnowledgeBaseRecord> {
    const base = await this.store.knowledge.getBase(this.ownerId, id);
    if (!base || (base.workspaceId || DEFAULT_WORKSPACE_ID) !== workspaceId) throw new KnowledgeError("That knowledge base was not found.", 404, "not_found");
    return base;
  }

  private async touchBase(base: KnowledgeBaseRecord): Promise<void> {
    await this.store.knowledge.upsertBase({ ...base, updatedAt: this.now() });
  }

  private async baseView(base: KnowledgeBaseRecord, auto: Set<string>, docs?: KnowledgeDocRecord[]): Promise<KnowledgeBaseView> {
    const list = docs ?? (await this.store.knowledge.listDocs(this.ownerId, base.id));
    return {
      id: base.id,
      workspaceId: base.workspaceId,
      name: base.name,
      ...(base.description ? { description: base.description } : {}),
      docCount: list.length,
      indexing: list.filter((doc) => doc.status === "pending" || doc.status === "indexing").length,
      auto: auto.has(base.id),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt
    };
  }
}

export function docView(doc: KnowledgeDocRecord): KnowledgeDocView {
  return {
    id: doc.id,
    knowledgeBaseId: doc.knowledgeBaseId,
    title: doc.title,
    source: doc.source,
    ...(doc.mime ? { mime: doc.mime } : {}),
    status: doc.status,
    ...(doc.error ? { error: doc.error } : {}),
    chunkCount: doc.chunkCount,
    ...(doc.size !== undefined ? { size: doc.size } : {}),
    ...(doc.fileKind ? { fileKind: doc.fileKind as FileKind } : {}),
    ...(doc.parts ? { parts: doc.parts } : {}),
    ...(doc.ocr ? { ocr: doc.ocr } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

/** Files taken from one ZIP. */
const ARCHIVE_MAX_FILES = 200;

/** Each file within the upload limit; the whole archive at most 10× that (and at least 200 MB); room left in the base. */
function archiveLimits(maxEntryBytes: number, room: number): ArchiveLimits {
  return { maxEntryBytes, maxTotalBytes: Math.max(200 * 1024 * 1024, maxEntryBytes * 10), maxFiles: Math.min(ARCHIVE_MAX_FILES, room) };
}

/** Document fields that come from its upload. */
function uploadDocFields(upload: UploadView): Pick<KnowledgeDocRecord, "title" | "source" | "mime" | "fileKind" | "parts"> {
  return {
    title: upload.name,
    source: { kind: "upload", uploadId: upload.id, fileName: upload.name },
    mime: upload.mime,
    fileKind: upload.kind,
    ...(upload.parts ? { parts: upload.parts } : {})
  };
}

function cleanName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new KnowledgeError("Give the knowledge base a name.", 400, "invalid_name");
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length > 80) throw new KnowledgeError("The name is longer than 80 characters.", 400, "invalid_name");
  return name;
}

function cleanDescription(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new KnowledgeError("The description must be text.", 400, "invalid_description");
  const description = value.trim();
  if (description.length > 500) throw new KnowledgeError("The description is longer than 500 characters.", 400, "invalid_description");
  return description || undefined;
}

function safeUrlTitle(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

function stripEmbedding(chunk: KnowledgeChunk): KnowledgeChunk {
  const { embedding: _embedding, ...rest } = chunk;
  return rest;
}

/** The part of the chunk around the first query term, at most ~600 characters. */
export function snippet(text: string, query: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= SNIPPET_CHARS) return clean;
  const lower = clean.toLowerCase();
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 2);
  const at = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - 120, clean.length - SNIPPET_CHARS));
  const body = clean.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${body}${start + SNIPPET_CHARS < clean.length ? "…" : ""}`;
}
