/**
 * Ranking, merging, the pipeline, the CodeGraph resolver, and the build signal.
 *
 * There is no numeric confidence to assert any more — deliberately. What is
 * asserted is the **ordering evidence**: how many independent signals agree with
 * a candidate, and the readable reasons the hover shows.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD_SIGNAL,
  MAX_RANK,
  STRONG_DEFINITION,
  containerAgrees,
  kindsCompatible,
  rankCandidate,
} from '../src/resolution/Ranking.ts';
import { COMPILE_COMMANDS_FILE, CompileCommandsIndex } from '../src/resolution/CompileCommands.ts';
import { isWeakDefinition } from '../src/resolution/WeakLinkage.ts';
import { CODEGRAPH_RESOLVER_ID, type ResolutionResult, type ResolveContext, type SymbolResolver } from '../src/resolution/Resolver.ts';
import { ResolverPipeline, bestRank, mergeCandidates } from '../src/resolution/ResolverPipeline.ts';
import { CodegraphResolver } from '../src/resolution/CodegraphResolver.ts';
import { CodegraphIndexService } from '../src/codegraph/CodegraphIndex.ts';
import { pathToUri } from '../src/util/uri.ts';
import { FAKE_SDK, fakeGraphRoot, node, plainDir, tempDir } from './support/env.ts';

const made: string[] = [];

function scratch(): string {
  const dir = tempDir();
  made.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.CODEGRAPH_SDK_PATH;
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------- ranking ------------------------------- */

test('a fully corroborated exact hit carries every signal', () => {
  const { rank, reasons } = rankCandidate({
    matchType: 'exact',
    queryName: 'nx_start',
    queryContainer: 'nx',
    queryLanguage: 'c',
    queryKindHint: 'function',
    hit: { name: 'nx_start', kind: 'function', container: 'nx', language: 'c' },
  });
  assert.equal(rank, MAX_RANK);
  assert.deepEqual(reasons, ['exact name', 'qualifier nx', 'language c', 'kind function']);
});

test('a bare exact mention is worth one signal', () => {
  const { rank, reasons } = rankCandidate({
    matchType: 'exact',
    queryName: 'nx_start',
    hit: { name: 'nx_start' },
  });
  assert.equal(rank, 1);
  assert.deepEqual(reasons, ['exact name']);
});

test('a fenced, call-shaped mention picks up the language and kind signals', () => {
  const { rank, reasons } = rankCandidate({
    matchType: 'exact',
    queryName: 'nx_start',
    queryLanguage: 'c',
    queryKindHint: 'function',
    hit: { name: 'nx_start', kind: 'function', language: 'c' },
  });
  assert.equal(rank, 3);
  assert.deepEqual(reasons, ['exact name', 'language c', 'kind function']);
});

test('a prefix match earns no point for the name itself', () => {
  const { rank, reasons } = rankCandidate({
    matchType: 'prefix',
    queryName: 'nx_sta',
    queryLanguage: 'c',
    queryKindHint: 'function',
    hit: { name: 'nx_start', kind: 'function', language: 'c' },
  });
  // Everything but the name agreed: language + kind. An exact hit with the same
  // two would score 3, so a prefix match can never outrank one if a second engine
  // ever merges both match types into one result set.
  assert.equal(rank, 2);
  assert.ok(reasons.includes('name prefix'));
});

test('contradictions subtract rather than reject the candidate', () => {
  const { rank, reasons } = rankCandidate({
    matchType: 'exact',
    queryName: 'run',
    queryContainer: 'Alpha',
    queryLanguage: 'cpp',
    hit: { name: 'run', kind: 'method', container: 'Beta', language: 'python' },
  });
  // 1 for the exact name, minus the qualifier and the language: it survives and
  // sorts last. Rejecting would be wrong — `sameLanguageFamily` is false for any
  // language outside its table, so a fence written ```text would drop everything.
  assert.equal(rank, -1);
  assert.ok(reasons.some((reason) => reason.startsWith('qualifier mismatch')));
  assert.ok(reasons.some((reason) => reason.startsWith('language mismatch')));
});

test('an incompatible kind records the difference without a signal', () => {
  const { rank, reasons } = rankCandidate({
    matchType: 'exact',
    queryName: 'CONFIG_MAX',
    queryKindHint: 'macro',
    hit: { name: 'CONFIG_MAX', kind: 'enum' },
  });
  assert.equal(rank, 1, 'only the exact name agreed');
  assert.ok(reasons.includes('kind differs (enum)'));
});

