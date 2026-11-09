/**
 * Workspaces, knowledge bases, skills and plugins.
 *
 * - A workspace groups everything one project needs: chats, knowledge,
 *   skills, connections, routines and slide spaces, plus default
 *   instructions. Every owner has the default workspace "default"; records
 *   without a workspaceId belong to it.
 * - A knowledge base is a set of documents (uploads, web pages, pasted text)
 *   split into chunks that Sibyl searches when answering. Keyword search
 *   (SQLite FTS5) works out of the box; embeddings are an optional upgrade.
 * - A skill is a reusable, plain-language instruction pack ("how we write
 *   release notes"), loaded into the brain only when relevant.
 * - A plugin bundles skills, MCP servers, required secrets and routine
 *   templates behind one manifest, installed and removed as a unit.
 */

export const DEFAULT_WORKSPACE_ID = "default";

/* ───────────── Workspaces ───────────── */

export interface WorkspaceRecord {
  id: string;
  ownerId: string;
  name: string;
  /** One emoji-free short glyph or initials shown in the switcher. */
  icon?: string;
  /** Workspace instructions added to every system prompt in this workspace. */
  instructions?: string;
  /** Model preset used by default in this workspace (e.g. "balanced"). */
  defaultPreset?: string;
  /** Knowledge bases searched automatically in this workspace's chats. */
  knowledgeBaseIds?: string[];
  /** Spending caps for this workspace (Settings → Workspace; enforced by the usage meter). */
  budget?: SpendCaps;
  createdAt: number;
  updatedAt: number;
}

/** Daily and monthly spending caps in USD (absent: no cap). */
export interface SpendCaps {
  dailyUsd?: number;
  monthlyUsd?: number;
}

/* ───────────── Knowledge bases ───────────── */

