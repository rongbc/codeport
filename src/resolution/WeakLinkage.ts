/**
 * Weak linkage detection — the tie-break the linker itself applies.
 *
 * `up_allocate_heap` is the canonical shape: a generic per-arch default declared
 * `weak_function` (NuttX's spelling of `__attribute__((weak))`) plus one chip
 * override with strong linkage. Both are translation units of the same build, so
 * membership in `compile_commands.json` cannot separate them — but the linker can,
 * because a strong definition overrides a weak one. In a graph built without a
 * preprocessor and without a link step, the definition's own source line is the
 * only place that fact exists.
 *
 * Deliberately narrow, because this decides which candidate survives:
 *
 * - **Only the exact line the graph points at is read.** A marker written on its
 *   own line above the signature is *missed* on purpose: a miss costs a Peek list,
 *   while a false positive would silently hide the right answer.
 * - **The marker must appear before the symbol's own name, on that line.** That is
 *   where linkage lives, so `void f(int weak)` is not read as link-time weakness,
 *   and a line that does not carry the name at all counts as unknown, not weak.
 * - **Anything unreadable is "not known to be weak".** A missing file, a binary
 *   file, an index that points past the end: the caller keeps the candidate.
 */

import fs from 'node:fs';

/**
 * Spellings C code actually uses. `__attribute__((weak))` and `WEAK` are covered
 * by the bare word; `weak_function` needs its own alternative because `_` is a
 * word character and would defeat the boundary after `weak`.
 */
const WEAK_MARKER = /\bweak(_function)?\b|\bweak\b/i;

/** How many parsed files to remember. Hovers are user-paced; this is plenty. */
const MAX_CACHED_FILES = 32;

interface CachedLines {
  readonly mtimeMs: number;
  readonly size: number;
  readonly lines: readonly string[];
}

const cache = new Map<string, CachedLines>();

/**
 * True when the definition at `line` (0-based) carries a weak-linkage marker.
 *
 * `symbolName` is required rather than optional: the "marker before the name"
 * rule is what keeps a parameter called `weak` from being misread as linkage.
 */
export function isWeakDefinition(file: string, line: number, symbolName: string): boolean {
  const text = lineAt(file, line);
  if (text === undefined) return false;

  // Only the part of the line in front of the name counts: that is where linkage
  // is written, and it keeps `void f(int weak)` out. A line that does not carry
  // the name at all is not a definition line we understand, so it is "unknown"
  // rather than "weak".
  const nameAt = text.indexOf(symbolName);
  if (nameAt === -1) return false;
  return WEAK_MARKER.test(text.slice(0, nameAt));
}

/** Forget every cached file. Tests. */
export function clearWeakLinkageCache(): void {
  cache.clear();
}

function lineAt(file: string, line: number): string | undefined {
  if (line < 0) return undefined;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;

  let entry = cache.get(file);
  if (entry && entry.mtimeMs === stats.mtimeMs && entry.size === stats.size) {
    // Refresh the insertion order so the LRU eviction below drops colder files.
    cache.delete(file);
  } else {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    entry = { mtimeMs: stats.mtimeMs, size: stats.size, lines: text.split('\n') };
  }

  cache.set(file, entry);
  while (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }

  return entry.lines[line];
}
