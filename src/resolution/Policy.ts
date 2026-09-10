/**
 * Resolution policies (plan sections 13-14).
 *
 * The default is `index-first`: answer from the local index when a single
 * candidate is convincing, otherwise confirm with the language server. The other
 * policies exist because the right trade-off depends on the project — a huge
 * codebase with a slow clangd may prefer `index-only`, a template-heavy one
 * `lsp-only`.
 */

import type { ResolutionCandidate, ResolutionResult, ResolveContext, SymbolResolver } from './Resolver.ts';
import { INDEX_RESOLVER_ID, LSP_RESOLVER_ID } from './Resolver.ts';

export type PolicyId = 'index-first' | 'lsp-first' | 'index-only' | 'lsp-only';

export const POLICY_IDS: readonly PolicyId[] = ['index-first', 'lsp-first', 'index-only', 'lsp-only'];

export interface PolicyOptions {
  /**
   * Confidence a single index candidate must reach for `index-first` to skip the
   * language server. Default 0.85.
   */
  readonly indexAcceptConfidence?: number;
}

export interface ResolutionPolicy {
  readonly id: PolicyId;
  /** Resolvers to try, in order, filtered to those this policy permits. */
  order(resolvers: readonly SymbolResolver[]): readonly SymbolResolver[];
  /** True when the pipeline can stop without consulting further resolvers. */
  shouldStop(
    result: ResolutionResult,
    results: readonly ResolutionResult[],
    context: ResolveContext
  ): boolean;
  /** Combine every result into the final, ranked candidate list. */
  merge(results: readonly ResolutionResult[], context: ResolveContext): ResolutionCandidate[];
}

const DEFAULT_INDEX_ACCEPT_CONFIDENCE = 0.85;

export function createPolicy(id: PolicyId, options: PolicyOptions = {}): ResolutionPolicy {
  const acceptConfidence = options.indexAcceptConfidence ?? DEFAULT_INDEX_ACCEPT_CONFIDENCE;

  const order = (resolvers: readonly SymbolResolver[]): readonly SymbolResolver[] => {
    const index = resolvers.filter((resolver) => resolver.kind === 'index');
    const lsp = resolvers.filter((resolver) => resolver.kind === 'lsp');
    switch (id) {
      case 'index-only':
        return index;
      case 'lsp-only':
        return lsp;
      case 'lsp-first':
        return [...lsp, ...index];
      case 'index-first':
      default:
        return [...index, ...lsp];
    }
  };

  const shouldStop = (
    result: ResolutionResult,
    _results: readonly ResolutionResult[],
    _context: ResolveContext
  ): boolean => {
    switch (id) {
      case 'index-only':
      case 'lsp-only':
        return true;
      case 'lsp-first':
        // The server answered: it is authoritative, no need for the index.
        return result.resolver === LSP_RESOLVER_ID && result.candidates.length > 0;
      case 'index-first':
      default:
        return (
          result.resolver === INDEX_RESOLVER_ID &&
          result.candidates.length === 1 &&
          result.confidence >= acceptConfidence
        );
    }
  };

  const merge = (
    results: readonly ResolutionResult[],
    context: ResolveContext
  ): ResolutionCandidate[] => mergeCandidates(results, context);

  return { id, order, shouldStop, merge };
}

/**
 * Merge candidates from every resolver.
 *
 * De-duplication is by location, keeping the highest confidence, which matters
 * when the index and clangd both find the same definition. The result is ranked
 * descending, so a language-server hit (>= 0.92) naturally outranks an
 * unconfirmed index hit without any special casing.
 */
export function mergeCandidates(
  results: readonly ResolutionResult[],
  _context?: ResolveContext
): ResolutionCandidate[] {
  const byLocation = new Map<string, ResolutionCandidate>();

  for (const result of results) {
    for (const candidate of result.candidates) {
      const { uri, range } = candidate.location;
      const key = `${uri}:${range.start.line}:${range.start.character}`;
      const existing = byLocation.get(key);
      if (!existing || candidate.confidence > existing.confidence) {
        byLocation.set(key, candidate);
      }
    }
  }

  return [...byLocation.values()].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    // Stable, deterministic tie-break: file, then position.
    if (a.location.uri !== b.location.uri) return a.location.uri < b.location.uri ? -1 : 1;
    if (a.location.range.start.line !== b.location.range.start.line) {
      return a.location.range.start.line - b.location.range.start.line;
    }
    return a.location.range.start.character - b.location.range.start.character;
  });
}
