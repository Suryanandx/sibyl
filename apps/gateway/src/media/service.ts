/**
 * Media service: images, video and audio from OpenRouter, one way for every
 * caller (chat tools, the composer's Create mode, the Media page, agents).
 *
 *  - Every request is priced first (estimate.ts) and checked against the
 *    budgets (organization, workspace, agent) BEFORE anything is sent.
 *  - Results are saved as uploads, so a generated image is a file like any
 *    attachment: it can be referenced, saved to knowledge, put in slides.
 *  - Each request is an ArtifactRecord (kind "media") in its workspace, so
 *    the Media gallery, chat cards and resumable video jobs read one record.
 *  - Video is a job: submit, poll, download. Jobs still running when the
 *    gateway stops are picked up again on start (resume()).
 *  - Usage is metered as feature "media" with OpenRouter's reported cost
 *    (an estimate only when the provider reports none).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, inWorkspace, type ArtifactRecord, type BudgetDecision, type Store, type UsageMeter } from "@open-gpt-live/core";
import type {
  MediaCreateRequest,
  MediaCollectionView,
  MediaItemPatch,
  MediaItemView,
  MediaKind,
  MediaModelsResponse,
  MediaOutputView,
  MediaReferenceInput,
  MediaStatus
} from "@open-gpt-live/protocol";
import { MAX_MEDIA_PROMPT_CHARS } from "@open-gpt-live/protocol";
import { idPattern, newId } from "../http/ids.js";
import type { UploadService, UploadView } from "../uploads/index.js";
import type { MediaCatalog, MediaModelEntry } from "./catalog.js";
import { MediaProviderError, type MediaClient } from "./client.js";
import { estimateAudio, estimateImage, estimateVideo, durationOf, type Estimate } from "./estimate.js";
import { providerPrompt, refMediaType, referenceProblem, type ResolvedRef } from "./references.js";

export const DEFAULT_APPROVE_ABOVE_USD = 0.25;
/** Generated files may be larger than the upload limit for people (a 1080p clip). */
const GENERATED_MAX_BYTES = 250 * 1024 * 1024;
const POLL_MS = 8_000;
const JOB_TIMEOUT_MS = 40 * 60_000;
const REF_LINK_TTL_MS = 2 * 60 * 60_000;
const MEDIA_ID = idPattern("md");

export class MediaError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "MediaError";
  }
}

/** Whose media: the organization and one workspace. */
export interface MediaScope {
  ownerId: string;
  workspaceId?: string;
  /** Who is looking (their favourites). */
  viewer?: string;
}

export interface CreateMediaInput extends MediaCreateRequest {
  workspaceId?: string;
  /** Who asked (user id, or "token"/"local"). */
  userId?: string;
  role?: string;
  /** Audio without a named model: voice-over (default) or music. */
  audioType?: "speech" | "music";
  agentId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

interface StoredRef {
  uploadId: string;
  role: "reference" | "first_frame" | "last_frame";
  mediaType: "image" | "video" | "audio";
  token?: string;
  name?: string;
  mime?: string;
}

export interface MediaMeta {
  kind: MediaKind;
  status: MediaStatus;
  model: string;
  modelName?: string;
  prompt: string;
  providerPrompt?: string;
  settings: Record<string, string | number | boolean>;
  references: StoredRef[];
  outputs: MediaOutputView[];
  estimateUsd: number;
  estimateDetail?: string;
  /** The estimate before calibration (what the listing alone says). */
  rawEstimateUsd?: number;
  costUsd?: number;
  costEstimated?: boolean;
  error?: string;
  providerJobId?: string;
  expectedMs?: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  createdBy?: string;
  agentId?: string;
  requestId?: string;
  /** Spend recorded on the meter (exactly once). */
  metered?: boolean;
  /** People who marked it as a favourite. */
  favoritedBy?: string[];
  /** Library collections (ids) it is in. */
  collections?: string[];
}

export interface MediaServiceOptions {
  store: Store;
  ownerId: string;
  meter: UsageMeter;
  uploads: UploadService;
  catalog: MediaCatalog;
  client: MediaClient;
  approveAboveUsd?: number;
  /** Public HTTPS address of the gateway: reference videos and audio are fetched by the provider from here. */
  publicUrl?: string;
  now?: () => number;
  createId?: () => string;
  pollMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface MediaListFilter {
  kind?: MediaKind;
  model?: string;
  createdBy?: string;
  conversationId?: string;
  query?: string;
  limit?: number;
  collectionId?: string;
  favorites?: boolean;
}

export class MediaService {
  readonly approveAboveUsd: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly pollMs: number;
  private readonly polling = new Map<string, AbortController>();
  /** Charged ÷ listed estimate, per model, from finished requests (only ever raises estimates). */
  private readonly ratios = new Map<string, number>();
  /** Signs reference links for the provider (per process: links live for two hours). */
  private readonly refSecret = randomBytes(32);
  private readonly listeners = new Set<(item: MediaItemView, workspaceId: string) => void>();

  constructor(private readonly options: MediaServiceOptions) {
    this.approveAboveUsd = options.approveAboveUsd ?? DEFAULT_APPROVE_ABOVE_USD;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => newId("md"));
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  get catalog(): MediaCatalog {
    return this.options.catalog;
  }

