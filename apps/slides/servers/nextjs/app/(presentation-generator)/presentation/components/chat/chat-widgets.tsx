import { withBasePath } from "@/utils/basePath";
import { Loader2 } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import SmartHtmlSlide from "../../../components/SmartHtmlSlide";
import { TemplateV2HtmlSlidePreview } from "../../../components/TemplateV2HtmlSlidePreview";
import { quickPromptGroups } from "./chat-prompts";
import type { AssistantActivity, ChatEditPreview } from "./chat-types";

const AssistantSparkleIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M6.9 1.1c.22 3.03 1.37 4.17 4.4 4.4-3.03.22-4.18 1.37-4.4 4.4-.22-3.03-1.37-4.18-4.4-4.4 3.03-.23 4.18-1.37 4.4-4.4Z"
      fill="#596C5D"
    />
    <path
      d="M11.2 9.4c.1 1.42.64 1.96 2.06 2.06-1.42.1-1.96.64-2.06 2.06-.1-1.42-.64-1.96-2.06-2.06 1.42-.1 1.96-.64 2.06-2.06Z"
      fill="#6172F3"
    />
  </svg>
);

export const AssistantMarker = () => (
  <div className="mb-2 flex items-center gap-1.5 text-[var(--text-3)]">
    <AssistantSparkleIcon size={14} />
    <span className="text-[11px] font-medium leading-4">Assistant</span>
  </div>
);

export const ActivityStatusIcon = ({
  activity,
}: {
  activity: AssistantActivity;
}) => {
  if (activity.state === "running") {
    return (
      <span
        className="activity-flow-dots relative mt-1 h-[9px] w-[22px] shrink-0"
        aria-label="Working"
      >
        <span className="absolute left-0 top-[1.5px] h-[6px] w-[6px] rounded-full bg-[var(--hover)]" />
        <span className="absolute left-[8px] top-[1.5px] h-[6px] w-[6px] rounded-full bg-[var(--hover)]" />
        <span className="absolute left-[16px] top-[1.5px] h-[6px] w-[6px] rounded-full bg-[var(--hover)]" />
      </span>
    );
  }

  if (activity.state === "error") {
    return <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--danger)]" />;
  }

  return <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--subtle)]" />;
};

export const QuickPromptsPanel = ({
  onPromptSelect,
  groups = quickPromptGroups,
}: {
  onPromptSelect: (prompt: string) => void;
  groups?: typeof quickPromptGroups;
}) => (
  <div className="flex flex-col gap-6 font-syne">
    <AssistantSparkleIcon size={24} />
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-2">
          <p className="text-sm font-normal tracking-[0.28px] text-[var(--text)]">
            {group.label}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {group.prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onPromptSelect(prompt)}
                className="rounded-full border border-[var(--border-strong)]/[0.04] bg-[var(--ink)]/[0.02] px-4 py-1.5 font-manrope text-xs font-normal tracking-[0.24px] text-[var(--text)] outline-none transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--accent-soft)] hover:text-[var(--text)] focus:border-[var(--ink)] focus:outline-none focus:ring-0 focus-visible:border-[var(--ink)] focus-visible:text-[var(--text)] focus-visible:outline-none focus-visible:ring-0 active:border-[var(--ink)] active:text-[var(--text)]"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const EditComparisonPreview = ({
  preview,
  fonts,
  selectedVersion,
  isApplying,
  onSelectVersion,
}: {
  preview: ChatEditPreview;
  fonts?: unknown;
  selectedVersion: "original" | "modified";
  isApplying: boolean;
  onSelectVersion: (version: "original" | "modified") => void;
}) => {
  if (!preview.modifiedSlides?.length) return null;

  const cards = [
    {
      label: "Original",
      slides: preview.originalSlides,
      version: "original" as const,
    },
    {
      label: "Modified",
      slides: preview.modifiedSlides,
      version: "modified" as const,
    },
  ];

  const renderSlidePreview = (slide: unknown, label: string, index: number) => {
    const htmlContent =
      slide && typeof slide === "object"
        ? (slide as Record<string, unknown>).html_content
        : null;
    const previewClassName =
      "pointer-events-none overflow-hidden rounded-[2px] border border-[var(--border)] bg-[var(--surface)]";

    if (typeof htmlContent === "string" && htmlContent.trim()) {
      return (
        <div key={`${label}-${index}`} className={previewClassName}>
          <SmartHtmlSlide
            html={htmlContent}
            fonts={fonts}
            title={`${label} slide preview ${index + 1}`}
          />
        </div>
      );
    }

    return (
      <TemplateV2HtmlSlidePreview
        key={`${label}-${index}`}
        slide={slide}
        fonts={fonts}
        className={previewClassName}
      />
    );
  };

  return (
    <div className="flex w-full flex-col gap-2 font-manrope">
      <div className="flex items-center gap-1 text-[13px] leading-[18px]">
        <Image
          src={withBasePath("/frame.svg")}
          alt=""
          width={14}
          height={14}
          className="h-[14px] w-[14px] shrink-0"
        />
        <span className="font-semibold text-[var(--text)]">Select edits</span>
        <span className="ml-auto text-[11px] font-medium leading-[normal] text-[var(--text)]">
          {preview.changeCount} {preview.changeCount === 1 ? "Change" : "Changes"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-[5px]">
        {cards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => onSelectVersion(card.version)}
            disabled={isApplying}
            className={cn(
              "min-w-0 overflow-hidden rounded-[6px] border bg-[var(--canvas)] px-[6px] py-[10px] text-left transition-[border-color,background-color,box-shadow,opacity] hover:border-[var(--ink)] disabled:cursor-wait disabled:opacity-70",
              selectedVersion === card.version
                ? "border-[var(--ink)] bg-[var(--accent-soft)]"
                : "border-[var(--border)]",
            )}
            aria-pressed={selectedVersion === card.version}
            aria-label={`Restore ${card.label.toLowerCase()} slide state`}
          >
            <span className="mb-[7px] flex items-center justify-center gap-1 truncate text-center text-[13px] font-medium leading-[normal] text-[var(--text)]">
              {isApplying && selectedVersion === card.version && (
                <Loader2 className="h-3 w-3 animate-spin text-[var(--text)]" />
              )}
              <span>{card.label}</span>
            </span>
            <span className="flex flex-col gap-[3px]">
              {card.slides
                .filter(Boolean)
                .slice(0, 2)
                .map((slide, index) =>
                  renderSlidePreview(slide, card.label, index),
                )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