export interface KnowledgeBaseRecord {
  id: string;
  ownerId: string;
  workspaceId: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export type KnowledgeDocSource =
  | { kind: "upload"; uploadId: string; fileName: string }
  | { kind: "url"; url: string }
  | { kind: "text" };

export type KnowledgeDocStatus = "pending" | "indexing" | "ready" | "failed";

export interface KnowledgeDocRecord {
  id: string;
  ownerId: string;
  knowledgeBaseId: string;
  title: string;
  source: KnowledgeDocSource;
  mime?: string;
  status: KnowledgeDocStatus;
  error?: string;
  chunkCount: number;
  /** Characters of extracted text. */
  size?: number;
  /** Uploaded file type (protocol FileKind). */
  fileKind?: string;
  /** Pages, slides, sheets, chapters or files, when the format has them. */
  parts?: { unit: "page" | "slide" | "sheet" | "chapter" | "file"; count: number };
  /** Text read by a vision / OCR model, and what it cost. */
  ocr?: { model: string; engine?: string; costUsd: number; estimated: boolean };
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeChunk {
  id: string;
  ownerId: string;
  knowledgeBaseId: string;
  docId: string;
  /** Position within the document (0-based). */
  ordinal: number;
  text: string;
  /** Optional heading / page label for citations. */
  label?: string;
  /** Optional embedding (when an embeddings model is configured). */
  embedding?: number[];
}

export interface KnowledgeHit {
  chunk: KnowledgeChunk;
  /** Higher is better (keyword search: inverted bm25). */
  score: number;
}

/* ───────────── Skills ───────────── */

export interface SkillRecord {
  id: string;
  ownerId: string;
  /** Undefined: available in every workspace. */
  workspaceId?: string;
  /** Stable slug, unique per owner: [a-z0-9-]{1,64}. */
  name: string;
  title: string;
  /** When to use it, written for the model ("Use when the user asks for …"). */
  description: string;
  /** The skill body (Markdown instructions), loaded only when the skill is used. */
  instructions: string;
  /** Tool names the skill expects (shown in the UI; never grants new tools). */
  tools?: string[];
  /** Small reference files bundled with the skill (templates, examples). */
  files?: Array<{ name: string; content: string }>;
  source: "builtin" | "user" | "plugin" | "agent";
  pluginId?: string;
  /** Agent that wrote it (source "agent": learned from experience, revertible). */
  agentId?: string;
  enabled: boolean;
  version?: string;
  createdAt: number;
  updatedAt: number;
}

/* ───────────── Plugins ───────────── */

export interface PluginSecretSpec {
  /** UPPER_SNAKE_CASE secret name referenced as ${secret:NAME}. */
  name: string;
  description: string;
  allowedHosts: string[];
  howToGet?: string;
  docsUrl?: string;
  optional?: boolean;
}

export type PluginMcpServerSpec =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: "http"; url: string; headers?: Record<string, string> };

export interface PluginSkillSpec {
  name: string;
  title: string;
  description: string;
  instructions: string;
  tools?: string[];
  files?: Array<{ name: string; content: string }>;
}

export interface PluginRoutineTemplate {
  name: string;
  instruction: string;
  /** Suggested 5-field cron; the user confirms before it is created. */
  cron: string;
}

/** An empty knowledge base a plugin creates (e.g. "Research sources"). */
export interface PluginKnowledgeBaseSpec {
  name: string;
  description?: string;
}

/** sibyl-plugin.json */
export interface PluginManifest {
  /** Manifest format version (currently 1). */
  manifestVersion?: 1;
  /** [a-z0-9-]{1,64} */
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  license?: string;
  skills?: PluginSkillSpec[];
  mcpServers?: Record<string, PluginMcpServerSpec>;
  secrets?: PluginSecretSpec[];
  routines?: PluginRoutineTemplate[];
  /** Knowledge bases created (empty) in the install workspace. */
  knowledgeBases?: PluginKnowledgeBaseSpec[];
}

export type PluginSource =
  | { kind: "catalog"; ref: string }
  | { kind: "url"; ref: string }
  | { kind: "git"; ref: string }
  | { kind: "local"; ref: string };

export interface PluginRecord {
  id: string;
  ownerId: string;
  /** Undefined: installed for every workspace. */
  workspaceId?: string;
  manifest: PluginManifest;
  source: PluginSource;
  enabled: boolean;
  /** needs_secrets: installed, waiting for required secrets. */
  status: "ready" | "needs_secrets" | "error";
  error?: string;
  installedAt: number;
  updatedAt: number;
}

/* ───────────── Store collections ───────────── */

export interface WorkspaceStore {
  workspaces: {
    list(ownerId: string): Promise<WorkspaceRecord[]>;
    get(ownerId: string, id: string): Promise<WorkspaceRecord | undefined>;
    upsert(record: WorkspaceRecord): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
  };
  knowledge: {
    listBases(ownerId: string, filter?: { workspaceId?: string }): Promise<KnowledgeBaseRecord[]>;
    getBase(ownerId: string, id: string): Promise<KnowledgeBaseRecord | undefined>;
    upsertBase(record: KnowledgeBaseRecord): Promise<void>;
    /** Removes the base, its documents and chunks. */
    removeBase(ownerId: string, id: string): Promise<void>;
    listDocs(ownerId: string, knowledgeBaseId: string): Promise<KnowledgeDocRecord[]>;
    getDoc(ownerId: string, id: string): Promise<KnowledgeDocRecord | undefined>;
    upsertDoc(record: KnowledgeDocRecord): Promise<void>;
    /** Removes the document and its chunks. */
    removeDoc(ownerId: string, id: string): Promise<void>;
    /** Replace all chunks of a document (re-indexing). */
    replaceChunks(ownerId: string, docId: string, chunks: KnowledgeChunk[]): Promise<void>;
    /** Keyword search across the given bases, best first. */
    search(ownerId: string, knowledgeBaseIds: string[], query: string, limit?: number): Promise<KnowledgeHit[]>;
    /** All chunks of the given bases (for embedding search; small bases only). */
    chunks(ownerId: string, knowledgeBaseIds: string[]): Promise<KnowledgeChunk[]>;
  };
  skills: {
    list(ownerId: string, filter?: { workspaceId?: string }): Promise<SkillRecord[]>;
    get(ownerId: string, id: string): Promise<SkillRecord | undefined>;
    upsert(record: SkillRecord): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
  };
  plugins: {
    list(ownerId: string): Promise<PluginRecord[]>;
    get(ownerId: string, id: string): Promise<PluginRecord | undefined>;
    upsert(record: PluginRecord): Promise<void>;
    remove(ownerId: string, id: string): Promise<void>;
  };
}

/** Records without a workspaceId belong to the default workspace. */
export function inWorkspace(record: { workspaceId?: string }, workspaceId: string | undefined): boolean {
  if (!workspaceId) return true;
  return (record.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId;
}

/** Skills/plugins without a workspace apply everywhere. */
export function availableInWorkspace(record: { workspaceId?: string }, workspaceId: string | undefined): boolean {
  return !record.workspaceId || !workspaceId || record.workspaceId === workspaceId;
}

/** Simple keyword scoring for the in-memory store (FTS5 does this in SQLite). */
export function keywordScore(text: string, query: string): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  const words = tokenize(text);
  if (words.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  let score = 0;
  for (const term of new Set(terms)) {
    let tf = counts.get(term) ?? 0;
    if (tf === 0) {
      // Crude stemming: "returns" matches "return", "policies" ~ "policy".
      for (const [word, count] of counts) if (word.startsWith(term.slice(0, Math.max(4, term.length - 2)))) tf += count;
    }
    if (tf > 0) score += (tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * words.length) / 120));
  }
  return score;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}
