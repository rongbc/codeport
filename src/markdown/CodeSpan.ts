/**
 * Inline code span (single backtick run) detection within one line.
 *
 * Follows the CommonMark rule that a span is delimited by two backtick runs of
 * equal length, so `` ``a`b`` `` is one span containing ``a`b``.
 */

export interface InlineCodeSpan {
  /** Offset of the first content character (after the opening run). */
  readonly start: number;
  /** Offset one past the last content character (before the closing run). */
  readonly end: number;
  /** Offset of the first opening backtick. */
  readonly openStart: number;
  /** Offset one past the last closing backtick. */
  readonly closeEnd: number;
}

/** All inline code spans in a single line, left to right. */
export function findInlineCodeSpans(lineText: string): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = [];
  const n = lineText.length;
  let i = 0;

  while (i < n) {
    if (lineText[i] !== '`') {
      i++;
      continue;
    }
    const openStart = i;
    // Measure the opening run.
    let openEnd = i;
    while (openEnd < n && lineText[openEnd] === '`') openEnd++;
    const runLength = openEnd - openStart;

    // Find the next run of exactly the same length.
    let cursor = openEnd;
    let closeStart = -1;
    let closeEnd = -1;
    while (cursor < n) {
      if (lineText[cursor] !== '`') {
        cursor++;
        continue;
      }
      let runEnd = cursor;
      while (runEnd < n && lineText[runEnd] === '`') runEnd++;
      if (runEnd - cursor === runLength) {
        closeStart = cursor;
        closeEnd = runEnd;
        break;
      }
      cursor = runEnd;
    }

    if (closeStart < 0) {
      // Unterminated run: nothing after it can be code, so stop scanning.
      break;
    }
    spans.push({ start: openEnd, end: closeStart, openStart, closeEnd });
    i = closeEnd;
  }

  return spans;
}
