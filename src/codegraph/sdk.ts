/**
 * Locating and loading the CodeGraph SDK.
 *
 * CodeGraph is treated as an **external tool**, exactly the way `clangd` was
 * before it: CodePort never bundles it. The per-platform bundle carries its own
 * Node runtime (~123 MB) and the npm package unpacks to ~292 MB, so vendoring it
 * into a `.vsix` is not an option. CodePort finds an installed copy and calls it
 * in-process.
 *
 * "In-process" matters: measured on a 46-file TypeScript project, loading the
 * SDK costs ~72 ms once, opening a graph ~5 ms, and an exact name lookup is
 * sub-millisecond — the same order as the SQLite index this replaces. There is
 * no daemon and no IPC on the query path.
 *
 * The package is CommonJS whose `module.exports` is assigned dynamically, so
 * Node's named-export detection cannot see through it: a dynamic `import()`
 * yields everything under `default`. {@link loadCodegraphSdk} normalises that.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GRAPH_DIR_NAME } from '../constants.ts';

/** Node kinds CodeGraph reports. A string union, so the sources stay strippable. */
export type CodegraphNodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component'
  | 'union';

/** One symbol node. Field names mirror CodeGraph's own `Node` exactly. */
export interface CodegraphNode {
  readonly id: string;
  readonly kind: CodegraphNodeKind;
  readonly name: string;
  readonly qualifiedName?: string | null;
  /** **Relative to the project root**, not absolute — see `toHit`. */
  readonly filePath: string;
  readonly language?: string | null;
  /** 1-based, unlike CodePort's own zero-based positions. */
  readonly startLine: number;
  readonly endLine: number;
  /** 0-based. */
  readonly startColumn: number;
  /** 0-based. */
  readonly endColumn: number;
  readonly signature?: string | null;
  readonly visibility?: string | null;
  readonly isExported?: boolean | null;
  readonly isAsync?: boolean | null;
}

/** One graph edge. `line`/`column` locate the *reference site*, not the target. */
export interface CodegraphEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly line?: number | null;
  readonly column?: number | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface CodegraphUsage {
  readonly node: CodegraphNode;
  readonly edge: CodegraphEdge;
}

/** Graph-level statistics, as reported by CodeGraph's own `status`. */
export interface CodegraphStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly fileCount: number;
  readonly dbSizeBytes: number;
  readonly filesByLanguage?: Record<string, number>;
}

/** The slice of the CodeGraph instance CodePort actually uses. */
export interface CodegraphGraph {
  getNodesByName(name: string): CodegraphNode[];
  getNodesByNamePrefix(prefix: string, limit?: number): CodegraphNode[];
  getNodesByNameSubstring(
    substring: string,
    options?: { readonly kinds?: readonly CodegraphNodeKind[]; readonly limit?: number }
  ): CodegraphNode[];
  getCode(nodeId: string): Promise<string | null>;
  findUsages(nodeId: string): CodegraphUsage[];
  getCallers(nodeId: string, maxDepth?: number): CodegraphUsage[];
  getStats(): CodegraphStats;
  close(): void;
}

export interface CodegraphGraphConstructor {
  isInitialized(projectRoot: string): boolean;
  openSync(projectRoot: string): CodegraphGraph;
  open(projectRoot: string, options?: { sync?: boolean; readOnly?: boolean }): Promise<CodegraphGraph>;
}

export interface CodegraphSdk {
  readonly CodeGraph: CodegraphGraphConstructor;
  readonly isInitialized: (projectRoot: string) => boolean;
  readonly findNearestCodeGraphRoot: (from: string) => string | null;
  readonly getSupportedLanguages: () => string[];
}

/** Where the SDK entry lives inside an installed package. */
const SDK_ENTRY = 'npm-sdk.js';
const PACKAGE_SEGMENTS = ['@colbymchenry', 'codegraph'];

export interface SdkLookupOptions {
  /** Explicit path from settings: package dir, SDK entry file, or CLI binary. */
  readonly configuredPath?: string;
  /** Workspace root, so a project-local install wins over a global one. */
  readonly workspaceRoot?: string;
  /** Extension install directory, so a bundled copy would win over a global one. */
  readonly extensionPath?: string;
  /** Extra candidate entries, used by tests. */
  readonly extraPaths?: readonly string[];
}

