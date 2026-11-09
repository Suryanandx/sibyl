/**
 * The side panel's state, as plain functions (store.ts wraps them; tests use
 * them directly).
 *
 * - Each conversation has its own Activity list (what the AI did or made).
 * - Something the person opens always shows. Something the AI starts (its
 *   computer, a deck build, a media job) opens the panel only if the person
 *   hasn't closed it in this conversation; otherwise it waits in the list.
 * - A build that is still running is a placeholder entry tied to its tool
 *   call; when the call finishes it becomes the real item (or shows it failed).
 */
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import type { SidePanelItem, SidePanelKind } from "./events";

export interface PanelEntry {
  key: string;
  item: SidePanelItem;
  /** Building (a tool call is still running) or failed. Absent: ready. */
  status?: "running" | "failed";
  /** The tool call building this entry. */
  callId?: string;
  /** The deck, when the chat saw it (so the panel can show it after a reload). */
  artifact?: ToolArtifactView;
  at: number;
}

export interface PanelState {
  /** The conversation on screen ("" for a new chat that has no id yet). */
  conversation: string;
  open: boolean;
  activeKey: string | null;
  history: Record<string, PanelEntry[]>;
  /** Conversations in which the person closed the panel (no more auto-opening there). */
  dismissed: Record<string, true>;
  width: number;
}

export type PanelAction =
  | { type: "open"; item: SidePanelItem; auto?: boolean; status?: "running"; callId?: string; artifact?: ToolArtifactView; at: number }
  /** Add to the Activity list without showing it. */
  | { type: "record"; item: SidePanelItem; at: number }
  /** A building entry's tool call finished: the real item, or null when it failed. */
  | { type: "resolve"; callId: string; item: SidePanelItem | null; artifact?: ToolArtifactView; at: number }
  | { type: "select"; key: string }
  /** `user`: the person closed it (no more auto-opening in this conversation). */
  | { type: "close"; user: boolean }
  | { type: "toggle" }
  | { type: "remove"; key: string }
  | { type: "conversation"; id: string | null }
  | { type: "width"; width: number }
  /** Back/Forward or a reload named this entry in the address. */
  | { type: "show"; key: string; at: number };

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 960;
export const DEFAULT_WIDTH = 480;
export const MAX_ENTRIES = 30;
export const MAX_CONVERSATIONS = 40;

export function initialState(partial: Partial<PanelState> = {}): PanelState {
  return { conversation: "", open: false, activeKey: null, history: {}, dismissed: {}, width: DEFAULT_WIDTH, ...partial };
}

export function clampWidth(width: number, viewport = Infinity): number {
  const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(viewport * 0.6)));
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

/* ───────────── keys (also the `?panel=` value) ───────────── */

/** Stable id of an item: `<kind>:<id>` (the colon keeps it apart from legacy `?panel=` names). */
export function itemKey(item: SidePanelItem): string {
  switch (item.kind) {
    case "media":
    case "file":
      return `${item.kind}:${item.uploadId}`;
    case "computer":
      return `computer:${item.agentId}${item.runId ? `/${item.runId}` : ""}`;
    case "slides":
      return `slides:${item.artifactId}`;
    case "visual":
      return `visual:${item.requestId}`;
    case "url":
      return `url:${item.url}`;
  }
}

const KINDS: readonly SidePanelKind[] = ["media", "computer", "slides", "visual", "file", "url"];

/**
 * The item a key names, when the key alone is enough (a link someone shared
 * or a reload before the Activity list loaded). Media and files need their
 * type, so they only come back from the list.
 */
export function itemFromKey(key: string): SidePanelItem | null {
  const colon = key.indexOf(":");
  if (colon < 1) return null;
  const kind = key.slice(0, colon) as SidePanelKind;
  const rest = key.slice(colon + 1);
  if (!KINDS.includes(kind) || !rest || isPendingId(rest)) return null;
  switch (kind) {
    case "computer": {
      const [agentId, runId] = rest.split("/");
      return agentId ? { kind, agentId, ...(runId ? { runId } : {}) } : null;
    }
    case "slides":
      return { kind, artifactId: rest };
    case "visual":
      return { kind, requestId: rest };
    case "url":
      return safeHttpUrl(rest) ? { kind, url: rest } : null;
    default:
      return null;
  }
}

