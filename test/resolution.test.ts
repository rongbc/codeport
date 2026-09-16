/**
 * Ranking, merging, the pipeline, and the CodeGraph resolver.
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
  MAX_RANK,
  containerAgrees,
  kindsCompatible,
  rankCandidate,
} from '../src/resolution/Ranking.ts';
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
  const service = new CodegraphIndexService({ sdk: { configuredPath: FAKE_SDK } });
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
