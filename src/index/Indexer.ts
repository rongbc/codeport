/**
 * Indexing pipeline (plan sections 8-9).
 *
 * `fullIndex` walks the workspace; `sync` re-verifies files and re-parses only
 * those whose content hash changed, which is what makes a restart cheap. A file
 * change is a delete + re-insert of that file's symbols only.
 *
 * The loop yields to the event loop every so often: tree-sitter parsing and
 * `node:sqlite` are both synchronous, so without yielding a large workspace would
 * freeze the extension host.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IndexStore } from './IndexStore.ts';
import type { SyntaxTree, TreeSitterParser } from './TreeSitterParser.ts';
import type { ExtractorRegistry, ExtractResult, SymbolExtractor } from './SymbolExtractor.ts';
import { sha1 } from '../util/text.ts';
import { languageFromPath, matchesGlob, toPosix } from '../util/path.ts';

export interface IndexerLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface IndexerOptions {
  /** Absolute directories to walk. */
  readonly roots: readonly string[];
  /** Glob patterns, relative to the workspace root, that are skipped. */
  readonly exclude: readonly string[];
  /** Glob patterns, relative to the workspace root, that are included. */
  readonly include?: readonly string[];
  readonly maxFileSize: number;
  readonly collectReferences: boolean;
  /** Files processed between event-loop yields. Default 25. */
  readonly yieldEvery?: number;
  readonly logger: IndexerLogger;
}

export interface IndexProgress {
  readonly phase: 'scanning' | 'indexing' | 'done';
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly symbols: number;
  readonly currentFile?: string;
}

export type ProgressReporter = (progress: IndexProgress) => void;

export interface IndexRunStats {
  readonly scannedFiles: number;
  readonly indexedFiles: number;
  readonly unchangedFiles: number;
  readonly skippedFiles: number;
  readonly removedFiles: number;
  readonly symbols: number;
  readonly durationMs: number;
}

const DEFAULT_YIELD_EVERY = 25;

export class Indexer {
  private readonly store: IndexStore;
  private readonly parser: TreeSitterParser;
  private readonly extractors: ExtractorRegistry;
  private readonly options: IndexerOptions;
  private readonly logger: IndexerLogger;

  constructor(
    store: IndexStore,
    parser: TreeSitterParser,
    extractors: ExtractorRegistry,
    options: IndexerOptions
  ) {
    this.store = store;
    this.parser = parser;
    this.extractors = extractors;
    this.options = options;
    this.logger = options.logger;
  }

  /** True when this file is indexable: supported language, grammar and size. */
  indexableLanguage(filePath: string): string | undefined {
    const language = languageFromPath(filePath);
    if (!language) return undefined;
    if (!this.extractors.forLanguage(language)) return undefined;
    if (!this.parser.supports(language)) return undefined;
    return language;
  }

  /** Walk the roots and return every source file CodePort can index. */
  scanFiles(): string[] {
    const found: string[] = [];
    for (const root of this.options.roots) {
      this.walk(root, root, found);
    }
    found.sort();
    return found;
  }

