import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type UsageMeter } from "@open-gpt-live/core";
import { afterEach, expect, test } from "vitest";
import { UploadService } from "../uploads/service.js";
import { MediaCatalog, type MediaModelEntry } from "./catalog.js";
import type { MediaClient } from "./client.js";
import { MediaService } from "./service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(32)]);

/** Wan 2.7 billed a 2 s clip as $0.50 (listed $0.10/s): later estimates for it are raised. */
test("estimates learn from what a model actually charged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sibyl-media-cal-"));
  dirs.push(dir);
  const store = createMemoryStore();
  const wan: MediaModelEntry = {
    id: "alibaba/wan-2.7",
    name: "Wan 2.7",
    kind: "video",
    params: [{ key: "duration", label: "Duration", type: "enum", values: [2, 5, 10], default: 5 }],
    references: { images: 5, videos: 0, audio: 0, frames: ["first_frame"], syntax: "wan" },
    priceLabel: "$0.1 / s",
    pricing: { kind: "video", skus: { duration_seconds: 0.1 } },
    inputs: ["text", "image"]
  };
  let polls = 0;
  const client: MediaClient = {
    getJson: async () => ({ data: [] }),
    images: async () => ({ images: [] }),
    submitVideo: async () => ({ id: "job" }),
    pollVideo: async () => (++polls > 1 ? { status: "completed", outputs: 1, costUsd: 0.5 } : { status: "in_progress", outputs: 0 }),
    videoContent: async () => ({ data: MP4, mime: "video/mp4" }),
    speech: async () => ({ data: MP4, mime: "audio/mpeg" }),
    music: async () => ({ data: MP4, mime: "audio/mpeg", text: "" }),
    generationCost: async () => undefined
  };
  const catalog = new MediaCatalog({ client });
  catalog.set([wan]);
  const meter: UsageMeter = { record: () => undefined, totals: () => ({ todayUsd: 0, monthUsd: 0, byFeature: {} }), check: () => ({ allowed: true }), limits: () => ({}) };
  const uploads = new UploadService({ store, ownerId: "owner", dir, maxBytes: 1024 * 1024 });
  const media = new MediaService({ store, ownerId: "owner", meter, uploads, catalog, client, pollMs: 2 });
  const scope = { ownerId: "owner", workspaceId: "default" };
  expect((await media.estimate(scope, { kind: "video", model: wan.id, settings: { duration: 2 } })).usd).toBeCloseTo(0.2, 5);
  const item = await media.create({ kind: "video", model: wan.id, prompt: "snow", settings: { duration: 2 }, workspaceId: "default" });
  for (let i = 0; i < 200 && (await media.get(scope, item.id))?.status !== "done"; i += 1) await new Promise((resolve) => setTimeout(resolve, 3));
  expect((await media.get(scope, item.id))?.costUsd).toBe(0.5);
  const next = await media.estimate(scope, { kind: "video", model: wan.id, settings: { duration: 2 } });
  expect(next.usd).toBeCloseTo(0.5, 5);
  expect(next.detail).toMatch(/what OpenRouter charged before/);
  // A new gateway learns it from the library.
  const again = new MediaService({ store, ownerId: "owner", meter, uploads, catalog, client, pollMs: 2 });
  await again.resume();
  expect((await again.estimate(scope, { kind: "video", model: wan.id, settings: { duration: 2 } })).usd).toBeCloseTo(0.5, 5);
});