test('family-level language agreement is not a contradiction', () => {
  // A `cpp` project legitimately contains `.c` files.
  const { rank } = rankCandidate({
    matchType: 'exact',
    queryName: 'helper',
    queryLanguage: 'cpp',
    hit: { name: 'helper', language: 'c' },
  });
  assert.equal(rank, 2);
});

test('a fence language CodePort does not recognise counts as a mismatch', () => {
  const { rank, reasons } = rankCandidate({
    matchType: 'exact',
    queryName: 'helper',
    queryLanguage: 'text',
    hit: { name: 'helper', language: 'c' },
  });
  // `sameLanguageFamily` is false for anything outside its family table, so
  // ```` ```text ```` is treated as a contradiction rather than as "no signal".
  // It costs exactly one point and never rejects the candidate — and because a
  // query returns either all-exact or all-prefix hits, every candidate in one
  // result set loses the same point, so the ordering is unaffected.
  assert.equal(rank, 0);
  assert.ok(reasons.includes('language mismatch (c)'));
});

test('kindsCompatible bridges the shapes a mention can take', () => {
  assert.equal(kindsCompatible('function', 'method'), true);
  assert.equal(kindsCompatible('function', 'class'), false);
  assert.equal(kindsCompatible('struct', 'class'), true);
  assert.equal(kindsCompatible('class', 'struct'), true);
  assert.equal(kindsCompatible('variable', 'field'), true);
  // CodeGraph has no macro kind, so a macro-shaped mention may only match a real
  // symbol of a compatible kind.
  assert.equal(kindsCompatible('macro', 'variable'), true);
  assert.equal(kindsCompatible('macro', 'macro'), true);
});

test('containerAgrees normalises both sides', () => {
  assert.equal(containerAgrees('nx', 'nx'), true);
  assert.equal(containerAgrees('a::b', 'b'), true);
  assert.equal(containerAgrees('b', 'a::b'), true);
  assert.equal(containerAgrees('::ns', 'ns'), true);
  assert.equal(containerAgrees('a::b', 'c'), false);
  assert.equal(containerAgrees('', 'a'), false);
});

/* -------------------------------- merging -------------------------------- */

function candidate(uri: string, line: number, rank: number) {
  return {
    location: { uri, range: { start: { line, character: 0 }, end: { line, character: 1 } } },
    rank,
    source: 'test',
  };
}

function result(name: string, candidates: ReturnType<typeof candidate>[]): ResolutionResult {
  return { resolver: name, candidates, durationMs: 0 };
}

