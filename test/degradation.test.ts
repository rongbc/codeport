/**
 * Degradation tests.
 *
 * CodePort is a navigation aid, so the interesting property is what it does when
 * the thing it depends on is missing or broken: it must say so and return
 * nothing, never throw into the editor and never guess a wrong location.
 *
 * Three states are covered end to end against the real bundle:
 *
 *  1. no CodeGraph index anywhere near the workspace;
 *  2. an index that exists but cannot be opened;
 *  3. a healthy index asked for a name CodeGraph does not model (a macro).
 *
 * Path links are asserted in all of them: they are the half of the extension that
 * never touched the symbol engine, so they must keep working unconditionally.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installVscodeStub } from './support/vscode-stub.ts';
import { FAKE_SDK, node, tempDir } from './support/env.ts';

const requireCjs = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = path.join(ROOT, 'dist', 'extension.js');
const BROKEN_SDK = fileURLToPath(new URL('./fixtures/fake-codegraph-sdk-broken.js', import.meta.url));

const SOURCE = `#define SCHED_ALL_CPUS 3

void nx_start(void) {
}
`;

let handle: ReturnType<typeof installVscodeStub>;
const cleanups: Array<() => void | Promise<void>> = [];

before(() => {
  assert.ok(fs.existsSync(BUNDLE), 'run `npm run build` first (npm test does it via pretest)');
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.CODEGRAPH_SDK_PATH;
});

after(() => {
  handle?.restore();
});

/** A workspace with sources, and optionally a graph of the given shape. */
function makeWorkspace(options: { graph: 'healthy' | 'broken' | 'none'; sdk: string }): string {
  const dir = tempDir('codeport-degradation-');
  fs.writeFileSync(path.join(dir, 'a.c'), SOURCE);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), 'Call `nx_start()` and `SCHED_ALL_CPUS`.\n');

  if (options.graph !== 'none') {
    fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
  }
  if (options.graph === 'healthy') {
    fs.writeFileSync(
      path.join(dir, '.codegraph', 'fake-graph.json'),
      JSON.stringify({
        nodes: [
          node({
            id: 'fn:nx_start',
            kind: 'function',
            name: 'nx_start',
            language: 'c',
            filePath: 'a.c',
            startLine: 3,
            endLine: 4,
            startColumn: 5,
            endColumn: 1,
            signature: 'void nx_start(void)',
          }),
          // Deliberately no node for SCHED_ALL_CPUS: CodeGraph has no macro kind.
        ],
        usages: {},
      })
    );
  }

  process.env.CODEGRAPH_SDK_PATH = options.sdk;
  handle = installVscodeStub({
    workspaceRoot: dir,
    extensionPath: ROOT,
    settings: { 'codeport.trace': 'verbose' },
  });
  return dir;
}

/** Load and activate a fresh copy of the bundle (Node caches module state). */
function activateFresh(workspace: string): void {
  const resolved = requireCjs.resolve(BUNDLE);
  delete requireCjs.cache[resolved];
  const extension = requireCjs(BUNDLE) as { activate(context: unknown): unknown; deactivate(): Promise<void> };
  extension.activate({
    subscriptions: [],
    extensionPath: ROOT,
    extension: { id: 'RongBaichuan.codeport' },
    globalState: { get: () => undefined, update: async () => {} },
  });
  cleanups.push(async () => {
    await extension.deactivate();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
}

function fakeDocument(workspace: string, text: string): any {
  const fsPath = path.join(workspace, 'docs', 'notes.md');
  const lines = text.split('\n');
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    version: 1,
    languageId: 'markdown',
    getText: () => text,
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let line = 0; line < lines.length; line++) {
        const length = lines[line]!.length + 1;
        if (remaining < length) return { line, character: remaining };
        remaining -= length;
      }
      return { line: lines.length - 1, character: 0 };
    },
  };
}

const token = { isCancellationRequested: false };

function statusText(): string {
  return handle.stub.statusMessages.map((entry) => entry.message).join('\n');
}

test('with no index anywhere, a jump resolves to nothing and says why', async () => {
  const workspace = makeWorkspace({ graph: 'none', sdk: BROKEN_SDK });
  activateFresh(workspace);

  const result = await handle.providers
    .get('definition')
    .provideDefinition(fakeDocument(workspace, 'Call `nx_start()`.\n'), { line: 0, character: 8 }, token);

  assert.equal(result, undefined, 'no index must never produce a location');
  const status = statusText();
  assert.match(status, /no definition found/);
  assert.match(status, /no CodeGraph index covers this folder/, `status: ${status}`);
  assert.match(status, /codegraph index/, 'the hint must say how to fix it');
});

test('an unopenable index degrades instead of throwing into the editor', async () => {
  const workspace = makeWorkspace({ graph: 'broken', sdk: BROKEN_SDK });
  activateFresh(workspace);

  const result = await handle.providers
    .get('definition')
    .provideDefinition(fakeDocument(workspace, 'Call `nx_start()`.\n'), { line: 0, character: 8 }, token);

  assert.equal(result, undefined);
  // The resolver was available (a `.codegraph` exists) and failed quietly: it
  // reports an empty result rather than throwing, so the pipeline records no
  // error and the editor sees a plain "not found".
  assert.match(statusText(), /no definition found/);
  assert.doesNotMatch(statusText(), /CodeGraph was not found/);
});

test('a healthy index answers, but a macro still resolves to nothing', async () => {
  const workspace = makeWorkspace({ graph: 'healthy', sdk: FAKE_SDK });
  activateFresh(workspace);

  const definition = handle.providers.get('definition');
  const found = await definition.provideDefinition(
    fakeDocument(workspace, 'Call `nx_start()`.\n'),
    { line: 0, character: 8 },
    token
  );
  assert.ok(found, 'a plain symbol must resolve');
  assert.equal(found[0].range.start.line, 2, 'startLine 3 becomes line 2');

  // The documented regression: CodeGraph has no macro node kind, so a
  // `SOME_MACRO`-shaped mention cannot be answered by the index at all.
  const macro = fakeDocument(workspace, 'Bitmask `SCHED_ALL_CPUS` is set.\n');
  assert.equal(
    await definition.provideDefinition(macro, { line: 0, character: 12 }, token),
    undefined,
    'macros are not indexed by CodeGraph'
  );
  assert.match(statusText(), /preprocessor macros are not indexed/, `status: ${statusText()}`);
});

test('path links work in every degraded state', async () => {
  for (const graph of ['none', 'broken', 'healthy'] as const) {
    const workspace = makeWorkspace({ graph, sdk: graph === 'healthy' ? FAKE_SDK : BROKEN_SDK });
    activateFresh(workspace);

    const links = await handle.providers
      .get('documentLink')
      .provideDocumentLinks(fakeDocument(workspace, 'See `a.c:3` for the boot path.\n'), token);

    const targets = (links ?? []).filter((link: any) => link.target).map((link: any) => link.target.fsPath);
    assert.ok(
      targets.includes(path.join(workspace, 'a.c')),
      `path links must survive graph=${graph}; got ${JSON.stringify(targets)}`
    );
  }
});

test('activation itself never fails when CodeGraph is unusable', () => {
  const workspace = makeWorkspace({ graph: 'none', sdk: BROKEN_SDK });
  activateFresh(workspace);
  assert.ok(handle.providers.has('definition'));
  assert.ok(handle.providers.has('documentLink'));
});