/** True when `root` holds a CodeGraph graph directory with a database in it. */
export function hasGraph(root: string): boolean {
  return fs.existsSync(path.join(root, GRAPH_DIR_NAME, 'codegraph.db'));
}

/**
 * The nearest ancestor of `from` (inclusive) that holds a CodeGraph graph.
 *
 * This mirrors the SDK's `findNearestCodeGraphRoot`, deliberately reimplemented
 * as a synchronous filesystem walk so `isAvailable()` stays cheap and correct
 * before the SDK has been loaded.
 */
export function findGraphRoot(from: string): string | undefined {
  let current = path.resolve(from);
  for (;;) {
    if (hasGraph(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Candidate SDK entry points, most specific first.
 *
 * An explicit setting always wins. After that a project-local install beats a
 * global one, a bundled copy beats a global one, and the well-known global
 * prefixes come last. `CODEGRAPH_SDK_PATH` is an escape hatch for tests and for
 * setups none of the guesses cover.
 */
export function candidateSdkEntries(options: SdkLookupOptions = {}): string[] {
  const entries: string[] = [];
  const push = (value: string | undefined): void => {
    if (!value) return;
    if (!entries.includes(value)) entries.push(value);
  };

  for (const candidate of [options.configuredPath, process.env.CODEGRAPH_SDK_PATH]) {
    for (const entry of expandEntry(candidate)) push(entry);
  }

  const modules = (base: string): string => path.join(base, 'node_modules', ...PACKAGE_SEGMENTS, SDK_ENTRY);
  if (options.workspaceRoot) push(modules(options.workspaceRoot));
  if (options.extensionPath) push(modules(options.extensionPath));

  const globals = [
    '/usr/local/lib',
    '/usr/lib',
    '/opt/homebrew/lib',
    process.env.NODE_PATH,
    path.join(process.env.HOME ?? '', '.npm-global', 'lib'),
    path.join(process.env.HOME ?? '', '.local', 'lib'),
  ];
  for (const base of globals) {
    if (base) push(modules(base));
  }

  for (const extra of options.extraPaths ?? []) push(extra);
  return entries;
}

/**
 * Turn a configured path into candidate SDK entry files.
 *
 * The setting accepts three shapes and we cannot always tell them apart without
 * touching the filesystem — a package directory and a CLI binary both look like
 * "a path that is not a .js file". So both readings are offered and the loader
 * takes the first that exists, rather than guessing here.
 */
function expandEntry(candidate: string | undefined): string[] {
  if (!candidate) return [];
  const resolved = path.resolve(candidate);
  if (resolved.endsWith('.js')) return [resolved];
  return [
    // `<package-dir>/npm-sdk.js`
    path.join(resolved, SDK_ENTRY),
    // `<bin-dir>/npm-sdk.js`, for a path pointing at the `codegraph` CLI
    path.join(path.dirname(resolved), SDK_ENTRY),
  ];
}

let cached: CodegraphSdk | undefined;

/**
 * Load the SDK once and cache it. Returns `undefined` when no installed copy can
 * be found or it cannot be imported — the caller degrades, it never throws.
 */
export async function loadCodegraphSdk(options: SdkLookupOptions = {}): Promise<CodegraphSdk | undefined> {
  if (cached) return cached;

  for (const entry of candidateSdkEntries(options)) {
    if (!fs.existsSync(entry)) continue;
    try {
      const imported: unknown = await import(pathToFileURL(entry).href);
      const api = (imported as { default?: unknown }).default ?? imported;
      const sdk = asSdk(api);
      if (sdk) {
        cached = sdk;
        return cached;
      }
    } catch {
      // Try the next candidate: a broken install in one prefix must not shadow
      // a working one in another.
    }
  }

  return undefined;
}

/** Reset the cache. Tests only. */
export function resetSdkCache(): void {
  cached = undefined;
}

function asSdk(api: unknown): CodegraphSdk | undefined {
  if (typeof api !== 'object' || api === null) return undefined;
  const record = api as Record<string, unknown>;
  const graph = record['CodeGraph'];
  if (typeof graph !== 'function') return undefined;
  if (typeof record['isInitialized'] !== 'function') return undefined;
  return api as CodegraphSdk;
}
