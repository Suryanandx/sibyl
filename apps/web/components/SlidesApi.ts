"use client";

/**
 * Browser side of the gateway's /api/slides API. Every call goes to the
 * Sibyl gateway (never to the slides engine) with the owner token as a
 * Bearer header.
 */
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { readOwnerToken } from "./SignIn";

const wsUrl = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787";

/** Gateway HTTP origin: NEXT_PUBLIC_GATEWAY_HTTP_URL, else derived from the WebSocket URL. */
export function gatewayHttpBase(): string {
  const explicit = process.env.NEXT_PUBLIC_GATEWAY_HTTP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  } catch {
    return "http://localhost:8787";
  }
}

function headers(json = false): Record<string, string> {
  const token = readOwnerToken();
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) };
}

export class SlidesApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function slidesApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${gatewayHttpBase()}/api/slides${path}`, {
    method: init.method ?? "GET",
    headers: headers(init.body !== undefined),
    cache: "no-store",
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!response.ok) throw new SlidesApiError(data.message ?? data.error ?? `Request failed (${response.status})`, response.status);
  return data as T;
}

/** Download a deck through the gateway (keeps the token out of URLs). */
export async function downloadDeck(artifact: ToolArtifactView, format: "pptx" | "pdf"): Promise<void> {
  const path = artifact.downloads?.[format];
  if (!path) throw new Error("No download for this deck.");
  const response = await fetch(`${gatewayHttpBase()}${path}`, { headers: headers(), cache: "no-store" });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? `Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `${artifact.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "deck"}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Thumbnail as an object URL (needs the token header), or undefined. */
export async function loadThumbnail(artifact: ToolArtifactView, signal?: AbortSignal): Promise<string | undefined> {
  if (!artifact.thumbnailUrl) return undefined;
  try {
    const response = await fetch(`${gatewayHttpBase()}${artifact.thumbnailUrl}`, { headers: headers(), signal });
    if (!response.ok) return undefined;
    return URL.createObjectURL(await response.blob());
  } catch {
    return undefined;
  }
}

export type SlidesProgressEvent =
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

/** POST /api/slides/generate and read its Server-Sent Events. */
export async function streamGenerate(
  request: GenerateRequest,
  onEvent: (event: SlidesProgressEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${gatewayHttpBase()}/api/slides/generate`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(request),
    ...(signal ? { signal } : {})
  });
  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new SlidesApiError(data.message ?? data.error ?? `Request failed (${response.status})`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as SlidesProgressEvent);
      } catch {
        // ignore malformed events
      }
    }
  }
}
