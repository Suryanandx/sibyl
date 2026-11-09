/**
 * Memory across chats: small, explicit, user-controlled facts ("I prefer
 * metric units", "my company is Acme"). Stored in `store.kv` as one list per
 * person per workspace (see memoryKeys), so no new storage contract is needed.
 *
 * - Personal: a signed-in person's facts are theirs, within the workspace
 *   they were saved in. The owner token and local mode share the owner's list.
 * - The on/off switch is per workspace (workspace.settings to change).
 * - Only facts the user stated; never secrets (see `looksSecret`).
 * - Capped: MAX_MEMORIES items of MAX_MEMORY_CHARS each.
 * - Injected into system prompts as a compact block (MEMORY_PROMPT_CHARS),
 *   pinned first, then most recently updated.
 * - SIBYL_MEMORY=false turns the whole feature off; the user can also turn it
 *   off from the Memory tab (kv `memory.enabled`).
 */
import { DEFAULT_WORKSPACE_ID, type Principal, type Store } from "@open-gpt-live/core";
import { newId } from "../http/ids.js";

export const MEMORY_ITEMS_KEY = "memory.items";
export const MEMORY_ENABLED_KEY = "memory.enabled";
export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 300;
export const MEMORY_PROMPT_CHARS = 1_500;

export interface MemoryItem {
  id: string;
  text: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryState {
  /** False when SIBYL_MEMORY=false (the feature is off for this gateway). */
  available: boolean;
  /** The user's switch (Memory tab). */
  enabled: boolean;
  items: MemoryItem[];
}

export class MemoryError extends Error {
  constructor(message: string, readonly code: "secret" | "empty" | "too_long" | "full" | "not_found" | "disabled") {
    super(message);
  }
}

/** True unless SIBYL_MEMORY is explicitly false/0/no/off. */
export function memoryAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(false|0|no|off)$/i.test(env.SIBYL_MEMORY?.trim() ?? "");
}

const SECRET_PATTERNS: RegExp[] = [
  // Credentials stated in words.
  /\b(password|passwd|passphrase|passcode|pwd|pin( code| number)?|otp|2fa code|mfa code|security (code|answer)|cvv|cvc|login code)\b\s*(is|=|:|was)\s*\S+/i,
  /\bmy (password|passwd|passphrase|passcode|pin)\b/i,
  /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|bearer|private[ _-]?key|client[ _-]?secret|seed phrase|recovery phrase|mnemonic)\b/i,
  // Well-known key formats.
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  // US social security number.
  /\b\d{3}-\d{2}-\d{4}\b/,
  // IBAN.
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/
];

/**
 * Heuristic: does this text look like a password, key, token or card number?
 * Errs on the side of refusing — the user can always rephrase.
 */
