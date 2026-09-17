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
  /** Workspace root, so a project-local install wins over a global one. */
  readonly workspaceRoot?: string;
  /** Extension install directory, so a bundled copy would win over a global one. */
  readonly extensionPath?: string;
  /** Extra candidate entries, used by tests. */
  readonly extraPaths?: readonly string[];
  /**
   * Whether the workspace is trusted. Defaults to trusted.
   *
   * Set it from `vscode.workspace.isTrusted`: the workspace's own `node_modules` is
   * repository-controlled, and loading an SDK from there means importing and running
   * repository code in the extension host. Untrusted workspaces therefore get the
   * PATH and prefix installs, which the user controls, and nothing else.
   */
  readonly workspaceTrusted?: boolean;
  /** `PATH` to scan for a globally installed `codegraph`. Defaults to `process.env.PATH`. */
  readonly pathEnv?: string;
  /** Home directory behind the per-user prefixes. Defaults to `process.env.HOME`. */
  readonly homeDir?: string;
  /** nvm root, the directory holding `versions/node`. Defaults to `$NVM_DIR`, then `~/.nvm`. */
  readonly nvmDir?: string;
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
 * There is no setting for any of this: the extension is useless without CodeGraph,
 * and installing it is what puts `codegraph` on `PATH`. A project-local install
 * beats a global one and a bundled copy beats a global one, then the global
 * installs come last. `CODEGRAPH_SDK_PATH` is an escape hatch for tests and for
 * setups none of the guesses cover.
 *
 * The global half is where a plain `npm i -g @colbymchenry/codegraph` has to be
 * found, and it is deliberately searched three ways: by reading `PATH` (which
 * covers nvm, fnm, Volta and any custom prefix, because the `codegraph` shim
 * resolves to its own package), by the fixed prefixes, and by walking nvm's
 * per-version installs for the case where the editor was not started from a shell
 * that had nvm on `PATH`.
 */
export function candidateSdkEntries(options: SdkLookupOptions = {}): string[] {
  const entries: string[] = [];
  const push = (value: string | undefined): void => {
    if (!value) return;
    if (!entries.includes(value)) entries.push(value);
  };

  const pathEnv = options.pathEnv ?? process.env.PATH;
  const home = options.homeDir ?? process.env.HOME ?? '';

  for (const entry of expandEntry(process.env.CODEGRAPH_SDK_PATH, pathEnv)) push(entry);

  const modules = (base: string): string => path.join(base, 'node_modules', ...PACKAGE_SEGMENTS, SDK_ENTRY);
  // Only a trusted workspace may supply the SDK: `<workspace>/node_modules` is
  // repository content, and this path ends in an `import()`.
  if (options.workspaceRoot && options.workspaceTrusted !== false) push(modules(options.workspaceRoot));
  if (options.extensionPath) push(modules(options.extensionPath));

  for (const entry of sdkEntriesOnPath(pathEnv)) push(entry);

  const globals = [
    '/usr/local/lib',
    '/usr/lib',
    '/opt/homebrew/lib',
    process.env.NODE_PATH,
    path.join(home, '.npm-global', 'lib'),
    path.join(home, '.local', 'lib'),
  ];
  for (const base of globals) {
    if (base) push(modules(base));
  }

  for (const lib of nvmLibDirs(options.nvmDir ?? process.env.NVM_DIR ?? path.join(home, '.nvm'))) {
    push(modules(lib));
  }

  for (const extra of options.extraPaths ?? []) push(extra);
  return entries;
}

/**
 * Turn a value of `CODEGRAPH_SDK_PATH` into candidate SDK entry files.
 *
 * The variable accepts the same shapes a user would naturally write — a package
 * directory, the `npm-sdk.js` entry, the `codegraph` CLI, or the bare command name —
 * and we cannot always tell them apart without touching the filesystem: a package
 * directory and a CLI binary both look like "a path that is not a .js file". So
 * every reading is offered and the loader takes the first that exists, rather than
 * guessing here.
 *
 * Symlinks are resolved first, because a `codegraph` executable is exactly that: a
 * link into the package, whose SDK sits next to the *target*, not next to the link.
 */
