import type {
  Font,
  LatexTextRun,
  TextElement,
  TextRun,
} from "@/components/slide-editor/types";

export type TextSelectionRange = {
  start: number;
  end: number;
};

export function isLatexTextRun(run: unknown): run is LatexTextRun {
  return Boolean(
    run &&
      typeof run === "object" &&
      (run as { type?: unknown }).type === "latex" &&
      typeof (run as { latex?: unknown }).latex === "string",
  );
}

export function textRunContent(run: TextRun) {
  return isLatexTextRun(run) ? run.latex : run.text;
}

export function textRunsContent(runs: TextRun[]) {
  return runs.map(textRunContent).join("");
}

export function normalizedTextSelectionRange(
  range: TextSelectionRange | null | undefined,
  textLength: number,
) {
  if (!range) return null;
  const start = clamp(Math.min(range.start, range.end), 0, textLength);
  const end = clamp(Math.max(range.start, range.end), 0, textLength);
  return end > start ? { start, end } : null;
}

export function fontForTextSelection(
  element: Pick<TextElement, "font" | "runs">,
  range: TextSelectionRange | null | undefined,
) {
  const textLength = textRunsContent(element.runs).length;
  const normalized = normalizedTextSelectionRange(range, textLength);
  const targetOffset = normalized?.start ?? 0;
  let offset = 0;

  for (const run of element.runs) {
    const nextOffset = offset + textRunContent(run).length;
    if (targetOffset >= offset && targetOffset <= nextOffset) {
      return { ...(element.font ?? {}), ...(run.font ?? {}) } satisfies Font;
    }
    offset = nextOffset;
  }

  return element.runs[0]?.font
    ? ({ ...(element.font ?? {}), ...element.runs[0].font } satisfies Font)
    : element.font;
}

export function applyTextRunFontToSelection<T extends Pick<TextElement, "font" | "runs">>(
  element: T,
  range: TextSelectionRange | null | undefined,
  fontPatch: Partial<Font>,
) {
  const textLength = textRunsContent(element.runs).length;
  const normalized = normalizedTextSelectionRange(range, textLength);
  if (!normalized) return element;

  const patch = cleanFontPatch(fontPatch);
  const nextRuns: TextRun[] = [];
  let offset = 0;

  for (const run of element.runs) {
    const runText = textRunContent(run);
    const runStart = offset;
    const runEnd = offset + runText.length;
    const overlapStart = Math.max(runStart, normalized.start);
    const overlapEnd = Math.min(runEnd, normalized.end);

    if (overlapStart >= overlapEnd) {
      nextRuns.push(run);
      offset = runEnd;
      continue;
    }

    if (isLatexTextRun(run)) {
      nextRuns.push({
        ...run,
        font: { ...(run.font ?? element.font ?? {}), ...patch },
      });
      offset = runEnd;
      continue;
    }

    const before = runText.slice(0, overlapStart - runStart);
    const selected = runText.slice(overlapStart - runStart, overlapEnd - runStart);
    const after = runText.slice(overlapEnd - runStart);
    const runFont = run.font ?? element.font ?? undefined;

    if (before) nextRuns.push({ ...run, text: before });
    if (selected) {
      nextRuns.push({
        ...run,
        text: selected,
        font: {
          ...(runFont ?? {}),
          ...patch,
        },
      });
    }
    if (after) nextRuns.push({ ...run, text: after });

    offset = runEnd;
  }

  return {
    ...element,
    runs: mergeAdjacentTextRuns(nextRuns),
  };
}

export function textSelectionContainsLatex(
  runs: TextRun[],
  range: TextSelectionRange | null | undefined,
) {
  const normalized = normalizedTextSelectionRange(
    range,
    textRunsContent(runs).length,
  );
  if (!normalized) return false;

  let offset = 0;
  return runs.some((run) => {
    const nextOffset = offset + textRunContent(run).length;
    const overlaps = offset < normalized.end && nextOffset > normalized.start;
    offset = nextOffset;
    return overlaps && isLatexTextRun(run);
  });
}

