/**
 * Slides service: budgets, metering, artifacts and spaces around the engine
 * client. Both the brain tools (tools.ts) and the Slides page API (http.ts)
 * go through here, so a deck is created, metered and versioned one way.
 */
import { randomUUID } from "node:crypto";
import type { ArtifactRecord, SpaceRecord, Store, UsageMeter } from "@open-gpt-live/core";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { GatewayUsageMeter } from "../metering/meter.js";
import { CostEstimator } from "../metering/pricing.js";
import { SlidesEngineError, type ExportFormat, type SlidesClient } from "./client.js";

export const DEFAULT_SLIDE_COUNT = 8;
export const MAX_SLIDES = 40;
/** Fallback when the slides model has no known pricing. */
export const DEFAULT_USD_PER_SLIDE = 0.004;
export const DEFAULT_SPACE_NAME = "My decks";
/** Stored content is capped so revisions can rebuild a deck without bloating the store. */
const MAX_STORED_CONTENT = 40_000;

export interface SlidesServiceOptions {
  client: SlidesClient;
  store: Store;
  meter: UsageMeter;
  /** Model the engine generates with (SIBYL_SLIDES_MODEL), for estimates and metering. */
  model?: string;
  usdPerSlide?: number;
  /** Where the web app serves the engine's editor (default "/slides"). */
  editorBase?: string;
  now?: () => number;
  createId?: () => string;
}

export interface CreateDeckInput {
  ownerId: string;
  title: string;
  content: string;
  nSlides?: number;
  template?: string;
  /** Space id or name; a new name creates the space. */
  space?: string;
  language?: string;
  instructions?: string;
  conversationId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

export interface ReviseDeckInput {
  ownerId: string;
  artifactId: string;
  instructions: string;
  nSlides?: number;
  template?: string;
  conversationId?: string;
  requestId?: string;
  signal?: AbortSignal;
}

export class SlidesBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlidesBudgetError";
  }
}

export interface SlidesMeta {
  engine: "presenton";
  presentationId: string;
  editPath: string;
  exports: Partial<Record<ExportFormat, string>>;
  slideCount: number;
  template?: string;
  content: string;
  instructions?: string;
  thumbnail?: string;
  costUsd: number;
}

export class SlidesService {
  readonly client: SlidesClient;
  private readonly store: Store;
  private readonly meter: UsageMeter;
  readonly model: string;
  private readonly usdPerSlide: number;
  private readonly editorBase: string;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: SlidesServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.meter = options.meter;
    this.model = options.model?.trim() || "slides-engine";
    this.usdPerSlide = options.usdPerSlide ?? DEFAULT_USD_PER_SLIDE;
    this.editorBase = (options.editorBase ?? "/slides").replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  /** Expected engine cost: outline + one generation per slide, priced on the slides model. */
  estimateUsd(nSlides: number): number {
    const slides = clampSlides(nSlides);
    if (this.meter instanceof GatewayUsageMeter && this.meter.pricing.get(this.model)) {
      const estimator = new CostEstimator(this.meter.pricing, () => undefined);
      const priced = estimator.llm("slides", this.model, 2_000 + 1_500 * slides, 900 * slides);
      if (priced > 0) return priced;
    }
    return this.usdPerSlide * slides;
  }

  /** Throws SlidesBudgetError when the generation would break a budget cap. */
  checkBudget(ownerId: string, estimateUsd: number): void {
    const decision = this.meter.check({ ownerId, estimateUsd });
    if (!decision.allowed) throw new SlidesBudgetError(`Can't build the deck: ${decision.message}`);
  }

