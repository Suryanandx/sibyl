import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, createToolRegistry, needsApproval, type BudgetDecision, type Store, type UsageEvent, type UsageMeter } from "@open-gpt-live/core";
import { parseClientMessage, WS_EVENTS } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { protectedRoutePermission } from "../identity/http.js";
import { UploadService } from "../uploads/service.js";
import { detectType } from "../uploads/types.js";
import { MediaCatalog } from "./catalog.js";
import type { MediaClient, VideoPoll } from "./client.js";
import { estimateVideo } from "./estimate.js";
import { replyText, runMediaChatTurn } from "./chat.js";
import { providerPrompt, referenceProblem } from "./references.js";
import { MediaError, MediaService, providerOptions, sanitizeSettings } from "./service.js";
import { createMediaTools, takeMediaArtifact } from "./tools.js";

/* Listings shaped exactly like OpenRouter's (2026-11), trimmed. */
const VIDEO_MODELS = {
  data: [
    {
      id: "bytedance/seedance-2.0-fast",
      name: "ByteDance: Seedance 2.0 Fast",
      description: "Seedance 2.0 Fast … supports text-to-video, image-to-video and multimodal reference-to-video.",

      supported_resolutions: ["480p", "720p"],
      supported_aspect_ratios: ["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"],
      supported_sizes: ["854x480", "1280x720"],
      supported_durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      supported_frame_images: ["first_frame", "last_frame"],
      generate_audio: true,
      seed: true,
      pricing_skus: { video_tokens: "0.0000042", video_tokens_without_audio: "0.0000042", video_tokens_with_video_input: "0.000002475" },
      allowed_passthrough_parameters: ["watermark", "req_key"]
    },
    {
      id: "google/veo-3.1-lite",
      name: "Google: Veo 3.1 Lite",
      description: "Veo 3.1 Lite.",
      supported_resolutions: ["720p", "1080p"],
      supported_aspect_ratios: ["16:9", "9:16"],
      supported_durations: [8, 4, 6],
      supported_frame_images: ["first_frame", "last_frame"],
      generate_audio: true,
      seed: true,
      pricing_skus: { duration_seconds_with_audio: "0.08", duration_seconds_without_audio: "0.05", duration_seconds_with_audio_720p: "0.05", duration_seconds_without_audio_720p: "0.03" },
      allowed_passthrough_parameters: ["personGeneration", "aspectRatio", "negativePrompt", "conditioningScale", "enhancePrompt"]
    },
    {
      id: "alibaba/wan-2.7",
      name: "Alibaba: Wan 2.7",
      description: "Wan 2.7 reference-to-video.",
      supported_resolutions: ["720p", "1080p"],
      supported_aspect_ratios: ["16:9", "9:16", "1:1"],
      supported_durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      supported_frame_images: ["first_frame", "last_frame"],
      generate_audio: true,
      seed: true,
      pricing_skus: { duration_seconds: "0.1" },
      allowed_passthrough_parameters: ["negative_prompt", "prompt_extend", "audio"]
    },
    { id: "black-forest-labs/flux-video-upscale", supported_durations: null, pricing_skus: { cents_per_megapixel_second_precise: "3.5" } }
  ]
};
const IMAGE_MODELS = {
  data: [
    {
      id: "black-forest-labs/flux.2-klein-4b",
      name: "Black Forest Labs: FLUX.2 Klein 4B",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1", "16:9", "auto"] },
        output_format: { type: "enum", values: ["png", "jpeg"] },
        n: { type: "range", min: 1, max: 1 },
        input_references: { type: "range", min: 0, max: 4 },
        seed: { type: "boolean" }
      }
    },
    { id: "recraft/recraft-v4-vector", supported_parameters: { output_format: { type: "enum", values: ["svg"] } } }
  ]
};
const SPEECH_MODELS = { data: [{ id: "hexgrad/kokoro-82m", name: "Kokoro 82M", pricing: { prompt: "0.00000062", completion: "0" }, supported_voices: ["af_heart", "am_adam"], architecture: { input_modalities: ["text"] } }] };
const AUDIO_MODELS = {
  data: [
    { id: "google/lyria-3-clip-preview", name: "Google: Lyria 3 Clip Preview", description: "30 second duration clips are priced at $0.04 per clip. Lyria 3 is Google's music model.", pricing: { prompt: "0", completion: "0" } },
    { id: "openai/gpt-audio", name: "OpenAI: GPT Audio", description: "Chat with audio.", pricing: { prompt: "0.0000025" } }
  ]
};

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]);