export function latexTextRunRangeAtCursor(
  runs: TextRun[],
  cursorOffset: number | null | undefined,
): TextSelectionRange | null {
  if (cursorOffset == null || !Number.isFinite(cursorOffset)) return null;
  const cursor = clamp(cursorOffset, 0, textRunsContent(runs).length);
  let offset = 0;

  for (const run of runs) {
    const nextOffset = offset + textRunContent(run).length;
    if (
      isLatexTextRun(run) &&
      cursor >= offset &&
      cursor <= nextOffset
    ) {
      return { start: offset, end: nextOffset };
    }
    offset = nextOffset;
  }

  return null;
}

export function toggleTextRunLatexForSelection<
  T extends Pick<TextElement, "font" | "runs">,
>(element: T, range: TextSelectionRange | null | undefined): T {
  const normalized = normalizedTextSelectionRange(
    range,
    textRunsContent(element.runs).length,
  );
  if (!normalized) return element;

  const convertToLatex = !textSelectionContainsLatex(
    element.runs,
    normalized,
  );
  const nextRuns: TextRun[] = [];
  let offset = 0;

  for (const run of element.runs) {
    const content = textRunContent(run);
    const runStart = offset;
    const runEnd = runStart + content.length;
    const overlapStart = Math.max(runStart, normalized.start);
    const overlapEnd = Math.min(runEnd, normalized.end);
    offset = runEnd;

    if (overlapStart >= overlapEnd) {
      nextRuns.push(run);
      continue;
    }

    if (isLatexTextRun(run)) {
      nextRuns.push(
        convertToLatex
          ? run
          : { text: run.latex, font: run.font ?? element.font },
      );
      continue;
    }

    const before = run.text.slice(0, overlapStart - runStart);
    const selected = run.text.slice(
      overlapStart - runStart,
      overlapEnd - runStart,
    );
    const after = run.text.slice(overlapEnd - runStart);
    if (before) nextRuns.push({ ...run, text: before });
    if (selected) {
      nextRuns.push(
        convertToLatex
          ? {
              type: "latex",
              latex: selected,
              display_mode: false,
              font: run.font ?? element.font,
            }
          : { ...run, text: selected },
      );
    }
    if (after) nextRuns.push({ ...run, text: after });
  }

  return {
    ...element,
    runs: mergeAdjacentTextRuns(nextRuns),
  };
}

export function replaceTextRunsContent(
  runs: TextRun[],
  text: string,
  fallbackFont?: Font | null,
) {
  const nextText = text || " ";
  if (runs.length === 0) {
    return [
      fallbackFont ? { text: nextText, font: fallbackFont } : { text: nextText },
    ];
  }

  const nextRuns: TextRun[] = [];
  let offset = 0;
  let lastFont = runs[0]?.font ?? fallbackFont ?? undefined;

  for (const run of runs) {
    if (offset >= nextText.length) break;
    const runLength = Math.max(1, textRunContent(run).length);
    const textSlice = nextText.slice(offset, offset + runLength);
    if (textSlice) {
      lastFont = run.font ?? lastFont;
      nextRuns.push({
        text: textSlice,
        font: run.font ?? fallbackFont ?? undefined,
      });
    }
    offset += runLength;
  }

  if (offset < nextText.length) {
    const sourceRun = runs[runs.length - 1];
    nextRuns.push({
      text: nextText.slice(offset),
      font: sourceRun?.font ?? lastFont,
    });
  }

  return mergeAdjacentTextRuns(nextRuns);
}

export function mergeAdjacentTextRuns(runs: TextRun[]) {
  const merged: TextRun[] = [];
  for (const run of runs) {
    if (isLatexTextRun(run)) {
      if (run.latex) {
        merged.push({
          ...run,
          ...(run.font ? { font: { ...run.font } } : {}),
        });
      }
      continue;
    }
    if (!run.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && !isLatexTextRun(previous) && sameFont(previous.font, run.font)) {
      previous.text += run.text;
      continue;
    }
    merged.push({
      ...run,
      ...(run.font ? { font: { ...run.font } } : {}),
    });
  }
  return merged.length > 0 ? merged : [{ text: " " }];
}

function cleanFontPatch(font: Partial<Font>) {
  return Object.fromEntries(
    Object.entries(font).filter(([, value]) => value !== undefined),
  ) as Partial<Font>;
}

function sameFont(left: TextRun["font"], right: TextRun["font"]) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
