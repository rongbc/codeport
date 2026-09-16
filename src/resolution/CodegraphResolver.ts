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
 *
 * One thing the graph *cannot know* is patched in here: which of N same-named
 * definitions the current build actually compiles. For C/C++ projects with a
 * `compile_commands.json`, the build database **replaces** the graph's list when
 * it has an answer for the name, and the linker's own weak/strong rule then breaks
 * the remaining tie — a C/C++-only optimization that turns a twenty-entry Peek
 * list into the one definition the build links. It is never applied when the
 * database has no answer, so notes about a platform the workspace is not
 * configured for still resolve. See `CompileCommands.ts` and `WeakLinkage.ts`.
 */

import path from 'node:path';
import type { CodegraphHit, CodegraphIndex } from '../codegraph/CodegraphIndex.ts';
import { findGraphRoot } from '../codegraph/sdk.ts';
import { isCFamilyLanguage } from '../util/language.ts';
import { pathToUri, tryUriToPath } from '../util/uri.ts';
import { compileCommands, type CompileCommandsDb } from './CompileCommands.ts';
import {
  CODEGRAPH_RESOLVER_ID,
  candidateRange,
  type ResolutionCandidate,
  type ResolutionResult,
  type ResolveContext,
  type SymbolResolver,
} from './Resolver.ts';
import { BUILD_SIGNAL, STRONG_DEFINITION, rankCandidate } from './Ranking.ts';
import { isWeakDefinition } from './WeakLinkage.ts';

/**
 * The slice of a graph the resolver uses. {@link CodegraphIndex} satisfies it and
 * tests can inject a fake of the same shape, so the resolver never needs a real
 * CodeGraph install to be exercised.
 */
export type CodegraphQueryTarget = Pick<CodegraphIndex, 'query'>;

/** Resolve a graph root to an already-open graph, if one is cached. */
export type CodegraphLookup = (root: string) => CodegraphQueryTarget | undefined;

/**
 * The compilation database that governs one mention, if there is one.
 *
 * Injectable so tests can hand the resolver a database without a project on disk,
 * exactly like {@link CodegraphLookup}.
 */
export type CompileCommandsLookup = (context: ResolveContext) => CompileCommandsDb | undefined;

/**
 * The default lookup: the database nearest the Markdown file, never leaving the
 * workspace, falling back to the workspace root (which finds a build directory
 * one level down, e.g. `nuttx/compile_commands.json`).
 *
 * A note can live behind a symlink outside the workspace — this repository links
 * `note/` elsewhere — hence the fallback rather than a single upward walk.
 */
export function lookupCompileCommands(context: ResolveContext): CompileCommandsDb | undefined {
  const root = context.workspaceRoot;
  if (!root) return undefined;

  const document = tryUriToPath(context.documentUri);
  if (document) {
    const near = compileCommands.find(path.dirname(document), root);
    if (near) return near;
  }

  return compileCommands.find(root, root);
}

export interface CodegraphResolverLogger {
  trace?(message: string): void;
}

export interface CodegraphResolverOptions {
  /** Look up an already-open graph for a root. */
  readonly lookup: CodegraphLookup;
  /** Open the graph for a root on demand. */
  readonly open: (root: string) => Promise<CodegraphQueryTarget | undefined>;
  /**
   * The build database used as one more ordering signal. Defaults to the
   * process-wide index; pass one to test the signal without a project on disk.
   */
  readonly compileCommands?: CompileCommandsLookup;
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
    this.options = { compileCommands: lookupCompileCommands, ...options };
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

    // A candidate plus the facts narrowing needs to judge it.
    const scored: ScoredCandidate[] = [];

    // Asked once per resolve: the parse is cached and invalidated by mtime, so the
    // cost is a stat — cheaper than the SQLite lookup it follows. A project with no
    // build system simply gets `undefined`, and nothing below narrows anything.
    const build = this.options.compileCommands?.(context);
    if (build) {
      this.options.logger?.trace?.(
        `[codegraph] build signal: ${build.count} translation unit(s) from ${build.path}`
      );
    }

