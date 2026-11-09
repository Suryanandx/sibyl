/**
 * Composer attachments: uploads to the gateway's /api/uploads (with
 * progress) and cached object URLs for uploaded files. Requests go through
 * the shared gateway client (lib/gateway-http.ts).
 */
import { ACCEPTED_FILE_EXTENSIONS, type AttachmentRef } from "@open-gpt-live/protocol";
import { GatewayError, gatewayObjectUrl, gatewayUpload } from "../lib/gateway-http";

/** File picker filter: the protocol's one list of supported formats (the gateway checks the bytes). */
export const ATTACHMENT_ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif", ...ACCEPTED_FILE_EXTENSIONS].join(",");

export const MAX_ATTACHMENTS = 10;

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

/** Upload one file with progress. */
export function uploadFile(
  file: File,
  options: { onProgress?: (fraction: number) => void; conversationId?: string | null } = {}
): { promise: Promise<UploadedFile>; abort: () => void } {
  const query = options.conversationId ? `?conversationId=${encodeURIComponent(options.conversationId)}` : "";
  const upload = gatewayUpload<{ upload?: UploadedFile }>(`/api/uploads${query}`, file, {
    headers: { "x-filename": encodeURIComponent(file.name || "pasted-image.png") },
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  });
  const promise = upload.promise.then(
    (body) => {
      if (!body?.upload) throw new GatewayError("Upload failed: unexpected answer from the gateway.", 0, "invalid_response");
      return body.upload;
    },
    (error: unknown) => {
      if (error instanceof GatewayError && error.status === 401) throw new GatewayError("Sign in again to upload files.", 401, error.code);
      throw error;
    }
  );
  return { promise, abort: upload.abort };
}

const blobUrls = new Map<string, Promise<string>>();

/** Object URL for an uploaded file (cached per page). */
export function uploadBlobUrl(id: string): Promise<string> {
  const cached = blobUrls.get(id);
  if (cached) return cached;
  const promise = gatewayObjectUrl(`/api/uploads/${encodeURIComponent(id)}`).catch((error: unknown) => {
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