function expandEntry(candidate: string | undefined, pathEnv: string | undefined): string[] {
  if (!candidate) return [];
  // A bare command name ("codegraph") most likely means the one on PATH, which is
  // how a user reads "point it at the CLI" — but fall back to a relative reading
  // so a value that merely lacks a separator is never silently dropped.
  const named = isBareName(candidate) ? findExecutable(candidate, pathEnv) ?? path.resolve(candidate) : path.resolve(candidate);
  const resolved = resolveSymlink(named);

  if (resolved.endsWith('.js')) {
    const beside = path.join(path.dirname(resolved), SDK_ENTRY);
    // `npm-shim.js` is the CLI launcher: it *execs* a bundled Node, so importing it
    // in-process would run the wrong program. The SDK next to it is what we want.
    return path.basename(resolved) === SDK_ENTRY ? [resolved] : unique([beside, resolved]);
  }

  return unique([
    // `<package-dir>/npm-sdk.js`
    path.join(resolved, SDK_ENTRY),
    // `<bin-dir>/npm-sdk.js`, for a path pointing at the `codegraph` CLI
    path.join(path.dirname(resolved), SDK_ENTRY),
  ]);
}

/** True when `value` names a command rather than locating a file. */
function isBareName(value: string): boolean {
  return !path.isAbsolute(value) && !value.includes('/') && !value.includes('\\');
}

/** The SDK entries behind a `codegraph` executable on `PATH`. */
function sdkEntriesOnPath(pathEnv: string | undefined): string[] {
  const found: string[] = [];
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const executable = findExecutableIn(dir, 'codegraph');
    if (executable) found.push(...sdkEntriesForExecutable(executable));
  }
  return found;
}

/**
 * Candidate SDK entries for one `codegraph` executable.
 *
 * A POSIX global install puts `<prefix>/bin/codegraph` as a symlink to
 * `<prefix>/lib/node_modules/@colbymchenry/codegraph/npm-shim.js`, so resolving the
 * link lands in the package. The second reading covers a launcher that is *not* a
 * link (`pnpm`, a copied shim): it still sits in `<prefix>/bin`, and npm's layout
 * below the prefix is the same either way. Both are derived from the paths we were
 * given, never by appending to the resolved target.
 */
function sdkEntriesForExecutable(executable: string): string[] {
  const resolved = resolveSymlink(executable);
  const prefix = path.dirname(path.dirname(executable));
  return unique([
    path.join(path.dirname(resolved), SDK_ENTRY),
    path.join(prefix, 'lib', 'node_modules', ...PACKAGE_SEGMENTS, SDK_ENTRY),
  ]);
}

/** The first `name` executable in `pathEnv`, the way a shell would pick it. */
function findExecutable(name: string, pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const found = findExecutableIn(dir, name);
    if (found) return found;
  }
  return undefined;
}

function findExecutableIn(dir: string, name: string): string | undefined {
  for (const suffix of executableSuffixes()) {
    const candidate = path.join(dir, name + suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** `''` on POSIX; the Windows launchers npm actually creates otherwise. */
function executableSuffixes(): readonly string[] {
  if (process.platform !== 'win32') return [''];
  const fromEnv = (process.env.PATHEXT ?? '').split(';').filter(Boolean);
  const exts = fromEnv.length > 0 ? fromEnv : ['.COM', '.EXE', '.BAT', '.CMD'];
  return ['', ...exts.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))];
}

/**
 * `lib` roots of every Node version nvm has installed, newest first.
 *
 * nvm gives each Node version its own global prefix, so `npm i -g` under nvm lands
 * somewhere no fixed directory list can name. Newest first because that is the Node
 * the editor is most likely to have been started with.
 */
function nvmLibDirs(nvmDir: string): string[] {
  const root = path.join(nvmDir, 'versions', 'node');
  let versions: string[];
  try {
    versions = fs.readdirSync(root);
  } catch {
    return [];
  }
  return versions
    .filter((version) => fs.existsSync(path.join(root, version, 'lib')))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => path.join(root, version, 'lib'));
}

/** `fs.realpathSync` without the throw: a missing path resolves to itself. */
function resolveSymlink(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
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
