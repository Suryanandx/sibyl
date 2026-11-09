"use client";

import { useEffect, useState } from "react";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";
import { errorText } from "../lib/gateway-http";
import { downloadDeck, loadThumbnail } from "../features/slides/api";
import { Button, ButtonLink, Notice } from "./ui";

interface SlidesCardProps {
  artifact: ToolArtifactView;
  /** Prefill the composer to ask for changes. Omit to hide "Revise". */
  onRevise?: (text: string) => void;
  /** Show the deck next to the chat (the side panel). Omit to hide "Preview". */
  onPreview?: () => void;
  compact?: boolean;
}

/** Preview of a deck Sibyl built: open in the editor, download, or revise. */
export function SlidesCard({ artifact, onRevise, onPreview, compact = false }: SlidesCardProps) {
  const [thumb, setThumb] = useState<string>();
  const [busy, setBusy] = useState<"pptx" | "pdf" | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    void loadThumbnail(artifact, controller.signal).then((value) => {
      url = value;
      if (!controller.signal.aborted) setThumb(value);
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact]);

  async function download(format: "pptx" | "pdf"): Promise<void> {
    setBusy(format);
    setError(undefined);
    try {
      await downloadDeck(artifact, format);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  }

  const meta = [
    artifact.slideCount ? `${artifact.slideCount} slides` : undefined,
    artifact.version > 1 ? `Version ${artifact.version}` : undefined
  ].filter(Boolean);

  return (
    <section className={`slidesCard${compact ? " compact" : ""}`} aria-label={`Slide deck ${artifact.title}`}>
      <div className="slidesThumb" aria-hidden>
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" />
        ) : (
          <span className="slidesThumbStack">
            <span />
            <span />
            <span>
              <Icon name="layers" size={18} />
            </span>
          </span>
        )}
      </div>
      <div className="slidesInfo">
        <span className="slidesEyebrow">Slide deck</span>
        <h3 className="slidesTitle">{artifact.title}</h3>
        {meta.length ? <p className="slidesMeta">{meta.join(" · ")}</p> : null}
        <div className="slidesActions">
          {artifact.editUrl ? (
            <ButtonLink variant="primary" size="sm" href={artifact.editUrl} target="_blank" rel="noopener">
              <Icon name="pencil" size={14} />
              Open in editor
            </ButtonLink>
          ) : null}
          {onPreview ? (
            <Button size="sm" onClick={onPreview}>
              Preview
            </Button>
          ) : null}
          <Button size="sm" disabled={busy !== null} onClick={() => void download("pptx")}>
            {busy === "pptx" ? "Preparing…" : "PPTX"}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void download("pdf")}>
            {busy === "pdf" ? "Preparing…" : "PDF"}
          </Button>
          {onRevise ? (
            <Button variant="ghost" size="sm" onClick={() => onRevise(`Revise the deck "${artifact.title}" (deck id ${artifact.id}): `)}>
              Revise
            </Button>
          ) : null}
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </section>
  );
}
