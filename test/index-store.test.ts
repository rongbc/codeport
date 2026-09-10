import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IndexStore } from '../src/index/IndexStore.ts';
import { tempDir } from './support/env.ts';

const A_SYMBOLS = [
  { name: 'nx_start', kind: 'function' as const, line: 37, column: 5, qualifiedName: 'nx_start', signature: 'void nx_start(void)' },
  { name: 'a_b', kind: 'variable' as const, line: 1, column: 4 },
];
const B_SYMBOLS = [
  { name: 'axb', kind: 'variable' as const, line: 2, column: 4 },
  { name: 'nx_start', kind: 'function' as const, line: 3, column: 5 },
];

function seed(store: IndexStore): void {
  store.transaction(() => {
    const a = store.upsertFile({ path: '/ws/a.c', language: 'c', size: 10, mtime: 1, hash: 'ha' });
    store.replaceFileContent(a, A_SYMBOLS);
    const b = store.upsertFile({ path: '/ws/b.c', language: 'c', size: 20, mtime: 2, hash: 'hb' });
    store.replaceFileContent(b, B_SYMBOLS);
  });
}

test('node:sqlite is available in this runtime', () => {
  // The whole index engine depends on it; fail loudly rather than silently skip.
  assert.equal(IndexStore.isAvailable(), true, 'expected node:sqlite to be available');
});

test('indexes symbols and answers exact queries', () => {
  const store = IndexStore.openInMemory();
  seed(store);

  const exact = store.queryExact({ name: 'nx_start' });
  assert.equal(exact.length, 2, 'both definitions must be returned');
  assert.deepEqual(
    exact.map((hit) => hit.file).sort(),
    ['/ws/a.c', '/ws/b.c']
  );
  assert.ok(exact.every((hit) => hit.kind === 'function'));
  // Rows come back ordered by line, so look the signature up by file.
  assert.equal(exact.find((hit) => hit.file === '/ws/a.c')!.signature, 'void nx_start(void)');
  store.close();
});

test('falls back to prefix queries and escapes LIKE wildcards', () => {
  const store = IndexStore.openInMemory();
  seed(store);

  const prefix = store.queryByPrefix({ name: 'nx_' });
  assert.ok(prefix.length >= 2);

  // `a_b` must not match `axb`: the underscore is escaped, not a wildcard.
  const underscore = store.queryByPrefix({ name: 'a_' });
  assert.deepEqual(
    underscore.map((hit) => hit.name),
    ['a_b']
  );

  // `%` must be literal too.
  assert.equal(store.queryByPrefix({ name: '%' }).length, 0);
  store.close();
});

test('filters queries by language', () => {
  const store = IndexStore.openInMemory();
  seed(store);
  assert.equal(store.queryExact({ name: 'nx_start', language: 'cpp' }).length, 0);
  assert.equal(store.queryExact({ name: 'nx_start', language: 'c' }).length, 2);
  store.close();
});

test('replacing a file removes its previous symbols', () => {
  const store = IndexStore.openInMemory();
  seed(store);
  const a = store.getFile('/ws/a.c')!;
  store.replaceFileContent(a.id, [{ name: 'renamed', kind: 'function', line: 1, column: 0 }]);
  assert.equal(store.queryExact({ name: 'nx_start' }).length, 1, 'only b.c should still define it');
  assert.equal(store.queryExact({ name: 'renamed' }).length, 1);
  store.close();
});

test('prunes files that disappeared from disk', () => {
  const store = IndexStore.openInMemory();
  seed(store);
  const removed = store.pruneFiles(new Set(['/ws/a.c']));
  assert.equal(removed, 1);
  assert.equal(store.getFile('/ws/b.c'), undefined);
  assert.equal(store.queryExact({ name: 'nx_start' }).length, 1);
  store.close();
});

test('deleting a file cascades to its symbols and includes', () => {
  const store = IndexStore.openInMemory();
  const a = store.upsertFile({ path: '/ws/a.c', language: 'c', size: 1, mtime: 1, hash: 'x' });
  store.replaceFileContent(a, A_SYMBOLS, [{ name: 'helper', kind: 'call', line: 5, column: 2 }], ['stdio.h']);
  assert.equal(store.stats().includes, 1);
  assert.equal(store.stats().references, 1);
  assert.equal(store.deleteFile('/ws/a.c'), true);
  const stats = store.stats();
  assert.equal(stats.symbols, 0);
  assert.equal(stats.references, 0);
  assert.equal(stats.includes, 0);
  store.close();
});

test('links a reference to a same-file symbol when the name is known', () => {
  const store = IndexStore.openInMemory();
  const a = store.upsertFile({ path: '/ws/a.c', language: 'c', size: 1, mtime: 1, hash: 'x' });
  store.replaceFileContent(
    a,
    [{ name: 'helper', kind: 'function', line: 1, column: 5 }],
    [{ name: 'helper', kind: 'call', line: 9, column: 2 }]
  );
  assert.equal(store.stats().references, 1);
  store.close();
});

test('persists to disk and reopens', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, '.codeport', 'index.db');

  const first = IndexStore.open(dbPath);
  assert.ok(first, 'the database must open on a real filesystem');
  seed(first);
  first.close();

  assert.ok(fs.existsSync(dbPath), 'the database file must exist on disk');
  const second = IndexStore.open(dbPath);
  assert.ok(second);
  assert.equal(second.stats().files, 2);
  assert.equal(second.queryExact({ name: 'nx_start' }).length, 2);
  assert.equal(second.getMeta('schema_version'), '1');
  second.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('clears every row but keeps the schema', () => {
  const store = IndexStore.openInMemory();
  seed(store);
  store.clear();
  assert.deepEqual(store.stats().symbols, 0);
  assert.equal(store.stats().files, 0);
  // Still usable after a clear.
  seed(store);
  assert.equal(store.stats().files, 2);
  store.close();
});

test('opening a folder that does not exist is tolerated', () => {
  const dir = tempDir();
  // The store creates intermediate directories itself.
  const store = IndexStore.open(path.join(dir, 'nested', 'deeper', 'index.db'));
  assert.ok(store);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