  /** Called on every change of an item (status, progress, outputs). */
  onUpdate(listener: (item: MediaItemView, workspaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async models(): Promise<MediaModelsResponse> {
    const models = await this.options.catalog.views();
    const defaults = this.options.catalog.defaults();
    return { models, defaults: { ...(defaults.image ? { image: defaults.image } : {}), ...(defaults.video ? { video: defaults.video } : {}), ...(defaults.audio ? { audio: defaults.audio } : {}) }, approveAboveUsd: this.approveAboveUsd, updatedAt: this.now() };
  }

  /** The model for a request: the one named (must be of that kind), else the default. */
  async resolveModel(kind: MediaKind, id?: string, audioType?: "speech" | "music"): Promise<MediaModelEntry> {
    const catalog = this.options.catalog;
    if (id) {
      const entry = await catalog.get(id);
      if (!entry) throw new MediaError(`There is no media model "${id}" on OpenRouter.`, 400, "unknown_model");
      if (entry.kind !== kind) throw new MediaError(`${entry.name} makes ${entry.kind}, not ${kind}.`, 400, "wrong_kind");
      return entry;
    }
    await catalog.models();
    const defaults = catalog.defaults();
    const fallback = kind === "audio" ? (audioType === "music" ? defaults.music : defaults.speech ?? defaults.audio) : defaults[kind];
    const entry = fallback ? await catalog.get(fallback) : undefined;
    if (!entry) throw new MediaError(`No ${kind} model is available on OpenRouter right now.`, 503, "no_model");
    return entry;
  }

  /** Price a request without sending it (the settings popover and approval cards). */
  async estimate(scope: MediaScope, input: Omit<MediaCreateRequest, "prompt"> & { prompt?: string }): Promise<Estimate & { model: string; needsApproval: boolean }> {
    const entry = await this.resolveModel(input.kind, input.model);
    const refs = await this.resolveRefs(scope, input.references ?? []);
    const settings = sanitizeSettings(entry, input.settings ?? {});
    const estimate = await this.price(entry, settings, refs, input.prompt ?? "");
    return { ...estimate, model: entry.id, needsApproval: estimate.usd > this.approveAboveUsd };
  }

  /**
   * Synchronous estimate for approval decisions (tool calls): from the loaded
   * catalogue, references counted as images. Undefined while the price is
   * unknown (catalogue not loaded, image price lines not fetched yet).
   */
  quickEstimate(input: Omit<MediaCreateRequest, "prompt"> & { prompt?: string; audioType?: "speech" | "music" }): number | undefined {
    const catalog = this.options.catalog;
    const defaults = catalog.defaults();
    const id = input.model ?? (input.kind === "audio" ? (input.audioType === "music" ? defaults.music : defaults.speech ?? defaults.audio) : defaults[input.kind]);
    const entry = id ? catalog.peek(id) : undefined;
    if (!entry || entry.kind !== input.kind) return undefined;
    const settings = sanitizeSettings(entry, input.settings ?? {});
    const refs = input.references ?? [];
    const counts = { images: refs.filter((r) => (r.role ?? "reference") === "reference").length, videos: 0, audio: 0, frames: refs.filter((r) => r.role && r.role !== "reference").length };
    const request = { settings, references: counts, prompt: input.prompt ?? "" };
    if (entry.kind === "video") return this.calibrated(entry.id, estimateVideo(entry, request)).usd;
    if (entry.kind === "audio") return this.calibrated(entry.id, estimateAudio(entry, request)).usd;
    if (entry.pricing.kind !== "image" || !entry.pricing.lines) {
      void catalog.imagePricing(entry);
      return undefined;
    }
    return this.calibrated(entry.id, estimateImage(entry, entry.pricing.lines, request)).usd;
  }

  /**
   * Listings don't say everything (Wan 2.7 billed a 2-second clip as 5 s:
   * $0.50, listed $0.10/s). When a model charged more than its listing
   * suggested, later estimates for it are raised by that ratio.
   */
  private calibrated(model: string, estimate: Estimate): Estimate & { rawUsd: number } {
    const ratio = this.ratios.get(model);
    if (!ratio || ratio <= 1.05) return { ...estimate, rawUsd: estimate.usd };
    return { usd: estimate.usd * ratio, rawUsd: estimate.usd, detail: `${estimate.detail} × ${ratio.toFixed(2)} (what OpenRouter charged before)` };
  }

  private observe(model: string, rawEstimate: number, charged: number): void {
    if (rawEstimate > 0 && charged >= 0) this.ratios.set(model, Math.min(10, Math.max(0.2, charged / rawEstimate)));
  }

  /** Calibration from the library (newest first: the first seen per model wins). */
  private learn(meta: MediaMeta): void {
    if (this.ratios.has(meta.model) || meta.status !== "done" || meta.costEstimated || meta.costUsd === undefined) return;
    this.observe(meta.model, meta.rawEstimateUsd ?? meta.estimateUsd, meta.costUsd);
  }

  private async price(entry: MediaModelEntry, settings: MediaMeta["settings"], refs: StoredRef[], prompt: string): Promise<Estimate & { rawUsd: number }> {
    const counts = {
      images: refs.filter((r) => r.role === "reference" && r.mediaType === "image").length,
      videos: refs.filter((r) => r.role === "reference" && r.mediaType === "video").length,
      audio: refs.filter((r) => r.role === "reference" && r.mediaType === "audio").length,
      frames: refs.filter((r) => r.role !== "reference").length
    };
    const input = { settings, references: counts, prompt };
    if (entry.kind === "video") return this.calibrated(entry.id, estimateVideo(entry, input));
    if (entry.kind === "image") return this.calibrated(entry.id, estimateImage(entry, await this.options.catalog.imagePricing(entry), input));
    return this.calibrated(entry.id, estimateAudio(entry, input));
  }

  private async resolveRefs(scope: MediaScope, refs: MediaReferenceInput[]): Promise<StoredRef[]> {
    const resolved: StoredRef[] = [];
    for (const ref of refs) {
      const upload = await this.options.uploads.get(ref.uploadId, { ownerId: scope.ownerId, workspaceId: scope.workspaceId || DEFAULT_WORKSPACE_ID });
      if (!upload) throw new MediaError("A referenced file was not found in this workspace.", 404, "reference_not_found");
      const mediaType = refMediaType(upload.kind, upload.mime);
      if (!mediaType) throw new MediaError(`${upload.name} can't be a reference: only images, video and audio can.`, 400, "bad_reference");
      if (resolved.some((r) => r.uploadId === upload.id && r.role === (ref.role ?? "reference"))) continue;
      resolved.push({ uploadId: upload.id, role: ref.role ?? "reference", mediaType, ...(ref.token ? { token: ref.token } : {}), name: upload.name, mime: upload.mime });
    }
    return resolved;
  }

  /** Throws MediaError (402) when the spend would break a budget. */
  private async checkBudget(input: CreateMediaInput, model: string, usd: number): Promise<void> {
    let agent: { id: string; name?: string; dailyUsd?: number; monthlyUsd?: number } | undefined;
    if (input.agentId) {
      const record = await this.options.store.agents.get(this.options.ownerId, input.agentId).catch(() => undefined);
      agent = {
        id: input.agentId,
        ...(record?.name ? { name: record.name } : {}),
        ...(record?.budget?.dailyUsd !== undefined ? { dailyUsd: record.budget.dailyUsd } : {}),
        ...(record?.budget?.monthlyUsd !== undefined ? { monthlyUsd: record.budget.monthlyUsd } : {})
      };
    }
    const decision: BudgetDecision = this.options.meter.check({
      ownerId: this.options.ownerId,
      estimateUsd: usd,
      feature: "media",
      model,
      workspaceId: input.workspaceId || DEFAULT_WORKSPACE_ID,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.role ? { role: input.role } : {}),
      ...(agent ? { agent } : {})
    });
    if (!decision.allowed) throw new MediaError(`Can't create this: ${decision.message}`, 402, "budget");
  }

  /**
   * Make media. Images and audio are finished when this returns; a video is
   * submitted and keeps rendering in the background (poll get() for progress).
   */
  async create(input: CreateMediaInput): Promise<MediaItemView> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new MediaError("Describe what to make.", 400, "empty_prompt");
    if (prompt.length > MAX_MEDIA_PROMPT_CHARS) throw new MediaError(`The prompt is longer than ${MAX_MEDIA_PROMPT_CHARS} characters.`, 400, "prompt_too_long");
    const scope = { ownerId: this.options.ownerId, workspaceId: input.workspaceId || DEFAULT_WORKSPACE_ID };
    const entry = await this.resolveModel(input.kind, input.model, input.audioType);
    const settings = sanitizeSettings(entry, input.settings ?? {});
    const refs = await this.resolveRefs(scope, input.references ?? []);
    const problem = referenceProblem(refs as ResolvedRef[], entry.references, entry.name);
    if (problem) throw new MediaError(problem, 400, "bad_reference");
    if (refs.some((r) => r.role !== "reference") && refs.some((r) => r.role === "reference")) {
      throw new MediaError("Use either a first/last frame or references, not both (OpenRouter then ignores the references).", 400, "bad_reference");
    }
    if (refs.some((r) => r.role === "reference" && r.mediaType !== "image") && !this.options.publicUrl) {
      throw new MediaError("Reference videos and audio are fetched by the model provider over HTTPS: set SIBYL_PUBLIC_GATEWAY_URL to the gateway's public address.", 400, "needs_public_url");
    }
    const estimate = await this.price(entry, settings, refs, prompt);
    await this.checkBudget(input, entry.id, estimate.usd);

    const at = this.now();
    const meta: MediaMeta = {
      kind: entry.kind,
      status: "queued",
      model: entry.id,
      modelName: entry.name,
      prompt,
      providerPrompt: providerPrompt(prompt, refs as ResolvedRef[], entry.references.syntax),
      settings,
      references: refs,
      outputs: [],
      estimateUsd: estimate.usd,
      estimateDetail: estimate.detail,
      rawEstimateUsd: estimate.rawUsd,
      updatedAt: at,
      ...(input.userId ? { createdBy: input.userId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {})
    };
    const record: ArtifactRecord = {
      id: this.createId(),
      ownerId: this.options.ownerId,
      workspaceId: scope.workspaceId,
      kind: "media",
      title: prompt.replace(/\s+/g, " ").slice(0, 120),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      version: 1,
      meta: meta as unknown as Record<string, unknown>,
      createdAt: at
    };
    await this.save(record, meta);
    this.options.log?.("media.created", { id: record.id, kind: entry.kind, model: entry.id, estimateUsd: estimate.usd });

    if (entry.kind === "video") {
      try {
        await this.submitVideo(record, meta, entry, input.signal);
      } catch (error) {
        await this.fail(record, meta, error);
      }
      return this.view(record, meta);
    }
    try {
      meta.status = "running";
      meta.startedAt = this.now();
      await this.save(record, meta);
      if (entry.kind === "image") await this.runImage(record, meta, input.signal);
      else await this.runAudio(record, meta, entry, input.signal);
    } catch (error) {
      await this.fail(record, meta, error);
    }
    return this.view(record, meta);
  }

  /* ───────────── images and audio ───────────── */

  private async runImage(record: ArtifactRecord, meta: MediaMeta, signal?: AbortSignal): Promise<void> {
    const body: Record<string, unknown> = { model: meta.model, prompt: meta.providerPrompt ?? meta.prompt };
    for (const key of ["aspect_ratio", "resolution", "quality", "background", "seed"] as const) if (meta.settings[key] !== undefined) body[key] = meta.settings[key];
    if (Number(meta.settings.n) > 1) body.n = Number(meta.settings.n);
    const refs = meta.references.filter((r) => r.mediaType === "image");
    if (refs.length) body.input_references = await Promise.all(refs.map(async (r) => ({ type: "image_url", image_url: { url: await this.dataUrl(r) } })));
    const result = await this.options.client.images(body, signal);
    const outputs: MediaOutputView[] = [];
    for (const [index, image] of result.images.entries()) outputs.push(await this.saveOutput(record, image.data, image.mime, index));
    this.complete(record, meta, outputs, result.costUsd, outputs.length);
    await this.save(record, meta);
  }

  private async runAudio(record: ArtifactRecord, meta: MediaMeta, entry: MediaModelEntry, signal?: AbortSignal): Promise<void> {
    if (entry.audioKind === "music") {
      const prompt = `${meta.providerPrompt ?? meta.prompt}${meta.settings.instrumental === false ? "" : "\n\nInstrumental only, no vocals."}`;
      const result = await this.options.client.music({ model: entry.id, prompt }, signal);
      const output = await this.saveOutput(record, result.data, result.mime, 0);
      this.complete(record, meta, [output], result.costUsd, 1);
      await this.save(record, meta);
      return;
    }
    const voice = typeof meta.settings.voice === "string" ? meta.settings.voice : undefined;
    const result = await this.options.client.speech({ model: entry.id, input: meta.prompt, ...(voice ? { voice } : {}) }, signal);
    const output = await this.saveOutput(record, result.data, result.mime, 0);
    // The speech API reports no cost inline; OpenRouter's generation record has it a few seconds later.
    const cost = result.generationId ? await this.lookupCost(result.generationId) : undefined;
    this.complete(record, meta, [output], cost, meta.prompt.length);
    await this.save(record, meta);
  }

  private async lookupCost(generationId: string): Promise<number | undefined> {
    for (const wait of [1_500, 4_000, 8_000]) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs < POLL_MS ? 1 : wait));
      const cost = await this.options.client.generationCost(generationId);
      if (cost !== undefined) return cost;
    }
    return undefined;
  }

