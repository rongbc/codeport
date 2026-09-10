import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeSitterParser } from '../src/index/TreeSitterParser.ts';
import { CppExtractor } from '../src/index/CppExtractor.ts';
import { ExtractorRegistry } from '../src/index/SymbolExtractor.ts';
import { createTestParser, silentLogger } from './support/env.ts';

const SAMPLE = `#include <stdio.h>
#include "local.h"

#define MAX_ITEMS 32
#define SQUARE(x) ((x)*(x))

typedef struct Node {
    int value;
    struct Node *next;
} Node;

enum Color { RED, GREEN = 2, BLUE };

namespace nx {

class Task {
public:
    Task();
    void run(int depth);
    int priority;
private:
    int hidden_;
};

void Task::run(int depth) {
    helper(depth);
}

static int helper(int a);

int global_counter = 0;

}

static int helper(int a) {
    return a + 1;
}

void nx_start(void) {
    helper(1);
    nx::Task *task = new nx::Task();
    task->run(2);
}
`;

async function extractSample(options?: { references?: boolean }) {
  const parser = await createTestParser();
  assert.ok(parser, 'tree-sitter assets are required for this test');
  assert.ok(await parser.load('c'), 'the C grammar must load');
  const tree = parser.parse('c', SAMPLE);
  assert.ok(tree);
  return { parser, result: new CppExtractor().extract(tree, 'c', options) };
}

test('extracts functions, methods and their signatures', async () => {
  const { result } = await extractSample();
  const byQualified = new Map(result.symbols.map((s) => [s.qualifiedName, s]));

  const nxStart = byQualified.get('nx_start');
  assert.ok(nxStart, 'nx_start must be extracted');
  assert.equal(nxStart.kind, 'function');
  assert.equal(nxStart.line, 38);
  assert.equal(nxStart.signature, 'void nx_start(void)');

  const run = byQualified.get('nx::Task::run');
  assert.ok(run, 'the inline method declaration must be extracted');
  assert.equal(run.kind, 'method');
  assert.equal(run.container, 'nx::Task');

  // An out-of-line definition keeps its explicit qualifier.
  const outOfLine = result.symbols.find((s) => s.qualifiedName === 'Task::run');
  assert.ok(outOfLine, 'the out-of-line definition must be extracted');
  assert.equal(outOfLine.container, 'Task');

  const macro = byQualified.get('MAX_ITEMS');
  assert.ok(macro);
  assert.equal(macro.kind, 'macro');
});

test('extracts aggregates, fields and enumerators with containers', async () => {
  const { result } = await extractSample();
  const kinds = new Map(result.symbols.map((s) => [s.qualifiedName, s.kind]));

  assert.equal(kinds.get('Node'), 'struct');
  assert.equal(kinds.get('nx::Task'), 'class');
  assert.equal(kinds.get('Color'), 'enum');
  assert.equal(kinds.get('RED'), 'enumerator');
  assert.equal(kinds.get('GREEN'), 'enumerator');
  assert.equal(kinds.get('BLUE'), 'enumerator');
  assert.equal(kinds.get('nx'), 'namespace');
  assert.equal(kinds.get('nx::Task::priority'), 'field');
  assert.equal(kinds.get('nx::Task::hidden_'), 'field');

  const value = result.symbols.find((s) => s.qualifiedName === 'Node::value');
  assert.ok(value);
  assert.equal(value.kind, 'field');
  assert.equal(value.container, 'Node');
});

test('does not invent a symbol for an elaborated type reference', async () => {
  const { result } = await extractSample();
  // `struct Node *next;` must not produce a `Node::Node` definition.
  const nested = result.symbols.filter((s) => s.qualifiedName === 'Node::Node');
  assert.equal(nested.length, 0);
});

test('extracts typedefs, variables and includes', async () => {
  const { result } = await extractSample();
  const typedef = result.symbols.find((s) => s.qualifiedName === 'Node' && s.kind === 'typedef');
  assert.ok(typedef, 'the typedef name must be extracted');
  assert.ok(result.symbols.some((s) => s.qualifiedName === 'nx::global_counter' && s.kind === 'variable'));
  assert.deepEqual([...result.includes].sort(), ['local.h', 'stdio.h']);
});

test('collects call references only when asked', async () => {
  const withRefs = await extractSample({ references: true });
  const names = withRefs.result.references.map((r) => r.name);
  assert.ok(names.includes('helper'));
  assert.ok(names.includes('run'));
  assert.ok(withRefs.result.references.every((r) => r.kind === 'call'));

  const withoutRefs = await extractSample();
  assert.equal(withoutRefs.result.references.length, 0);
});

test('reports positions as zero-based line/column of the declared name', async () => {
  const { result } = await extractSample();
  const nxStart = result.symbols.find((s) => s.qualifiedName === 'nx_start')!;
  // `void nx_start(void) {` on line 38 (zero-based); the name starts at column 5.
  assert.equal(nxStart.line, 38);
  assert.equal(nxStart.column, 5);
});

test('registers extractors by language', () => {
  const registry = new ExtractorRegistry();
  registry.register(new CppExtractor());
  assert.ok(registry.forLanguage('c'));
  assert.ok(registry.forLanguage('cpp'));
  assert.ok(registry.forLanguage('c++'));
  assert.equal(registry.forLanguage('rust'), undefined);
  assert.equal(registry.size, 1);
});

test('an absent grammar degrades instead of throwing', async () => {
  const parser = await TreeSitterParser.create({
    wasmDir: '/nonexistent-wasm-dir',
    logger: silentLogger,
  });
  assert.equal(parser, undefined);
});
