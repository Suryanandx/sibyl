"use client";

import { useId, useState, type FormEvent } from "react";
import { ArrowUp, Loader2, PenLine } from "lucide-react";
import type { TemplateV2Layout } from "@/components/slide-editor/importing/template-v2-import";
import { TemplateV2HtmlSlidePreview } from "../components/TemplateV2HtmlSlidePreview";
import {
  PRESENTON_BLANK_SLIDE_PROMPT_EVENT,
  type BlankSlidePromptEventDetail,
} from "./blank-slide-prompt-event";

const TEMPLATE_V2_PREVIEW_SCALE = 0.085;

function createTemplateV2PromptPreviewSlide(
  layout: TemplateV2Layout,
  slideIndex: number,
) {
  return {
    id: `template-v2-prompt-preview-${slideIndex}`,
    content: {},
    ui: layout,
    layout: typeof layout.id === "string" ? layout.id : `slide-${slideIndex}`,
    layout_group: "template-v2",
  };
}

type TemplateV2PromptOverlayProps = {
  layout: TemplateV2Layout;
  slideIndex: number;
  showLayoutPreview?: boolean;
  isSubmitting?: boolean;
  onDismiss?: () => void;
  onSubmitPrompt?: (
    prompt: string,
  ) => boolean | void | Promise<boolean | void>;
};

export function TemplateV2PromptOverlay({
  layout,
  slideIndex,
  showLayoutPreview = false,
  isSubmitting = false,
  onDismiss,
  onSubmitPrompt,
}: TemplateV2PromptOverlayProps) {
  const inputId = useId();
  const [prompt, setPrompt] = useState("");
  const [isPromptVisible, setIsPromptVisible] = useState(true);
  const [isSubmittingLocally, setIsSubmittingLocally] = useState(false);
  const submitting = isSubmitting || isSubmittingLocally;

  const dismissPrompt = () => {
    if (submitting) return;
    setIsPromptVisible(false);
    onDismiss?.();
  };

  const submitPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || submitting) return;

    if (onSubmitPrompt) {
      setIsSubmittingLocally(true);
      try {
        const shouldDismiss = await onSubmitPrompt(trimmedPrompt);
        if (shouldDismiss !== false) {
          setPrompt("");
          setIsPromptVisible(false);
          onDismiss?.();
        }
      } catch (error) {
        console.error("Failed to create slide from prompt", error);
      } finally {
        setIsSubmittingLocally(false);
      }
      return;
    }

    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent<BlankSlidePromptEventDetail>(
        PRESENTON_BLANK_SLIDE_PROMPT_EVENT,
        {
          detail: {
            prompt: trimmedPrompt,
            slideIndex,
            layoutId: typeof layout.id === "string" ? layout.id : null,
            promptKind: showLayoutPreview ? "layout" : "blank",
            layout: showLayoutPreview ? layout : null,
          },
        },
      ),
    );
    setPrompt("");
    setIsPromptVisible(false);
    onDismiss?.();
  };

  if (!isPromptVisible) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 font-syne">
      <div className="absolute inset-0 bg-[var(--surface)]" aria-hidden="true" />
      <div className="absolute left-[76px] top-[76px] text-[44px] font-medium leading-none text-[var(--text)]/[0.04]">
        New page
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute inset-0"
        onPointerDown={dismissPrompt}
      />
      {showLayoutPreview ? (
        <div className="pointer-events-none absolute left-[150px] top-[202px] h-[61px] w-[109px] overflow-hidden rounded-[4px] border border-[var(--border)] bg-[var(--surface)] shadow-[0_4px_14px_rgba(16,24,40,0.08)]">
          <div
            className="absolute left-0 top-0"
            style={{
              width: 1280,
              height: 720,
              transform: `scale(${TEMPLATE_V2_PREVIEW_SCALE})`,
              transformOrigin: "top left",
            }}
          >
            <TemplateV2HtmlSlidePreview
              slide={createTemplateV2PromptPreviewSlide(layout, slideIndex)}
              fixedSize
            />
          </div>
        </div>
      ) : null}
      <form
        aria-busy={submitting}
        aria-label="Create slide from prompt"
        onSubmit={submitPrompt}
        onPointerDown={(event) => event.stopPropagation()}
        style={{ translate: "none" }}
        className="pointer-events-auto absolute left-1/2 top-[292px] flex h-[104px] w-[980px] max-w-[calc(100%_-_160px)] -translate-x-1/2 items-center rounded-[14px] border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_90%,transparent)] px-4 shadow-[0_10px_30px_rgba(16,24,40,0.03)]"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <PenLine
            className="mt-1 h-5 w-5 shrink-0 text-[var(--text)]"
            strokeWidth={1.7}
          />
          <div className="min-w-0 flex-1">
            <label
              htmlFor={inputId}
              className="block text-[18px] font-normal leading-[22px] text-[var(--text)]"
            >
              Write prompt
            </label>
            <input
              id={inputId}
              autoFocus
              disabled={submitting}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Start with your idea... we'll handle the slides"
              className="mt-3 h-8 w-full border-0 bg-transparent p-0 text-[18px] font-normal leading-8 text-[var(--text)] outline-none placeholder:text-[var(--text-3)] disabled:cursor-wait"
            />
          </div>
        </div>
        <button
          type="submit"
          aria-label={submitting ? "Creating slide" : "Create slide"}
          disabled={!prompt.trim() || submitting}
          style={{
            background: "var(--ink)", color: "var(--ink-text)",
          }}
          className="ml-4 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text)] transition hover:brightness-95 disabled:cursor-not-allowed disabled:text-[var(--text-3)] disabled:hover:brightness-100"
        >
          {submitting ? (
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2.1} />
          ) : (
            <ArrowUp className="h-5 w-5" strokeWidth={2.1} />
          )}
        </button>
      </form>
    </div>
  );
}