  /* ───────────── video jobs ───────────── */

  private async submitVideo(record: ArtifactRecord, meta: MediaMeta, entry: MediaModelEntry, signal?: AbortSignal): Promise<void> {
    const body: Record<string, unknown> = { model: entry.id, prompt: meta.providerPrompt ?? meta.prompt, duration: durationOf(entry, meta.settings) };
    for (const key of ["resolution", "aspect_ratio", "seed"] as const) if (meta.settings[key] !== undefined) body[key] = meta.settings[key];
    if (entry.params.some((p) => p.key === "generate_audio")) body.generate_audio = meta.settings.generate_audio !== false;
    const frames = meta.references.filter((r) => r.role !== "reference");
    if (frames.length) {
      body.frame_images = await Promise.all(frames.map(async (r) => ({ type: "image_url", image_url: { url: await this.dataUrl(r) }, frame_type: r.role })));
    }
    const refs = meta.references.filter((r) => r.role === "reference");
    if (refs.length) {
      body.input_references = await Promise.all(
        refs.map(async (r) =>
          r.mediaType === "image"
            ? { type: "image_url", image_url: { url: await this.dataUrl(r) } }
            : r.mediaType === "video"
              ? { type: "video_url", video_url: { url: this.refLink(r.uploadId) } }
              : { type: "audio_url", audio_url: { url: this.refLink(r.uploadId) } }
        )
      );
    }
    const info = await this.options.catalog.endpoint(entry);
    const options = providerOptions(entry, meta.settings, info.tag);
    if (options) body.provider = { options };
    const job = await this.options.client.submitVideo(body, signal);
    meta.providerJobId = job.id;
    meta.status = "running";
    meta.startedAt = this.now();
    meta.expectedMs = info.expectedMs;
    await this.save(record, meta);
    this.options.log?.("media.video_submitted", { id: record.id, model: entry.id, job: job.id });
    this.poll(record.id);
  }

