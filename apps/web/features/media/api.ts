"use client";

/**
 * Browser side of the gateway's /api/media (models, estimates, the gallery,
 * one item, cancel, delete) plus the per-workspace preferences of the
 * Create controls (last model per kind and its settings).
 */
import type {
  MediaCollectionView,
  MediaCreateSpec,
  MediaItemPatch,
  MediaItemView,
  MediaKind,
  MediaModelView,
  MediaModelsResponse
} from "@open-gpt-live/protocol";
import { currentWorkspaceId } from "../../lib/app-session";
import { gatewayDownload, gatewayObjectUrl, gatewayRequest } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";

/** The Media place (also `paths.media`). */
export const MEDIA_PATH = paths.media;
export const mediaItemPath = (id: string) => `${MEDIA_PATH}/${encodeURIComponent(id)}`;

let modelsCache: { workspace: string | null; at: number; value: Promise<MediaModelsResponse> } | undefined;

/** The media models (cached for 10 minutes per workspace). */
export function loadMediaModels(force = false): Promise<MediaModelsResponse> {
  const workspace = currentWorkspaceId();
  if (!force && modelsCache && modelsCache.workspace === workspace && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.value;
  const value = gatewayRequest<MediaModelsResponse>("/api/media/models");
  modelsCache = { workspace, at: Date.now(), value };
  value.catch(() => {
    if (modelsCache?.value === value) modelsCache = undefined;
  });
  return value;
}

export interface MediaEstimate {
  usd: number;
  detail: string;
  model: string;
  needsApproval: boolean;
}

export function estimateMedia(spec: MediaCreateSpec & { prompt?: string }, signal?: AbortSignal): Promise<MediaEstimate> {
  return gatewayRequest<MediaEstimate>("/api/media/estimate", { method: "POST", body: spec, ...(signal ? { signal } : {}) });
}

export interface MediaFilter {
  kind?: MediaKind;
  model?: string;
  creator?: string;
  q?: string;
  conversationId?: string;
  collection?: string;
  favorites?: "1";
}

export async function listMedia(filter: MediaFilter = {}, signal?: AbortSignal): Promise<MediaItemView[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const query = params.toString();
  return (await gatewayRequest<{ items: MediaItemView[] }>(`/api/media${query ? `?${query}` : ""}`, signal ? { signal } : {})).items;
}

export async function getMedia(id: string, signal?: AbortSignal): Promise<MediaItemView> {
  return (await gatewayRequest<{ item: MediaItemView }>(`/api/media/${encodeURIComponent(id)}`, signal ? { signal } : {})).item;
}

export async function mediaByUpload(uploadId: string, signal?: AbortSignal): Promise<MediaItemView | undefined> {
  try {
    return (await gatewayRequest<{ item: MediaItemView }>(`/api/media/by-upload/${encodeURIComponent(uploadId)}`, signal ? { signal } : {})).item;
  } catch {
    return undefined;
  }
}

export async function updateMedia(id: string, patch: MediaItemPatch): Promise<MediaItemView> {
  return (await gatewayRequest<{ item: MediaItemView }>(`/api/media/${encodeURIComponent(id)}`, { method: "PATCH", body: patch })).item;
}

/* ───────────── library collections ───────────── */

export async function listCollections(): Promise<MediaCollectionView[]> {
  return (await gatewayRequest<{ collections: MediaCollectionView[] }>("/api/media/collections")).collections;
}

export async function createCollection(name: string): Promise<MediaCollectionView> {
  return (await gatewayRequest<{ collection: MediaCollectionView }>("/api/media/collections", { method: "POST", body: { name } })).collection;
}

export async function renameCollection(id: string, name: string): Promise<void> {
  await gatewayRequest(`/api/media/collections/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } });
}

export async function deleteCollection(id: string): Promise<void> {
  await gatewayRequest(`/api/media/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ───────────── handing an item to chat ───────────── */

/**
 * The library hands work to chat (the one place media is made):
 *  - "create": open chat in Image / Video / Audio mode;
 *  - "use": the item as an @ reference in the composer;
 *  - "remix": the composer prefilled with its prompt, model, settings and references.
 * Kept in sessionStorage for the next chat screen to pick up.
 */
export type ChatMediaIntent = { action: "create"; kind: MediaKind } | { action: "use" | "remix"; item: MediaItemView };

const INTENT_KEY = "sibyl.media.chatIntent";
/** Fired after an intent is stashed, for a chat screen that is already open. */
export const CHAT_INTENT_EVENT = "sibyl:media-chat-intent";

export function stashChatIntent(intent: ChatMediaIntent): void {
  try {
    window.sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
    // After the navigation settles (the chat may open another conversation first).
    window.setTimeout(() => window.dispatchEvent(new Event(CHAT_INTENT_EVENT)), 700);
  } catch {
    // Private mode: the chat just opens without it.
  }
}

export function takeChatIntent(): ChatMediaIntent | undefined {
  try {
    const raw = window.sessionStorage.getItem(INTENT_KEY);
    if (!raw) return undefined;
    window.sessionStorage.removeItem(INTENT_KEY);
    return JSON.parse(raw) as ChatMediaIntent;
  } catch {
    return undefined;
  }
}

/** Where "Use in chat" / "Remix in chat" go: the chat it was made in, else a new one. */
export function chatPathFor(item: MediaItemView): string {
  return item.conversationId ? paths.conversation(item.conversationId) : paths.newChat;
}

export async function cancelMedia(id: string): Promise<MediaItemView> {
  return (await gatewayRequest<{ item: MediaItemView }>(`/api/media/${encodeURIComponent(id)}/cancel`, { method: "POST" })).item;
}

export async function deleteMedia(id: string): Promise<void> {
  await gatewayRequest(`/api/media/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** A generated file as an object URL (revoke when done). */
export function mediaFileUrl(uploadId: string, signal?: AbortSignal): Promise<string> {
  return gatewayObjectUrl(`/api/uploads/${encodeURIComponent(uploadId)}`, signal);
}

export function downloadMediaFile(uploadId: string, fallbackName: string): Promise<void> {
  return gatewayDownload(`/api/uploads/${encodeURIComponent(uploadId)}?download=1`, fallbackName);
}

export async function saveMediaToKnowledge(uploadId: string): Promise<string> {
  const result = await gatewayRequest<{ base: { name: string } }>("/api/knowledge/save-upload", { method: "POST", body: { uploadId } });
  return result.base.name;
}

/* ───────────── preferences (per workspace, this browser) ───────────── */

export interface MediaPrefs {
  model?: Partial<Record<MediaKind, string>>;
  settings?: Record<string, Record<string, string | number | boolean>>;
}

function prefsKey(): string {
  return `sibyl.media.prefs.${currentWorkspaceId() ?? "default"}`;
}

export function readMediaPrefs(): MediaPrefs {
  try {
    const raw = window.localStorage.getItem(prefsKey());
    return raw ? (JSON.parse(raw) as MediaPrefs) : {};
  } catch {
    return {};
  }
}

export function writeMediaPrefs(update: (prefs: MediaPrefs) => MediaPrefs): void {
  try {
    window.localStorage.setItem(prefsKey(), JSON.stringify(update(readMediaPrefs())));
  } catch {
    // Private mode: preferences just aren't remembered.
  }
}

/** The model to show for a kind: remembered, else the workspace default, else the first. */
export function preferredModel(kind: MediaKind, models: MediaModelsResponse): MediaModelView | undefined {
  const ofKind = models.models.filter((model) => model.kind === kind);
  const remembered = readMediaPrefs().model?.[kind];
  return ofKind.find((m) => m.id === remembered) ?? ofKind.find((m) => m.id === models.defaults[kind]) ?? ofKind[0];
}

/** Settings for a model: remembered values that are still valid, else its defaults. */
export function settingsFor(model: MediaModelView): Record<string, string | number | boolean> {
  const remembered = readMediaPrefs().settings?.[model.id] ?? {};
  const settings: Record<string, string | number | boolean> = {};
  for (const param of model.params) {
    const value = remembered[param.key];
    if (value !== undefined && (param.type !== "enum" || (param.values ?? []).some((option) => String(option) === String(value)))) settings[param.key] = value;
    else if (param.default !== undefined) settings[param.key] = param.default;
  }
  return settings;
}

export function rememberChoice(kind: MediaKind, model: string, settings: Record<string, string | number | boolean>): void {
  writeMediaPrefs((prefs) => ({ model: { ...prefs.model, [kind]: model }, settings: { ...prefs.settings, [model]: settings } }));
}

/* ───────────── formatting ───────────── */

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(value < 1 ? 3 : 2).replace(/0$/, "")}`;
}

export const KIND_LABEL: Record<MediaKind, string> = { image: "Image", video: "Video", audio: "Audio" };

export function mediaTypeOf(mime: string): MediaKind {
  return mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image";
}
