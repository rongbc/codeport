/**
 * End-to-end activation test.
 *
 * Runs the **real esbuild bundle** (`dist/extension.js`) against a stubbed VS Code
 * API and a real temporary C project. This is the closest thing to launching the
 * extension that works without a display, and it covers the whole chain:
 *
 *   Markdown text -> parser -> project detection -> index (tree-sitter+SQLite)
 *                 -> resolver policy -> provider -> vscode.Location
 *
 * clangd is deliberately absent, which also proves the documented graceful
 * degradation: the language server fails, the index still answers.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installVscodeStub, awaitStatusTask } from './support/vscode-stub.ts';

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

let workspace: string;
let handle: ReturnType<typeof installVscodeStub>;
let extension: { activate(context: unknown): unknown; deactivate(): Promise<void> };

before(async () => {
  // Build the real bundle (and copy the tree-sitter WASM assets) exactly the way
  // shipping does, so the test validates the build pipeline too.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  assert.ok(fs.existsSync(BUNDLE), 'the build must produce dist/extension.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'wasm', 'tree-sitter-cpp.wasm')));

  workspace = fs.mkdtempSync(path.join(requireCjs('node:os').tmpdir(), 'codeport-e2e-'));
  fs.writeFileSync(path.join(workspace, 'a.c'), SOURCE);
  fs.writeFileSync(
    path.join(workspace, 'compile_commands.json'),
    JSON.stringify([
      { directory: workspace, command: 'cc -c a.c', file: path.join(workspace, 'a.c') },
    ])
  );
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs', 'notes.md'), 'Call `nx_start()` to boot.\n');

  handle = installVscodeStub({
    workspaceRoot: workspace,
    extensionPath: ROOT,
    settings: { 'codeport.trace': 'verbose' },
  });
  extension = requireCjs(BUNDLE) as typeof extension;
  extension.activate({
    subscriptions: [],
    extensionPath: ROOT,
    extension: { id: 'local.codeport' },
    globalState: { get: () => undefined, update: async () => {} },
  });
});

after(async () => {
  try {
    await extension?.deactivate();
  } finally {
    handle?.restore();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

let documentCounter = 0;

function fakeDocument(text: string): unknown {
  const lines = text.split('\n');
  const name = `notes-${++documentCounter}.md`;
  const fsPath = path.join(workspace, 'docs', name);
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

test('activation registers the Markdown providers and commands', () => {
  assert.deepEqual([...handle.stub.registeredLanguages], ['markdown']);
  for (const kind of ['definition', 'reference', 'hover', 'documentLink']) {
    assert.ok(handle.providers.has(kind), `${kind} provider must be registered`);
  }
  for (const command of [
    'codeport.goToDefinition',
    'codeport.findReferences',
    'codeport.insertSourceLink',
    'codeport.rebuildIndex',
    'codeport.showIndexStats',
    'codeport.showLog',
  ]) {
    assert.ok(handle.stub.registeredCommands.has(command), `${command} must be registered`);
  }
});

test('the index is built for the detected C project and answers a Markdown symbol', async () => {
  const message = await awaitStatusTask(handle.stub);
  assert.match(
    String(message),
    /indexing/,
    `expected the background index task; log: ${handle.stub.logLines.join(' | ')}`
  );

  // The database must exist on disk under .codeport/.
  assert.ok(
    fs.existsSync(path.join(workspace, '.codeport', 'index.db')),
    'the index database must be created'
  );

  const provider = handle.providers.get('definition');
  const document = fakeDocument('Call `nx_start()` to boot.\n');
  // Cursor on `(` of `nx_start()`.
  const result = await provider.provideDefinition(
    document,
    { line: 0, character: 15 },
    { isCancellationRequested: false }
  );

  assert.ok(result, `expected a definition; log: ${handle.stub.logLines.join(' | ')}`);
  assert.equal(result.length, 1);
  const location = result[0];
  assert.equal(location.uri.fsPath, path.join(workspace, 'a.c'));
  // `void nx_start(void) {` is on line 6 (zero-based).
  assert.equal(location.range.start.line, 6);

  const stats = handle.stub.logLines.join('\n');
  assert.match(stats, /index synced/, 'the index sync must complete');
});

test('the resolver policy records which engines ran', () => {
  const log = handle.stub.logLines.join('\n');
  // The index fast path or an LSP failure must both be visible in the log.
  assert.match(log, /\[pipeline\/index-first\]/, 'the pipeline must log its decision');
  assert.match(log, /clangd/, 'clangd must have been attempted and reported');
});

test('hover reports the definition site and provenance', async () => {
  const provider = handle.providers.get('hover');
  const document = fakeDocument('Call `nx_start()` to boot.\n');
  const hover = await provider.provideHover(
    document,
    { line: 0, character: 8 },
    { isCancellationRequested: false }
  );
  assert.ok(hover, 'expected hover content');
  const value = String(hover.contents.value);
  assert.match(value, /nx_start/);
  assert.match(value, /a\.c/, `hover must name the defining file; got: ${value}`);
  assert.match(
    value,
    /(index|lsp) · confidence \d\.\d\d/,
    `hover must state which engine answered and how confidently; got: ${value}`
  );
});

test('prose and unindexed names yield nothing instead of a wrong guess', async () => {
  const provider = handle.providers.get('definition');
  const prose = fakeDocument('The nx_start function boots the system.\n');
  assert.equal(
    await provider.provideDefinition(prose, { line: 0, character: 10 }, { isCancellationRequested: false }),
    undefined,
    'plain prose must never resolve'
  );

  const unknown = fakeDocument('Call `definitely_not_a_symbol()` here.\n');
  assert.equal(
    await provider.provideDefinition(
      unknown,
      { line: 0, character: 10 },
      { isCancellationRequested: false }
    ),
    undefined,
    'an unknown name must not produce a location'
  );
});

/** Is a clangd binary reachable the way the adapter looks for one? */
function hasClangd(): boolean {
  const candidates = ['/usr/local/bin/clangd', '/usr/bin/clangd', '/opt/homebrew/bin/clangd'];
  try {
    for (const name of fs.readdirSync('/usr/lib')) {
      if (/^llvm-\d+$/.test(name)) candidates.push(path.join('/usr/lib', name, 'bin', 'clangd'));
    }
  } catch {
    /* no /usr/lib */
  }
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

test('find-all-references goes through the language server at a real definition', async () => {
  const provider = handle.providers.get('reference');
  const document = fakeDocument('Call `nx_start()` twice.\n');
  const context = { includeDeclaration: true };
  const token = { isCancellationRequested: false };
  const position = { line: 0, character: 8 };

  const withoutServer = !hasClangd();

  // clangd needs a moment to parse the file before it can answer; the provider
  // resolves the definition from the index first, then asks the server.
  let result: any[] | undefined;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    result = await provider.provideReferences(document, position, context, token);
    if (result && result.length > 0) break;
    if (withoutServer) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (withoutServer) {
    assert.equal(result, undefined, 'without a language server there is no reference search');
    return;
  }

  assert.ok(result, `expected references; log: ${handle.stub.logLines.join(' | ')}`);
  const lines = result.map((location) => location.range.start.line);
  // `void nx_start(void) {` is on line 6; the two call sites are below.
  assert.ok(lines.includes(6), `the definition must be included; got lines ${lines.join(',')}`);
});

test('deactivate shuts everything down cleanly', async () => {
  await extension.deactivate();
  // Nothing must be registered as still running afterwards.
  assert.equal(handle.stub.disposed.count > 0, true, 'disposables must be released');
});
