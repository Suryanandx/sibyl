"use client";

import { useRef, useState, type DragEvent } from "react";
import {
  FILE_FORMAT_GROUPS,
  LEGACY_OFFICE_FORMATS,
  fileExtension,
  fileFormatFor,
  isSecretFileName,
  type KnowledgeAddDocsResponse
} from "@open-gpt-live/protocol";
import { ATTACHMENT_ACCEPT, uploadFile } from "../../components/AttachmentClient";
import { Badge, Button, Muted, Row, type Tone } from "../../components/ui";
import { errorText, gatewayRequest } from "../../lib/gateway-http";
import styles from "./knowledge.module.css";

/** Files uploaded at the same time. */
const PARALLEL = 3;
/** Files taken from one pick or folder. */
const MAX_FILES = 1000;

type ItemStatus = "queued" | "uploading" | "adding" | "added" | "skipped" | "failed";

interface Item {
  key: string;
  name: string;
  status: ItemStatus;
  /** 0..1 while uploading. */
  progress: number;
  detail?: string;
}

const STATUS: Record<ItemStatus, { label: string; tone: Tone }> = {
  queued: { label: "Waiting", tone: "neutral" },
  uploading: { label: "Uploading", tone: "warning" },
  adding: { label: "Adding", tone: "warning" },
  added: { label: "Added", tone: "positive" },
  skipped: { label: "Skipped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" }
};

/** Why the browser won't even send a file (the gateway checks the bytes of the rest). */
function localRefusal(name: string): string | undefined {
  if (isSecretFileName(name)) return "may hold secrets, never uploaded";
  const ext = fileExtension(name);
  const modern = LEGACY_OFFICE_FORMATS[ext];
  if (modern) return `old ${ext} file: save it as ${modern} and add that`;
  return fileFormatFor(name) ? undefined : "not a supported type";
}

/** Hidden files and folders (.git, .DS_Store) are left out of folder uploads. */
function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX" || part === "node_modules");
}

/**
 * Add files to a knowledge base: several at once, a whole folder, or a ZIP
 * (one document per file inside). Each file shows its own progress.
 */
export function AddFiles(props: {
  /** The base's documents path, or a function that makes the base on first use (onboarding). */
  docsPath: string | (() => Promise<string>);
  disabled: boolean;
  onAdded: () => Promise<void>;
  /** Fold the list of supported file types behind "Which files work?" (onboarding). */
  foldFormats?: boolean;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [ignored, setIgnored] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<Item>) => setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  async function addOne(file: File, item: Item, docsPath: string): Promise<void> {
    update(item.key, { status: "uploading", progress: 0 });
    try {
      const upload = await uploadFile(file, { onProgress: (progress) => update(item.key, { progress }) }).promise;
      update(item.key, { status: "adding" });
      const result = await gatewayRequest<KnowledgeAddDocsResponse>(docsPath, { method: "POST", body: { kind: "upload", uploadId: upload.id } });
      const skipped = result.skipped ?? [];
      const detail =
        upload.kind === "zip"
          ? `${result.docs.length} file${result.docs.length === 1 ? "" : "s"} added${skipped.length ? `; skipped ${skipped.map((entry) => `${entry.name} (${entry.reason})`).join(", ")}` : ""}`
          : upload.summary;
      update(item.key, { status: "added", detail });
      await props.onAdded();
    } catch (cause) {
      update(item.key, { status: "failed", detail: errorText(cause) });
    }
  }

  async function addFiles(list: FileList | null): Promise<void> {
    const all = [...(list ?? [])];
    if (all.length === 0) return;
    const pathOf = (file: File) => file.webkitRelativePath || file.name;
    const visible = all.filter((file) => !isHiddenPath(pathOf(file)));
    setIgnored(all.length - visible.length);
    const picked = visible.slice(0, MAX_FILES);
    const stamp = Date.now();
    const next = picked.map((file, index): Item => {
      const reason = localRefusal(file.name);
      return { key: `${stamp}-${index}`, name: pathOf(file), status: reason ? "skipped" : "queued", progress: 0, ...(reason ? { detail: reason } : {}) };
    });
    if (visible.length > MAX_FILES) {
      next.push({ key: `${stamp}-more`, name: `${visible.length - MAX_FILES} more files`, status: "skipped", progress: 0, detail: `at most ${MAX_FILES} at a time` });
    }
    setItems(next);
    setRunning(true);
    let docsPath: string;
    try {
      docsPath = typeof props.docsPath === "string" ? props.docsPath : await props.docsPath();
    } catch (cause) {
      setItems(next.map((item) => (item.status === "queued" ? { ...item, status: "failed", detail: errorText(cause) } : item)));
      setRunning(false);
      return;
    }
    const queue = picked.map((file, index) => ({ file, item: next[index]! })).filter(({ item }) => item.status === "queued");
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await addOne(job.file, job.item, docsPath);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
    setRunning(false);
    if (fileRef.current) fileRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    if (!running && !props.disabled) void addFiles(event.dataTransfer.files);
  }

  const done = items.filter((item) => item.status === "added").length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const busy = running || props.disabled;
  const formats = (
    <ul className={styles.formats} aria-label="Supported file types">
      {FILE_FORMAT_GROUPS.map((group) => (
        <li key={group.label}>
          <strong>{group.label}:</strong> {group.detail}
        </li>
      ))}
      <li>
        <strong>Not supported:</strong> old .doc, .xls and .ppt files (save them as .docx, .xlsx or .pptx), and files that hold secrets such as .env or private keys.
      </li>
    </ul>
  );

  return (
    <div
      className={styles.dropZone}
      data-dragging={dragging ? "true" : "false"}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input ref={fileRef} type="file" multiple hidden accept={`${ATTACHMENT_ACCEPT},.zip`} onChange={(event) => void addFiles(event.target.files)} aria-label="Choose files" />
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        // Folder upload (all current browsers); React has no typed prop for it.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => void addFiles(event.target.files)}
        aria-label="Choose a folder"
      />
      <Row>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          Choose files
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => folderRef.current?.click()}>
          Choose a folder
        </Button>
        <Muted as="span">or drop files here. A ZIP adds every file inside.</Muted>
      </Row>

      {props.foldFormats ? (
        <details className={styles.formatsFold}>
          <summary>Which files work?</summary>
          {formats}
        </details>
      ) : (
        formats
      )}

      {items.length > 0 ? (
        <div className={styles.progress} aria-live="polite">
          <Muted as="span">
            {running
              ? `Adding ${done} of ${items.length - skipped}…`
              : `Added ${done} file${done === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}${failed ? `, ${failed} failed` : ""}.`}
            {ignored ? ` ${ignored} hidden file${ignored === 1 ? "" : "s"} left out.` : ""}
          </Muted>
          <ul className={styles.progressList}>
            {items.map((item) => (
              <li key={item.key} className={styles.progressItem}>
                <span className={styles.progressName} title={item.name}>
                  {item.name}
                </span>
                <Badge tone={STATUS[item.status].tone}>
                  {item.status === "uploading" ? `${STATUS.uploading.label} ${Math.round(item.progress * 100)}%` : STATUS[item.status].label}
                </Badge>
                {item.detail ? <span className={item.status === "failed" ? styles.docError : styles.docMeta}>{item.detail}</span> : null}
              </li>
            ))}
          </ul>
          {!running ? (
            <Row>
              <Button variant="ghost" size="sm" onClick={() => setItems([])}>
                Clear list
              </Button>
            </Row>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
