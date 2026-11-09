"use client";

import React, { memo, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { resolveBackendAssetUrl } from "@/utils/api";
import {
  TemplateCreateTaskResponse,
  TemplateListItem,
} from "../services/api/template";
import {
  TemplatePreviewStage,
  LayoutsBadge,
} from "./TemplatePreviewComponents";
import { TemplateTab } from "../hooks/useTemplateSummaries";

export function TemplateThumbnailPreview({
  thumbnail,
  templateName,
  selectionPage = false,
  flush = false,
}: {
  thumbnail?: string | null;
  templateName: string;
  selectionPage?: boolean;
  flush?: boolean;
}) {
  const resolvedThumbnail = thumbnail ? resolveBackendAssetUrl(thumbnail) : "";

  if (!resolvedThumbnail) {
    return (
      <div
        className={cn(
          "relative z-10 flex w-full items-center justify-center rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_80%,transparent)]",
          selectionPage ? "h-full" : "aspect-video"
        )}
      >
        <div className="h-10 w-16 rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--canvas)]" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative z-10 flex w-full items-center justify-center",
        selectionPage ? "h-full" : "aspect-video"
      )}
    >
      <div
        aria-label={`${templateName} thumbnail`}
        className={cn(
          "h-full w-full bg-[var(--surface)] bg-no-repeat",
          flush ? "bg-cover bg-left-top" : "bg-contain bg-center",
          !flush && "rounded-[12px] border border-[var(--border)]",
          !selectionPage && "shadow-sm"
        )}
        role="img"
        style={{ backgroundImage: `url(${JSON.stringify(resolvedThumbnail)})` }}
      />
    </div>
  );
}

