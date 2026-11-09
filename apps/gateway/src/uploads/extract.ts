/**
 * Text extraction at upload time (pure JS, no model calls). One pipeline for
 * chat attachments, knowledge and connector files:
 * - PDF via unpdf (serverless pdf.js build), "--- Page N ---" markers
 * - Office Open XML (DOCX, XLSX, PPTX with speaker notes), OpenDocument
 *   (ODT, ODS, ODP) and EPUB (chapters in spine order) via the small zip reader
 * - HTML via the read_webpage tool's htmlToText; RTF (control words stripped);
 *   email (.eml: headers, the text or HTML part, attachments by name)
 * - CSV / TSV / JSON: a short summary (headers + first rows / shape) then the content
 * - text, Markdown, YAML, XML, TOML, INI and source code as is (code with its language)
 * - ZIP: the text of every readable file inside, "--- File: path ---" markers
 * Images have no text here; chats send them to the model as images, and
 * knowledge has them read by a vision model (knowledge/ocr.ts).
 */
import type { FileParts } from "@open-gpt-live/protocol";
import { fileFormatFor } from "@open-gpt-live/protocol";
import { htmlToText } from "../tools/builtin/read-webpage.js";
import { readArchive } from "./archive.js";
import type { UploadKind } from "./types.js";
import { listZipEntries, readZipEntry, type ZipEntry } from "./zip.js";

/** Extracted text kept per file (read_file pages through it). */
export const MAX_EXTRACTED_CHARS = 2_000_000;
const MAX_ZIP_ENTRY_BYTES = 40 * 1024 * 1024;
const PREVIEW_ROWS = 10;

export interface Extraction {
  text: string;
  /** One-line description for the model and the UI. */
  summary: string;
  /** PDF pages (kept for older callers; `parts` has the same). */
  pages?: number;
  /** Pages, slides, sheets, chapters or files. */
  parts?: FileParts;
}

export async function extractText(kind: UploadKind, data: Buffer, name = ""): Promise<Extraction> {
  switch (kind) {
    case "image":
      return { text: "", summary: "image" };
    case "video":
      return { text: "", summary: "video" };
    case "audio":
      return { text: "", summary: "audio" };
    case "pdf":
      return extractPdf(data);
    case "csv":
      return summariseCsv(decodeText(data));
    case "tsv":
      return summariseCsv(decodeText(data), "\t");
    case "json":
      return summariseJson(decodeText(data));
    case "docx":
      return extractDocx(data);
    case "xlsx":
      return extractXlsx(data);
    case "pptx":
      return extractPptx(data);
    case "odt":
      return extractOdt(data);
    case "ods":
      return extractOds(data);
    case "odp":
      return extractOdp(data);
    case "epub":
      return extractEpub(data);
    case "html":
      return extractHtml(decodeText(data));
    case "rtf":
      return extractRtf(data);
    case "eml":
      return extractEml(data);
    case "zip":
      return extractZip(data);
    case "code": {
      const text = decodeText(data);
      const language = fileFormatFor(name)?.label ?? "Source";
      return { text: cap(`${language} source file${name ? ` ${name}` : ""}\n\n${text}`), summary: `${language} code, ${lineCount(text)} lines` };
    }
    case "text":
    case "markdown":
    case "yaml":
    case "xml":
    case "toml":
    case "ini": {
      const text = cap(decodeText(data));
      const label = kind === "markdown" ? "Markdown" : kind === "text" ? "text" : (fileFormatFor(name)?.label ?? kind.toUpperCase());
      return { text, summary: `${label}, ${lineCount(text)} lines` };
    }
  }
}

function decodeText(data: Buffer): string {
  return data.toString("utf8").replace(/^﻿/, "");
}

