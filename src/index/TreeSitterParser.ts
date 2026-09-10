/**
 * Tree-sitter parsing for the CodePort index (plan section 5).
 *
 * Uses the WASM build of tree-sitter (`@vscode/tree-sitter-wasm`), which runs in
 * a plain extension host with no native compilation, no `electron-rebuild` and no
 * ABI coupling to VS Code's Node version.
 *
 * Grammars are resolved lazily and *optionally*: a language whose `.wasm` was not
 * shipped is simply unsupported, and the caller falls back to LSP. This keeps the
 * design honest about "Tree-sitter extracts structure, the language server
 * resolves semantics".
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeLanguageId } from '../util/language.ts';

/* --------------------------- syntax tree shape --------------------------- */

export interface SyntaxPosition {
  readonly row: number;
  readonly column: number;
}

/**
 * The slice of tree-sitter's `Node` API CodePort uses. Declared structurally so
 * extractors can be unit-tested with hand-built trees.
 */
export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: SyntaxPosition;
  readonly endPosition: SyntaxPosition;
  readonly namedChildren: readonly SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

export interface SyntaxTree {
  readonly rootNode: SyntaxNode;
  readonly text: string;
}

/* ------------------------------ grammars ------------------------------ */

/**
 * Language -> grammar file. The C++ grammar is a superset of C, so `c` and the
 * Objective-C variants reuse it; `@vscode/tree-sitter-wasm` ships no plain C
 * grammar.
 */
export const DEFAULT_GRAMMARS: Readonly<Record<string, string>> = {
  c: 'tree-sitter-cpp.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  'objective-c': 'tree-sitter-cpp.wasm',
  'objective-cpp': 'tree-sitter-cpp.wasm',
  'cuda-cpp': 'tree-sitter-cpp.wasm',
  rust: 'tree-sitter-rust.wasm',
  go: 'tree-sitter-go.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-typescript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
};

export interface TreeSitterLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TreeSitterParserOptions {
  /** Directory holding `tree-sitter.js`, `tree-sitter.wasm` and the grammars. */
  readonly wasmDir: string;
  readonly grammars?: Readonly<Record<string, string>>;
  readonly logger?: TreeSitterLogger;
}

/* --------------------------- runtime bindings --------------------------- */

interface TsParser {
  setLanguage(language: unknown): void;
  parse(text: string): { rootNode: unknown } | null;
}

interface TsRuntime {
  Parser: {
    new (): TsParser;
    init(options?: { locateFile?: (name: string) => string }): Promise<void>;
  };
  Language: { load(wasmPath: string): Promise<unknown> };
}

const lazyRequire = createRequire(path.join(process.cwd(), 'codeport-runtime.cjs'));

/* -------------------------------- parser -------------------------------- */

export class TreeSitterParser {
  private readonly runtime: TsRuntime;
  private readonly wasmDir: string;
  private readonly grammars: Readonly<Record<string, string>>;
  private readonly logger: TreeSitterLogger;
  private readonly parsers = new Map<string, TsParser>();
  private readonly available: Set<string>;

  private constructor(
    runtime: TsRuntime,
    wasmDir: string,
    grammars: Readonly<Record<string, string>>,
    available: Set<string>,
    logger: TreeSitterLogger
  ) {
    this.runtime = runtime;
    this.wasmDir = wasmDir;
    this.grammars = grammars;
    this.available = available;
    this.logger = logger;
  }

  /**
   * Load the runtime and discover which grammars are present.
   * Returns `undefined` when tree-sitter cannot be used at all, so the index can
   * disable itself instead of failing extension activation.
   */
  static async create(options: TreeSitterParserOptions): Promise<TreeSitterParser | undefined> {
    const logger = options.logger ?? { info() {}, warn() {} };
    const runtimePath = path.join(options.wasmDir, 'tree-sitter.js');
    if (!fs.existsSync(runtimePath)) {
      logger.warn(`tree-sitter runtime not found at ${runtimePath}; index disabled`);
      return undefined;
    }

    const grammars = normalizeGrammarKeys(options.grammars ?? DEFAULT_GRAMMARS);
    const available = new Set<string>();
    for (const [language, file] of Object.entries(grammars)) {
      if (fs.existsSync(path.join(options.wasmDir, file))) available.add(language);
    }
    if (available.size === 0) {
      logger.warn(`no tree-sitter grammar found in ${options.wasmDir}; index disabled`);
      return undefined;
    }

    let runtime: TsRuntime;
    try {
      runtime = lazyRequire(runtimePath) as TsRuntime;
      await runtime.Parser.init({
        locateFile: (name: string) => path.join(options.wasmDir, name),
      });
    } catch (error) {
      logger.warn(`failed to initialise tree-sitter: ${(error as Error).message}; index disabled`);
      return undefined;
    }

    logger.info(
      `tree-sitter ready (${available.size} grammar(s): ${[...available].sort().join(', ')})`
    );
    return new TreeSitterParser(runtime, options.wasmDir, grammars, available, logger);
  }

  /** Languages with a grammar present on disk. */
  get availableLanguages(): string[] {
    return [...this.available];
  }

  supports(language: string | undefined): boolean {
    const normalized = normalizeLanguageId(language ?? '');
    return normalized !== undefined && this.available.has(normalized);
  }

  /** Load a grammar on first use. Returns false when unsupported/unloadable. */
  async load(language: string): Promise<boolean> {
    const normalized = normalizeLanguageId(language);
    if (!normalized) return false;
    if (this.parsers.has(normalized)) return true;
    const file = this.grammars[normalized];
    if (!file || !this.available.has(normalized)) return false;

    try {
      const loaded = await this.runtime.Language.load(path.join(this.wasmDir, file));
      const parser = new this.runtime.Parser();
      parser.setLanguage(loaded);
      this.parsers.set(normalized, parser);
      return true;
    } catch (error) {
      this.logger.warn(`failed to load grammar for ${normalized}: ${(error as Error).message}`);
      this.available.delete(normalized);
      return false;
    }
  }

  /**
   * Parse synchronously. The grammar must have been loaded with {@link load}
   * first — the indexer does this once per language, keeping the hot loop sync.
   */
  parse(language: string, text: string): SyntaxTree | undefined {
    const normalized = normalizeLanguageId(language);
    if (!normalized) return undefined;
    const parser = this.parsers.get(normalized);
    if (!parser) return undefined;
    try {
      const tree = parser.parse(text);
      if (!tree) return undefined;
      return { rootNode: tree.rootNode as SyntaxNode, text };
    } catch (error) {
      this.logger.warn(`failed to parse as ${normalized}: ${(error as Error).message}`);
      return undefined;
    }
  }
}

function normalizeGrammarKeys(
  grammars: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [language, file] of Object.entries(grammars)) {
    out[normalizeLanguageId(language) ?? language] = file;
  }
  return out;
}
