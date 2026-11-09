import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { LLMMessage, LLMProvider } from "@open-gpt-live/adapters";
import { createMemoryStore, type ToolContext } from "@open-gpt-live/core";
import { WS_EVENTS, parseClientMessage, type ModelCatalog, type ServerMessage } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { historyFromMessages } from "../conversations.js";
import { createGatewayServer, type GatewayServerOptions } from "../gateway.js";
import { createNoopMeter, createTestRuntime, type GatewayRuntime } from "../runtime.js";
import { pickVisionModel, prepareAttachments, supportsVision, withoutImages } from "./attachments.js";
import { extractDocx, extractText, extractXlsx, parseCsv, summariseCsv, summariseJson } from "./extract.js";
import { parseMultipartFile } from "./multipart.js";
import { UploadService, isUploadId } from "./service.js";
import { createUploadTools } from "./tools.js";
import { cleanFileName, detectType } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sibyl-uploads-"));
  dirs.push(dir);
  return dir;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function makePdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Tiny zip writer (deflate, CRC left at 0 — our reader doesn't check it). */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const DOCX = () =>
  makeZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml":
      '<w:document><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Revenue &amp; costs</w:t><w:tab/><w:t>up</w:t></w:r></w:p></w:body></w:document>'
  });

const XLSX = () =>
  makeZip({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/sharedStrings.xml": "<sst><si><t>Region</t></si><si><t>Total</t></si><si><t>North</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42.5</v></c></row></sheetData></worksheet>'
  });

function service(dir = tempDir(), maxBytes = 1024 * 1024) {
  const store = createMemoryStore();
  return { store, uploads: new UploadService({ store, ownerId: "owner", dir, maxBytes }) };
}

describe("type detection and names", () => {
  test("detects by magic bytes, never by the declared type", () => {
    expect(detectType(PNG, "photo.txt")?.mime).toBe("image/png");
    expect(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "a.jpg")?.mime).toBe("image/jpeg");
    expect(detectType(Buffer.from("GIF89a...."), "a.gif")?.mime).toBe("image/gif");
    expect(detectType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "a.webp")?.mime).toBe("image/webp");
    expect(detectType(makePdf("x"), "doc.bin")?.kind).toBe("pdf");
    expect(detectType(DOCX(), "r.docx")?.kind).toBe("docx");
    expect(detectType(XLSX(), "r.xlsx")?.kind).toBe("xlsx");
    expect(detectType(DOCX(), "r.zip")).toBeUndefined();
    expect(detectType(Buffer.from("a,b\n1,2\n"), "data.csv")?.kind).toBe("csv");
    expect(detectType(Buffer.from("<svg onload=alert(1)>"), "x.svg")).toBeUndefined();
    expect(detectType(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), "notes.txt")).toBeUndefined();
    expect(detectType(Buffer.from("<html>"), "page.html")).toBeUndefined();
  });

  test("file names are display-only and stripped of paths", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(cleanFileName("..")).toBe("file");
    expect(cleanFileName("a\u0000b\nc.txt")).toBe("abc.txt");
  });
});

