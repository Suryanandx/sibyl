/**
 * Slides tools for the brain: create_slides, revise_slides (both "write", so
 * they wait for an approval card) and list_slides (read).
 *
 * The brain is told (in the tool descriptions, which it always sees) to
 * gather real data with its other tools first — web search, MCP data
 * sources — and to pass the figures in `content`.
 */
import type { ToolDefinition, ToolResult } from "@open-gpt-live/core";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { SlidesEngineError } from "./client.js";
import { DEFAULT_SLIDE_COUNT, MAX_SLIDES, SlidesBudgetError, clampSlides, formatEstimate, type SlidesService } from "./service.js";

export const SLIDES_TOOL_NAMES = ["create_slides", "revise_slides", "list_slides"] as const;

/**
 * A slides tool with the optional hooks the brain understands:
 * `approvalSummary(input)` is the approval card's sentence (approvals.ts),
 * `promptGuidance` is appended to the brain's system prompt while the tool is
 * enabled (tool-loop.ts). `describeCall` is kept as an alias of the summary.
 */
export type DescribedTool<I> = ToolDefinition<I, unknown> & {
  approvalSummary?(input: I): string | undefined;
  describeCall?(input: I): string;
  promptGuidance?: string;
};

/**
 * Artifacts finished by a slides tool, waiting to ride on the TOOL_FINISHED
 * message. Write tools run one at a time per run, and the loop reports a call
 * right after it returns, so a FIFO per run is exact.
 */
const finishedArtifacts = new Map<string, ToolArtifactView[]>();
const MAX_PENDING_RUNS = 200;

function rememberArtifact(runId: string, view: ToolArtifactView): void {
  if (!finishedArtifacts.has(runId) && finishedArtifacts.size >= MAX_PENDING_RUNS) {
    const oldest = finishedArtifacts.keys().next().value;
    if (oldest !== undefined) finishedArtifacts.delete(oldest);
  }
  finishedArtifacts.set(runId, [...(finishedArtifacts.get(runId) ?? []), view]);
}

/** Artifact for a finished slides tool call (used by the gateway's TOOL_FINISHED). */
export function takeSlidesArtifact(runId: string, toolName: string): ToolArtifactView | undefined {
  if (toolName !== "create_slides" && toolName !== "revise_slides") return undefined;
  const queue = finishedArtifacts.get(runId);
  const view = queue?.shift();
  if (queue && queue.length === 0) finishedArtifacts.delete(runId);
  return view;
}

/** Extra system-prompt guidance for decks (also baked into the tool descriptions). */
export const SLIDES_PROMPT_GUIDANCE = [
  "",
  "",
  "## Slide decks",
  "When the user wants slides, a deck or a presentation: first gather the facts with your other tools (web search, the user's MCP data sources), then call create_slides once with a clear outline and the real figures, names and dates in `content`. Never invent numbers.",
  "To change an existing deck, call revise_slides with its id (list_slides finds it); this keeps the version history."
].join("\n");

/** "Create an 8-slide deck 'Q3 market overview' (≈$0.03)" */
export function describeCreate(service: SlidesService, input: CreateInput): string {
  const n = clampSlides(input.n_slides ?? DEFAULT_SLIDE_COUNT);
  const title = quoteTitle(input.title, "Untitled deck");
  const space = input.space?.trim() ? ` in "${input.space.trim().slice(0, 60)}"` : "";
  return `Create ${n === 8 || n === 11 || n === 18 ? "an" : "a"} ${n}-slide deck ${title}${space} (${formatEstimate(service.estimateUsd(n))})`;
}

/** "Make version 2 of 'Q3 market overview' (8 slides, ≈$0.03): add a slide on churn" */
export function describeRevise(service: SlidesService, input: ReviseInput): string {
  const known = input.deck_id ? service.describeDeck(input.deck_id.trim()) : undefined;
  const n = clampSlides(input.n_slides ?? known?.slideCount ?? DEFAULT_SLIDE_COUNT);
  const what = (input.instructions ?? "").replace(/\s+/g, " ").trim();
  const change = what ? `: ${what.length > 90 ? `${what.slice(0, 89)}…` : what}` : "";
  const deck = known ? quoteTitle(known.title, "the deck") : "the deck";
  return `Make a new version of ${deck} (${n} slides, ${formatEstimate(service.estimateUsd(n))})${change}`;
}

