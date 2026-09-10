/**
 * `CodePort` — the facade the VS Code layer talks to.
 *
 * Owns the adapter registry, project/language detection, the index service, the
 * language-server pool and the resolver pipeline, and rebuilds the pipeline
 * whenever the policy changes.
 *
 * The dependency direction is one-way and deliberate:
 *
 *   providers -> CodePort -> pipeline -> resolvers -> adapters -> LSP
 *                                      \-> index
 *
 * Nothing below `CodePort` imports `vscode`, which is what keeps the interesting
 * parts unit-testable.
 */

import * as vscode from 'vscode';
import path from 'node:path';
import { createAdapterRegistry, createBuiltInAdapters } from '../adapters/index.ts';
import type { AdapterRegistry } from '../adapters/AdapterRegistry.ts';
import { LspClientPool } from '../lsp/LspClientPool.ts';
import { IndexResolver } from '../resolution/IndexResolver.ts';
import { LspResolver, type LspTarget } from '../resolution/LspResolver.ts';
import { ResolverPipeline } from '../resolution/ResolverPipeline.ts';
import { createPolicy } from '../resolution/Policy.ts';
import { MarkdownParserCache, symbolAt, type ParsedMarkdown } from '../markdown/MarkdownParser.ts';
import { readConfig, offerLegacyMigration, type CodePortConfig } from '../config.ts';
import { Logger } from '../logger.ts';
import { ProjectManager } from './ProjectManager.ts';
import { LanguageManager } from './LanguageManager.ts';
import { IndexService } from './IndexService.ts';
import { CONFIG_SECTION, INDEX_DIR_NAME } from '../constants.ts';
import type { ResolveContext, ResolutionOutcome } from '../resolution/Resolver.ts';
import type { Location, SymbolReference } from '../types.ts';
import type { IndexStats } from '../index/IndexStore.ts';
import type { IndexRunStats } from '../index/Indexer.ts';
import { tryUriToPath } from '../util/uri.ts';
import { fromVsPosition } from '../vscode/convert.ts';

/** Settings that invalidate the index or the language-server configuration. */
const ADAPTER_AFFECTING_SETTINGS = [
  'clangd.path',
  'clangd.arguments',
  'clangd.compileCommandsDir',
  'languages',
];

const INDEX_AFFECTING_SETTINGS = [
  'index.enabled',
  'index.exclude',
  'index.maxFileSize',
  'index.references',
];

export class CodePort {
  readonly logger: Logger;

  private readonly context: vscode.ExtensionContext;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly projects: ProjectManager;
  private readonly languages: LanguageManager;
  private readonly indexes: IndexService;
  private readonly pool: LspClientPool;
  private readonly indexResolver: IndexResolver;
  private readonly lspResolver: LspResolver;
  private readonly parserCache = new MarkdownParserCache();
  private readonly disposables: vscode.Disposable[] = [];

  private pipeline: ResolverPipeline;
  private configCache: CodePortConfig | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    const config = readConfig();

    this.logger = new Logger();
    this.logger.setLevel(config.trace);
    this.logger.section(`CodePort ${context.extension.id} activated`);

    this.adapterRegistry = createAdapterRegistry({
      clangd: {
        binaryPath: config.clangdPath,
        extraArguments: config.clangdArguments,
        compileCommandsDir: config.clangdCompileCommandsDir,
      },
    });

    this.projects = new ProjectManager({ registry: this.adapterRegistry, logger: this.logger });
    this.languages = new LanguageManager({
      registry: this.adapterRegistry,
      projects: this.projects,
      getConfig: () => this.getConfig(),
      logger: this.logger,
    });
    this.indexes = new IndexService({
      wasmDir: this.wasmDirectory(),
      getConfig: () => this.getConfig(),
      logger: this.logger,
    });

    this.pool = new LspClientPool(this.logger);
    this.lspResolver = new LspResolver({
      pool: this.pool,
      targets: this.languages,
      logger: this.logger,
    });
    this.indexResolver = new IndexResolver({
      lookup: (workspaceRoot) => this.indexes.getIndex(workspaceRoot),
      logger: this.logger,
    });

