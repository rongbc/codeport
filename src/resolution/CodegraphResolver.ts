/**
 * `CodegraphResolver` — CodePort's only symbol engine.
 *
 * It answers from a CodeGraph graph through {@link CodegraphIndex}, and ranks
 * every hit with {@link rankCandidate} so several same-named symbols come back in
 * a defensible order and the hover can explain *why*.
 *
 * What it cannot do, and what CodePort therefore no longer does: resolve
 * overloads, templates, macros or conditional compilation. CodeGraph's graph is
 * structural (the same class of answer tree-sitter used to give) — it is broader
 * and faster, not more semantic. `macro` is the one outright regression, since
 * CodeGraph has no macro node kind at all.
 */

import type { CodegraphIndex } from '../codegraph/CodegraphIndex.ts';
import { findGraphRoot } from '../codegraph/sdk.ts';
import { pathToUri } from '../util/uri.ts';
import {
  CODEGRAPH_RESOLVER_ID,
  candidateRange,
  type ResolutionCandidate,
  type ResolutionResult,
  type ResolveContext,
  type SymbolResolver,
} from './Resolver.ts';
import { rankCandidate } from './Ranking.ts';

/**
 * The slice of a graph the resolver uses. {@link CodegraphIndex} satisfies it and
 * tests can inject a fake of the same shape, so the resolver never needs a real
 * CodeGraph install to be exercised.
 */
export type CodegraphQueryTarget = Pick<CodegraphIndex, 'query'>;

/** Resolve a graph root to an already-open graph, if one is cached. */
export type CodegraphLookup = (root: string) => CodegraphQueryTarget | undefined;

export interface CodegraphResolverLogger {
  trace?(message: string): void;
}

export interface CodegraphResolverOptions {
  /** Look up an already-open graph for a root. */
  readonly lookup: CodegraphLookup;
  /** Open the graph for a root on demand. */
  readonly open: (root: string) => Promise<CodegraphQueryTarget | undefined>;
  /** Max rows to consider before scoring. Default 50. */
  readonly limit?: number;
  readonly logger?: CodegraphResolverLogger;
}

const DEFAULT_LIMIT = 50;
/** Never surface more than this many candidates for one mention. */
const MAX_CANDIDATES = 20;

export class CodegraphResolver implements SymbolResolver {
  readonly id = CODEGRAPH_RESOLVER_ID;

  private readonly options: CodegraphResolverOptions;

  constructor(options: CodegraphResolverOptions) {
    this.options = options;
  }

  /**
   * Cheap and synchronous: a workspace is "available" exactly when some ancestor
   * directory holds a `.codegraph/` graph. No SDK load, no I/O beyond stat calls.
   */
  isAvailable(context: ResolveContext): boolean {
    const root = context.workspaceRoot;
    if (!root) return false;
    return findGraphRoot(root) !== undefined;
  }

  async resolve(context: ResolveContext): Promise<ResolutionResult> {
    const started = Date.now();
    const workspaceRoot = context.workspaceRoot;
    if (!workspaceRoot) return emptyResult(started);

    const graphRoot = findGraphRoot(workspaceRoot);
    if (!graphRoot) {
      this.options.logger?.trace?.(`[codegraph] no graph at or above ${workspaceRoot}`);
      return emptyResult(started);
    }

    const target = this.options.lookup(graphRoot) ?? (await this.options.open(graphRoot));
    if (!target) {
      this.options.logger?.trace?.(`[codegraph] graph at ${graphRoot} could not be opened`);
      return emptyResult(started);
    }

    const lookup = target.query(context.reference.name, { limit: this.options.limit ?? DEFAULT_LIMIT });
    if (lookup.match === 'none' || lookup.hits.length === 0) {
      this.options.logger?.trace?.(`[codegraph] no hit for "${context.reference.name}"`);
      return emptyResult(started);
    }

    const candidates: ResolutionCandidate[] = [];
    for (const hit of lookup.hits.slice(0, MAX_CANDIDATES)) {
      const ranking = rankCandidate({
        matchType: lookup.match,
        queryName: context.reference.name,
        queryContainer: context.reference.container,
        // The fence language is the only language signal CodePort supplies;
        // CodeGraph reports the language of the defining file.
        queryLanguage: context.language ?? context.reference.language,
        queryKindHint: context.reference.kindHint,
        hit: {
          name: hit.name,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          container: hit.container,
          language: hit.language,
        },
      });
      candidates.push({
        location: {
          uri: pathToUri(hit.file),
          range: candidateRange(hit.line, hit.column, hit.endLine, hit.endColumn),
        },
        rank: ranking.rank,
        source: this.id,
        reason: ranking.reasons.join(', '),
        symbol: {
          id: hit.id,
          name: hit.name,
          qualifiedName: hit.qualifiedName,
          kind: hit.kind,
          signature: hit.signature,
          container: hit.container,
        },
      });
    }

    return { resolver: this.id, candidates, durationMs: Date.now() - started };
  }
}

function emptyResult(started: number): ResolutionResult {
  return { resolver: CODEGRAPH_RESOLVER_ID, candidates: [], durationMs: Date.now() - started };
}
