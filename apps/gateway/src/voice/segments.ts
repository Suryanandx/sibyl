/**
 * Splits a streaming reply into speech segments.
 *
 * The first segment ends at the first clause boundary (",", ".", "?", …) after
 * `minLength` characters, so speech starts on the first clause instead of the
 * first full sentence; a long opening without punctuation is cut at a word
 * boundary after `firstMaxLength`. Later segments take the longest run of
 * whole clauses up to `maxLength` (they are synthesized while the first plays).
 */
export interface SegmentConfig {
  ttsSegmentMinLength: number;
  ttsSegmentMaxLength: number;
}

/** A first segment without punctuation is cut at a word boundary after this many characters. */
export const FIRST_SEGMENT_MAX_LENGTH = 60;
const BOUNDARY = /[.!?。！？；;，,:—]\s*/g;

export function takeReadyTtsSegments(
  text: string,
  config: SegmentConfig,
  first = false
): { segments: string[]; remainder: string } {
  const segments: string[] = [];
  let remainder = text;
  let isFirst = first;

  while (remainder.length >= config.ttsSegmentMinLength) {
    const splitAt = isFirst ? firstSplit(remainder, config) : laterSplit(remainder, config);
    if (splitAt === -1) break;
    const segment = remainder.slice(0, splitAt).trim();
    remainder = remainder.slice(splitAt).trimStart();
    if (segment) {
      segments.push(segment);
      isFirst = false;
    }
  }

  return { segments, remainder };
}

function firstSplit(text: string, config: SegmentConfig): number {
  BOUNDARY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOUNDARY.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    if (boundary >= config.ttsSegmentMinLength && complete(match[0])) return boundary;
  }
  if (text.length >= FIRST_SEGMENT_MAX_LENGTH) {
    const space = text.lastIndexOf(" ", FIRST_SEGMENT_MAX_LENGTH);
    if (space >= config.ttsSegmentMinLength) return space + 1;
  }
  return -1;
}

function laterSplit(text: string, config: SegmentConfig): number {
  const boundary = lastBoundary(text, config);
  if (boundary >= config.ttsSegmentMinLength) return boundary;
  return text.length >= config.ttsSegmentMaxLength ? config.ttsSegmentMaxLength : -1;
}

function lastBoundary(text: string, config: SegmentConfig): number {
  BOUNDARY.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last = -1;
  while ((match = BOUNDARY.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    if (boundary >= config.ttsSegmentMinLength && complete(match[0])) last = boundary;
    if (boundary >= config.ttsSegmentMaxLength) break;
  }
  return last;
}

/**
 * Western punctuation ends a clause only when whitespace follows ("3.5", "e.g." and a
 * boundary at the very end of streamed text are not yet clause ends); full-width CJK
 * punctuation always does.
 */
function complete(match: string): boolean {
  return /\s$/.test(match) || /^[。！？；，]/.test(match);
}