  /** Follow a video job until it finishes (also after a restart). */
  private poll(id: string): void {
    if (this.polling.has(id)) return;
    const controller = new AbortController();
    this.polling.set(id, controller);
    void this.pollLoop(id, controller.signal).finally(() => this.polling.delete(id));
  }

  private async pollLoop(id: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      if (signal.aborted) return;
      const record = await this.options.store.artifacts.get(this.options.ownerId, id);
      if (!record || record.kind !== "media") return;
      const meta = record.meta as unknown as MediaMeta;
      if (!meta.providerJobId || (meta.status !== "running" && meta.status !== "queued" && !(meta.status === "cancelled" && !meta.metered))) return;
      try {
        const poll = await this.options.client.pollVideo(meta.providerJobId);
        if (poll.status === "completed") {
          if (meta.status === "cancelled") {
            // Cancelled here, but the provider rendered it anyway: record what it cost.
            this.meterOnce(record, meta, poll.costUsd ?? meta.estimateUsd, poll.costUsd === undefined, durationOf(await this.entryOr(meta), meta.settings));
            await this.save(record, meta);
            return;
          }
          const outputs: MediaOutputView[] = [];
          for (let index = 0; index < Math.max(1, poll.outputs); index += 1) {
            const content = await this.options.client.videoContent(meta.providerJobId, index);
            outputs.push(await this.saveOutput(record, content.data, content.mime, index));
          }
          this.complete(record, meta, outputs, poll.costUsd, durationOf(await this.entryOr(meta), meta.settings));
          await this.save(record, meta);
          this.options.log?.("media.video_done", { id, costUsd: meta.costUsd });
          return;
        }
        if (poll.status === "failed" || poll.status === "cancelled" || poll.status === "expired") {
          if (meta.status === "cancelled") return;
          await this.fail(record, meta, new MediaProviderError(poll.error ?? `The video job ${poll.status}.`));
          return;
        }
        if (meta.status !== "cancelled") {
          meta.status = "running";
          meta.updatedAt = this.now();
          await this.save(record, meta);
        }
      } catch (error) {
        this.options.log?.("media.poll_failed", { id, error: error instanceof Error ? error.message : String(error) });
      }
      if (this.now() - (meta.startedAt ?? record.createdAt) > JOB_TIMEOUT_MS) {
        if (meta.status !== "cancelled") await this.fail(record, meta, new MediaProviderError("The video took too long and was given up."));
        return;
      }
    }
  }

  private async entryOr(meta: MediaMeta): Promise<MediaModelEntry> {
    const entry = await this.options.catalog.get(meta.model).catch(() => undefined);
    return entry ?? ({ id: meta.model, params: [], kind: meta.kind } as unknown as MediaModelEntry);
  }

  /** Pick up video jobs that were rendering when the gateway stopped. */
  async resume(): Promise<number> {
    const records = await this.options.store.artifacts.list(this.options.ownerId, { kind: "media" });
    let resumed = 0;
    for (const record of records) {
      const meta = record.meta as unknown as MediaMeta;
      this.learn(meta);
      if (meta.kind !== "video") continue;
      if (meta.providerJobId && (meta.status === "running" || meta.status === "queued" || (meta.status === "cancelled" && !meta.metered))) {
        this.poll(record.id);
        resumed += 1;
      } else if (!meta.providerJobId && (meta.status === "queued" || meta.status === "running")) {
        await this.fail(record, meta, new MediaProviderError("The gateway stopped before the video was submitted."));
      }
    }
    if (resumed) this.options.log?.("media.resumed", { jobs: resumed });
    return resumed;
  }

  /** Stop waiting for a running item. OpenRouter has no cancel: the render may still be billed, and is recorded if it is. */
  async cancel(scope: MediaScope, id: string): Promise<MediaItemView | undefined> {
    const found = await this.record(scope, id);
    if (!found) return undefined;
    const { record, meta } = found;
    if (meta.status !== "running" && meta.status !== "queued") return this.view(record, meta);
    meta.status = "cancelled";
    meta.finishedAt = this.now();
    if (!meta.providerJobId) meta.metered = true;
    await this.save(record, meta);
    this.options.log?.("media.cancelled", { id });
    return this.view(record, meta);
  }

  /* ───────────── reads ───────────── */

  private async record(scope: MediaScope, id: string): Promise<{ record: ArtifactRecord; meta: MediaMeta } | undefined> {
    if (!MEDIA_ID.test(id)) return undefined;
    const record = await this.options.store.artifacts.get(scope.ownerId, id);
    if (!record || record.kind !== "media" || !inWorkspace(record, scope.workspaceId || DEFAULT_WORKSPACE_ID)) return undefined;
    return { record, meta: record.meta as unknown as MediaMeta };
  }

  async get(scope: MediaScope, id: string): Promise<MediaItemView | undefined> {
    const found = await this.record(scope, id);
    return found ? this.view(found.record, found.meta, scope.viewer) : undefined;
  }

  /** Raw record (creator checks before deleting). */
  async owner(scope: MediaScope, id: string): Promise<string | undefined> {
    return (await this.record(scope, id))?.meta.createdBy;
  }

  async list(scope: MediaScope, filter: MediaListFilter = {}): Promise<MediaItemView[]> {
    const workspaceId = scope.workspaceId || DEFAULT_WORKSPACE_ID;
    const records = (await this.options.store.artifacts.list(scope.ownerId, { kind: "media" })).filter((record) => inWorkspace(record, workspaceId));
    const query = filter.query?.trim().toLowerCase();
    const items: MediaItemView[] = [];
    for (const record of records) {
      const meta = record.meta as unknown as MediaMeta;
      if (filter.kind && meta.kind !== filter.kind) continue;
      if (filter.model && meta.model !== filter.model) continue;
      if (filter.createdBy && meta.createdBy !== filter.createdBy) continue;
      if (filter.conversationId && record.conversationId !== filter.conversationId) continue;
      if (query && !`${meta.prompt} ${meta.modelName ?? ""} ${meta.model}`.toLowerCase().includes(query)) continue;
      if (filter.collectionId && !meta.collections?.includes(filter.collectionId)) continue;
      if (filter.favorites && !(scope.viewer && meta.favoritedBy?.includes(scope.viewer))) continue;
      items.push(this.view(record, meta, scope.viewer));
      if (items.length >= Math.min(500, filter.limit ?? 200)) break;
    }
    return items;
  }

  /** The item that produced (or used) this upload: the side panel opens media by upload id. */
  async byUpload(scope: MediaScope, uploadId: string): Promise<MediaItemView | undefined> {
    const items = await this.list(scope, { limit: 500 });
    return items.find((item) => item.outputs.some((output) => output.uploadId === uploadId));
  }

  /** Delete an item and the files it made. */
  async remove(scope: MediaScope, id: string): Promise<boolean> {
    const found = await this.record(scope, id);
    if (!found) return false;
    if (found.meta.status === "running" || found.meta.status === "queued") await this.cancel(scope, id);
    for (const output of found.meta.outputs) await this.options.uploads.remove(output.uploadId).catch(() => false);
    await this.options.store.artifacts.remove(scope.ownerId, id);
    this.polling.get(id)?.abort();
    this.options.log?.("media.removed", { id });
    return true;
  }

  view(record: ArtifactRecord, meta: MediaMeta = record.meta as unknown as MediaMeta, viewer?: string): MediaItemView {
    const progress =
      meta.status === "running" && meta.kind === "video" && meta.startedAt && meta.expectedMs
        ? Math.min(95, Math.max(2, Math.round(((this.now() - meta.startedAt) / meta.expectedMs) * 100)))
        : meta.status === "done"
          ? 100
          : undefined;
    return {
      id: record.id,
      kind: meta.kind,
      status: meta.status,
      model: meta.model,
      ...(meta.modelName ? { modelName: meta.modelName } : {}),
      prompt: meta.prompt,
      ...(meta.providerPrompt && meta.providerPrompt !== meta.prompt ? { providerPrompt: meta.providerPrompt } : {}),
      settings: meta.settings,
      references: meta.references.map(({ uploadId, role, token, name, mime }) => ({ uploadId, role, ...(token ? { token } : {}), ...(name ? { name } : {}), ...(mime ? { mime } : {}) })),
      outputs: meta.outputs,
      estimateUsd: meta.estimateUsd,
      ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
      ...(meta.costEstimated ? { costEstimated: true } : {}),
      ...(meta.error ? { error: meta.error } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(meta.createdBy ? { createdBy: meta.createdBy } : {}),
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
      createdAt: record.createdAt,
      updatedAt: meta.updatedAt,
      ...(meta.finishedAt ? { finishedAt: meta.finishedAt } : {}),
      ...(viewer && meta.favoritedBy?.includes(viewer) ? { favorite: true } : {}),
      ...(meta.collections?.length ? { collectionIds: meta.collections } : {})
    };
  }

  /* ───────────── library: favourites and collections ───────────── */

  private collectionsKey(scope: MediaScope): string {
    return `media.collections.${scope.workspaceId || DEFAULT_WORKSPACE_ID}`;
  }

  private async readCollections(scope: MediaScope): Promise<Array<{ id: string; name: string; createdAt: number }>> {
    return (await this.options.store.kv.get<Array<{ id: string; name: string; createdAt: number }>>(scope.ownerId, this.collectionsKey(scope))) ?? [];
  }

  /** The workspace's collections with how many items each holds. */
  async collections(scope: MediaScope): Promise<MediaCollectionView[]> {
    const list = await this.readCollections(scope);
    const items = await this.list(scope, { limit: 500 });
    return list.map((c) => ({ ...c, count: items.filter((item) => item.collectionIds?.includes(c.id)).length }));
  }

  async createCollection(scope: MediaScope, name: string): Promise<MediaCollectionView> {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean) throw new MediaError("Give the collection a name.", 400, "invalid");
    const list = await this.readCollections(scope);
    if (list.length >= 200) throw new MediaError("A workspace can have at most 200 collections.", 409, "limit");
    const collection = { id: newId("mc"), name: clean, createdAt: this.now() };
    await this.options.store.kv.set(scope.ownerId, this.collectionsKey(scope), [...list, collection]);
    return { ...collection, count: 0 };
  }

  async renameCollection(scope: MediaScope, id: string, name: string): Promise<boolean> {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
    const list = await this.readCollections(scope);
    if (!clean || !list.some((c) => c.id === id)) return false;
    await this.options.store.kv.set(scope.ownerId, this.collectionsKey(scope), list.map((c) => (c.id === id ? { ...c, name: clean } : c)));
    return true;
  }

  /** Delete a collection (its items stay in the library). */
  async removeCollection(scope: MediaScope, id: string): Promise<boolean> {
    const list = await this.readCollections(scope);
    if (!list.some((c) => c.id === id)) return false;
    await this.options.store.kv.set(scope.ownerId, this.collectionsKey(scope), list.filter((c) => c.id !== id));
    const records = (await this.options.store.artifacts.list(scope.ownerId, { kind: "media" })).filter((r) => inWorkspace(r, scope.workspaceId || DEFAULT_WORKSPACE_ID));
    for (const record of records) {
      const meta = record.meta as unknown as MediaMeta;
      if (meta.collections?.includes(id)) {
        meta.collections = meta.collections.filter((c) => c !== id);
        await this.save(record, meta);
      }
    }
    return true;
  }

  /** Favourite (per viewer) and collection membership. */
  async update(scope: MediaScope, id: string, patch: MediaItemPatch): Promise<MediaItemView | undefined> {
    const found = await this.record(scope, id);
    if (!found) return undefined;
    const { record, meta } = found;
    if (patch.favorite !== undefined) {
      if (!scope.viewer) throw new MediaError("Favourites need a signed-in person.", 400, "invalid");
      const set = new Set(meta.favoritedBy ?? []);
      if (patch.favorite) set.add(scope.viewer);
      else set.delete(scope.viewer);
      meta.favoritedBy = [...set];
    }
    if (patch.addToCollection || patch.removeFromCollection) {
      const known = new Set((await this.readCollections(scope)).map((c) => c.id));
      const set = new Set(meta.collections ?? []);
      if (patch.addToCollection) {
        if (!known.has(patch.addToCollection)) throw new MediaError("No such collection.", 404, "not_found");
        set.add(patch.addToCollection);
      }
      if (patch.removeFromCollection) set.delete(patch.removeFromCollection);
      meta.collections = [...set];
    }
    await this.save(record, meta);
    return this.view(record, meta, scope.viewer);
  }

  /* ───────────── signed reference links (provider fetches) ───────────── */

  /** A short-lived public link to an upload, for providers that only take HTTPS URLs (reference video/audio). */
  refLink(uploadId: string): string {
    const base = (this.options.publicUrl ?? "").replace(/\/+$/, "");
    const exp = this.now() + REF_LINK_TTL_MS;
    return `${base}/api/media/ref/${uploadId}?exp=${exp}&sig=${this.sign(uploadId, exp)}`;
  }

  private sign(uploadId: string, exp: number): string {
    return createHmac("sha256", this.refSecret).update(`${uploadId}.${exp}`).digest("hex");
  }

  /** The upload behind a valid, unexpired reference link (and only one used as a reference). */
  async refUpload(uploadId: string, exp: number, sig: string): Promise<UploadView | undefined> {
    if (!Number.isFinite(exp) || exp < this.now() || !/^[a-f0-9]{64}$/.test(sig)) return undefined;
    const expected = Buffer.from(this.sign(uploadId, exp), "hex");
    if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return undefined;
    return this.options.uploads.get(uploadId, { ownerId: this.options.ownerId });
  }

  async readUpload(uploadId: string): Promise<Buffer> {
    return this.options.uploads.readBytes(uploadId);
  }

  /* ───────────── helpers ───────────── */

  private async dataUrl(ref: StoredRef): Promise<string> {
    const bytes = await this.options.uploads.readBytes(ref.uploadId);
    return `data:${ref.mime ?? "image/png"};base64,${bytes.toString("base64")}`;
  }

  private async saveOutput(record: ArtifactRecord, data: Buffer, mime: string, index: number): Promise<MediaOutputView> {
    const meta = record.meta as unknown as MediaMeta;
    const name = `${fileStem(meta.prompt)}${index ? `-${index + 1}` : ""}${extensionFor(mime)}`;
    const upload = await this.options.uploads.save({
      data,
      filename: name,
      workspaceId: record.workspaceId || DEFAULT_WORKSPACE_ID,
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      maxBytes: GENERATED_MAX_BYTES
    });
    return { uploadId: upload.id, mime: upload.mime, size: upload.size, url: `/api/uploads/${upload.id}` };
  }

  private complete(record: ArtifactRecord, meta: MediaMeta, outputs: MediaOutputView[], costUsd: number | undefined, units: number): void {
    meta.outputs = outputs;
    meta.status = "done";
    meta.finishedAt = this.now();
    this.meterOnce(record, meta, costUsd ?? meta.estimateUsd, costUsd === undefined, units);
  }

  private meterOnce(record: ArtifactRecord, meta: MediaMeta, costUsd: number, estimated: boolean, units: number): void {
    if (meta.metered) return;
    meta.metered = true;
    meta.costUsd = costUsd;
    if (!estimated) this.observe(meta.model, meta.rawEstimateUsd ?? meta.estimateUsd, costUsd);
    if (estimated) meta.costEstimated = true;
    this.options.meter.record({
      ownerId: this.options.ownerId,
      feature: "media",
      model: meta.model,
      costUsd,
      estimated,
      units,
      workspaceId: record.workspaceId || DEFAULT_WORKSPACE_ID,
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
      ...(meta.createdBy ? { userId: meta.createdBy } : {})
    });
  }

  private async fail(record: ArtifactRecord, meta: MediaMeta, error: unknown): Promise<void> {
    meta.status = "error";
    meta.error = error instanceof Error ? error.message : String(error);
    meta.finishedAt = this.now();
    // Nothing was made: OpenRouter doesn't bill failed generations.
    meta.metered = true;
    await this.save(record, meta);
    this.options.log?.("media.failed", { id: record.id, model: meta.model, error: meta.error });
  }

  private async save(record: ArtifactRecord, meta: MediaMeta): Promise<void> {
    meta.updatedAt = this.now();
    record.meta = meta as unknown as Record<string, unknown>;
    await this.options.store.artifacts.create(record);
    const view = this.view(record, meta);
    for (const listener of this.listeners) {
      try {
        listener(view, record.workspaceId || DEFAULT_WORKSPACE_ID);
      } catch {
        // A listener must not break a job.
      }
    }
  }

  /** Stop polling (gateway shutdown); jobs resume on the next start. */
  close(): void {
    for (const controller of this.polling.values()) controller.abort();
    this.polling.clear();
  }
}