function cap(text: string): string {
  return text.length > MAX_EXTRACTED_CHARS ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n…(truncated)` : text;
}

function lineCount(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Blank-line runs collapsed, lines trimmed at the end. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ───────────── PDF ───────────── */

async function extractPdf(data: Buffer): Promise<Extraction> {
  const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const result = await pdfText(pdf, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [String(result.text)];
    const chars = pages.reduce((total, page) => total + page.trim().length, 0);
    // A scanned PDF has no text layer: leave the text empty (knowledge reads it with OCR).
    const text = chars === 0 ? "" : cap(pages.map((page, index) => `--- Page ${index + 1} ---\n${page.trim()}`).join("\n\n"));
    return {
      text,
      pages: result.totalPages,
      parts: { unit: "page", count: result.totalPages },
      summary: `PDF, ${plural(result.totalPages, "page")}${chars === 0 ? ", no text layer (scanned?)" : ""}`
    };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

/** True when a PDF's extracted text is too thin to be its real content (a scan). */
export function looksScanned(text: string, pages: number | undefined): boolean {
  const body = text.replace(/^--- Page \d+ ---$/gm, "").replace(/\s+/g, "");
  return body.length < Math.max(1, pages ?? 1) * 10;
}

/* ───────────── CSV / TSV / JSON ───────────── */

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF); `delimiter` "\t" for TSV. */
export function parseCsv(text: string, maxRows = Infinity, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= maxRows) return rows;
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function summariseCsv(text: string, delimiter = ","): Extraction {
  const rows = parseCsv(text, Infinity, delimiter).filter((row) => row.some((cell) => cell.trim() !== ""));
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const preview = rows.slice(0, PREVIEW_ROWS + 1).map((row) => row.join(" | "));
  const summary = `${delimiter === "\t" ? "TSV" : "CSV"}, ${plural(body.length, "row")} × ${plural(headers.length, "column")}`;
  const header = [
    `${summary}.`,
    `Columns: ${headers.join(", ") || "(none)"}`,
    `First ${Math.min(PREVIEW_ROWS, body.length)} rows:`,
    ...preview,
    "",
    "--- Full content ---"
  ].join("\n");
  return { text: cap(`${header}\n${text}`), summary };
}

export function summariseJson(text: string): Extraction {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { text: cap(text), summary: `JSON (invalid: ${(error as Error).message.slice(0, 80)})` };
  }
  let summary: string;
  let preview: string;
  if (Array.isArray(value)) {
    const keys = new Set<string>();
    for (const item of value.slice(0, 50)) {
      if (item && typeof item === "object" && !Array.isArray(item)) for (const key of Object.keys(item)) keys.add(key);
    }
    summary = `JSON array, ${plural(value.length, "item")}${keys.size ? `, fields: ${[...keys].slice(0, 30).join(", ")}` : ""}`;
    preview = `First ${Math.min(5, value.length)} items:\n${JSON.stringify(value.slice(0, 5), null, 2)}`;
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    summary = `JSON object, ${plural(keys.length, "key")}: ${keys.slice(0, 30).join(", ")}`;
    preview = "";
  } else {
    summary = `JSON ${typeof value}`;
    preview = "";
  }
  const pretty = JSON.stringify(value, null, 2);
  return { text: cap([`${summary}.`, preview, "--- Full content ---", pretty].filter(Boolean).join("\n")), summary };
}

/* ───────────── zip-based formats ───────────── */

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    }
    return XML_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Attributes of one XML start tag (any order, either quote). */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[match[1]!] = decodeXml(match[2] ?? match[3] ?? "");
  return out;
}

/** Read entries of a zip by name (each inflated on demand, capped). */
class ZipFiles {
  private readonly entries: Map<string, ZipEntry>;
  constructor(private readonly data: Buffer) {
    this.entries = new Map(listZipEntries(data).map((entry) => [entry.name, entry]));
  }
  names(): string[] {
    return [...this.entries.keys()];
  }
  text(name: string): string | undefined {
    const entry = this.entries.get(name);
    return entry ? readZipEntry(this.data, entry, MAX_ZIP_ENTRY_BYTES).toString("utf8") : undefined;
  }
}

/** Resolve a relationship / manifest target against the folder of the part that names it. */
function resolvePart(fromFolder: string, target: string): string {
  const raw = target.startsWith("/") ? target.slice(1) : `${fromFolder}${target}`;
  const parts: string[] = [];
  for (const piece of safeDecodeUri(raw.split("#")[0]!).split("/")) {
    if (piece === "..") parts.pop();
    else if (piece && piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Relationship id → target path (resolved). */
function relationships(xml: string | undefined, fromFolder: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  for (const match of (xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const attrs = attrsOf(match[0]);
    if (attrs.Id && attrs.Target && attrs.TargetMode !== "External") out.set(attrs.Id, { target: resolvePart(fromFolder, attrs.Target), type: attrs.Type ?? "" });
  }
  return out;
}

export function extractDocx(data: Buffer): Extraction {
  const xml = new ZipFiles(data).text("word/document.xml");
  if (xml === undefined) throw new Error("not a Word document (word/document.xml missing)");
  const text = decodeXml(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(br|cr)\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cap(text), summary: `Word document, ~${wordCount(text)} words` };
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Sheets as CSV under "--- Sheet: name ---" markers, with a one-line summary. */
function sheetsText(sheets: Array<{ name: string; rows: string[][] }>, label: string): Extraction {
  const parts: string[] = [];
  const summaries: string[] = [];
  for (const { name, rows } of sheets) {
    const width = Math.max(0, ...rows.map((row) => row.length));
    summaries.push(`${name} (${rows.length} rows × ${width} cols)`);
    parts.push(`--- Sheet: ${name} ---\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`);
  }
  const summary = `${label}, ${plural(sheets.length, "sheet")}: ${summaries.join("; ")}`;
  return { text: cap(`${summary}.\n\n${parts.join("\n\n")}`), summary, parts: { unit: "sheet", count: sheets.length } };
}

export function extractXlsx(data: Buffer): Extraction {
  const zip = new ZipFiles(data);
  const shared: string[] = [];
  for (const si of (zip.text("xl/sharedStrings.xml") ?? "").match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push(decodeXml([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")));
  }
  const sheetNames = [...(zip.text("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]!));
  const sheetFiles = zip
    .names()
    .map((name) => ({ name, number: Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((item) => Number.isFinite(item.number))
    .sort((a, b) => a.number - b.number);
  if (sheetFiles.length === 0) throw new Error("not an Excel workbook (no worksheets)");
  const sheets = sheetFiles.map(({ name }, index) => {
    const xml = zip.text(name) ?? "";
    const rows: string[][] = [];
    for (const rowXml of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const row: string[] = [];
      for (const cell of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? "";
        const inner = cell[2] ?? "";
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = decodeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
        else if (raw !== undefined) value = decodeXml(raw);
        const column = ref ? columnIndex(ref) : row.length;
        while (row.length < column) row.push("");
        row[column] = value;
      }
      rows.push(row);
    }
    return { name: sheetNames[index] ?? `Sheet${index + 1}`, rows };
  });
  return sheetsText(sheets, "Excel workbook");
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Text of DrawingML (slides and notes): paragraphs as lines, fields (slide numbers, dates) dropped. */
function drawingText(xml: string): string {
  return tidy(
    decodeXml(
      xml
        .replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "")
        .replace(/<a:tab\/>/g, "\t")
        .replace(/<a:br\b[^>]*\/>/g, "\n")
        .replace(/<\/a:p>/g, "\n")
        .replace(/<[^>]+>/g, "")
    )
  );
}

export function extractPptx(data: Buffer): Extraction {
  const zip = new ZipFiles(data);
  const presentation = zip.text("ppt/presentation.xml");
  if (presentation === undefined) throw new Error("not a PowerPoint file (ppt/presentation.xml missing)");
  const rels = relationships(zip.text("ppt/_rels/presentation.xml.rels"), "ppt/");
  let slides = [...presentation.matchAll(/<p:sldId\b[^>]*>/g)]
    .map((match) => rels.get(attrsOf(match[0])["r:id"] ?? "")?.target)
    .filter((path): path is string => Boolean(path));
  if (slides.length === 0) {
    slides = zip
      .names()
      .map((name) => ({ name, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
      .filter((item) => Number.isFinite(item.number))
      .sort((a, b) => a.number - b.number)
      .map((item) => item.name);
  }
  const parts: string[] = [];
  let withNotes = 0;
  slides.forEach((path, index) => {
    const xml = zip.text(path);
    if (xml === undefined) return;
    const folder = path.slice(0, path.lastIndexOf("/") + 1);
    const relsPath = `${folder}_rels/${path.slice(folder.length)}.rels`;
    const notesPath = [...relationships(zip.text(relsPath), folder).values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target;
    const notesXml = notesPath ? zip.text(notesPath) : undefined;
    const notes = notesXml ? drawingText(notesXml) : "";
    if (notes) withNotes += 1;
    parts.push([`--- Slide ${index + 1} ---`, drawingText(xml), notes ? `Speaker notes:\n${notes}` : ""].filter(Boolean).join("\n"));
  });
  const summary = `PowerPoint, ${plural(slides.length, "slide")}${withNotes ? `, speaker notes on ${withNotes}` : ""}`;
  return { text: cap(parts.join("\n\n")), summary, parts: { unit: "slide", count: slides.length } };
}

/** Text of OpenDocument XML: paragraphs and headings as lines (headings as Markdown). */
function odfText(xml: string): string {
  return tidy(
    decodeXml(
      xml
        .replace(/<text:h\b[^>]*?text:outline-level="(\d+)"[^>]*>/g, (_m, level: string) => `\n${"#".repeat(Math.min(6, Number(level) || 1))} `)
        .replace(/<text:s\b[^>]*?text:c="(\d+)"[^>]*\/>/g, (_m, count: string) => " ".repeat(Math.min(100, Number(count) || 1)))
        .replace(/<text:s\b[^>]*\/>/g, " ")
        .replace(/<text:tab\b[^>]*\/>/g, "\t")
        .replace(/<text:line-break\b[^>]*\/>/g, "\n")
        .replace(/<text:list-item\b[^>]*>/g, "- ")
        .replace(/<\/text:(p|h)>/g, "\n")
        .replace(/<[^>]+>/g, "")
    )
  );
}

function odfContent(data: Buffer, what: string): string {
  const xml = new ZipFiles(data).text("content.xml");
  if (xml === undefined) throw new Error(`not an OpenDocument ${what} (content.xml missing)`);
  return xml;
}

export function extractOdt(data: Buffer): Extraction {
  const xml = odfContent(data, "text");
  const body = /<office:text\b[^>]*>([\s\S]*)<\/office:text>/.exec(xml)?.[1] ?? xml;
  const text = odfText(body);
  return { text: cap(text), summary: `OpenDocument text, ~${wordCount(text)} words` };
}

export function extractOdp(data: Buffer): Extraction {
  const xml = odfContent(data, "presentation");
  const pages = xml.match(/<draw:page\b[\s\S]*?<\/draw:page>/g) ?? [];
  let withNotes = 0;
  const parts = pages.map((page, index) => {
    const notesXml = /<presentation:notes\b[\s\S]*?<\/presentation:notes>/.exec(page)?.[0] ?? "";
    const notes = notesXml ? odfText(notesXml) : "";
    if (notes) withNotes += 1;
    const body = odfText(page.replace(notesXml, ""));
    return [`--- Slide ${index + 1} ---`, body, notes ? `Speaker notes:\n${notes}` : ""].filter(Boolean).join("\n");
  });
  const summary = `OpenDocument presentation, ${plural(pages.length, "slide")}${withNotes ? `, speaker notes on ${withNotes}` : ""}`;
  return { text: cap(parts.join("\n\n")), summary, parts: { unit: "slide", count: pages.length } };
}

/** Repeated empty cells/rows are common (styling up to column 1024): repeat only real values, a little. */
const MAX_REPEAT = 50;

export function extractOds(data: Buffer): Extraction {
  const xml = odfContent(data, "spreadsheet");
  const tables = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)];
  const sheets = tables.map((table, index) => {
    const name = attrsOf(table[1] ?? "")["table:name"] ?? `Sheet${index + 1}`;
    const rows: string[][] = [];
    for (const rowMatch of (table[2] ?? "").matchAll(/<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      const row: string[] = [];
      for (const cell of (rowMatch[2] ?? "").matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
        const attrs = attrsOf(cell[1] ?? "");
        const text = cell[2] ? odfText(cell[2]).replace(/\n+/g, " ") : "";
        const value = text || attrs["office:value"] || attrs["office:date-value"] || attrs["office:boolean-value"] || "";
        const repeat = Math.max(1, Number(attrs["table:number-columns-repeated"]) || 1);
        for (let index = 0; index < (value ? Math.min(repeat, MAX_REPEAT) : Math.min(repeat, 1)); index += 1) row.push(value);
      }
      while (row.length && !row[row.length - 1]) row.pop();
      if (row.length) rows.push(row);
    }
    return { name, rows };
  });
  if (sheets.length === 0) throw new Error("not an OpenDocument spreadsheet (no tables)");
  return sheetsText(sheets, "OpenDocument spreadsheet");
}

export function extractEpub(data: Buffer): Extraction {
  const zip = new ZipFiles(data);
  const container = zip.text("META-INF/container.xml");
  const opfPath = container ? /<rootfile\b[^>]*>/.exec(container)?.[0] : undefined;
  const fullPath = opfPath ? attrsOf(opfPath)["full-path"] : undefined;
  const opf = fullPath ? zip.text(fullPath) : undefined;
  if (!fullPath || opf === undefined) throw new Error("not an EPUB book (no package document)");
  const folder = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)) {
    const attrs = attrsOf(item[0]);
    if (attrs.id && attrs.href) manifest.set(attrs.id, { href: resolvePart(folder, attrs.href), type: attrs["media-type"] ?? "" });
  }
  const bookTitle = decodeXml(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? "").trim();
  const parts: string[] = [];
  for (const ref of opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/g)) {
    const item = manifest.get(attrsOf(ref[0]).idref ?? "");
    if (!item || !/html|xml/.test(item.type || "html")) continue;
    const html = zip.text(item.href);
    if (html === undefined) continue;
    const { text } = htmlToText(html);
    if (!text.trim()) continue;
    parts.push(`--- Chapter ${parts.length + 1} ---\n${text}`);
  }
  const header = bookTitle ? `# ${bookTitle}\n\n` : "";
  const summary = `EPUB book${bookTitle ? ` "${bookTitle.slice(0, 80)}"` : ""}, ${plural(parts.length, "chapter")}`;
  return { text: cap(header + parts.join("\n\n")), summary, parts: { unit: "chapter", count: parts.length } };
}

