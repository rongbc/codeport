/**
 * Tests for the CodeGraph integration layer.
 *
 * These cover the two conversions that are easy to get silently wrong, and that
 * would send a jump to the wrong place rather than fail loudly:
 *
 *  1. CodeGraph reports **1-based lines** and **0-based columns**;
 *  2. CodeGraph reports `filePath` **relative to the project root**.
 *
 * Both are asserted here because no other test would notice a regression.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CodegraphIndex, CodegraphIndexService, deriveContainer, toHit } from '../src/codegraph/CodegraphIndex.ts';
import {
  candidateSdkEntries,
  findGraphRoot,
  hasGraph,
  loadCodegraphSdk,
  resetSdkCache,
  type CodegraphNode,
} from '../src/codegraph/sdk.ts';
import { FAKE_SDK, fakeGraphRoot, node, plainDir, tempDir } from './support/env.ts';

const made: string[] = [];

function scratch(): string {
  const dir = tempDir();
  made.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.CODEGRAPH_SDK_PATH;
  resetSdkCache();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function graphNode(overrides: Partial<CodegraphNode> & Pick<CodegraphNode, 'id' | 'name'>): CodegraphNode {
  return {
    kind: 'function',
    filePath: 'src/a.c',
    language: 'c',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    ...overrides,
  };
}

/* ------------------------------ node mapping ------------------------------ */

test('toHit shifts CodeGraph 1-based lines to CodePort 0-based lines', () => {
  const hit = toHit(
    graphNode({ id: 'f1', name: 'nx_start', startLine: 7, endLine: 9, startColumn: 5, endColumn: 1 }),
    '/proj'
  );
  assert.equal(hit.line, 6, 'startLine 7 is zero-based line 6');
  assert.equal(hit.endLine, 8);
  // Columns are already 0-based and must pass through untouched.
  assert.equal(hit.column, 5);
  assert.equal(hit.endColumn, 1);
});

test('toHit resolves a project-root-relative filePath against the graph root', () => {
  const hit = toHit(graphNode({ id: 'f1', name: 'main', filePath: 'nuttx/sched/init/nx_start.c' }), '/proj');
  // Resolving against the process CWD instead would silently point elsewhere.
  assert.equal(hit.file, path.resolve('/proj', 'nuttx/sched/init/nx_start.c'));
  assert.ok(path.isAbsolute(hit.file));
});

test('toHit leaves an already-absolute filePath alone', () => {
  const hit = toHit(graphNode({ id: 'f1', name: 'main', filePath: '/abs/b.c' }), '/proj');
  assert.equal(hit.file, '/abs/b.c');
});

test('toHit maps CodeGraph node kinds onto CodePort kinds', () => {
  const cases: Array<[string, string]> = [
    ['function', 'function'],
    ['method', 'method'],
    ['class', 'class'],
    ['component', 'class'],
    ['struct', 'struct'],
    ['union', 'union'],
    ['enum', 'enum'],
    ['enum_member', 'enumerator'],
    ['type_alias', 'typedef'],
    ['interface', 'interface'],
    ['trait', 'interface'],
    ['protocol', 'interface'],
    ['namespace', 'namespace'],
    ['module', 'module'],
    ['field', 'field'],
    ['property', 'field'],
    ['variable', 'variable'],
    ['constant', 'variable'],
    // No CodeGraph kind maps onto these: CodeGraph has no macros at all.
    ['import', 'unknown'],
    ['parameter', 'unknown'],
  ];
  for (const [kind, expected] of cases) {
    const hit = toHit(graphNode({ id: 'x', name: 'n', kind: kind as CodegraphNode['kind'] }), '/proj');
    assert.equal(hit.kind, expected, `${kind} should map to ${expected}`);
  }
});

test('toHit splits the container out of the qualified name', () => {
  const hit = toHit(
    graphNode({ id: 'x', name: 'createPipeline', qualifiedName: 'CodePort::createPipeline' }),
    '/proj'
  );
  assert.equal(hit.container, 'CodePort');
  assert.equal(hit.qualifiedName, 'CodePort::createPipeline');
});

