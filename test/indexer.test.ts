import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Indexer, type IndexerOptions } from '../src/index/Indexer.ts';
import { IndexStore } from '../src/index/IndexStore.ts';
import { ExtractorRegistry } from '../src/index/SymbolExtractor.ts';
import { CppExtractor } from '../src/index/CppExtractor.ts';
import { createTestParser, silentLogger, tempDir } from './support/env.ts';

function options(root: string): IndexerOptions {
  return {
    roots: [root],
    exclude: [],
    maxFileSize: 1024 * 1024,
    collectReferences: false,
    yieldEvery: 1,
    logger: silentLogger,
  };
}

test('a throwing extractor skips its file instead of aborting the index run', async () => {
  const parser = await createTestParser();
  assert.ok(parser, 'tree-sitter assets are required for this test');
  assert.ok(await parser.load('c'));

  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bad.c'), 'int main(void) { return 0; }\n');

  const store = IndexStore.openInMemory();
  const extractors = new ExtractorRegistry();
  extractors.register({
    id: 'boom',
    languages: ['c'],
    extract() {
      // The shape of the failure a deep recursive tree walk used to produce.
      throw new RangeError('Maximum call stack size exceeded');
    },
  });

  const indexer = new Indexer(store, parser, extractors, options(dir));
  const stats = await indexer.fullIndex();

  assert.equal(stats.scannedFiles, 1);
  assert.equal(stats.skippedFiles, 1);
  assert.equal(stats.indexedFiles, 0);
  assert.equal(store.stats().files, 0, 'the failed file must not be recorded');

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('indexes a normal C file end to end', async () => {
  const parser = await createTestParser();
  assert.ok(parser, 'tree-sitter assets are required for this test');
  assert.ok(await parser.load('c'));

  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'good.c'), 'int helper(int a) { return a + 1; }\n');

  const store = IndexStore.openInMemory();
  const extractors = new ExtractorRegistry();
  extractors.register(new CppExtractor());

  const indexer = new Indexer(store, parser, extractors, options(dir));
  const stats = await indexer.fullIndex();

  assert.equal(stats.indexedFiles, 1);
  assert.ok(stats.symbols >= 1);
  assert.equal(store.queryExact({ name: 'helper' }).length, 1);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
