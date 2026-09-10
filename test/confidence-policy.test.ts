import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containerAgrees,
  kindsCompatible,
  lspSymbolConfidence,
  scoreIndexHit,
} from '../src/resolution/Confidence.ts';
import { createPolicy, mergeCandidates } from '../src/resolution/Policy.ts';
import { ResolverPipeline } from '../src/resolution/ResolverPipeline.ts';
import { IndexResolver } from '../src/resolution/IndexResolver.ts';
import type { SymbolIndex } from '../src/index/SymbolIndex.ts';
import type {
  ResolutionCandidate,
  ResolutionResult,
  ResolveContext,
  SymbolResolver,
} from '../src/resolution/Resolver.ts';
import type { SymbolReference } from '../src/types.ts';

/* ------------------------------- fixtures ------------------------------- */

function reference(overrides: Partial<SymbolReference> = {}): SymbolReference {
  return {
    name: 'nx_start',
    raw: 'nx_start()',
    called: true,
    kindHint: 'function',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
    codeRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
    inline: true,
    ...overrides,
  };
}

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    reference: reference(),
    documentUri: 'file:///ws/docs/notes.md',
    position: { line: 0, character: 0 },
    language: 'c',
    workspaceRoot: '/ws',
    ...overrides,
  };
}

function candidate(uri: string, line: number, confidence: number, source = 'index'): ResolutionCandidate {
  return {
    location: { uri, range: { start: { line, character: 5 }, end: { line, character: 13 } } },
    confidence,
    source,
    reason: `${source} reason`,
  };
}

function result(resolver: string, candidates: ResolutionCandidate[], error?: string): ResolutionResult {
  return {
    resolver,
    candidates,
    confidence: candidates.reduce((best, entry) => Math.max(best, entry.confidence), 0),
    durationMs: 1,
    error,
  };
}

interface FakeResolver extends SymbolResolver {
  calls: number;
}

function fakeResolver(
  id: string,
  kind: 'index' | 'lsp',
  produce: (context: ResolveContext) => ResolutionResult,
  available = true
): FakeResolver {
  const resolver: FakeResolver = {
    id,
    kind,
    calls: 0,
    isAvailable: () => available,
    async resolve(ctx: ResolveContext) {
      resolver.calls++;
      if (produce instanceof Function && (produce as unknown as { throws?: boolean }).throws) {
        throw new Error(`${id} exploded`);
      }
      return produce(ctx);
    },
  };
  return resolver;
}

/* ------------------------------ confidence ------------------------------ */

test('scores a fully corroborated index hit at 1.0', () => {
  const score = scoreIndexHit({
    matchType: 'exact',
    queryName: 'nx_start',
    queryContainer: 'nx',
    queryLanguage: 'c',
    queryKindHint: 'function',
    resultCount: 1,
    hit: { name: 'nx_start', kind: 'function', container: 'nx', language: 'c' },
  });
  assert.equal(score.score, 1);
  assert.ok(score.reasons.includes('exact name'));
  assert.ok(score.reasons.includes('unique result'));
});

test('a called symbol in a C fence clears the default accept threshold', () => {
  // exact 0.50 + language 0.10 + kind 0.15 + unique 0.10 = 0.85
  const score = scoreIndexHit({
    matchType: 'exact',
    queryName: 'nx_start',
    queryLanguage: 'c',
    queryKindHint: 'function',
    resultCount: 1,
    hit: { name: 'nx_start', kind: 'function', language: 'c' },
  });
  assert.equal(score.score, 0.85);
  assert.ok(score.score >= 0.85, 'should take the index-only fast path');
});

test('a bare mention stays below the threshold so the server is consulted', () => {
  // A plain `` `nx_start` `` mention carries no shape evidence, so even a unique
  // exact hit only reaches exact 0.50 + language 0.10 + unique 0.10 = 0.70.
  const unique = scoreIndexHit({
    matchType: 'exact',
    queryName: 'nx_start',
    queryLanguage: 'c',
    resultCount: 1,
    hit: { name: 'nx_start', language: 'c' },
  });
  assert.equal(unique.score, 0.7);
  assert.ok(unique.score < 0.85, 'must not take the index-only fast path');

  // Several same-named definitions are even less certain.
  const ambiguous = scoreIndexHit({
    matchType: 'exact',
    queryName: 'nx_start',
    queryLanguage: 'c',
    resultCount: 3,
    hit: { name: 'nx_start', language: 'c' },
  });
  assert.equal(ambiguous.score, 0.6);
});

