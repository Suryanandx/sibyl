/**
 * Media tools for the brain (and agents with access): create_image,
 * create_video, create_audio. They spend money, so they are "write" tools —
 * but a call only waits for an approval when its estimate is above
 * SIBYL_MEDIA_APPROVE_ABOVE_USD (default $0.25): most images and voice-overs
 * go straight through, most videos ask. Budgets are checked before anything
 * is sent (service.ts).
 */
import type { ToolDefinition, ToolResult } from "@open-gpt-live/core";
import type { MediaItemView, MediaKind, MediaReferenceInput, ToolArtifactView } from "@open-gpt-live/protocol";
import { usd } from "./catalog.js";
import { MediaError, type MediaService } from "./service.js";

export const MEDIA_TOOL_NAMES = ["create_image", "create_video", "create_audio"] as const;

type MediaTool<I> = ToolDefinition<I, unknown> & { approvalSummary?(input: I): string | undefined; promptGuidance?: string };

const finished = new Map<string, ToolArtifactView[]>();
const MAX_PENDING_RUNS = 200;

/** Media made by a tool call, riding on its TOOL_FINISHED message (one per call, in order). */
export function takeMediaArtifact(runId: string, toolName: string): ToolArtifactView | undefined {
  if (!(MEDIA_TOOL_NAMES as readonly string[]).includes(toolName)) return undefined;
  const queue = finished.get(runId);
  const view = queue?.shift();
  if (queue && !queue.length) finished.delete(runId);
  return view;
}

function remember(runId: string, item: MediaItemView): void {
  if (!finished.has(runId) && finished.size >= MAX_PENDING_RUNS) {
    const oldest = finished.keys().next().value;
    if (oldest !== undefined) finished.delete(oldest);
  }
  finished.set(runId, [...(finished.get(runId) ?? []), mediaArtifact(item)]);
}

export function mediaArtifact(item: MediaItemView): ToolArtifactView {
  return { id: item.id, kind: "media", title: item.prompt.slice(0, 120), version: 1, media: item, createdAt: item.createdAt };
}

export const MEDIA_PROMPT_GUIDANCE = [
  "",
  "",
  "## Images, video and audio",
  "You can make media: create_image, create_video, create_audio (voice-over or music). Write a vivid, specific prompt (subject, setting, style, light, camera).",
  "Files the user attached or picked with @ have file ids (up_…): pass them in `references` to use them as reference images/videos, and name them in the prompt as @image1, @image2, @video1 … in the order you list them. For a video that should start (or end) on an exact picture, pass it as first_frame (or last_frame) instead.",
  "The user sees the result as a card with a player and downloads, so don't paste links; say in one sentence what you made. Videos render in the background (a minute or more): tell the user it's on its way."
].join("\n");

interface CommonInput {
  prompt?: string;
  model?: string;
  references?: string[];
  settings?: Record<string, string | number | boolean>;
}

interface ImageInput extends CommonInput {
  aspect_ratio?: string;
  resolution?: string;
  n?: number;
}

interface VideoInput extends CommonInput {
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  generate_audio?: boolean;
  first_frame?: string;
  last_frame?: string;
}

interface AudioInput {
  text?: string;
  type?: "speech" | "music";
  voice?: string;
  model?: string;
}

const referenceSchema = {
  type: "array",
  items: { type: "string", description: "File id (up_…) of an image (or, for video, a video/audio clip)." },
  maxItems: 9,
  description: "Reference files, in order: the prompt names them @image1, @image2, @video1 …"
};

function refs(ids: string[] | undefined, frames: Array<[string | undefined, "first_frame" | "last_frame"]> = []): MediaReferenceInput[] {
  const list: MediaReferenceInput[] = [];
  for (const id of ids ?? []) if (typeof id === "string" && id.trim()) list.push({ uploadId: id.trim(), role: "reference" });
  for (const [id, role] of frames) if (id?.trim()) list.push({ uploadId: id.trim(), role });
  return list;
}

