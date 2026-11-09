/**
 * Skill bundles: a SKILL.md plus small reference files, imported from a zip
 * or a folder (a list of { path, content } from the browser), exported as a
 * zip (or a bare SKILL.md when there are no files).
 *
 * Safe unzip: the archive is read in memory (never written to disk); any
 * entry with an absolute path, a drive letter, a backslash or a `..` part
 * rejects the whole import; every entry is size-capped before and while it
 * is inflated; only UTF-8 text files are kept.
 */
import { crc32 } from "node:zlib";
import { isSafeRelativePath, SKILL_LIMITS, type SkillFileView } from "@open-gpt-live/protocol";
import { listZipEntries, readZipEntry, ZipError } from "../uploads/zip.js";
import { parseSkillMd, serializeSkillMd, SkillFormatError, type ParsedSkillMd } from "./skill-md.js";

export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 200;
const SKILL_MD_MAX_BYTES = 128 * 1024;

export interface SkillBundle extends ParsedSkillMd {
  files: SkillFileView[];
  /** Files left out (binary, too large, over the count). */
  skipped: string[];
}

interface RawFile {
  path: string;
  size: number;
  read(maxBytes: number): Buffer;
}

export function importSkillZip(data: Buffer): SkillBundle {
  if (data.byteLength > MAX_ARCHIVE_BYTES) throw new SkillFormatError(`The zip is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
  let entries;
  try {
    entries = listZipEntries(data);
  } catch (error) {
    throw new SkillFormatError(`That is not a readable zip file (${(error as Error).message}).`);
  }
  if (entries.length > MAX_ENTRIES) throw new SkillFormatError(`The zip has more than ${MAX_ENTRIES} entries.`);
  const files: RawFile[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      if (!isSafeRelativePath(entry.name.slice(0, -1))) throw new SkillFormatError(`Unsafe path in the zip: ${entry.name}`);
      continue;
    }
    if (!isSafeRelativePath(entry.name)) throw new SkillFormatError(`Unsafe path in the zip: ${entry.name}`);
    files.push({
      path: entry.name,
      size: entry.size,
      read: (maxBytes) => {
        try {
          return readZipEntry(data, entry, maxBytes);
        } catch (error) {
          throw new SkillFormatError(error instanceof ZipError ? `Could not read ${entry.name}: ${error.message}` : `Could not read ${entry.name}`);
        }
      }
    });
  }
  return bundleFrom(files);
}

export function importSkillFolder(input: unknown): SkillBundle {
  if (!Array.isArray(input) || input.length === 0) throw new SkillFormatError("files must be a non-empty list of { path, content }.");
  if (input.length > MAX_ENTRIES) throw new SkillFormatError(`A skill folder can have at most ${MAX_ENTRIES} files.`);
  const files: RawFile[] = input.map((item) => {
    const file = item as { path?: unknown; content?: unknown };
    if (typeof file?.path !== "string" || typeof file.content !== "string") throw new SkillFormatError("Each file needs a path and text content.");
    const path = file.path.replace(/^\.\//, "");
    if (!isSafeRelativePath(path)) throw new SkillFormatError(`Unsafe path: ${file.path}`);
    const bytes = Buffer.from(file.content, "utf8");
    return {
      path,
      size: bytes.byteLength,
      read: (maxBytes: number) => {
        if (bytes.byteLength > maxBytes) throw new SkillFormatError(`${path} is too large.`);
        return bytes;
      }
    };
  });
  return bundleFrom(files);
}

export function importSkillMarkdown(text: string, fallbackName?: string): SkillBundle {
  if (Buffer.byteLength(text, "utf8") > SKILL_MD_MAX_BYTES) throw new SkillFormatError(`SKILL.md is larger than ${SKILL_MD_MAX_BYTES / 1024} KB.`);
  return { ...parseSkillMd(text, fallbackName), files: [], skipped: [] };
}

function bundleFrom(all: RawFile[]): SkillBundle {
  // Ignore OS litter and hidden files.
  const files = all.filter((file) => !file.path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX"));
  const skillMd = files
    .filter((file) => file.path.split("/").pop()!.toLowerCase() === "skill.md")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  if (!skillMd) throw new SkillFormatError("No SKILL.md found (it must be at the top of the folder or zip, or one folder down).");
  const depth = skillMd.path.split("/").length;
  if (depth > 2) throw new SkillFormatError("SKILL.md must be at the top of the folder or zip, or one folder down.");
  const root = depth === 2 ? `${skillMd.path.split("/")[0]}/` : "";
  if (skillMd.size > SKILL_MD_MAX_BYTES) throw new SkillFormatError(`SKILL.md is larger than ${SKILL_MD_MAX_BYTES / 1024} KB.`);
  const parsed = parseSkillMd(decodeText(skillMd.read(SKILL_MD_MAX_BYTES), skillMd.path), root ? root.slice(0, -1) : undefined);

  const kept: SkillFileView[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const file of files) {
    if (file === skillMd || !file.path.startsWith(root)) continue;
    const name = file.path.slice(root.length);
    if (kept.length >= SKILL_LIMITS.files || file.size > SKILL_LIMITS.fileBytes || total + file.size > SKILL_LIMITS.totalBytes) {
      skipped.push(name);
      continue;
    }
    let content: string;
    try {
      content = decodeText(file.read(SKILL_LIMITS.fileBytes), name);
    } catch {
      skipped.push(name);
      continue;
    }
    total += Buffer.byteLength(content, "utf8");
    kept.push({ name, content });
  }
  return { ...parsed, files: kept, skipped };
}

function decodeText(data: Buffer, name: string): string {
  if (data.includes(0)) throw new SkillFormatError(`${name} is not a text file.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    throw new SkillFormatError(`${name} is not UTF-8 text.`);
  }
}

/** Export: SKILL.md alone, or a zip with `<name>/SKILL.md` and the files. */
export function exportSkill(skill: {
  name: string;
  title: string;
  description: string;
  instructions: string;
  tools?: string[];
  version?: string;
  files?: SkillFileView[];
}): { fileName: string; contentType: string; data: Buffer } {
  const markdown = serializeSkillMd(skill);
  if (!skill.files?.length) {
    return { fileName: "SKILL.md", contentType: "text/markdown; charset=utf-8", data: Buffer.from(markdown, "utf8") };
  }
  const entries = [
    { name: `${skill.name}/SKILL.md`, data: Buffer.from(markdown, "utf8") },
    ...skill.files.map((file) => ({ name: `${skill.name}/${file.name}`, data: Buffer.from(file.content, "utf8") }))
  ];
  return { fileName: `${skill.name}.zip`, contentType: "application/zip", data: writeZip(entries) };
}

/** Minimal ZIP writer (stored, no compression): enough for a few small text files. */
export function writeZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00 in DOS time.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.byteLength + entry.data.byteLength;
  }
  const centralSize = centrals.reduce((total, part) => total + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
