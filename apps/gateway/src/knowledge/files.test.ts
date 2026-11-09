/**
 * Knowledge from every file type: one document per file, ZIPs expanded,
 * images and scanned PDFs read by the OCR model (the provider is faked at the
 * HTTP boundary; the files and parsers are real).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type BudgetDecision, type UsageEvent, type UsageMeter } from "@open-gpt-live/core";
import type { ModelCatalog } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { UploadService } from "../uploads/service.js";
import { makeEml, makeEpub, makeImagePdf, makePdf, makePptx, makeXlsx, makeZip } from "../uploads/test-files.js";
import { OcrClient, pickOcrModel } from "./ocr.js";
import { KnowledgeService } from "./service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

class TestMeter implements UsageMeter {
  readonly events: Array<Omit<UsageEvent, "id" | "at">> = [];
  blocked: string | undefined;
  record(event: Omit<UsageEvent, "id" | "at">): void {
    this.events.push(event);
  }
  totals() {
    return { todayUsd: 0, monthUsd: 0, byFeature: {} };
  }
  check(): BudgetDecision {
    return this.blocked ? { allowed: false, scope: "daily", message: this.blocked } : { allowed: true };
  }
  limits() {
    return {};
  }
}

interface Call {
  body: { model: string; plugins?: Array<{ id: string; pdf: { engine: string } }>; messages: Array<{ content: Array<{ type: string }> }> };
}

/** A fake OpenRouter chat endpoint: answers by what the request carries. */
function provider(handler: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const call = { body: JSON.parse(String(init.body)) as Call["body"] };
    calls.push(call);
    const reply = handler(call);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

const reply = (content: string, cost: number, annotations?: unknown) => ({
  json: { choices: [{ message: { content, ...(annotations ? { annotations } : {}) } }], usage: { prompt_tokens: 900, completion_tokens: 60, cost } }
});

const CATALOG: ModelCatalog = {
  llm: [
    { id: "openai/gpt-4o", label: "GPT-4o", costPer100Turns: 9 },
    { id: "google/gemini-2.5-flash-lite", label: "Flash Lite", costPer100Turns: 0.4 },
    { id: "deepseek/deepseek-chat", label: "DeepSeek", costPer100Turns: 0.1 }
  ],
  stt: [],
  tts: []
} as unknown as ModelCatalog;

function setup(options: { fetch?: ReturnType<typeof provider>["fetch"]; ocr?: boolean; catalog?: ModelCatalog } = {}) {
  const store = createMemoryStore();
  const dir = mkdtempSync(join(tmpdir(), "sibyl-kbfiles-"));
  dirs.push(dir);
  const meter = new TestMeter();
  const uploads = new UploadService({ store, ownerId: "owner", dir, maxBytes: 2 * 1024 * 1024 });
  const ocr =
    options.ocr === false
      ? undefined
      : new OcrClient({ baseUrl: "https://openrouter.test/api/v1", apiKey: "test", meter, ownerId: "owner", env: {}, ...(options.fetch ? { fetch: options.fetch } : {}) });
  ocr?.useCatalog(() => options.catalog ?? CATALOG);
  const knowledge = new KnowledgeService({ store, ownerId: "owner", meter, uploads, ...(ocr ? { ocr } : {}) });
  return { knowledge, uploads, meter };
}

async function addFile(ctx: ReturnType<typeof setup>, baseId: string, data: Buffer, filename: string) {
  const upload = await ctx.uploads.save({ data, filename, workspaceId: "default" });
  const result = await ctx.knowledge.addDocs("default", baseId, { kind: "upload", uploadId: upload.id });
  await ctx.knowledge.idle();
  return result;
}

async function onlyDoc(ctx: ReturnType<typeof setup>, baseId: string) {
  const { docs } = await ctx.knowledge.getBase("default", baseId);
  return docs[0]!;
}

describe("OCR model choice", () => {
  test("config override first, else the cheapest vision-capable model in the catalog", () => {
    expect(pickOcrModel({ SIBYL_OCR_MODEL: "x/ocr" }, CATALOG)).toBe("x/ocr");
    expect(pickOcrModel({ SIBYL_VISION_MODEL: "x/vision" }, CATALOG)).toBe("x/vision");
    // deepseek-chat is cheaper but can't see images.
    expect(pickOcrModel({}, CATALOG)).toBe("google/gemini-2.5-flash-lite");
    expect(pickOcrModel({}, { llm: [{ id: "deepseek/deepseek-chat", label: "d" }], stt: [], tts: [] } as unknown as ModelCatalog)).toBeUndefined();
  });

  test("with OpenRouter model data: input modalities decide vision, token prices decide cost", () => {
    const info = (id: string) =>
      ({
        "openai/gpt-4o": { id, architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.0000025", completion: "0.00001" } },
        "google/gemini-2.5-flash-lite": { id, architecture: { input_modalities: ["text"] }, pricing: { prompt: "0.0000001", completion: "0.0000004" } },
        "deepseek/deepseek-chat": { id, architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.0000003", completion: "0.000001" } }
      })[id];
    expect(pickOcrModel({}, CATALOG, info)).toBe("deepseek/deepseek-chat");
  });
});

describe("images in knowledge", () => {
  test("an image gets a transcription and description, metered as knowledge_ocr, cached for re-indexing", async () => {
    const api = provider(() => reply("Text in the image:\nFalcon launch moves to Tuesday\n\nDescription: A whiteboard with notes.", 0.00031));
    const ctx = setup({ fetch: api.fetch });
    const base = await ctx.knowledge.createBase("default", { name: "Photos" });
    await addFile(ctx, base.id, PNG, "whiteboard.png");
    const doc = await onlyDoc(ctx, base.id);
    expect(doc).toMatchObject({ status: "ready", fileKind: "image", ocr: { model: "google/gemini-2.5-flash-lite", costUsd: 0.00031, estimated: false } });
    expect(api.calls[0]!.body.model).toBe("google/gemini-2.5-flash-lite");
    expect(api.calls[0]!.body.messages[0]!.content.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(ctx.meter.events).toEqual([expect.objectContaining({ feature: "knowledge_ocr", model: "google/gemini-2.5-flash-lite", costUsd: 0.00031, estimated: false, promptTokens: 900 })]);
    const hits = await ctx.knowledge.search("default", "falcon launch Tuesday");
    expect(hits.hits[0]).toMatchObject({ docTitle: "whiteboard.png" });
    expect(hits.hits[0]!.snippet).toContain("whiteboard with notes");

    await ctx.knowledge.reindexDoc("default", base.id, doc.id);
    await ctx.knowledge.idle();
    expect(api.calls).toHaveLength(1);
    expect((await onlyDoc(ctx, base.id)).ocr?.costUsd).toBe(0.00031);
  });

  test("budget blocked: the document fails with the reason and nothing is sent", async () => {
    const api = provider(() => reply("never", 1));
    const ctx = setup({ fetch: api.fetch });
    ctx.meter.blocked = "Daily budget reached ($1.00 of $1.00).";
    const base = await ctx.knowledge.createBase("default", { name: "Photos" });
    await addFile(ctx, base.id, PNG, "receipt.png");
    const doc = await onlyDoc(ctx, base.id);
    expect(doc.status).toBe("failed");
    expect(doc.error).toBe("Budget reached, so the image was not read. Daily budget reached ($1.00 of $1.00).");
    expect(api.calls).toHaveLength(0);
  });

  test("no vision model: a clear reason; OCR switched off: images are refused up front", async () => {
    const ctx = setup({ fetch: provider(() => reply("x", 0)).fetch, catalog: { llm: [], stt: [], tts: [] } as unknown as ModelCatalog });
    const base = await ctx.knowledge.createBase("default", { name: "Photos" });
    await addFile(ctx, base.id, PNG, "a.png");
    expect((await onlyDoc(ctx, base.id)).error).toMatch(/No vision model.*SIBYL_OCR_MODEL/);

    const off = setup({ ocr: false });
    const offBase = await off.knowledge.createBase("default", { name: "Photos" });
    const upload = await off.uploads.save({ data: PNG, filename: "a.png", workspaceId: "default" });
    await expect(off.knowledge.addDocs("default", offBase.id, { kind: "upload", uploadId: upload.id })).rejects.toMatchObject({ status: 415 });
  });
});

describe("scanned PDFs in knowledge", () => {
  const scanned = makeImagePdf(JPEG, 1, 1);

  test("OpenRouter's file parser (mistral-ocr) reads it; the parsed text comes from the annotation", async () => {
    const api = provider(() =>
      reply("OK", 0.0020038, [
        { type: "file", file: { hash: "h", name: "scan.pdf", content: [{ type: "text", text: '<file name="scan.pdf">' }, { type: "text", text: "The magenta lighthouse protocol requires two inspectors." }, { type: "text", text: "</file>" }] } }
      ])
    );
    const ctx = setup({ fetch: api.fetch });
    const base = await ctx.knowledge.createBase("default", { name: "Scans" });
    await addFile(ctx, base.id, scanned, "audit.pdf");
    const doc = await onlyDoc(ctx, base.id);
    expect(doc).toMatchObject({ status: "ready", fileKind: "pdf", parts: { unit: "page", count: 1 }, ocr: { engine: "mistral-ocr", costUsd: 0.0020038 } });
    expect(api.calls[0]!.body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "mistral-ocr" } }]);
    expect(api.calls[0]!.body.messages[0]!.content.map((part) => part.type)).toEqual(["text", "file"]);
    expect((await ctx.knowledge.search("default", "magenta lighthouse")).hits).toHaveLength(1);
  });

  test("falls back to the model reading the PDF when the parser fails", async () => {
    const api = provider((call) =>
      call.body.plugins?.[0]?.pdf.engine === "mistral-ocr" ? { status: 502, json: { error: { message: "parser down" } } } : reply("--- Page 1 ---\nCobalt valve inspection", 0.0004)
    );
    const ctx = setup({ fetch: api.fetch });
    const base = await ctx.knowledge.createBase("default", { name: "Scans" });
    await addFile(ctx, base.id, scanned, "valve.pdf");
    const doc = await onlyDoc(ctx, base.id);
    expect(doc).toMatchObject({ status: "ready", ocr: { engine: "native", costUsd: 0.0004 } });
    expect(api.calls.map((call) => call.body.plugins?.[0]?.pdf.engine)).toEqual(["mistral-ocr", "native"]);
    expect((await ctx.knowledge.search("default", "cobalt valve")).hits[0]?.label).toBe("Page 1");
  });

  test("both fail: the document fails with both reasons", async () => {
    const api = provider(() => ({ status: 400, json: { error: { message: "no file input" } } }));
    const ctx = setup({ fetch: api.fetch });
    const base = await ctx.knowledge.createBase("default", { name: "Scans" });
    await addFile(ctx, base.id, scanned, "x.pdf");
    const doc = await onlyDoc(ctx, base.id);
    expect(doc.status).toBe("failed");
    expect(doc.error).toMatch(/scanned PDF could not be read \(mistral-ocr: HTTP 400: no file input; native: HTTP 400: no file input\)/);
  });

  test("a PDF with a text layer never calls the model", async () => {
    const api = provider(() => reply("x", 1));
    const ctx = setup({ fetch: api.fetch });
    const base = await ctx.knowledge.createBase("default", { name: "Docs" });
    await addFile(ctx, base.id, makePdf(["Quarterly report for the saffron project"]), "r.pdf");
    expect((await onlyDoc(ctx, base.id)).status).toBe("ready");
    expect(api.calls).toHaveLength(0);
  });
});

describe("bulk: ZIP archives", () => {
  test("each supported file becomes its own searchable document; the rest are listed as skipped", async () => {
    const api = provider(() => reply("Text in the image:\nOwner: Priya\n\nDescription: a sticky note.", 0.0002));
    const ctx = setup({ fetch: api.fetch });
    const base = await ctx.knowledge.createBase("default", { name: "Handbook" });
    const zip = makeZip({
      "handbook/intro.md": "# Intro\nThe saffron gate opens at nine.",
      "handbook/deck.pptx": makePptx([{ text: ["Quarterly review"], notes: ["Remember the orchid budget"] }]),
      "handbook/prices.xlsx": makeXlsx([{ name: "Prices", rows: [["Item", "Price"], ["Teal kettle", 42]] }]),
      "handbook/book.epub": makeEpub("Guide", [{ title: "Owls", text: "Barn owls hunt at dusk." }]),
      "handbook/mail.eml": makeEml({ from: "a@example.com", to: "b@example.com", subject: "Launch", text: "Launch moves to Thursday." }),
      "handbook/note.png": PNG,
      "handbook/old.doc": Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]),
      "handbook/.env": "SECRET=1"
    });
    const result = await addFile(ctx, base.id, zip, "handbook.zip");
    expect(result.docs.map((doc) => doc.title)).toEqual(["handbook/intro.md", "handbook/deck.pptx", "handbook/prices.xlsx", "handbook/book.epub", "handbook/mail.eml", "handbook/note.png"]);
    expect(result.skipped).toEqual([
      { name: "handbook/old.doc", reason: "Old .doc Office files can't be read. Open it and save as .docx, then upload that." },
      { name: "handbook/.env", reason: "Files that usually hold secrets (.env, private keys, credentials) are never accepted." }
    ]);
    const { docs } = await ctx.knowledge.getBase("default", base.id);
    expect(docs.every((doc) => doc.status === "ready")).toBe(true);
    expect(docs.find((doc) => doc.fileKind === "pptx")?.parts).toEqual({ unit: "slide", count: 1 });
    for (const [query, title] of [
      ["orchid budget", "handbook/deck.pptx"],
      ["teal kettle", "handbook/prices.xlsx"],
      ["barn owls", "handbook/book.epub"],
      ["launch thursday", "handbook/mail.eml"],
      ["saffron gate", "handbook/intro.md"],
      ["Priya", "handbook/note.png"]
    ]) {
      expect((await ctx.knowledge.search("default", query!)).hits[0]?.docTitle, query).toBe(title);
    }
    expect((await ctx.knowledge.search("default", "orchid")).hits[0]?.label).toBe("Slide 1");
  });

  test("a ZIP with nothing usable is refused with the reasons", async () => {
    const ctx = setup({ ocr: false });
    const base = await ctx.knowledge.createBase("default", { name: "x" });
    const upload = await ctx.uploads.save({ data: makeZip({ "a.exe": Buffer.from([0x4d, 0x5a, 0, 0]) }), filename: "a.zip", workspaceId: "default" });
    await expect(ctx.knowledge.addDocs("default", base.id, { kind: "upload", uploadId: upload.id })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("a.exe: Unsupported file type (.exe)")
    });
  });

  test("files inside a ZIP respect the per-file upload limit", async () => {
    const ctx = setup({ ocr: false });
    const base = await ctx.knowledge.createBase("default", { name: "x" });
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const result = await addFile(ctx, base.id, makeZip({ "big.txt": big, "ok.txt": "fine" }), "a.zip");
    expect(result.docs.map((doc) => doc.title)).toEqual(["ok.txt"]);
    expect(result.skipped).toEqual([{ name: "big.txt", reason: "larger than 2 MB" }]);
  });
});
