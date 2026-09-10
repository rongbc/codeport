import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownParser, symbolAt } from '../src/markdown/MarkdownParser.ts';
import { findInlineCodeSpans } from '../src/markdown/CodeSpan.ts';
import { findFencedBlocks, normalizeLanguage } from '../src/markdown/CodeBlock.ts';
import { splitLines } from '../src/util/text.ts';

const parser = new MarkdownParser();

test('extracts a symbol from an inline code span', () => {
  const parsed = parser.parse('Call `nx_start()` to initialise the system.');
  assert.equal(parsed.references.length, 1);
  const ref = parsed.references[0]!;
  assert.equal(ref.name, 'nx_start');
  assert.equal(ref.raw, 'nx_start');
  assert.equal(ref.called, true);
  assert.equal(ref.kindHint, 'function');
  assert.equal(ref.inline, true);
  assert.equal(ref.language, undefined);
  assert.deepEqual(ref.range, { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } });
  // codeRange covers the whole span including its backticks, which is exactly
  // the text `Insert Source Link` replaces.
  assert.deepEqual(ref.codeRange, {
    start: { line: 0, character: 5 },
    end: { line: 0, character: 17 },
  });
});

test('splits a qualified name into container and name', () => {
  const parsed = parser.parse('See `nx::Task::run` for details.');
  assert.equal(parsed.references.length, 1);
  const ref = parsed.references[0]!;
  assert.equal(ref.name, 'run');
  assert.equal(ref.container, 'nx::Task');
  assert.equal(ref.raw, 'nx::Task::run');
});

test('never mines prose for symbols', () => {
  const parsed = parser.parse('The start_worker function runs the start_worker loop.');
  assert.equal(parsed.references.length, 0);
});

test('skips file and line references so code links keep ownership', () => {
  const parsed = parser.parse('See `src/main.c:42` and `/abs/path/foo.h`.');
  assert.equal(parsed.references.length, 0);
});

test('skips URLs', () => {
  const parsed = parser.parse('Docs: `https://example.com/foo.c`');
  assert.equal(parsed.references.length, 0);
});

test('skips language keywords', () => {
  const parsed = parser.parse('```c\nfor (int i = 0; i < 10; i++) { return; }\n```');
  // `for`, `int` and `return` are keywords; only the loop variable survives.
  assert.deepEqual(
    parsed.references.map((ref) => ref.name).sort(),
    ['i', 'i', 'i']
  );
});

test('reads the fence language and marks references as block references', () => {
  const parsed = parser.parse('```cpp\nnxsched_add_readytorun(tcb);\n```\n');
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0]!.language, 'cpp');
  const ref = parsed.references.find((candidate) => candidate.name === 'nxsched_add_readytorun');
  assert.ok(ref, 'expected the call to be extracted');
  assert.equal(ref.language, 'cpp');
  assert.equal(ref.inline, false);
  assert.equal(ref.called, true);
});

test('normalises common fence languages', () => {
  assert.equal(normalizeLanguage('c++'), 'cpp');
  assert.equal(normalizeLanguage('C'), 'c');
  assert.equal(normalizeLanguage('rs'), 'rust');
  assert.equal(normalizeLanguage('ts'), 'typescript');
  assert.equal(normalizeLanguage('c {#example}'), 'c');
  assert.equal(normalizeLanguage(''), undefined);
});

test('pairs tilde fences and ignores fenced content as inline code', () => {
  const text = ['~~~c', 'first_call();', '~~~', '', 'plain `second_call()`'].join('\n');
  const parsed = parser.parse(text);
  const names = parsed.references.map((ref) => ref.name);
  assert.ok(names.includes('first_call'));
  assert.ok(names.includes('second_call'));
  const first = parsed.references.find((ref) => ref.name === 'first_call')!;
  assert.equal(first.inline, false);
  const second = parsed.references.find((ref) => ref.name === 'second_call')!;
  assert.equal(second.inline, true);
});

test('resolves the identifier under and immediately after the cursor', () => {
  const text = 'Call `nx_start()` now.';
  const parsed = parser.parse(text);
  // Cursor on `(`.
  assert.equal(symbolAt(parsed, { line: 0, character: 14 })?.name, 'nx_start');
  // Cursor on `)`.
  assert.equal(symbolAt(parsed, { line: 0, character: 15 })?.name, 'nx_start');
  // Cursor inside the identifier.
  assert.equal(symbolAt(parsed, { line: 0, character: 8 })?.name, 'nx_start');
  // Cursor in prose far away: no guess.
  assert.equal(symbolAt(parsed, { line: 0, character: 19 }), undefined);
  assert.equal(symbolAt(parsed, { line: 0, character: 0 }), undefined);
});

test('finds inline code spans with CommonMark backtick-run rules', () => {
  // `start`/`end` are the content; `openStart`/`closeEnd` include the backticks.
  assert.deepEqual(findInlineCodeSpans('a `b` c'), [
    { start: 3, end: 4, openStart: 2, closeEnd: 5 },
  ]);
  // A double-backtick span may contain a single backtick.
  assert.deepEqual(findInlineCodeSpans('``a`b``'), [
    { start: 2, end: 5, openStart: 0, closeEnd: 7 },
  ]);
  // Unterminated runs are literal text.
  assert.deepEqual(findInlineCodeSpans('a `b'), []);
  assert.deepEqual(findInlineCodeSpans('no code here'), []);
});

test('detects fenced blocks including unterminated ones', () => {
  const lines = splitLines(['```c', 'int x;', '```', 'text', '```py', 'y = 1'].join('\n'));
  const blocks = findFencedBlocks(lines);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.language, 'c');
  assert.equal(blocks[0]!.closeLine, 2);
  assert.equal(blocks[1]!.language, 'python');
  assert.equal(blocks[1]!.closeLine, undefined);
  assert.equal(blocks[1]!.contentEndLine, 5);
});

test('a backtick fence cannot be closed by a tilde fence', () => {
  const lines = splitLines(['```c', '~~~', '```'].join('\n'));
  const blocks = findFencedBlocks(lines);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.closeLine, 2);
});

test('caps a macro-looking name with a macro hint', () => {
  const parsed = parser.parse('`MAX_TASKS` is the limit.');
  const ref = parsed.references[0]!;
  assert.equal(ref.name, 'MAX_TASKS');
  assert.equal(ref.kindHint, 'macro');
  assert.equal(ref.called, false);
});
