/**
 * `compile_commands.json` membership — the build signal.
 *
 * CodeGraph's graph is a *static* view of a whole tree, and the tree contains one
 * `up_allocate_heap` definition per chip. Nothing in the graph knows which of
 * them the current build actually compiles, so several candidates are perfectly
 * tied and the order between them falls back to `(file_path, start_line)` — a
 * property of the code, not of the build. A compilation database does know: it is
 * the exact list of translation units one build compiles, written by `bear -- make`,
 * CMake's `CMAKE_EXPORT_COMPILE_COMMANDS`, `ninja -t compdb`, and friends.
 *
 * This signal is deliberately narrow, and it is an **optimization, not a filter**:
 *
 * - It only ever **adds** evidence. Notes are where platforms get compared, so a
 *   note legitimately mentions symbols the current `.config` does not build
 *   (another board, another arch, `sim:nsh`). Demoting or dropping those
 *   candidates would break exactly the jumps CodePort exists for.
 * - It is **C/C++ only**, because a compilation database is a C/C++ concept. A
 *   database that also lists generated assembly or a mixed-language project must
 *   not silently reorder symbols of other languages.
 * - Failure is never an error. No database, unreadable JSON, a database left over
 *   from another platform: no signal, and the jump behaves exactly as before.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The file name every generator agrees on. */
export const COMPILE_COMMANDS_FILE = 'compile_commands.json';

/** Directory names a one-level child scan never descends into. */
const SKIP_DIRECTORIES = new Set(['node_modules']);

/** A parsed database, reduced to the question the resolver asks of it. */
export interface CompileCommandsDb {
  /** Absolute path of the JSON this came from, for the log and the hover. */
  readonly path: string;
  /** Number of distinct translation units, for the log. */
  readonly count: number;
  /** True when `file` is one of the build's translation units. */
  has(file: string): boolean;
}

interface CachedDb {
  readonly mtimeMs: number;
  readonly size: number;
  readonly db: CompileCommandsDb | undefined;
}

/**
 * Comparison key for a path.
 *
 * Purely a case-folding choice: the same file reached through a differently
 * cased path is still the same file on Windows and (by default) macOS.
 */
function pathKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/** True when `candidate` is `parent` or lives below it. */
function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Read and reduce one database. Every failure answers `undefined`. */
function parseCompileCommands(file: string): CompileCommandsDb | undefined {
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }

  if (!Array.isArray(entries)) return undefined;

  const base = path.dirname(file);
  const units = new Set<string>();

  for (const entry of entries) {
    const record = entry as { file?: unknown; directory?: unknown } | null;
    if (!record || typeof record.file !== 'string') continue;
    const directory = typeof record.directory === 'string' ? record.directory : base;
    // `file` is absolute in most generators and relative to `directory` in the
    // ones that follow the specification literally, so resolve against both.
    units.add(pathKey(path.resolve(base, directory, record.file)));
  }

  // A database that lists nothing is a database that says nothing.
  if (units.size === 0) return undefined;

  return {
    path: path.resolve(file),
    count: units.size,
    has: (candidate: string) => units.has(pathKey(candidate)),
  };
}

/**
 * Discover and cache compilation databases.
 *
 * Discovery is deliberately not cached — it is a handful of `existsSync` calls
 * against user-paced events (a jump, a hover) — while **parsing** is, because a
 * real database is megabytes. The parse cache is invalidated by the file's
 * mtime and size, so re-running `bear -- make` after a platform switch is picked
 * up without a window reload.
 */
export class CompileCommandsIndex {
  private readonly cache = new Map<string, CachedDb>();

  /**
   * The database that governs `fromDir`: the nearest `compile_commands.json` at
   * or above it, plus — when the directory is the workspace root itself — one
   * level below it, which is how a build directory (`nuttx/`, `build/`) is found
   * without guessing project layout. The search never leaves `root`: a note can
   * sit behind a symlink (this repository links `note/` outside the workspace),
   * and `/compile_commands.json` is not this project's build.
   */
  find(fromDir: string, root: string): CompileCommandsDb | undefined {
    const stop = path.resolve(root);
    let current = path.resolve(fromDir);

    for (;;) {
      const found = this.databaseIn(current, current === stop);
      if (found) return found;
      if (current === stop || !isInside(current, stop)) return undefined;

      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  /** Forget every parsed database. Tests, and workspace-folder changes. */
  clear(): void {
    this.cache.clear();
  }

  private databaseIn(dir: string, scanChildren: boolean): CompileCommandsDb | undefined {
    const direct = this.read(path.join(dir, COMPILE_COMMANDS_FILE));
    if (direct) return direct;
    if (!scanChildren) return undefined;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    // Sorted, so two builds in one workspace never alternate between jumps.
    const names = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !SKIP_DIRECTORIES.has(entry.name)
      )
      .map((entry) => entry.name)
      .sort();

    for (const name of names) {
      const nested = this.read(path.join(dir, name, COMPILE_COMMANDS_FILE));
      if (nested) return nested;
    }
    return undefined;
  }

  private read(file: string): CompileCommandsDb | undefined {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      return undefined;
    }
    if (!stats.isFile()) return undefined;

    const key = pathKey(file);
    const cached = this.cache.get(key);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.db;
    }

    const db = parseCompileCommands(file);
    this.cache.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, db });
    return db;
  }
}

/** The process-wide index. One database set per workspace is all a workspace has. */
export const compileCommands = new CompileCommandsIndex();
