/**
 * Architecture invariants.
 *
 * The layering claim in docs/ARCHITECTURE.md — "nothing below `core/` imports
 * `vscode`" — is what makes 68 tests possible without a GUI. An unenforced claim
 * rots, so it is checked here instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Directories/layers allowed to depend on the VS Code API. */
const VSCODE_LAYERS = ['core', 'providers', 'commands', 'vscode'];
/** Individual files allowed to depend on the VS Code API. */
const VSCODE_FILES = ['extension.ts', 'config.ts', 'logger.ts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function allowed(file: string): boolean {
  const relative = path.relative(SRC, file).split(path.sep).join('/');
  if (VSCODE_FILES.includes(relative)) return true;
  return VSCODE_LAYERS.some((layer) => relative.startsWith(`${layer}/`));
}

test('only the VS Code integration layers import the vscode module', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    if (allowed(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    // A value import pulls in the module; `import type` is erased and harmless.
    const importsVscode =
      /^\s*import\s+(?!type\s)[^;]*from\s+['"]vscode['"]/m.test(text) ||
      /\brequire\(\s*['"]vscode['"]\s*\)/.test(text);
    if (importsVscode) violations.push(relative);
  }
  assert.deepEqual(
    violations,
    [],
    `these modules must stay vscode-free: ${violations.join(', ')}`
  );
});

test('the whole source tree is free of TypeScript parameter properties', () => {
  // Node's type-stripping (used by the test suite) only supports strip-only
  // syntax; parameter properties would make the sources untestable as written.
  const violations: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    if (/constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*:/s.test(text)) {
      violations.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(violations, [], `parameter properties found in: ${violations.join(', ')}`);
});

test('every shipped adapter declares the pieces the core requires', async () => {
  const { createBuiltInAdapters } = await import('../src/adapters/index.ts');
  const adapters = createBuiltInAdapters({});
  assert.ok(adapters.length >= 1, 'at least one adapter must ship');

  for (const adapter of adapters) {
    assert.ok(adapter.id, 'an adapter needs an id');
    assert.ok(adapter.languages.length > 0, `${adapter.id} must declare languages`);
    assert.ok(adapter.detector, `${adapter.id} must declare a project detector`);
    assert.equal(typeof adapter.serverSpec, 'function');
    assert.equal(typeof adapter.seedFiles, 'function');
  }
});

test('every policy id in the settings enum is implemented', async () => {
  const { POLICY_IDS } = await import('../src/resolution/Policy.ts');
  const packageJson = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  );
  const declared: string[] = packageJson.contributes.configuration.properties['codeport.policy'].enum;
  assert.deepEqual([...declared].sort(), [...POLICY_IDS].sort());
});

test('every command contributed in package.json is registered by the extension', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  );
  const contributed: string[] = packageJson.contributes.commands.map(
    (entry: { command: string }) => entry.command
  );
  const commandsSource = sourceFiles(path.join(SRC, 'commands'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  const missing = contributed.filter((command) => !commandsSource.includes(`'${command}'`));
  assert.deepEqual(missing, [], `contributed but never registered: ${missing.join(', ')}`);
});

test('every registered command is contributed in package.json', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  );
  const contributed = new Set<string>(
    packageJson.contributes.commands.map((entry: { command: string }) => entry.command)
  );
  const commandsSource = sourceFiles(path.join(SRC, 'commands'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  const registered = [...commandsSource.matchAll(/registerCommand\(\s*'([^']+)'/g)].map(
    (match) => match[1]!
  );
  assert.ok(registered.length > 0, 'expected commands to be registered');
  const extra = registered.filter((command) => !contributed.has(command));
  assert.deepEqual(extra, [], `registered but not contributed: ${extra.join(', ')}`);
});

test('every setting the code reads is contributed in package.json', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  );
  const properties = packageJson.contributes.configuration.properties as Record<string, unknown>;
  const configSource = fs.readFileSync(path.join(SRC, 'config.ts'), 'utf8');

  const read = [...configSource.matchAll(/config\.get<[^>]+>\('([^']+)'/g)].map(
    (match) => match[1]!
  );
  assert.ok(read.length > 0, 'expected config reads');
  const missing = read.filter((key) => properties[`codeport.${key}`] === undefined);
  assert.deepEqual(missing, [], `read but not contributed: ${missing.join(', ')}`);
});
