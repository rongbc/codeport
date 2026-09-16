/**
 * Markdown symbol parser (plan section 6).
 *
 * Walks a Markdown document and emits `SymbolReference`s for every identifier
 * that appears inside a fenced code block or an inline code span. Prose is never
 * touched, and file/path mentions such as `src/main.c:42` are skipped so they
 * stay owned by the code-link provider.
 *
 * The parser is deliberately free of any language knowledge: it reports fences'
 * language hints and leaves interpretation to the adapter layer.
 */

import { findFencedBlocks, type FencedBlock } from './CodeBlock.ts';
import { findInlineCodeSpans } from './CodeSpan.ts';
import { lineOffsets, rangeFromOffsets, splitLines, isKeyword } from '../util/text.ts';
import { rangeContains, type Position, type Range, type SymbolReference } from '../types.ts';

export interface ParsedMarkdown {
  readonly text: string;
  readonly lines: readonly string[];
  readonly offsets: readonly number[];
  readonly blocks: readonly FencedBlock[];
  readonly references: readonly SymbolReference[];
}

/** Path/file mentions (`src/main.c`, `/abs/a.h:12`) that must not become symbols. */
const FILE_REF_RE =
  /[A-Za-z0-9_][A-Za-z0-9_.+/-]*\.(?:[ch]|cc|cpp|cxx|hpp|hh|S|asm)(?::\d+)?/g;
