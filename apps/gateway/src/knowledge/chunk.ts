/**
 * Split extracted text into ~800-token chunks with a small overlap, keeping
 * the nearest Markdown heading and the part marker written by the upload
 * extractor ("--- Page 3 ---", "--- Slide 2 ---", "--- Sheet: Q3 ---",
 * "--- Chapter 4 ---", "--- File: notes/a.md ---") as each chunk's citation label.
 *
 * Tokens are estimated at 4 characters each (good enough for English prose;
 * no tokenizer dependency).
 */

export interface TextChunk {
  text: string;
  label?: string;
}

export interface ChunkOptions {
  /** Target size in tokens (default 800). */
  maxTokens?: number;
  /** Overlap in tokens carried into the next chunk (default 100). */
  overlapTokens?: number;
  /** Hard cap on the number of chunks (default 5000). */
  maxChunks?: number;
}

const CHARS_PER_TOKEN = 4;
const PART_MARKER = /^--- ((?:Page|Slide|Chapter) \d+|(?:Sheet|File): .{1,200}) ---$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

interface Block {
  text: string;
  /** "Page 3", "Slide 2", "Sheet: Q3", … */
  page?: string;
  heading?: string;
}

export function chunkText(input: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = Math.max(200, (options.maxTokens ?? 800) * CHARS_PER_TOKEN);
  const overlapChars = Math.max(0, Math.min(maxChars / 2, (options.overlapTokens ?? 100) * CHARS_PER_TOKEN));
  const maxChunks = options.maxChunks ?? 5000;
  const blocks = toBlocks(input.replace(/\r\n?/g, "\n"), maxChars);

  const chunks: TextChunk[] = [];
  let current: Block[] = [];
  let size = 0;
  /** How many blocks at the start of `current` are overlap carried from the last chunk. */
  let carriedCount = 0;
  const flush = (): void => {
    const text = current.map((block) => block.text).join("\n\n").trim();
    if (text) chunks.push({ text, ...labelOf(current) });
    // Carry the tail of this chunk (whole blocks, up to the overlap) into the next.
    const carried: Block[] = [];
    let carriedSize = 0;
    for (let index = current.length - 1; index >= 0 && overlapChars > 0; index -= 1) {
      const block = current[index]!;
      if (carriedSize + block.text.length > overlapChars) break;
      carried.unshift(block);
      carriedSize += block.text.length + 2;
    }
    current = carried;
    size = carriedSize;
  };
  for (const block of blocks) {
    if (chunks.length >= maxChunks) break;
    if (size > 0 && size + block.text.length + 2 > maxChars) {
      // Emit what we have unless it is only overlap from the previous chunk.
      if (current.length > carriedCount) flush();
      carriedCount = current.length;
      if (size + block.text.length + 2 > maxChars) {
        current = [];
        size = 0;
        carriedCount = 0;
      }
    }
    current.push(block);
    size += block.text.length + 2;
  }
  // The rest, unless it is only overlap already emitted.
  if (chunks.length < maxChunks && current.length > carriedCount) {
    const text = current.map((block) => block.text).join("\n\n").trim();
    if (text) chunks.push({ text, ...labelOf(current) });
  }
  return chunks.slice(0, maxChunks);
}

/** Label for a chunk: "Page 3 · Pricing" (first block's part, most specific heading). */
function labelOf(blocks: Block[]): { label?: string } {
  const first = blocks.find((block) => block.text.trim()) ?? blocks[0];
  if (!first) return {};
  const parts = [first.page, first.heading].filter(Boolean);
  return parts.length ? { label: parts.join(" · ").slice(0, 160) } : {};
}

/** Paragraph blocks tagged with their page and heading; oversized paragraphs are split. */
function toBlocks(text: string, maxChars: number): Block[] {
  const blocks: Block[] = [];
  let page: string | undefined;
  let heading: string | undefined;
  let paragraph: string[] = [];
  const push = (): void => {
    const body = paragraph.join("\n").trim();
    paragraph = [];
    if (!body) return;
    for (const piece of splitLong(body, maxChars)) blocks.push({ text: piece, ...(page ? { page } : {}), ...(heading ? { heading } : {}) });
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const pageMatch = PART_MARKER.exec(trimmed);
    if (pageMatch) {
      push();
      page = pageMatch[1];
      continue;
    }
    const headingMatch = HEADING.exec(trimmed);
    if (headingMatch) {
      push();
      heading = headingMatch[2]!.slice(0, 120);
      paragraph.push(trimmed);
      continue;
    }
    if (!trimmed) {
      push();
      continue;
    }
    paragraph.push(line);
  }
  push();
  return blocks;
}

/** Split a paragraph longer than maxChars at sentence, then word boundaries. */
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"), window.lastIndexOf("? "), window.lastIndexOf("! "));
    if (cut < maxChars * 0.5) cut = window.lastIndexOf(" ");
    if (cut < maxChars * 0.3) cut = maxChars - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** Rough token estimate (4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
