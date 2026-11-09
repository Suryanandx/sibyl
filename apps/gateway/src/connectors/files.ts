/**
 * Text from downloaded files (Drive, OneDrive/SharePoint): reuses the upload
 * extractors (PDF, DOCX, XLSX, CSV, JSON, text). No model calls.
 */
import { extractText } from "../uploads/extract.js";
import { detectType, isProbablyUtf8Text } from "../uploads/types.js";

export const DEFAULT_READ_CHARS = 20_000;
export const MAX_READ_CHARS = 60_000;

export interface FileText {
  text: string;
  /** Characters available in total (before paging). */
  totalChars: number;
  kind: string;
}

/** Extracted text of a file, or undefined when its type can't be read as text. */
export async function fileToText(data: Buffer, name: string): Promise<FileText | undefined> {
  const detected = detectType(data, name);
  if (detected && detected.kind !== "image") {
    const extraction = await extractText(detected.kind, data, name);
    return { text: extraction.text, totalChars: extraction.text.length, kind: detected.kind };
  }
  if (!detected && isProbablyUtf8Text(data)) {
    const text = data.toString("utf8");
    return { text, totalChars: text.length, kind: "text" };
  }
  return undefined;
}

/** A page of text with a continuation hint. */
export function pageOfText(text: string, offset: number, maxChars: number): { text: string; offset: number; nextOffset?: number; totalChars: number } {
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + maxChars);
  return { text: text.slice(start, end), offset: start, ...(end < text.length ? { nextOffset: end } : {}), totalChars: text.length };
}
