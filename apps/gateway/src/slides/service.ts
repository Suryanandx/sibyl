/**
 * Slides service: budgets, metering, artifacts and spaces around the engine
 * client. Both the brain tools (tools.ts) and the Slides page API (http.ts)
 * go through here, so a deck is created, metered and versioned one way.
 *
 * Decks and spaces belong to a workspace (records without one: the default
 * workspace). Every read and write goes through SlidesLibrary, which takes
 * the caller's scope, so a deck made in one workspace never shows in another.
 */
import { DEFAULT_WORKSPACE_ID, inWorkspace, type ArtifactRecord, type SpaceRecord, type Store, type UsageMeter } from "@open-gpt-live/core";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { newId } from "../http/ids.js";
import { GatewayUsageMeter } from "../metering/meter.js";
import { CostEstimator } from "../metering/pricing.js";
import { ENGINE_PATHS, SlidesEngineError, type EngineConfig, type ExportFormat, type SlidesClient } from "./client.js";
import { SlidesJobs } from "./jobs.js";

export const DEFAULT_SLIDE_COUNT = 8;
export const MAX_SLIDES = 40;
/** Fallback when the slides model has no known pricing. */
export const DEFAULT_USD_PER_SLIDE = 0.004;
export const DEFAULT_SPACE_NAME = "My decks";
/**
 * Token shape of one build, for estimates from the model's per-token price:
 * outline + structure calls, then one call per slide (prompts carry the
 * template layouts, so they are large). Calibrated on real builds: a 5-slide
 * deck on deepseek-v4.1-flash cost $0.0202 (2026-11).
 */
const PROMPT_TOKENS_BASE = 10_000;
const PROMPT_TOKENS_PER_SLIDE = 25_000;
const COMPLETION_TOKENS_BASE = 3_000;
const COMPLETION_TOKENS_PER_SLIDE = 4_000;
/** How many recent builds the observed cost per slide averages over. */
const OBSERVED_SAMPLES = 10;
/** Stored content is capped so revisions can rebuild a deck without bloating the store. */
const MAX_STORED_CONTENT = 40_000;

export interface SlidesServiceOptions {
  client: SlidesClient;
  store: Store;
  meter: UsageMeter;
  /**
   * Model the engine generates with, for estimates and metering. Replaced by
   * what the engine itself reports (applyEngineConfig), the source of truth.
   */
  model?: string;
  /** Engine model price per token (USD), from the engine's /api/v1/sibyl/config. */
  pricing?: { prompt: number; completion: number };
  usdPerSlide?: number;
  /** Where the web app serves the engine's editor (default "/slides"). */
  editorBase?: string;
  now?: () => number;
  createId?: () => string;
}

/** Whose decks: the organization (store owner) and the workspace (absent: default). */
export interface SlidesScope {
  ownerId: string;
  workspaceId?: string;
}

/**
 * The one place slides records are read and written, always within a scope.
 * Works without the engine (spaces can be managed while it is down).
 */
