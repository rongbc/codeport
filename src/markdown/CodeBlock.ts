/**
 * Fenced code block ("```" / "~~~") detection.
 *
 * Line oriented and dependency free. It follows CommonMark closely enough for
 * CodePort's purpose: a fence is up to three leading spaces, then three or more
 * backticks or tildes, plus an optional info string.
 */

import { normalizeLanguageId } from '../util/language.ts';

export interface FencedBlock {
  /** Normalised language from the info string (`c++` -> `cpp`), when present. */
  readonly language?: string;
  /** Raw info string, verbatim. */
  readonly info: string;
  readonly fenceChar: '`' | '~';
  readonly fenceLength: number;
  /** Line index of the opening fence. */
  readonly openLine: number;
  /** Line index of the closing fence; `undefined` when the fence never closes. */
  readonly closeLine?: number;
  /** First content line (inclusive). */
  readonly contentStartLine: number;
  /** Last content line (inclusive). `contentEndLine < contentStartLine` means empty. */
  readonly contentEndLine: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Normalise a fence info string's first word into a CodePort language id. */
export function normalizeLanguage(info: string): string | undefined {
  return normalizeLanguageId(info);
}


interface FenceMatch {
  char: '`' | '~';
  length: number;
  info: string;
}

function matchFence(line: string): FenceMatch | undefined {
  const m = FENCE_RE.exec(line);
  if (!m) return undefined;
  const run = m[1]!;
  const info = m[2] ?? '';
  const char = run[0] as '`' | '~';
  // A backtick fence's info string may not contain a backtick.
  if (char === '`' && info.includes('`')) return undefined;
  return { char, length: run.length, info };
}

/** Find every fenced code block in a list of lines. */
export function findFencedBlocks(lines: readonly string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = matchFence(lines[i]!);
    if (!open) {
      i++;
      continue;
    }
    const openLine = i;
    let closeLine: number | undefined;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const candidate = matchFence(lines[j]!);
      if (candidate && candidate.char === open.char && candidate.length >= open.length) {
        closeLine = j;
        break;
      }
    }
    const contentStartLine = openLine + 1;
    const contentEndLine = closeLine === undefined ? lines.length - 1 : closeLine - 1;
    blocks.push({
      language: normalizeLanguage(open.info),
      info: open.info.trim(),
      fenceChar: open.char,
      fenceLength: open.length,
      openLine,
      closeLine,
      contentStartLine,
      contentEndLine,
    });
    i = closeLine === undefined ? lines.length : closeLine + 1;
  }
  return blocks;
}

/** True when the line is a fence delimiter for one of the given blocks. */
export function isFenceDelimiter(line: number, block: FencedBlock): boolean {
  return line === block.openLine || line === block.closeLine;
}
