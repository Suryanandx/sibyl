"use client";

/**
 * Generated media in chat (MediaResult), large in the side panel or the Media
 * page (MediaPreview), and the shared details + actions (MediaDetails).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { MediaItemView, MediaOutputView } from "@open-gpt-live/protocol";
import { Icon } from "../../components/Icon";
import { Button, Notice } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { openSidePanel } from "../side-panel/events";
import { cancelMedia, downloadMediaFile, formatUsd, getMedia, mediaByUpload, mediaItemPath, mediaTypeOf, saveMediaToKnowledge, KIND_LABEL } from "./api";
import { useFileUrl, useMediaItem } from "./hooks";
import styles from "./media.module.css";

export interface MediaActions {
  /** Add a result to the next request's references (chat composer, Create panel). */
  onUseAsReference?: (output: MediaOutputView, item: MediaItemView) => void;
  /** Make it again with the same prompt, model and settings. */
  onRegenerate?: (item: MediaItemView) => void;
  /** Reuse the prompt (Media page). */
  /** Prefill the composer with its prompt, model, settings and references ("Remix"; in the library: "Remix in chat"). */
  onRemix?: (item: MediaItemView) => void;
  /** The library: open chat with the item as an @ reference. */
  onUseInChat?: (item: MediaItemView) => void;
  onDelete?: (item: MediaItemView) => void;
}

function fileName(item: MediaItemView, output: MediaOutputView, index: number): string {
  const ext = output.mime.split("/")[1]?.replace("mpeg", "mp3").replace("quicktime", "mov") ?? "bin";
  return `${item.prompt.slice(0, 40).replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "media"}${index ? `-${index + 1}` : ""}.${ext}`;
}

function openInPanel(item: MediaItemView, output?: MediaOutputView): void {
  openSidePanel({
    kind: "media",
    uploadId: output?.uploadId ?? "",
    mediaType: output ? mediaTypeOf(output.mime) : item.kind,
    title: item.prompt.slice(0, 80),
    jobId: item.id
  });
}

/** One output: image, video player or audio player. */
export function MediaOutput({ output, large = false, onOpen }: { output: MediaOutputView; large?: boolean; onOpen?: () => void }) {
  const url = useFileUrl(output.uploadId);
  const type = mediaTypeOf(output.mime);
  if (!url) return <div className={large ? styles.outputLarge : styles.output} aria-busy="true"><span className={styles.shimmer} /></div>;
  if (type === "video") {
    return <video className={large ? styles.outputLarge : styles.output} src={url} controls playsInline preload="metadata" />;
  }
  if (type === "audio") {
    return <audio className={styles.audio} src={url} controls preload="metadata" />;
  }
  return onOpen ? (
    <button type="button" className={large ? styles.outputLarge : styles.output} onClick={onOpen} aria-label="Open large">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" />
    </button>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={large ? styles.outputLarge : styles.output} src={url} alt="" />
  );
}

function Progress({ item }: { item: MediaItemView }) {
  const label = item.status === "queued" ? "Queued" : `Rendering${item.progress !== undefined ? ` · about ${item.progress}%` : "…"}`;
  return (
    <div className={styles.progress} role="status" aria-live="polite">
      <div className={styles.progressBar}>
        <span style={{ width: `${Math.max(4, item.progress ?? 4)}%` }} />
      </div>
      <span>{label}</span>
    </div>
  );
}

/** The card under a reply. Click an image (or a video's title) to open it in the side panel. */
export function MediaResult({ item: initial, ...actions }: { item: MediaItemView } & MediaActions) {
  const item = useMediaItem(initial) ?? initial;
  const running = item.status === "running" || item.status === "queued";
  return (
    <section className={styles.card} aria-label={`${KIND_LABEL[item.kind]}: ${item.prompt}`}>
      {running ? (
        <button type="button" className={styles.pending} onClick={() => openInPanel(item)}>
          <Icon name={item.kind === "video" ? "video" : item.kind === "audio" ? "volume" : "sparkle"} size={20} />
          <Progress item={item} />
        </button>
      ) : item.status === "error" ? (
        <Notice tone="danger">{item.error ?? "It didn't work."}</Notice>
      ) : item.status === "cancelled" ? (
        <Notice tone="warning">Cancelled.</Notice>
      ) : (
        <div className={item.kind === "image" && item.outputs.length > 1 ? styles.grid : styles.single}>
          {item.outputs.map((output) => (
            <MediaOutput key={output.uploadId} output={output} onOpen={() => openInPanel(item, output)} />
          ))}
        </div>
      )}
      <MediaDetails item={item} compact {...actions} />
    </section>
  );
}

