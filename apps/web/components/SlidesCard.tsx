"use client";

import { useEffect, useState } from "react";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { Icon } from "./Icon";
import { downloadDeck, loadThumbnail } from "./SlidesApi";

interface SlidesCardProps {
  artifact: ToolArtifactView;
  /** Prefill the composer to ask for changes. Omit to hide "Revise". */
  onRevise?: (text: string) => void;
  compact?: boolean;
}

/** Preview of a deck Sibyl built: open in the editor, download, or revise. */
export function SlidesCard({ artifact, onRevise, compact = false }: SlidesCardProps) {
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
      setError(failure instanceof Error ? failure.message : String(failure));
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
            <a className="slidesBtn primary" href={artifact.editUrl} target="_blank" rel="noopener">
              <Icon name="pencil" size={15} />
              Open in editor
            </a>
          ) : null}
          <button type="button" className="slidesBtn" disabled={busy !== null} onClick={() => void download("pptx")}>
            {busy === "pptx" ? "Preparing…" : "PPTX"}
          </button>
          <button type="button" className="slidesBtn" disabled={busy !== null} onClick={() => void download("pdf")}>
            {busy === "pdf" ? "Preparing…" : "PDF"}
          </button>
          {onRevise ? (
            <button
              type="button"
              className="slidesBtn ghost"
              onClick={() => onRevise(`Revise the deck "${artifact.title}" (deck id ${artifact.id}): `)}
            >
              Revise
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="slidesError" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