describe("extraction", () => {
  test("PDF text via unpdf", async () => {
    const result = await extractText("pdf", makePdf("Hello Sibyl PDF"));
    expect(result.pages).toBe(1);
    expect(result.text).toContain("Hello Sibyl PDF");
    expect(result.summary).toBe("PDF, 1 page");
  });

  test("CSV summary with headers and first rows", () => {
    expect(parseCsv('name,quote\n"Ada","said ""hi"", twice"\r\nBob,x')).toEqual([
      ["name", "quote"],
      ["Ada", 'said "hi", twice'],
      ["Bob", "x"]
    ]);
    const rows = ["city,temp", ...Array.from({ length: 30 }, (_, i) => `City${i},${i}`)].join("\n");
    const result = summariseCsv(rows);
    expect(result.summary).toBe("CSV, 30 rows × 2 columns");
    expect(result.text).toContain("Columns: city, temp");
    expect(result.text).toContain("City9 | 9");
    expect(result.text).toContain("--- Full content ---");
    expect(result.text).toContain("City29,29");
  });

  test("JSON summary", () => {
    const result = summariseJson(JSON.stringify([{ id: 1, name: "a" }, { id: 2, tags: [] }]));
    expect(result.summary).toBe("JSON array, 2 items, fields: id, name, tags");
    expect(summariseJson('{"a":1,"b":2}').summary).toBe("JSON object, 2 keys: a, b");
    expect(summariseJson("{oops").summary).toMatch(/^JSON \(invalid/);
  });

  test("DOCX and XLSX via the zip reader", () => {
    const docx = extractDocx(DOCX());
    expect(docx.text).toBe("Quarterly report\nRevenue & costs\tup");
    const xlsx = extractXlsx(XLSX());
    expect(xlsx.summary).toBe("Excel workbook, 1 sheet: Sales (2 rows × 3 cols)");
    expect(xlsx.text).toContain("Region,Total\nNorth,,42.5");
  });
});

describe("UploadService", () => {
  test("saves bytes, extracted text and an artifact record; ids are validated", async () => {
    const dir = tempDir();
    const { store, uploads } = service(dir);
    const view = await uploads.save({ data: Buffer.from("a,b\n1,2\n"), filename: "../data.csv" });
    expect(isUploadId(view.id)).toBe(true);
    expect(view).toMatchObject({ name: "data.csv", mime: "text/csv", kind: "csv" });
    expect(readdirSync(join(dir, view.id)).sort()).toEqual(["extracted.txt", "file"]);
    const record = await store.artifacts.get("owner", view.id);
    expect(record).toMatchObject({ kind: "file", title: "data.csv", meta: { name: "data.csv", mime: "text/csv", textPath: "extracted.txt" } });
    expect(await uploads.get(view.id, "someone-else")).toBeUndefined();
    expect(() => uploads.folderFor("../../etc")).toThrow(/Invalid file id/);
    expect(() => uploads.folderFor("up_../../x")).toThrow(/Invalid file id/);
    expect(await uploads.get("../x")).toBeUndefined();
    await expect(uploads.save({ data: Buffer.from("MZ\0\0"), filename: "x.exe" })).rejects.toMatchObject({ status: 415 });
    await expect(uploads.save({ data: Buffer.alloc(0), filename: "x.txt" })).rejects.toMatchObject({ status: 400 });
  });

  test("read_file pages through long text", async () => {
    const { store, uploads } = service();
    const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const view = await uploads.save({ data: Buffer.from(text), filename: "log.txt" });
    const [readFile] = createUploadTools(uploads);
    const context: ToolContext = { signal: new AbortController().signal, ownerId: "owner", runId: "r", store, meter: createNoopMeter(), log() {} };
    const first = await readFile!.run({ id: view.id }, context);
    expect(first.content).toMatch(/characters 0–8000 of \d+ \(continue with offset 8000\)/);
    const second = await readFile!.run({ id: view.id, offset: 8000, length: 100 }, context);
    expect(second.data).toMatchObject({ offset: 8000, end: 8100 });
    const missing = await readFile!.run({ id: "up_000000000000000000000000" }, context);
    expect(missing.isError).toBe(true);
    const other = await readFile!.run({ id: view.id }, { ...context, ownerId: "intruder" });
    expect(other.isError).toBe(true);
  });
});

test("multipart parser returns the file part", () => {
  const boundary = "----sibyl";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const part = parseMultipartFile(body, boundary);
  expect(part?.filename).toBe("a.png");
  expect(part?.data.equals(PNG)).toBe(true);
});

// ── HTTP ──

async function withGateway(
  run: (input: { base: string; port: number; runtime: GatewayRuntime; uploads: UploadService }) => Promise<void>,
  extra: Partial<GatewayServerOptions> = {},
  maxBytes = 64 * 1024
): Promise<void> {
  const runtime = createTestRuntime();
  const uploads = new UploadService({ store: runtime.store, ownerId: runtime.ownerId, dir: tempDir(), maxBytes });
  const gateway = await createGatewayServer({
    providers: { llm: { async *streamText() { yield { delta: "ok" }; } }, stt: { async transcribe() { return { text: "" }; } } },
    host: "127.0.0.1",
    env: {},
    uploads,
    ...extra,
    runtime
  });
  try {
    await run({ base: `http://127.0.0.1:${gateway.port}`, port: gateway.port, runtime, uploads });
  } finally {
    await gateway.close();
  }
}

describe("POST/GET /api/uploads", () => {
  test("auth, CORS, size and type limits; download with auth", async () => {
    await withGateway(
      async ({ base }) => {
        const post = (headers: Record<string, string>, body: BodyInit) => fetch(`${base}/api/uploads`, { method: "POST", headers, body });
        const auth = { Authorization: "Bearer tok", Origin: "http://localhost:3000" };

        expect((await post({ "X-Filename": "a.png" }, PNG)).status).toBe(401);
        expect((await post({ "X-Filename": "a.png", Authorization: "Bearer wrong" }, PNG)).status).toBe(401);
        expect((await post({ ...auth, Origin: "https://evil.example", "X-Filename": "a.png" }, PNG)).status).toBe(403);

        const preflight = await fetch(`${base}/api/uploads`, {
          method: "OPTIONS",
          headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" }
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
        expect(preflight.headers.get("access-control-allow-headers")).toMatch(/authorization/);

        const big = await post({ ...auth, "X-Filename": "big.txt" }, Buffer.alloc(70 * 1024, 97));
        expect(big.status).toBe(413);

        const exe = await post({ ...auth, "X-Filename": "tool.exe" }, Buffer.from([0x4d, 0x5a, 0, 1]));
        expect(exe.status).toBe(415);

        const created = await post({ ...auth, "X-Filename": encodeURIComponent("my photo.png"), "Content-Type": "image/png" }, PNG);
        expect(created.status).toBe(201);
        expect(created.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
        const { upload } = (await created.json()) as { upload: { id: string; name: string; mime: string } };
        expect(upload).toMatchObject({ name: "my photo.png", mime: "image/png" });

        expect((await fetch(`${base}/api/uploads/${upload.id}`)).status).toBe(401);
        const download = await fetch(`${base}/api/uploads/${upload.id}`, { headers: { Authorization: "Bearer tok" } });
        expect(download.status).toBe(200);
        expect(download.headers.get("content-type")).toBe("image/png");
        expect(download.headers.get("x-content-type-options")).toBe("nosniff");
        expect(Buffer.from(await download.arrayBuffer()).equals(PNG)).toBe(true);
        // ?token= works too (same as the WebSocket).
        expect((await fetch(`${base}/api/uploads/${upload.id}?token=tok`)).status).toBe(200);

        // Path traversal and unknown ids never reach the filesystem.
        for (const path of ["..%2F..%2Fetc%2Fpasswd", "up_..", "%2E%2E", "up_000000000000000000000000"]) {
          const response = await fetch(`${base}/api/uploads/${path}`, { headers: { Authorization: "Bearer tok" } });
          expect(response.status).toBe(404);
        }
      },
      { ownerToken: "tok", allowedOrigins: ["http://localhost:3000"] }
    );
  });

  test("multipart upload of a PDF extracts its text", async () => {
    await withGateway(async ({ base, uploads }) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(makePdf("Invoice total 42 EUR"))], { type: "application/pdf" }), "invoice.pdf");
      const response = await fetch(`${base}/api/uploads`, { method: "POST", body: form });
      expect(response.status).toBe(201);
      const { upload } = (await response.json()) as { upload: { id: string; summary: string } };
      expect(upload.summary).toBe("PDF, 1 page");
      expect(await uploads.readText(upload.id)).toContain("Invoice total 42 EUR");
    });
  });
});

