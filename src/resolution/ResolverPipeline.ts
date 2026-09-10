/**
 * The resolution pipeline (plan section 3).
 *
 * Runs the permitted resolvers in policy order, stops as soon as the policy is
 * satisfied, and merges whatever came back. A resolver that throws degrades to a
 * recorded error instead of failing the user's jump: if the index is broken but
 * clangd works, navigation still works.
 */

import type {
  ResolutionOutcome,
  ResolutionResult,
  ResolveContext,
  SymbolResolver,
} from './Resolver.ts';
import type { ResolutionPolicy } from './Policy.ts';
import { clamp01 } from './Confidence.ts';
import { mergeCandidates } from './Policy.ts';

export interface PipelineLogger {
  info(message: string): void;
  warn(message: string): void;
  trace?(message: string): void;
}

export interface ResolverPipelineOptions {
  readonly policy: ResolutionPolicy;
  readonly logger?: PipelineLogger;
}

export class ResolverPipeline {
  private readonly resolvers: readonly SymbolResolver[];
  readonly policy: ResolutionPolicy;
  private readonly logger: PipelineLogger;

  constructor(resolvers: readonly SymbolResolver[], options: ResolverPipelineOptions) {
    this.resolvers = resolvers;
    this.policy = options.policy;
    this.logger = options.logger ?? { info() {}, warn() {} };
  }

  /** Resolver ids this pipeline may use, in policy order. */
  resolverIds(): string[] {
    return this.policy.order(this.resolvers).map((resolver) => resolver.id);
  }

  async resolve(context: ResolveContext): Promise<ResolutionOutcome> {
    const started = Date.now();
    const results: ResolutionResult[] = [];

    for (const resolver of this.policy.order(this.resolvers)) {
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
        result = { resolver: resolver.id, candidates: [], confidence: 0, durationMs: 0, error: message };
      }

      results.push(result);
      this.logger.trace?.(
        `[pipeline] ${resolver.id}: ${result.candidates.length} candidate(s), ` +
          `confidence ${result.confidence.toFixed(2)}, ${result.durationMs} ms` +
          (result.error ? ` (error: ${result.error})` : '')
      );

      if (this.policy.shouldStop(result, results, context)) break;
    }

    const candidates = this.policy.merge(results, context);
    const outcome: ResolutionOutcome = {
      candidates,
      results,
      durationMs: Date.now() - started,
    };

    this.logger.info(
      `[pipeline/${this.policy.id}] resolved "${context.reference.raw}" -> ` +
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

/** Best confidence across an outcome; 0 when nothing was found. */
export function bestConfidence(outcome: ResolutionOutcome): number {
  return outcome.candidates.reduce((best, candidate) => Math.max(best, candidate.confidence), clamp01(0));
}