test('penalises a contradicting qualifier and language, and floors at 0', () => {
  const mismatch = scoreIndexHit({
    matchType: 'exact',
    queryName: 'run',
    queryContainer: 'other',
    queryLanguage: 'rust',
    resultCount: 2,
    hit: { name: 'run', kind: 'method', container: 'nx::Task', language: 'cpp' },
  });
  assert.ok(mismatch.reasons.some((reason) => reason.startsWith('qualifier mismatch')));
  assert.ok(mismatch.reasons.some((reason) => reason.startsWith('language mismatch')));
  assert.ok(mismatch.score < 0.5);

  const floor = scoreIndexHit({
    matchType: 'prefix',
    queryName: 'x',
    queryContainer: 'a',
    queryLanguage: 'rust',
    resultCount: 5,
    hit: { name: 'y', kind: 'function', container: 'b', language: 'cpp' },
  });
  assert.ok(floor.score >= 0);
});

test('a C++ project and a .c definition are not a language mismatch', () => {
  // The detector reports `cpp` for a C/C++ build while the file is `.c`; scoring
  // must compare families, otherwise every inline mention is wrongly penalised.
  const score = scoreIndexHit({
    matchType: 'exact',
    queryName: 'nx_start',
    queryLanguage: 'cpp',
    queryKindHint: 'function',
    resultCount: 1,
    hit: { name: 'nx_start', kind: 'function', language: 'c' },
  });
  assert.equal(score.score, 0.85);
  assert.ok(score.reasons.includes('language c'));
  assert.ok(!score.reasons.some((reason) => reason.includes('mismatch')));

  // A genuinely different language still counts against the candidate.
  const foreign = scoreIndexHit({
    matchType: 'exact',
    queryName: 'spawn',
    queryLanguage: 'rust',
    resultCount: 1,
    hit: { name: 'spawn', kind: 'function', language: 'cpp' },
  });
  assert.ok(foreign.reasons.some((reason) => reason.includes('language mismatch')));
  assert.ok(foreign.score < 0.85);
});

test('a prefix match never reaches the accept threshold on its own', () => {
  const score = scoreIndexHit({
    matchType: 'prefix',
    queryName: 'nx_',
    queryLanguage: 'c',
    queryKindHint: 'function',
    resultCount: 1,
    hit: { name: 'nx_start', kind: 'function', language: 'c' },
  });
  assert.equal(score.score, 0.55); // 0.20 + 0.10 + 0.15 + 0.10
  assert.ok(score.score < 0.85);
});

test('language server confidence distinguishes match quality', () => {
  assert.equal(lspSymbolConfidence('qualified').score, 0.95);
  assert.equal(lspSymbolConfidence('exact').score, 0.92);
  assert.equal(lspSymbolConfidence('fuzzy').score, 0.6);
  assert.ok(lspSymbolConfidence('exact', { resultCount: 3 }).score < 0.92);
});

test('qualifier and kind agreement helpers', () => {
  assert.equal(containerAgrees('nx', 'nx'), true);
  assert.equal(containerAgrees('nx::Task', 'Task'), true);
  assert.equal(containerAgrees('Task', 'nx::Task'), true);
  assert.equal(containerAgrees('other', 'nx'), false);
  assert.equal(containerAgrees('', 'nx'), false);

  assert.equal(kindsCompatible('function', 'method'), true);
  assert.equal(kindsCompatible('function', 'function'), true);
  assert.equal(kindsCompatible('macro', 'variable'), true);
  assert.equal(kindsCompatible('struct', 'class'), true);
  assert.equal(kindsCompatible('function', 'namespace'), false);
});

/* --------------------------------- merge -------------------------------- */