  async create(input: CreateDeckInput): Promise<ArtifactRecord> {
    const nSlides = clampSlides(input.nSlides ?? DEFAULT_SLIDE_COUNT);
    const space = await this.resolveSpace(input.ownerId, input.space);
    const template = input.template?.trim() || space.template;
    const instructions = joinInstructions(space.instructions, input.instructions);
    return this.generate({
      ownerId: input.ownerId,
      title: input.title.trim() || "Untitled deck",
      content: input.content,
      nSlides,
      ...(template ? { template } : {}),
      ...(instructions ? { instructions } : {}),
      ...(input.language ? { language: input.language } : {}),
      spaceId: space.id,
      version: 1,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  async revise(input: ReviseDeckInput): Promise<ArtifactRecord> {
    const previous = await this.store.artifacts.get(input.ownerId, input.artifactId);
    if (!previous || previous.kind !== "slides") throw new SlidesEngineError(`No deck with id ${input.artifactId}. Use list_slides to find it.`);
    const meta = previous.meta as Partial<SlidesMeta>;
    const content = [
      meta.content ?? previous.title,
      "",
      `Revision ${previous.version + 1} — apply these changes to the deck above:`,
      input.instructions.trim()
    ].join("\n");
    const template = input.template?.trim() || meta.template;
    return this.generate({
      ownerId: input.ownerId,
      title: previous.title,
      content,
      nSlides: clampSlides(input.nSlides ?? meta.slideCount ?? DEFAULT_SLIDE_COUNT),
      ...(template ? { template } : {}),
      ...(meta.instructions ? { instructions: meta.instructions } : {}),
      ...(previous.spaceId ? { spaceId: previous.spaceId } : {}),
      version: previous.version + 1,
      parentId: previous.id,
      ...(input.conversationId ?? previous.conversationId ? { conversationId: input.conversationId ?? previous.conversationId! } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
  }

  private async generate(input: {
    ownerId: string;
    title: string;
    content: string;
    nSlides: number;
    template?: string;
    instructions?: string;
    language?: string;
    spaceId?: string;
    version: number;
    parentId?: string;
    conversationId?: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<ArtifactRecord> {
    if (!input.content.trim()) throw new SlidesEngineError("The deck needs some content: a brief, an outline or the data to show.");
    const estimateUsd = this.estimateUsd(input.nSlides);
    this.checkBudget(input.ownerId, estimateUsd);

    const content = `# ${input.title}\n\n${input.content.trim()}`;
    const deck = await this.client.generate(
      {
        content,
        nSlides: input.nSlides,
        exportAs: "pptx",
        ...(input.template ? { template: input.template } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.language ? { language: input.language } : {})
      },
      input.signal
    );
    // The engine spent the money once it answered: record it even if the details lookup fails.
    this.meter.record({
      ownerId: input.ownerId,
      feature: "slides",
      model: this.model,
      costUsd: estimateUsd,
      estimated: true,
      units: input.nSlides,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {})
    });

    let slideCount = input.nSlides;
    let thumbnail: string | undefined;
    try {
      const details = await this.client.get(deck.presentationId, input.signal);
      if (details.slideCount) slideCount = details.slideCount;
      thumbnail = details.thumbnail;
    } catch {
      // Details are a nicety; the deck exists.
    }

    const exports: SlidesMeta["exports"] = {};
    if (deck.path) exports[/\.pdf$/i.test(deck.path) ? "pdf" : "pptx"] = deck.path;
    const meta: SlidesMeta = {
      engine: "presenton",
      presentationId: deck.presentationId,
      editPath: deck.editPath,
      exports,
      slideCount,
      ...(input.template ? { template: input.template } : {}),
      content: input.content.slice(0, MAX_STORED_CONTENT),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      costUsd: estimateUsd
    };
    const record: ArtifactRecord = {
      id: this.createId(),
      ownerId: input.ownerId,
      kind: "slides",
      title: input.title,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      version: input.version,
      meta: meta as unknown as Record<string, unknown>,
      createdAt: this.now()
    };
    await this.store.artifacts.create(record);
    return record;
  }

  async listDecks(ownerId: string, spaceId?: string): Promise<ArtifactRecord[]> {
    return this.store.artifacts.list(ownerId, { kind: "slides", ...(spaceId ? { spaceId } : {}) });
  }

  /** Engine path of an export, exporting on demand when the deck has none yet. */
  async exportPath(ownerId: string, artifactId: string, format: ExportFormat, signal?: AbortSignal): Promise<{ path: string; title: string }> {
    const artifact = await this.store.artifacts.get(ownerId, artifactId);
    if (!artifact || artifact.kind !== "slides") throw new SlidesEngineError("Deck not found.", 404);
    const meta = artifact.meta as Partial<SlidesMeta>;
    const known = meta.exports?.[format];
    if (known) return { path: known, title: artifact.title };
    if (!meta.presentationId) throw new SlidesEngineError("This deck has no engine presentation.", 404);
    const exported = await this.client.export(meta.presentationId, format, signal);
    return { path: exported.path, title: artifact.title };
  }

  /** Find a space by id or name, create one by name, or fall back to the default space. */
  async resolveSpace(ownerId: string, space?: string): Promise<SpaceRecord> {
    const wanted = space?.trim();
    const spaces = await this.store.spaces.list(ownerId);
    if (wanted) {
      const found =
        spaces.find((s) => s.id === wanted) ?? spaces.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
      if (found) return found;
      return this.createSpace(ownerId, { name: wanted.slice(0, 80) });
    }
    return spaces.find((s) => s.name === DEFAULT_SPACE_NAME) ?? this.createSpace(ownerId, { name: DEFAULT_SPACE_NAME });
  }

  async createSpace(ownerId: string, input: { name: string; instructions?: string; template?: string }): Promise<SpaceRecord> {
    const at = this.now();
    const record: SpaceRecord = {
      id: this.createId(),
      ownerId,
      name: input.name.trim() || "Untitled space",
      ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
      ...(input.template?.trim() ? { template: input.template.trim() } : {}),
      createdAt: at,
      updatedAt: at
    };
    await this.store.spaces.upsert(record);
    return record;
  }

  /** Browser-safe view: editor URL on the web app, downloads through the gateway. */
  view(artifact: ArtifactRecord): ToolArtifactView {
    const meta = artifact.meta as Partial<SlidesMeta>;
    const editPath = meta.editPath ?? (meta.presentationId ? `/presentation?id=${encodeURIComponent(meta.presentationId)}` : undefined);
    const base = `/api/slides/decks/${encodeURIComponent(artifact.id)}`;
    return {
      id: artifact.id,
      kind: "slides",
      title: artifact.title,
      version: artifact.version,
      ...(artifact.parentId ? { parentId: artifact.parentId } : {}),
      ...(artifact.spaceId ? { spaceId: artifact.spaceId } : {}),
      ...(meta.slideCount ? { slideCount: meta.slideCount } : {}),
      ...(editPath ? { editUrl: `${this.editorBase}${editPath.startsWith("/") ? "" : "/"}${editPath}` } : {}),
      ...(meta.thumbnail ? { thumbnailUrl: `${base}/thumbnail` } : {}),
      downloads: { pptx: `${base}/download?format=pptx`, pdf: `${base}/download?format=pdf` },
      createdAt: artifact.createdAt
    };
  }
}

export function clampSlides(value: number | undefined): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SLIDE_COUNT;
  return Math.min(MAX_SLIDES, n);
}

function joinInstructions(...parts: Array<string | undefined>): string | undefined {
  const joined = parts.map((part) => part?.trim()).filter(Boolean).join("\n\n");
  return joined || undefined;
}

export function formatEstimate(usd: number): string {
  if (usd < 0.01) return `≈$${usd.toFixed(3)}`;
  return `≈$${usd.toFixed(2)}`;
}
