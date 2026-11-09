/**
 * Labels and file-preview rules for the side panel (plain functions, tested).
 */
import type { SidePanelItem } from "./events";
import { isPendingId, safeHttpUrl, type PanelEntry } from "./state";

export type FilePreview = "image" | "pdf" | "markdown" | "csv" | "text" | "video" | "audio" | "download";

/** How a file is shown: inline for images, PDF, text, Markdown, CSV and playable media; a download for the rest. */
export function filePreviewOf(mime: string, name = ""): FilePreview {
  const type = mime.toLowerCase().split(";")[0]!.trim();
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (/^image\/(png|jpe?g|webp|gif|avif)$/.test(type)) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (type === "text/csv" || ext === "csv") return "csv";
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(type)) return "video";
  if (/^audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4|aac|flac)$/.test(type)) return "audio";
  if (type.startsWith("text/") || type === "application/json" || ["txt", "json", "log", "tsv", "yaml", "yml", "xml"].includes(ext)) return "text";
  return "download";
}

/** Text previews stop here (the rest is a download). */
export const MAX_TEXT_PREVIEW = 400_000;
export const MAX_CSV_ROWS = 200;

/** A small CSV reader (quotes, escaped quotes, CRLF) for the preview table. */
export function parseCsv(text: string, maxRows = MAX_CSV_ROWS): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      pushRow();
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), more: true };
    } else field += char;
    i += 1;
  }
  if (field !== "" || row.length) pushRow();
  return { rows: rows.slice(0, maxRows), more: rows.length > maxRows };
}

const MEDIA_NAMES = { image: "Image", video: "Video", audio: "Audio" } as const;

/** The name an entry goes by in the header and the Activity list. */
export function itemLabel(item: SidePanelItem, agentName?: string): string {
  switch (item.kind) {
    case "computer":
      return agentName ? `${agentName}'s computer` : "Agent computer";
    case "slides":
      return item.title || "Slide deck";
    case "visual":
      return item.title || "Visual";
    case "file":
      return item.name;
    case "media":
      return item.title || MEDIA_NAMES[item.mediaType];
    case "url": {
      if (item.title) return item.title;
      return safeHttpUrl(item.url)?.hostname.replace(/^www\./, "") ?? item.url;
    }
  }
}

/** What kind of thing it is, in a word (screen readers, the list's second line). */
export function kindLabel(item: SidePanelItem): string {
  switch (item.kind) {
    case "computer":
      return "Computer";
    case "slides":
      return "Deck";
    case "visual":
      return "Visual";
    case "file":
      return "File";
    case "media":
      return MEDIA_NAMES[item.mediaType];
    case "url":
      return "Web page";
  }
}

/** Is the entry still a placeholder for something being built? */
export function isBuilding(entry: PanelEntry): boolean {
  if (entry.status === "running") return true;
  const id = entry.item.kind === "slides" ? entry.item.artifactId : entry.item.kind === "media" ? entry.item.uploadId : "";
  return Boolean(id) && isPendingId(id) && entry.status !== "failed";
}