export class SlidesLibrary {
  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => newId()
  ) {}

  static workspaceOf(scope: SlidesScope): string {
    return scope.workspaceId || DEFAULT_WORKSPACE_ID;
  }

  async spaces(scope: SlidesScope): Promise<SpaceRecord[]> {
    const workspaceId = SlidesLibrary.workspaceOf(scope);
    return (await this.store.spaces.list(scope.ownerId)).filter((space) => inWorkspace(space, workspaceId));
  }

  async space(scope: SlidesScope, id: string): Promise<SpaceRecord | undefined> {
    const space = await this.store.spaces.get(scope.ownerId, id);
    return space && inWorkspace(space, SlidesLibrary.workspaceOf(scope)) ? space : undefined;
  }

  async createSpace(scope: SlidesScope, input: { name: string; instructions?: string; template?: string }): Promise<SpaceRecord> {
    const at = this.now();
    const record: SpaceRecord = {
      id: this.createId(),
      ownerId: scope.ownerId,
      workspaceId: SlidesLibrary.workspaceOf(scope),
      name: input.name.trim() || "Untitled space",
      ...(input.instructions?.trim() ? { instructions: input.instructions.trim() } : {}),
      ...(input.template?.trim() ? { template: input.template.trim() } : {}),
      createdAt: at,
      updatedAt: at
    };
    await this.store.spaces.upsert(record);
    return record;
  }

  /** Save changes to a space read through space() (its workspace is kept). */
  async saveSpace(record: SpaceRecord): Promise<void> {
    await this.store.spaces.upsert(record);
  }

  /** Remove a space of this scope (its decks stay, unfiled). False when there is no such space here. */
  async removeSpace(scope: SlidesScope, id: string): Promise<boolean> {
    if (!(await this.space(scope, id))) return false;
    await this.store.spaces.remove(scope.ownerId, id);
    return true;
  }

  /** Find a space by id or name, create one by name, or fall back to the default space. */
  async resolveSpace(scope: SlidesScope, space?: string): Promise<SpaceRecord> {
    const wanted = space?.trim();
    const spaces = await this.spaces(scope);
    if (wanted) {
      const found = spaces.find((s) => s.id === wanted) ?? spaces.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
      if (found) return found;
      return this.createSpace(scope, { name: wanted.slice(0, 80) });
    }
    return spaces.find((s) => s.name === DEFAULT_SPACE_NAME) ?? this.createSpace(scope, { name: DEFAULT_SPACE_NAME });
  }

  /** Every deck version in this scope (optionally one space), newest first. */
  async decks(scope: SlidesScope, spaceId?: string): Promise<ArtifactRecord[]> {
    const workspaceId = SlidesLibrary.workspaceOf(scope);
    const decks = await this.store.artifacts.list(scope.ownerId, { kind: "slides", ...(spaceId ? { spaceId } : {}) });
    return decks.filter((deck) => inWorkspace(deck, workspaceId));
  }

  /** One deck version in this scope. */
  async deck(scope: SlidesScope, id: string): Promise<ArtifactRecord | undefined> {
    const deck = await this.store.artifacts.get(scope.ownerId, id);
    return deck && deck.kind === "slides" && inWorkspace(deck, SlidesLibrary.workspaceOf(scope)) ? deck : undefined;
  }
}

export interface CreateDeckInput {
  ownerId: string;
  /** Workspace the deck is saved in (absent: default). */
  workspaceId?: string;
  title: string;
  /** The title is only a placeholder (cut from the prompt): use the engine's title for the deck. */
  draftTitle?: boolean;
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
  /** Workspace the deck must be in (absent: default). */
  workspaceId?: string;
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
  /** Actual cost (engine-reported) unless costEstimated is set. */
  costUsd: number;
  costEstimated?: boolean;
}

export class SlidesService {
  readonly client: SlidesClient;
  /** Scoped access to decks and spaces. */
  readonly library: SlidesLibrary;
  private readonly store: Store;
  private readonly meter: UsageMeter;
  model: string;
  private pricing?: { prompt: number; completion: number };
  /** When asking the engine for its config last failed (retried after a while). */
  private engineConfigFailedAt?: number;
  /** Actual cost per slide of recent builds (engine-reported), newest last. */
  private readonly observedPerSlide: number[] = [];
  private readonly usdPerSlide: number;
  private readonly editorBase: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  /** Deck builds started from the Slides page (see jobs.ts). */
  readonly jobs: SlidesJobs;
  /** Deck titles and slide counts seen by this service, for synchronous approval summaries. */
  private readonly known = new Map<string, { title: string; slideCount?: number }>();