export function createMediaTools(service: MediaService): ToolDefinition<any, any>[] {

  const run = async (kind: MediaKind, input: { prompt: string; model?: string; settings: Record<string, string | number | boolean>; references: MediaReferenceInput[]; audioType?: "speech" | "music" }, context: Parameters<ToolDefinition["run"]>[1]): Promise<ToolResult> => {
    try {
      const principal = context.principal;
      const item = await service.create({
        kind,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        settings: input.settings,
        references: input.references,
        ...(input.audioType ? { audioType: input.audioType } : {}),
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(principal ? { userId: principal.userId ?? principal.kind } : {}),
        ...(context.agent ? { agentId: context.agent.id } : {}),
        requestId: context.runId,
        signal: context.signal
      });
      remember(context.runId, item);
      context.log("media.tool_done", { id: item.id, kind, status: item.status });
      return { content: describeResult(item), data: item, artifacts: [{ id: item.id, kind: "media", title: item.prompt.slice(0, 80) }], ...(item.status === "error" ? { isError: true } : {}) };
    } catch (error) {
      return { content: error instanceof MediaError ? error.message : `Media failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  };

  /** Price of a proposed call (from the loaded catalogue; undefined while unknown). */
  const price = (kind: MediaKind, input: unknown): number | undefined => service.quickEstimate(toEstimateRequest(kind, input));
  /** Above the threshold asks; an unknown price asks for video (images and audio are cheap). */
  const needs = (kind: MediaKind, input: unknown): boolean => {
    const usdValue = price(kind, input);
    return usdValue === undefined ? kind === "video" : usdValue > service.approveAboveUsd;
  };

  const createImage: MediaTool<ImageInput> = {
    name: "create_image",
    title: "Create an image",
    description:
      "Generates images from a prompt with an image model on OpenRouter (default: the workspace's image model). Use references (file ids) to edit or restyle a picture or keep a subject consistent. The result is saved as a file in the chat and the Media gallery.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw: subject, setting, style, light, composition. Name references as @image1, @image2…" },
        aspect_ratio: { type: "string", description: "e.g. 1:1, 16:9, 9:16, 4:3 (if the model supports it)." },
        resolution: { type: "string", description: "e.g. 1K, 2K (if the model supports it)." },
        n: { type: "integer", minimum: 1, maximum: 4, description: "How many images (default 1)." },
        references: referenceSchema,
        model: { type: "string", description: "Optional OpenRouter image model id; leave out for the default." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    effect: "write",
    source: "media",
    provider: "openrouter",
    promptGuidance: MEDIA_PROMPT_GUIDANCE,
    approvalNeeded: (input) => needs("image", input),
    approvalSummary: (input) => `Create ${input.n && input.n > 1 ? `${input.n} images` : "an image"}: "${clip(input.prompt)}"${estimateText(price("image", input))}`,
    run: (input, context) => {
      const settings = { ...(input.settings ?? {}), ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}), ...(input.resolution ? { resolution: input.resolution } : {}), ...(input.n ? { n: input.n } : {}) };
      return run("image", { prompt: input.prompt ?? "", ...(input.model ? { model: input.model } : {}), settings, references: refs(input.references) }, context);
    }
  };

  const createVideo: MediaTool<VideoInput> = {
    name: "create_video",
    title: "Create a video",
    description:
      "Generates a short video clip (a few seconds) with a video model on OpenRouter (default: the workspace's video model, e.g. Seedance or Wan). Text-to-video, or from reference images/videos (references, named @image1/@video1 in the prompt), or starting/ending on an exact picture (first_frame / last_frame file ids). Renders in the background; the user sees progress and the player in chat.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The shot: subject, action, setting, camera movement, style, sound." },
        duration: { type: "integer", minimum: 1, maximum: 30, description: "Seconds (the model's nearest supported length is used; default ≈5)." },
        resolution: { type: "string", description: "e.g. 480p, 720p, 1080p." },
        aspect_ratio: { type: "string", description: "e.g. 16:9, 9:16, 1:1." },
        generate_audio: { type: "boolean", description: "Generate sound (models that can)." },
        references: referenceSchema,
        first_frame: { type: "string", description: "File id of an image the video starts on." },
        last_frame: { type: "string", description: "File id of an image the video ends on." },
        model: { type: "string", description: "Optional OpenRouter video model id; leave out for the default." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    effect: "write",
    source: "media",
    provider: "openrouter",
    promptGuidance: MEDIA_PROMPT_GUIDANCE,
    approvalNeeded: (input) => needs("video", input),
    approvalSummary: (input) => `Create a ${input.duration ? `${input.duration}-second ` : ""}video: "${clip(input.prompt)}"${estimateText(price("video", input))}`,
    run: (input, context) => {
      const settings: Record<string, string | number | boolean> = { ...(input.settings ?? {}) };
      if (input.resolution) settings.resolution = input.resolution;
      if (input.aspect_ratio) settings.aspect_ratio = input.aspect_ratio;
      if (input.generate_audio !== undefined) settings.generate_audio = input.generate_audio;
      if (input.duration) settings.duration = input.duration;
      return run("video", { prompt: input.prompt ?? "", ...(input.model ? { model: input.model } : {}), settings, references: refs(input.references, [[input.first_frame, "first_frame"], [input.last_frame, "last_frame"]]) }, context);
    }
  };

  const createAudio: MediaTool<AudioInput> = {
    name: "create_audio",
    title: "Create audio",
    description:
      "Makes audio with OpenRouter: type \"speech\" reads `text` aloud as a voice-over (choose a voice if you like); type \"music\" composes a short music clip from a description in `text` (genre, mood, tempo, instruments).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Speech: the exact words to say. Music: a description of the piece." },
        type: { type: "string", enum: ["speech", "music"], description: "speech (default) or music." },
        voice: { type: "string", description: "Speech only: a voice of the model (optional)." },
        model: { type: "string", description: "Optional OpenRouter speech or music model id." }
      },
      required: ["text"],
      additionalProperties: false
    },
    effect: "write",
    source: "media",
    provider: "openrouter",
    promptGuidance: MEDIA_PROMPT_GUIDANCE,
    approvalNeeded: (input) => needs("audio", input),
    approvalSummary: (input) => `Create ${input.type === "music" ? "a music clip" : "a voice-over"}: "${clip(input.text)}"${estimateText(price("audio", input))}`,
    run: (input, context) =>
      run("audio", { prompt: input.text ?? "", ...(input.model ? { model: input.model } : {}), settings: input.voice ? { voice: input.voice } : {}, references: [], audioType: input.type === "music" ? "music" : "speech" }, context)
  };

  return [createImage, createVideo, createAudio];
}

function toEstimateRequest(kind: MediaKind, input: any): Parameters<MediaService["quickEstimate"]>[0] {
  if (kind === "audio") return { kind, prompt: String(input.text ?? ""), ...(input.model ? { model: input.model } : {}), audioType: input.type === "music" ? "music" : "speech" };
  const settings: Record<string, string | number | boolean> = {};
  for (const name of ["aspect_ratio", "resolution", "n", "duration", "generate_audio"]) if (input[name] !== undefined) settings[name] = input[name];
  return {
    kind,
    prompt: String(input.prompt ?? ""),
    ...(input.model ? { model: input.model } : {}),
    settings,
    references: refs(input.references, [[input.first_frame, "first_frame"], [input.last_frame, "last_frame"]])
  };
}

function clip(text: string | undefined): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}

function estimateText(value: number | undefined): string {
  return value === undefined ? "" : ` (≈${usd(value)})`;
}

function describeResult(item: MediaItemView): string {
  const files = item.outputs.map((output) => output.uploadId).join(", ");
  if (item.status === "error") return `It failed: ${item.error ?? "unknown error"}. Nothing was charged.`;
  if (item.status === "running" || item.status === "queued") {
    return `The video is rendering with ${item.modelName ?? item.model} (media id ${item.id}, estimated ${usd(item.estimateUsd)}). It usually takes a minute or more; the user sees its progress and the player in chat. Tell them it's on its way.`;
  }
  return `Made ${item.outputs.length > 1 ? `${item.outputs.length} ${item.kind}s` : `the ${item.kind}`} with ${item.modelName ?? item.model} (file id${item.outputs.length > 1 ? "s" : ""} ${files}; cost ${usd(item.costUsd ?? item.estimateUsd)}). The user sees it in chat. Use the file id${item.outputs.length > 1 ? "s" : ""} as references for follow-ups.`;
}
