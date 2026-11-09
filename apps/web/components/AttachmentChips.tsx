"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { AttachmentRef } from "@open-gpt-live/protocol";
import { formatBytes, isImageMime, uploadBlobUrl, type ComposerAttachment } from "./AttachmentClient";

/** Paperclip (kept here so the shared icon set stays untouched). */
export function AttachmentIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />
    </svg>
  );
}

function FileGlyph({ mime, name }: { mime: string; name: string }) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? mime.split("/")[1] ?? "file").slice(0, 4).toUpperCase();
  return <span className="attachmentGlyph" aria-hidden>{ext}</span>;
}

/** Chips above the composer input: name, size, progress, remove. */
export function AttachmentTray(props: { items: ComposerAttachment[]; onRemove: (localId: string) => void }) {
  if (props.items.length === 0) return null;
  return (
    <ul className="attachmentTray" aria-label="Attachments">
      {props.items.map((item) => (
        <li key={item.localId} className={`attachmentChip ${item.status}`} title={item.error ?? item.name}>
          {item.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="attachmentThumb" src={item.previewUrl} alt="" />
          ) : (
            <FileGlyph mime={item.mime} name={item.name} />
          )}
          <span className="attachmentText">
            <span className="attachmentName">{item.name}</span>
            <span className="attachmentMeta">
              {item.status === "uploading"
                ? `Uploading… ${Math.round(item.progress * 100)}%`
                : item.status === "error"
                  ? item.error ?? "Upload failed"
                  : formatBytes(item.size)}
            </span>
          </span>
          {item.status === "uploading" ? (
            <span className="attachmentProgress" aria-hidden>
              <i style={{ width: `${Math.max(4, Math.round(item.progress * 100))}%` }} />
            </span>
          ) : null}
          <button
            type="button"
            className="attachmentRemove"
            aria-label={`Remove ${item.name}`}
            onClick={() => props.onRemove(item.localId)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function AttachmentImage({ attachment, onOpen }: { attachment: AttachmentRef; onOpen?: (attachment: AttachmentRef) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    uploadBlobUrl(attachment.id).then(
      (value) => active && setUrl(value),
      () => active && setFailed(true)
    );
    return () => {
      active = false;
    };
  }, [attachment.id]);
  if (failed) return <AttachmentFile attachment={attachment} onOpen={onOpen} />;
  return (
    <a
      className="attachmentImage"
      href={url ?? undefined}
      target="_blank"
      rel="noreferrer"
      title={attachment.name}
      aria-label={`Open ${attachment.name}`}
      onClick={(event) => {
        if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen(attachment);
      }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={attachment.name} />
      ) : (
        <span className="attachmentImagePlaceholder" />
      )}
    </a>
  );
}

function AttachmentFile({ attachment, onOpen }: { attachment: AttachmentRef; onOpen?: (attachment: AttachmentRef) => void }) {
  const open = () => {
    if (onOpen) return onOpen(attachment);
    void uploadBlobUrl(attachment.id).then((url) => window.open(url, "_blank", "noopener"), () => undefined);
  };
  return (
    <button type="button" className="attachmentChip sent" onClick={open} title={`Open ${attachment.name}`}>
      <FileGlyph mime={attachment.mime} name={attachment.name} />
      <span className="attachmentText">
        <span className="attachmentName">{attachment.name}</span>
        {attachment.size !== undefined ? <span className="attachmentMeta">{formatBytes(attachment.size)}</span> : null}
      </span>
    </button>
  );
}

/**
 * Attachments on a sent user message: image thumbnails and file chips.
 * `action` adds a small control per attachment (e.g. "Save to knowledge"),
 * shown on hover or focus (always on touch screens). `onOpen` shows a file
 * next to the chat instead of in a new tab.
 */
export function AttachmentList({
  attachments,
  action,
  onOpen
}: {
  attachments?: AttachmentRef[];
  action?: (attachment: AttachmentRef) => ReactNode;
  onOpen?: (attachment: AttachmentRef) => void;
}) {
  if (!attachments?.length) return null;
  const images = attachments.filter((item) => isImageMime(item.mime));
  const files = attachments.filter((item) => !isImageMime(item.mime));
  return (
    <div className="attachmentList">
      {images.length ? (
        <div className="attachmentImages">
          {images.map((item) => (
            <AttachmentItem key={item.id} action={action?.(item)}>
              <AttachmentImage attachment={item} onOpen={onOpen} />
            </AttachmentItem>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="attachmentFiles">
          {files.map((item) => (
            <AttachmentItem key={item.id} action={action?.(item)}>
              <AttachmentFile attachment={item} onOpen={onOpen} />
            </AttachmentItem>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentItem({ action, children }: { action?: ReactNode; children: ReactNode }) {
  if (!action) return <>{children}</>;
  return (
    <span className="attachmentItem">
      {children}
      <span className="attachmentAction">{action}</span>
    </span>
  );
}