// ── Attachments through the protocol to the model ──

test("protocol: user.text attachments are strictly validated and optional", () => {
  const ok = parseClientMessage({ type: "user.text", text: "", attachments: [{ id: "up_abc", name: "a.png", mime: "image/png", size: 3 }] });
  expect(ok.success && ok.data.type === "user.text" && ok.data.attachments).toEqual([{ id: "up_abc", name: "a.png", mime: "image/png", size: 3 }]);
  const legacy = parseClientMessage({ type: "user.text", text: "hi" });
  expect(legacy.success && legacy.data.type === "user.text" && "attachments" in legacy.data).toBe(false);
  for (const attachments of [
    "nope",
    [{ id: "../x", name: "a", mime: "image/png" }],
    [{ id: "up_a", name: "", mime: "image/png" }],
    [{ id: "up_a", name: "a", mime: "image/png", size: -1 }],
    Array.from({ length: 11 }, (_, i) => ({ id: `up_${i}`, name: "a", mime: "text/plain" }))
  ]) {
    expect(parseClientMessage({ type: "user.text", text: "x", attachments }).success).toBe(false);
  }
});

test("vision helpers", () => {
  expect(supportsVision("openai/gpt-4o-mini")).toBe(true);
  expect(supportsVision("google/gemini-2.5-flash")).toBe(true);
  expect(supportsVision("anthropic/claude-sonnet-4.5")).toBe(true);
  expect(supportsVision("deepseek/deepseek-chat-v3")).toBe(false);
  expect(supportsVision("openai/gpt-4o-audio-preview")).toBe(false);
  expect(pickVisionModel("openai/gpt-4o", [], {})).toEqual({ model: "openai/gpt-4o", switched: false });
  expect(pickVisionModel("deepseek/deepseek-chat", ["x/y", "google/gemini-2.5-flash"], {})).toEqual({ model: "google/gemini-2.5-flash", switched: true });
  expect(pickVisionModel("deepseek/deepseek-chat", ["google/gemini-2.5-flash"], { SIBYL_VISION_MODEL: "qwen/qwen2.5-vl-72b" })?.model).toBe("qwen/qwen2.5-vl-72b");
  expect(pickVisionModel("deepseek/deepseek-chat", ["x/y"], {})).toBeUndefined();
  const content = [{ type: "text" as const, text: "look" }, { type: "image_url", image_url: { url: "data:," } }] as unknown as LLMMessage["content"];
  expect(withoutImages(content)).toBe("look\n(The image was shown with this message.)");
});

