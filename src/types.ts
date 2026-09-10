/**
 * Plain value types shared by every CodePort layer.
 *
 * These types are intentionally free of any `vscode` dependency so that the whole
 * Markdown -> resolver -> index pipeline stays unit-testable in plain Node.
 */

/** Zero-based line/character pair, identical to the LSP / VS Code convention. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** A location in a file, identified by URI string (never a `vscode.Uri`). */
export interface Location {
  readonly uri: string;
  readonly range: Range;
}

/**
 * Symbol kinds CodePort understands. Deliberately a string union rather than a
 * TypeScript `enum` so the sources stay runnable by Node's type-stripping.
 */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'destructor'
  | 'class'
  | 'struct'
  | 'union'
  | 'enum'
  | 'enumerator'
  | 'typedef'
  | 'type'
  | 'variable'
  | 'field'
  | 'macro'
  | 'namespace'
  | 'interface'
  | 'module'
  | 'unknown';

/** Every kind, useful for validation and for building UI labels. */
export const SYMBOL_KINDS: readonly SymbolKind[] = [
  'function',
  'method',
  'constructor',
  'destructor',
  'class',
  'struct',
  'union',
  'enum',
  'enumerator',
  'typedef',
  'type',
  'variable',
  'field',
  'macro',
  'namespace',
  'interface',
  'module',
  'unknown',
];

/** A symbol as described by an index row or a language server. */
export interface ResolvedSymbol {
  readonly name: string;
  readonly qualifiedName?: string;
  readonly kind?: SymbolKind;
  readonly signature?: string;
  readonly container?: string;
  readonly documentation?: string;
}

/**
 * A symbol mention found in Markdown text.
 *
 * `range` covers the identifier exactly; `codeRange` covers the enclosing code
 * region (inline span or fenced block), which is what link insertion rewrites.
 */
export interface SymbolReference {
  /** Bare symbol name, e.g. `start` for `nx::start`. */
  readonly name: string;
  /** Verbatim source text, e.g. `nx::start`. */
  readonly raw: string;
  /** Qualifier chain without the name, e.g. `nx` for `nx::start`. */
  readonly container?: string;
  /** Language taken from the fence info string, when known. */
  readonly language?: string;
  /** Set when the mention is immediately followed by `(`. */
  readonly called?: boolean;
  readonly kindHint?: SymbolKind;
  readonly range: Range;
  readonly codeRange: Range;
  /** True when the mention lives in an inline code span (vs a fenced block). */
  readonly inline: boolean;
}

/** What a layer decided about the language/project a reference belongs to. */
export interface ResolvedTarget {
  readonly language: string;
  readonly adapterId: string;
  /** Absolute project root, when a project was detected. */
  readonly projectRoot?: string;
  /** Which of the three detection levels produced this answer. */
  readonly source: 'fence' | 'workspace' | 'fallback';
}

/** Convenience: convert a `Range` into a comparable key. */
export function rangeKey(range: Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

/** True when `position` is inside `range` (end is exclusive, matching LSP). */
export function rangeContains(range: Range, position: Position): boolean {
  return (
    comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) < 0
  );
}

export function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}
