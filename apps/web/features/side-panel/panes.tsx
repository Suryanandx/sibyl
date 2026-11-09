"use client";

/**
 * What the side panel shows for each kind of item. Each pane reuses the
 * feature that owns the thing: the agent computer view, the deck card and
 * editor, the chat's visual renderer, the attachment helpers.
 */
import { useEffect, useState } from "react";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { GenUiView, type GenUiAction } from "../../components/GenUiView";
import { SlidesCard } from "../../components/SlidesCard";
import { uploadBlobUrl } from "../../components/AttachmentClient";
import { Button, ButtonLink, EmptyState, Muted, Notice } from "../../components/ui";
import { SibylLoader } from "../../components/SibylLoader";
import { Icon } from "../../components/Icon";
import { errorText, gatewayDownload } from "../../lib/gateway-http";
import { useGateway } from "../../lib/gateway";
import { ComputerView } from "../computers";
import { editorHref, slidesApi } from "../slides/api";
import { MarkdownPreview } from "../skills";
import type { SidePanelItem } from "./events";
import { filePreviewOf, isBuilding, MAX_TEXT_PREVIEW, parseCsv } from "./preview";
import type { SidePanelSources } from "./sources";
import { isPendingId, safeHttpUrl, type PanelEntry } from "./state";
import { MediaPreview } from "../media/MediaResult";
import styles from "./side-panel.module.css";

type Of<K extends SidePanelItem["kind"]> = Extract<SidePanelItem, { kind: K }>;

export interface PaneProps {
  entry: PanelEntry;
  sources: SidePanelSources;
  onVisualAction?: (action: GenUiAction) => void;
}

export function Pane({ entry, sources, onVisualAction }: PaneProps) {
  if (entry.status === "failed") {
    return (
      <EmptyState title="It didn't finish" compact>
        <p>The step that was building this stopped. The chat says what happened.</p>
      </EmptyState>
    );
  }
  if (isBuilding(entry)) return <Building entry={entry} />;
  const item = entry.item;
  switch (item.kind) {
    case "computer":
      return <ComputerPane item={item} />;
    case "slides":
      return <SlidesPane item={item} artifact={sources.decks[item.artifactId] ?? entry.artifact} />;
    case "visual":
      return <VisualPane item={item} sources={sources} onAction={onVisualAction} />;
    case "file":
      return <FilePane item={item} />;
    case "media":
      return <MediaPane item={item} />;
    case "url":
      return <UrlPane item={item} />;
  }
}

function Building({ entry }: { entry: PanelEntry }) {
  const what = entry.item.kind === "slides" ? "deck" : entry.item.kind === "media" ? entry.item.mediaType : "result";
  return (
    <div className={styles.building} role="status">
      <SibylLoader state="working" size={22} />
      <p>{entry.item.kind === "slides" ? entry.item.title || "Building the deck" : `Making the ${what}`}…</p>
      <Muted>It shows up here when it's ready. You can keep chatting.</Muted>
    </div>
  );
}

/* ───────────── computer ───────────── */

function ComputerPane({ item }: { item: Of<"computer"> }) {
  const { agents, connected } = useGateway();
  const agent = agents.agents.find((candidate) => candidate.id === item.agentId);
  if (!agent) {
    return (
      <EmptyState title={connected ? "Agent not found" : "Connecting…"} compact>
        <p>{connected ? "It may have been deleted, or it isn't shared with you." : "Loading your agents."}</p>
      </EmptyState>
    );
  }
  return <ComputerView agentId={agent.id} agentName={agent.name} runId={item.runId} stacked />;
}

/* ───────────── slides ───────────── */