/** Details (model, settings, references, cost) and actions. */
export function MediaDetails({ item, compact = false, ...actions }: { item: MediaItemView; compact?: boolean } & MediaActions) {
  const [open, setOpen] = useState(!compact);
  const [note, setNote] = useState<{ tone: "positive" | "danger"; text: string }>();
  const [busy, setBusy] = useState(false);
  const running = item.status === "running" || item.status === "queued";
  const first = item.outputs[0];
  const act = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setNote(undefined);
    try {
      const text = await work();
      if (text) setNote({ tone: "positive", text });
    } catch (error) {
      setNote({ tone: "danger", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const settings = Object.entries(item.settings).filter(([, value]) => value !== "" && value !== undefined);
  return (
    <div className={styles.details}>
      <div className={styles.actions}>
        {compact && first && !running ? (
          <Button size="sm" variant="ghost" onClick={() => openInPanel(item, first)}>
            View
          </Button>
        ) : null}
        {first && !running ? (
          <Button size="sm" disabled={busy} onClick={() => void act(async () => {
            for (const [index, output] of item.outputs.entries()) await downloadMediaFile(output.uploadId, fileName(item, output, index));
          })}>
            <Icon name="download" size={14} />
            Download
          </Button>
        ) : null}
        {first && !running && actions.onUseAsReference ? (
          <Button size="sm" variant="ghost" onClick={() => actions.onUseAsReference?.(first, item)}>
            Use as reference
          </Button>
        ) : null}
        {first && item.kind === "image" && !running ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => `Saved to ${await saveMediaToKnowledge(first.uploadId)}.`)}>
            Save to knowledge
          </Button>
        ) : null}
        {actions.onRegenerate && !running ? (
          <Button size="sm" variant="ghost" onClick={() => actions.onRegenerate?.(item)}>
            Make another
          </Button>
        ) : null}
        {actions.onRemix && !running ? (
          <Button size="sm" variant="ghost" onClick={() => actions.onRemix?.(item)}>
            {compact ? "Remix" : "Remix in chat"}
          </Button>
        ) : null}
        {actions.onUseInChat && !running && first ? (
          <Button size="sm" variant="ghost" onClick={() => actions.onUseInChat?.(item)}>
            Use in chat
          </Button>
        ) : null}
        {running ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => {
            await cancelMedia(item.id);
            return "Stopped waiting. OpenRouter can't stop a render that started, so it may still be billed.";
          })}>
            Cancel
          </Button>
        ) : null}
        {compact ? (
          <Link className={styles.linkButton} href={mediaItemPath(item.id)}>
            Open in Media
          </Link>
        ) : null}
        {actions.onDelete ? (
          <Button size="sm" variant="danger" onClick={() => actions.onDelete?.(item)}>
            <Icon name="trash" size={14} />
            Delete
          </Button>
        ) : null}
        {compact ? (
          <button type="button" className={styles.detailsToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            Details
          </button>
        ) : null}
      </div>
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      {open ? (
        <dl className={styles.meta}>
          <dt>Prompt</dt>
          <dd>{item.prompt}</dd>
          {item.providerPrompt ? (
            <>
              <dt>Sent as</dt>
              <dd>{item.providerPrompt}</dd>
            </>
          ) : null}
          <dt>Model</dt>
          <dd>{item.modelName ?? item.model}</dd>
          {settings.length ? (
            <>
              <dt>Settings</dt>
              <dd>{settings.map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value)}`).join(" · ")}</dd>
            </>
          ) : null}
          {item.references.length ? (
            <>
              <dt>References</dt>
              <dd>{item.references.map((ref) => `${ref.token ?? ""} ${ref.name ?? ref.uploadId}${ref.role && ref.role !== "reference" ? ` (${ref.role.replace("_", " ")})` : ""}`.trim()).join(", ")}</dd>
            </>
          ) : null}
          <dt>Cost</dt>
          <dd>
            {item.costUsd !== undefined ? `${formatUsd(item.costUsd)}${item.costEstimated ? " (estimated)" : ""}` : `about ${formatUsd(item.estimateUsd)} (estimate)`}
          </dd>
          <dt>Made</dt>
          <dd>{new Date(item.createdAt).toLocaleString()}</dd>
        </dl>
      ) : null}
    </div>
  );
}

/**
 * One media item shown large (the chat side panel, the Media page): the
 * player, progress while a video renders, and the actions. Finds the item by
 * its id (jobId) or by one of its files (uploadId).
 */
export function MediaPreview(props: { uploadId: string; mediaType: "image" | "video" | "audio"; jobId?: string } & MediaActions) {
  const [found, setFound] = useState<MediaItemView>();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setMissing(false);
    const load = props.jobId ? getMedia(props.jobId, controller.signal).catch(() => undefined) : props.uploadId ? mediaByUpload(props.uploadId, controller.signal) : Promise.resolve(undefined);
    void load.then((item) => {
      if (controller.signal.aborted) return;
      if (item) setFound(item);
      else setMissing(true);
    });
    return () => controller.abort();
  }, [props.jobId, props.uploadId]);
  const item = useMediaItem(found);
  if (!item) {
    // A plain file (not generated here): just show it.
    if (missing && props.uploadId) return <MediaOutput output={{ uploadId: props.uploadId, mime: `${props.mediaType}/*`, size: 0, url: "" }} large />;
    return <div className={styles.outputLarge} aria-busy="true"><span className={styles.shimmer} /></div>;
  }
  const running = item.status === "running" || item.status === "queued";
  const shown = item.outputs.filter((output) => !props.uploadId || output.uploadId === props.uploadId);
  return (
    <div className={styles.preview}>
      {running ? (
        <div className={styles.previewPending}>
          <Icon name={item.kind === "video" ? "video" : "sparkle"} size={28} />
          <Progress item={item} />
        </div>
      ) : item.status === "error" ? (
        <Notice tone="danger">{item.error ?? "It didn't work."}</Notice>
      ) : (
        (shown.length ? shown : item.outputs).map((output) => <MediaOutput key={output.uploadId} output={output} large />)
      )}
      <MediaDetails item={item} {...props} />
    </div>
  );
}