class FakeClient implements MediaClient {
  calls: Array<{ op: string; body?: unknown }> = [];
  polls: VideoPoll[] = [];
  async getJson(path: string) {
    this.calls.push({ op: "get", body: path });
    if (path === "/videos/models") return VIDEO_MODELS;
    if (path === "/images/models") return IMAGE_MODELS;
    if (path.includes("speech")) return SPEECH_MODELS;
    if (path.includes("output_modalities=audio")) return AUDIO_MODELS;
    // The video listing has no input modalities (as on OpenRouter); the models listing does.
    if (path.includes("output_modalities=video")) return { data: [{ id: "bytedance/seedance-2.0-fast", architecture: { input_modalities: ["text", "image", "video", "audio"] } }] };
    if (path.startsWith("/images/models/")) return { endpoints: [{ pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.014 }] }] };
    if (path.startsWith("/models/")) return { data: { endpoints: [{ tag: "seed", perf_last_30m_by_workload: { video_generation: { latency: { p50: 60_000 } } } }] } };
    throw new Error(`unexpected ${path}`);
  }
  async images(body: Record<string, unknown>) {
    this.calls.push({ op: "images", body });
    return { images: [{ data: PNG, mime: "image/png" }], costUsd: 0.015 };
  }
  async submitVideo(body: Record<string, unknown>) {
    this.calls.push({ op: "submitVideo", body });
    return { id: "gen-vid-1" };
  }
  async pollVideo() {
    return this.polls.shift() ?? { status: "in_progress" as const, outputs: 0 };
  }
  async videoContent() {
    return { data: MP4, mime: "video/mp4" };
  }
  async speech(body: { model: string; input: string }) {
    this.calls.push({ op: "speech", body });
    return { data: MP3, mime: "audio/mpeg", generationId: "gen-tts-1" };
  }
  async music(body: { model: string; prompt: string }) {
    this.calls.push({ op: "music", body });
    return { data: MP3, mime: "audio/mpeg", text: "<instrumental>", costUsd: 0.04 };
  }
  async generationCost() {
    return 0.0001;
  }
}