test('mergeCandidates deduplicates by location and keeps the higher rank', () => {
  const merged = mergeCandidates([
    result('a', [candidate('file:///x.c', 3, 1)]),
    result('b', [candidate('file:///x.c', 3, 4)]),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.rank, 4);
});

test('mergeCandidates ranks descending with a deterministic tie-break', () => {
  const merged = mergeCandidates([
    result('a', [
      candidate('file:///b.c', 1, 2),
      candidate('file:///a.c', 5, 2),
      candidate('file:///a.c', 2, 4),
    ]),
  ]);
  assert.deepEqual(
    merged.map((entry) => `${entry.location.uri}:${entry.location.range.start.line}`),
    ['file:///a.c:2', 'file:///a.c:5', 'file:///b.c:1']
  );
});

test('bestRank reports the strongest candidate', () => {
  assert.equal(bestRank({ candidates: [candidate('u', 0, 3), candidate('v', 0, 1)], results: [], durationMs: 0 }), 3);
  assert.equal(bestRank({ candidates: [], results: [], durationMs: 0 }), 0);
});

/* -------------------------------- pipeline -------------------------------- */

const context: ResolveContext = {
  reference: {
    name: 'nx_start',
    raw: 'nx_start',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
    codeRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
    inline: true,
  },
  documentUri: 'file:///notes.md',
  position: { line: 0, character: 0 },
  workspaceRoot: '/ws',
};

function fakeResolver(
  id: string,
  options: { available?: boolean; candidates?: ReturnType<typeof candidate>[]; throws?: boolean } = {}
): SymbolResolver {
  return {
    id,
    isAvailable: () => options.available ?? true,
    async resolve(): Promise<ResolutionResult> {
      if (options.throws) throw new Error(`${id} exploded`);
      return result(id, options.candidates ?? []);
    },
  };
}

test('the pipeline records every resolver that ran, in order', async () => {
  const pipeline = new ResolverPipeline([
    fakeResolver('first', { candidates: [candidate('file:///a.c', 0, 1)] }),
    fakeResolver('second', { candidates: [candidate('file:///b.c', 0, 3)] }),
  ]);
  const outcome = await pipeline.resolve(context);
  assert.deepEqual(outcome.results.map((entry) => entry.resolver), ['first', 'second']);
  assert.deepEqual(pipeline.resolverIds(), ['first', 'second']);
  assert.equal(outcome.candidates.length, 2);
  assert.equal(outcome.candidates[0]!.rank, 3, 'the better-evidenced candidate ranks first');
});

test('an unavailable resolver costs nothing and reports nothing', async () => {
  const pipeline = new ResolverPipeline([fakeResolver('off', { available: false })]);
  const outcome = await pipeline.resolve(context);
  assert.deepEqual(outcome.results, []);
  assert.equal(outcome.candidates.length, 0);
});

test('a throwing resolver degrades instead of failing the jump', async () => {
  const pipeline = new ResolverPipeline([
    fakeResolver('broken', { throws: true }),
    fakeResolver('working', { candidates: [candidate('file:///ok.c', 1, 2)] }),
  ]);
  const outcome = await pipeline.resolve(context);
  assert.equal(outcome.results[0]!.error, 'broken exploded');
  assert.equal(outcome.candidates.length, 1, 'the healthy resolver still answers');
});

test('a resolver whose isAvailable throws is treated as unavailable', async () => {
  const hostile: SymbolResolver = {
    id: 'hostile',
    isAvailable: () => {
      throw new Error('nope');
    },
    resolve: async () => result('hostile', [candidate('file:///x.c', 0, 9)]),
  };
  const outcome = await new ResolverPipeline([hostile]).resolve(context);
  assert.deepEqual(outcome.results, []);
});

test('cancellation stops the pipeline before the next resolver', async () => {
  const pipeline = new ResolverPipeline([
    fakeResolver('first', { candidates: [candidate('file:///a.c', 0, 1)] }),
    fakeResolver('second', { candidates: [candidate('file:///b.c', 0, 3)] }),
  ]);
  const outcome = await pipeline.resolve({ ...context, isCancelled: () => true });
  assert.deepEqual(outcome.results, []);
});

/* ---------------------------- codegraph resolver ---------------------------- */

const RESOLVER_FIXTURE = {
  nodes: [
    node({
      id: 'f1',
      name: 'nx_start',
      qualifiedName: 'nx_start',
      kind: 'function',
      language: 'c',
      filePath: 'sched/nx_start.c',
      startLine: 7,
      endLine: 9,
      startColumn: 5,
      endColumn: 1,
      signature: 'void nx_start(void)',
    }),
    node({ id: 'f2', name: 'nx_startup_helper', kind: 'function', language: 'c', filePath: 'sched/aux.c', startLine: 2, endLine: 2 }),
  ],
};

async function resolverFor(): Promise<{ resolver: CodegraphResolver; service: CodegraphIndexService }> {
  process.env.CODEGRAPH_SDK_PATH = FAKE_SDK;
  const service = new CodegraphIndexService();
  const resolver = new CodegraphResolver({
    lookup: (key) => service.lookup(key),
    open: (key) => service.open(key),
  });
  return { resolver, service };
}

test('the resolver is unavailable without a workspace or without a graph', () => {
  const resolver = new CodegraphResolver({ lookup: () => undefined, open: async () => undefined });
  assert.equal(resolver.isAvailable(context), false, 'no workspace root');
  assert.equal(resolver.isAvailable({ ...context, workspaceRoot: undefined }), false);
  assert.equal(
    resolver.isAvailable({ ...context, workspaceRoot: plainDir(scratch(), 'bare') }),
    false,
    'no .codegraph anywhere above'
  );
});

test('the resolver is available exactly when a graph covers the workspace', async () => {
  const root = fakeGraphRoot(scratch(), RESOLVER_FIXTURE);
  const { resolver, service } = await resolverFor();
  try {
    assert.equal(resolver.isAvailable({ ...context, workspaceRoot: root }), true);
    // A subdirectory counts: CodeGraph is found by walking up.
    const nested = path.join(root, 'docs');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(resolver.isAvailable({ ...context, workspaceRoot: nested }), true);
  } finally {
    service.closeAll();
  }
});

test('the resolver maps a hit onto an absolute location with a 0-based line', async () => {
  const root = fakeGraphRoot(scratch(), RESOLVER_FIXTURE);
  const { resolver, service } = await resolverFor();
  try {
    const outcome = await resolver.resolve({
      ...context,
      workspaceRoot: root,
      // A `called` mention: the parser sets `kindHint` when the name is followed
      // by `(`, which is the evidence the kind signal comes from.
      reference: { ...context.reference, kindHint: 'function' },
      language: 'c',
    });
    assert.equal(outcome.resolver, CODEGRAPH_RESOLVER_ID);
    assert.equal(outcome.candidates.length, 1);

    const best = outcome.candidates[0]!;
    assert.equal(best.location.uri, pathToUri(path.join(root, 'sched/nx_start.c')));
    assert.equal(best.location.range.start.line, 6, 'startLine 7 becomes line 6');
    assert.equal(best.location.range.start.character, 5);
    assert.equal(best.symbol?.kind, 'function');
    assert.equal(best.symbol?.signature, 'void nx_start(void)');
    assert.equal(best.symbol?.id, 'f1', 'the backend id is kept for reference lookups');
    assert.equal(best.reason, 'exact name, language c, kind function');
    assert.equal(best.rank, 3);
    assert.equal(best.source, CODEGRAPH_RESOLVER_ID);
  } finally {
    service.closeAll();
  }
});

test('the resolver falls back to a prefix match and says so', async () => {
  const root = fakeGraphRoot(scratch(), RESOLVER_FIXTURE);
  const { resolver, service } = await resolverFor();
  try {
    // Both `nx_start` and `nx_startup_helper` carry the `nx_star` prefix.
    const outcome = await resolver.resolve({ ...context, workspaceRoot: root, reference: { ...context.reference, name: 'nx_star' } });
    assert.equal(outcome.candidates.length, 2);
    for (const found of outcome.candidates) {
      assert.ok(found.reason?.startsWith('name prefix'), `got: ${found.reason}`);
    }
  } finally {
    service.closeAll();
  }
});

test('the resolver answers nothing when the name is unknown', async () => {
  const root = fakeGraphRoot(scratch(), RESOLVER_FIXTURE);
  const { resolver, service } = await resolverFor();
  try {
    const outcome = await resolver.resolve({ ...context, workspaceRoot: root, reference: { ...context.reference, name: 'not_indexed' } });
    assert.deepEqual(outcome.candidates, []);
  } finally {
    service.closeAll();
  }
});

test('the resolver degrades when the graph cannot be opened', async () => {
  // A `.codegraph` marker without a working SDK is the realistic "CodeGraph was
  // uninstalled" case: available, but no answer and no crash.
  const root = fakeGraphRoot(scratch(), RESOLVER_FIXTURE);
  const resolver = new CodegraphResolver({ lookup: () => undefined, open: async () => undefined });
  assert.equal(resolver.isAvailable({ ...context, workspaceRoot: root }), true);
  const outcome = await resolver.resolve({ ...context, workspaceRoot: root });
  assert.deepEqual(outcome.candidates, []);
});

/* ------------------------------ build signal ------------------------------ */

/**
 * Two chips, one name: the `up_allocate_heap` shape. The graph cannot tell them
 * apart, and the fixture order (`chip-a` first) is what the resolver offers when
 * nothing knows which file the build compiles.
 */
const DUPLICATE_FIXTURE = {
  nodes: [
    node({
      id: 'chip-a',
      name: 'up_allocate_heap',
      qualifiedName: 'nx::up_allocate_heap',
      kind: 'function',
      language: 'c',
      filePath: 'arch/chip-a/allocateheap.c',
      startLine: 60,
      endLine: 62,
    }),
    node({
      id: 'chip-b',
      name: 'up_allocate_heap',
      qualifiedName: 'nx::up_allocate_heap',
      kind: 'function',
      language: 'c',
      filePath: 'arch/chip-b/allocateheap.c',
      startLine: 60,
      endLine: 62,
    }),
  ],
};

/** Write a compilation database into `dir`; `units` are relative to `dir`. */
function writeCompileCommands(dir: string, units: readonly string[]): string {
  const cdb = path.join(dir, COMPILE_COMMANDS_FILE);
  const entries = units.map((file) => ({ directory: dir, file }));
  fs.writeFileSync(cdb, JSON.stringify(entries, null, 2));
  return cdb;
}

test('the build narrows the list to the definition it compiles', async () => {
  const root = fakeGraphRoot(scratch(), DUPLICATE_FIXTURE);
  // Only chip-b is a translation unit of this build, so chip-a is not part of it
  // at all: the jump goes straight to the one answer instead of a Peek list.
  writeCompileCommands(root, ['arch/chip-b/allocateheap.c']);

  const { resolver, service } = await resolverFor();
  try {
    const outcome = await resolver.resolve({
      ...context,
      workspaceRoot: root,
      language: 'c',
      // A fully corroborated mention: named, qualified, fenced, call-shaped.
      reference: {
        ...context.reference,
        name: 'up_allocate_heap',
        container: 'nx',
        kindHint: 'function',
      },
    });

    assert.equal(outcome.candidates.length, 1, 'the other chip is dropped, not offered');
    const best = outcome.candidates[0]!;
    assert.equal(best.symbol?.id, 'chip-b');
    assert.equal(best.rank, MAX_RANK + 1, 'the build signal is the one signal past MAX_RANK');
    assert.equal(best.reason, `exact name, qualifier nx, language c, kind function, ${BUILD_SIGNAL.reason}`);
  } finally {
    service.closeAll();
  }
});

test('a build database that does not know the name narrows nothing', async () => {
  const root = fakeGraphRoot(scratch(), DUPLICATE_FIXTURE);
  // The database exists and is healthy, but this build compiles neither chip — the
  // realistic note-about-another-platform case (`sim:nsh` while a board is
  // configured). Every candidate survives, exactly as without a database.
  writeCompileCommands(root, ['arch/other/allocateheap.c']);

  const { resolver, service } = await resolverFor();
  try {
    const outcome = await resolver.resolve({
      ...context,
      workspaceRoot: root,
      language: 'c',
      reference: { ...context.reference, name: 'up_allocate_heap', kindHint: 'function' },
    });

    assert.deepEqual(
      outcome.candidates.map((found) => found.symbol?.id),
      ['chip-a', 'chip-b']
    );
    for (const found of outcome.candidates) {
      assert.ok(!found.reason?.includes(BUILD_SIGNAL.reason), `got: ${found.reason}`);
    }
  } finally {
    service.closeAll();
  }
});

test('a strong definition beats the weak default it overrides', async () => {
  const root = fakeGraphRoot(scratch(), {
    nodes: [
      node({ id: 'weak', name: 'up_allocate_heap', language: 'c', filePath: 'arch/generic/allocateheap.c', startLine: 2, endLine: 4 }),
      node({ id: 'strong', name: 'up_allocate_heap', language: 'c', filePath: 'arch/chip/allocateheap.c', startLine: 1, endLine: 3 }),
    ],
  });
  // Both files are compiled — NuttX's shape exactly: a generic `weak_function`
  // default plus the chip's override. The linker keeps the strong one, so that is
  // the only answer worth jumping to.
  fs.mkdirSync(path.join(root, 'arch/generic'), { recursive: true });
  fs.mkdirSync(path.join(root, 'arch/chip'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'arch/generic/allocateheap.c'),
    '/* the generic default */\nvoid weak_function up_allocate_heap(void **h, size_t *s)\n{\n  (void)h;\n}\n'
  );
  fs.writeFileSync(
    path.join(root, 'arch/chip/allocateheap.c'),
    'void up_allocate_heap(void **h, size_t *s)\n{\n  (void)h;\n}\n'
  );
  writeCompileCommands(root, ['arch/generic/allocateheap.c', 'arch/chip/allocateheap.c']);

  const { resolver, service } = await resolverFor();
  try {
    const outcome = await resolver.resolve({
      ...context,
      workspaceRoot: root,
      language: 'c',
      reference: { ...context.reference, name: 'up_allocate_heap', kindHint: 'function' },
    });

    assert.equal(outcome.candidates.length, 1);
    const best = outcome.candidates[0]!;
    assert.equal(best.symbol?.id, 'strong');
    assert.ok(best.reason?.endsWith(STRONG_DEFINITION.reason), `got: ${best.reason}`);
  } finally {
    service.closeAll();
  }
});

test('every build candidate being weak keeps the whole list', async () => {
  const root = fakeGraphRoot(scratch(), {
    nodes: [
      node({ id: 'weak-a', name: 'hook', language: 'c', filePath: 'arch/a/hook.c', startLine: 1, endLine: 3 }),
      node({ id: 'weak-b', name: 'hook', language: 'c', filePath: 'arch/b/hook.c', startLine: 1, endLine: 3 }),
    ],
  });
  fs.mkdirSync(path.join(root, 'arch/a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'arch/b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'arch/a/hook.c'), 'void weak_function hook(void) {}\n');
  fs.writeFileSync(path.join(root, 'arch/b/hook.c'), '__attribute__((weak)) void hook(void) {}\n');
  writeCompileCommands(root, ['arch/a/hook.c', 'arch/b/hook.c']);

  const { resolver, service } = await resolverFor();
  try {
    const outcome = await resolver.resolve({
      ...context,
      workspaceRoot: root,
      language: 'c',
      reference: { ...context.reference, name: 'hook' },
    });

    assert.deepEqual(
      outcome.candidates.map((found) => found.symbol?.id),
      ['weak-a', 'weak-b'],
      'nothing can be preferred, so nothing is hidden'
    );
  } finally {
    service.closeAll();
  }
});

test('narrowing happens before the 20-candidate cap', async () => {
  // A name with many definitions where the compiled one sorts last: the cap must
  // not be what decides the jump.
  const nodes = Array.from({ length: 25 }, (_, index) =>
    node({
      id: `dup-${index}`,
      name: 'hook',
      language: 'c',
      filePath: `arch/chip-${String(index).padStart(2, '0')}/hook.c`,
      startLine: 1,
      endLine: 3,
    })
  );
  const root = fakeGraphRoot(scratch(), { nodes });
  writeCompileCommands(root, ['arch/chip-24/hook.c']);

  const { resolver, service } = await resolverFor();
  try {
    const outcome = await resolver.resolve({
      ...context,
      workspaceRoot: root,
      language: 'c',
      reference: { ...context.reference, name: 'hook' },
    });

    assert.equal(outcome.candidates.length, 1);
    assert.equal(outcome.candidates[0]!.symbol?.id, 'dup-24');
  } finally {
    service.closeAll();
  }
});

test('the build signal never touches a non-C candidate, and the lookup is injectable', async () => {
  const root = fakeGraphRoot(scratch(), {
    nodes: [
      node({ id: 'c-helper', name: 'helper', language: 'c', filePath: 'src/helper.c', startLine: 4, endLine: 6 }),
      node({ id: 'py-helper', name: 'helper', language: 'python', filePath: 'tools/helper.py', startLine: 4, endLine: 6 }),
    ],
  });

  const asked: string[] = [];
  const { service } = await resolverFor();
  const resolver = new CodegraphResolver({
    lookup: (key) => service.lookup(key),
    open: (key) => service.open(key),
    // Every file is "in the build", so only the C/C++ gate can explain a miss.
    compileCommands: () => ({
      path: '/fixture/compile_commands.json',
      count: 1,
      has: (file: string) => {
        asked.push(file);
        return true;
      },
    }),
  });

  try {
    const outcome = await resolver.resolve({
      ...context,
      workspaceRoot: root,
      language: 'c',
      reference: { ...context.reference, name: 'helper' },
    });
    const byId = new Map(outcome.candidates.map((found) => [found.symbol?.id, found]));

    assert.equal(byId.get('c-helper')!.rank, 3, 'exact name + language + the build signal');
    assert.ok(byId.get('c-helper')!.reason?.includes(BUILD_SIGNAL.reason));
    assert.equal(byId.get('py-helper')!.rank, 0, 'a Python candidate is not reordered by a C database');
    assert.ok(!byId.get('py-helper')!.reason?.includes(BUILD_SIGNAL.reason));
    assert.ok(
      !asked.includes(path.join(root, 'tools/helper.py')),
      'the database is not even asked about a non-C candidate'
    );
  } finally {
    service.closeAll();
  }
});

test('the database finder walks up from the note and never leaves the workspace', () => {
  const outer = scratch();
  const root = path.join(outer, 'ws');
  const noteDir = path.join(root, 'note', 'deep');
  fs.mkdirSync(noteDir, { recursive: true });
  const cdb = writeCompileCommands(root, ['nuttx/src/built.c']);

  const index = new CompileCommandsIndex();
  const found = index.find(noteDir, root);
  assert.equal(found?.path, cdb);
  assert.equal(found?.has(path.join(root, 'nuttx/src/built.c')), true);
  assert.equal(found?.has(path.join(root, 'nuttx/src/other.c')), false);

  // Elsewhere under the same parent is outside the workspace, so the workspace's
  // database must not answer for it — the real case is a `note/` symlink that
  // points out of the workspace.
  const outside = path.join(outer, 'elsewhere');
  fs.mkdirSync(outside);
  assert.equal(index.find(outside, root), undefined);
});

test('a build directory one level below the root is found without guessing layout', () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, 'nuttx'));
  writeCompileCommands(path.join(root, 'nuttx'), ['sched/nx_start.c']);

  const found = new CompileCommandsIndex().find(root, root);
  assert.equal(found?.has(path.join(root, 'nuttx/sched/nx_start.c')), true);
});