/** Only settings the model lists, with valid values; defaults filled in. */
export function sanitizeSettings(entry: MediaModelEntry, raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const settings: Record<string, string | number | boolean> = {};
  for (const param of entry.params) {
    const value = raw[param.key];
    if (param.type === "enum") {
      const values = param.values ?? [];
      let match = values.find((option) => String(option) === String(value));
      // A number between the listed ones (a duration of 7 s where 6 and 8 exist): the nearest, rounding up.
      if (match === undefined && value !== undefined && value !== "" && Number.isFinite(Number(value)) && values.every((option) => typeof option === "number")) {
        const wanted = Number(value);
        match = [...(values as number[])].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || b - a)[0];
      }
      if (match !== undefined) settings[param.key] = match;
      else if (param.default !== undefined) settings[param.key] = param.default;
    } else if (param.type === "range") {
      const n = Number(value);
      if (value !== undefined && value !== "" && Number.isFinite(n)) settings[param.key] = Math.round(Math.min(param.max ?? n, Math.max(param.min ?? n, n)));
      else if (param.default !== undefined) settings[param.key] = param.default;
    } else if (param.type === "boolean") {
      if (typeof value === "boolean") settings[param.key] = value;
      else if (value === "true" || value === "false") settings[param.key] = value === "true";
      else if (param.default !== undefined) settings[param.key] = param.default;
    } else if (param.type === "text" && typeof value === "string" && value.trim()) {
      settings[param.key] = value.trim().slice(0, 500);
    }
  }
  return settings;
}

