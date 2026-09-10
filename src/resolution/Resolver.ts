/**
 * The resolver abstraction (plan section 3).
 *
 * CodePort has two engines — the local index and language servers — and does not
 * let either one own the answer. Both produce the same `ResolutionResult`, and a
 * policy decides how they are combined (plan sections 11-14).
 */

import type { Project } from '../project/Project.ts';
import type { Location, Position, ResolvedSymbol, SymbolReference } from '../types.ts';

/** Stable resolver ids, referenced by policies and the log. */
export const INDEX_RESOLVER_ID = 'index';
export const LSP_RESOLVER_ID = 'lsp';

export interface ResolveContext {
  /** The Markdown mention being resolved. */
  readonly reference: SymbolReference;
  /** URI of the Markdown document. */
  readonly documentUri: string;
  /** Position of the mention inside the Markdown document. */
  readonly position: Position;
  /** Language chosen by the three-level strategy (plan section 7), if known. */
  readonly language?: string;
  readonly workspaceRoot?: string;
  /** Abort signal for long runs; checked between resolvers. */
  readonly isCancelled?: () => boolean;
}

export interface ResolutionCandidate {
  readonly location: Location;
  /** 0..1. Higher wins when candidates are merged. */
  readonly confidence: number;
  /** Resolver that produced the candidate (`index`, `lsp`). */
  readonly source: string;
  /** Human readable justification, surfaced in the hover and the log. */
  readonly reason?: string;
  readonly symbol?: ResolvedSymbol;
}

export interface ResolutionResult {
  readonly resolver: string;
  readonly candidates: readonly ResolutionCandidate[];
  /** Best candidate confidence; 0 when the resolver found nothing. */
  readonly confidence: number;
  readonly durationMs: number;
  /** Set when the resolver failed; the pipeline keeps going regardless. */
  readonly error?: string;
}

export interface SymbolResolver {
  readonly id: string;
  readonly kind: 'index' | 'lsp';
  /** Cheap pre-flight check so an unavailable resolver costs nothing. */
  isAvailable(context: ResolveContext): boolean;
  resolve(context: ResolveContext): Promise<ResolutionResult>;
}

export interface ResolutionOutcome {
  /** Merged, de-duplicated, confidence-sorted candidates. */
  readonly candidates: readonly ResolutionCandidate[];
  /** Per-resolver results, for logging and the "why" UI. */
  readonly results: readonly ResolutionResult[];
  readonly durationMs: number;
}

/** A location that points at a single character (or the symbol's own range). */
export function candidateRange(
  line: number,
  column: number,
  endLine?: number,
  endColumn?: number
): Location['range'] {
  return {
    start: { line, character: column },
    end: { line: endLine ?? line, character: endColumn ?? column },
  };
}
