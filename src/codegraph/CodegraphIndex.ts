/**
 * `CodegraphIndex` — CodePort's view of one CodeGraph graph.
 *
 * This is the facade the resolver talks to. It replaces the old `SymbolIndex` +
 * `IndexStore` + `Indexer` + `CppExtractor` stack (1810 lines) with a thin,
 * read-only adapter over CodeGraph, and it deliberately keeps the same lookup
 * contract (`exact`, then `prefix`) so the ranking and the hover
 * provenance work unchanged.
 *
 * Two coordinate facts are handled here and nowhere else:
 *
 * - CodeGraph reports **1-based** lines and **0-based** columns (LSP-style
 *   columns, but editor-style lines). CodePort is 0-based throughout, so lines
 *   are shifted by one on the way in.
 * - CodeGraph's `qualifiedName` uses `::` and includes the symbol itself
 *   (`CodePort::createPipeline`), while CodePort's `container` excludes it.
 */

import path from 'node:path';
import { loadCodegraphSdk, type CodegraphGraph, type CodegraphNode, type CodegraphNodeKind, type CodegraphStats, type CodegraphUsage, type SdkLookupOptions } from './sdk.ts';
import type { SymbolKind } from '../types.ts';

/**
 * CodeGraph kinds that are legitimate jump targets.
 *
 * Deliberately excludes `import` / `export` / `file` / `route` / `parameter`:
 * a mention of `x` in `foo(x)` must never land on a parameter node, and import
 * nodes are not definitions. `macro` is absent because CodeGraph has no macro
 * node kind at all — see docs/ARCHITECTURE.md.
 */
const JUMPABLE_KINDS: ReadonlySet<string> = new Set<CodegraphNodeKind>([
  'function',
  'method',
  'class',
  'struct',
  'union',
  'enum',
  'enum_member',
  'type_alias',
  'interface',
  'trait',
  'protocol',
  'namespace',
  'module',
  'variable',
  'constant',
  'field',
  'property',
  'component',
]);

/** CodeGraph kind -> CodePort kind. Unmapped kinds become `unknown`. */
const KIND_MAP: Readonly<Record<string, SymbolKind>> = {
  function: 'function',
  method: 'method',
  class: 'class',
  component: 'class',
  struct: 'struct',
  union: 'union',
  enum: 'enum',
  enum_member: 'enumerator',
  type_alias: 'typedef',
  interface: 'interface',
  trait: 'interface',
  protocol: 'interface',
  namespace: 'namespace',
  module: 'module',
  field: 'field',
  property: 'field',
  variable: 'variable',
  constant: 'variable',
};

