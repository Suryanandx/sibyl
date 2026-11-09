"use client";
import { withBasePath } from "@/utils/basePath";

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AlignCenter,
  AreaChart,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  BarChart3,
  Bookmark,
  ChartNoAxesGantt,
  ChevronsRight,
  Circle,
  Cloud,
  Columns2,
  Diamond,
  Droplet,
  Flag,
  Gauge,
  Grid3X3,
  Heart,
  Hexagon,
  Home,
  Image,
  LineChart,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  Moon,
  Move,
  Octagon,
  Pentagon,
  PieChart,
  Play,
  Plus,
  Quote,
  RectangleHorizontal,
  Rows3,
  Shield,
  Shapes,
  Star,
  Sun,
  Table2,
  Triangle,
  ListMinus,
  Search,
  Sigma,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { notify } from "@/components/ui/sonner";
import { MixpanelEvent, trackEvent } from "@/utils/mixpanel";
import type { SlideElement } from "@/components/slide-editor/types";

import {
  ELEMENT_INSERT_GROUPS,
  createChartInsertElements,
  createElementInsertElements,
  createImageInsertContent,
  createInfographicInsertElements,
  createTableInsertElements,
  createTextInsertElements,
  type ElementInsertKind,
  type EditorInsertContent,
} from "@/components/slide-editor/insert/insert-elements";
import {
  adaptTemplateV2ComponentToElement,
  extractTemplateV2Layouts,
  extractTemplateV2MergedComponents,
  type TemplateV2Layout,
  type TemplateV2ImportResponse,
} from "@/components/slide-editor/importing/template-v2-import";
import {
  TEMPLATE_V2_INSERT_ELEMENTS_EVENT,
  TEMPLATE_V2_SURFACE_SELECTED_EVENT,
  type TemplateV2InsertComponent,
  type TemplateV2InsertElementsDetail,
  type TemplateV2SurfaceSelectedDetail,
} from "@/components/slide-editor/events/events";
import Chat from "./Chat";
import {
  PRESENTON_BLANK_SLIDE_PROMPT_EVENT,
  type BlankSlidePromptEventDetail,
  type BlankSlidePromptRequest,
} from "../../_shared/blank-slide-prompt-event";
import TemplateService from "../../services/api/template";
import { TemplateV2HtmlSlidePreview } from "../../components/TemplateV2HtmlSlidePreview";
import { isTemplateFreePresentation } from "../../_shared/blank-slide";
import {
  resolvePresentationTheme,
  type TemplateTheme,
} from "@/lib/template-theme";
import {
  InsertPalettePreview,
  type InsertPalettePreviewKind,
} from "./InsertPalettePreview";

type PresentationActionsProps = React.ComponentProps<typeof Chat> & {
  editingDisabled?: boolean;
  presentationData?: unknown;
  panelOpen?: boolean;
  onPanelOpenChange?: (open: boolean) => void;
};

type ActionId =
  | "ai"
  | "blocks"
  | "texts"
  | "charts"
  | "infograph"
  | "tables"
  | "images"
  | "shapes";

type ActionItem = {
  id: ActionId;
  label: string;
};

export type PaletteItem = {
  id?: string;
  label: string;
  icon: LucideIcon;
};

type UnknownRecord = Record<string, unknown>;

export type TemplateBlock = {
  key: string;
  title: string;
  description: string;
  elementCount: number;
  raw: unknown;
  index: number;
};

type TemplateBlockGroup = {
  key: string;
  title: string;
  description: string;
  variants: TemplateBlock[];
};

type BlocksPanelState = {
  blocks: TemplateBlockGroup[];
  error: string | null;
  loading: boolean;
};

type BlocksPanelAction =
  | { type: "cached"; blocks: TemplateBlockGroup[] }
  | { type: "loading" }
  | { type: "loaded"; blocks: TemplateBlockGroup[] }
  | { type: "failed"; message: string };

const initialBlocksPanelState: BlocksPanelState = {
  blocks: [],
  error: null,
  loading: false,
};

function blocksPanelReducer(
  state: BlocksPanelState,
  action: BlocksPanelAction,
): BlocksPanelState {
  switch (action.type) {
    case "cached":
    case "loaded":
      return { blocks: action.blocks, error: null, loading: false };
    case "loading":
      return { ...state, error: null, loading: true };
    case "failed":
      return { blocks: [], error: action.message, loading: false };
    default:
      return state;
  }
}

type PresentationActionsUiState = {
  activeAction: ActionId;
};

type PresentationActionsUiAction = {
  type: "selectAction";
  activeAction: ActionId;
};

const initialPresentationActionsUiState: PresentationActionsUiState = {
  activeAction: "ai",
};

function presentationActionsUiReducer(
  state: PresentationActionsUiState,
  action: PresentationActionsUiAction,
): PresentationActionsUiState {
  switch (action.type) {
    case "selectAction":
      return { ...state, activeAction: action.activeAction };
    default:
      return state;
  }
}

const insertActions: ActionItem[] = [
  { id: "ai", label: "AI", },
  { id: "blocks", label: "Blocks", },
  { id: "texts", label: "Texts", },
  { id: "charts", label: "Charts", },
  { id: "infograph", label: "Infograph",  },
  { id: "tables", label: "Tables",  },
  { id: "images", label: "Images", },
  { id: "shapes", label: "Shapes", },
];

const actionIconSrc: Record<ActionId, string> = {
  ai: withBasePath("/figma/presentation-actions/ai.svg"),
  blocks: withBasePath("/figma/presentation-actions/blocks.svg"),
  charts: withBasePath("/figma/presentation-actions/charts.svg"),
  infograph: withBasePath("/figma/presentation-actions/infographics.svg"),
  shapes: withBasePath("/figma/presentation-actions/shapes.svg"),
  images: withBasePath("/figma/presentation-actions/images.svg"),
  texts: withBasePath("/figma/presentation-actions/texts.svg"),
  tables: withBasePath("/figma/presentation-actions/tables.svg"),
};

export const textItems = [
  { id: "equation", label: "Equation", icon: Sigma },
  { id: "equation-quadratic", label: "Quadratic", icon: Sigma },
  { id: "equation-summation", label: "Summation", icon: Sigma },
  { id: "equation-integral", label: "Integral", icon: Sigma },
  { id: "equation-matrix", label: "Matrix", icon: Sigma },
  { id: "title-block", label: "Title Block", icon: AlignCenter },
  { id: "subtitle", label: "Subtitle", icon: AlignCenter },
  { id: "bullet-list", label: "Bullet List", icon: List },
  { id: "numbered-list", label: "Order List", icon: ListOrdered },
  { id: "list-item", label: "List Item", icon: ListMinus },
  { id: "quote", label: "Quote", icon: Quote },
  { id: "body-text", label: "Body Text", icon: Columns2 },
] satisfies PaletteItem[];

const textStyleOptions = [
  {
    itemId: "title-block",
    label: "Add a heading",
    textClassName: "text-[clamp(23px,2vw,28px)] leading-none",
  },
  {
    itemId: "subtitle",
    label: "Add a subheading",
    textClassName: "text-[clamp(17px,1.45vw,20px)] leading-6",
  },
  {
    itemId: "body-text",
    label: "Add a body text",
    textClassName: "text-[clamp(13px,1.05vw,15px)] leading-5",
  },
  {
    itemId: "bullet-list",
    label: "Add a bullet point",
    textClassName: "text-[clamp(13px,1.05vw,15px)] leading-5",
    bullet: true,
  },
] as const;

const textCompositionItemIds = [
  "equation",
  "equation-quadratic",
  "equation-summation",
  "quote",
  "equation-integral",
  "equation-matrix",
  "numbered-list",
  "list-item",
] as const;

const textCompositionItems = textCompositionItemIds.flatMap((itemId) => {
  const item = textItems.find((candidate) => candidate.id === itemId);
  return item ? [item] : [];
});

export const chartTypeItems = [
  { id: "bar", label: "Bar Chart", icon: BarChart3 },
  { id: "horizontal_bar", label: "Horizontal Bar", icon: BarChart3 },
  { id: "stacked_bar", label: "Stacked Bar", icon: BarChart3 },
  {
    id: "horizontal_stacked_bar",
    label: "Horizontal Stack Bar",
    icon: BarChart3,
  },
  { id: "line", label: "Line Chart", icon: LineChart },
  { id: "pie", label: "Pie Chart", icon: PieChart },
  { id: "area", label: "Area Chart", icon: AreaChart },
  { id: "donut", label: "Donut Chart", icon: PieChart },
  { id: "scatter", label: "Scatter Chart", icon: Circle },
  { id: "radar", label: "Radar Chart", icon: PieChart },
  { id: "polar_area", label: "Polar Area", icon: PieChart },
] satisfies PaletteItem[];