export function looksSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // Card numbers: 13–19 digits (spaces/dashes allowed) that pass Luhn.
  for (const match of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  // Long opaque tokens (high-entropy strings mixing letters and digits).
  for (const match of text.matchAll(/[A-Za-z0-9_+/=-]{32,}/g)) {
    const token = match[0];
    if (/[A-Za-z]/.test(token) && /\d/.test(token) && new Set(token).size >= 12) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Normalise and validate a fact before it is stored. */
export function cleanMemoryText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new MemoryError("Nothing to remember.", "empty");
  if (text.length > MAX_MEMORY_CHARS) {
    throw new MemoryError(`Too long to remember (max ${MAX_MEMORY_CHARS} characters). Keep it to one short fact.`, "too_long");
  }
  if (looksSecret(text)) {
    throw new MemoryError(
      "That looks like a password, key, token or card number. Sibyl never stores secrets in memory.",
      "secret"
    );
  }
  return text;
}

/** Whose memory: the person (absent or not a signed-in user: the owner) in a workspace (absent: default). */
export interface MemoryScope {
  principal?: Principal;
  workspaceId?: string;
}

/**
 * The kv keys of one scope. The owner's facts in the default workspace keep
 * the original keys, so memory saved before workspaces is still found.
 */
export function memoryKeys(scope: MemoryScope = {}): { items: string; enabled: string } {
  const workspaceId = scope.workspaceId || DEFAULT_WORKSPACE_ID;
  const person = scope.principal?.kind === "user" && scope.principal.userId ? `user:${scope.principal.userId}` : undefined;
  const enabled = workspaceId === DEFAULT_WORKSPACE_ID ? MEMORY_ENABLED_KEY : `${MEMORY_ENABLED_KEY}:${workspaceId}`;
  if (!person && workspaceId === DEFAULT_WORKSPACE_ID) return { items: MEMORY_ITEMS_KEY, enabled };
  return { items: `${MEMORY_ITEMS_KEY}:${workspaceId}:${person ?? "owner"}`, enabled };
}

export interface MemoryServiceOptions extends MemoryScope {
  store: Store;
  ownerId: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  createId?: () => string;
}

/** One person's memory list in kv. Writes are serialised so concurrent adds don't clobber each other. */
export class MemoryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly keys: { items: string; enabled: string };

  constructor(private readonly options: MemoryServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => newId("mem"));
    this.keys = memoryKeys(options);
  }

  get available(): boolean {
    return memoryAvailable(this.options.env);
  }

  async state(): Promise<MemoryState> {
    return { available: this.available, enabled: await this.enabled(), items: await this.list() };
  }

  async enabled(): Promise<boolean> {
    if (!this.available) return false;
    const value = await this.options.store.kv.get<boolean>(this.options.ownerId, this.keys.enabled);
    return value !== false;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.options.store.kv.set(this.options.ownerId, this.keys.enabled, enabled);
  }

  /** Pinned first, then most recently updated. */
  async list(): Promise<MemoryItem[]> {
    const raw = await this.options.store.kv.get<unknown>(this.options.ownerId, this.keys.items);
    const items = Array.isArray(raw) ? raw.filter(isMemoryItem) : [];
    return sortMemories(items);
  }

  async add(text: unknown, extra: { pinned?: boolean } = {}): Promise<MemoryItem> {
    const clean = cleanMemoryText(text);
    return this.mutate((items) => {
      const duplicate = items.find((item) => item.text.toLowerCase() === clean.toLowerCase());
      if (duplicate) {
        duplicate.updatedAt = this.now();
        if (extra.pinned !== undefined) duplicate.pinned = extra.pinned;
        return duplicate;
      }
      if (items.length >= MAX_MEMORIES) {
        throw new MemoryError(`Memory is full (${MAX_MEMORIES} facts). Remove some in Settings → Memory.`, "full");
      }
      const at = this.now();
      const item: MemoryItem = { id: this.createId(), text: clean, ...(extra.pinned ? { pinned: true } : {}), createdAt: at, updatedAt: at };
      items.push(item);
      return item;
    });
  }

  async update(id: string, patch: { text?: unknown; pinned?: boolean }): Promise<MemoryItem> {
    const text = patch.text === undefined ? undefined : cleanMemoryText(patch.text);
    return this.mutate((items) => {
      const item = items.find((entry) => entry.id === id);
      if (!item) throw new MemoryError("No such memory.", "not_found");
      if (text !== undefined) item.text = text;
      if (patch.pinned !== undefined) {
        if (patch.pinned) item.pinned = true;
        else delete item.pinned;
      }
      item.updatedAt = this.now();
      return item;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    });
  }

  /** Remove by id, or every fact whose text contains `query` (case-insensitive). */
  async forget(query: string): Promise<MemoryItem[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.mutate((items) => {
      const removed = items.filter((item) => item.id === query.trim() || item.text.toLowerCase().includes(needle));
      for (const item of removed) items.splice(items.indexOf(item), 1);
      return removed;
    });
  }

  async clear(): Promise<void> {
    await this.mutate((items) => {
      items.splice(0, items.length);
    });
  }

  /** Compact "What you know about the user" block, or "" when off/empty. */
  async promptBlock(maxChars = MEMORY_PROMPT_CHARS): Promise<string> {
    if (!(await this.enabled())) return "";
    return formatMemoryBlock(await this.list(), maxChars);
  }

  private mutate<T>(change: (items: MemoryItem[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const items = await this.list();
      const result = change(items);
      await this.options.store.kv.set(this.options.ownerId, this.keys.items, items);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export function sortMemories(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
}

const BLOCK_HEADER =
  "\n\n## What you know about the user\n" +
  "Facts the user asked you to remember (from earlier chats). Use them when relevant; don't recite them unprompted.\n";

export function formatMemoryBlock(items: MemoryItem[], maxChars = MEMORY_PROMPT_CHARS): string {
  if (items.length === 0) return "";
  let body = "";
  for (const item of sortMemories(items)) {
    const line = `- ${item.text}\n`;
    if (BLOCK_HEADER.length + body.length + line.length > maxChars) break;
    body += line;
  }
  return body ? `${BLOCK_HEADER}${body}`.trimEnd() : "";
}

function isMemoryItem(value: unknown): value is MemoryItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.text === "string" && typeof item.createdAt === "number" && typeof item.updatedAt === "number";
}

/**
 * The one helper every prompt-building site calls: returns `prompt` with the
 * memory block appended (unchanged when memory is off, empty or unreadable).
 */
export async function withUserMemory(
  prompt: string,
  input: { store: Store; ownerId: string; env?: NodeJS.ProcessEnv } & MemoryScope
): Promise<string> {
  try {
    const block = await new MemoryService(input).promptBlock();
    return block ? `${prompt}${block}` : prompt;
  } catch {
    return prompt;
  }
}
