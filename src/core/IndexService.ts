/**
 * `IndexService` — index lifecycle for the VS Code side.
 *
 * Owns one `SymbolIndex` per workspace root, keeps it current with a
 * `FileSystemWatcher`, and keeps the synchronous indexing loop from blocking the
 * extension host (progress is reported through the status bar).
 *
 * Failure is never fatal: if `node:sqlite`, tree-sitter or the database file are
 * unavailable, the service logs once and returns `undefined`, so CodePort simply
 * runs language-server-only.
 */

import * as vscode from 'vscode';
import path from 'node:path';
import { SymbolIndex } from '../index/SymbolIndex.ts';
import type { IndexRunStats } from '../index/Indexer.ts';
import type { CodePortConfig } from '../config.ts';
import type { Logger } from '../logger.ts';
import { DB_FILE_NAME, INDEX_DIR_NAME } from '../constants.ts';

export interface IndexServiceOptions {
  readonly wasmDir: string;
  readonly getConfig: () => CodePortConfig;
  readonly logger: Logger;
}

/** Every extension the C/C++ extractor can index. */
const SOURCE_GLOB =
  '**/*.{c,h,cc,cpp,cxx,c++,hpp,hh,hxx,h++,inl,ipp,tcc,m,mm,cu,cuh}';

/** Coalesce bursts of file-system events (a save can fire several). */
const DEBOUNCE_MS = 500;

export class IndexService {
  private readonly indexes = new Map<string, SymbolIndex>();
  private readonly starting = new Map<string, Promise<SymbolIndex | undefined>>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher[]>();
  private readonly pendingIndex = new Map<string, Set<string>>();
  private readonly pendingDelete = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly warned = new Set<string>();

  private readonly wasmDir: string;
  private readonly getConfig: () => CodePortConfig;
  private readonly logger: Logger;
  private disposed = false;

  constructor(options: IndexServiceOptions) {
    this.wasmDir = options.wasmDir;
    this.getConfig = options.getConfig;
    this.logger = options.logger;
  }

  /** The live index for a workspace root, if it has been created. */
  getIndex(workspaceRoot: string): SymbolIndex | undefined {
    const index = this.indexes.get(workspaceRoot);
    if (!index) return undefined;
    if (index.isClosed) {
      this.indexes.delete(workspaceRoot);
      return undefined;
    }
    return index;
  }

  /** All live indexes. */
  all(): Array<[string, SymbolIndex]> {
    return [...this.indexes.entries()];
  }

  /**
   * Create the index for a root if needed. Concurrent calls share one attempt;
   * a failed attempt is not cached, so a later call can retry.
   */
  async ensureIndex(workspaceRoot: string): Promise<SymbolIndex | undefined> {
    if (this.disposed) return undefined;
    const existing = this.getIndex(workspaceRoot);
    if (existing) return existing;

    const inFlight = this.starting.get(workspaceRoot);
    if (inFlight) return inFlight;

    const config = this.getConfig();
    if (!config.enabled || !config.indexEnabled) {
      this.warnOnce(
        'disabled',
        'the CodePort index is disabled by configuration; using language servers only'
      );
      return undefined;
    }

    const creation = (async (): Promise<SymbolIndex | undefined> => {
      try {
        const index = await SymbolIndex.create({
          workspaceRoot,
          wasmDir: this.wasmDir,
          exclude: config.indexExclude,
          maxFileSize: config.indexMaxFileSize,
          collectReferences: config.indexReferences,
          dbPath: path.join(workspaceRoot, INDEX_DIR_NAME, DB_FILE_NAME),
          logger: this.logger,
        });
        if (!index) {
          this.warnOnce(
            'unavailable',
            'the CodePort index is unavailable in this environment (node:sqlite or tree-sitter ' +
              'assets missing); using language servers only'
          );
          return undefined;
        }
        this.indexes.set(workspaceRoot, index);
        this.watch(workspaceRoot);
        this.logger.info(`index ready at ${index.dbPath} (languages: ${index.supportedLanguages.join(', ')})`);
        return index;
      } catch (error) {
        this.logger.warn(`failed to create index for ${workspaceRoot}: ${(error as Error).message}`);
        return undefined;
      } finally {
        this.starting.delete(workspaceRoot);
      }
    })();

    this.starting.set(workspaceRoot, creation);
    return creation;
  }