export const TemplateListCard = memo(function TemplateListCard({
  template,
  onClick,
  isSelected = false,
  isSuggested = false,
  showArrow = false,
  selectionPage = false,
}: {
  template: TemplateListItem;
  onClick: () => void;
  isSelected?: boolean;
  isSuggested?: boolean;
  showArrow?: boolean;
  selectionPage?: boolean;
}) {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.currentTarget.getAttribute("aria-disabled") === "true") {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onClick();
    },
    [onClick]
  );

  const rawStatus = template.generation_status ?? template.status ?? null;
  const status = rawStatus?.toLowerCase().replace(/[_-]+/g, " ") ?? null;
  const isGeneratingStatus =
    status === "generating" ||
    status === "processing" ||
    status === "pending" ||
    status === "queued" ||
    status === "running" ||
    status === "in progress";
  const statusLabel =
    status && !isGeneratingStatus
      ? status.replace(/\b\w/g, (char) => char.toUpperCase())
      : null;

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${showArrow ? "Open" : "Select"} ${template.name} template`}
      className={cn(
        "group relative overflow-hidden border bg-[var(--surface)] shadow-none outline-none transition-all duration-200",
        selectionPage ? "rounded-[12px]" : "rounded-[22px]",
        "cursor-pointer hover:-translate-y-1 hover:border-[var(--ink)] hover:ring-2 hover:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] hover:shadow-[0_18px_40px_rgba(34,31,54,0.12)] focus-visible:-translate-y-1 focus-visible:border-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_30%,transparent)] focus-visible:shadow-[0_18px_40px_rgba(34,31,54,0.12)]",
        isSelected
          ? cn(
              "ring-2 ring-[color-mix(in_srgb,var(--accent)_25%,transparent)] shadow-[0_14px_34px_rgba(34,31,54,0.12)]",
              selectionPage ? "!border-0" : "border-[var(--ink)]"
            )
          : selectionPage
            ? "!border-0 !shadow-[inset_0_0_0_1px_#EDEEEF]"
            : "border-[var(--border)]"
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-30 bg-[var(--ink)]/[0.04] opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100",
          selectionPage ? "rounded-[12px]" : "rounded-[22px]"
        )}
      />
      {isSelected && (
        <span className="absolute right-4 top-3.5 z-50 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ink)] text-[var(--ink-text)] shadow-sm">
          <CheckCircle2 className="h-4 w-4" />
        </span>
      )}
      {isSuggested && (
        <span className="absolute right-3.5 top-[52px] z-50 rounded-full border border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-2.5 py-1 font-syne text-[10px] font-semibold text-[var(--text)] shadow-sm backdrop-blur">
          Suggested
        </span>
      )}
      <TemplatePreviewStage selectionPage={selectionPage}>
        <LayoutsBadge
          count={template.layout_count ?? 0}
          selectionPage={selectionPage}
        />
        <TemplateThumbnailPreview
          thumbnail={template.thumbnail}
          templateName={template.name}
          selectionPage={selectionPage}
        />
      </TemplatePreviewStage>
      <div
        className={cn(
          "relative z-40 flex items-center justify-between gap-4 border-t border-[var(--border)] bg-[var(--surface)]",
          selectionPage ? "h-20 px-5 py-2.5" : "px-6 py-5"
        )}
      >
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "font-syne capitalize",
              selectionPage
                ? "text-sm font-semibold tracking-[0.14px] text-[var(--text)]"
                : cn(
                    "font-bold text-[var(--text)]",
                    showArrow ? "text-base" : "text-sm"
                  )
            )}
          >
            {template.name}
          </h3>
          {template.description && (
            <p
              className={cn(
                "line-clamp-2 font-syne",
                selectionPage
                  ? "mt-1 text-[11px] font-semibold leading-3 tracking-[0.11px] text-[var(--text-3)]"
                  : cn(
                      "text-[var(--text-2)]",
                      showArrow ? "mt-1 text-sm text-[var(--text-2)]" : "text-xs"
                    )
              )}
            >
              {template.description}
            </p>
          )}
          {statusLabel && (
            <span
              className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--canvas)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-2)]"
            >
              {statusLabel}
            </span>
          )}
        </div>
        {showArrow && (
          <ArrowUpRight
            aria-hidden="true"
            strokeWidth={selectionPage ? 1.67 : 2}
            className={cn(
              "shrink-0",
              selectionPage
                ? "h-5 w-5 text-[var(--text-3)]"
                : "h-4 w-4 text-[var(--text-3)] transition-colors group-hover:text-[var(--text)]"
            )}
          />
        )}
      </div>
    </Card>
  );
});

export const ProcessingTemplateListCard = memo(
  function ProcessingTemplateListCard({
    task,
    onRetry,
    retrying = false,
  }: {
    task: TemplateCreateTaskResponse;
    onRetry?: () => void;
    retrying?: boolean;
  }) {
    const failed = task.status === "error";
    const templateName = task.data?.name?.trim() || "New template";
    const createdLayouts = task.data?.created_layouts ?? 0;
    const remainingLayouts = task.data?.remaining_layouts ?? 0;
    const totalLayouts = createdLayouts + remainingLayouts;
    const progressPercent =
      totalLayouts > 0
        ? Math.min(
            95,
            Math.max(0, Math.round((createdLayouts / totalLayouts) * 100))
          )
        : 0;
    const overlayWidth = `${100 - progressPercent}%`;
    const visibilityOverlayOpacity = Math.max(
      0.1,
      0.72 - progressPercent / 150
    );
    const progressLabel =
      failed
        ? taskErrorDetail(task.error)
        : totalLayouts > 0
        ? `${createdLayouts} of ${totalLayouts} layouts`
        : "Preparing layouts";

    return (
      <Card
        role="group"
        aria-label={`${templateName} template ${failed ? "generation failed" : "is processing"}`}
        className={cn(
          "relative overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)]",
          failed ? "shadow-sm" : "cursor-not-allowed opacity-90 shadow-sm"
        )}
      >
        <TemplatePreviewStage>
          <LayoutsBadge count={totalLayouts} />
          <TemplateThumbnailPreview
            thumbnail={task.data?.thumbnail}
            templateName={templateName}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-5 z-20 rounded-xl bg-[var(--surface)] transition-opacity duration-500 ease-out"
            style={{ opacity: visibilityOverlayOpacity }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-5 right-5 top-5 z-20 rounded-r-xl bg-[color-mix(in_srgb,var(--accent-soft)_70%,transparent)] transition-[width] duration-500 ease-out"
            style={{ width: overlayWidth }}
          />
          <div
            className={cn(
              "absolute right-8 top-8 z-30 inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color-mix(in_srgb,var(--surface)_90%,transparent)] px-2.5 py-1.5 text-xs font-bold shadow-sm backdrop-blur",
              failed ? "text-red-600" : "text-[var(--text)]"
            )}
          >
            {failed ? (
              <AlertCircle className="h-3.5 w-3.5" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--ink)]" />
            )}
            {failed ? "Failed" : `${progressPercent}%`}
          </div>
          <div className="absolute inset-x-5 bottom-5 z-30 h-1.5 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--surface)_70%,transparent)]">
            <div
              className="h-full rounded-full bg-[var(--ink)] transition-[width] duration-500 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </TemplatePreviewStage>
        <div className="relative z-40 flex items-center justify-between gap-4 border-t border-[var(--border)] bg-[var(--surface)] px-6 py-5">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-syne text-base font-bold capitalize text-[var(--text)]">
              {templateName}
            </h3>
            <p
              className={cn(
                "mt-1 line-clamp-2 text-xs font-medium",
                failed ? "text-red-600" : "text-[var(--text-2)]"
              )}
            >
              {progressLabel}
            </p>
          </div>
          {failed && onRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={onRetry}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--ink)] px-3 py-2 text-xs font-semibold text-[var(--ink-text)] transition hover:bg-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {retrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Retry
            </button>
          )}
        </div>
      </Card>
    );
  }
);

function taskErrorDetail(error: unknown): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return "Template generation failed";
}

export function TemplateListSection({
  label,
  children,
  selectionPage = false,
}: {
  label: string;
  children: React.ReactNode;
  selectionPage?: boolean;
}) {
  return (
    <section className={selectionPage ? "space-y-3" : "space-y-4"}>
      <h3
        className={cn(
          "font-syne text-sm text-[var(--text)]",
          selectionPage ? "text-base font-medium" : "font-semibold"
        )}
      >
        {label}
      </h3>
      {children}
    </section>
  );
}

export function TemplateTabSwitcher({
  tab,
  onTabChange,
  libraryPage = false,
}: {
  tab: TemplateTab;
  onTabChange: (tab: TemplateTab) => void;
  libraryPage?: boolean;
}) {
  if (libraryPage) {
    return (
      <div role="group" aria-label="Template type" className="flex h-9 w-[180px] shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] p-[3px] font-manrope">
        {([{ value: "default", label: "Built-In" }, { value: "custom", label: "Custom" }] as const).map((item) => (
          <button key={item.value} type="button" aria-pressed={tab === item.value} onClick={() => onTabChange(item.value)} className={cn("flex h-7 flex-1 items-center justify-center rounded-lg text-[13px] font-medium leading-6 text-[var(--text)] outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_30%,transparent)]", tab === item.value ? "bg-[var(--canvas)]" : "hover:bg-[var(--canvas)]")}>{item.label}</button>
        ))}
      </div>
    );
  }
  return (
    <div className="p-1 rounded-[40px] bg-[var(--canvas)] w-fit border border-[var(--border)] flex items-center justify-center">
      <button
        type="button"
        className="px-5 py-2 text-xs font-medium text-[var(--text)] rounded-[70px]"
        onClick={() => onTabChange("custom")}
        style={{
          background: tab === "custom" ? "var(--accent-soft)" : "transparent",
          color: tab === "custom" ? "var(--text)" : "var(--text-2)",
        }}
      >
        Custom
      </button>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="mx-1"
        width="2"
        height="17"
        viewBox="0 0 2 17"
        fill="none"
        aria-hidden="true"
      >
        <path d="M1 0V16.5" stroke="#EDECEC" strokeWidth="2" />
      </svg>
      <button
        type="button"
        className="px-5 py-2 text-xs font-medium text-[var(--text)] rounded-[70px]"
        onClick={() => onTabChange("default")}
        style={{
          background: tab === "default" ? "var(--accent-soft)" : "transparent",
          color: tab === "default" ? "var(--text)" : "var(--text-2)",
        }}
      >
        Built-in
      </button>
    </div>
  );
}

export function TemplateListLoadingState({ message = "Loading templates..." }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-12 font-syne">
      <Loader2 className="w-8 h-8 animate-spin text-[var(--text)]" />
      <span className="ml-3 text-[var(--text-2)]">{message}</span>
    </div>
  );
}

export function TemplateListEmptyState({ message = "No templates available." }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-12 font-syne text-[var(--text-2)]">
      {message}
    </div>
  );
}
