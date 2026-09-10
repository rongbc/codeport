/** Text helpers: line/offset conversion, ranges and identifier classification. */

import { createHash } from 'node:crypto';
import type { Position, Range } from '../types.ts';

/** Character offsets at which each line starts. Index `i` is the start of line `i`. */
export function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) offsets.push(i + 1);
  }
  return offsets;
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Convert an absolute character offset into a zero-based Position. */
export function positionAt(text: string, offsets: readonly number[], offset: number): Position {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - offsets[low]! };
}

/** Convert a zero-based Position into an absolute character offset. */
export function offsetAt(text: string, offsets: readonly number[], position: Position): number {
  const line = Math.max(0, Math.min(position.line, offsets.length - 1));
  return Math.min(offsets[line]! + position.character, text.length);
}

export function rangeFromOffsets(
  text: string,
  offsets: readonly number[],
  start: number,
  end: number
): Range {
  return { start: positionAt(text, offsets, start), end: positionAt(text, offsets, end) };
}

/**
 * Identifiers that are never worth resolving. A merged superset of the common
 * C/C++/Rust/Go/TypeScript/Python keywords plus C literals.
 */
const KEYWORDS = new Set([
  // C / C++
  'alignas', 'alignof', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'char16_t',
  'char32_t', 'class', 'const', 'constexpr', 'const_cast', 'continue', 'decltype',
  'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit',
  'export', 'extern', 'false', 'final', 'float', 'for', 'friend', 'goto', 'if',
  'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'nullptr',
  'operator', 'override', 'private', 'protected', 'public', 'register',
  'reinterpret_cast', 'return', 'short', 'signed', 'sizeof', 'static',
  'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this',
  'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename',
  'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while',
  // Rust
  'as', 'async', 'await', 'crate', 'dyn', 'fn', 'impl', 'let', 'loop', 'match',
  'mod', 'move', 'mut', 'pub', 'ref', 'self', 'Self', 'static', 'super', 'trait',
  'unsafe', 'where', 'yield',
  // Go
  'chan', 'defer', 'fallthrough', 'func', 'go', 'interface', 'map', 'package',
  'range', 'select', 'var',
  // TypeScript / JavaScript
  'abstract', 'any', 'boolean', 'constructor', 'declare', 'extends', 'implements',
  'import', 'instanceof', 'keyof', 'never', 'readonly', 'require', 'string',
  'symbol', 'typeof', 'undefined', 'unknown', 'yield', 'console',
  // Python
  'def', 'elif', 'except', 'finally', 'from', 'global', 'lambda', 'nonlocal',
  'pass', 'raise', 'with', 'None', 'True', 'False', 'print',
  // Preprocessor / misc noise
  'define', 'include', 'ifdef', 'ifndef', 'endif', 'pragma', 'NULL',
]);

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word);
}

/** A `sha1` digest, used as the content hash of an indexed file. */
export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** `true` when the character can start/continue a C-like identifier. */
export function isIdentifierChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_]/.test(ch);
}

/** Collapse a signature onto one line and trim excessive length. */
export function oneLine(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}