/** URLs, so `https://example.com/foo.c` is not mined for identifiers. */
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s)`>"']*/gi;
/** A (possibly qualified) C-like identifier: `name`, `a::b::c`. */
const QUALIFIED_IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/g;

interface SkipRange {
  readonly start: number;
  readonly end: number;
}

/** Collect ranges that must never be mined for symbol names. */
function collectSkipRanges(chunk: string, base: number): SkipRange[] {
  const ranges: SkipRange[] = [];
  for (const re of [FILE_REF_RE, URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk)) !== null) {
      ranges.push({ start: base + m.index, end: base + m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return ranges;
}

function overlapsAny(ranges: readonly SkipRange[], start: number, end: number): boolean {
  for (const r of ranges) {
    if (start < r.end && end > r.start) return true;
  }
  return false;
}

/** `SOME_MACRO` style names are surfaced as a macro hint. */
function looksLikeMacro(name: string): boolean {
  return name.length >= 3 && /^[A-Z][A-Z0-9_]*$/.test(name);
}

interface ExtractionContext {
  readonly text: string;
  readonly offsets: readonly number[];
  readonly language?: string;
  readonly inline: boolean;
  readonly codeRange: Range;
}

/**
 * Extract symbol references from a code chunk.
 * `base` is the chunk's absolute offset inside the document.
 */
function extractFromChunk(
  chunk: string,
  base: number,
  ctx: ExtractionContext,
  out: SymbolReference[]
): void {
  const skipRanges = collectSkipRanges(chunk, base);

  QUALIFIED_IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUALIFIED_IDENT_RE.exec(chunk)) !== null) {
    const raw = m[0];
    const absStart = base + m.index;
    const absEnd = absStart + raw.length;
    if (overlapsAny(skipRanges, absStart, absEnd)) continue;

    const segments = raw.split('::');
    const name = segments[segments.length - 1]!;
    if (!name || isKeyword(name)) continue;

    const container = segments.length > 1 ? segments.slice(0, -1).join('::') : undefined;

    // A trailing `(` marks a call / function-like mention.
    let probe = absEnd;
    while (probe < ctx.text.length && (ctx.text[probe] === ' ' || ctx.text[probe] === '\t')) {
      probe++;
    }
    const called = ctx.text[probe] === '(';

    const range = rangeFromOffsets(ctx.offsets, absStart, absEnd);
    out.push({
      name,
      raw,
      container,
      language: ctx.language,
      called,
      kindHint: called ? 'function' : looksLikeMacro(name) ? 'macro' : undefined,
      range,
      codeRange: ctx.codeRange,
      inline: ctx.inline,
    });
  }
}

export class MarkdownParser {
  /** Parse a document into code regions and symbol references. */
  parse(text: string): ParsedMarkdown {
    const lines = splitLines(text);
    const offsets = lineOffsets(text);
    const blocks = findFencedBlocks(lines);
    const references: SymbolReference[] = [];

    // Map each line to the block that owns it, so fence content is parsed once.
    const lineOwner = new Map<number, FencedBlock>();
    for (const block of blocks) {
      for (let line = block.contentStartLine; line <= block.contentEndLine; line++) {
        lineOwner.set(line, block);
      }
    }

    for (let line = 0; line < lines.length; line++) {
      const lineText = lines[line]!;
      const lineStart = offsets[line]!;
      const block = lineOwner.get(line);

      if (block) {
        const codeRange = blockRange(text, offsets, block);
        extractFromChunk(
          lineText,
          lineStart,
          {
            text,
            offsets,
            language: block.language,
            inline: false,
            codeRange,
          },
          references
        );
        continue;
      }

      // Fence delimiter lines themselves carry no code.
      if (blocks.some((b) => b.openLine === line || b.closeLine === line)) continue;

      for (const span of findInlineCodeSpans(lineText)) {
        if (span.end <= span.start) continue;
        // `codeRange` spans the delimiters too: for an inline span it is exactly
        // the text that has to be replaced when a source link is inserted.
        const codeRange = rangeFromOffsets(
          offsets,
          lineStart + span.openStart,
          lineStart + span.closeEnd
        );
        extractFromChunk(
          lineText.slice(span.start, span.end),
          lineStart + span.start,
          {
            text,
            offsets,
            inline: true,
            codeRange,
          },
          references
        );
      }
    }

    return { text, lines, offsets, blocks, references };
  }
}

/** The range covering a fenced block's content (collapsed when empty). */
function blockRange(text: string, offsets: readonly number[], block: FencedBlock): Range {
  const startOffset = offsets[block.contentStartLine] ?? text.length;
  const endLine = Math.max(block.contentEndLine, block.contentStartLine);
  const endOffset = Math.min(
    (offsets[endLine + 1] ?? text.length + 1) - 1,
    text.length
  );
  return rangeFromOffsets(offsets, startOffset, Math.max(startOffset, endOffset));
}

/**
 * The reference under (or immediately left of) a cursor position.
 *
 * Cursor-on-`)` or cursor-on-`(` should resolve the identifier next to it, which
 * is what the original md-code-links extension did and what users expect.
 */
export function symbolAt(
  parsed: ParsedMarkdown,
  position: Position
): SymbolReference | undefined {
  let best: SymbolReference | undefined;
  for (const ref of parsed.references) {
    if (rangeContains(ref.range, position)) return ref;
    if (ref.range.start.line === position.line && ref.range.end.character <= position.character) {
      const gap = position.character - ref.range.end.character;
      if (gap <= 1 && (!best || ref.range.end.character > best.range.end.character)) {
        best = ref;
      }
    }
  }
  return best;
}

/**
 * Small cache so a DefinitionProvider request does not re-parse the document.
 * Keyed by document URI + VS Code version counter.
 */
export class MarkdownParserCache {
  private readonly entries = new Map<string, { key: string; parsed: ParsedMarkdown }>();
  private readonly parser = new MarkdownParser();
  private readonly maxEntries: number;

  constructor(maxEntries = 32) {
    this.maxEntries = maxEntries;
  }

  get(uri: string, version: number, text: string): ParsedMarkdown {
    // The document version alone is not a safe key: it can be reused after a
    // close/reopen, and callers may synthesise documents. Length is free to
    // compute and makes a stale hit impossible in practice.
    const key = `${version}:${text.length}`;
    const cached = this.entries.get(uri);
    if (cached && cached.key === key) return cached.parsed;
    const parsed = this.parser.parse(text);
    this.entries.delete(uri);
    this.entries.set(uri, { key, parsed });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return parsed;
  }

  invalidate(uri: string): void {
    this.entries.delete(uri);
  }

  clear(): void {
    this.entries.clear();
  }
}
