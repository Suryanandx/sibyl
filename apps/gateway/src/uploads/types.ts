/**
 * Which files Sibyl accepts, decided from the bytes and the extension — the
 * browser's declared MIME type is never trusted.
 */
export type UploadKind = "image" | "pdf" | "text" | "markdown" | "csv" | "json" | "docx" | "xlsx";

export interface DetectedType {
  kind: UploadKind;
  mime: string;
}

export const ACCEPTED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".pdf",
  ".txt", ".md", ".markdown", ".csv", ".json",
  ".docx", ".xlsx"
] as const;

const TEXT_EXTENSIONS: Record<string, DetectedType> = {
  ".txt": { kind: "text", mime: "text/plain" },
  ".text": { kind: "text", mime: "text/plain" },
  ".log": { kind: "text", mime: "text/plain" },
  ".md": { kind: "markdown", mime: "text/markdown" },
  ".markdown": { kind: "markdown", mime: "text/markdown" },
  ".csv": { kind: "csv", mime: "text/csv" },
  ".json": { kind: "json", mime: "application/json" }
};

export function extensionOf(name: string): string {
  const match = /\.[A-Za-z0-9]{1,10}$/.exec(name);
  return match ? match[0].toLowerCase() : "";
}

/** Detect an accepted type, or undefined when the file is not supported. */
export function detectType(data: Buffer, name: string): DetectedType | undefined {
  const ext = extensionOf(name);
  const starts = (bytes: number[], at = 0) => bytes.every((byte, index) => data[at + index] === byte);

  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
  if (starts([0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (data.subarray(0, 6).toString("latin1") === "GIF87a" || data.subarray(0, 6).toString("latin1") === "GIF89a") {
    return { kind: "image", mime: "image/gif" };
  }
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    return { kind: "image", mime: "image/webp" };
  }
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    if (ext === ".docx") return { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    if (ext === ".xlsx") return { kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    return undefined;
  }
  const text = TEXT_EXTENSIONS[ext];
  if (text && isProbablyUtf8Text(data)) return text;
  return undefined;
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