/** Provider options for the settings OpenRouter only forwards as passthrough (negative prompt, prompt enhancement). */
export function providerOptions(entry: MediaModelEntry, settings: Record<string, string | number | boolean>, tag: string | undefined): Record<string, unknown> | undefined {
  const allowed = new Set(entry.passthrough ?? []);
  const out: Record<string, unknown> = {};
  const negative = typeof settings.negative_prompt === "string" ? settings.negative_prompt : undefined;
  if (negative) {
    if (allowed.has("negativePrompt")) out.negativePrompt = negative;
    else if (allowed.has("negative_prompt")) out.negative_prompt = negative;
  }
  if (settings.enhance_prompt !== undefined) {
    const on = settings.enhance_prompt === true;
    if (allowed.has("enhancePrompt")) out.enhancePrompt = on;
    else if (allowed.has("prompt_extend")) out.prompt_extend = on;
    else if (allowed.has("enable_prompt_expansion")) out.enable_prompt_expansion = on;
    else if (allowed.has("prompt_optimizer")) out.prompt_optimizer = on;
  }
  if (!Object.keys(out).length || !tag) return undefined;
  // Google Veo takes its options under `parameters`; every other provider directly under its slug.
  return /google/.test(tag) ? { [tag]: { parameters: out } } : { [tag]: out };
}

function fileStem(prompt: string): string {
  const words = prompt.toLowerCase().replace(/@\w+/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6);
  return words.length ? words.join("-") : "media";
}

function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a"
  };
  return map[mime.toLowerCase()] ?? (mime.startsWith("video/") ? ".mp4" : mime.startsWith("audio/") ? ".mp3" : ".png");
}
