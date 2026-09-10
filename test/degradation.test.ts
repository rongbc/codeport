/**
 * Degradation test: CodePort must stay useful with **neither a build system nor a
 * language server**.
 *
 * This is a regression guard for a real defect. The index lifecycle used to be
 * gated on project detection (`compile_commands.json` / `.clangd`): with neither
 * marker present, `prewarm()` skipped the workspace entirely, so the index was
 * never populated and every lookup failed — even though the index needs no build
 * system at all. `compile_commands.json` is a requirement of *clangd*, not of the
 * CodePort index.
 *
 * The workspace here has no markers and `codeport.clangd.path` points at a file
 * that exists but cannot be executed, so the adapter cannot fall back to
 * auto-detection and the language server is genuinely unavailable on any machine.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installVscodeStub } from './support/vscode-stub.ts';

const requireCjs = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = path.join(ROOT, 'dist', 'extension.js');

const SOURCE = `void nx_start(void) {
}

int main(void) {
    nx_start();
    return 0;
}
`;

let workspace: string;
let handle: ReturnType<typeof installVscodeStub>;
let extension: { activate(context: unknown): unknown; deactivate(): Promise<void> };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const log = (): string => handle.stub.logLines.join('\n');

before(() => {
  assert.ok(fs.existsSync(BUNDLE), 'run `npm run build` first (npm test does it via pretest)');

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codeport-degrade-'));
  fs.writeFileSync(path.join(workspace, 'a.c'), SOURCE);
  // Deliberately NO compile_commands.json and NO .clangd.

  const brokenBinary = path.join(workspace, 'broken-clangd');
  fs.writeFileSync(brokenBinary, 'this is not a program\n');

  handle = installVscodeStub({
    workspaceRoot: workspace,
    extensionPath: ROOT,
    settings: {
      'codeport.trace': 'verbose',
      'codeport.clangd.path': brokenBinary,
    },
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

function fakeDocument(text: string): unknown {
  const fsPath = path.join(workspace, 'n.md');
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

const TOKEN = { isCancellationRequested: false };

test('the index is built from the workspace alone, with no build system', async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/index synced/.test(log())) await sleep(50);

  assert.match(
    log(),
    /index synced: 1 indexed/,
    `the index must be built without compile_commands.json; log: ${log()}`
  );
  assert.ok(
    fs.existsSync(path.join(workspace, '.codeport', 'index.db')),
    'the index database must exist'
  );
  // Project detection is expected to fail — that is the point of this test.
  assert.doesNotMatch(log(), /\[project\].*-> clangd/, 'no project should be detected');
});

test('go-to-definition resolves through the index', async () => {
  const provider = handle.providers.get('definition');
  const result = await provider.provideDefinition(
    fakeDocument('Call `nx_start()` to boot.\n'),
    { line: 0, character: 8 },
    TOKEN
  );

  assert.ok(result, `expected a definition from the index; log: ${log()}`);
  assert.equal(result.length, 1);
  assert.equal(result[0].uri.fsPath, path.join(workspace, 'a.c'));
  assert.equal(result[0].range.start.line, 0);
});

test('a weak mention escalates to the language server, fails, and still resolves', async () => {
  // Without call parentheses the index only reaches 0.70, which is below the
  // accept threshold, so the policy consults the language server. With clangd
  // unavailable that resolver must fail softly and the index candidate must
  // survive the merge.
  const provider = handle.providers.get('definition');
  const result = await provider.provideDefinition(
    fakeDocument('The `nx_start` routine boots.\n'),
    { line: 0, character: 8 },
    TOKEN
  );

  assert.ok(result, `the index candidate must survive an LSP failure; log: ${log()}`);
  assert.equal(result[0].uri.fsPath, path.join(workspace, 'a.c'));
  assert.match(
    log(),
    /resolved "nx_start" -> \d+ candidate\(s\)[^\n]*\[index=1, lsp=0\]/,
    `expected the index to answer after the server produced nothing; log: ${log()}`
  );
});

test('hover still reports a signature, taken from the index', async () => {
  const provider = handle.providers.get('hover');
  const hover = await provider.provideHover(
    fakeDocument('Call `nx_start()` to boot.\n'),
    { line: 0, character: 8 },
    TOKEN
  );

  assert.ok(hover, `hover must work without a language server; log: ${log()}`);
  assert.match(
    String(hover.contents.value),
    /void nx_start\(void\)/,
    'the signature must come from the index'
  );
  assert.match(String(hover.contents.value), /index · confidence/);
});

test('Find All References degrades honestly instead of guessing', async () => {
  // Reference search needs a server at a real definition position. With no build
  // configuration there is no server, so CodePort must report nothing rather than
  // returning its own candidates as if they were references.
  const provider = handle.providers.get('reference');
  const result = await provider.provideReferences(
    fakeDocument('Call `nx_start()` to boot.\n'),
    { line: 0, character: 8 },
    { includeDeclaration: true },
    TOKEN
  );

  assert.equal(result, undefined, 'no references must be reported without a server');
  const status = handle.stub.statusMessages.map((entry) => entry.message).join('\n');
  assert.match(status, /no references found/i, `expected an honest status message; got: ${status}`);
});