    // Every hit is ranked. The `MAX_CANDIDATES` cap is applied *after* narrowing:
    // the definition a build compiles is not guaranteed to be among the first
    // twenty hits a name-ordered graph query returns.
    for (const hit of lookup.hits) {
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

      // C/C++ only: a compilation database is a C/C++ artifact.
      const inBuild = build !== undefined && isCFamilyLanguage(hit.language) && build.has(hit.file);
      const reasons = inBuild ? [...ranking.reasons, BUILD_SIGNAL.reason] : ranking.reasons;

      scored.push({
        hit,
        inBuild,
        candidate: {
          location: {
            uri: pathToUri(hit.file),
            range: candidateRange(hit.line, hit.column, hit.endLine, hit.endColumn),
          },
          rank: ranking.rank + (inBuild ? BUILD_SIGNAL.points : 0),
          source: this.id,
          reason: reasons.join(', '),
          symbol: {
            id: hit.id,
            name: hit.name,
            qualifiedName: hit.qualifiedName,
            kind: hit.kind,
            signature: hit.signature,
            container: hit.container,
          },
        },
      });
    }

    const narrowed = narrowToBuild(scored, build);
    if (narrowed.length !== scored.length) {
      this.options.logger?.trace?.(
        `[codegraph] ${build?.path} narrowed ${scored.length} candidate(s) to ` +
          `${narrowed.length} for "${context.reference.name}"`
      );
    }

    return {
      resolver: this.id,
      candidates: narrowed.slice(0, MAX_CANDIDATES).map((entry) => entry.candidate),
      durationMs: Date.now() - started,
    };
  }
}

/** A candidate together with the build facts that decide whether it survives. */
export interface ScoredCandidate {
  readonly hit: CodegraphHit;
  /** True when the file is a C-family translation unit of the current build. */
  readonly inBuild: boolean;
  readonly candidate: ResolutionCandidate;
}

/**
 * The build's own opinion, applied after ranking.
 *
 * A static graph cannot tell which of N same-named definitions a build compiles,
 * and the mention's evidence scores them all alike — so for NuttX's
 * one-definition-per-chip ARCH hooks the graph offers twenty equally good answers
 * and the Peek list is a coin flip. When the project has a compilation database
 * *and it has an answer for this name*, that answer replaces the graph's list:
 *
 * 1. C-family candidates in the build are kept; C-family candidates outside it are
 *    dropped. The alternatives are, by construction, not part of this build.
 * 2. Candidates of **another language are never dropped**. A build database is a
 *    C/C++ artifact and must not hide a Python or Rust definition of one name.
 * 3. Among the survivors, a **strong definition beats a weak one** — that is what
 *    the linker does, and it is the difference between a chip's real
 *    `up_allocate_heap` and the generic `weak_function` default it overrides.
 *
 * When the database has no answer for the name — a note about `sim:nsh` while the
 * workspace is configured for a board, say — nothing is dropped and the full list
 * comes back unchanged.
 */
export function narrowToBuild(
  scored: readonly ScoredCandidate[],
  build: CompileCommandsDb | undefined
): ScoredCandidate[] {
  if (!build) return [...scored];

  const inBuild = scored.filter((entry) => entry.inBuild);
  if (inBuild.length === 0) return [...scored];

  const strong = inBuild.filter(
    (entry) => !isWeakDefinition(entry.hit.file, entry.hit.line, entry.hit.name)
  );

  // Every build candidate is weak: there is nothing for the linker to prefer, so
  // the whole list stays and the mention's evidence orders it.
  const droppedWeak = strong.length > 0 && strong.length < inBuild.length;
  const survivors = new Set(droppedWeak ? strong : inBuild);
  const kept = scored.filter(
    (entry) => survivors.has(entry) || !isCFamilyLanguage(entry.hit.language)
  );

  if (!droppedWeak) return kept;
  return kept.map((entry) =>
    survivors.has(entry) ? withReason(entry, STRONG_DEFINITION.reason) : entry
  );
}

function withReason(entry: ScoredCandidate, reason: string): ScoredCandidate {
  const existing = entry.candidate.reason;
  return {
    ...entry,
    candidate: {
      ...entry.candidate,
      reason: existing ? `${existing}, ${reason}` : reason,
    },
  };
}

function emptyResult(started: number): ResolutionResult {
  return { resolver: CODEGRAPH_RESOLVER_ID, candidates: [], durationMs: Date.now() - started };
}