test('a nearer database wins over the workspace one', () => {
  const root = scratch();
  const noteDir = path.join(root, 'note');
  fs.mkdirSync(noteDir);
  writeCompileCommands(root, ['root.c']);
  writeCompileCommands(noteDir, ['note.c']);

  const found = new CompileCommandsIndex().find(noteDir, root);
  assert.equal(found?.has(path.join(noteDir, 'note.c')), true);
  assert.equal(found?.has(path.join(root, 'root.c')), false);
});

test('absolute translation-unit paths are used as they are', () => {
  const root = scratch();
  const unit = path.join(root, 'nuttx/arch/stm32.c');
  fs.writeFileSync(path.join(root, COMPILE_COMMANDS_FILE), JSON.stringify([{ file: unit }]));

  assert.equal(new CompileCommandsIndex().find(root, root)?.has(unit), true);
});

test('a rewritten database is noticed, and a broken one is simply no signal', () => {
  const root = scratch();
  const index = new CompileCommandsIndex();

  writeCompileCommands(root, ['a.c']);
  assert.equal(index.find(root, root)?.has(path.join(root, 'a.c')), true);

  // A new build (bear, CMake) rewrites the JSON; the cache is invalidated by
  // mtime and size, so the next jump sees the new units without a reload.
  writeCompileCommands(root, ['b.c', 'c.c']);
  const rewritten = index.find(root, root);
  assert.equal(rewritten?.has(path.join(root, 'b.c')), true);
  assert.equal(rewritten?.has(path.join(root, 'a.c')), false);

  const broken = scratch();
  fs.writeFileSync(path.join(broken, COMPILE_COMMANDS_FILE), '{ not json');
  assert.equal(new CompileCommandsIndex().find(broken, broken), undefined);

  const empty = scratch();
  fs.writeFileSync(path.join(empty, COMPILE_COMMANDS_FILE), '[]');
  assert.equal(new CompileCommandsIndex().find(empty, empty), undefined);
});

