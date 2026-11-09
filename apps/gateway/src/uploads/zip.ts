/**
 * Minimal ZIP reader for DOCX/XLSX text extraction (pure JS on node:zlib).
 * Reads the central directory, inflates only the entries asked for, and caps
 * every inflated entry so a zip bomb can't exhaust memory. No ZIP64.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class ZipError extends Error {}

export function listZipEntries(data: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw new ZipError("bad central directory");
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(data: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const at = entry.localOffset;
  if (at + 30 > data.length || data.readUInt32LE(at) !== 0x04034b50) throw new ZipError("bad local header");
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > data.length) throw new ZipError("truncated entry");
  const raw = data.subarray(start, end);
  if (entry.method === 0) {
    if (raw.length > maxBytes) throw new ZipError("entry too large");
    return Buffer.from(raw);
  }
  if (entry.method !== 8) throw new ZipError(`unsupported compression ${entry.method}`);
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (error) {
    throw new ZipError(`could not inflate ${entry.name}: ${(error as Error).message}`);
  }
}

function findEndOfCentralDirectory(data: Buffer): number {
  const min = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= min; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ZipError("not a zip file");
}
