/**
 * The resolution pipeline.
 *
 * It runs the configured resolvers in order, isolates failures, and merges
 * whatever came back. CodePort now has a single engine (CodeGraph), so the loop
 * usually runs once — but the seam is kept deliberately: adding a second opinion
 * later means writing one resolver, not touching the providers.
 *
 * A resolver that throws degrades to a recorded error instead of failing the
 * user's jump.
 */

import type {
  ResolutionCandidate,
  ResolutionOutcome,
  ResolutionResult,
  ResolveContext,
  SymbolResolver,
} from './Resolver.ts';

export interface PipelineLogger {
  info(message: string): void;
  warn(message: string): void;
  trace?(message: string): void;
}

export interface ResolverPipelineOptions {
  readonly logger?: PipelineLogger;
}

export class ResolverPipeline {
  private readonly resolvers: readonly SymbolResolver[];
  private readonly logger: PipelineLogger;

  constructor(resolvers: readonly SymbolResolver[], options: ResolverPipelineOptions = {}) {
    this.resolvers = resolvers;
    this.logger = options.logger ?? { info() {}, warn() {} };
  }

  /** Resolver ids this pipeline may use, in order. */
  resolverIds(): string[] {
    return this.resolvers.map((resolver) => resolver.id);
  }

  async resolve(context: ResolveContext): Promise<ResolutionOutcome> {
    const started = Date.now();
    const results: ResolutionResult[] = [];

    for (const resolver of this.resolvers) {
      if (context.isCancelled?.()) break;

      if (!isUsable(resolver, context)) {
        this.logger.trace?.(`[pipeline] skipping ${resolver.id} (not available)`);
        continue;
      }

      let result: ResolutionResult;
      try {
        result = await resolver.resolve(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[pipeline] ${resolver.id} failed: ${message}`);
        result = { resolver: resolver.id, candidates: [], durationMs: 0, error: message };
      }

      results.push(result);
      this.logger.trace?.(
        `[pipeline] ${resolver.id}: ${result.candidates.length} candidate(s), ` +
          `${result.durationMs} ms` +
          (result.error ? ` (error: ${result.error})` : '')
      );
    }

    const candidates = mergeCandidates(results, context);
    const outcome: ResolutionOutcome = {
      candidates,
      results,
      durationMs: Date.now() - started,
    };

    this.logger.info(
      `[pipeline] resolved "${context.reference.raw}" -> ` +
        `${candidates.length} candidate(s) in ${outcome.durationMs} ms ` +
        `[${results.map((r) => `${r.resolver}=${r.candidates.length}`).join(', ') || 'no resolver ran'}]`
    );
    return outcome;
  }
}

function isUsable(resolver: SymbolResolver, context: ResolveContext): boolean {
  try {
    return resolver.isAvailable(context);
  } catch {
    return false;
  }
}

/**
 * Merge candidates from every resolver.
 *
 * De-duplication is by location, keeping the higher rank, and the result is
 * ranked descending with a deterministic tie-break (file, then position) so the
 * same query always produces the same order.
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
      if (!existing || candidate.rank > existing.rank) {
        byLocation.set(key, candidate);
      }
    }
  }

  return [...byLocation.values()].sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (a.location.uri !== b.location.uri) return a.location.uri < b.location.uri ? -1 : 1;
    if (a.location.range.start.line !== b.location.range.start.line) {
      return a.location.range.start.line - b.location.range.start.line;
    }
    return a.location.range.start.character - b.location.range.start.character;
  });
}

/** Best rank across an outcome; the number of evidence signals on the top hit. */
export function bestRank(outcome: ResolutionOutcome): number {
  return outcome.candidates.reduce((best, candidate) => Math.max(best, candidate.rank), 0);
}
