/** Path helpers plus the tiny glob matcher used by the indexer's exclude list. */

import path from 'node:path';

/** Extensions CodePort can index / follow. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  '.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++',
  '.inl', '.ipp', '.tcc', '.m', '.mm', '.cu', '.cuh',
];

/** Mapping from extension to CodePort language id. */
export function languageFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.c':
      return 'c';
    case '.h':
      // Headers are ambiguous; the C++ grammar is a superset, so treat them as C++.
      return 'cpp';
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.c++':
    case '.hpp':
    case '.hh':
    case '.hxx':
    case '.h++':
    case '.inl':
    case '.ipp':
    case '.tcc':
      return 'cpp';
    case '.m':
      return 'objective-c';
    case '.mm':
      return 'objective-cpp';
    case '.cu':
    case '.cuh':
      return 'cuda-cpp';
    default:
      return undefined;
  }
}

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/** Normalise to forward slashes so index keys are stable across platforms. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Build a relative Markdown link target (always POSIX separators, URL-ish).
 * `fromFile` is the Markdown file, `toFile` the resolved source file.
 */
export function relativeLinkPath(fromFile: string, toFile: string): string {
  const rel = path.relative(path.dirname(fromFile), toFile);
  return toPosix(rel);
}

/** Compile a glob (`**`, `*`, `?`) into a regular expression. */
export function compileGlob(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      const isDoubleStar = pattern[i + 1] === '*';
      if (isDoubleStar) {
        // `**/` may match nothing, so `**/foo` also matches a top-level `foo`.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '/') {
      re += '/';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map<string, RegExp>();

function cachedGlob(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    re = compileGlob(pattern);
    globCache.set(pattern, re);
  }
  return re;
}

/** True when the (workspace-relative, posix) path matches any pattern. */
export function matchesGlob(relPath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => cachedGlob(pattern).test(relPath));
}

/** True when the path or one of its ancestors matches any pattern. */
export function isExcluded(absPath: string, workspaceRoot: string, patterns: readonly string[]): boolean {
  const rel = toPosix(path.relative(workspaceRoot, absPath));
  if (rel.startsWith('..')) return false;
  return matchesGlob(rel, patterns);
}
