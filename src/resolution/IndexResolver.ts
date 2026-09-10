/**
 * `IndexResolver` — answers from the local CodePort index (plan section 4.1).
 *
 * Fast, offline and language-server-free. It scores each hit with
 * {@link scoreIndexHit} so the policy can tell a certain answer from a guess.
 */

import type { SymbolIndex } from '../index/SymbolIndex.ts';
import { pathToUri } from '../util/uri.ts';
import {
  INDEX_RESOLVER_ID,
  candidateRange,
  type ResolutionCandidate,
  type ResolutionResult,
  type ResolveContext,
  type SymbolResolver,
} from './Resolver.ts';
import { scoreIndexHit } from './Confidence.ts';

export type SymbolIndexLookup = (workspaceRoot: string) => SymbolIndex | undefined;

export interface IndexResolverLogger {
  trace?(message: string): void;
}

export interface IndexResolverOptions {
  readonly lookup: SymbolIndexLookup;
  /** Max candidate rows to consider. Default 50. */
  readonly limit?: number;
  readonly logger?: IndexResolverLogger;
}

const DEFAULT_LIMIT = 50;
/** Never surface more than this many index candidates for one mention. */
const MAX_CANDIDATES = 20;

export class IndexResolver implements SymbolResolver {
  readonly id = INDEX_RESOLVER_ID;
  readonly kind = 'index' as const;

  private readonly options: IndexResolverOptions;

  constructor(options: IndexResolverOptions) {
    this.options = options;
  }

  isAvailable(context: ResolveContext): boolean {
    const root = context.workspaceRoot;
    if (!root) return false;
    const index = this.options.lookup(root);
    return index !== undefined && !index.isClosed;
  }

  async resolve(context: ResolveContext): Promise<ResolutionResult> {
    const started = Date.now();
    const root = context.workspaceRoot;
    const index = root ? this.options.lookup(root) : undefined;
    if (!index) {
      return emptyResult(started);
    }

    const lookup = index.query(context.reference.name, { limit: this.options.limit ?? DEFAULT_LIMIT });
    if (lookup.match === 'none' || lookup.hits.length === 0) {
      this.options.logger?.trace?.(`[index] no hit for "${context.reference.name}"`);
      return emptyResult(started);
    }

    const candidates: ResolutionCandidate[] = [];
    for (const hit of lookup.hits.slice(0, MAX_CANDIDATES)) {
      const score = scoreIndexHit({
        matchType: lookup.match,
        queryName: context.reference.name,
        queryContainer: context.reference.container,
        // The resolved language (context) is a stronger signal than the fence
        // hint: LanguageManager may have established it from the document's own
        // project when the fence carried no info string.
        queryLanguage: context.language ?? context.reference.language,
        queryKindHint: context.reference.kindHint,
        resultCount: lookup.hits.length,
        hit: {
          name: hit.name,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          container: hit.container,
          language: hit.language,
        },
      });
      if (score.score <= 0) continue;
      candidates.push({
        location: {
          uri: pathToUri(hit.file),
          range: candidateRange(hit.line, hit.column, hit.endLine, hit.endColumn),
        },
        confidence: score.score,
        source: this.id,
        reason: score.reasons.join(', '),
        symbol: {
          name: hit.name,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          signature: hit.signature,
          container: hit.container,
        },
      });
    }

    const confidence = candidates.reduce((best, candidate) => Math.max(best, candidate.confidence), 0);
    return { resolver: this.id, candidates, confidence, durationMs: Date.now() - started };
  }
}

function emptyResult(started: number): ResolutionResult {
  return { resolver: INDEX_RESOLVER_ID, candidates: [], confidence: 0, durationMs: Date.now() - started };
}
