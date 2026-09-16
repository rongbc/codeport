/** Path helpers for Markdown link targets. */

import path from 'node:path';

/** Normalise to forward slashes, so link targets are stable across platforms. */
function toPosix(p: string): string {
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