/* ───────────── HTML, RTF, email ───────────── */

export function extractHtml(html: string): Extraction {
  const { title, text } = htmlToText(html);
  const body = title && !text.startsWith(`# ${title}`) ? `# ${title}\n\n${text}` : text;
  return { text: cap(body), summary: `HTML page${title ? ` "${title.slice(0, 80)}"` : ""}, ~${wordCount(text)} words` };
}

/** Destinations whose text is not document content. */
const RTF_SKIP = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "headerl", "headerr", "headerf", "footer", "footerl",
  "footerr", "footerf", "themedata", "colorschememapping", "datastore", "latentstyles", "listtable", "listoverridetable",
  "rsidtbl", "generator", "xmlnstbl", "fldinst", "filetbl", "revtbl", "pgdsctbl", "bkmkstart", "bkmkend", "shppict", "nonshppict"
]);
const RTF_WORDS: Record<string, string> = {
  par: "\n", line: "\n", sect: "\n\n", page: "\n\n", row: "\n", cell: "\t", tab: "\t",
  emdash: "—", endash: "–", bullet: "•", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”", emspace: " ", enspace: " "
};
const CP1252 = new TextDecoder("windows-1252");

/** Plain text of an RTF document (control words stripped; \u and \'hh characters decoded). */
export function rtfToText(rtf: string): string {
  let out = "";
  const stack: Array<{ skip: boolean; uc: number }> = [];
  let skip = false;
  let uc = 1;
  /** Fallback characters still to drop after a \u character. */
  let drop = 0;
  for (let index = 0; index < rtf.length; index += 1) {
    const char = rtf[index]!;
    if (char === "{") {
      stack.push({ skip, uc });
      drop = 0;
    } else if (char === "}") {
      const state = stack.pop();
      if (state) ({ skip, uc } = state);
      drop = 0;
    } else if (char === "\\") {
      const next = rtf[index + 1] ?? "";
      if (/[a-zA-Z]/.test(next)) {
        const match = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(index + 1, index + 50))!;
        index += match[0].length;
        const word = match[1]!;
        const param = match[2] === undefined ? undefined : Number(match[2]);
        if (RTF_SKIP.has(word)) skip = true;
        else if (word === "uc" && param !== undefined) uc = Math.max(0, param);
        else if (word === "u" && param !== undefined) {
          if (!skip) out += String.fromCharCode(param < 0 ? param + 65536 : param);
          drop = uc;
        } else if (!skip && RTF_WORDS[word] !== undefined) out += RTF_WORDS[word];
      } else if (next === "'") {
        const hex = rtf.slice(index + 2, index + 4);
        index += 3;
        if (drop > 0) drop -= 1;
        else if (!skip && /^[0-9a-f]{2}$/i.test(hex)) out += CP1252.decode(Buffer.from([parseInt(hex, 16)]));
      } else {
        index += 1;
        if (next === "*") skip = true;
        else if (!skip && drop === 0) {
          if (next === "\\" || next === "{" || next === "}") out += next;
          else if (next === "~") out += " ";
          else if (next === "_") out += "-";
          else if (next === "\n" || next === "\r") out += "\n";
        } else if (drop > 0) drop -= 1;
      }
    } else if (char === "\r" || char === "\n") {
      continue;
    } else if (drop > 0) {
      drop -= 1;
    } else if (!skip) {
      out += char;
    }
  }
  return tidy(out.replace(/\t+\n/g, "\n"));
}

