/**
 * `SymbolIndex` — the per-workspace facade over the CodePort index.
 *
 * Owns the SQLite store, the tree-sitter parser, the extractor registry and the
 * indexer, and exposes the two operations the resolver layer needs: `query` for
 * lookups and `sync` / `indexPaths` / `removeFile` for keeping the index current.
 *
 * The index is a cache: `.codeport/index.db` can always be deleted and rebuilt
 * from the sources, which is also the migration strategy when the schema changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { IndexStore, type IndexStats, type SymbolHit } from './IndexStore.ts';
import { TreeSitterParser } from './TreeSitterParser.ts';
import { ExtractorRegistry } from './SymbolExtractor.ts';
import { CppExtractor } from './CppExtractor.ts';
import { Indexer, type IndexProgress, type IndexRunStats, type ProgressReporter } from './Indexer.ts';

export interface SymbolIndexLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface SymbolIndexOptions {
  /** Workspace folder this index belongs to. */
  readonly workspaceRoot: string;
  /** Directory holding the tree-sitter WASM runtime and grammars. */
  readonly wasmDir: string;
  readonly exclude: readonly string[];
  readonly include?: readonly string[];
  readonly maxFileSize: number;
  readonly collectReferences: boolean;
  /** Defaults to `<workspaceRoot>/.codeport/index.db`. */
  readonly dbPath?: string;
  readonly logger: SymbolIndexLogger;
}

export interface IndexLookupResult {
  readonly hits: readonly SymbolHit[];
  readonly match: 'exact' | 'prefix' | 'none';
}

export interface IndexQueryOptions {
  readonly language?: string;
  readonly limit?: number;
}

const DEFAULT_QUERY_LIMIT = 50;

export class SymbolIndex {
  private readonly store: IndexStore;
  private readonly indexer: Indexer;
  private readonly parser: TreeSitterParser;
  readonly workspaceRoot: string;
  readonly dbPath: string;
  private closed = false;
  /** True once a full sync/rebuild completed in this session. */
  private synced = false;

  private constructor(
    store: IndexStore,
    indexer: Indexer,
    parser: TreeSitterParser,
    workspaceRoot: string,
    dbPath: string
  ) {
    this.store = store;
    this.indexer = indexer;
    this.parser = parser;
    this.workspaceRoot = workspaceRoot;
    this.dbPath = dbPath;
  }

  /**
   * Build an index for a workspace. Returns `undefined` when the host cannot run
   * the index (no `node:sqlite`, no tree-sitter assets), in which case CodePort
   * keeps working through language servers alone.
   */
  static async create(options: SymbolIndexOptions): Promise<SymbolIndex | undefined> {
    if (!IndexStore.isAvailable()) {
      options.logger.warn(
        'node:sqlite is unavailable in this VS Code/Node version; the CodePort index is disabled'
      );
      return undefined;
    }

    const dbPath = options.dbPath ?? path.join(options.workspaceRoot, '.codeport', 'index.db');
    ensureIndexDirectory(dbPath);

    const store = IndexStore.open(dbPath);
    if (!store) {
      options.logger.warn(`failed to open index database at ${dbPath}; index disabled`);
      return undefined;
    }

    const parser = await TreeSitterParser.create({
      wasmDir: options.wasmDir,
      logger: options.logger,
    });
    if (!parser) {
      store.close();
      return undefined;
    }

    const extractors = new ExtractorRegistry();
    extractors.register(new CppExtractor());

    const indexer = new Indexer(store, parser, extractors, {
      roots: [options.workspaceRoot],
      exclude: options.exclude,
      include: options.include,
      maxFileSize: options.maxFileSize,
      collectReferences: options.collectReferences,
      logger: options.logger,
    });

    return new SymbolIndex(store, indexer, parser, options.workspaceRoot, dbPath);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Languages this index can actually extract symbols for. */
  get supportedLanguages(): string[] {
    return this.parser.availableLanguages;
  }

  /**
   * Look a name up: exact matches first, then a bounded prefix search.
   * The returned `match` tag feeds the resolver's confidence scoring.
   */
  query(name: string, options: IndexQueryOptions = {}): IndexLookupResult {
    if (this.closed || !name) return { hits: [], match: 'none' };
    const limit = options.limit ?? DEFAULT_QUERY_LIMIT;

    const exact = this.store.queryExact({ name, language: options.language, limit });
    if (exact.length > 0) return { hits: exact, match: 'exact' };

    const prefix = this.store.queryByPrefix({ name, language: options.language, limit });
    if (prefix.length > 0) return { hits: prefix, match: 'prefix' };

    return { hits: [], match: 'none' };
  }

  /** Re-walk the workspace, re-indexing only changed files. */
  /**
   * Whether this index has completed a full sync. A freshly opened database that
   * already holds rows still reports `false`: the on-disk contents may be stale,
   * so a cheap hash-comparison pass is still owed before results are trusted.
   */
  get hasSynced(): boolean {
    return this.synced;
  }

  /** Re-walk the workspace, re-indexing only changed files. */
  async sync(report?: ProgressReporter): Promise<IndexRunStats> {
    const stats = await this.indexer.fullIndex(report);
    this.synced = true;
    return stats;
  }

  /** Drop every row and rebuild from scratch. */
  async rebuild(report?: ProgressReporter): Promise<IndexRunStats> {
    if (!this.closed) this.store.clear();
    this.synced = false;
    const stats = await this.indexer.fullIndex(report);
    this.synced = true;
    return stats;
  }

  /** Incrementally (re)index specific files, e.g. from a file watcher. */
  indexPaths(paths: readonly string[], report?: ProgressReporter): Promise<IndexRunStats> {
    return this.indexer.indexPaths(paths, report);
  }

  /** Index a single file. */
  indexFile(filePath: string): Promise<boolean> {
    return this.indexer.indexFile(filePath);
  }

  /** Forget a deleted file. */
  removeFile(filePath: string): boolean {
    if (this.closed) return false;
    return this.indexer.removeFile(filePath);
  }

  /** True when this index would handle the given file. */
  canIndex(filePath: string): boolean {
    return this.indexer.indexableLanguage(filePath) !== undefined;
  }

  stats(): IndexStats {
    return this.closed
      ? { files: 0, symbols: 0, references: 0, includes: 0, schemaVersion: 0 }
      : this.store.stats();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }
}

/** Create `.codeport/` plus a `.gitignore` so the cache never gets committed. */
function ensureIndexDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (path.basename(dir) === '.codeport') {
      const gitignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(gitignore)) {
        fs.writeFileSync(gitignore, '# CodePort local index — regenerated automatically\n*\n');
      }
    }
  } catch {
    /* The store will surface a real failure when it tries to open the file. */
  }
}

export type { IndexProgress, IndexRunStats };
