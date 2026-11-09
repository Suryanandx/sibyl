"use client";

/**
 * Browser side of the gateway's /api/slides (never the slides engine
 * directly). Requests go through the shared gateway client.
 */
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { gatewayDownload, gatewayFetch, gatewayObjectUrl, gatewayRequest, readEventStream } from "../../lib/gateway-http";

/* ───────────── types (as the gateway's slides/http.ts sends them) ───────────── */

export interface SlidesSpace {
  id: string;
  name: string;
  instructions?: string;
  template?: string;
  deckCount: number;
}

/** All versions of one deck, newest first. */
export interface DeckGroup {
  id: string;
  title: string;
  spaceId?: string;
  latest: ToolArtifactView;
  versions: ToolArtifactView[];
  updatedAt: number;
}

export interface SlidesSource {
  id: string;
  label: string;
  kind: "tool" | "mcp";
  /** "web" (search, pages, Wikipedia…) or "connections" (MCP, knowledge bases). */
  group?: string;
  description?: string;
  tools: string[];
}

export interface SlidesSourceGroup {
  id: string;
  label: string;
}

export interface SlidesTemplate {
  id: string;
  name: string;
  description?: string;
}

export type SlidesProgressEvent =
  | { type: "job"; id: string }
  | { type: "step"; step: "researching"; tools: string[] }
  | { type: "step"; step: "outlining" }
  | { type: "step"; step: "generating"; nSlides: number; estimateUsd: number }
  | { type: "tool"; callId: string; name: string; title: string; status: "running" | "ok" | "error" | "declined"; summary?: string }
  | { type: "done"; artifact: ToolArtifactView }
  | { type: "error"; message: string };

export interface GenerateRequest {
  prompt: string;
  title?: string;
  sources: string[];
  spaceId?: string;
  template?: string;
  nSlides: number;
}

export interface SlidesJob {
  id: string;
  title: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  artifact?: ToolArtifactView;
  message?: string;
}

/* ───────────── calls ───────────── */

const id = (value: string) => encodeURIComponent(value);

export const slidesApi = {
  status: () => gatewayRequest<{ enabled: boolean }>("/api/slides/status"),
  sources: () => gatewayRequest<{ sources: SlidesSource[]; groups?: SlidesSourceGroup[] }>("/api/slides/sources"),
  templates: async () => (await gatewayRequest<{ templates: SlidesTemplate[] }>("/api/slides/templates")).templates,
  spaces: async () => (await gatewayRequest<{ spaces: SlidesSpace[] }>("/api/slides/spaces")).spaces,
  createSpace: async (name: string) => (await gatewayRequest<{ space: SlidesSpace }>("/api/slides/spaces", { method: "POST", body: { name } })).space,
  updateSpace: (space: SlidesSpace) =>
    gatewayRequest(`/api/slides/spaces/${id(space.id)}`, {
      method: "PATCH",
      body: { name: space.name, instructions: space.instructions ?? "", template: space.template ?? "" }
    }),
  deleteSpace: (spaceId: string) => gatewayRequest(`/api/slides/spaces/${id(spaceId)}`, { method: "DELETE" }),
  decks: async (spaceId?: string) =>
    (await gatewayRequest<{ decks: DeckGroup[] }>(`/api/slides/decks${spaceId ? `?spaceId=${id(spaceId)}` : ""}`)).decks,
  jobs: async () => (await gatewayRequest<{ jobs: SlidesJob[] }>("/api/slides/jobs")).jobs,
  /** Stop a running build (otherwise it outlives the page). */
  cancelJob: (jobId: string) => gatewayRequest(`/api/slides/jobs/${id(jobId)}`, { method: "DELETE" }).then(
    () => undefined,
    () => undefined
  ),
  /** POST /api/slides/generate and follow its progress events. */
  generate: async (request: GenerateRequest, onEvent: (event: SlidesProgressEvent) => void, signal?: AbortSignal) => {
    const response = await gatewayFetch("/api/slides/generate", { method: "POST", body: request, ...(signal ? { signal } : {}) });
    await readEventStream(response, onEvent);
  }
};

/** Download a deck (auth stays in headers, out of URLs). */
export function downloadDeck(artifact: ToolArtifactView, format: "pptx" | "pdf"): Promise<void> {
  const path = artifact.downloads?.[format];
  if (!path) return Promise.reject(new Error("No download for this deck."));
  return gatewayDownload(path, `${artifact.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "deck"}.${format}`);
}

/** Thumbnail as an object URL, or undefined. */
export async function loadThumbnail(artifact: ToolArtifactView, signal?: AbortSignal): Promise<string | undefined> {
  if (!artifact.thumbnailUrl) return undefined;
  return gatewayObjectUrl(artifact.thumbnailUrl, signal).catch(() => undefined);
}

/** Editor link that returns to the deck's space when the user goes back. */
export function editorHref(artifact: ToolArtifactView, spaceId?: string): string | undefined {
  if (!artifact.editUrl) return undefined;
  const space = spaceId ?? artifact.spaceId;
  if (!space || /[?&]space=/.test(artifact.editUrl)) return artifact.editUrl;
  return `${artifact.editUrl}${artifact.editUrl.includes("?") ? "&" : "?"}space=${encodeURIComponent(space)}`;
}

/* ───────────── builds this browser started ───────────── */

const PENDING_KEY = "sibyl.slides.pendingJobs";

/** Fired on this window when the pending list changes. */
export const PENDING_EVENT = "sibyl:slides-pending";
/** Fired when a build this browser started is ready (the library reloads). */
export const READY_EVENT = "sibyl:slides-ready";

/** Builds whose progress this page is streaming right now (no toast for those). */
export const streamingJobs = new Set<string>();

/**
 * Builds this browser started and has not shown yet. A build that finishes
 * while its page is gone surfaces as a "Deck ready" notification.
 */
export function pendingJobs(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(PENDING_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function setJobPending(jobId: string, pending: boolean): void {
  try {
    const next = pendingJobs().filter((existing) => existing !== jobId);
    if (pending) next.push(jobId);
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(next.slice(-20)));
  } catch {
    // Storage unavailable: the toast is a nicety.
  }
  window.dispatchEvent(new Event(PENDING_EVENT));
}