/* ------------------------------ weak linkage ------------------------------ */

test('weak markers are read from the definition line, and only before the name', () => {
  const root = scratch();
  const file = path.join(root, 'hook.c');
  const lines = [
    'void weak_function hook(void) {}',
    '__attribute__((weak)) void other(void) {}',
    'WEAK void third(void) {}',
    'void strong(void) {}',
    // A parameter called `weak` must not be read as linkage.
    'int compare(int weak, int strong) { return weak - strong; }',
    // Nor a word `weak` that comes after the definition: it is not linkage.
    'int hook(int weak) { return weak; } /* not weak linkage */',
    'int late(int weak) { return weak; }',
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  assert.equal(isWeakDefinition(file, 0, 'hook'), true);
  assert.equal(isWeakDefinition(file, 1, 'other'), true);
  assert.equal(isWeakDefinition(file, 2, 'third'), true);
  assert.equal(isWeakDefinition(file, 3, 'strong'), false);
  assert.equal(isWeakDefinition(file, 4, 'compare'), false, 'a parameter named weak is not linkage');
  assert.equal(isWeakDefinition(file, 5, 'hook'), false, 'the marker only counts before the name');
  assert.equal(isWeakDefinition(file, 6, 'late'), false);
  assert.equal(isWeakDefinition(file, 5, 'absent'), false, 'a line without the name is unknown');

  // Never a reason to hide anything: an unreadable file, or a line past the end.
  assert.equal(isWeakDefinition(path.join(root, 'missing.c'), 0, 'hook'), false);
  assert.equal(isWeakDefinition(file, 999, 'hook'), false);
});
