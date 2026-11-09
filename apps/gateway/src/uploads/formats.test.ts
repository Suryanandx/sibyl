import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@open-gpt-live/core";
import { ACCEPTED_FILE_EXTENSIONS, FILE_FORMATS, isSecretFileName } from "@open-gpt-live/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { chunkText } from "../knowledge/chunk.js";
import { readArchive } from "./archive.js";
import { extractText, looksScanned, rtfToText } from "./extract.js";
import { UploadService } from "./service.js";
import { makeDocx, makeEml, makeEpub, makeImagePdf, makeOdp, makeOds, makeOdt, makePdf, makePptx, makeRtf, makeXlsx, makeZip } from "./test-files.js";
import { detectType, refusalFor } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function uploads(maxBytes = 1024 * 1024): UploadService {
  const dir = mkdtempSync(join(tmpdir(), "sibyl-formats-"));
  dirs.push(dir);
  return new UploadService({ store: createMemoryStore(), ownerId: "owner", dir, maxBytes });
}

/** Detect + extract, as the upload pipeline does. */
async function read(data: Buffer, name: string) {
  const type = detectType(data, name);
  expect(type, `${name} should be accepted`).toBeDefined();
  return { type: type!, ...(await extractText(type!.kind, data, name)) };
}

describe("one list of formats", () => {
  test("every accepted extension maps to exactly one format, and the list has no duplicates", () => {
    expect(new Set(ACCEPTED_FILE_EXTENSIONS).size).toBe(ACCEPTED_FILE_EXTENSIONS.length);
    for (const ext of [".pptx", ".odt", ".ods", ".odp", ".epub", ".html", ".htm", ".rtf", ".eml", ".tsv", ".yaml", ".xml", ".toml", ".ini", ".py", ".tsx", ".zip"]) {
      expect(ACCEPTED_FILE_EXTENSIONS).toContain(ext);
    }
    expect(FILE_FORMATS.find((format) => format.ext === ".rs")).toMatchObject({ kind: "code", label: "Rust" });
  });

  test("secret files are never accepted, whatever they contain", () => {
    for (const name of [".env", ".env.local", "prod.env", "id_rsa", "server.pem", "tls.key", "credentials.json", "secrets.yaml", ".npmrc", "my-service-account.json"]) {
      expect(isSecretFileName(name), name).toBe(true);
      expect(detectType(Buffer.from("API_KEY=abc\n"), name), name).toBeUndefined();
      expect(refusalFor(Buffer.from("x"), name)).toMatch(/secrets/);
    }
    expect(isSecretFileName("environment.md")).toBe(false);
    expect(isSecretFileName("keyboard.json")).toBe(false);
  });

  test("old binary Office files are refused with a save-as hint", async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    for (const [name, modern] of [["budget.xls", ".xlsx"], ["memo.doc", ".docx"], ["deck.ppt", ".pptx"]] as const) {
      expect(detectType(ole, name)).toBeUndefined();
      expect(refusalFor(ole, name)).toContain(`save as ${modern}`);
      await expect(uploads().save({ data: ole, filename: name })).rejects.toMatchObject({ status: 415, message: expect.stringContaining(modern) });
    }
  });

  test("a ZIP container must carry a ZIP-based extension; binary text files are refused", () => {
    const zip = makeZip({ "a.txt": "hi" });
    expect(detectType(zip, "a.zip")?.kind).toBe("zip");
    expect(detectType(zip, "a.txt")).toBeUndefined();
    expect(detectType(Buffer.from([0x00, 0x01, 0x02, 0x03]), "a.py")).toBeUndefined();
  });
});