test('deriveContainer only strips a trailing ::name', () => {
  assert.equal(deriveContainer('a::b::run', 'run'), 'a::b');
  assert.equal(deriveContainer('run', 'run'), undefined, 'a bare name has no container');
  assert.equal(deriveContainer('a::runner', 'run'), undefined, 'a partial suffix is not a container');
  assert.equal(deriveContainer(undefined, 'run'), undefined);
});

/* ------------------------------ graph location ------------------------------ */

test('findGraphRoot walks up to the nearest .codegraph directory', () => {
  const base = scratch();
  const root = fakeGraphRoot(base, { nodes: [] }, 'repo');
  const nested = path.join(root, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(findGraphRoot(nested), root);
  assert.equal(findGraphRoot(root), root);
  assert.equal(hasGraph(root), true);
  assert.equal(hasGraph(nested), false);
});

test('findGraphRoot returns undefined when nothing above has a graph', () => {
  const orphan = plainDir(scratch(), 'no-graph');
  // A temp dir has no CodeGraph index in any ancestor.
  assert.equal(findGraphRoot(orphan), undefined);
});

/* ------------------------------ SDK location ------------------------------ */

test('candidateSdkEntries offers both readings of a configured path, override first', () => {
  process.env.CODEGRAPH_SDK_PATH = '/from-env/npm-sdk.js';
  const entries = candidateSdkEntries({ configuredPath: '/from-setting', workspaceRoot: '/ws' });

  // A setting that is not a `.js` file could be a package directory or the CLI
  // binary; both readings are offered so the loader can pick the one that exists.
  assert.equal(entries[0], path.join('/from-setting', 'npm-sdk.js'));
  assert.ok(entries.includes(path.join('/', 'npm-sdk.js')), 'the sibling reading must be offered too');

  // The env override beats the workspace, which beats a global prefix.
  const envIndex = entries.indexOf('/from-env/npm-sdk.js');
  const workspaceIndex = entries.indexOf(
    path.join('/ws', 'node_modules', '@colbymchenry', 'codegraph', 'npm-sdk.js')
  );
  assert.ok(envIndex > 0);
  assert.ok(workspaceIndex > envIndex, 'the workspace copy must come after the override');
});

test('candidateSdkEntries accepts an explicit .js entry unchanged', () => {
  const entries = candidateSdkEntries({ configuredPath: '/opt/cg/npm-sdk.js' });
  assert.equal(entries[0], '/opt/cg/npm-sdk.js');
});

test('loadCodegraphSdk normalises a CommonJS export and caches it', async () => {
  process.env.CODEGRAPH_SDK_PATH = FAKE_SDK;
  const sdk = await loadCodegraphSdk();
  assert.ok(sdk, 'the fixture SDK must load');
  assert.equal(typeof sdk.CodeGraph.open, 'function');
  assert.equal(typeof sdk.CodeGraph.isInitialized, 'function');
  assert.deepEqual(sdk.getSupportedLanguages(), ['c', 'cpp', 'typescript', 'python']);
  assert.equal(await loadCodegraphSdk(), sdk, 'a second load must reuse the cached SDK');
});

test('loadCodegraphSdk reports unavailable instead of throwing', async () => {
  process.env.CODEGRAPH_SDK_PATH = path.join(scratch(), 'does-not-exist', 'npm-sdk.js');
  const sdk = await loadCodegraphSdk({ extraPaths: [] });
  // The real machine may have CodeGraph installed globally, so this asserts the
  // failure contract rather than a null: no throw, and either a usable SDK or
  // undefined.
  assert.ok(sdk === undefined || typeof sdk.CodeGraph.open === 'function');
});

/* ------------------------------ index facade ------------------------------ */

const FIXTURE = {
  nodes: [
    node({ id: 'f1', name: 'nx_start', qualifiedName: 'nx_start', filePath: 'a.c', startLine: 7, endLine: 9, signature: 'void nx_start(void)' }),
    node({ id: 'f2', name: 'nx_start_extra', filePath: 'b.c', startLine: 2, endLine: 2 }),
    node({ id: 'f3', name: 'imported', kind: 'import', filePath: 'a.c', startLine: 1, endLine: 1 }),
    node({ id: 'f4', name: 'arg', kind: 'parameter', filePath: 'a.c', startLine: 1, endLine: 1 }),
  ],
  usages: {
    f1: [
      {
        node: node({ id: 'caller', name: 'main', kind: 'function', filePath: 'a.c', startLine: 12, endLine: 14 }),
        edge: {
          source: 'caller',
          target: 'f1',
          kind: 'calls',
          line: 13,
          column: 4,
          metadata: { refName: 'nx_start', confidence: 0.9, resolvedBy: 'import' },
        },
      },
    ],
  },
};

async function openFixture(): Promise<{ index: CodegraphIndex; root: string }> {
  process.env.CODEGRAPH_SDK_PATH = FAKE_SDK;
  const root = fakeGraphRoot(scratch(), FIXTURE);
  const index = await CodegraphIndex.open(root);
  assert.ok(index, 'the fixture graph must open');
  return { index, root };
}

test('query prefers an exact name and falls back to a prefix', async () => {
  const { index } = await openFixture();
  try {
    const exact = index.query('nx_start');
    assert.equal(exact.match, 'exact');
    assert.equal(exact.hits.length, 1);
    assert.equal(exact.hits[0]!.name, 'nx_start');

    const prefix = index.query('nx_sta');
    assert.equal(prefix.match, 'prefix');
    assert.deepEqual(
      prefix.hits.map((hit) => hit.name).sort(),
      ['nx_start', 'nx_start_extra']
    );

    assert.equal(index.query('nothing_here').match, 'none');
  } finally {
    index.close();
  }
});

test('query drops nodes that are not jump targets', async () => {
  const { index } = await openFixture();
  try {
    // `import` and `parameter` nodes are in the fixture but must never surface:
    // a mention of `arg` in `foo(arg)` must not land on a parameter node.
    assert.equal(index.query('imported').match, 'none');
    assert.equal(index.query('arg').match, 'none');
  } finally {
    index.close();
  }
});

test('usages expose the exact call site line and column', async () => {
  const { index, root } = await openFixture();
  try {
    const [usage] = index.usages('f1');
    assert.ok(usage);
    assert.equal(usage.edge.line, 13);
    assert.equal(usage.edge.column, 4);
    assert.equal(usage.edge.metadata?.['refName'], 'nx_start');
    // The referencing node carries the file, again relative to the graph root.
    assert.equal(usage.node.filePath, 'a.c');
    assert.equal(path.resolve(root, usage.node.filePath), path.join(root, 'a.c'));
  } finally {
    index.close();
  }
});

test('code() returns the symbol source read from disk', async () => {
  process.env.CODEGRAPH_SDK_PATH = FAKE_SDK;
  const root = fakeGraphRoot(scratch(), {
    nodes: [node({ id: 'f1', name: 'nx_start', filePath: 'a.c', startLine: 2, endLine: 3 })],
  });
  fs.writeFileSync(path.join(root, 'a.c'), 'int helper(void);\nvoid nx_start(void) {\n}\n');
  const index = await CodegraphIndex.open(root);
  assert.ok(index);
  assert.equal(await index.code('f1'), 'void nx_start(void) {\n}');
  assert.equal(await index.code('missing'), undefined);
  index.close();
});

test('opening a directory with no graph fails without throwing', async () => {
  process.env.CODEGRAPH_SDK_PATH = FAKE_SDK;
  assert.equal(await CodegraphIndex.open(plainDir(scratch(), 'bare')), undefined);
});

test('the index service caches one open graph per root and closes it', async () => {
  process.env.CODEGRAPH_SDK_PATH = FAKE_SDK;
  const root = fakeGraphRoot(scratch(), FIXTURE);
  const service = new CodegraphIndexService({ sdk: { configuredPath: FAKE_SDK } });
  try {
    assert.equal(service.lookup(root), undefined, 'nothing is open before the first use');
    const [first, second] = await Promise.all([service.open(root), service.open(root)]);
    assert.ok(first);
    assert.equal(first, second, 'concurrent opens must share one attempt');
    assert.equal(service.lookup(root), first, 'the open graph is cached');
    service.close(root);
    assert.equal(service.lookup(root), undefined);
  } finally {
    service.closeAll();
  }
});
