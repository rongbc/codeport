/**
 * `LspResolver` — answers through the project's language server (plan section 4.2).
 *
 * This is where the compiler-grade semantics live: overloads, namespaces,
 * templates, macros, include paths, conditional compilation. CodePort reaches
 * them through whichever adapter matches the language, so this class never
 * mentions clangd.
 *
 * The Markdown document is not part of any compilation, so a position inside it
 * cannot be sent to the server. Instead the mention is resolved with
 * `workspace/symbol`, exactly as the original extension did. Once a definition is
 * known, {@link referencesAt} and {@link hoverAt} *do* use real positions, which
 * is what makes Find All References work for Markdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LspClient } from '../lsp/LspClient.ts';
import type { LspClientPool } from '../lsp/LspClientPool.ts';
import type { LspLogger } from '../lsp/LspClient.ts';
import type { LanguageAdapter } from '../adapters/LanguageAdapter.ts';
import type { Project } from '../project/Project.ts';
import { projectKey } from '../project/Project.ts';
import { pathToUri } from '../util/uri.ts';
import { EXTENSION_VERSION } from '../constants.ts';
import type { Location } from '../types.ts';
import {
  LSP_RESOLVER_ID,
  type ResolutionCandidate,
  type ResolutionResult,
  type ResolveContext,
  type SymbolResolver,
} from './Resolver.ts';
import { lspSymbolConfidence } from './Confidence.ts';

/** An adapter/project pair able to answer for a mention. */
export interface LspTarget {
  readonly adapter: LanguageAdapter;
  readonly project: Project;
}

/**
 * Supplies the adapter/project pairs to try. The VS Code layer implements the
 * three-level language strategy (plan section 7) behind this interface, which
 * keeps the resolver free of workspace/configuration concerns.
 */
export interface LspTargetProvider {
  resolveTargets(context: ResolveContext): Promise<readonly LspTarget[]>;
}

export interface LspResolverLogger extends LspLogger {
  trace?(message: string): void;
}

export interface LspResolverOptions {
  readonly pool: LspClientPool;
  readonly targets: LspTargetProvider;
  readonly logger: LspResolverLogger;
  readonly requestTimeoutMs?: number;
}

export class LspResolver implements SymbolResolver {
  readonly id = LSP_RESOLVER_ID;
  readonly kind = 'lsp' as const;

  private readonly options: LspResolverOptions;

  constructor(options: LspResolverOptions) {
    this.options = options;
  }

  isAvailable(_context: ResolveContext): boolean {
    // Targets are resolved per request; an empty target list is handled in
    // `resolve` without starting anything.
    return true;
  }

  async resolve(context: ResolveContext): Promise<ResolutionResult> {
    const started = Date.now();
    const targets = await this.options.targets.resolveTargets(context);
    if (targets.length === 0) {
      this.options.logger.trace?.('[lsp] no adapter/project can serve this mention');
      return this.result(started);
    }

    const errors: string[] = [];
    for (const target of targets) {
      try {
        const client = await this.clientFor(target);
        const matches = await target.adapter.workspaceSymbol(
          client,
          context.reference.name,
          context.reference.container
        );
        if (matches.length === 0) continue;

        const candidates: ResolutionCandidate[] = matches.map((match) => {
          const score = lspSymbolConfidence(match.match, { resultCount: matches.length });
          return {
            location: match.location,
            confidence: score.score,
            source: this.id,
            reason: score.reasons.join(', '),
            symbol: match.symbol,
          };
        });
        const confidence = candidates.reduce(
          (best, candidate) => Math.max(best, candidate.confidence),
          0
        );
        this.options.logger.trace?.(
          `[lsp] ${target.adapter.id} returned ${candidates.length} candidate(s) for ` +
            `"${context.reference.name}" (confidence ${confidence.toFixed(2)})`
        );
        return { resolver: this.id, candidates, confidence, durationMs: Date.now() - started };
      } catch (error) {
        const message = `${target.adapter.id}@${target.project.root}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        errors.push(message);
        this.options.logger.warn(`[lsp] ${message}`);
      }
    }

    return this.result(started, errors.length > 0 ? errors.join('; ') : undefined);
  }

  /** Find references to the symbol at a position inside a real source file. */
  async referencesAt(
    target: LspTarget,
    location: Location,
    includeDeclaration = true
  ): Promise<Location[]> {
    const client = await this.clientFor(target);
    return target.adapter.references(
      client,
      location.uri,
      location.range.start,
      includeDeclaration
    );
  }

  /** Hover text for a position inside a real source file. */
  async hoverAt(target: LspTarget, location: Location): Promise<string | undefined> {
    const client = await this.clientFor(target);
    return target.adapter.hover(client, location.uri, location.range.start);
  }

  /**
   * The pooled client for a target, started and seeded on first use. Starting is
   * shared between concurrent callers by the pool.
   */
  async clientFor(target: LspTarget): Promise<LspClient> {
    const key = projectKey(target.project);
    return this.options.pool.acquire(key, () => startClient(target, this.options));
  }

  /** Dispose every language server this resolver started. */
  async dispose(): Promise<void> {
    await this.options.pool.disposeAll();
  }

  private result(started: number, error?: string): ResolutionResult {
    return {
      resolver: this.id,
      candidates: [],
      confidence: 0,
      durationMs: Date.now() - started,
      error,
    };
  }
}

/** Spawn a server for a target and open its seed files (best effort). */
async function startClient(target: LspTarget, options: LspResolverOptions): Promise<LspClient> {
  const spec = target.adapter.serverSpec(target.project);
  const client = await LspClient.start(
    spec,
    target.adapter.rootUri(target.project),
    {
      logger: options.logger,
      requestTimeoutMs: options.requestTimeoutMs,
      clientName: 'CodePort',
      clientVersion: EXTENSION_VERSION,
    },
    path.basename(target.project.root)
  );

  for (const seed of target.adapter.seedFiles(target.project)) {
    try {
      const text = fs.readFileSync(seed.path, 'utf8');
      client.didOpen(pathToUri(seed.path), seed.languageId, text);
    } catch {
      // A seed file that disappeared is not fatal: it only costs index warm-up.
    }
  }
  return client;
}