export function extractRtf(data: Buffer): Extraction {
  const raw = data.toString("latin1");
  if (!raw.startsWith("{\\rtf")) throw new Error("not an RTF document");
  const text = rtfToText(raw);
  return { text: cap(text), summary: `Rich Text document, ~${wordCount(text)} words` };
}

interface MimePart {
  headers: Map<string, string>;
  /** Raw body as latin1 (one char per byte). */
  body: string;
}

function parseMimePart(raw: string): MimePart {
  const split = /\r?\n\r?\n/.exec(raw);
  const head = split ? raw.slice(0, split.index) : raw;
  const body = split ? raw.slice(split.index + split[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
    }
  }
  return { headers, body };
}

function headerParam(value: string | undefined, param: string): string | undefined {
  if (!value) return undefined;
  const match = new RegExp(`(?:^|;)\\s*${param}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  // RFC 2231: utf-8''name%20with%20spaces
  const extended = /^([\w-]+)'[^']*'(.*)$/.exec(raw);
  return extended ? safeDecodeUri(extended[2]!) : decodeWords(raw);
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder((charset || "utf-8").toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** RFC 2047 encoded words in headers (=?utf-8?B?...?= / =?iso-8859-1?Q?...?=). */
function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (_m, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toLowerCase() === "b" ? Buffer.from(text, "base64") : Buffer.from(decodeQuotedPrintable(text.replace(/_/g, " ")), "latin1");
    return decodeCharset(bytes, charset);
  });
}

function decodeQuotedPrintable(text: string): string {
  return text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function partText(part: MimePart): string {
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const charset = headerParam(part.headers.get("content-type"), "charset");
  const bytes =
    encoding === "base64"
      ? Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
      : Buffer.from(encoding === "quoted-printable" ? decodeQuotedPrintable(part.body) : part.body, "latin1");
  return decodeCharset(bytes, charset);
}

interface EmailWalk {
  plain: string[];
  html: string[];
  attachments: string[];
}

function walkMime(part: MimePart, out: EmailWalk, depth = 0): void {
  const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  const disposition = part.headers.get("content-disposition") ?? "";
  const filename = headerParam(disposition, "filename") ?? headerParam(part.headers.get("content-type"), "name");
  if (type.startsWith("multipart/") && depth < 10) {
    const boundary = headerParam(part.headers.get("content-type"), "boundary");
    if (!boundary) return;
    const pieces = part.body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`));
    for (const piece of pieces.slice(1)) if (piece.trim()) walkMime(parseMimePart(piece), out, depth + 1);
    return;
  }
  if (/^attachment/i.test(disposition) || (filename && !type.startsWith("text/"))) {
    out.attachments.push(filename ?? type);
    return;
  }
  if (type.startsWith("text/html")) out.html.push(partText(part));
  else if (type.startsWith("text/")) out.plain.push(partText(part));
  else if (filename) out.attachments.push(filename);
}