    this.pipeline = this.createPipeline();
  }

  /** Register workspace listeners and warm up the engines. */
  initialize(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) this.onConfigurationChanged(event);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.projects.invalidate();
        this.logger.trace('workspace folders changed; project cache cleared');
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.parserCache.invalidate(document.uri.toString());
      })
    );

    void offerLegacyMigration(this.context);
    this.prewarm();
  }

  /* ------------------------------ config ------------------------------ */

  getConfig(): CodePortConfig {
    if (!this.configCache) this.configCache = readConfig();
    return this.configCache;
  }

  /** Directory holding the tree-sitter WASM assets shipped in the extension. */
  private wasmDirectory(): string {
    return path.join(this.context.extensionPath, 'dist', 'wasm');
  }

  private createPipeline(): ResolverPipeline {
    const config = this.getConfig();
    return new ResolverPipeline([this.indexResolver, this.lspResolver], {
      policy: createPolicy(config.policy, {
        indexAcceptConfidence: config.indexAcceptConfidence,
      }),
      logger: this.logger,
    });
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    this.configCache = undefined;
    const config = this.getConfig();

    this.logger.setLevel(config.trace);
    this.pipeline = this.createPipeline();
    this.projects.invalidate();

    if (ADAPTER_AFFECTING_SETTINGS.some((key) => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
      const adapters = createBuiltInAdapters({
        clangd: {
          binaryPath: config.clangdPath,
          extraArguments: config.clangdArguments,
          compileCommandsDir: config.clangdCompileCommandsDir,
        },
      });
      for (const adapter of adapters) this.adapterRegistry.register(adapter);
      // Existing servers were started with the previous command line.
      void this.pool.disposeAll();
      this.logger.info('adapter configuration changed; language servers restarted on next use');
    }

    if (INDEX_AFFECTING_SETTINGS.some((key) => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
      this.indexes.reset();
      this.logger.info(`index configuration changed; index reset for ${INDEX_DIR_NAME}`);
    }
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
    const config = this.getConfig();
    const documentUri = document.uri.toString();
    const documentPath = tryUriToPath(documentUri);
    const workspaceRoot =
      this.projects.workspaceRootFor(document.uri) ??
      (documentPath ? this.projects.workspaceRootForPath(documentPath) : undefined);

    const target = this.languages.describeTarget(reference.language, documentUri);

    // Make sure the index exists *and* gets populated. Creating it is not enough:
    // an unsynced index is empty, so the first request would find nothing. This
    // also covers `index.prewarm = false`, where the build starts on first use
    // instead of at activation. Both calls are idempotent.
    if (workspaceRoot && config.indexEnabled && config.policy !== 'lsp-only') {
      await this.indexes.ensureIndex(workspaceRoot);
      void this.indexes.startInBackground(workspaceRoot);
    }

    const context: ResolveContext = {
      reference,
      documentUri,
      position: reference.range.start,
      language: target?.language ?? reference.language,
      workspaceRoot,
      isCancelled: token ? () => token.isCancellationRequested : undefined,
    };

    if (token?.isCancellationRequested) {
      return { candidates: [], results: [], durationMs: 0 };
    }
    return this.pipeline.resolve(context);
  }

  /** Adapter/project pair owning a resolved source location. */
  targetForLocation(location: Location): LspTarget | undefined {
    const filePath = tryUriToPath(location.uri);
    if (!filePath) return undefined;
    return this.languages.targetForFile(filePath);
  }

  /** `textDocument/references` at a real source location. */
  findReferences(
    target: LspTarget,
    location: Location,
    includeDeclaration: boolean
  ): Promise<Location[]> {
    return this.lspResolver.referencesAt(target, location, includeDeclaration);
  }

  /** Hover text from the language server at a real source location. */
  fetchServerHover(target: LspTarget, location: Location): Promise<string | undefined> {
    return this.lspResolver.hoverAt(target, location);
  }

  /** Adapter/project pairs for a whole workspace (used for pre-warming). */
  targetsForWorkspace(workspaceRoot: string): LspTarget[] {
    return this.languages.targetsForWorkspace(workspaceRoot);
  }

  /* -------------------------------- index -------------------------------- */

  indexStats(workspaceRoot: string): IndexStats | undefined {
    return this.indexes.getIndex(workspaceRoot)?.stats();
  }

  async rebuildIndex(workspaceRoot?: string): Promise<IndexRunStats | undefined> {
    const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showInformationMessage('CodePort: open a folder to index.');
      return undefined;
    }
    return this.indexes.rebuild(root);
  }

  /* ------------------------------ lifecycle ------------------------------ */

  private prewarm(): void {
    const config = this.getConfig();
    if (!config.enabled || !config.indexPrewarm) return;

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;

      // The index is workspace-based: it needs no build system and no compiler.
      // Gating it on project detection (a `compile_commands.json`/`.clangd`) would
      // needlessly disable indexing in projects CodePort could still navigate.
      if (config.indexEnabled) void this.indexes.startInBackground(root);

      // A language server, by contrast, is useless without a build configuration.
      const projects = this.projects.projectsInWorkspace(root);
      if (projects.length === 0) continue;

      this.logger.info(
        `project detected in ${root} (${projects.map((project) => `${project.adapterId}:${project.markers.join('+')}`).join(', ')})`
      );
      if (config.policy !== 'index-only') void this.prewarmLanguageServers(root);
    }
  }

  private async prewarmLanguageServers(workspaceRoot: string): Promise<void> {
    for (const target of this.targetsForWorkspace(workspaceRoot)) {
      try {
        await this.lspResolver.clientFor(target);
        this.logger.info(
          `language server ready: ${target.adapter.id} @ ${target.project.root}`
        );
      } catch (error) {
        this.logger.warn(
          `could not start ${target.adapter.id} for ${target.project.root}: ${(error as Error).message}`
        );
      }
    }
  }

  async dispose(): Promise<void> {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.indexes.dispose();
    this.parserCache.clear();
    await this.pool.disposeAll();
    this.logger.info('CodePort deactivated');
    this.logger.dispose();
  }
}