/** A symbol as CodePort wants it: zero-based, container split out, kind mapped. */
export interface CodegraphHit {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName?: string;
  readonly kind: SymbolKind;
  readonly container?: string;
  readonly language?: string;
  readonly signature?: string;
  /** Absolute path of the defining file. */
  readonly file: string;
  /** Zero-based. */
  readonly line: number;
  /** Zero-based. */
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface CodegraphLookup {
  readonly match: 'exact' | 'prefix' | 'none';
  readonly hits: readonly CodegraphHit[];
}

export interface CodegraphIndexOptions {
  readonly sdk?: SdkLookupOptions;
  /** Max prefix hits to pull from CodeGraph. Default 50. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 50;

export class CodegraphIndex {
  private readonly graph: CodegraphGraph;
  readonly root: string;
  private closed = false;

  private constructor(root: string, graph: CodegraphGraph) {
    this.root = root;
    this.graph = graph;
  }

  /**
   * Open an existing graph read-only.
   *
   * Read-only matters: a CodeGraph daemon or another CodePort window may hold the
   * same database, and CodePort only ever reads it.
   */
  static async open(root: string, options: CodegraphIndexOptions = {}): Promise<CodegraphIndex | undefined> {
    const sdk = await loadCodegraphSdk({ ...options.sdk, workspaceRoot: options.sdk?.workspaceRoot ?? root });
    if (!sdk) return undefined;
    try {
      const graph = await sdk.CodeGraph.open(root, { readOnly: true, sync: false });
      return new CodegraphIndex(root, graph);
    } catch {
      return undefined;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Exact name first, then prefix — the same escalation the old index used.
   *
   * `getNodesByName` is CodeGraph's direct index lookup, documented as returning
   * *every* node with that name rather than a ranked, capped page, which is what
   * an overload-heavy C++ or TypeScript codebase needs.
   */
  query(name: string, options: { readonly limit?: number } = {}): CodegraphLookup {
    if (this.closed) return { match: 'none', hits: [] };
    const limit = options.limit ?? DEFAULT_LIMIT;

    const exact = this.jumpable(this.graph.getNodesByName(name));
    if (exact.length > 0) {
      return { match: 'exact', hits: exact.map((node) => toHit(node, this.root)) };
    }

    let prefix: CodegraphNode[] = [];
    try {
      prefix = this.jumpable(this.graph.getNodesByNamePrefix(name, limit));
    } catch {
      prefix = [];
    }
    if (prefix.length === 0) return { match: 'none', hits: [] };
    return { match: 'prefix', hits: prefix.map((node) => toHit(node, this.root)) };
  }

  /** Every node with this exact name, unfiltered — used for reference lookups. */
  nodeById(id: string): CodegraphNode[] {
    return this.jumpable(this.graph.getNodesByName(id));
  }

  /** Reference sites of a symbol: exact `line`/`column` of each usage. */
  usages(nodeId: string): readonly CodegraphUsage[] {
    if (this.closed) return [];
    try {
      return this.graph.findUsages(nodeId);
    } catch {
      return [];
    }
  }

  callers(nodeId: string, maxDepth = 1): readonly CodegraphUsage[] {
    if (this.closed) return [];
    try {
      return this.graph.getCallers(nodeId, maxDepth);
    } catch {
      return [];
    }
  }

  /** The symbol's own source text, read from disk by CodeGraph. */
  async code(nodeId: string): Promise<string | undefined> {
    if (this.closed) return undefined;
    try {
      return (await this.graph.getCode(nodeId)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Human-facing summary for the "Show Index Stats" command. */
  stats(): CodegraphStats | undefined {
    if (this.closed) return undefined;
    try {
      return this.graph.getStats();
    } catch {
      return undefined;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.graph.close();
    } catch {
      // A graph that cannot be closed is not worth failing a jump over.
    }
  }

  private jumpable(nodes: readonly CodegraphNode[]): CodegraphNode[] {
    return nodes.filter((node) => JUMPABLE_KINDS.has(node.kind));
  }
}

/**
 * Map one CodeGraph node onto CodePort's zero-based hit shape.
 *
 * `root` is required because CodeGraph reports `filePath` **relative to the
 * project root**, not as an absolute path.
 */
export function toHit(node: CodegraphNode, root: string): CodegraphHit {
  const qualifiedName = node.qualifiedName ?? undefined;
  const container = deriveContainer(qualifiedName, node.name);
  return {
    id: node.id,
    name: node.name,
    ...(qualifiedName ? { qualifiedName } : {}),
    kind: KIND_MAP[node.kind] ?? 'unknown',
    ...(container ? { container } : {}),
    ...(node.language ? { language: node.language } : {}),
    ...(node.signature ? { signature: node.signature } : {}),
    file: path.isAbsolute(node.filePath) ? node.filePath : path.resolve(root, node.filePath),
    line: Math.max(0, node.startLine - 1),
    column: Math.max(0, node.startColumn),
    endLine: Math.max(0, node.endLine - 1),
    endColumn: Math.max(0, node.endColumn),
  };
}

/** `CodePort::createPipeline` + `createPipeline` -> `CodePort`. */
export function deriveContainer(qualifiedName: string | undefined, name: string): string | undefined {
  if (!qualifiedName) return undefined;
  const suffix = `::${name}`;
  if (!qualifiedName.endsWith(suffix)) return undefined;
  const container = qualifiedName.slice(0, -suffix.length);
  return container.length > 0 ? container : undefined;
}

/**
 * Per-root cache of open graphs.
 *
 * Graphs are opened lazily and reused for the life of the window; CodeGraph keeps
 * the database in WAL mode, so a long-lived reader is cheap and never blocks a
 * concurrent indexer.
 */
export class CodegraphIndexService {
  private readonly indices = new Map<string, CodegraphIndex>();
  private readonly pending = new Map<string, Promise<CodegraphIndex | undefined>>();
  private readonly options: CodegraphIndexOptions;

  constructor(options: CodegraphIndexOptions = {}) {
    this.options = options;
  }

  /** The open graph for `root`, if one is already available. */
  lookup(root: string): CodegraphIndex | undefined {
    const index = this.indices.get(root);
    return index && !index.isClosed ? index : undefined;
  }

  /**
   * Languages the installed CodeGraph can parse — i.e. what CodePort can jump
   * into. Loads the SDK on first call, so this is asynchronous.
   */
  async supportedLanguages(): Promise<readonly string[]> {
    const sdk = await loadCodegraphSdk(this.options.sdk);
    return sdk?.getSupportedLanguages() ?? [];
  }

  /** Open (or reuse) the graph for `root`. Concurrent calls share one attempt. */
  async open(root: string): Promise<CodegraphIndex | undefined> {
    const existing = this.lookup(root);
    if (existing) return existing;

    const inFlight = this.pending.get(root);
    if (inFlight) return inFlight;

    const attempt = CodegraphIndex.open(root, this.options)
      .then((index) => {
        if (index) this.indices.set(root, index);
        return index;
      })
      .finally(() => {
        this.pending.delete(root);
      });

    this.pending.set(root, attempt);
    return attempt;
  }

  close(root: string): void {
    const index = this.indices.get(root);
    if (!index) return;
    this.indices.delete(root);
    index.close();
  }

  closeAll(): void {
    for (const root of [...this.indices.keys()]) this.close(root);
  }
}