function SlidesPane({ item, artifact: known }: { item: Of<"slides">; artifact?: ToolArtifactView }) {
  const [artifact, setArtifact] = useState<ToolArtifactView | undefined>(known);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (known) {
      setArtifact(known);
      return;
    }
    if (isPendingId(item.artifactId)) return;
    // Not in this chat's messages (e.g. after a reload): find it in the library.
    let active = true;
    slidesApi.decks().then(
      (decks) => {
        const found = decks.flatMap((deck) => deck.versions).find((version) => version.id === item.artifactId);
        if (!active) return;
        if (found) setArtifact(found);
        else setError("This deck isn't in your slides library any more.");
      },
      (failure: unknown) => active && setError(errorText(failure))
    );
    return () => {
      active = false;
    };
  }, [item.artifactId, known]);

  if (!artifact) {
    return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading the deck…</Muted>;
  }
  const href = editorHref(artifact);
  // The editor is this app's own page (/slides…), so it can be shown here.
  const embeddable = href?.startsWith("/slides/") ? href : undefined;
  return (
    <div className={styles.slides}>
      <SlidesCard artifact={artifact} compact />
      {embeddable ? <iframe className={styles.editorFrame} src={embeddable} title={`Editor: ${artifact.title}`} loading="lazy" /> : null}
    </div>
  );
}

/* ───────────── visual ───────────── */

function VisualPane({ item, sources, onAction }: { item: Of<"visual">; sources: SidePanelSources; onAction?: (action: GenUiAction) => void }) {
  const visual = sources.visuals[item.requestId];
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!visual) {
    return (
      <EmptyState title="This visual isn't in the chat on screen" compact>
        <p>Open the chat it came from to see it again.</p>
      </EmptyState>
    );
  }
  const copy = () => {
    void navigator.clipboard?.writeText(visual.source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className={styles.visual}>
      <div className={styles.paneTools}>
        <Button size="sm" variant="ghost" aria-pressed={showSource} onClick={() => setShowSource((on) => !on)}>
          <Icon name="code" size={14} />
          {showSource ? "Hide source" : "Show source"}
        </Button>
        {showSource ? (
          <Button size="sm" variant="ghost" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </div>
      {showSource ? <pre className={styles.source}>{visual.source}</pre> : null}
      <GenUiView source={visual.source} streaming={visual.streaming} onAction={visual.latest ? onAction : undefined} />
    </div>
  );
}

/* ───────────── files ───────────── */

/** An uploaded file as an object URL (cached per page by the attachment helpers). */
function useUploadUrl(uploadId: string): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let active = true;
    setState({});
    uploadBlobUrl(uploadId).then(
      (url) => active && setState({ url }),
      (failure: unknown) => active && setState({ error: errorText(failure) })
    );
    return () => {
      active = false;
    };
  }, [uploadId]);
  return state;
}

function FilePane({ item }: { item: Of<"file"> }) {
  const preview = filePreviewOf(item.mime, item.name);
  const { url, error } = useUploadUrl(item.uploadId);
  const download = () => void gatewayDownload(`/api/uploads/${encodeURIComponent(item.uploadId)}`, item.name);
  const downloadButton = (
    <Button size="sm" onClick={download}>
      <Icon name="download" size={14} />
      Download
    </Button>
  );
  if (error) return <Notice tone="danger" action={downloadButton}>{error}</Notice>;
  if (preview === "download") {
    return (
      <EmptyState title={item.name} compact action={downloadButton}>
        <p>There's no preview for this kind of file ({item.mime || "unknown type"}).</p>
      </EmptyState>
    );
  }
  if (!url) return <Muted>Loading {item.name}…</Muted>;
  return (
    <div className={styles.file}>
      <div className={styles.paneTools}>{downloadButton}</div>
      {preview === "image" ? (
        // Object URL of the user's own upload: no next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.image} src={url} alt={item.name} />
      ) : preview === "video" ? (
        <video className={styles.video} src={url} controls aria-label={item.name} />
      ) : preview === "audio" ? (
        <audio className={styles.audio} src={url} controls aria-label={item.name} />
      ) : preview === "pdf" ? (
        <PdfFrame url={url} name={item.name} />
      ) : (
        <TextPreview url={url} kind={preview} />
      )}
    </div>
  );
}

