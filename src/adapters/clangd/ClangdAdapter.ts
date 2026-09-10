/**
 * clangd adapter — the first and, for now, only shipped adapter.
 *
 * Owns everything clangd-specific that used to live inside `extension.js`:
 * binary discovery, command-line arguments, and the seed file used to wake
 * clangd's background indexer.
 *
 * Known clangd behaviour this preserves: clangd 15's background indexer stays
 * idle until a file is opened (measured: no indexing after 5 minutes without a
 * `didOpen`; roughly 20 seconds to a full index afterwards), so the adapter
 * opens a file from `compile_commands.json` right after the handshake.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LanguageAdapter, type SeedFile } from '../LanguageAdapter.ts';
import type { LspServerSpec } from '../../lsp/LspClient.ts';
import type { ProjectDetector } from '../../project/ProjectDetector.ts';
import type { Project } from '../../project/Project.ts';
import { CppProjectDetector } from '../../project/detectors/CppProjectDetector.ts';

export interface ClangdAdapterOptions {
  /** `codeport.clangd.path`; empty means auto-detect. */
  readonly binaryPath?: string;
  /** `codeport.clangd.arguments`, appended verbatim. */
  readonly extraArguments?: readonly string[];
  /** `codeport.clangd.compileCommandsDir`; empty means auto-detect. */
  readonly compileCommandsDir?: string;
  /** Directories probed for a `clangd` binary, beyond the defaults. */
  readonly searchPaths?: readonly string[];
  /** `-j` value passed to clangd. Default 4. */
  readonly jobs?: number;
  /** Max `workspace/symbol` hits kept. Default 10, matching the old extension. */
  readonly maxSymbolResults?: number;
}

/** Default locations probed when `codeport.clangd.path` is empty. */
const DEFAULT_CLANGD_CANDIDATES = [
  '/usr/local/bin/clangd',
  '/usr/bin/clangd',
  '/opt/homebrew/bin/clangd',
];

export class ClangdAdapter extends LanguageAdapter {
  readonly id = 'clangd';
  readonly displayName = 'clangd (C/C++)';
  readonly languages = ['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda-cpp'];
  readonly detector: ProjectDetector;

  private readonly options: ClangdAdapterOptions;
  private readonly jobs: number;
  private cachedBinary: string | undefined;

  constructor(options: ClangdAdapterOptions = {}) {
    super();
    this.options = options;
    this.jobs = options.jobs ?? 4;
    this.maxSymbolResults = options.maxSymbolResults ?? 10;
    this.detector = new CppProjectDetector({ compileCommandsDir: options.compileCommandsDir });
  }

  /**
   * Locate clangd: explicit config, then versioned LLVM directories
   * (newest first), then well-known prefixes, then bare `clangd` on PATH.
   */
  findBinary(): string {
    if (this.cachedBinary) return this.cachedBinary;
    const explicit = this.options.binaryPath;
    if (explicit && fileExists(explicit)) {
      this.cachedBinary = explicit;
      return explicit;
    }

    const candidates = [
      ...llvmVersionedBinaries(),
      ...(this.options.searchPaths ?? []),
      ...DEFAULT_CLANGD_CANDIDATES,
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) {
        this.cachedBinary = candidate;
        return candidate;
      }
    }
    // Let the OS resolve it from PATH; `spawn` reports ENOENT if missing.
    this.cachedBinary = 'clangd';
    return this.cachedBinary;
  }

  override languageId(language: string): string {
    switch (language.toLowerCase()) {
      case 'cuda-cpp':
        return 'cuda';
      case 'objective-cpp':
        return 'objective-cpp';
      default:
        return language.toLowerCase();
    }
  }

  serverSpec(project: Project): LspServerSpec {
    const binary = this.findBinary();
    const compileCommandsDir = this.compileCommandsDirFor(project);
    const args = [
      `--compile-commands-dir=${compileCommandsDir}`,
      '--background-index',
      '--header-insertion=never',
      '--log=error',
      `-j=${this.jobs}`,
      ...(this.options.extraArguments ?? []),
    ];
    return { command: binary, args, cwd: project.root, label: 'clangd' };
  }

  /**
   * Open a few files that `compile_commands.json` already knows about, which is
   * what actually makes clangd start building its background index.
   */
  seedFiles(project: Project, limit = 3): readonly SeedFile[] {
    const dir = this.compileCommandsDirFor(project);
    const databasePath = path.join(dir, 'compile_commands.json');
    let entries: unknown;
    try {
      entries = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];

    const seeds: SeedFile[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const file = (entry as { file?: unknown })?.file;
      if (typeof file !== 'string' || seen.has(file)) continue;
      seen.add(file);
      if (!fileExists(file)) continue;
      seeds.push({ path: file, languageId: seedLanguageId(file) });
      if (seeds.length >= limit) break;
    }
    return seeds;
  }

  private compileCommandsDirFor(project: Project): string {
    return project.compileCommandsDir ?? project.root;
  }
}

function seedLanguageId(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.c':
      return 'c';
    case '.m':
      return 'objective-c';
    case '.mm':
      return 'objective-cpp';
    case '.cu':
    case '.cuh':
      return 'cuda';
    default:
      return 'cpp';
  }
}

function fileExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Versioned LLVM install locations, newest LLVM version first. */
function llvmVersionedBinaries(): string[] {
  const base = '/usr/lib';
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^llvm-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)))
    .map((name) => path.join(base, name, 'bin', 'clangd'))
    .filter(fileExists);
}