test('merging de-duplicates by location and keeps the highest confidence', () => {
  const merged = mergeCandidates([
    result('index', [candidate('file:///ws/a.c', 10, 0.85)]),
    result('lsp', [candidate('file:///ws/a.c', 10, 0.92, 'lsp')]),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.confidence, 0.92);
  assert.equal(merged[0]!.source, 'lsp');
});

test('merging ranks by confidence and breaks ties deterministically', () => {
  const merged = mergeCandidates([
    result('index', [candidate('file:///ws/b.c', 5, 0.85)]),
    result('lsp', [
      candidate('file:///ws/a.c', 20, 0.92, 'lsp'),
      candidate('file:///ws/a.c', 3, 0.85, 'lsp'),
    ]),
  ]);
  assert.deepEqual(
    merged.map((entry) => `${entry.location.uri}:${entry.location.range.start.line}`),
    ['file:///ws/a.c:20', 'file:///ws/a.c:3', 'file:///ws/b.c:5']
  );
});

/* --------------------------------- policy -------------------------------- */

test('index-first stops as soon as a confident single index hit exists', () => {
  const policy = createPolicy('index-first', { indexAcceptConfidence: 0.85 });
  const strong = result('index', [candidate('file:///ws/a.c', 1, 0.85)]);
  assert.equal(policy.shouldStop(strong, [strong], context()), true);

  const weak = result('index', [candidate('file:///ws/a.c', 1, 0.7)]);
  assert.equal(policy.shouldStop(weak, [weak], context()), false);

  const ambiguous = result('index', [
    candidate('file:///ws/a.c', 1, 0.9),
    candidate('file:///ws/b.c', 1, 0.9),
  ]);
  assert.equal(policy.shouldStop(ambiguous, [ambiguous], context()), false);

  const lspResult = result('lsp', [candidate('file:///ws/a.c', 1, 0.92, 'lsp')]);
  assert.equal(policy.shouldStop(lspResult, [lspResult], context()), false);
});

test('policy ordering selects which engines may run', () => {
  const index = fakeResolver('index', 'index', () => result('index', []));
  const lsp = fakeResolver('lsp', 'lsp', () => result('lsp', []));
  const all = [index, lsp];

  assert.deepEqual(
    createPolicy('index-first').order(all).map((entry) => entry.id),
    ['index', 'lsp']
  );
  assert.deepEqual(
    createPolicy('lsp-first').order(all).map((entry) => entry.id),
    ['lsp', 'index']
  );
  assert.deepEqual(
    createPolicy('index-only').order(all).map((entry) => entry.id),
    ['index']
  );
  assert.deepEqual(
    createPolicy('lsp-only').order(all).map((entry) => entry.id),
    ['lsp']
  );
});

/* -------------------------------- pipeline ------------------------------- */

test('the pipeline takes the fast path and never starts the server', async () => {
  const index = fakeResolver('index', 'index', () =>
    result('index', [candidate('file:///ws/a.c', 122, 0.85)])
  );
  const lsp = fakeResolver('lsp', 'lsp', () => result('lsp', [candidate('file:///ws/a.c', 122, 0.92, 'lsp')]));
  const pipeline = new ResolverPipeline([index, lsp], { policy: createPolicy('index-first') });

  const outcome = await pipeline.resolve(context());
  assert.equal(index.calls, 1);
  assert.equal(lsp.calls, 0, 'the language server must not be consulted');
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.candidates[0]!.source, 'index');
});

test('a weak index result escalates to the language server, which wins', async () => {
  const index = fakeResolver('index', 'index', () =>
    result('index', [candidate('file:///ws/a.c', 122, 0.7)])
  );
  const lsp = fakeResolver('lsp', 'lsp', () =>
    result('lsp', [candidate('file:///ws/a.c', 122, 0.92, 'lsp')])
  );
  const pipeline = new ResolverPipeline([index, lsp], { policy: createPolicy('index-first') });

  const outcome = await pipeline.resolve(context());
  assert.equal(lsp.calls, 1);
  assert.equal(outcome.candidates[0]!.source, 'lsp');
  assert.equal(outcome.candidates[0]!.confidence, 0.92);
  assert.equal(outcome.results.length, 2);
});

