/**
 * Which files Sibyl accepts, decided from the bytes and the extension — the
 * browser's declared MIME type is never trusted. The list of formats is
 * FILE_FORMATS in the protocol package (shared with the web app's pickers).
 */
import {
  ACCEPTED_FILE_EXTENSIONS,
  FILE_FORMAT_GROUPS,
  LEGACY_OFFICE_FORMATS,
  fileExtension,
  fileFormatFor,
  isSecretFileName,
  type FileKind
} from "@open-gpt-live/protocol";

export type UploadKind = FileKind;

export interface DetectedType {
  kind: UploadKind;
  mime: string;
  /** Plain name of the format ("PowerPoint", "Python"). */
  label: string;
}

export const ACCEPTED_EXTENSIONS = ACCEPTED_FILE_EXTENSIONS;

const MIME: Partial<Record<UploadKind, string>> = {
  pdf: "application/pdf",
  text: "text/plain",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  xml: "application/xml",
  toml: "application/toml",
  ini: "text/plain",
  html: "text/html",
  rtf: "application/rtf",
  eml: "message/rfc822",
  code: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  zip: "application/zip"
};

/** Formats stored in a ZIP container. */
const ZIP_KINDS = new Set<UploadKind>(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "zip"]);
/** 8-bit formats that may legitimately be Latin-1 rather than UTF-8. */
const LATIN1_OK = new Set<UploadKind>(["rtf", "eml"]);

export function extensionOf(name: string): string {
  return fileExtension(name);
}

function imageType(data: Buffer): DetectedType | undefined {
  const starts = (bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png", label: "PNG image" };
  if (starts([0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", label: "JPEG image" };
  const head = data.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return { kind: "image", mime: "image/gif", label: "GIF image" };
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    return { kind: "image", mime: "image/webp", label: "WebP image" };
  }
  return undefined;
}

/** Video and audio containers, from their magic bytes (generated media and references). */
function mediaType(data: Buffer): DetectedType | undefined {
  const ascii = (from: number, to: number) => data.subarray(from, to).toString("latin1");
  if (data.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^M4A|^M4B/.test(brand)) return { kind: "audio", mime: "audio/mp4", label: "M4A audio" };
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime", label: "QuickTime video" };
    return { kind: "video", mime: "video/mp4", label: "MP4 video" };
  }
  if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) return { kind: "video", mime: "video/webm", label: "WebM video" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { kind: "audio", mime: "audio/wav", label: "WAV audio" };
  if (ascii(0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg", label: "Ogg audio" };
  if (ascii(0, 3) === "ID3" || (data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0)) return { kind: "audio", mime: "audio/mpeg", label: "MP3 audio" };
  return undefined;
}

function isZip(data: Buffer): boolean {
  // A local file header, or the end record of an empty archive.
  return data.length >= 4 && (data.readUInt32LE(0) === 0x04034b50 || (data.length >= 22 && data.readUInt32LE(0) === 0x06054b50));
}

/** Detect an accepted type, or undefined when the file is not supported. */
export function detectType(data: Buffer, name: string): DetectedType | undefined {
  if (isSecretFileName(name)) return undefined;
  const image = imageType(data);
  if (image) return image;
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf", label: "PDF" };
  const format = fileFormatFor(name);
  // Media by magic bytes, only under a media extension (a .txt starting with "ID3" stays text).
  if (format?.kind === "video" || format?.kind === "audio") return mediaType(data);
  if (isZip(data)) {
    return format && ZIP_KINDS.has(format.kind) ? { kind: format.kind, mime: MIME[format.kind]!, label: format.label } : undefined;
  }
  if (!format || format.kind === "image" || format.kind === "pdf" || ZIP_KINDS.has(format.kind)) return undefined;
  const textual = isProbablyUtf8Text(data) || (LATIN1_OK.has(format.kind) && !data.includes(0));
  return textual ? { kind: format.kind, mime: MIME[format.kind] ?? "text/plain", label: format.label } : undefined;
}

/** Why a file is refused, in words for the person who uploaded it. */
export function refusalFor(data: Buffer, name: string): string {
  if (isSecretFileName(name)) {
    return "Files that usually hold secrets (.env, private keys, credentials) are never accepted.";
  }
  const ext = extensionOf(name);
  const modern = LEGACY_OFFICE_FORMATS[ext];
  if (modern) {
    return `Old ${ext} Office files can't be read. Open it and save as ${modern}, then upload that.`;
  }
  if (fileFormatFor(name)) return `This doesn't look like a valid ${fileFormatFor(name)!.label} file.`;
  return `Unsupported file type${ext ? ` (${ext})` : ""}. Sibyl reads ${FILE_FORMAT_GROUPS.map((group) => group.label.toLowerCase()).join(", ")}.`;
}

/** Valid UTF-8 without NUL bytes (binary files pretending to be .txt are refused). */
export function isProbablyUtf8Text(data: Buffer): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** Display name: no directories, no control characters, bounded length. */
export function cleanFileName(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!clean || clean === "." || clean === "..") return "file";
  if (clean.length <= 160) return clean;
  const ext = extensionOf(clean);
  return `${clean.slice(0, 160 - ext.length)}${ext}`;
}
