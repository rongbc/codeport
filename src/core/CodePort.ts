/**
 * `CodePort` — the facade the VS Code layer talks to.
 *
 * Owns the CodeGraph index service, the resolver pipeline and the Markdown parse
 * cache, and rebuilds the engines whenever the configuration changes.
 *
 * The dependency direction is one-way and deliberate:
 *
 *   providers -> CodePort -> pipeline -> CodegraphResolver -> CodeGraph
 *
 * Nothing below `CodePort` imports `vscode`, which is what keeps the interesting
 * parts unit-testable. Note where the project root comes from: CodePort used to
 * run a project detector to decide which language server to start. CodeGraph owns
 * that question now — it finds its own graph by walking up from a file — so the
 * workspace folder is all that is left to look up.
 */

import * as vscode from 'vscode';
import path from 'node:path';
import { CodegraphIndexService, type CodegraphIndex } from '../codegraph/CodegraphIndex.ts';
import { findGraphRoot, type CodegraphStats } from '../codegraph/sdk.ts';
import { CodegraphResolver } from '../resolution/CodegraphResolver.ts';
import { ResolverPipeline } from '../resolution/ResolverPipeline.ts';
import { MarkdownParserCache, symbolAt, type ParsedMarkdown } from '../markdown/MarkdownParser.ts';
import { readConfig, type CodePortConfig } from '../config.ts';
import { Logger } from '../logger.ts';
import { CONFIG_SECTION } from '../constants.ts';
import type { ResolveContext, ResolutionOutcome } from '../resolution/Resolver.ts';
import type { Location, SymbolReference } from '../types.ts';
import { pathToUri, tryUriToPath } from '../util/uri.ts';
import { fromVsPosition } from '../vscode/convert.ts';

/** A CodeGraph index found for a workspace, with its statistics. */
export interface GraphSummary extends CodegraphStats {
  readonly root: string;
}

/** How many resolved definitions `Find All References` expands. */
const MAX_REFERENCE_TARGETS = 5;

export class CodePort {
  readonly logger: Logger;

  private readonly context: vscode.ExtensionContext;
  private readonly parserCache = new MarkdownParserCache();
  private readonly disposables: vscode.Disposable[] = [];

  private graphs: CodegraphIndexService;
  private pipeline: ResolverPipeline;
  private configCache: CodePortConfig | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    const config = readConfig();

    this.logger = new Logger();
    this.logger.setLevel(config.trace);
    this.logger.section(`CodePort ${context.extension.id} activated`);