  /**
   * Create the index (if needed) and bring it up to date in the background.
   * Returns immediately after the index object exists.
   */
  async startInBackground(workspaceRoot: string): Promise<void> {
    const index = await this.ensureIndex(workspaceRoot);
    if (!index) return;

    void vscode.window.setStatusBarMessage(
      '$(sync~spin) CodePort: indexing…',
      index
        .sync((progress) => {
          if (progress.phase === 'indexing') {
            this.logger.trace(
              `indexing ${progress.filesDone}/${progress.filesTotal} (${progress.currentFile ?? ''})`
            );
          }
        })
        .then((stats) => {
          this.logger.info(
            `index synced: ${stats.indexedFiles} indexed, ${stats.unchangedFiles} unchanged, ` +
              `${stats.symbols} symbols in ${stats.durationMs} ms`
          );
        })
        .catch((error: unknown) => {
          this.logger.warn(`index sync failed: ${(error as Error).message}`);
        })
    );
  }

  /** Drop and rebuild an index with a visible progress notification. */
  async rebuild(workspaceRoot: string): Promise<IndexRunStats | undefined> {
    const index = await this.ensureIndex(workspaceRoot);
    if (!index) {
      void vscode.window.showWarningMessage(
        'CodePort: the index is unavailable, so there is nothing to rebuild. See the CodePort log.'
      );
      return undefined;
    }

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodePort: rebuilding index', cancellable: false },
      async (progress) => {
        const stats = await index.rebuild((update) => {
          const fraction =
            update.filesTotal > 0 ? update.filesDone / update.filesTotal : 0;
          progress.report({
            increment: fraction * 100,
            message:
              update.phase === 'scanning'
                ? 'scanning workspace'
                : `${update.filesDone}/${update.filesTotal} files`,
          });
        });
        return stats;
      }
    );
  }

  /* ------------------------------ watching ------------------------------ */

  private watch(workspaceRoot: string): void {
    if (this.watchers.has(workspaceRoot)) return;
    const folder = vscode.workspace.workspaceFolders?.find(
      (candidate) => candidate.uri.fsPath === workspaceRoot
    );
    if (!folder) return;

    const pattern = new vscode.RelativePattern(folder, SOURCE_GLOB);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const enqueue = (uri: vscode.Uri, deleted: boolean): void => {
      const target = deleted ? this.pendingDelete : this.pendingIndex;
      const set = target.get(workspaceRoot) ?? new Set<string>();
      set.add(uri.fsPath);
      target.set(workspaceRoot, set);
      this.scheduleFlush(workspaceRoot);
    };

    watcher.onDidCreate((uri) => enqueue(uri, false));
    watcher.onDidChange((uri) => enqueue(uri, false));
    watcher.onDidDelete((uri) => enqueue(uri, true));

    this.watchers.set(workspaceRoot, [watcher]);
    this.logger.trace(`watching ${workspaceRoot} for source changes`);
  }

  private scheduleFlush(workspaceRoot: string): void {
    const existing = this.timers.get(workspaceRoot);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(workspaceRoot);
      void this.flush(workspaceRoot);
    }, DEBOUNCE_MS);
    this.timers.set(workspaceRoot, timer);
  }

  /** Apply the queued create/change/delete events for one root. */
  private async flush(workspaceRoot: string): Promise<void> {
    if (this.disposed) return;
    const index = this.getIndex(workspaceRoot);
    const changed = this.pendingIndex.get(workspaceRoot);
    const deleted = this.pendingDelete.get(workspaceRoot);
    this.pendingIndex.delete(workspaceRoot);
    this.pendingDelete.delete(workspaceRoot);

    if (!index) return;

    try {
      if (deleted) {
        for (const filePath of deleted) index.removeFile(filePath);
        if (deleted.size > 0) this.logger.trace(`index: removed ${deleted.size} file(s)`);
      }
      if (changed && changed.size > 0) {
        // Deletions win: a file reported as changed then deleted must not be
        // re-added.
        const toIndex = [...changed].filter((filePath) => !deleted?.has(filePath));
        const stats = await index.indexPaths(toIndex);
        if (stats.indexedFiles > 0) {
          this.logger.trace(
            `index: ${stats.indexedFiles} file(s) updated, ${stats.symbols} symbol(s)`
          );
        }
      }
    } catch (error) {
      this.logger.warn(`incremental index update failed: ${(error as Error).message}`);
    }
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Discard every index so the next use recreates it (configuration changed). */
  reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pendingIndex.clear();
    this.pendingDelete.clear();
    for (const [root, index] of this.indexes) {
      index.close();
      this.logger.trace(`index closed for ${root}`);
    }
    this.indexes.clear();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const list of this.watchers.values()) {
      for (const watcher of list) watcher.dispose();
    }
    this.watchers.clear();
    for (const index of this.indexes.values()) index.close();
    this.indexes.clear();
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}