function quoteTitle(title: string | undefined, fallback: string): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return `'${clean.length > 80 ? `${clean.slice(0, 79)}…` : clean}'`;
}

interface CreateInput {
  title?: string;
  content?: string;
  brief?: string;
  outline?: string;
  n_slides?: number;
  template?: string;
  space?: string;
  language?: string;
  instructions?: string;
}

interface ReviseInput {
  deck_id?: string;
  instructions?: string;
  n_slides?: number;
  template?: string;
}

interface ListInput {
  space?: string;
  limit?: number;
}

export function createSlidesTools(service: SlidesService): ToolDefinition<any, any>[] {
  const createSlides: DescribedTool<CreateInput> = {
    name: "create_slides",
    title: "Create a slide deck",
    description: [
      "Builds a new slide deck (PowerPoint/PDF, editable in Sibyl Slides) and saves it in a Slides space.",
      "BEFORE calling this, gather the real data the deck needs with your other tools (web search, webpages, the user's MCP data sources) — do not invent figures.",
      "Then put everything the deck must say in `content`: a slide-by-slide outline in Markdown with the actual numbers, names, dates and sources.",
      `Use n_slides between 3 and ${MAX_SLIDES} (default ${DEFAULT_SLIDE_COUNT}).`
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Deck title, e.g. 'Q3 market overview'." },
        content: {
          type: "string",
          description: "Everything the deck must contain: outline per slide plus the real data you gathered (figures, quotes, sources)."
        },
        brief: { type: "string", description: "Optional: audience, goal and tone." },
        n_slides: { type: "integer", minimum: 1, maximum: MAX_SLIDES, description: "Number of slides." },
        template: { type: "string", description: "Optional Sibyl Slides template name (default: the space's template, else 'general')." },
        space: { type: "string", description: "Optional Slides space name or id to save the deck in (created if new)." },
        language: { type: "string", description: "Deck language (default English)." }
      },
      required: ["title", "content"],
      additionalProperties: false
    },
    effect: "write",
    source: "slides",
    provider: "sibyl-slides",
    approvalSummary: (input) => describeCreate(service, input),
    describeCall: (input) => describeCreate(service, input),
    promptGuidance: SLIDES_PROMPT_GUIDANCE,
    async run(input, context): Promise<ToolResult> {
      const title = input.title?.trim() || "Untitled deck";
      const content = [input.brief?.trim() ? `Brief: ${input.brief.trim()}` : "", input.content ?? input.outline ?? ""]
        .filter(Boolean)
        .join("\n\n");
      try {
        const artifact = await service.create({
          ownerId: context.ownerId,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          title,
          content,
          ...(input.n_slides ? { nSlides: input.n_slides } : {}),
          ...(input.template ? { template: input.template } : {}),
          ...(input.space ? { space: input.space } : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          requestId: context.runId,
          signal: context.signal
        });
        const view = service.view(artifact);
        rememberArtifact(context.runId, view);
        context.log("slides.created", { artifactId: artifact.id, slides: view.slideCount });
        return {
          content: `Created the deck "${artifact.title}" (${view.slideCount ?? "?"} slides, deck id ${artifact.id}, version 1). The user sees a preview card with "Open in editor" and PPTX/PDF downloads, so don't paste links; summarise what the deck covers in one or two sentences.`,
          data: view,
          artifacts: [{ id: artifact.id, kind: "slides", title: artifact.title }]
        };
      } catch (error) {
        return failure(error);
      }
    }
  };

  const reviseSlides: DescribedTool<ReviseInput> = {
    name: "revise_slides",
    title: "Revise a slide deck",
    description:
      "Makes a new version of an existing deck from change instructions (the earlier version is kept). Find the deck id with list_slides or from the create_slides result. Gather any new data with other tools first and include it in `instructions`.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string", description: "Id of the deck version to revise." },
        instructions: { type: "string", description: "What to change, with any new figures to use." },
        n_slides: { type: "integer", minimum: 1, maximum: MAX_SLIDES, description: "New slide count (default: same as before)." },
        template: { type: "string", description: "Optional new template." }
      },
      required: ["deck_id", "instructions"],
      additionalProperties: false
    },
    effect: "write",
    source: "slides",
    provider: "sibyl-slides",
    approvalSummary: (input) => describeRevise(service, input),
    describeCall: (input) => describeRevise(service, input),
    promptGuidance: SLIDES_PROMPT_GUIDANCE,
    async run(input, context): Promise<ToolResult> {
      if (!input.deck_id?.trim() || !input.instructions?.trim()) {
        return { content: "revise_slides needs deck_id and instructions.", isError: true };
      }
      try {
        const artifact = await service.revise({
          ownerId: context.ownerId,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          artifactId: input.deck_id.trim(),
          instructions: input.instructions,
          ...(input.n_slides ? { nSlides: input.n_slides } : {}),
          ...(input.template ? { template: input.template } : {}),
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          requestId: context.runId,
          signal: context.signal
        });
        const view = service.view(artifact);
        rememberArtifact(context.runId, view);
        context.log("slides.revised", { artifactId: artifact.id, parentId: artifact.parentId, version: artifact.version });
        return {
          content: `Saved version ${artifact.version} of "${artifact.title}" (deck id ${artifact.id}). The user sees a preview card for it; summarise the changes briefly.`,
          data: view,
          artifacts: [{ id: artifact.id, kind: "slides", title: artifact.title }]
        };
      } catch (error) {
        return failure(error);
      }
    }
  };

  const listSlides: ToolDefinition<ListInput, unknown> = {
    name: "list_slides",
    title: "List slide decks",
    description: "Lists the user's slide decks (newest first) with ids, versions and spaces. Use it to find a deck to revise.",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Optional space name or id to filter by." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many decks (default 20)." }
      },
      additionalProperties: false
    },
    effect: "read",
    source: "slides",
    provider: "sibyl-slides",
    async run(input, context): Promise<ToolResult> {
      const scope = { ownerId: context.ownerId, ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}) };
      const spaces = await service.library.spaces(scope);
      let spaceId: string | undefined;
      if (input.space?.trim()) {
        const wanted = input.space.trim().toLowerCase();
        spaceId = spaces.find((s) => s.id === input.space!.trim() || s.name.toLowerCase() === wanted)?.id;
        if (!spaceId) return { content: `No Slides space called "${input.space}". Spaces: ${spaces.map((s) => s.name).join(", ") || "none yet"}.` };
      }
      const decks = await service.listDecks(scope, spaceId);
      const limit = Math.min(50, Math.max(1, input.limit ?? 20));
      const names = new Map(spaces.map((s) => [s.id, s.name]));
      const rows = decks.slice(0, limit).map((deck) => {
        const meta = deck.meta as { slideCount?: number };
        return `- ${deck.title} — v${deck.version}, ${meta.slideCount ?? "?"} slides, space "${names.get(deck.spaceId ?? "") ?? "none"}", id ${deck.id}, ${new Date(deck.createdAt).toISOString().slice(0, 10)}`;
      });
      return {
        content: rows.length ? `Decks (${decks.length}):\n${rows.join("\n")}` : "No slide decks yet.",
        data: decks.slice(0, limit).map((deck) => service.view(deck))
      };
    }
  };

  return [createSlides, reviseSlides, listSlides];
}

function failure(error: unknown): ToolResult {
  if (error instanceof SlidesBudgetError || error instanceof SlidesEngineError) return { content: error.message, isError: true };
  return { content: `Slides failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
}