/** The browser's PDF viewer, on a copy typed as PDF (so nothing else can render in the frame). */
function PdfFrame({ url, name }: { url: string; name: string }) {
  const [pdfUrl, setPdfUrl] = useState<string>();
  useEffect(() => {
    let made: string | undefined;
    let active = true;
    void fetch(url)
      .then((response) => response.blob())
      .then((blob) => {
        made = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
        if (active) setPdfUrl(made);
        else URL.revokeObjectURL(made);
      });
    return () => {
      active = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url]);
  return pdfUrl ? <iframe className={styles.pdf} src={pdfUrl} title={name} /> : <Muted>Loading the PDF…</Muted>;
}

function TextPreview({ url, kind }: { url: string; kind: "markdown" | "csv" | "text" }) {
  const [text, setText] = useState<{ value: string; cut: boolean }>();
  useEffect(() => {
    let active = true;
    void fetch(url)
      .then((response) => response.text())
      .then((value) => active && setText({ value: value.slice(0, MAX_TEXT_PREVIEW), cut: value.length > MAX_TEXT_PREVIEW }));
    return () => {
      active = false;
    };
  }, [url]);
  if (!text) return <Muted>Loading…</Muted>;
  return (
    <>
      {kind === "markdown" ? (
        <div className={styles.markdown}>
          <MarkdownPreview source={text.value} />
        </div>
      ) : kind === "csv" ? (
        <CsvTable text={text.value} />
      ) : (
        <pre className={styles.source}>{text.value}</pre>
      )}
      {text.cut ? <Muted>The preview stops here. Download the file for all of it.</Muted> : null}
    </>
  );
}

function CsvTable({ text }: { text: string }) {
  const { rows, more } = parseCsv(text);
  if (!rows.length) return <Muted>The file is empty.</Muted>;
  const [head, ...body] = rows;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head!.map((cell, index) => (
              <th key={index} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more ? <Muted>Showing the first {rows.length} rows.</Muted> : null}
    </div>
  );
}

/* ───────────── media ───────────── */

function MediaPane({ item }: { item: Of<"media"> }) {
  // Generated media (a library item): the player, render progress and its actions (features/media).
  if (item.jobId) return <MediaPreview uploadId={item.uploadId} mediaType={item.mediaType} jobId={item.jobId} />;
  return <UploadMediaPane item={item} />;
}

function UploadMediaPane({ item }: { item: Of<"media"> }) {
  const { url, error } = useUploadUrl(item.uploadId);
  const label = item.title || item.mediaType;
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!url) return <Muted>Loading…</Muted>;
  if (item.mediaType === "video") return <video className={styles.video} src={url} controls aria-label={label} />;
  if (item.mediaType === "audio") return <audio className={styles.audio} src={url} controls aria-label={label} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.image} src={url} alt={label} />;
}

/* ───────────── web page ───────────── */

/**
 * Other sites are never framed: most refuse it anyway, and a framed page could
 * pass itself off as part of Sibyl. The card names the site plainly and opens
 * it in a new tab, without sending Sibyl's address along.
 */
function UrlPane({ item }: { item: Of<"url"> }) {
  const url = safeHttpUrl(item.url);
  if (!url) return <Notice tone="danger">This link isn't a web page Sibyl can open.</Notice>;
  return (
    <article className={styles.urlCard}>
      <span className={styles.urlHost}>
        <Icon name="link" size={14} />
        {url.hostname.replace(/^www\./, "")}
      </span>
      {item.title ? <h3 className={styles.urlTitle}>{item.title}</h3> : null}
      <p className={styles.urlFull}>{url.toString()}</p>
      {url.protocol === "http:" ? <Notice tone="warning">This page doesn't use a secure connection (https).</Notice> : null}
      <div>
        <ButtonLink variant="primary" size="sm" href={url.toString()} target="_blank" rel="noopener noreferrer" outside>
          Open in a new tab
        </ButtonLink>
      </div>
      <Muted>Pages from other sites open in their own tab. Sibyl doesn't load them inside the app.</Muted>
    </article>
  );
}