/** Placeholder ids for builds that have no artifact yet. */
export function pendingId(callId: string): string {
  return `pending-${callId}`;
}

export function isPendingId(id: string): boolean {
  return id.startsWith("pending-");
}

/** Only http(s) links are shown or opened. */
export function safeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/* ───────────── reducer ───────────── */

export function entriesOf(state: PanelState, conversation = state.conversation): PanelEntry[] {
  return state.history[conversation] ?? [];
}

export function activeEntry(state: PanelState): PanelEntry | null {
  if (!state.activeKey) return null;
  return entriesOf(state).find((entry) => entry.key === state.activeKey) ?? null;
}

export function reduce(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open": {
      const key = itemKey(action.item);
      const known = entriesOf(state).some((entry) => entry.key === key);
      const next = upsert(state, {
        key,
        item: action.item,
        at: action.at,
        ...(action.status ? { status: action.status } : {}),
        ...(action.callId ? { callId: action.callId } : {}),
        ...(action.artifact ? { artifact: action.artifact } : {})
      });
      if (!action.auto) {
        const { [state.conversation]: _cleared, ...dismissed } = next.dismissed;
        return { ...next, open: true, activeKey: key, dismissed };
      }
      // The AI started something: show it unless the person closed the panel
      // here, and don't pull them away from another entry they are looking at
      // for something already in the list.
      if (state.dismissed[state.conversation]) return next;
      if (state.open && known && state.activeKey !== key) return next;
      return { ...next, open: true, activeKey: key };
    }
    case "record":
      return upsert(state, { key: itemKey(action.item), item: action.item, at: action.at });
    case "resolve": {
      const entries = entriesOf(state);
      const index = entries.findIndex((entry) => entry.callId === action.callId);
      if (index < 0) return state;
      const old = entries[index]!;
      if (!action.item) {
        const failed: PanelEntry = { ...old, status: "failed" };
        return withEntries(state, entries.map((entry, i) => (i === index ? failed : entry)));
      }
      const key = itemKey(action.item);
      const ready: PanelEntry = {
        key,
        item: action.item,
        at: action.at,
        ...(action.artifact ? { artifact: action.artifact } : {})
      };
      // A revision of a deck already in the list replaces it in place.
      const rest = entries.filter((entry, i) => i !== index && entry.key !== key);
      rest.splice(Math.min(index, rest.length), 0, ready);
      return { ...withEntries(state, rest), activeKey: state.activeKey === old.key ? key : state.activeKey };
    }
    case "select":
      return entriesOf(state).some((entry) => entry.key === action.key) ? { ...state, open: true, activeKey: action.key } : state;
    case "show": {
      const entry = entriesOf(state).find((candidate) => candidate.key === action.key);
      if (entry) return { ...state, open: true, activeKey: entry.key };
      const item = itemFromKey(action.key);
      if (!item) return state;
      return { ...upsert(state, { key: action.key, item, at: action.at }), open: true, activeKey: action.key };
    }
    case "close":
      return {
        ...state,
        open: false,
        dismissed: action.user ? { ...state.dismissed, [state.conversation]: true } : state.dismissed
      };
    case "toggle": {
      if (state.open) return reduce(state, { type: "close", user: true });
      const entries = entriesOf(state);
      if (!entries.length) return state;
      const activeKey = entries.some((entry) => entry.key === state.activeKey) ? state.activeKey : entries[entries.length - 1]!.key;
      const { [state.conversation]: _cleared, ...dismissed } = state.dismissed;
      return { ...state, open: true, activeKey, dismissed };
    }
    case "remove": {
      const entries = entriesOf(state).filter((entry) => entry.key !== action.key);
      const next = withEntries(state, entries);
      if (state.activeKey !== action.key) return next;
      const last = entries[entries.length - 1];
      return { ...next, activeKey: last?.key ?? null, open: Boolean(last) && state.open };
    }
    case "conversation": {
      const id = action.id ?? "";
      if (id === state.conversation) return state;
      // A new chat just got its id (first message): it keeps its Activity list and panel.
      const fresh = state.conversation === "" && id !== "" && !state.history[id]?.length;
      if (fresh) {
        const { [""]: entries, ...history } = state.history;
        const { [""]: wasDismissed, ...dismissed } = state.dismissed;
        return {
          ...state,
          conversation: id,
          history: entries?.length ? { ...history, [id]: entries } : history,
          dismissed: wasDismissed ? { ...dismissed, [id]: true } : dismissed
        };
      }
      // Another chat: its own list comes back, closed until opened.
      const entries = state.history[id] ?? [];
      const { [""]: _unsaved, ...history } = state.history;
      const { [""]: _unsavedDismissed, ...dismissed } = state.dismissed;
      return { ...state, conversation: id, open: false, activeKey: entries[entries.length - 1]?.key ?? null, history, dismissed };
    }
    case "width":
      return { ...state, width: clampWidth(action.width) };
  }
}