test("prepareAttachments puts file text in the turn and images as image_url parts", async () => {
  const { uploads } = service();
  const csv = await uploads.save({ data: Buffer.from("a,b\n1,2\n"), filename: "t.csv" });
  const png = await uploads.save({ data: PNG, filename: "p.png" });
  const prepared = await prepareAttachments(uploads, "what is this?", [
    { id: csv.id, name: "evil-name-from-client", mime: "text/html" },
    { id: png.id, name: "p.png", mime: "image/png" },
    { id: "up_000000000000000000000000", name: "ghost", mime: "text/plain" }
  ]);
  expect(prepared.missing).toEqual(["up_000000000000000000000000"]);
  expect(prepared.refs.map((ref) => ref.name)).toEqual(["t.csv", "p.png"]);
  expect(prepared.refs[0]!.mime).toBe("text/csv");
  const [text, image] = prepared.content as unknown as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  expect(text!.text).toMatch(/^what is this\?\n\n\[Attached files\]\n- t\.csv \(file id up_/);
  expect(text!.text).toContain("Columns: a, b");
  expect(image!.type).toBe("image_url");
  expect(image!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
});

const catalog: ModelCatalog = {
  llm: [
    { id: "text/only", label: "Text" },
    { id: "google/gemini-2.5-flash", label: "Gemini" }
  ],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: []
};

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: ServerMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise((resolve) => socket.once("open", resolve));
  const waitFor = async (predicate: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
    for (let i = 0; i < 300; i += 1) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  return { socket, messages, waitFor, send: (m: unknown) => socket.send(JSON.stringify(m)) };
}

test("an image attachment reaches a vision model as an image part; history and storage keep references", async () => {
  const calls: Array<{ model?: string; messages: LLMMessage[] }> = [];
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      calls.push({ model: options?.model, messages: structuredClone(messages) });
      yield { delta: "A tiny image." };
    }
  };
  await withGateway(
    async ({ port, runtime, uploads }) => {
      const png = await uploads.save({ data: PNG, filename: "dot.png" });
      const notes = await uploads.save({ data: Buffer.from("# Notes\nRemember the milk."), filename: "notes.md" });
      const client = await connect(port);
      try {
        await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
        client.send({
          type: WS_EVENTS.USER_TEXT,
          requestId: "r1",
          text: "",
          attachments: [
            { id: png.id, name: "dot.png", mime: "image/png", size: PNG.length },
            { id: notes.id, name: "notes.md", mime: "text/markdown" }
          ]
        });
        await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "r1");

        // The text-only chat model was swapped for a vision model, with a step row saying so.
        expect(calls[0]!.model).toBe("google/gemini-2.5-flash");
        const step = client.messages.find((m) => m.type === WS_EVENTS.TOOL_STARTED && m.callId === "vision-r1") as { title: string } | undefined;
        expect(step?.title).toBe("Looking at the image with google/gemini-2.5-flash");
        expect(client.messages.some((m) => m.type === WS_EVENTS.TOOL_STARTED && m.title === "Read notes.md")).toBe(true);

        const user = calls[0]!.messages.at(-1)!;
        const parts = user.content as unknown as Array<{ type: string; text?: string; image_url?: { url: string } }>;
        expect(parts[0]!.text).toContain("Remember the milk.");
        expect(parts[1]!.type).toBe("image_url");
        expect(parts[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/);

        // Next turn: the image is no longer re-sent; the text reference stays.
        client.send({ type: WS_EVENTS.USER_TEXT, requestId: "r2", text: "thanks" });
        await client.waitFor((m) => m.type === WS_EVENTS.LLM_DONE && m.requestId === "r2");
        expect(calls[1]!.model).toBe("text/only");
        const earlier = calls[1]!.messages.find((m) => m.role === "user")!;
        expect(typeof earlier.content).toBe("string");
        expect(earlier.content).toMatch(/The image was shown with this message/);

        // Stored conversation keeps attachment references (not file text).
        await new Promise((r) => setTimeout(r, 50));
        const [summary] = await runtime.store.conversations.list(runtime.ownerId);
        expect(summary!.title).toBe("dot.png, notes.md");
        const record = await runtime.store.conversations.get(runtime.ownerId, summary!.id);
        const stored = record!.messages[0] as unknown as { content: string; attachments: Array<{ id: string; name: string }> };
        expect(stored.content).toBe("");
        expect(stored.attachments.map((a) => a.name)).toEqual(["dot.png", "notes.md"]);
        const history = historyFromMessages(record!.messages);
        expect(history[0]!.content).toMatch(/\[Attached: dot\.png \(file id up_[a-f0-9]+\), notes\.md/);
      } finally {
        client.socket.close();
      }
    },
    {
      providers: { llm, stt: { async transcribe() { return { text: "" }; } } },
      modelCatalog: catalog,
      defaultSettings: { llmModel: "text/only", sttModel: "stt/x" }
    }
  );
});

test("uploads default under $SIBYL_DATA_DIR/uploads", async () => {
  const dir = tempDir();
  const { uploadOptionsFromEnv } = await import("./service.js");
  expect(uploadOptionsFromEnv({ SIBYL_DATA_DIR: dir, SIBYL_UPLOAD_MAX_MB: "2" })).toEqual({ dir: join(dir, "uploads"), maxBytes: 2 * 1024 * 1024 });
  expect(uploadOptionsFromEnv({}).maxBytes).toBe(20 * 1024 * 1024);
  assert.equal(existsSync(join(dir, "uploads")), false);
});