class Meter implements UsageMeter {
  events: Array<Omit<UsageEvent, "id" | "at">> = [];
  checks: Array<{ estimateUsd: number; feature?: string }> = [];
  decision: BudgetDecision = { allowed: true };
  record(event: Omit<UsageEvent, "id" | "at">) {
    this.events.push(event);
  }
  totals() {
    return { todayUsd: 0, monthUsd: 0, byFeature: {} };
  }
  check(input: { estimateUsd: number; feature?: string }) {
    this.checks.push(input);
    return this.decision;
  }
  limits() {
    return {};
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(options: { publicUrl?: string; store?: Store } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sibyl-media-"));
  dirs.push(dir);
  const store = options.store ?? createMemoryStore();
  const uploads = new UploadService({ store, ownerId: "owner", dir, maxBytes: 1024 * 1024 });
  const client = new FakeClient();
  const meter = new Meter();
  const catalog = new MediaCatalog({ client });
  const media = new MediaService({ store, ownerId: "owner", meter, uploads, catalog, client, pollMs: 5, ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}) });
  return { store, uploads, client, meter, catalog, media };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

describe("catalogue (from OpenRouter listings)", () => {
  test("video, image, speech and music models with their parameters; edit/upscale, SVG and chat-audio models left out", async () => {
    const { catalog } = await setup();
    const models = await catalog.models();
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(["black-forest-labs/flux.2-klein-4b", "bytedance/seedance-2.0-fast", "google/veo-3.1-lite", "alibaba/wan-2.7", "hexgrad/kokoro-82m", "google/lyria-3-clip-preview"]);
    const seedance = models.find((m) => m.id === "bytedance/seedance-2.0-fast")!;
    expect(seedance.params.map((p) => p.key)).toEqual(["aspect_ratio", "resolution", "duration", "generate_audio", "seed"]);
    expect(seedance.references).toEqual({ images: 9, videos: 3, audio: 3, frames: ["first_frame", "last_frame"], syntax: "seedance" });
    expect(models.find((m) => m.id === "alibaba/wan-2.7")!.references.syntax).toBe("wan");
    expect(models.find((m) => m.id === "google/veo-3.1-lite")!.params.map((p) => p.key)).toContain("negative_prompt");
    expect(models.find((m) => m.id === "hexgrad/kokoro-82m")!.params[0]).toMatchObject({ key: "voice", values: ["af_heart", "am_adam"] });
    expect(models.find((m) => m.id === "google/lyria-3-clip-preview")).toMatchObject({ audioKind: "music", priceLabel: "$0.04 / clip" });
    expect(catalog.defaults()).toMatchObject({ video: "bytedance/seedance-2.0-fast", speech: "hexgrad/kokoro-82m", music: "google/lyria-3-clip-preview" });
  });
});

describe("estimates", () => {
  test("Seedance video tokens match a measured job (864×496, 4 s at 24 fps → $0.17)", async () => {
    const { catalog } = await setup();
    const seedance = (await catalog.get("bytedance/seedance-2.0-fast"))!;
    const estimate = estimateVideo(seedance, { settings: { resolution: "480p", aspect_ratio: "16:9", duration: 4, generate_audio: false }, references: { images: 1, videos: 0, audio: 0, frames: 0 }, prompt: "" });
    // Measured on OpenRouter 2026-11-09: $0.1704948 (4.04 s rendered).
    expect(estimate.usd).toBeCloseTo(0.1715, 3);
  });

  test("per-second SKUs pick resolution and audio", async () => {
    const { catalog } = await setup();
    const veo = (await catalog.get("google/veo-3.1-lite"))!;
    const at720 = estimateVideo(veo, { settings: { resolution: "720p", duration: 4, generate_audio: false }, references: { images: 0, videos: 0, audio: 0, frames: 1 }, prompt: "" });
    expect(at720.usd).toBeCloseTo(0.12, 5);
    const at1080 = estimateVideo(veo, { settings: { resolution: "1080p", duration: 8, generate_audio: true }, references: { images: 0, videos: 0, audio: 0, frames: 0 }, prompt: "" });
    expect(at1080.usd).toBeCloseTo(0.64, 5);
  });
});

describe("references", () => {
  const refs = [
    { uploadId: "up_a", role: "reference" as const, mediaType: "image" as const, token: "@fox" },
    { uploadId: "up_b", role: "reference" as const, mediaType: "image" as const },
    { uploadId: "up_c", role: "reference" as const, mediaType: "video" as const }
  ];
  test("prompt tokens are rewritten to each model's syntax", () => {
    expect(providerPrompt("@fox walks past @image2 like in @video1", refs, "seedance")).toBe("@Image1 walks past @Image2 like in @Video1");
    expect(providerPrompt("@FOX walks past @image2 like in @video1", refs, "wan")).toBe("image 1 walks past image 2 like in video 1");
    expect(providerPrompt("start on @image1", [{ uploadId: "up_f", role: "first_frame", mediaType: "image", token: "@image1" }], "plain")).toBe("start on the first frame");
  });
  test("limits per model", () => {
    const support = { images: 1, videos: 0, audio: 0, frames: ["first_frame" as const], syntax: "plain" as const };
    expect(referenceProblem(refs.slice(0, 2), support, "M")).toMatch(/at most 1 reference image/);
    expect(referenceProblem([{ uploadId: "x", role: "last_frame", mediaType: "image" }], support, "M")).toMatch(/doesn't take a last frame/);
    expect(referenceProblem([{ uploadId: "x", role: "reference", mediaType: "audio" }], { ...support, audio: 3 }, "M")).toMatch(/needs at least one reference image or video/);
  });
});

describe("media service", () => {
  test("image: budget checked before sending, saved as an upload, metered with the provider's cost", async () => {
    const { media, meter, client, uploads } = await setup();
    const ref = await uploads.save({ data: PNG, filename: "fox.png", workspaceId: "default" });
    const item = await media.create({ kind: "image", prompt: "a fox like @image1", references: [{ uploadId: ref.id, token: "@image1" }], workspaceId: "default", userId: "u1", model: "black-forest-labs/flux.2-klein-4b" });
    expect(item.status).toBe("done");
    expect(meter.checks[0]).toMatchObject({ feature: "media" });
    expect(meter.checks[0]!.estimateUsd).toBeCloseTo(0.0147, 3);
    const sent = client.calls.find((c) => c.op === "images")!.body as Record<string, unknown>;
    expect(sent.prompt).toBe("a fox like image 1");
    expect((sent.input_references as Array<{ image_url: { url: string } }>)[0]!.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(meter.events).toEqual([expect.objectContaining({ feature: "media", costUsd: 0.015, estimated: false, userId: "u1", workspaceId: "default" })]);
    const output = await uploads.get(item.outputs[0]!.uploadId, { workspaceId: "default" });
    expect(output).toMatchObject({ kind: "image", mime: "image/png" });
    expect(await media.byUpload({ ownerId: "owner", workspaceId: "default" }, output!.id)).toMatchObject({ id: item.id });
    // Another workspace sees nothing.
    expect(await media.get({ ownerId: "owner", workspaceId: "other" }, item.id)).toBeUndefined();
  });

  test("a budget refusal stops the request before anything is sent", async () => {
    const { media, meter, client } = await setup();
    meter.decision = { allowed: false, scope: "daily", message: "The daily budget is used up." };
    await expect(media.create({ kind: "image", prompt: "x", workspaceId: "default" })).rejects.toBeInstanceOf(MediaError);
    expect(client.calls.some((c) => c.op === "images")).toBe(false);
  });

  test("video: submitted with a first frame, polled, downloaded, resumable after a restart", async () => {
    const store = createMemoryStore();
    const first = await setup({ store });
    const frame = await first.uploads.save({ data: PNG, filename: "start.png", workspaceId: "default" });
    const item = await first.media.create({ kind: "video", prompt: "the fox runs", references: [{ uploadId: frame.id, role: "first_frame" }], settings: { duration: 4, resolution: "480p" }, workspaceId: "default" });
    expect(item.status).toBe("running");
    const body = first.client.calls.find((c) => c.op === "submitVideo")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: "bytedance/seedance-2.0-fast", duration: 4, resolution: "480p", generate_audio: true });
    expect((body.frame_images as Array<{ frame_type: string }>)[0]!.frame_type).toBe("first_frame");
    // The gateway stops before the job finishes …
    first.media.close();
    // … and a new one picks it up.
    const second = await setup({ store });
    second.client.polls.push({ status: "in_progress", outputs: 0 }, { status: "completed", outputs: 1, costUsd: 0.1705 });
    expect(await second.media.resume()).toBe(1);
    const done = await waitFor(() => second.media.get({ ownerId: "owner", workspaceId: "default" }, item.id), (value) => value?.status === "done");
    expect(done!.outputs[0]!.mime).toBe("video/mp4");
    expect(second.meter.events).toEqual([expect.objectContaining({ costUsd: 0.1705, estimated: false, units: 4 })]);
  });

  test("cancel stops waiting; a render that still finishes is recorded once, without files", async () => {
    const { media, client, meter } = await setup();
    const item = await media.create({ kind: "video", prompt: "waves", workspaceId: "default" });
    const cancelled = await media.cancel({ ownerId: "owner", workspaceId: "default" }, item.id);
    expect(cancelled!.status).toBe("cancelled");
    client.polls.push({ status: "completed", outputs: 1, costUsd: 0.2 });
    await waitFor(async () => meter.events.length, (n) => n === 1);
    const after = await media.get({ ownerId: "owner", workspaceId: "default" }, item.id);
    expect(after).toMatchObject({ status: "cancelled", outputs: [], costUsd: 0.2 });
  });

  test("reference videos need the public gateway address; with it they go as signed HTTPS links", async () => {
    const without = await setup();
    const clip = await without.uploads.save({ data: MP4, filename: "clip.mp4", workspaceId: "default" });
    await expect(without.media.create({ kind: "video", prompt: "like @video1", references: [{ uploadId: clip.id }], workspaceId: "default" })).rejects.toThrow(/SIBYL_PUBLIC_GATEWAY_URL/);
    const withUrl = await setup({ publicUrl: "https://sibyl.example.com" });
    const clip2 = await withUrl.uploads.save({ data: MP4, filename: "clip.mp4", workspaceId: "default" });
    await withUrl.media.create({ kind: "video", prompt: "like @video1", references: [{ uploadId: clip2.id }], workspaceId: "default" });
    const body = withUrl.client.calls.find((c) => c.op === "submitVideo")!.body as { input_references: Array<{ type: string; video_url: { url: string } }>; prompt: string };
    expect(body.prompt).toBe("like @Video1");
    const link = new URL(body.input_references[0]!.video_url.url);
    expect(link.origin).toBe("https://sibyl.example.com");
    expect(await withUrl.media.refUpload(clip2.id, Number(link.searchParams.get("exp")), link.searchParams.get("sig")!)).toMatchObject({ id: clip2.id });
    expect(await withUrl.media.refUpload(clip2.id, Number(link.searchParams.get("exp")), "0".repeat(64))).toBeUndefined();
  });

  test("speech and music", async () => {
    const { media, meter } = await setup();
    const speech = await media.create({ kind: "audio", prompt: "Hello there", settings: { voice: "am_adam" }, workspaceId: "default" });
    expect(speech).toMatchObject({ status: "done", model: "hexgrad/kokoro-82m", settings: { voice: "am_adam" }, costUsd: 0.0001 });
    const music = await media.create({ kind: "audio", audioType: "music", prompt: "lo-fi piano", workspaceId: "default" });
    expect(music).toMatchObject({ status: "done", model: "google/lyria-3-clip-preview", costUsd: 0.04 });
    expect(meter.events).toHaveLength(2);
  });

  test("settings: only what the model lists, defaults filled; passthrough by provider", async () => {
    const { catalog } = await setup();
    const veo = (await catalog.get("google/veo-3.1-lite"))!;
    expect(sanitizeSettings(veo, { duration: 7, resolution: "4K", fps: 60, negative_prompt: " blur " })).toEqual({ aspect_ratio: "16:9", resolution: "720p", duration: 8, generate_audio: true, negative_prompt: "blur", enhance_prompt: false });
    expect(providerOptions(veo, { negative_prompt: "blur", enhance_prompt: true }, "google-vertex")).toEqual({ "google-vertex": { parameters: { negativePrompt: "blur", enhancePrompt: true } } });
    const wan = (await catalog.get("alibaba/wan-2.7"))!;
    expect(providerOptions(wan, { negative_prompt: "blur" }, "alibaba")).toEqual({ alibaba: { negative_prompt: "blur" } });
  });
});

describe("tools and chat", () => {
  test("cheap images go straight through; a video above the threshold asks", async () => {
    const { media, catalog } = await setup();
    await catalog.models();
    await catalog.imagePricing((await catalog.get("black-forest-labs/flux.2-klein-4b"))!);
    const registry = createToolRegistry();
    for (const tool of createMediaTools(media)) registry.register(tool);
    const image = registry.get("create_image")!;
    const video = registry.get("create_video")!;
    expect(needsApproval(image, { prompt: "a cat", model: "black-forest-labs/flux.2-klein-4b" })).toBe(false);
    expect(needsApproval(video, { prompt: "a cat", duration: 10, resolution: "720p" })).toBe(true);
    expect(needsApproval(video, { prompt: "a cat", duration: 4, resolution: "480p", generate_audio: false, model: "bytedance/seedance-2.0-fast" })).toBe(false);
    expect(needsApproval(video, { prompt: "a cat", duration: 2, resolution: "720p", model: "alibaba/wan-2.7" })).toBe(false);
  });

  test("create_image hands its card to TOOL_FINISHED", async () => {
    const { media, store, meter } = await setup();
    const tool = createMediaTools(media).find((t) => t.name === "create_image")!;
    const result = await tool.run({ prompt: "a red fox" }, { signal: new AbortController().signal, ownerId: "owner", runId: "run1", workspaceId: "default", store, meter, log: () => undefined });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/file id up_/);
    expect(takeMediaArtifact("run1", "create_image")).toMatchObject({ kind: "media", media: { status: "done" } });
    expect(takeMediaArtifact("run1", "create_image")).toBeUndefined();
  });

  test("Create-mode chat turn: tool step with the card, a reply naming the file ids", async () => {
    const { media } = await setup();
    const sent: Array<{ type: string }> = [];
    let reply = "";
    await runMediaChatTurn({ media, requestId: "r1", prompt: "a lighthouse", spec: { kind: "image" }, workspaceId: "default", conversationId: "c1", send: (m) => sent.push(m), reply: (text) => (reply = text) });
    expect(sent.map((m) => m.type)).toEqual([WS_EVENTS.TOOL_STARTED, WS_EVENTS.TOOL_FINISHED, WS_EVENTS.LLM_DELTA, WS_EVENTS.LLM_DONE]);
    expect(reply).toMatch(/^Here is the image, made with .*file id up_/);
    expect(replyText({ status: "error", error: "nope" } as never)).toMatch(/Nothing was charged/);
  });

  test("user.text carries a validated media spec", () => {
    const ok = parseClientMessage({ type: "user.text", text: "a fox", media: { kind: "video", model: "bytedance/seedance-2.0", settings: { duration: 5, "bad key": 1 }, references: [{ uploadId: `up_${"a".repeat(24)}`, role: "first_frame", token: "@image1" }] } });
    expect(ok.success && ok.data.type === "user.text" && ok.data.media).toEqual({ kind: "video", model: "bytedance/seedance-2.0", settings: { duration: 5 }, references: [{ uploadId: `up_${"a".repeat(24)}`, role: "first_frame", token: "@image1" }] });
    expect(parseClientMessage({ type: "user.text", text: "x", media: { kind: "gif" } }).success).toBe(false);
  });

  test("routes: chat.use, except the signed reference links", () => {
    expect(protectedRoutePermission("POST", "/api/media")).toEqual({ permission: "chat.use" });
    expect(protectedRoutePermission("GET", "/api/media/models")).toEqual({ permission: "chat.use" });
    expect(protectedRoutePermission("GET", `/api/media/ref/up_${"a".repeat(24)}`)).toBeUndefined();
  });

  test("uploads recognise generated video and audio by their bytes", () => {
    expect(detectType(MP4, "clip.mp4")).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect(detectType(MP3, "voice.mp3")).toMatchObject({ kind: "audio", mime: "audio/mpeg" });
    expect(detectType(Buffer.from("hello"), "fake.mp4")).toBeUndefined();
  });
});
