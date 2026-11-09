/**
 * Each agent computer's file area: downloads and screenshots land here, and
 * uploads are picked from here. It lives on the gateway
 * ($SIBYL_DATA_DIR/computers/<agentId>/files), never inside the sandbox, so
 * the container needs no host mounts; files stream over the Playwright
 * connection. A per-agent quota caps it.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export interface FileEntry {
  name: string;
  bytes: number;
  modifiedAt: number;
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".yaml", ".yml", ".log", ".ics", ".vcf"]);
export const READ_FILE_MAX_CHARS = 20_000;

/** A safe file name (no paths, no dot files), or undefined. */
export function safeFileName(raw: string): string | undefined {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[^\w.\- ()]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!cleaned || cleaned.startsWith(".") || cleaned === "..") return undefined;
  return cleaned;
}

export class FileArea {
  constructor(
    private readonly root: string,
    private readonly quotaBytes: number
  ) {}

  dir(agentId: string): string {
    return join(this.root, agentId, "files");
  }

  async list(agentId: string): Promise<FileEntry[]> {
    const dir = this.dir(agentId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const entries: FileEntry[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const info = await stat(join(dir, name)).catch(() => undefined);
      if (info?.isFile()) entries.push({ name, bytes: info.size, modifiedAt: info.mtimeMs });
    }
    return entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async used(agentId: string): Promise<number> {
    return (await this.list(agentId)).reduce((sum, file) => sum + file.bytes, 0);
  }

  /** Bytes still free in the agent's quota. */
  async free(agentId: string): Promise<number> {
    return Math.max(0, this.quotaBytes - (await this.used(agentId)));
  }

  /** Path of an existing file, or undefined. */
  async path(agentId: string, name: string): Promise<string | undefined> {
    const safe = safeFileName(name);
    if (!safe || safe !== name) return undefined;
    const full = join(this.dir(agentId), safe);
    const info = await stat(full).catch(() => undefined);
    return info?.isFile() ? full : undefined;
  }

  /** A free path for a new file named like `wanted` (adds " (2)" … when taken). */
  async reserve(agentId: string, wanted: string): Promise<{ name: string; path: string }> {
    const dir = this.dir(agentId);
    await mkdir(dir, { recursive: true });
    const safe = safeFileName(wanted) ?? "download";
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length) || "file";
    for (let n = 1; n < 1_000; n += 1) {
      const name = n === 1 ? safe : `${stem} (${n})${ext}`;
      const full = join(dir, name);
      if (!(await stat(full).catch(() => undefined))) return { name, path: full };
    }
    const name = `${stem}-${Date.now()}${ext}`;
    return { name, path: join(dir, name) };
  }

  /** Save bytes as a new file; refuses when over the quota. */
  async write(agentId: string, wanted: string, bytes: Uint8Array): Promise<{ name: string; bytes: number }> {
    if (bytes.byteLength > (await this.free(agentId))) throw new Error(`The file area is full (${Math.round(this.quotaBytes / 1_048_576)} MB). Delete files or raise SIBYL_COMPUTER_FILES_MB.`);
    const target = await this.reserve(agentId, wanted);
    await writeFile(target.path, bytes);
    return { name: target.name, bytes: bytes.byteLength };
  }

  /** Text of a file (text formats only), capped. */
  async readText(agentId: string, name: string): Promise<{ text: string; truncated: boolean } | { error: string }> {
    const full = await this.path(agentId, name);
    if (!full) return { error: `There is no file named ${name}. Use computer_files to list them.` };
    if (!TEXT_EXTENSIONS.has(extname(name).toLowerCase())) {
      const info = await stat(full);
      return { error: `${name} is not a text file (${info.size} bytes); it can be uploaded to a site but not read here.` };
    }
    const text = (await readFile(full)).toString("utf8");
    return { text: text.slice(0, READ_FILE_MAX_CHARS), truncated: text.length > READ_FILE_MAX_CHARS };
  }

  async remove(agentId: string): Promise<void> {
    await rm(join(this.root, agentId), { recursive: true, force: true });
  }
}