  private walk(dir: string, root: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Symlinks are skipped: they can form cycles and escape the workspace.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, full));

      if (entry.isDirectory()) {
        if (matchesGlob(relative, this.options.exclude)) continue;
        this.walk(full, root, out);
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchesGlob(relative, this.options.exclude)) continue;
      if (this.options.include && this.options.include.length > 0) {
        if (!matchesGlob(relative, this.options.include)) continue;
      }
      if (!this.indexableLanguage(full)) continue;
      out.push(full);
    }
  }

  /** Walk the workspace, re-parsing only what changed, and prune deleted files. */
  async fullIndex(report?: ProgressReporter): Promise<IndexRunStats> {
    const started = Date.now();
    const files = this.scanFiles();
    report?.({ phase: 'scanning', filesTotal: files.length, filesDone: 0, symbols: 0 });

    // Load every grammar we will need before entering the synchronous hot loop.
    for (const language of new Set(files.map((file) => this.indexableLanguage(file)!))) {
      await this.parser.load(language);
    }

    const removedFiles = this.store.pruneFiles(new Set(files));

    let indexedFiles = 0;
    let unchangedFiles = 0;
    let skippedFiles = 0;
    let symbols = 0;
    const yieldEvery = this.options.yieldEvery ?? DEFAULT_YIELD_EVERY;

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const outcome = this.indexFileSync(file);
      switch (outcome.status) {
        case 'indexed':
          indexedFiles++;
          symbols += outcome.symbols;
          break;
        case 'unchanged':
          unchangedFiles++;
          break;
        case 'skipped':
          skippedFiles++;
          break;
      }
      if ((i + 1) % yieldEvery === 0) {
        report?.({
          phase: 'indexing',
          filesTotal: files.length,
          filesDone: i + 1,
          symbols,
          currentFile: file,
        });
        await yieldToEventLoop();
      }
    }

    report?.({
      phase: 'done',
      filesTotal: files.length,
      filesDone: files.length,
      symbols,
    });

    const stats: IndexRunStats = {
      scannedFiles: files.length,
      indexedFiles,
      unchangedFiles,
      skippedFiles,
      removedFiles,
      symbols,
      durationMs: Date.now() - started,
    };
    this.logger.info(
      `index sync: ${stats.indexedFiles} indexed, ${stats.unchangedFiles} unchanged, ` +
        `${stats.removedFiles} removed, ${stats.symbols} symbols (${stats.durationMs} ms)`
    );
    return stats;
  }

  /** Index a specific set of files (used by the file watcher). */
  async indexPaths(paths: readonly string[], report?: ProgressReporter): Promise<IndexRunStats> {
    const started = Date.now();
    const candidates = paths.filter((file) => this.indexableLanguage(file));
    for (const language of new Set(candidates.map((file) => this.indexableLanguage(file)!))) {
      await this.parser.load(language);
    }

    let indexedFiles = 0;
    let unchangedFiles = 0;
    let skippedFiles = 0;
    let symbols = 0;
    const yieldEvery = this.options.yieldEvery ?? DEFAULT_YIELD_EVERY;

    for (let i = 0; i < candidates.length; i++) {
      const outcome = this.indexFileSync(candidates[i]!);
      if (outcome.status === 'indexed') {
        indexedFiles++;
        symbols += outcome.symbols;
      } else if (outcome.status === 'unchanged') {
        unchangedFiles++;
      } else {
        skippedFiles++;
      }
      if ((i + 1) % yieldEvery === 0) await yieldToEventLoop();
    }

    report?.({
      phase: 'done',
      filesTotal: candidates.length,
      filesDone: candidates.length,
      symbols,
    });

    return {
      scannedFiles: candidates.length,
      indexedFiles,
      unchangedFiles,
      skippedFiles,
      removedFiles: 0,
      symbols,
      durationMs: Date.now() - started,
    };
  }

  /** Index one file. Returns false when it could not be indexed. */
  async indexFile(filePath: string): Promise<boolean> {
    const language = this.indexableLanguage(filePath);
    if (!language) return false;
    await this.parser.load(language);
    return this.indexFileSync(filePath).status === 'indexed';
  }

  /** Remove a file and everything recorded for it. */
  removeFile(filePath: string): boolean {
    return this.store.deleteFile(filePath);
  }

  /**
   * Synchronous per-file work: hash check, parse, replace rows.
   * One file is one transaction, so a parse failure cannot corrupt the index.
   */
  private indexFileSync(
    filePath: string
  ): { status: 'indexed'; symbols: number } | { status: 'unchanged' } | { status: 'skipped' } {
    const language = this.indexableLanguage(filePath);
    if (!language) return { status: 'skipped' };

    let stat: fs.Stats;
    let text: string;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) return { status: 'skipped' };
      if (stat.size > this.options.maxFileSize) return { status: 'skipped' };
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { status: 'skipped' };
    }

    const hash = sha1(text);
    const existing = this.store.getFile(filePath);
    if (existing && existing.hash === hash && existing.size === stat.size) {
      return { status: 'unchanged' };
    }

    const tree = this.parser.parse(language, text);
    if (!tree) return { status: 'skipped' };
    const extractor = this.extractors.forLanguage(language);
    if (!extractor) return { status: 'skipped' };

    const result = this.extractSymbols(extractor, tree, language, filePath);
    if (!result) return { status: 'skipped' };

    this.store.transaction(() => {
      const fileId = this.store.upsertFile({
        path: filePath,
        language,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        hash,
      });
      this.store.replaceFileContent(fileId, result.symbols, result.references, result.includes);
    });

    return { status: 'indexed', symbols: result.symbols.length };
  }

  /**
   * Run the extractor defensively: one pathological file (a deeply nested
   * generated header, say) must be skipped, never allowed to abort the whole
   * rebuild and surface as a command error.
   */
  private extractSymbols(
    extractor: SymbolExtractor,
    tree: SyntaxTree,
    language: string,
    filePath: string
  ): ExtractResult | undefined {
    try {
      return extractor.extract(tree, language, { references: this.options.collectReferences });
    } catch (error) {
      this.logger.warn(
        `skipping ${filePath}: symbol extraction failed (${(error as Error).message})`
      );
      return undefined;
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
