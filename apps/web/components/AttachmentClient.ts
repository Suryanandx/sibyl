/**
 * HTTP helpers for the gateway's /api/uploads and /api/memory endpoints.
 * The gateway's HTTP origin is derived from NEXT_PUBLIC_GATEWAY_WS_URL and the
 * owner token (if any) is sent as a Bearer header — never in the URL.
 */
import type { AttachmentRef } from "@open-gpt-live/protocol";
import { readOwnerToken } from "./SignIn";

const gatewayWsUrl = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://localhost:8787";

export const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json," +
  ".txt,.md,.markdown,.csv,.json,.pdf,.docx,.xlsx";

export const MAX_ATTACHMENTS = 10;

/** http(s) origin of the gateway. */
export function gatewayHttpBase(webSocketUrl = gatewayWsUrl): string {
  try {
    const url = new URL(webSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  } catch {
    return "http://localhost:8787";
  }
}

export function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : readOwnerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Attachment in the composer: uploading, ready (has a gateway id) or failed. */
export interface ComposerAttachment {
  localId: string;
  name: string;
  size: number;
  mime: string;
  status: "uploading" | "ready" | "error";
  /** 0..1 */
  progress: number;
  /** Gateway upload id once uploaded. */
  id?: string;
  error?: string;
  /** Local object URL for image thumbnails. */
  previewUrl?: string;
}

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: string;
  summary: string;
}

export class UploadFailed extends Error {}

/** Upload one file with progress (XHR, since fetch has no upload progress). */
export function uploadFile(
  file: File,
  options: { onProgress?: (fraction: number) => void; conversationId?: string | null } = {}
): { promise: Promise<UploadedFile>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedFile>((resolve, reject) => {
    const query = options.conversationId ? `?conversationId=${encodeURIComponent(options.conversationId)}` : "";
    xhr.open("POST", `${gatewayHttpBase()}/api/uploads${query}`);
    for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name || "pasted-image.png"));
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: { upload?: UploadedFile; message?: string; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // Not JSON (proxy error page).
      }
      if (xhr.status === 201 && body.upload) resolve(body.upload);
      else if (xhr.status === 401) reject(new UploadFailed("Sign in again to upload files."));
      else reject(new UploadFailed(body.message ?? body.error ?? `Upload failed (${xhr.status || "network"}).`));
    };
    xhr.onerror = () => reject(new UploadFailed("Upload failed: the gateway could not be reached."));
    xhr.onabort = () => reject(new UploadFailed("Upload cancelled."));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

const blobUrls = new Map<string, Promise<string>>();

/** Object URL for an uploaded file (fetched with the owner token; cached per page). */
export function uploadBlobUrl(id: string): Promise<string> {
  const cached = blobUrls.get(id);
  if (cached) return cached;
  const promise = fetch(`${gatewayHttpBase()}/api/uploads/${encodeURIComponent(id)}`, { headers: authHeaders() })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return URL.createObjectURL(await response.blob());
    })
    .catch((error: unknown) => {
      blobUrls.delete(id);
      throw error;
    });
  blobUrls.set(id, promise);
  return promise;
}

export function toAttachmentRefs(items: ComposerAttachment[]): AttachmentRef[] {
  return items
    .filter((item): item is ComposerAttachment & { id: string } => item.status === "ready" && Boolean(item.id))
    .map((item) => ({ id: item.id, name: item.name, mime: item.mime, size: item.size }));
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

export function isImageMime(mime: string | undefined): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(mime ?? "");
}

/** JSON call to the gateway (memory API). */
export async function gatewayJson<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${gatewayHttpBase()}${path}`, {
    method: init.method ?? "GET",
    headers: { ...authHeaders(), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store"
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // ignore
  }
  if (!response.ok) {
    const message = (body as { message?: string; error?: string } | undefined)?.message ?? (body as { error?: string } | undefined)?.error;
    throw new Error(message ?? `Request failed (${response.status})`);
  }
  return body as T;
}