export function extractEml(data: Buffer): Extraction {
  const message = parseMimePart(data.toString("latin1"));
  if (!message.headers.has("from") && !message.headers.has("subject") && !message.headers.has("date")) {
    throw new Error("not an email message (no headers)");
  }
  const walk: EmailWalk = { plain: [], html: [], attachments: [] };
  walkMime(message, walk);
  const header = ["subject", "from", "to", "cc", "date"]
    .map((name) => {
      const value = message.headers.get(name);
      return value ? `${name[0]!.toUpperCase()}${name.slice(1)}: ${decodeWords(value)}` : "";
    })
    .filter(Boolean);
  const body = walk.plain.length ? walk.plain.join("\n\n") : walk.html.map((html) => htmlToText(html).text).join("\n\n");
  const subject = decodeWords(message.headers.get("subject") ?? "").slice(0, 80);
  const text = [header.join("\n"), tidy(body.replace(/\r\n?/g, "\n")), walk.attachments.length ? `Attachments: ${walk.attachments.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const from = decodeWords(message.headers.get("from") ?? "").slice(0, 80);
  const summary = `Email${subject ? ` "${subject}"` : ""}${from ? ` from ${from}` : ""}${walk.attachments.length ? `, ${plural(walk.attachments.length, "attachment")}` : ""}`;
  return { text: cap(text), summary };
}

/* ───────────── ZIP ───────────── */

async function extractZip(data: Buffer): Promise<Extraction> {
  const { files, skipped } = readArchive(data);
  const parts: string[] = [];
  let length = 0;
  let readable = 0;
  for (const file of files) {
    if (length > MAX_EXTRACTED_CHARS) break;
    let body: string;
    if (file.type.kind === "image") body = "(image)";
    else {
      try {
        body = (await extractText(file.type.kind, file.data, file.name)).text || "(no text)";
        readable += 1;
      } catch (error) {
        body = `(could not be read: ${(error as Error).message.slice(0, 120)})`;
      }
    }
    const part = `--- File: ${file.path} ---\n${body}`;
    parts.push(part);
    length += part.length;
  }
  if (skipped.length) parts.push(`Not read:\n${skipped.map((item) => `- ${item.name}: ${item.reason}`).join("\n")}`);
  const summary = `ZIP archive, ${plural(files.length, "file")} (${readable} with text)${skipped.length ? `, ${skipped.length} skipped` : ""}`;
  return { text: cap(parts.join("\n\n")), summary, parts: { unit: "file", count: files.length } };
}
