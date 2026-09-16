/** Shared test helpers. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The fixture SDK that stands in for a real CodeGraph install.
 *
 * Point `CODEGRAPH_SDK_PATH` at it and CodePort's loader will pick it up, so the
 * whole chain can be tested without the real package.
 */
export const FAKE_SDK = fileURLToPath(
  new URL('../fixtures/fake-codegraph-sdk.js', import.meta.url)
);

export const silentLogger = { info(): void {}, warn(): void {} };

export function tempDir(prefix = 'codeport-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** One node in a fake graph, in CodeGraph's own shape (1-based lines). */
export interface FakeNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName?: string;
  /** **Relative** to the graph root, like the real thing. */
  readonly filePath: string;
  readonly language?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly signature?: string;
}

export interface FakeUsage {
  readonly node: FakeNode;
  readonly edge: {
    readonly source: string;
    readonly target: string;
    readonly kind: string;
    readonly line?: number;
    readonly column?: number;
    readonly metadata?: Record<string, unknown>;
  };
}

export interface FakeGraphData {
  readonly nodes: readonly FakeNode[];
  readonly usages?: Readonly<Record<string, readonly FakeUsage[]>>;
}

/**
 * Create a directory that looks like a CodeGraph project root to CodePort: a
 * `.codegraph/` directory with a database file and, optionally, fixture data.
 *
 * Only the *presence* of `codegraph.db` matters to `findGraphRoot`; the content
 * is what {@link FAKE_SDK} reads.
 */
export function fakeGraphRoot(parent: string, data: FakeGraphData, name = 'project'): string {
  const root = path.join(parent, name);
  const dir = path.join(root, '.codegraph');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'codegraph.db'), '');
  fs.writeFileSync(path.join(dir, 'fake-graph.json'), JSON.stringify(data, null, 2));
  return root;
}

/** A directory with no `.codegraph/` anywhere above it (as far as tests care). */
export function plainDir(parent: string, name = 'plain'): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a node with sensible defaults, so tests only state what they exercise. */
export function node(overrides: Partial<FakeNode> & Pick<FakeNode, 'id' | 'name'>): FakeNode {
  return {
    kind: 'function',
    filePath: 'src/a.c',
    language: 'c',
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    ...overrides,
  };
}
