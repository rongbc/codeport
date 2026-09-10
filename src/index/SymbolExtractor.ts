/**
 * Symbol extraction abstraction.
 *
 * Keeping extractors behind an interface is what makes the index multi-language
 * ready: `CppExtractor` ships today, `RustExtractor` / `GoExtractor` slot in
 * without touching the store, the indexer or the resolvers.
 */

import type { SymbolKind } from '../types.ts';
import type { SyntaxTree } from './TreeSitterParser.ts';
import { normalizeLanguageId } from '../util/language.ts';

export interface ExtractedSymbol {
  readonly name: string;
  readonly qualifiedName?: string;
  readonly kind: SymbolKind;
  readonly container?: string;
  readonly signature?: string;
  /** Zero-based. */
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface ExtractedReference {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly column: number;
}

export interface ExtractResult {
  readonly symbols: readonly ExtractedSymbol[];
  readonly references: readonly ExtractedReference[];
  readonly includes: readonly string[];
}

export interface ExtractOptions {
  /** Collect call-site references as well. Off by default (plan section 7). */
  readonly references?: boolean;
}

export interface SymbolExtractor {
  readonly id: string;
  readonly languages: readonly string[];
  extract(tree: SyntaxTree, language: string, options?: ExtractOptions): ExtractResult;
}

export class ExtractorRegistry {
  private readonly extractors: SymbolExtractor[] = [];

  register(extractor: SymbolExtractor): void {
    this.extractors.push(extractor);
  }

  all(): readonly SymbolExtractor[] {
    return this.extractors;
  }

  forLanguage(language: string | undefined): SymbolExtractor | undefined {
    if (!language) return undefined;
    const normalized = normalizeLanguageId(language);
    if (!normalized) return undefined;
    return this.extractors.find((extractor) =>
      extractor.languages.some((candidate) => normalizeLanguageId(candidate) === normalized)
    );
  }

  get size(): number {
    return this.extractors.length;
  }
}
