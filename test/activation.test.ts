/**
 * End-to-end activation test.
 *
 * Runs the **real esbuild bundle** (`dist/extension.js`) against a stubbed VS Code
 * API, a real temporary project and a stand-in CodeGraph SDK. This is the closest
 * thing to launching the extension that works without a display, and it covers the
 * whole chain:
 *
 *   Markdown text -> parser -> CodegraphResolver -> CodeGraph -> provider
 *                 -> vscode.Location
 *
 * The SDK is injected through `CODEGRAPH_SDK_PATH`, which is also the escape hatch
 * the shipped extension exposes via `codeport.codegraph.path`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installVscodeStub } from './support/vscode-stub.ts';
import { FAKE_SDK, fakeGraphRoot, node } from './support/env.ts';

const requireCjs = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = path.join(ROOT, 'dist', 'extension.js');

const SOURCE = `#include <stdio.h>

static int helper(int a) {
    return a + 1;
}

void nx_start(void) {
    helper(1);
}
`;

const MAIN = `void nx_start(void);

int main(void) {
    nx_start();
    return 0;
}
`;

let workspace: string;
let handle: ReturnType<typeof installVscodeStub>;
let extension: { activate(context: unknown): unknown; deactivate(): Promise<void> };

before(() => {
  // `npm test` runs the `pretest` build first. Asserting here keeps a bare
  // `node --test` run from failing with a confusing module-not-found error.
  assert.ok(fs.existsSync(BUNDLE), 'run `npm run build` first (npm test does it via pretest)');

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codeport-e2e-'));
  fs.writeFileSync(path.join(workspace, 'a.c'), SOURCE);
  fs.writeFileSync(path.join(workspace, 'main.c'), MAIN);
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs', 'notes.md'), 'Call `nx_start()` to boot.\n');

  // The graph lives *in the workspace*, and `filePath` is relative to it — as the
  // real CodeGraph reports it.
  fakeGraphRoot(
    workspace,
    {
      nodes: [
        node({
          id: 'fn:nx_start',
          kind: 'function',
          name: 'nx_start',
          qualifiedName: 'nx_start',
          language: 'c',
          filePath: 'a.c',
          startLine: 7,
          endLine: 9,
          startColumn: 5,
          endColumn: 1,
          signature: 'void nx_start(void)',
        }),
        node({
          id: 'fn:helper',
          kind: 'function',
          name: 'helper',
          language: 'c',
          filePath: 'a.c',
          startLine: 3,
          endLine: 5,
          startColumn: 11,
          endColumn: 1,
        }),
        node({
          id: 'fn:main',
          kind: 'function',
          name: 'main',
          language: 'c',
          filePath: 'main.c',
          startLine: 3,
          endLine: 6,
          startColumn: 4,
          endColumn: 1,
        }),
      ],
      usages: {
        'fn:nx_start': [
          {
            node: node({ id: 'fn:main', name: 'main', kind: 'function', filePath: 'main.c', startLine: 3, endLine: 6 }),
            edge: {
              source: 'fn:main',
              target: 'fn:nx_start',
              kind: 'calls',
              line: 4,
              column: 4,
              metadata: { refName: 'nx_start', confidence: 0.9, resolvedBy: 'exact-match' },
            },
          },
        ],
      },
    },
    '.'
  );

  process.env.CODEGRAPH_SDK_PATH = FAKE_SDK;
  handle = installVscodeStub({
    workspaceRoot: workspace,
    extensionPath: ROOT,
    settings: { 'codeport.trace': 'verbose' },
  });
  extension = requireCjs(BUNDLE) as typeof extension;
  extension.activate({
    subscriptions: [],
    extensionPath: ROOT,
    extension: { id: 'RongBaichuan.codeport' },
    globalState: { get: () => undefined, update: async () => {} },
  });
});

after(async () => {
  try {
    await extension?.deactivate();
  } finally {
    handle?.restore();
    delete process.env.CODEGRAPH_SDK_PATH;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

let documentCounter = 0;

function fakeDocument(text: string): any {
  const lines = text.split('\n');
  const name = `notes-${++documentCounter}.md`;
  const fsPath = path.join(workspace, 'docs', name);
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    version: 1,
    languageId: 'markdown',
    getText: () => text,
    // The document-link provider works in offsets, so it needs this.
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

test('activation registers the Markdown providers and commands', () => {
  assert.deepEqual([...handle.stub.registeredLanguages], ['markdown']);
  for (const kind of ['definition', 'reference', 'hover', 'documentLink']) {
    assert.ok(handle.providers.has(kind), `${kind} provider must be registered`);
  }
  for (const command of [
    'codeport.goToDefinition',
    'codeport.peekDefinition',
    'codeport.findReferences',
    'codeport.insertSourceLink',
    'codeport.rebuildIndex',
    'codeport.showIndexStats',
    'codeport.showLog',
  ]) {
    assert.ok(handle.stub.registeredCommands.has(command), `${command} must be registered`);
  }
});

test('the resolver is reported as ready in the log', () => {
  const log = handle.stub.logLines.join('\n');
  assert.match(log, /CodeGraph ready for 4 language\(s\)/, `log: ${log}`);
  assert.match(log, /resolver=codegraph/);
});

test('a Markdown symbol resolves to its source definition', async () => {
  const provider = handle.providers.get('definition');
  const document = fakeDocument('Call `nx_start()` to boot.\n');
  // Cursor on the `(` after `nx_start`.
  const result = await provider.provideDefinition(document, { line: 0, character: 15 }, token);

  assert.ok(result, `expected a definition; log: ${handle.stub.logLines.join(' | ')}`);
  assert.equal(result.length, 1);
  const location = result[0];
  assert.equal(location.uri.fsPath, path.join(workspace, 'a.c'));
  // CodeGraph reports `startLine: 7` (1-based); the editor wants 6 (0-based).
  assert.equal(location.range.start.line, 6, 'the 1-based CodeGraph line must be shifted');
  assert.equal(location.range.start.character, 5);
});

test('the pipeline log names the engine that answered', () => {
  const log = handle.stub.logLines.join('\n');
  assert.match(log, /\[pipeline\] resolved "nx_start"/, `log: ${log}`);
  assert.match(log, /codegraph=1/);
});

test('hover reports the definition site and provenance', async () => {
  const provider = handle.providers.get('hover');
  const document = fakeDocument('Call `nx_start()` to boot.\n');
  const hover = await provider.provideHover(document, { line: 0, character: 8 }, token);

  assert.ok(hover, 'expected hover content');
  const value = String(hover.contents.value);
  assert.match(value, /nx_start/);
  assert.match(value, /a\.c/, `hover must name the defining file; got: ${value}`);
  assert.match(
    value,
    /codegraph · exact name/,
    `hover must state which engine answered and on what evidence; got: ${value}`
  );
});

test('hover falls back to reading the symbol source when there is no signature', async () => {
  const provider = handle.providers.get('hover');
  const document = fakeDocument('Call `helper()` to add one.\n');
  const hover = await provider.provideHover(document, { line: 0, character: 8 }, token);
  assert.ok(hover);
  const value = String(hover.contents.value);
  // `helper` has no signature in the fixture, so CodeGraph's own source read is
  // what fills the code block.
  assert.match(value, /static int helper\(int a\)/, `got: ${value}`);
});

test('find-all-references returns the exact usage site plus the declaration', async () => {
  const provider = handle.providers.get('reference');
  const document = fakeDocument('Call `nx_start()` twice.\n');
  const result = await provider.provideReferences(
    document,
    { line: 0, character: 8 },
    { includeDeclaration: true },
    token
  );

  assert.ok(result, `expected references; log: ${handle.stub.logLines.join(' | ')}`);
  const sites = result.map((location: any) => `${path.basename(location.uri.fsPath)}:${location.range.start.line}`);
  assert.ok(sites.includes('a.c:6'), `the declaration must be included; got ${sites.join(', ')}`);
  // The edge reported the call at main.c line 4 (1-based) -> 3 (0-based).
  assert.ok(sites.includes('main.c:3'), `the call site must be included; got ${sites.join(', ')}`);

  const callSite = result.find((location: any) => path.basename(location.uri.fsPath) === 'main.c');
  assert.equal(callSite.range.start.character, 4);
  // The range covers the referenced name, which the edge carried as `refName`.
  assert.equal(callSite.range.end.character, 4 + 'nx_start'.length);
});

test('prose and unindexed names yield nothing instead of a wrong guess', async () => {
  const provider = handle.providers.get('definition');
  const prose = fakeDocument('The nx_start function boots the system.\n');
  assert.equal(
    await provider.provideDefinition(prose, { line: 0, character: 10 }, token),
    undefined,
    'plain prose must never resolve'
  );

  const unknown = fakeDocument('Call `definitely_not_a_symbol()` here.\n');
  assert.equal(
    await provider.provideDefinition(unknown, { line: 0, character: 10 }, token),
    undefined,
    'an unknown name must not produce a location'
  );
});

test('path links still work — they never touch the symbol engine', async () => {
  const provider = handle.providers.get('documentLink');
  const document = fakeDocument('See `a.c:7` and `main.c:4` for the boot path.\n');
  const links = await provider.provideDocumentLinks(document, token);

  const targets = (links ?? [])
    .filter((link: any) => link.target)
    .map((link: any) => link.target.fsPath);
  assert.ok(
    targets.includes(path.join(workspace, 'a.c')),
    `path links must keep working without the resolver; got ${JSON.stringify(targets)}`
  );
});

test('deactivate shuts everything down cleanly', async () => {
  await extension.deactivate();
  assert.equal(handle.stub.disposed.count > 0, true, 'disposables must be released');
});