function upsert(state: PanelState, entry: PanelEntry): PanelState {
  const entries = entriesOf(state);
  const index = entries.findIndex((candidate) => candidate.key === entry.key);
  if (index >= 0) {
    const merged: PanelEntry = { ...entries[index]!, ...entry, artifact: entry.artifact ?? entries[index]!.artifact };
    if (!entry.status) delete merged.status;
    if (!merged.artifact) delete merged.artifact;
    return withEntries(state, entries.map((candidate, i) => (i === index ? merged : candidate)));
  }
  return withEntries(state, [...entries, entry].slice(-MAX_ENTRIES));
}

function withEntries(state: PanelState, entries: PanelEntry[]): PanelState {
  const history = { ...state.history, [state.conversation]: entries };
  if (!entries.length) delete history[state.conversation];
  return { ...state, history: trimConversations(history, state.conversation) };
}

/** Keep the most recently used conversations' lists. */
function trimConversations(history: Record<string, PanelEntry[]>, current: string): Record<string, PanelEntry[]> {
  const ids = Object.keys(history);
  if (ids.length <= MAX_CONVERSATIONS) return history;
  const lastUsed = (id: string) => Math.max(0, ...(history[id] ?? []).map((entry) => entry.at));
  const keep = new Set(
    ids
      .filter((id) => id !== current)
      .sort((a, b) => lastUsed(b) - lastUsed(a))
      .slice(0, MAX_CONVERSATIONS - 1)
  );
  keep.add(current);
  return Object.fromEntries(Object.entries(history).filter(([id]) => keep.has(id)));
}

/* ───────────── what is kept in the browser ───────────── */

export interface StoredPanel {
  width: number;
  history: Record<string, PanelEntry[]>;
  dismissed: Record<string, true>;
}

/** What survives a reload: finished entries of saved chats, closed-here marks, the width. */
export function toStored(state: PanelState): StoredPanel {
  const history: Record<string, PanelEntry[]> = {};
  for (const [id, entries] of Object.entries(state.history)) {
    if (!id) continue;
    const kept = entries.filter((entry) => entry.status !== "running");
    if (kept.length) history[id] = kept;
  }
  const { [""]: _unsaved, ...dismissed } = state.dismissed;
  return { width: state.width, history, dismissed };
}

export function fromStored(value: unknown): Partial<PanelState> {
  if (!value || typeof value !== "object") return {};
  const stored = value as Partial<StoredPanel>;
  const history: Record<string, PanelEntry[]> = {};
  if (stored.history && typeof stored.history === "object") {
    for (const [id, entries] of Object.entries(stored.history)) {
      if (!Array.isArray(entries)) continue;
      const valid = entries.filter(
        (entry): entry is PanelEntry =>
          Boolean(entry) && typeof entry.key === "string" && Boolean(entry.item) && typeof entry.item.kind === "string" && entry.status !== "running"
      );
      if (valid.length) history[id] = valid.slice(-MAX_ENTRIES);
    }
  }
  const dismissed: Record<string, true> = {};
  if (stored.dismissed && typeof stored.dismissed === "object") {
    for (const [id, flag] of Object.entries(stored.dismissed)) if (flag === true) dismissed[id] = true;
  }
  return { history, dismissed, ...(typeof stored.width === "number" ? { width: clampWidth(stored.width) } : {}) };
}