    this.graphs = this.createIndexService();
    this.pipeline = this.createPipeline();
  }

  /** Register workspace listeners. */
  initialize(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) this.onConfigurationChanged();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.graphs.closeAll();
        this.logger.trace('workspace folders changed; open graphs closed');
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.parserCache.invalidate(document.uri.toString());
      })
    );

    void this.logEngineStatus();
  }

  private async logEngineStatus(): Promise<void> {
    const languages = await this.supportedLanguages();
    this.logger.info(
      languages.length > 0
        ? `CodeGraph ready for ${languages.length} language(s); resolver=${this.pipeline.resolverIds().join(',')}`
        : 'CodeGraph was not found; install it (npm i -g @colbymchenry/codegraph) ' +
            'so that `codegraph` is on PATH'
    );
  }

  /* ------------------------------ config ------------------------------ */

  getConfig(): CodePortConfig {
    if (!this.configCache) this.configCache = readConfig();
    return this.configCache;
  }

  /**
   * The SDK search is entirely CodeGraph's own doing — CodePort has no setting for
   * where it lives, because the extension is useless without the tool and an
   * installed CLI is what puts it on `PATH`. The one thing the search must know is
   * whether the workspace is trusted: a repository ships its own `node_modules`,
   * and importing an SDK from there would run repository code in the extension host.
   */
  private createIndexService(): CodegraphIndexService {
    return new CodegraphIndexService({
      sdk: {
        extensionPath: this.context.extensionPath,
        workspaceTrusted: vscode.workspace.isTrusted,
      },
    });
  }

  private createPipeline(): ResolverPipeline {
    const graphs = this.graphs;
    return new ResolverPipeline(
      [
        new CodegraphResolver({
          lookup: (root) => graphs.lookup(root),
          open: (root) => graphs.open(root),
          logger: this.logger,
        }),
      ],
      { logger: this.logger }
    );
  }

  private onConfigurationChanged(): void {
    this.configCache = undefined;
    this.logger.setLevel(this.getConfig().trace);
  }

  /* --------------------------- document access --------------------------- */

  readDocument(document: vscode.TextDocument): ParsedMarkdown {
    return this.parserCache.get(document.uri.toString(), document.version, document.getText());
  }

  /** The symbol mention under (or just left of) a cursor position. */
  symbolAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): SymbolReference | undefined {
    return symbolAt(this.readDocument(document), fromVsPosition(position));
  }

  /* ------------------------------ resolving ------------------------------ */

  /** Run the resolver pipeline for a mention. */
  async resolve(
    reference: SymbolReference,
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): Promise<ResolutionOutcome> {
    const documentUri = document.uri.toString();
    const context: ResolveContext = {
      reference,
      documentUri,
      position: reference.range.start,
      language: reference.language,
      workspaceRoot: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
      isCancelled: token ? () => token.isCancellationRequested : undefined,
    };

    if (token?.isCancellationRequested) {
      return { candidates: [], results: [], durationMs: 0 };
    }
    return this.pipeline.resolve(context);
  }

  /**
   * Reference sites of a resolved symbol.
   *
   * CodeGraph's edges carry the exact line and column of each usage plus the
   * referenced name, so this is a faithful stand-in for the language server's
   * `textDocument/references` — at the cost of being a static, name-resolved call
   * graph rather than a semantic one.
   */
  async referencesFor(
    location: Location,
    symbolId: string | undefined,
    includeDeclaration: boolean
  ): Promise<Location[]> {
    if (!symbolId) return [];
    const resolved = await this.withIndexFor(location, (index) => index.usages(symbolId));
    if (!resolved) return [];

    const found: Location[] = includeDeclaration ? [location] : [];
    for (const usage of resolved.value) {
      const site = usage.edge;
      if (typeof site.line !== 'number') continue;
      const line = Math.max(0, site.line - 1);
      const column = Math.max(0, site.column ?? 0);
      const name = site.metadata?.['refName'];
      const width = typeof name === 'string' && name.length > 0 ? name.length : 0;
      found.push({
        uri: pathToUri(resolveNodeFile(resolved.root, usage.node.filePath)),
        range: {
          start: { line, character: column },
          end: { line, character: column + width },
        },
      });
    }
    return found;
  }

  /**
   * The symbol's own source text.
   *
   * Used by the hover when CodeGraph reported no `signature`, which is the one
   * case where a snippet beats metadata.
   */
  async symbolSource(location: Location, symbolId: string | undefined): Promise<string | undefined> {
    if (!symbolId) return undefined;
    const resolved = await this.withIndexFor(location, (index) => index.code(symbolId));
    return resolved?.value;
  }

  /** How many definitions to walk for one `Find All References`. */
  referenceTargetLimit(): number {
    return MAX_REFERENCE_TARGETS;
  }

  /** Languages the installed CodeGraph can parse. */
  async supportedLanguages(): Promise<readonly string[]> {
    return this.graphs.supportedLanguages();
  }

  /* ------------------------------ graph info ------------------------------ */

  /** Statistics for the CodeGraph index governing `workspaceRoot`, if any. */
  async graphSummary(workspaceRoot: string): Promise<GraphSummary | undefined> {
    const root = findGraphRoot(workspaceRoot);
    if (!root) return undefined;
    const index = await this.graphs.open(root);
    const stats = index?.stats();
    if (!stats) return undefined;
    return { root, ...stats };
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async dispose(): Promise<void> {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.graphs.closeAll();
    this.parserCache.clear();
    this.logger.info('CodePort deactivated');
    this.logger.dispose();
  }

  /**
   * Run `use` against the graph that owns `location`, opening it if needed.
   *
   * The graph root is derived from the *resolved file*, not from the workspace:
   * a mention in one folder can legitimately resolve into a graph that lives
   * above a different one.
   */
  private async withIndexFor<T>(
    location: Location,
    use: (index: CodegraphIndex) => T
  ): Promise<{ readonly root: string; readonly value: T } | undefined> {
    const filePath = tryUriToPath(location.uri);
    if (!filePath) return undefined;
    const root = findGraphRoot(path.dirname(filePath));
    if (!root) return undefined;
    const index = await this.graphs.open(root);
    if (!index) return undefined;
    return { root, value: use(index) };
  }
}

/** CodeGraph stores file paths relative to the project root. */
function resolveNodeFile(root: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
}