describe("office, OpenDocument and EPUB", () => {
  test("PPTX: slides in presentation order with speaker notes and Slide markers", async () => {
    const deck = makePptx(
      [
        { text: ["Roadmap", "Ship the falcon tracker"], notes: ["Mention the orchid budget"] },
        { text: ["Welcome"], notes: ["Say hello"] },
        { text: ["Thanks"] }
      ],
      [2, 1, 3]
    );
    const result = await read(deck, "deck.pptx");
    expect(result.type.kind).toBe("pptx");
    expect(result.parts).toEqual({ unit: "slide", count: 3 });
    expect(result.summary).toBe("PowerPoint, 3 slides, speaker notes on 2");
    expect(result.text.indexOf("Welcome")).toBeLessThan(result.text.indexOf("Roadmap"));
    expect(result.text).toContain("--- Slide 2 ---\nRoadmap\nShip the falcon tracker\nSpeaker notes:\nMention the orchid budget");
    // Slide-number fields in notes are dropped.
    expect(result.text).not.toMatch(/Say hello\n\d/);
    // Slide markers become citation labels.
    const chunks = chunkText(result.text.replace("Ship the falcon", `${"Long text. ".repeat(80)}Ship the falcon`), { maxTokens: 60, overlapTokens: 0 });
    expect(chunks[0]!.label).toBe("Slide 1");
    expect(chunks.find((chunk) => chunk.text.includes("orchid"))?.label).toBe("Slide 2");
  });

  test("ODT, ODS and ODP", async () => {
    const odt = await read(makeOdt([{ heading: "Onboarding" }, { text: "Badges are collected at the north desk." }]), "guide.odt");
    expect(odt.text).toBe("# Onboarding\nBadges are collected at the north desk.");

    const ods = await read(makeOds([{ name: "Q3", rows: [["Region", "Revenue"], ["North", "1200"]] }, { name: "Notes", rows: [["teal kettle"]] }]), "sales.ods");
    expect(ods.parts).toEqual({ unit: "sheet", count: 2 });
    expect(ods.text).toContain("--- Sheet: Q3 ---\nRegion,Revenue\nNorth,1200");
    expect(ods.text).toContain("--- Sheet: Notes ---\nteal kettle");
    // A million repeated empty rows/columns don't blow up the text.
    expect(ods.text.length).toBeLessThan(500);

    const odp = await read(makeOdp([{ text: ["Kickoff"], notes: ["Remember the cobalt deadline"] }, { text: ["Plan"] }]), "talk.odp");
    expect(odp.parts).toEqual({ unit: "slide", count: 2 });
    expect(odp.text).toContain("--- Slide 1 ---\nKickoff\nSpeaker notes:\nRemember the cobalt deadline");
  });

  test("EPUB chapters follow the spine, not file names", async () => {
    const book = await read(makeEpub("Field Guide", [{ title: "Herons", text: "Grey herons wade." }, { title: "Owls", text: "Barn owls hunt at dusk." }]), "guide.epub");
    expect(book.parts).toEqual({ unit: "chapter", count: 2 });
    expect(book.summary).toBe('EPUB book "Field Guide", 2 chapters');
    expect(book.text.indexOf("Herons")).toBeLessThan(book.text.indexOf("Owls"));
    expect(book.text).toContain("--- Chapter 2 ---");
  });

  test("DOCX and XLSX built by the test writer still read (with real CRCs)", async () => {
    expect((await read(makeDocx(["Alpha", "Beta"]), "a.docx")).text).toBe("Alpha\nBeta");
    const xlsx = await read(makeXlsx([{ name: "Prices", rows: [["Item", "Price"], ["Lamp", 42]] }]), "p.xlsx");
    expect(xlsx.parts).toEqual({ unit: "sheet", count: 1 });
    expect(xlsx.text).toContain("Lamp,42");
  });
});

describe("web, rich text, email, data and code", () => {
  test("HTML uses the read_webpage converter", async () => {
    const html = await read(Buffer.from("<html><head><title>Wiki</title><script>x()</script></head><body><h2>Setup</h2><p>Install the &amp; tool.</p></body></html>"), "page.htm");
    expect(html.type.kind).toBe("html");
    expect(html.text).toBe("# Wiki\n\n## Setup\nInstall the & tool.");
  });

  test("RTF: control words, groups and unicode escapes", async () => {
    const rtf = await read(makeRtf(["Café menu", "Soup {daily}"]), "menu.rtf");
    expect(rtf.text).toBe("Café menu\nSoup {daily}");
    expect(rtfToText("{\\rtf1{\\*\\ignored hidden}\\b Bold\\b0  \\'e9t\\'e9\\par}")).toBe("Bold été");
  });

  test("email: headers, the text part, attachments by name", async () => {
    const eml = await read(
      makeEml({ from: "Ana <ana@example.com>", to: "team@example.com", subject: "Déjà vu: launch", text: "The launch moves to Thursday.\nSee the plan.", attachment: "plan.pdf" }),
      "launch.eml"
    );
    expect(eml.type.kind).toBe("eml");
    expect(eml.text).toContain("Subject: Déjà vu: launch\nFrom: Ana <ana@example.com>\nTo: team@example.com");
    expect(eml.text).toContain("The launch moves to Thursday.");
    expect(eml.text).toContain("Attachments: plan.pdf");
    expect(eml.text).not.toContain("<p>");
    expect(eml.summary).toBe('Email "Déjà vu: launch" from Ana <ana@example.com>, 1 attachment');
  });

  test("TSV, YAML, TOML, INI, XML and code", async () => {
    const tsv = await read(Buffer.from("name\tcity\nAda\tLondon\n"), "people.tsv");
    expect(tsv.summary).toBe("TSV, 1 row × 2 columns");
    expect(tsv.text).toContain("Ada | London");
    expect((await read(Buffer.from("a: 1\nb: [2]\n"), "c.yml")).summary).toBe("YAML, 3 lines");
    expect((await read(Buffer.from("[x]\ny = 1\n"), "c.toml")).type.kind).toBe("toml");
    expect((await read(Buffer.from("[x]\ny=1\n"), "setup.cfg")).type.kind).toBe("ini");
    expect((await read(Buffer.from("<a><b>1</b></a>"), "d.xml")).text).toBe("<a><b>1</b></a>");
    const code = await read(Buffer.from("def greet():\n    return 'hi'\n"), "greet.py");
    expect(code.type).toMatchObject({ kind: "code", label: "Python" });
    expect(code.summary).toBe("Python code, 3 lines");
    expect(code.text.startsWith("Python source file greet.py\n\ndef greet")).toBe(true);
  });
});

