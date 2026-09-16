/**
 * The resolver abstraction.
 *
 * CodePort has a single engine — CodeGraph — but keeps the resolver interface so
 * the pipeline still isolates failures and still produces the same
 * `ResolutionResult` the providers and the hover provenance consume.
 */

import type { Location, Position, ResolvedSymbol, SymbolReference } from '../types.ts';

/** Stable resolver id, referenced by the log and shown in the hover. */
export const CODEGRAPH_RESOLVER_ID = 'codegraph';

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
  /**
   * How many independent pieces of evidence agree with this candidate, minus the
   * ones that contradict it. Higher sorts first. Not a probability — see
   * `Ranking.ts`.
   */
  readonly rank: number;
  /** Resolver that produced the candidate (`codegraph`). */
  readonly source: string;
  /** Human readable justification, surfaced in the hover and the log. */
  readonly reason?: string;
  readonly symbol?: ResolvedSymbol;
}

export interface ResolutionResult {
  readonly resolver: string;
  readonly candidates: readonly ResolutionCandidate[];
  readonly durationMs: number;
  /** Set when the resolver failed; the pipeline keeps going regardless. */
  readonly error?: string;
}

export interface SymbolResolver {
  readonly id: string;
  /** Cheap pre-flight check so an unavailable resolver costs nothing. */
  isAvailable(context: ResolveContext): boolean;
  resolve(context: ResolveContext): Promise<ResolutionResult>;
}

export interface ResolutionOutcome {
  /** Merged, de-duplicated, rank-sorted candidates. */
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
