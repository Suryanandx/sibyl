/**
 * Text extraction at upload time (pure JS, no model calls):
 * - PDF via unpdf (serverless pdf.js build)
 * - CSV / JSON: a short summary (headers + first rows / shape) followed by the content
 * - text / markdown as is
 * - DOCX (word/document.xml) and XLSX (shared strings + sheets) via a tiny zip reader
 * Images have no text; they reach the model as image parts.
 */
import type { UploadKind } from "./types.js";
import { listZipEntries, readZipEntry } from "./zip.js";

/** Extracted text kept per file (read_file pages through it). */
export const MAX_EXTRACTED_CHARS = 2_000_000;
const MAX_ZIP_ENTRY_BYTES = 40 * 1024 * 1024;
const PREVIEW_ROWS = 10;

export interface Extraction {
  text: string;
  /** One-line description for the model and the UI. */
  summary: string;
  pages?: number;
}

export async function extractText(kind: UploadKind, data: Buffer): Promise<Extraction> {
  switch (kind) {
    case "image":
      return { text: "", summary: "image" };
    case "pdf":
      return extractPdf(data);
    case "csv":
      return summariseCsv(decodeText(data));
    case "json":
      return summariseJson(decodeText(data));
    case "docx":
      return extractDocx(data);
    case "xlsx":
      return extractXlsx(data);
    case "text":
    case "markdown": {
      const text = cap(decodeText(data));
      return { text, summary: `${kind === "markdown" ? "Markdown" : "text"}, ${lineCount(text)} lines` };
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

async function extractPdf(data: Buffer): Promise<Extraction> {
  const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const result = await pdfText(pdf, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [String(result.text)];
    const text = cap(
      pages
        .map((page, index) => `--- Page ${index + 1} ---\n${page.trim()}`)
        .join("\n\n")
    );
    const chars = pages.reduce((total, page) => total + page.trim().length, 0);
    return {
      text,
      pages: result.totalPages,
      summary: `PDF, ${result.totalPages} page${result.totalPages === 1 ? "" : "s"}${chars === 0 ? ", no text layer (scanned?)" : ""}`
    };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string, maxRows = Infinity): string[][] {
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
    else if (char === ",") {
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

export function summariseCsv(text: string): Extraction {
  const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ""));
  const headers = rows[0] ?? [];
  const body = rows.slice(1);
  const preview = rows.slice(0, PREVIEW_ROWS + 1).map((row) => row.join(" | "));
  const summary = `CSV, ${body.length} row${body.length === 1 ? "" : "s"} × ${headers.length} column${headers.length === 1 ? "" : "s"}`;
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
    summary = `JSON array, ${value.length} item${value.length === 1 ? "" : "s"}${keys.size ? `, fields: ${[...keys].slice(0, 30).join(", ")}` : ""}`;
    preview = `First ${Math.min(5, value.length)} items:\n${JSON.stringify(value.slice(0, 5), null, 2)}`;
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    summary = `JSON object, ${keys.length} key${keys.length === 1 ? "" : "s"}: ${keys.slice(0, 30).join(", ")}`;
    preview = "";
  } else {
    summary = `JSON ${typeof value}`;
    preview = "";
  }
  const pretty = JSON.stringify(value, null, 2);
  return { text: cap([`${summary}.`, preview, "--- Full content ---", pretty].filter(Boolean).join("\n")), summary };
}

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

function zipText(data: Buffer, name: string): string | undefined {
  const entry = listZipEntries(data).find((item) => item.name === name);
  return entry ? readZipEntry(data, entry, MAX_ZIP_ENTRY_BYTES).toString("utf8") : undefined;
}

export function extractDocx(data: Buffer): Extraction {
  const xml = zipText(data, "word/document.xml");
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
  const words = text ? text.split(/\s+/).length : 0;
  return { text: cap(text), summary: `Word document, ~${words} words` };
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export function extractXlsx(data: Buffer): Extraction {
  const entries = listZipEntries(data);
  const read = (name: string) => {
    const entry = entries.find((item) => item.name === name);
    return entry ? readZipEntry(data, entry, MAX_ZIP_ENTRY_BYTES).toString("utf8") : undefined;
  };
  const shared: string[] = [];
  for (const si of (read("xl/sharedStrings.xml") ?? "").match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push(decodeXml([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")));
  }
  const sheetNames = [...(read("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]!));
  const sheets = entries
    .map((entry) => ({ entry, number: Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(entry.name)?.[1]) }))
    .filter((item) => Number.isFinite(item.number))
    .sort((a, b) => a.number - b.number);
  if (sheets.length === 0) throw new Error("not an Excel workbook (no worksheets)");

  const parts: string[] = [];
  const summaries: string[] = [];
  sheets.forEach(({ entry }, index) => {
    const xml = readZipEntry(data, entry, MAX_ZIP_ENTRY_BYTES).toString("utf8");
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
    const name = sheetNames[index] ?? `Sheet${index + 1}`;
    const width = Math.max(0, ...rows.map((row) => row.length));
    summaries.push(`${name} (${rows.length} rows × ${width} cols)`);
    parts.push(`--- Sheet: ${name} ---\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`);
  });
  const summary = `Excel workbook, ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}: ${summaries.join("; ")}`;
  return { text: cap(`${summary}.\n\n${parts.join("\n\n")}`), summary };
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