describe("PDF", () => {
  test("text PDFs keep page markers; scanned PDFs have no text and are flagged", async () => {
    const text = await read(makePdf("Hello Sibyl PDF"), "a.pdf");
    expect(text.parts).toEqual({ unit: "page", count: 1 });
    expect(looksScanned(text.text, 1)).toBe(false);
    // A JPEG-only page (minimal valid JPEG header is enough: pdf.js sees no text).
    const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
    const scan = await read(makeImagePdf(jpeg, 1, 1), "scan.pdf");
    expect(scan.text).toBe("");
    expect(scan.summary).toContain("no text layer");
    expect(looksScanned(scan.text, 1)).toBe(true);
  });
});

describe("ZIP archives", () => {
  test("chat sees every readable file; unsupported, secret and nested ones are listed", async () => {
    const zip = makeZip({
      "docs/": "",
      "docs/intro.md": "# Intro\nThe saffron gate opens at nine.",
      "docs/deck.pptx": makePptx([{ text: ["Deck"], notes: ["indigo note"] }]),
      "__MACOSX/docs/._intro.md": "junk",
      "tool.exe": Buffer.from([0x4d, 0x5a, 0x00, 0x00]),
      ".env": "TOKEN=1",
      "inner.zip": makeZip({ "x.txt": "x" })
    });
    const result = await read(zip, "bundle.zip");
    expect(result.parts).toEqual({ unit: "file", count: 2 });
    expect(result.text).toContain("--- File: docs/intro.md ---\n# Intro\nThe saffron gate opens at nine.");
    expect(result.text).toContain("indigo note");
    expect(result.text).toContain("tool.exe: Unsupported file type (.exe)");
    expect(result.text).toContain(".env: Files that usually hold secrets");
    expect(result.text).toContain("inner.zip: archives inside archives aren't opened");
    expect(result.text).not.toContain("junk");
  });

  test("zip-bomb limits: per-file, total and count caps", () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61); // deflates to a few KB
    const zip = makeZip({ "a.txt": big, "b.txt": "small", "c.txt": "small too", "d.txt": "and more" });
    const result = readArchive(zip, { maxEntryBytes: 1024 * 1024, maxTotalBytes: 12, maxFiles: 2 });
    expect(result.files.map((file) => file.path)).toEqual(["b.txt"]);
    expect(result.skipped).toEqual([
      { name: "a.txt", reason: "larger than 1 MB" },
      { name: "c.txt", reason: "the archive holds more than 0 MB in total" },
      { name: "d.txt", reason: "the archive holds more than 0 MB in total" }
    ]);
    // A lying header (declared small, inflates big) is still capped while inflating.
    const lying = makeZip({ "a.txt": big });
    lying.writeUInt32LE(10, lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    expect(readArchive(lying, { maxEntryBytes: 1024, maxTotalBytes: 1e9, maxFiles: 10 }).skipped).toEqual([{ name: "a.txt", reason: "larger than 0 MB" }]);
    const many = makeZip(Object.fromEntries(Array.from({ length: 5 }, (_v, i) => [`f${i}.txt`, `file ${i}`])));
    const capped = readArchive(many, { maxEntryBytes: 1024, maxTotalBytes: 1e9, maxFiles: 3 });
    expect(capped.files).toHaveLength(3);
    expect(capped.skipped.map((item) => item.reason)).toEqual(["more than 3 files in one archive", "more than 3 files in one archive"]);
  });

  test("uploads store parts and the refusal reason", async () => {
    const service = uploads();
    const saved = await service.save({ data: makePptx([{ text: ["One"] }, { text: ["Two"] }]), filename: "d.pptx" });
    expect(saved).toMatchObject({ kind: "pptx", parts: { unit: "slide", count: 2 }, summary: "PowerPoint, 2 slides" });
    await expect(service.save({ data: Buffer.from("MZ\0\0"), filename: "x.exe" })).rejects.toMatchObject({ status: 415, message: expect.stringMatching(/Unsupported file type \(\.exe\)/) });
  });
});