export const infographicItems = [
  { id: "progress_bar", label: "Progress Bar", icon: ChartNoAxesGantt },
  { id: "gauge", label: "Gauge Chart", icon: Gauge },
  { id: "gantt", label: "Gantt Chart", icon: ChartNoAxesGantt },
  { id: "timeline", label: "Timeline", icon: ArrowRight },
  { id: "roadmap", label: "Roadmap", icon: Move },
  { id: "milestone_timeline", label: "Milestones", icon: Flag },
  { id: "staircase", label: "Staircase", icon: Rows3 },
  { id: "supply_chain", label: "Supply Chain", icon: Move },
  { id: "stair_step_blocks", label: "Step Blocks", icon: Rows3 },
  { id: "maturity_model", label: "Maturity Model", icon: Rows3 },
  { id: "pillar_framework", label: "Pillar Framework", icon: Columns2 },
  { id: "transformation_hub", label: "Transformation Hub", icon: Shapes },
  { id: "diagonal_circles", label: "Diagonal Circles", icon: Circle },
  { id: "risk_matrix", label: "Risk Matrix", icon: Grid3X3 },
  { id: "chevron_process", label: "Chevron Process", icon: ChevronsRight },
  { id: "radial_cycle", label: "Radial Cycle", icon: Circle },
  { id: "conversion_funnel", label: "Conversion Funnel", icon: AreaChart },
  { id: "vertical_funnel", label: "Vertical Funnel", icon: AreaChart },
  { id: "pyramid", label: "Pyramid", icon: Triangle },
  { id: "segmented_wheel", label: "Segmented Wheel", icon: Circle },
  { id: "customer_journey", label: "Customer Journey", icon: Move },
  { id: "before_after", label: "Before & After", icon: Columns2 },
  { id: "impact_effort_matrix", label: "Impact / Effort", icon: Grid3X3 },
  { id: "comparison_matrix", label: "Comparison Matrix", icon: Table2 },
  { id: "org_chart", label: "Organization Chart", icon: Rows3 },
  { id: "decision_tree", label: "Decision Tree", icon: Shapes },
  { id: "mind_map", label: "Mind Map", icon: Shapes },
] satisfies PaletteItem[];

export const tableTypeItems = [
  { id: "simple-table", label: "Simple Table", icon: Table2 },
  { id: "comparison-table", label: "Comparison Table", icon: Columns2 },
  { id: "project-table", label: "Project Tracker", icon: Rows3 },
  { id: "metrics-table", label: "Metrics Table", icon: Table2 },
] satisfies PaletteItem[];

export const imageItems = [
  { id: "image-frame-square", label: "Square Frame", icon: Image },
  { id: "image-frame-rounded", label: "Rounded Frame", icon: Image },
  { id: "image-frame-circle", label: "Circle Frame", icon: Circle },
  { id: "image-frame-pentagon", label: "Pentagon Frame", icon: Pentagon },
  { id: "image-frame-polaroid", label: "Polaroid Frame", icon: Image },
  { id: "image-frame-torn", label: "Torn Paper Frame", icon: Image },
  { id: "image-filmstrip", label: "Film Strip", icon: Image },
  { id: "image-petal-grid", label: "Petal Collage", icon: Grid3X3 },
  { id: "image-frame-clover", label: "Clover Frame", icon: Image },
  { id: "image-circle-triptych", label: "Circle Triptych", icon: Circle },
  { id: "image-starburst", label: "Starburst Frame", icon: Star },
  { id: "image-triple-strip", label: "Three Image Strip", icon: Columns2 },
  { id: "image-frame-stamp", label: "Postage Frame", icon: Image },
  { id: "image-frame-torn-bottom", label: "Torn Bottom Frame", icon: Image },
  { id: "image-collage", label: "Image Collage", icon: Grid3X3 },
  { id: "image-vertical-stack", label: "Vertical Stack", icon: Rows3 },
  { id: "image", label: "Full Image", icon: Image },
  { id: "image-grid", label: "Image Grid", icon: Grid3X3 },
  { id: "image-split", label: "Two Images", icon: Columns2 },
  { id: "image-frame-ornate", label: "Corner Frame", icon: Image },
  { id: "image-text", label: "Image + Text", icon: Columns2 },
  { id: "image-caption", label: "Image + Caption", icon: Image },
] satisfies PaletteItem[];

const compactImageCardClassNames: Record<string, string> = {
  "image-filmstrip": "col-span-2",
  "image-triple-strip": "col-span-2",
};

const compactImageItems = imageItems.slice(0, 14);
const compositionImageItems = imageItems.slice(14);

const elementIconById: Record<ElementInsertKind, LucideIcon> = {
  "vector-rectangle": RectangleHorizontal,
  "vector-rounded-rectangle": RectangleHorizontal,
  "vector-capsule": RectangleHorizontal,
  "vector-circle": Circle,
  "vector-ellipse": Circle,
  "vector-triangle": Triangle,
  "vector-right-triangle": Triangle,
  "vector-diamond": Diamond,
  "vector-parallelogram": Shapes,
  "vector-trapezoid": Shapes,
  "vector-pentagon": Pentagon,
  "vector-hexagon": Hexagon,
  "vector-octagon": Octagon,
  "vector-teardrop": Droplet,
  "vector-line": Minus,
  "vector-line-arrow": ArrowRight,
  "vector-line-arrow-both": ArrowLeftRight,
  "vector-line-stealth": ArrowRight,
  "vector-line-filled": ArrowRight,
  "vector-line-filled-both": ArrowLeftRight,
  "vector-line-circle-arrow": ArrowRight,
  "vector-line-square-arrow": ArrowRight,
  "vector-line-diamond-arrow": ArrowRight,
  "vector-arrow": ArrowRight,
  "vector-arrow-left": ArrowLeft,
  "vector-arrow-up": ArrowUp,
  "vector-arrow-down": ArrowDown,
  "vector-arrow-left-right": ArrowLeftRight,
  "vector-arrow-up-down": ArrowUpDown,
  "vector-chevron-right": ChevronsRight,
  "vector-notched-arrow": ArrowRight,
  "vector-bent-arrow": ArrowUpRight,
  "vector-four-way-arrow": Move,
  "vector-plus": Plus,
  "vector-cross": X,
  "vector-lightning": Zap,
  "vector-home": Home,
  "vector-speech-bubble": MessageSquare,
  "vector-cloud": Cloud,
  "vector-heart": Heart,
  "vector-star": Star,
  "vector-bookmark": Bookmark,
  "vector-shield": Shield,
  "vector-flag": Flag,
  "vector-moon": Moon,
  "vector-sun": Sun,
  "vector-play": Play,
};

export const elementItemGroups = ELEMENT_INSERT_GROUPS.map((group) => ({
  label: group.label,
  items: group.items.map((item) => ({
    ...item,
    icon: elementIconById[item.id],
  })),
}));

export const elementItems = elementItemGroups.flatMap((group) => group.items);

const templateBlocksCache = new Map<string, TemplateBlockGroup[]>();
const BLOCK_PREVIEW_PADDING = { x: 0.04, y: 0.04 };

const NavButton = ({
  item,
  active,
  disabled = false,
  onClick,
}: {
  item: ActionItem;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) => {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex w-full flex-col items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)] text-[12px] font-normal leading-normal transition-colors",
        item.id === "images" ? "h-[52px] gap-2" : "h-12 gap-1",
        active ? "text-[var(--text)]" : "text-[var(--text)]",
        disabled && "cursor-not-allowed opacity-40",
      )}
      aria-pressed={active}
    >
      <span
        className={cn(
          "flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-transparent transition-all",
          active && "border-[var(--border)] bg-[var(--surface)]",
        )}
        style={{
          boxShadow: active ? "0 6.6px 13.2px 0 rgba(89, 108, 93, 0.14)" : "",
        }}
      >
        <img
          alt=""
          aria-hidden="true"
          className="h-[14px] w-[14px]"
          src={actionIconSrc[item.id]}
        />
      </span>
      <span>{item.label}</span>
    </button>
  );
};

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <h4 className="mb-2 text-[10px] font-normal uppercase leading-[15px] tracking-[0.367px] text-[var(--text-3)]">
    {children}
  </h4>
);

const FilledAccordionArrow = ({
  className,
  expanded,
}: {
  className?: string;
  expanded: boolean;
}) => (
  <svg
    aria-hidden="true"
    className={cn(
      "h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
      !expanded && "-rotate-90",
      className,
    )}
    viewBox="0 0 12 12"
  >
    <path d="M1.75 3.5h8.5L6 8.5 1.75 3.5Z" fill="currentColor" />
  </svg>
);