test('a failing resolver is recorded but does not break navigation', async () => {
  const crashing: SymbolResolver = {
    id: 'index',
    kind: 'index',
    isAvailable: () => true,
    resolve: () => {
      throw new Error('database exploded');
    },
  };
  const lsp = fakeResolver('lsp', 'lsp', () =>
    result('lsp', [candidate('file:///ws/a.c', 1, 0.92, 'lsp')])
  );
  const pipeline = new ResolverPipeline([crashing, lsp], {
    policy: createPolicy('index-first'),
    logger: { info() {}, warn() {}, trace() {} },
  });

  const outcome = await pipeline.resolve(context());
  const indexResult = outcome.results.find((entry) => entry.resolver === 'index');
  assert.equal(indexResult?.error, 'database exploded');
  assert.equal(outcome.candidates.length, 1, 'clangd still answers');
  assert.equal(outcome.candidates[0]!.source, 'lsp');
});

test('an unavailable resolver is skipped', async () => {
  const index = fakeResolver('index', 'index', () => result('index', []), false);
  const lsp = fakeResolver('lsp', 'lsp', () => result('lsp', []));
  const pipeline = new ResolverPipeline([index, lsp], { policy: createPolicy('index-first') });

  await pipeline.resolve(context());
  assert.equal(index.calls, 0);
  assert.equal(lsp.calls, 1);
});

test('index-only and lsp-only really mean only', async () => {
  const index = fakeResolver('index', 'index', () => result('index', []));
  const lsp = fakeResolver('lsp', 'lsp', () => result('lsp', []));

  await new ResolverPipeline([index, lsp], { policy: createPolicy('index-only') }).resolve(context());
  assert.equal(index.calls, 1);
  assert.equal(lsp.calls, 0);

  const index2 = fakeResolver('index', 'index', () => result('index', []));
  const lsp2 = fakeResolver('lsp', 'lsp', () => result('lsp', []));
  await new ResolverPipeline([index2, lsp2], { policy: createPolicy('lsp-only') }).resolve(context());
  assert.equal(index2.calls, 0);
  assert.equal(lsp2.calls, 1);
});

test('cancellation stops the pipeline before the next resolver', async () => {
  const index = fakeResolver('index', 'index', () =>
    result('index', [candidate('file:///ws/a.c', 1, 0.5)])
  );
  const lsp = fakeResolver('lsp', 'lsp', () => result('lsp', []));
  const pipeline = new ResolverPipeline([index, lsp], { policy: createPolicy('index-first') });

  const outcome = await pipeline.resolve(context({ isCancelled: () => true }));
  assert.equal(index.calls, 0);
  assert.equal(lsp.calls, 0);
  assert.equal(outcome.candidates.length, 0);
});

/* ------------------------------ IndexResolver ---------------------------- */

function stubIndex(hits: Array<Record<string, unknown>>, match: 'exact' | 'prefix' | 'none'): SymbolIndex {
  return {
    isClosed: false,
    query: () => ({ hits, match }),
  } as unknown as SymbolIndex;
}

test('IndexResolver maps hits to locations and scores them', async () => {
  const index = stubIndex(
    [
      {
        name: 'nx_start',
        qualifiedName: 'nx_start',
        kind: 'function',
        line: 122,
        column: 5,
        endLine: 122,
        endColumn: 13,
        signature: 'void nx_start(void)',
        file: '/ws/sched/init/nx_start.c',
        language: 'c',
      },
    ],
    'exact'
  );
  const resolver = new IndexResolver({ lookup: () => index });

  const resolved = await resolver.resolve(context());
  assert.equal(resolved.candidates.length, 1);
  const only = resolved.candidates[0]!;
  assert.equal(only.location.uri, 'file:///ws/sched/init/nx_start.c');
  assert.equal(only.location.range.start.line, 122);
  assert.equal(only.confidence, 0.85);
  assert.equal(only.symbol?.signature, 'void nx_start(void)');
  assert.equal(resolved.confidence, 0.85);
});

test('IndexResolver reports nothing when the index has no match', async () => {
  const resolver = new IndexResolver({ lookup: () => stubIndex([], 'none') });
  const resolved = await resolver.resolve(context());
  assert.equal(resolved.candidates.length, 0);
  assert.equal(resolved.confidence, 0);
});

test('IndexResolver is unavailable without a workspace root or index', () => {
  const resolver = new IndexResolver({ lookup: () => undefined });
  assert.equal(resolver.isAvailable(context()), false);
  assert.equal(resolver.isAvailable(context({ workspaceRoot: undefined })), false);

  const withIndex = new IndexResolver({ lookup: () => stubIndex([], 'none') });
  assert.equal(withIndex.isAvailable(context()), true);
});