  constructor(options: SlidesServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.meter = options.meter;
    this.model = options.model?.trim() || "slides-engine";
    if (options.pricing) this.pricing = options.pricing;
    this.usdPerSlide = options.usdPerSlide ?? DEFAULT_USD_PER_SLIDE;
    this.editorBase = (options.editorBase ?? "/slides").replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => newId());
    this.library = new SlidesLibrary(this.store, this.now, this.createId);
    this.jobs = new SlidesJobs(this.now);
  }

  /** Title and slide count of a deck version this service has seen (created or listed). */
  describeDeck(artifactId: string): { title: string; slideCount?: number } | undefined {
    return this.known.get(artifactId);
  }

  private remember(artifact: ArtifactRecord): void {
    if (this.known.size > 2_000) this.known.clear();
    const meta = artifact.meta as Partial<SlidesMeta>;
    this.known.set(artifact.id, { title: artifact.title, ...(meta.slideCount ? { slideCount: meta.slideCount } : {}) });
  }

  /** Adopt the engine's own model and pricing (one source of truth for estimates and labels). */
  applyEngineConfig(config: EngineConfig): void {
    if (config.model?.trim()) this.model = config.model.trim();
    if (config.pricing) this.pricing = config.pricing;
    this.engineConfigFailedAt = undefined;
  }

  /** Ask the engine for its model and pricing (once; again after a failure). */
  async refreshEngineConfig(signal?: AbortSignal): Promise<void> {
    try {
      this.applyEngineConfig(await this.client.config(signal ?? AbortSignal.timeout(5_000)));
    } catch {
      // Older engine or not reachable yet: keep the configured model.
      this.engineConfigFailedAt = this.now();
    }
  }

  /**
   * Expected engine cost before a build, for budget checks and approval cards.
   * Best first: the actual cost per slide of recent builds on this model, then
   * the engine model's per-token price (outline + one generation per slide),
   * then gateway pricing, then the per-slide fallback.
   */
  estimateUsd(nSlides: number): number {
    const slides = clampSlides(nSlides);
    if (this.observedPerSlide.length) {
      const average = this.observedPerSlide.reduce((sum, value) => sum + value, 0) / this.observedPerSlide.length;
      return average * slides;
    }
    if (this.pricing) {
      const promptTokens = PROMPT_TOKENS_BASE + PROMPT_TOKENS_PER_SLIDE * slides;
      const completionTokens = COMPLETION_TOKENS_BASE + COMPLETION_TOKENS_PER_SLIDE * slides;
      const priced = promptTokens * this.pricing.prompt + completionTokens * this.pricing.completion;
      if (priced > 0) return priced;
    }
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
    const scope = { ownerId: input.ownerId, workspaceId: SlidesLibrary.workspaceOf(input) };
    const space = await this.library.resolveSpace(scope, input.space);
    const template = input.template?.trim() || space.template;
    const instructions = joinInstructions(space.instructions, input.instructions);
    return this.generate({
      ...scope,
      title: input.title.trim() || "Untitled deck",
      ...(input.draftTitle ? { draftTitle: true } : {}),
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
    const previous = await this.library.deck(input, input.artifactId);
    if (!previous) throw new SlidesEngineError(`No deck with id ${input.artifactId}. Use list_slides to find it.`);
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
      workspaceId: SlidesLibrary.workspaceOf(previous),
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
    workspaceId: string;
    title: string;
    draftTitle?: boolean;
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
    if (this.engineConfigFailedAt !== undefined && this.now() - this.engineConfigFailedAt > 5 * 60_000) await this.refreshEngineConfig();
    const estimateUsd = this.estimateUsd(input.nSlides);
    this.checkBudget(input.ownerId, estimateUsd);

    const content = input.draftTitle ? input.content.trim() : `# ${input.title}\n\n${input.content.trim()}`;
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
    // The engine spent the money once it answered: record it even if the details
    // lookup fails. Actual cost when the engine reports it (OpenRouter usage
    // accounting), else the estimate.
    const actual = deck.costUsd !== undefined && !deck.costEstimated;
    const costUsd = deck.costUsd !== undefined ? Math.max(deck.costUsd, actual ? 0 : estimateUsd) : estimateUsd;
    if (actual && input.nSlides > 0) {
      this.observedPerSlide.push(costUsd / input.nSlides);
      if (this.observedPerSlide.length > OBSERVED_SAMPLES) this.observedPerSlide.shift();
    }
    this.meter.record({
      ownerId: input.ownerId,
      feature: "slides",
      model: this.model,
      costUsd,
      estimated: !actual,
      units: input.nSlides,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {})
    });

    let slideCount = input.nSlides;
    let title = input.title;
    // The engine renders slide 1 to a PNG on demand (and caches it).
    let thumbnail: string = ENGINE_PATHS.thumbnail(deck.presentationId);
    try {
      const details = await this.client.get(deck.presentationId, input.signal);
      if (details.slideCount) slideCount = details.slideCount;
      if (input.draftTitle && details.title?.trim()) title = details.title.trim().slice(0, 160);
      if (details.thumbnail) thumbnail = details.thumbnail;
    } catch {
      // Details are a nicety; the deck exists.
    }
    this.warmThumbnail(thumbnail);

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
      thumbnail,
      costUsd,
      ...(actual ? {} : { costEstimated: true })
    };
    const record: ArtifactRecord = {
      id: this.createId(),
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      kind: "slides",
      title,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      version: input.version,
      meta: meta as unknown as Record<string, unknown>,
      createdAt: this.now()
    };
    await this.store.artifacts.create(record);
    this.remember(record);
    return record;
  }

  /** Render the first-slide thumbnail in the background so the library has it ready. */
  private warmThumbnail(path: string): void {
    void this.client
      .download(path, AbortSignal.timeout(5 * 60_000))
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
  }

  async listDecks(scope: SlidesScope, spaceId?: string): Promise<ArtifactRecord[]> {
    const decks = await this.library.decks(scope, spaceId);
    for (const deck of decks) this.remember(deck);
    return decks;
  }

  /** Engine path of a deck's first-slide thumbnail (older decks get the on-demand renderer). */
  thumbnailPath(artifact: ArtifactRecord): string | undefined {
    const meta = artifact.meta as Partial<SlidesMeta>;
    if (meta.thumbnail) return meta.thumbnail;
    return meta.presentationId ? ENGINE_PATHS.thumbnail(meta.presentationId) : undefined;
  }

  /** Engine path of an export, exporting on demand when the deck has none yet. */
  async exportPath(scope: SlidesScope, artifactId: string, format: ExportFormat, signal?: AbortSignal): Promise<{ path: string; title: string }> {
    const artifact = await this.library.deck(scope, artifactId);
    if (!artifact) throw new SlidesEngineError("Deck not found.", 404);
    const meta = artifact.meta as Partial<SlidesMeta>;
    const known = meta.exports?.[format];
    if (known) return { path: known, title: artifact.title };
    if (!meta.presentationId) throw new SlidesEngineError("This deck has no engine presentation.", 404);
    const exported = await this.client.export(meta.presentationId, format, signal);
    return { path: exported.path, title: artifact.title };
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
      ...(editPath ? { editUrl: editorUrl(this.editorBase, editPath) } : {}),
      ...(this.thumbnailPath(artifact) ? { thumbnailUrl: `${base}/thumbnail` } : {}),
      downloads: { pptx: `${base}/download?format=pptx`, pdf: `${base}/download?format=pdf` },
      createdAt: artifact.createdAt
    };
  }

  /** Announce finished builds ("Deck ready") through the one notifications system. */
  notifyWith(publish: (input: { kind: "deck_ready"; workspaceId: string; recipientUserId?: string; title: string; body?: string; links?: { artifactId?: string } }) => void): void {
    this.jobs.onFinished = (job) => {
      if (job.status !== "done" || !job.artifact) return;
      publish({
        kind: "deck_ready",
        workspaceId: job.workspaceId,
        ...(job.userId ? { recipientUserId: job.userId } : {}),
        title: "Deck ready",
        body: job.artifact.title,
        links: { artifactId: job.artifact.id }
      });
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

/** The engine may return its edit path with or without its /slides base path. */
export function editorUrl(editorBase: string, editPath: string): string {
  const path = editPath.startsWith("/") ? editPath : `/${editPath}`;
  if (editorBase && (path === editorBase || path.startsWith(`${editorBase}/`) || path.startsWith(`${editorBase}?`))) return path;
  return `${editorBase}${path}`;
}