const PaletteCard = ({
  disabled = false,
  item,
  onClick,
  previewKind,
  theme,
}: {
  disabled?: boolean;
  item: PaletteItem;
  onClick?: () => void;
  previewKind: InsertPalettePreviewKind;
  theme: TemplateTheme;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={cn(
      "group min-w-0 overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)] text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--ink)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]",
      disabled &&
        "cursor-not-allowed opacity-50 hover:translate-y-0 hover:border-[var(--border)] hover:shadow-sm",
    )}
    aria-label={`Add ${item.label}`}
    title={item.label}
  >
    <div className="aspect-video w-full overflow-hidden bg-[var(--surface)]">
      <InsertPalettePreview itemId={item.id} kind={previewKind} theme={theme} />
    </div>
    <span className="block truncate border-t border-[var(--border)] px-2.5 py-2 text-[11px] font-medium leading-4 text-[var(--text)]">
      {item.label}
    </span>
  </button>
);

const PaletteGrid = ({
  disabled = false,
  items,
  onSelect,
  previewKind,
  theme,
}: {
  disabled?: boolean;
  items: PaletteItem[];
  onSelect?: (item: PaletteItem) => void;
  previewKind: InsertPalettePreviewKind;
  theme: TemplateTheme;
}) => (
  <div className="grid grid-cols-2 gap-[clamp(8px,0.8vw,10px)]">
    {items.map((item) => (
      <PaletteCard
        key={item.id ?? item.label}
        item={item}
        disabled={disabled}
        onClick={onSelect && !disabled ? () => onSelect(item) : undefined}
        previewKind={previewKind}
        theme={theme}
      />
    ))}
  </div>
);

export const InsertPanel = ({
  disabled = false,
  title,
  groups,
  onItemSelect,
  previewKind,
  theme,
}: {
  disabled?: boolean;
  title: string;
  groups: Array<{
    label: string;
    items: PaletteItem[];
  }>;
  onItemSelect?: (item: PaletteItem) => void;
  previewKind: InsertPalettePreviewKind;
  theme: TemplateTheme;
}) => (
  <div className="h-full overflow-y-auto px-[clamp(14px,1.4vw,20px)] pb-[clamp(24px,2.2vw,32px)] pt-[clamp(24px,2.2vw,32px)] hide-scrollbar">
    <h3 className="mb-[clamp(24px,2.2vw,32px)] text-[clamp(13px,0.95vw,15px)] font-semibold leading-5 text-[var(--text)]">
      {title}
    </h3>
    <div className="space-y-3.5">
      {groups.map((group) => (
        <section key={group.label}>
          <SectionLabel>{group.label}</SectionLabel>
          <PaletteGrid
            disabled={disabled}
            items={group.items}
            onSelect={onItemSelect}
            previewKind={previewKind}
            theme={theme}
          />
        </section>
      ))}
    </div>
  </div>
);

function TextsPanel({
  disabled = false,
  onItemSelect,
  theme,
}: {
  disabled?: boolean;
  onItemSelect?: (item: PaletteItem) => void;
  theme: TemplateTheme;
}) {
  const [compositionsExpanded, setCompositionsExpanded] = useState(true);

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)] hide-scrollbar">
      <div className="px-[clamp(14px,1.4vw,20px)] pb-3 pt-[clamp(22px,2vw,28px)]">
        <h3 className="mb-5 text-[15px] font-medium leading-5 text-[var(--text)]">
          Text Styles
        </h3>

        <div className="space-y-2">
          {textStyleOptions.map((option) => {
            const item = textItems.find(
              (candidate) => candidate.id === option.itemId,
            );
            if (!item) return null;

            return (
              <button
                key={option.itemId}
                type="button"
                disabled={disabled}
                onClick={
                  onItemSelect && !disabled
                    ? () => onItemSelect(item)
                    : undefined
                }
                className={cn(
                  "group flex min-h-[52px] w-full items-center rounded-[13px] border border-[var(--border)] bg-[var(--surface)] px-[clamp(14px,1.3vw,18px)] text-left font-normal text-[var(--text)] transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-[var(--ink)] hover:bg-[var(--accent-soft)] hover:shadow-[0_6px_16px_rgba(67,56,202,0.07)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]",
                  option.textClassName,
                  disabled &&
                    "cursor-not-allowed opacity-50 hover:translate-y-0 hover:border-[var(--border)] hover:bg-[var(--surface)] hover:shadow-none",
                )}
                aria-label={option.label}
              >
                {"bullet" in option && option.bullet ? (
                  <span
                    className="mr-3 text-[18px] leading-none"
                    aria-hidden="true"
                  >
                    •
                  </span>
                ) : null}
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <section>
        <div className="sticky top-0 z-10 bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-[clamp(14px,1.4vw,20px)] backdrop-blur-sm">
          <button
            type="button"
            onClick={() => setCompositionsExpanded((expanded) => !expanded)}
            className="flex min-h-[52px] w-full items-center gap-2 border-b border-transparent py-3 text-left transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
            aria-expanded={compositionsExpanded}
            aria-controls="text-compositions"
          >
            <FilledAccordionArrow
              expanded={compositionsExpanded}
              className="text-[var(--text-3)]"
            />
            <span className="text-[15px] font-medium leading-5 text-[var(--text)]">
              Compositions
            </span>
            <span className="ml-auto text-[11px] font-normal tabular-nums text-[var(--text-3)]">
              {textCompositionItems.length} Options
            </span>
          </button>
        </div>

        <div
          id="text-compositions"
          inert={!compositionsExpanded}
          className={cn(
            "grid motion-reduce:transition-none transition-[grid-template-rows,opacity] duration-200 ease-out",
            compositionsExpanded
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="grid grid-cols-2 gap-x-3 gap-y-5 px-[clamp(14px,1.4vw,20px)] pb-[clamp(24px,2.2vw,32px)] pt-1">
              {textCompositionItems.map((item) => (
                <button
                  key={item.id ?? item.label}
                  type="button"
                  disabled={disabled}
                  onClick={
                    onItemSelect && !disabled
                      ? () => onItemSelect(item)
                      : undefined
                  }
                  className={cn(
                    "group min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)] focus-visible:ring-offset-2",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                  aria-label={`Add ${item.label}`}
                >
                  <span className="block aspect-[4/3] w-full overflow-hidden bg-[var(--canvas)] transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_8px_20px_rgba(67,56,202,0.10)]">
                    <InsertPalettePreview
                      itemId={item.id}
                      kind="text"
                      theme={theme}
                    />
                  </span>
                  <span className="mt-2 block truncate text-[14px] font-normal leading-5 text-[var(--text)]">
                    {item.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ChartsPanel({
  disabled = false,
  onItemSelect,
  theme,
}: {
  disabled?: boolean;
  onItemSelect?: (item: PaletteItem) => void;
  theme: TemplateTheme;
}) {
  const [query, setQuery] = useState("");
  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return chartTypeItems;

    return chartTypeItems.filter((item) =>
      item.label.toLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)] hide-scrollbar">
      <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-[clamp(14px,1.4vw,20px)] pb-4 pt-5 backdrop-blur-sm">
        <label className="relative block">
          <span className="sr-only">Search charts</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Charts..."
            className="h-11 w-full appearance-none border-0 border-b border-[var(--border)] bg-transparent px-0 pr-8 text-[15px] font-normal text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-3)] focus:border-[var(--ink)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
              aria-label="Clear chart search"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </label>

        <div className="mt-7 flex items-end justify-between gap-3">
          <h3 className="text-[17px] font-medium leading-6 text-[var(--text)]">
            Charts
          </h3>
          <span className="text-[11px] tabular-nums text-[var(--text-3)]">
            {visibleItems.length}
          </span>
        </div>
      </div>

      <div className="px-[clamp(14px,1.4vw,20px)] pb-[clamp(24px,2.2vw,32px)] pt-5">
        {visibleItems.length > 0 ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-5">
            {visibleItems.map((item) => (
              <button
                key={item.id ?? item.label}
                type="button"
                disabled={disabled}
                onClick={
                  onItemSelect && !disabled
                    ? () => onItemSelect(item)
                    : undefined
                }
                className={cn(
                  "group min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)] focus-visible:ring-offset-2",
                  disabled && "cursor-not-allowed opacity-50",
                )}
                aria-label={`Add ${item.label}`}
              >
                <span className="block aspect-video w-full overflow-hidden bg-[var(--canvas)] transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_8px_20px_rgba(67,56,202,0.10)]">
                  <InsertPalettePreview
                    itemId={item.id}
                    kind="chart"
                    theme={theme}
                  />
                </span>
                <span className="mt-2 block truncate text-[14px] font-normal leading-5 text-[var(--text)]">
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-[10px] border border-dashed border-[var(--border-strong)] bg-[var(--canvas)] px-4 py-8 text-center">
            <Search
              className="mx-auto h-5 w-5 text-[var(--text-3)]"
              strokeWidth={1.7}
              aria-hidden
            />
            <p className="mt-2 text-[12px] font-medium text-[var(--text-2)]">
              No matching charts
            </p>
            <p className="mt-1 text-[11px] leading-4 text-[var(--text-3)]">
              Try a different name or keyword.
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mt-3 rounded-[7px] bg-[var(--accent-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
            >
              Clear search
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ImagesPanel({
  disabled = false,
  onItemSelect,
  theme,
}: {
  disabled?: boolean;
  onItemSelect?: (item: PaletteItem) => void;
  theme: TemplateTheme;
}) {
  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)] hide-scrollbar">
      <div className="sticky top-0 z-20 bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-4 pb-[10px] pt-8 backdrop-blur-sm">
        <h3 className="font-['Inter'] text-[14px] font-normal leading-normal text-[var(--text)]">
          Images
        </h3>
      </div>

      <div className="space-y-[18px] px-4 pb-8 pt-[10px]">
        {[
          {
            items: compactImageItems,
            gridClassName:
              "auto-rows-[60px] grid-cols-[repeat(4,60px)] gap-[9px]",
            cardClassName: (item: PaletteItem) =>
              (item.id && compactImageCardClassNames[item.id]) ?? "",
          },
          {
            items: compositionImageItems,
            gridClassName:
              "auto-rows-[96px] grid-cols-[repeat(2,129px)] gap-[9px]",
            cardClassName: () => "",
          },
        ].map((group, groupIndex) => (
          <div
            key={groupIndex}
            className={cn("grid grid-flow-row", group.gridClassName)}
          >
            {group.items.map((item) => (
              <button
                key={item.id ?? item.label}
                type="button"
                disabled={disabled}
                onClick={
                  onItemSelect && !disabled
                    ? () => onItemSelect(item)
                    : undefined
                }
                className={cn(
                  "group h-full w-full min-w-0 rounded-[9px] text-left focus-visible:outline-none",
                  group.cardClassName(item),
                  disabled && "cursor-not-allowed opacity-50",
                )}
                aria-label={`Add ${item.label}`}
                title={item.label}
              >
                <span className="block h-full w-full overflow-hidden rounded-[inherit] bg-[var(--canvas)] ring-1 ring-inset ring-transparent transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_7px_18px_rgba(39,39,42,0.12)] group-hover:ring-[var(--accent)] group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]">
                  <InsertPalettePreview
                    itemId={item.id}
                    kind="image"
                    theme={theme}
                  />
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ShapesPanel({
  disabled = false,
  onItemSelect,
  theme,
}: {
  disabled?: boolean;
  onItemSelect?: (item: PaletteItem) => void;
  theme: TemplateTheme;
}) {
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(elementItemGroups.map((group) => [group.label, true])),
  );
  const visibleGroups = useMemo<
    Array<{ label: string; items: PaletteItem[] }>
  >(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return elementItemGroups;

    return elementItemGroups.flatMap((group) => {
      const groupMatches = group.label.toLowerCase().includes(normalizedQuery);
      const items = groupMatches
        ? group.items
        : group.items.filter((item) =>
            item.label.toLowerCase().includes(normalizedQuery),
          );

      return items.length > 0 ? [{ ...group, items }] : [];
    });
  }, [query]);
  const hasSearchResults = visibleGroups.some((group) => group.items.length > 0);

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)] hide-scrollbar">
      <div className="sticky top-0 z-30 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-[clamp(14px,1.4vw,20px)] pb-4 pt-5 backdrop-blur-sm">
        <label className="relative block">
          <span className="sr-only">Search elements</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Elements..."
            className="h-11 w-full appearance-none border-0 border-b border-[var(--border)] bg-transparent px-0 pr-8 text-[15px] font-normal text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-3)] focus:border-[var(--ink)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
              aria-label="Clear element search"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </label>

        <h3 className="mt-7 text-[17px] font-medium leading-6 text-[var(--text)]">
          Shapes
        </h3>
      </div>

      {hasSearchResults ? (
        <div className="pb-[clamp(24px,2.2vw,32px)] pt-2">
          {visibleGroups.map((group) => {
            const expanded = query ? true : expandedGroups[group.label] !== false;
            const groupId = `shape-group-${group.label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")}`;

            return (
              <section key={group.label}>
                <div className="sticky top-[128px] z-20 bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-[clamp(14px,1.4vw,20px)] backdrop-blur-sm">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedGroups((current) => ({
                        ...current,
                        [group.label]: !expanded,
                      }))
                    }
                    className="flex min-h-[46px] w-full items-center gap-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
                    aria-expanded={expanded}
                    aria-controls={groupId}
                  >
                    <FilledAccordionArrow
                      expanded={expanded}
                      className="text-[var(--text)]"
                    />
                    <span className="text-[16px] font-normal leading-6 text-[var(--text)]">
                      {group.label}
                    </span>
                  </button>
                </div>

                <div
                  id={groupId}
                  inert={!expanded}
                  className={cn(
                    "grid motion-reduce:transition-none transition-[grid-template-rows,opacity] duration-200 ease-out",
                    expanded
                      ? "grid-rows-[1fr] opacity-100"
                      : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="grid grid-cols-5 gap-x-2 gap-y-3 px-[clamp(14px,1.4vw,20px)] pb-3 pt-1">
                      {group.items.map((item) => (
                        <button
                          key={item.id ?? item.label}
                          type="button"
                          disabled={disabled}
                          onClick={
                            onItemSelect && !disabled
                              ? () => onItemSelect(item)
                              : undefined
                          }
                          className={cn(
                            "group min-w-0 rounded-[8px] text-left focus-visible:outline-none",
                            disabled &&
                              "cursor-not-allowed opacity-50",
                          )}
                          aria-label={`Add ${item.label}`}
                          title={item.label}
                        >
                          <span className="block aspect-video w-full overflow-hidden rounded-[inherit] transition-shadow group-hover:ring-1 group-hover:ring-inset group-hover:ring-[var(--accent)] group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]">
                            <InsertPalettePreview
                              itemId={item.id}
                              kind="element"
                              theme={theme}
                            />
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="mx-[clamp(14px,1.4vw,20px)] mt-5 rounded-[10px] border border-dashed border-[var(--border-strong)] bg-[var(--canvas)] px-4 py-8 text-center">
          <Search
            className="mx-auto h-5 w-5 text-[var(--text-3)]"
            strokeWidth={1.7}
            aria-hidden
          />
          <p className="mt-2 text-[12px] font-medium text-[var(--text-2)]">
            No matching shapes
          </p>
          <p className="mt-1 text-[11px] leading-4 text-[var(--text-3)]">
            Try a different name or category.
          </p>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="mt-3 rounded-[7px] bg-[var(--accent-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
          >
            Clear search
          </button>
        </div>
      )}
    </div>
  );
}

function InfographicsPanel({
  disabled = false,
  onItemSelect,
  theme,
}: {
  disabled?: boolean;
  onItemSelect?: (item: PaletteItem) => void;
  theme: TemplateTheme;
}) {
  const [query, setQuery] = useState("");
  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return infographicItems;

    return infographicItems.filter((item) =>
      item.label.toLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)] hide-scrollbar">
      <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-[clamp(14px,1.4vw,20px)] pb-4 pt-5 backdrop-blur-sm">
        <label className="relative block">
          <span className="sr-only">Search infographics</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Infographics..."
            className="h-11 w-full appearance-none border-0 border-b border-[var(--border)] bg-transparent px-0 pr-8 text-[15px] font-normal text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-3)] focus:border-[var(--ink)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
              aria-label="Clear infographic search"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </label>

        <div className="mt-7 flex items-end justify-between gap-3">
          <h3 className="text-[17px] font-medium leading-6 text-[var(--text)]">
            Infographics
          </h3>
          <span className="text-[11px] tabular-nums text-[var(--text-3)]">
            {visibleItems.length}
          </span>
        </div>
      </div>

      <div className="px-[clamp(14px,1.4vw,20px)] pb-[clamp(24px,2.2vw,32px)] pt-5">
        {visibleItems.length > 0 ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-5">
            {visibleItems.map((item) => (
              <button
                key={item.id ?? item.label}
                type="button"
                disabled={disabled}
                onClick={
                  onItemSelect && !disabled
                    ? () => onItemSelect(item)
                    : undefined
                }
                className={cn(
                  "group min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)] focus-visible:ring-offset-2",
                  disabled && "cursor-not-allowed opacity-50",
                )}
                aria-label={`Add ${item.label}`}
              >
                <span className="block aspect-video w-full overflow-hidden bg-[var(--canvas)] transition-[box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_8px_20px_rgba(67,56,202,0.10)]">
                  <InsertPalettePreview
                    itemId={item.id}
                    kind="infographic"
                    theme={theme}
                  />
                </span>
                <span className="mt-2 block truncate text-[14px] font-normal leading-5 text-[var(--text)]">
                  {item.label}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-[10px] border border-dashed border-[var(--border-strong)] bg-[var(--canvas)] px-4 py-8 text-center">
            <Search
              className="mx-auto h-5 w-5 text-[var(--text-3)]"
              strokeWidth={1.7}
              aria-hidden
            />
            <p className="mt-2 text-[12px] font-medium text-[var(--text-2)]">
              No matching infographics
            </p>
            <p className="mt-1 text-[11px] leading-4 text-[var(--text-3)]">
              Try a different name or keyword.
            </p>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mt-3 rounded-[7px] bg-[var(--accent-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
            >
              Clear search
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExplicitThemeBackground(value: unknown) {
  const presentation = isRecord(value) ? value : null;
  const data = isRecord(presentation?.data) ? presentation.data : null;
  const theme = isRecord(presentation?.theme)
    ? presentation.theme
    : isRecord(data?.theme)
      ? data.theme
      : null;
  const colors = isRecord(theme?.colors)
    ? theme.colors
    : isRecord(presentation?.colors)
      ? presentation.colors
      : isRecord(data?.colors)
        ? data.colors
        : theme;
  const background = colors?.background;

  return typeof background === "string" && background.trim().length > 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readRecordString(record: UnknownRecord, key: string): string | null {
  return readString(record[key]);
}

function readRecordArray(record: UnknownRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function hasUsableComponentSize(record: UnknownRecord) {
  const size = isRecord(record.size) ? record.size : null;
  const width = typeof size?.width === "number" ? size.width : null;
  const height = typeof size?.height === "number" ? size.height : null;
  return Boolean(width && height && width > 0 && height > 0);
}

function humanizeIdentifier(value: string) {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function templateBlockFromComponent(
  component: unknown,
  index: number,
): TemplateBlock | null {
  const raw = isRecord(component) ? component : null;
  if (!raw) return null;

  const id = readRecordString(raw, "id");
  const title =
    readRecordString(raw, "name") ??
    readRecordString(raw, "title") ??
    (id ? humanizeIdentifier(id) : `Component ${index + 1}`);
  const description = readRecordString(raw, "description") ?? "";
  const elementCount = readRecordArray(raw, "elements").length;
  const keyBase = id ?? title;

  return {
    key: `${keyBase}-${index}`,
    title,
    description,
    elementCount,
    raw: component,
    index,
  };
}

function componentVariants(component: unknown): unknown[] {
  const raw = isRecord(component) ? component : null;
  if (!raw) return [];

  return readRecordArray(raw, "variants")
    .map((variant, variantIndex) => {
      if (!isRecord(variant)) return null;
      return {
        ...raw,
        ...variant,
        id:
          readRecordString(variant, "id") ??
          `${readRecordString(raw, "id") ?? "component"}_variant_${variantIndex + 1}`,
        name:
          readRecordString(variant, "name") ??
          readRecordString(variant, "title") ??
          readRecordString(raw, "name") ??
          readRecordString(raw, "title"),
        description:
          readRecordString(variant, "description") ??
          readRecordString(raw, "description"),
      };
    })
    .filter(Boolean);
}

function templateBlockGroupsFromTemplate(template: unknown): TemplateBlockGroup[] {
  const components = extractTemplateV2MergedComponents(template);
  return components
    .map((component, componentIndex) => {
      const baseBlock = templateBlockFromComponent(component, componentIndex);
      if (!baseBlock) return null;
      const variants = componentVariants(component);
      const variantSources = variants.length > 0 ? variants : [component];
      const variantBlocks = variantSources
        .map((variant, variantIndex) => {
          const block = templateBlockFromComponent(variant, componentIndex);
          return block
            ? { ...block, key: `${baseBlock.key}-variant-${variantIndex}` }
            : null;
        })
        .filter((block): block is TemplateBlock => Boolean(block));

      return variantBlocks.length > 0
        ? {
          key: baseBlock.key,
          title: baseBlock.title,
          description: baseBlock.description,
          variants: variantBlocks,
        }
        : null;
    })
    .filter((group): group is TemplateBlockGroup => Boolean(group));
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(Boolean) as string[]));
}

function collectCandidateTemplateIds(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];

  const ids: Array<string | null | undefined> = [];
  if (Array.isArray(value)) {
    value.slice(0, 80).forEach((item) => {
      ids.push(...collectCandidateTemplateIds(item, depth + 1));
    });
    return uniqueStrings(ids);
  }

  if (!isRecord(value)) return [];

  const directKeys = [
    "templateV2Id",
    "template_v2_id",
    "templateId",
    "template_id",
    "layout_group",
  ];

  directKeys.forEach((key) => {
    ids.push(readRecordString(value, key) ?? undefined);
  });

  const template = value.template;
  if (typeof template === "string") {
    ids.push(template);
  } else if (isRecord(template)) {
    ids.push(
      readRecordString(template, "id") ??
      readRecordString(template, "templateV2Id") ??
      readRecordString(template, "template_v2_id") ??
      undefined,
    );
  }

  [
    "layout",
    "layouts",
    "slides",
    "presentation",
    "properties",
    "ui",
    "metadata",
  ].forEach((key) => {
    ids.push(...collectCandidateTemplateIds(value[key], depth + 1));
  });

  if (typeof window !== "undefined" && depth === 0) {
    const params = new URLSearchParams(window.location.search);
    ids.push(
      params.get("templateV2Id") ??
      params.get("template_v2_id") ??
      params.get("template_id") ??
      params.get("templateId") ??
      undefined,
    );
  }

  return uniqueStrings(ids);
}

function collectPresentationLayoutIds(presentationData: unknown): string[] {
  const raw = isRecord(presentationData) ? presentationData : null;
  if (!raw) return [];

  const ids: Array<string | null | undefined> = [];
  const layout = raw.layout;

  if (typeof layout === "string") {
    ids.push(layout);
  } else if (isRecord(layout)) {
    ids.push(readRecordString(layout, "id"));
    extractTemplateV2Layouts(layout).forEach((entry) => {
      ids.push(readString(entry.id));
    });
  }

  readRecordArray(raw, "slides").forEach((slide) => {
    if (!isRecord(slide)) return;
    ids.push(readRecordString(slide, "layout"));
  });

  return uniqueStrings(ids);
}

function collectTemplateDetailLayoutIds(
  template: TemplateV2ImportResponse,
): string[] {
  return uniqueStrings([
    ...extractTemplateV2Layouts(template.layouts).map((layout) =>
      readString(layout.id),
    ),
    ...extractTemplateV2Layouts(template.raw_layouts).map((layout) =>
      readString(layout.id),
    ),
  ]);
}

function templateMatchesLayoutIds(
  template: TemplateV2ImportResponse,
  layoutIds: string[],
) {
  if (layoutIds.length === 0) return false;
  const wanted = new Set(layoutIds);
  return collectTemplateDetailLayoutIds(template).some((id) => wanted.has(id));
}

async function loadTemplateBlocksForPresentation(
  presentationData: unknown,
): Promise<TemplateBlockGroup[]> {
  const embeddedBlocks = templateBlockGroupsFromTemplate(presentationData);
  if (embeddedBlocks.length > 0) return embeddedBlocks;

  const candidateIds = collectCandidateTemplateIds(presentationData);
  for (const templateId of candidateIds) {
    try {
      const template = (await TemplateService.getTemplateDetails(
        templateId,
      )) as TemplateV2ImportResponse;
      const blocks = templateBlockGroupsFromTemplate(template);
      if (blocks.length > 0) return blocks;
    } catch {
      // Candidate ids can include legacy template slugs; ignore and try the next source.
    }
  }

  const layoutIds = collectPresentationLayoutIds(presentationData);
  if (layoutIds.length === 0) return [];

  try {
    const summaries = await TemplateService.getTemplateSummaries();
    for (const summary of summaries.items ?? []) {
      try {
        const template = (await TemplateService.getTemplateDetails(
          summary.id,
        )) as TemplateV2ImportResponse;
        if (!templateMatchesLayoutIds(template, layoutIds)) continue;

        const blocks = templateBlockGroupsFromTemplate(template);
        if (blocks.length > 0) return blocks;
      } catch {
        // Keep searching; one bad template should not break the blocks panel.
      }
    }
  } catch {
    return [];
  }

  return [];
}

function templateBlocksCacheKey(
  presentationId: string,
  presentationData: unknown,
) {
  const candidateIds = collectCandidateTemplateIds(presentationData).join(",");
  const layoutIds = collectPresentationLayoutIds(presentationData).join(",");
  return `${presentationId}:${candidateIds}:${layoutIds}`;
}

function blockPreviewLayout(block: TemplateBlock): TemplateV2Layout {
  return {
    id: `block-preview-${block.key}`,
    components: [block.raw],
  };
}

function blockPreviewBounds(block: TemplateBlock) {
  const element = adaptTemplateV2ComponentToElement(block.raw, block.index);
  const position = element?.position;
  const size = element?.size;

  if (
    !position ||
    !size ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return undefined;
  }

  // Template flow containers can be narrower than their rendered children
  // (for example, pagination labels whose text widths exceed the flex box).
  // Give small components proportionally more breathing room while capping
  // the expansion so large blocks still fill their preview cards.
  const horizontalSafety = Math.min(
    36,
    Math.max(12, size.width * 0.06),
  );
  const verticalSafety = Math.min(
    24,
    Math.max(6, size.height * 0.08),
  );

  return {
    left: position.x - horizontalSafety,
    top: position.y - verticalSafety,
    right: position.x + size.width + horizontalSafety,
    bottom: position.y + size.height + verticalSafety,
  };
}

function BlockThumbnail({ block }: { block: TemplateBlock }) {
  const layout = useMemo(() => blockPreviewLayout(block), [block]);
  const bounds = useMemo(() => blockPreviewBounds(block), [block]);

  return (
    <div
      className="template-block-preview relative aspect-video w-full overflow-hidden rounded-[6px] bg-[var(--canvas)] transition-colors duration-150 group-hover:bg-[var(--ink)] group-focus-visible:bg-[var(--ink)]"
    >
      <TemplateV2HtmlSlidePreview
        slide={{
          ui: layout,
        }}
        fonts={null}
        fitBounds={bounds}
        fitPadding={BLOCK_PREVIEW_PADDING}
        className="template-block-preview-surface pointer-events-none h-full rounded-[inherit] transition-colors duration-150 group-hover:bg-[var(--ink)] group-focus-visible:bg-[var(--ink)]"
        contentClassName="template-block-preview-content rounded-[inherit] transition-colors duration-150 group-hover:bg-[var(--ink)] group-focus-visible:bg-[var(--ink)] group-hover:[&_[data-template-v2-html-slide]]:!bg-[var(--ink)] group-focus-visible:[&_[data-template-v2-html-slide]]:!bg-[var(--ink)]"
      />
    </div>
  );
}

function BlockVariantButton({
  block,
  disabled = false,
  onInsertBlock,
}: {
  block: TemplateBlock;
  disabled?: boolean;
  onInsertBlock: (block: TemplateBlock) => void;
}) {
  return (
    <button
      type="button"
      data-block-variant
      disabled={disabled}
      className={cn(
        "template-block-variant group relative w-full overflow-hidden rounded-[8px] border border-transparent bg-[var(--canvas)] p-0 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-[var(--ink)] hover:shadow-[0_8px_20px_rgba(67,56,202,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]",
        disabled && "cursor-not-allowed opacity-50 hover:translate-y-0 hover:border-transparent hover:shadow-none",
      )}
      onClick={() => {
        if (!disabled) onInsertBlock(block);
      }}
      aria-label={`Insert ${block.title}`}
      title={`Add ${block.title}`}
    >
      <div className="relative">
        <BlockThumbnail block={block} />
        <span className="absolute right-1.5 top-1.5 flex h-7 w-7 scale-90 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] opacity-0 shadow-[0_6px_16px_rgba(16,24,40,0.18)] transition-[opacity,transform] duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100">
          <Plus className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        </span>
      </div>
    </button>
  );
}

function BlockGroupCard({
  defaultExpanded = false,
  disabled = false,
  group,
  onInsertBlock,
  searchActive = false,
}: {
  defaultExpanded?: boolean;
  disabled?: boolean;
  group: TemplateBlockGroup;
  onInsertBlock: (block: TemplateBlock) => void;
  searchActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded || searchActive);
  const [hasOpened, setHasOpened] = useState(defaultExpanded || searchActive);
  const variantCount = group.variants.length;
  const contentId = `block-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const groupTitle = group.title.replace(/^blocks?\s*[/:–—-]\s*/i, "");

  return (
    <section className="border-b border-[var(--border)] last:border-b-0">
      <button
        type="button"
        className="group sticky top-[117px] z-10 -mx-1 flex w-[calc(100%+8px)] items-center gap-2 border-b border-transparent bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-1 py-3 text-left backdrop-blur-sm transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) setHasOpened(true);
          setExpanded((current) => !current);
        }}
      >
        <FilledAccordionArrow
          expanded={expanded}
          className="text-[var(--text-3)] group-hover:text-[var(--text)]"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-[var(--text)]">
          <span className="font-normal text-[var(--text-3)]">Blocks/ </span>
          {groupTitle || group.title}
        </span>
        <span className="shrink-0 text-[11px] font-normal tabular-nums text-[var(--text-3)]">
          {variantCount} {variantCount === 1 ? "Layout" : "Layouts"}
        </span>
      </button>

      <div
        id={contentId}
        inert={!expanded}
        className={cn(
          "grid motion-reduce:transition-none transition-[grid-template-rows,opacity] duration-300 ease-out",
          expanded
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="grid grid-cols-2 gap-2 pb-4 pt-1">
            {hasOpened
              ? group.variants.map((block) => (
                  <BlockVariantButton
                    key={block.key}
                    block={block}
                    disabled={disabled}
                    onInsertBlock={onInsertBlock}
                  />
                ))
              : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export const BlocksPanel = ({
  disabled = false,
  presentationId,
  presentationData,
  onInsertBlock,
}: {
  disabled?: boolean;
  presentationId: string;
  presentationData?: unknown;
  onInsertBlock: (block: TemplateBlock) => void;
}) => {
  const [blockPrompt, setBlockPrompt] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [{ blocks, error, loading }, dispatchBlockState] = useReducer(
    blocksPanelReducer,
    initialBlocksPanelState,
  );
  const cacheKey = useMemo(
    () => templateBlocksCacheKey(presentationId, presentationData),
    [presentationData, presentationId],
  );
  const visibleBlocks = useMemo(() => {
    const query = blockPrompt.trim().toLowerCase();
    if (!query) return blocks;
    return blocks.filter(
      (group) =>
        group.title.toLowerCase().includes(query) ||
        group.description.toLowerCase().includes(query) ||
        group.variants.some(
          (variant) =>
            variant.title.toLowerCase().includes(query) ||
            variant.description.toLowerCase().includes(query),
        ),
    );
  }, [blockPrompt, blocks]);
  const visibleLayoutCount = useMemo(
    () =>
      visibleBlocks.reduce(
        (count, group) => count + group.variants.length,
        0,
      ),
    [visibleBlocks],
  );
  const searchActive = blockPrompt.trim().length > 0;

  useEffect(() => {
    let cancelled = false;
    const cached = templateBlocksCache.get(cacheKey);
    if (cached) {
      dispatchBlockState({ type: "cached", blocks: cached });
      trackEvent(MixpanelEvent.Editor_Template_Blocks_Loaded, {
        presentation_id: presentationId,
        block_group_count: cached.length,
        from_cache: true,
      });
      return;
    }

    dispatchBlockState({ type: "loading" });
    void loadTemplateBlocksForPresentation(presentationData)
      .then((nextBlocks) => {
        if (cancelled) return;
        if (nextBlocks.length > 0) {
          templateBlocksCache.set(cacheKey, nextBlocks);
        }
        dispatchBlockState({ type: "loaded", blocks: nextBlocks });
        trackEvent(MixpanelEvent.Editor_Template_Blocks_Loaded, {
          presentation_id: presentationId,
          block_group_count: nextBlocks.length,
          from_cache: false,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        dispatchBlockState({
          type: "failed",
          message: "Could not load template components.",
        });
        trackEvent(MixpanelEvent.Editor_Template_Blocks_Load_Failed, {
          presentation_id: presentationId,
          error_type:
            error instanceof Error ? error.name : "template_blocks_load_error",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, loadAttempt, presentationData, presentationId]);

  return (
    <div className="h-full overflow-y-auto hide-scrollbar">
      <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] px-[clamp(14px,1.4vw,20px)] pb-4 pt-5 backdrop-blur-sm">
        <label className="relative block">
          <span className="sr-only">Search blocks</span>
          <input
            type="search"
            value={blockPrompt}
            onChange={(event) => setBlockPrompt(event.target.value)}
            placeholder="Search Blocks..."
            className="h-11 w-full appearance-none border-0 border-b border-[var(--border)] bg-transparent px-0 pr-8 text-[15px] font-normal text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-3)] focus:border-[var(--ink)] [&::-webkit-search-cancel-button]:hidden"
          />
          {blockPrompt ? (
            <button
              type="button"
              onClick={() => setBlockPrompt("")}
              className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
              aria-label="Clear block search"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </label>

        <div className="mt-5 flex items-end justify-between gap-3">
          <h3 className="text-[15px] font-semibold leading-5 text-[var(--text)]">
            Blocks
          </h3>
          {!loading && !error ? (
            <span className="text-[11px] tabular-nums text-[var(--text-3)]">
              {visibleLayoutCount}{" "}
              {visibleLayoutCount === 1 ? "Layout" : "Layouts"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="px-[clamp(14px,1.4vw,20px)] pb-[clamp(24px,2.2vw,32px)] pt-2">
        {loading && (
          <div className="space-y-4 py-2" aria-label="Loading block layouts">
            {[0, 1, 2].map((item) => (
              <div key={item} className="animate-pulse">
                <div className="mb-3 flex items-center gap-2">
                  <div className="h-3 w-3 rounded bg-[var(--subtle)]" />
                  <div className="h-3 w-28 rounded bg-[var(--subtle)]" />
                  <div className="ml-auto h-3 w-12 rounded bg-[var(--subtle)]" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="aspect-video rounded-[8px] bg-[var(--subtle)]" />
                  <div className="aspect-video rounded-[8px] bg-[var(--subtle)]" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && error && (
          <div className="mt-4 rounded-[10px] border border-[var(--border)] bg-[var(--canvas)] p-4 text-center">
            <p className="text-[12px] font-medium text-[var(--danger)]">{error}</p>
            <p className="mt-1 text-[11px] leading-4 text-[var(--text-2)]">
              Check your connection and try loading the layouts again.
            </p>
            <button
              type="button"
              onClick={() => setLoadAttempt((current) => current + 1)}
              className="mt-3 rounded-[7px] bg-[var(--canvas)] px-3 py-1.5 text-[11px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FDA29B]/50"
            >
              Try again
            </button>
          </div>
        )}
        {!loading && !error && visibleBlocks.length === 0 && (
          <div className="mt-4 rounded-[10px] border border-dashed border-[var(--border-strong)] bg-[var(--canvas)] px-4 py-8 text-center">
            <Search className="mx-auto h-5 w-5 text-[var(--text-3)]" strokeWidth={1.7} aria-hidden />
            <p className="mt-2 text-[12px] font-medium text-[var(--text-2)]">
              {searchActive ? "No matching blocks" : "No blocks available"}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-[var(--text-3)]">
              {searchActive
                ? "Try a different title or keyword."
                : "This template does not include reusable blocks."}
            </p>
            {searchActive ? (
              <button
                type="button"
                onClick={() => setBlockPrompt("")}
                className="mt-3 rounded-[7px] bg-[var(--accent-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--text)] transition-colors hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
              >
                Clear search
              </button>
            ) : null}
          </div>
        )}
        {!loading &&
          !error &&
          visibleBlocks.map((group) => (
            <BlockGroupCard
              key={`${group.key}:${searchActive ? "search" : "browse"}`}
              defaultExpanded
              disabled={disabled}
              group={group}
              onInsertBlock={onInsertBlock}
              searchActive={searchActive}
            />
          ))}
      </div>
    </div>
  );
};

function PrimaryActionButton({
  active,
  disabled = false,
  disabledReason,
  iconSrc,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  disabledReason?: string;
  iconSrc: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      aria-label={disabled && disabledReason ? `${label}: ${disabledReason}` : label}
      className={cn(
        "flex h-12 w-full flex-col items-center justify-center gap-1",
        disabled && "cursor-not-allowed opacity-40",
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      <span
        className={`flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-transparent ${
          active ? "border-[var(--border)] bg-[var(--surface)]" : ""
        }`}
        style={{
          boxShadow: active ? "0 6.6px 13.2px 0 rgba(89, 108, 93, 0.14)" : "",
        }}
      >
        <img
          alt=""
          aria-hidden="true"
          className={label === "AI" ? "h-[18px] w-[18.643px]" : "h-[14px] w-[14px]"}
          src={iconSrc}
        />
      </span>
      <span className="text-[12px] font-normal leading-normal text-[var(--text)]">
        {label}
      </span>
    </button>
  );
}

function ActionsSidebar({
  activeAction,
  aiOnly = false,
  blocksUnavailable = false,
  onActionSelect,
}: {
  activeAction: ActionId;
  aiOnly?: boolean;
  blocksUnavailable?: boolean;
  onActionSelect: (action: ActionId) => void;
}) {
  return (
    <aside
      aria-label="Editor tools"
      className="ml-auto flex h-full w-[70px] shrink-0 flex-col items-center gap-5 overflow-y-auto bg-[var(--surface)] py-3.5 hide-scrollbar"
    >
      {aiOnly && (
        <PrimaryActionButton
          active={activeAction === "ai"}
          iconSrc={actionIconSrc.ai}
          label="AI"
          onClick={() => onActionSelect("ai")}
        />
      )}

      {!aiOnly && (
        <>
          <nav className="flex w-full flex-col items-center gap-6">
            {insertActions.map((item) => (
              <React.Fragment key={item.id}>
                <NavButton
                  item={item}
                  active={activeAction === item.id}
                  disabled={item.id === "blocks" && blocksUnavailable}
                  onClick={() => onActionSelect(item.id)}
                />
                {item.id === "blocks" && (
                  <div className="h-0 w-[30px] shrink-0 border-t border-[var(--border)]" />
                )}
              </React.Fragment>
            ))}
          </nav>
        </>
      )}
    </aside>
  );
}

function ActionsPanel({
  activeAction,
  aiOnly = false,
  blocksUnavailable = false,
  chatProps,
  editingDisabled = false,
  onBlockSelect,
  onChartItemSelect,
  onInfographicItemSelect,
  onElementItemSelect,
  onImageItemSelect,
  onTableItemSelect,
  onTextItemSelect,
  presentationData,
  presentationId,
  templateTheme,
}: {
  activeAction: ActionId;
  aiOnly?: boolean;
  blocksUnavailable?: boolean;
  chatProps: Omit<
    PresentationActionsProps,
    | "editingDisabled"
    | "presentationData"
    | "panelOpen"
    | "onPanelOpenChange"
  >;
  editingDisabled?: boolean;
  onBlockSelect: (block: TemplateBlock) => void;
  onChartItemSelect: (item: PaletteItem) => void;
  onInfographicItemSelect: (item: PaletteItem) => void;
  onElementItemSelect: (item: PaletteItem) => void;
  onImageItemSelect: (item: PaletteItem) => void;
  onTableItemSelect: (item: PaletteItem) => void;
  onTextItemSelect: (item: PaletteItem) => void;
  presentationData?: unknown;
  presentationId: string;
  templateTheme: TemplateTheme;
}) {
  const galleryPreviewTheme = useMemo(
    () =>
      hasExplicitThemeBackground(presentationData)
        ? templateTheme
        : { ...templateTheme, background: "var(--canvas)" },
    [presentationData, templateTheme],
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[var(--surface)]">
      <div className="min-h-0 flex-1">
        <div className={cn("h-full", activeAction === "ai" ? "block" : "hidden")}>
          <Chat {...chatProps} presentationData={presentationData} inputDisabled={editingDisabled} />
        </div>

        {!blocksUnavailable &&
          !aiOnly &&
          activeAction === "blocks" && (
          <BlocksPanel
            disabled={editingDisabled}
            presentationId={presentationId}
            presentationData={presentationData}
            onInsertBlock={onBlockSelect}
          />
        )}
        {!aiOnly && activeAction === "texts" && (
          <TextsPanel
            disabled={editingDisabled}
            onItemSelect={onTextItemSelect}
            theme={galleryPreviewTheme}
          />
        )}
        {!aiOnly && activeAction === "charts" && (
          <ChartsPanel
            disabled={editingDisabled}
            onItemSelect={onChartItemSelect}
            theme={galleryPreviewTheme}
          />
        )}
        {!aiOnly && activeAction === "infograph" && (
          <InfographicsPanel
            disabled={editingDisabled}
            onItemSelect={onInfographicItemSelect}
            theme={galleryPreviewTheme}
          />
        )}
        {!aiOnly && activeAction === "tables" && (
          <InsertPanel
            disabled={editingDisabled}
            title="Tables"
            groups={[{ label: "Table Type", items: tableTypeItems }]}
            onItemSelect={onTableItemSelect}
            previewKind="table"
            theme={templateTheme}
          />
        )}
        {!aiOnly && activeAction === "images" && (
          <ImagesPanel
            disabled={editingDisabled}
            onItemSelect={onImageItemSelect}
            theme={templateTheme}
          />
        )}
        {!aiOnly && activeAction === "shapes" && (
          <ShapesPanel
            disabled={editingDisabled}
            onItemSelect={onElementItemSelect}
            theme={templateTheme}
          />
        )}
      </div>
    </div>
  );
}

function templateV2TargetKey(
  slideIndex: number | null | undefined,
  target: TemplateV2SurfaceSelectedDetail["selection"],
) {
  if (target?.kind === "element") {
    return `slide:${slideIndex ?? ""}:element:${
      target.elementPath ?? target.componentIndex ?? ""
    }`;
  }
  if (target?.kind === "component") {
    return `slide:${slideIndex ?? ""}:component:${
      target.componentId ?? target.componentIndex ?? ""
    }`;
  }
  if (target?.kind === "multi-component") {
    return `slide:${slideIndex ?? ""}:multi:${target.components
      .map((component) => component.componentId ?? component.componentIndex ?? "")
      .join(".")}`;
  }
  return null;
}

const PresentationActions = (props: PresentationActionsProps) => {
  const {
    editingDisabled = false,
    presentationData,
    panelOpen = true,
    onPanelOpenChange = () => undefined,
    ...chatProps
  } = props;
  const aiOnly = props.presentationType === "smart";
  const blocksUnavailable = isTemplateFreePresentation(presentationData);
  const templateTheme = useMemo(
    () => resolvePresentationTheme(presentationData),
    [presentationData],
  );
  const [{ activeAction }, dispatchUiState] = useReducer(
    presentationActionsUiReducer,
    initialPresentationActionsUiState,
  );
  const nextBlankPromptId = useRef(0);
  const [blankSlidePromptRequest, setBlankSlidePromptRequest] =
    useState<BlankSlidePromptRequest | null>(null);

  useEffect(() => {
    if (props.variant !== "template-v2" || aiOnly) return;

    const handleBlankSlidePrompt = (event: Event) => {
      const detail = (event as CustomEvent<BlankSlidePromptEventDetail>).detail;
      if (typeof detail?.prompt !== "string" || !detail.prompt.trim()) return;

      nextBlankPromptId.current += 1;
      setBlankSlidePromptRequest({ id: nextBlankPromptId.current, detail });
      dispatchUiState({ type: "selectAction", activeAction: "ai" });
      onPanelOpenChange(true);
    };

    window.addEventListener(PRESENTON_BLANK_SLIDE_PROMPT_EVENT, handleBlankSlidePrompt);
    return () =>
      window.removeEventListener(PRESENTON_BLANK_SLIDE_PROMPT_EVENT, handleBlankSlidePrompt);
  }, [aiOnly, onPanelOpenChange, props.variant]);

  useEffect(() => {
    setBlankSlidePromptRequest(null);
  }, [props.presentationId]);

  const handleBlankSlidePromptConsumed = useCallback((id: number) => {
    setBlankSlidePromptRequest((current) => current?.id === id ? null : current);
  }, []);
  const [templateV2SelectionContext, setTemplateV2SelectionContext] = useState<{
    slideIndex: number | null;
    target: TemplateV2SurfaceSelectedDetail["selection"];
  }>({ slideIndex: null, target: null });
  const activeTemplateV2Target =
    templateV2SelectionContext.slideIndex === null ||
    typeof props.currentSlide !== "number" ||
    templateV2SelectionContext.slideIndex === props.currentSlide
      ? templateV2SelectionContext.target
      : null;
  const [hiddenSlideReference, setHiddenSlideReference] = useState<number | null>(
    null,
  );
  const [hiddenTargetReferenceKey, setHiddenTargetReferenceKey] = useState<
    string | null
  >(null);
  const targetReferenceKey = templateV2TargetKey(
    props.currentSlide,
    activeTemplateV2Target,
  );
  const selectedTemplateV2Target =
    targetReferenceKey && targetReferenceKey !== hiddenTargetReferenceKey
      ? activeTemplateV2Target
      : null;
  const chatSlide =
    typeof chatProps.currentSlide === "number" &&
    chatProps.currentSlide === hiddenSlideReference
      ? undefined
      : chatProps.currentSlide;

  useEffect(() => {
    if (
      (aiOnly || (blocksUnavailable && activeAction === "blocks")) &&
      activeAction !== "ai"
    ) {
      dispatchUiState({ type: "selectAction", activeAction: "ai" });
    }
  }, [activeAction, aiOnly, blocksUnavailable]);

  useEffect(() => {
    setHiddenSlideReference(null);
    setHiddenTargetReferenceKey(null);
  }, [props.currentSlide]);

  useEffect(() => {
    const handleSurfaceSelected = (event: Event) => {
      const detail = (event as CustomEvent<TemplateV2SurfaceSelectedDetail>).detail;
      const nextSelection = detail?.selection ?? null;
      if (nextSelection) {
        setHiddenTargetReferenceKey(null);
      }
      setTemplateV2SelectionContext({
        slideIndex:
          typeof detail?.slideIndex === "number" ? detail.slideIndex : null,
        target: nextSelection,
      });
    };

    window.addEventListener(
      TEMPLATE_V2_SURFACE_SELECTED_EVENT,
      handleSurfaceSelected,
    );
    return () => {
      window.removeEventListener(
        TEMPLATE_V2_SURFACE_SELECTED_EVENT,
        handleSurfaceSelected,
      );
    };
  }, []);

  const insertEditorContent = (
    content: EditorInsertContent,
    label: string,
  ): boolean => {
    if (editingDisabled) return false;
    if (typeof window === "undefined") return false;
    if (typeof props.currentSlide !== "number") {
      notify.warning("Select a slide", "Choose a slide before adding content.");
      return false;
    }
    if (
      (content.elements?.length ?? 0) === 0 &&
      (content.components?.length ?? 0) === 0
    ) {
      return false;
    }

    const detail: TemplateV2InsertElementsDetail = {
      ...content,
      label,
      slideIndex: props.currentSlide,
    };

    window.dispatchEvent(
      new CustomEvent(TEMPLATE_V2_INSERT_ELEMENTS_EVENT, { detail }),
    );

    if (!detail.handled) {
      notify.warning(
        "Insert unavailable",
        "Content can be added only to slides imported through the slide editor.",
      );
      return false;
    }

    window.requestAnimationFrame(() => {
      document.getElementById(`slide-${props.currentSlide}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    return true;
  };

  const insertEditorElements = (elements: SlideElement[], label: string) => {
    return insertEditorContent({ elements }, label);
  };

  const handleTextItemSelect = (item: PaletteItem) => {
    if (
      insertEditorElements(
        createTextInsertElements(item.id, templateTheme),
        item.label,
      )
    ) {
      trackEvent(MixpanelEvent.Editor_Insert_Palette_Item_Selected, {
        presentation_id: props.presentationId,
        category: "texts",
        item_id: item.id,
        item_label: item.label,
        slide_index: props.currentSlide,
      });
    }
  };

  const handleChartItemSelect = (item: PaletteItem) => {
    const chartElements = createChartInsertElements(item.id, templateTheme);
    if (insertEditorElements(chartElements, item.label)) {
      trackEvent(MixpanelEvent.Editor_Insert_Palette_Item_Selected, {
        presentation_id: props.presentationId,
        category: "charts",
        item_id: item.id,
        item_label: item.label,
        slide_index: props.currentSlide,
      });
    }
  };

  const handleInfographicItemSelect = (item: PaletteItem) => {
    const infographicElements = createInfographicInsertElements(
      item.id,
      templateTheme,
    );
    if (insertEditorElements(infographicElements, item.label)) {
      trackEvent(MixpanelEvent.Editor_Insert_Palette_Item_Selected, {
        presentation_id: props.presentationId,
        category: "infographics",
        item_id: item.id,
        item_label: item.label,
        slide_index: props.currentSlide,
      });
    }
  };

  const handleTableItemSelect = (item: PaletteItem) => {
    if (
      insertEditorElements(
        createTableInsertElements(item.id, templateTheme),
        item.label,
      )
    ) {
      trackEvent(MixpanelEvent.Editor_Insert_Palette_Item_Selected, {
        presentation_id: props.presentationId,
        category: "tables",
        item_id: item.id,
        item_label: item.label,
        slide_index: props.currentSlide,
      });
    }
  };

  const handleImageItemSelect = (item: PaletteItem) => {
    if (
      insertEditorContent(
        createImageInsertContent(item.id, templateTheme),
        item.label,
      )
    ) {
      trackEvent(MixpanelEvent.Editor_Insert_Palette_Item_Selected, {
        presentation_id: props.presentationId,
        category: "images",
        item_id: item.id,
        item_label: item.label,
        slide_index: props.currentSlide,
      });
    }
  };

  const handleElementItemSelect = (item: PaletteItem) => {
    if (
      insertEditorElements(
        createElementInsertElements(item.id, templateTheme),
        item.label,
      )
    ) {
      trackEvent(MixpanelEvent.Editor_Insert_Palette_Item_Selected, {
        presentation_id: props.presentationId,
        category: "elements",
        item_id: item.id,
        item_label: item.label,
        slide_index: props.currentSlide,
      });
    }
  };

  const handleBlockSelect = (block: TemplateBlock) => {
    if (blocksUnavailable) return;

    if (
      isRecord(block.raw) &&
      hasUsableComponentSize(block.raw) &&
      readRecordArray(block.raw, "elements").length > 0
    ) {
      const inserted = insertEditorContent(
        { components: [block.raw as TemplateV2InsertComponent] },
        block.title,
      );
      if (inserted) {
        trackEvent(MixpanelEvent.Editor_Template_Block_Inserted, {
          presentation_id: props.presentationId,
          block_title: block.title,
          block_index: block.index,
          element_count: readRecordArray(block.raw, "elements").length,
          slide_index: props.currentSlide,
        });
      }
      return;
    }

    const element = adaptTemplateV2ComponentToElement(block.raw, block.index);
    if (!element) {
      notify.warning(
        "Component unavailable",
        "This template component cannot be inserted yet.",
      );
      return;
    }

    if (insertEditorElements([element], block.title)) {
      trackEvent(MixpanelEvent.Editor_Template_Block_Inserted, {
        presentation_id: props.presentationId,
        block_title: block.title,
        block_index: block.index,
        element_count: 1,
        slide_index: props.currentSlide,
      });
    }
  };

  const handleActionSelect = (nextAction: ActionId) => {
    if (aiOnly && nextAction !== "ai") {
      return;
    }
    if (blocksUnavailable && nextAction === "blocks") {
      return;
    }

    if (panelOpen && nextAction === activeAction) {
      onPanelOpenChange(false);
      return;
    }

    trackEvent(MixpanelEvent.Editor_Side_Panel_Tab_Selected, {
      presentation_id: props.presentationId,
      tab: nextAction,
      variant: "template-v2",
    });
    dispatchUiState({ type: "selectAction", activeAction: nextAction });
    onPanelOpenChange(true);
  };

  return (
    <div
      data-inline-edit-ignore="true"
      className="flex h-full w-full overflow-hidden bg-[var(--surface)] text-[clamp(12px,0.82vw,14px)]"
    >
      {panelOpen ? (
        <ActionsPanel
          activeAction={activeAction}
          aiOnly={aiOnly}
          blocksUnavailable={blocksUnavailable}
          chatProps={{
            ...chatProps,
            blankSlidePromptRequest,
            onBlankSlidePromptConsumed: handleBlankSlidePromptConsumed,
            currentSlide: chatSlide,
            selectedTemplateV2Target,
            onClearChatSlideReference:
              typeof chatProps.currentSlide === "number"
                ? () => setHiddenSlideReference(chatProps.currentSlide!)
                : undefined,
            onClearChatTargetReference: targetReferenceKey
              ? () => setHiddenTargetReferenceKey(targetReferenceKey)
              : undefined,
          }}
          editingDisabled={editingDisabled}
          onBlockSelect={handleBlockSelect}
          onChartItemSelect={handleChartItemSelect}
          onInfographicItemSelect={handleInfographicItemSelect}
          onElementItemSelect={handleElementItemSelect}
          onImageItemSelect={handleImageItemSelect}
          onTableItemSelect={handleTableItemSelect}
          onTextItemSelect={handleTextItemSelect}
          presentationData={presentationData}
          presentationId={props.presentationId}
          templateTheme={templateTheme}
        />
      ) : null}
      <ActionsSidebar
        activeAction={activeAction}
        aiOnly={aiOnly}
        blocksUnavailable={blocksUnavailable}
        onActionSelect={handleActionSelect}
      />
    </div>
  );
};

export default PresentationActions;
