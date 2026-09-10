# CodePort architecture

> **English** · [简体中文](ARCHITECTURE.zh-CN.md)

This document describes the design CodePort converged on, **as actually built**. Two earlier proposals
shaped it: one for a renamed, adapter-based architecture (CodeNav) and one for a dual engine combining a
local index with language servers (CodePort). What follows is the merged, implemented result.

The guiding principle:

> CodePort does not understand every programming language. It delegates that understanding to language
> servers and to a local index, and never lets either one own the answer.

## Layers

```
┌──────────────────────────────────────────────────────────┐
│ Markdown                                                 │
│   `nx_start()`   `foo()`   `Bar`                         │
└───────────────────────┬──────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│ markdown/     MarkdownParser, CodeBlock, CodeSpan        │
│               → SymbolReference { name, range, language }│
└───────────────────────┬──────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│ core/         CodePort facade, ProjectManager,           │
│               LanguageManager, IndexService              │
│               → ResolveContext { symbol, language, project│
└───────────────────────┬──────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│ resolution/   ResolverPipeline + Policy + Confidence     │
│                                                          │
│      ┌──────────────┐            ┌──────────────┐        │
│      │ IndexResolver│            │  LspResolver │        │
│      └──────┬───────┘            └──────┬───────┘        │
└─────────────┼───────────────────────────┼────────────────┘
              ▼                           ▼
┌───────────────────────────┐  ┌──────────────────────────┐
│ index/   tree-sitter WASM │  │ adapters/  LanguageAdapter│
│          node:sqlite      │  │            ClangdAdapter  │
│          .codeport/index.db│ │ project/   ProjectDetector│
└───────────────────────────┘  └──────────────┬───────────┘
                                             ▼
                                   ┌──────────────────────┐
                                   │ lsp/   LspClient     │
                                   │        (stdio, JSON- │
                                   │         RPC framing) │
                                   └──────────────────────┘
                                             ▼
                                    clangd / rust-analyzer / …
```

A dependency rule holds throughout: **nothing below `core/` imports `vscode`.** The Markdown parser, the
index, the LSP transport, the adapters and the resolver pipeline are all plain Node modules, which is why
80 tests can cover them (and the whole extension) without a GUI.

## Directory layout

```
src/
├── extension.ts                 activate / deactivate, provider + command registration
├── constants.ts                 version, channel name, config sections
├── config.ts                    settings + mdCodeLinks.* migration
├── logger.ts                    output channel (off | messages | verbose)
├── types.ts                     Position, Range, Location, SymbolReference, SymbolKind
├── core/
│   ├── CodePort.ts              facade: owns everything, rebuilds the pipeline on config change
│   ├── ProjectManager.ts        cached project detection
│   ├── LanguageManager.ts       3-level language strategy + LspTargetProvider
│   └── IndexService.ts          index lifecycle, file watching, debounced incremental updates
├── markdown/
│   ├── MarkdownParser.ts        code regions → SymbolReference[], symbolAt(), parse cache
│   ├── CodeBlock.ts             fenced blocks (``` / ~~~), info string → language id
│   └── CodeSpan.ts              inline code spans (CommonMark backtick-run rules)
├── lsp/
│   ├── protocol.ts              the LSP subset used, plus conversions
│   ├── LspClient.ts             generic stdio client (no language knowledge)
│   └── LspClientPool.ts         one client per adapter+project, shared startup
├── adapters/
│   ├── LanguageAdapter.ts       the interface + default LSP-backed implementations
│   ├── AdapterRegistry.ts       language id → adapter, honouring user overrides
│   ├── clangd/ClangdAdapter.ts  binary discovery, argv, seed files
│   └── index.ts                 built-in adapters + registry factory
├── project/
│   ├── Project.ts               { root, adapterId, language, markers, compileCommandsDir }
│   ├── ProjectDetector.ts       the interface
│   └── detectors/CppProjectDetector.ts
├── index/
│   ├── schema.ts                SQL DDL + schema version
│   ├── IndexStore.ts            node:sqlite wrapper (lazy, optional, defensive)
│   ├── TreeSitterParser.ts      WASM runtime + grammar loading
│   ├── SymbolExtractor.ts       extraction interface + registry
│   ├── CppExtractor.ts          tree-sitter AST walker for C/C++
│   ├── Indexer.ts               full scan + incremental sync, yields to the event loop
│   └── SymbolIndex.ts           per-workspace facade (store + parser + indexer)
├── resolution/
│   ├── Resolver.ts              SymbolResolver, ResolveContext, ResolutionResult, candidate
│   ├── Confidence.ts            index/LSP weights and scoring
│   ├── Policy.ts                index-first / lsp-first / index-only / lsp-only + merge
│   ├── ResolverPipeline.ts      ordered run, per-resolver error isolation
│   ├── IndexResolver.ts         answers from the index
│   └── LspResolver.ts           answers through adapters; references/hover at real positions
├── providers/                   Definition, Reference, Hover, DocumentLink providers
├── commands/                    insert source link + the command palette entries
├── util/                        text, path/glob, language ids, uri conversion
└── vscode/convert.ts            plain types ↔ vscode types
```

## Core interfaces

### Meaning a symbol mention

```ts
interface SymbolReference {
  name: string;            // `start` for `nx::start`
  raw: string;             // `nx::start`
  container?: string;      // `nx`
  language?: string;       // from the fence info string
  called?: boolean;        // followed by `(`
  kindHint?: SymbolKind;   // function | macro
  range: Range;            // the identifier itself
  codeRange: Range;        // the enclosing code region (link insertion target)
  inline: boolean;
}
```

The parser only scans fenced code blocks and inline code spans, never prose, and it explicitly skips
file mentions (`src/main.c:42`) and URLs so those stay owned by the code-link provider.

### Language adapters

```ts
abstract class LanguageAdapter {
  readonly id: string;
  readonly languages: readonly string[];
  readonly detector: ProjectDetector;
  abstract serverSpec(project: Project): LspServerSpec;
  abstract seedFiles(project: Project, limit?: number): readonly SeedFile[];
  languageId(language: string): string;
  workspaceSymbol(client, query, container?): Promise<SymbolMatch[]>;   // default: LSP
  definition(client, uri, position): Promise<Location[]>;               // default: LSP
  references(client, uri, position, includeDeclaration): Promise<Location[]>; // default: LSP
  hover(client, uri, position): Promise<string | undefined>;            // default: LSP
}
```

The base class implements every capability on top of standard LSP requests, so a new adapter usually only
provides `serverSpec` and `seedFiles`. `workspaceSymbol` normalises each hit into an `exact` /
`qualified` / `fuzzy` match, which is what feeds confidence scoring.

### Resolvers and results

```ts
interface SymbolResolver {
  readonly id: string;                 // 'index' | 'lsp'
  readonly kind: 'index' | 'lsp';
  isAvailable(context: ResolveContext): boolean;      // cheap pre-flight
  resolve(context: ResolveContext): Promise<ResolutionResult>;
}

interface ResolutionResult {
  resolver: string;
  candidates: ResolutionCandidate[];   // { location, confidence, source, reason, symbol? }
  confidence: number;                  // best candidate
  durationMs: number;
  error?: string;                      // a failing resolver never fails the jump
}
```

`ResolverPipeline.resolve()` runs the permitted resolvers in policy order, stops as soon as the policy is
satisfied, records every result, and merges. A resolver that throws is recorded as an `error` and the
pipeline continues — if the index is broken but clangd works, navigation still works.

## Confidence

The plan gave relative weights; here they are normalised so a fully corroborated hit reaches exactly
`1.0`, which makes a threshold meaningful.

| Index evidence | Weight |
|---|---|
| exact name | `+0.50` |
| name prefix only | `+0.20` |
| qualifier agrees with `a::b` prefix | `+0.15` |
| language family agrees with the fence/project | `+0.10` |
| mention shape agrees with the kind | `+0.15` |
| exactly one candidate in the workspace | `+0.10` |
| qualifier contradicts | `−0.20` |
| language contradicts | `−0.10` |

| Language-server match | Confidence |
|---|---|
| `workspace/symbol`, qualified | `0.95` |
| `workspace/symbol`, exact | `0.92` |
| `workspace/symbol`, partial | `0.60` |
| `textDocument/definition` | `0.98` |
| `textDocument/references` | `0.92` |

Language agreement is compared by **family**, not by exact id: a project whose build language is `cpp`
contains `.c` files, and that is not a contradiction. Families live in `util/language.ts`.

Consequences, and they are deliberate:

- ```` ```c ```` + `` `nx_start()` `` → `0.85` (exact, family, kind, unique) → served from the index, no
  server call.
- `` `nx_start` `` bare → `0.70` → the server is consulted.
- a prefix match can never exceed `0.75` → always confirmed.

## Policies

`index-first` (default) stops after the index when there is exactly one candidate at or above
`codeport.policy.indexAcceptConfidence` (0.85). `lsp-first` stops as soon as the server answers.
`index-only` and `lsp-only` restrict `order()` to one engine. Merging de-duplicates by
`uri:line:character`, keeps the highest confidence, and ranks descending — so a server hit (≥ 0.92)
outranks an unconfirmed index hit with no special-casing.

## The index

Schema (`index/schema.ts`), line/column zero-based:

```sql
files(id, path UNIQUE, language, size, mtime, hash)
symbols(id, file_id→files, name, qualified_name, kind, container,
        line, column, end_line, end_column, signature)
symbol_references(id, file_id→files, symbol_id→symbols, name, kind, line, column)
includes(id, file_id→files, target)
meta(key, value)   -- schema_version
```

The table is named `symbol_references`, not `references`, because the latter is a SQL keyword that would
need quoting everywhere.

- **On disk**: `.codeport/index.db` (SQLite in WAL mode). The same directory receives a generated
  `.codeport/.gitignore`, so the cache is never committed.
- `Indexer.fullIndex()` walks the workspace (skipping symlinks and excludes), loads each needed grammar
  once, then re-parses only files whose SHA-1 content hash changed, and prunes rows for deleted files.
- `Indexer.indexPaths()` is the incremental path used by the watcher: create/change/delete events from
  the workspace `FileSystemWatcher` are applied in 500 ms batches.
- One file is one transaction, so a parse failure cannot corrupt the index.
- Parsing and `node:sqlite` are synchronous, so the loop yields to the event loop every 25 files; that is
  what keeps the extension host responsive on a large workspace.
- `schema_version` mismatch → drop and recreate. The index is a cache.
- **Workspace-scoped, not project-scoped.** `IndexService` builds an index for a workspace folder
  without consulting project detection, because the index needs no build system: `compile_commands.json`
  is a requirement of *clangd*, not of CodePort. Only the language server is gated on a detected project
  (`compile_commands.json` / `.clangd`). `startInBackground()` is idempotent per root, so the resolver
  can call it on demand (`index.prewarm = false`) without queueing duplicate scans. Gating the index on
  project detection was a real defect: without either marker the index was never populated and every
  lookup failed — `test/degradation.test.ts` guards against it.

### Why tree-sitter *and* clangd

tree-sitter recovers structure: functions, methods, aggregates, enum members, typedefs, aliases,
variables, fields, namespaces, macros, includes. It cannot decide what `foo(x)` means — that is overload
resolution, template instantiation and macro expansion, which is exactly what the language server is for.
The index gives speed and offline coverage; the server gives correctness. Neither is asked to do the
other's job.

| | CodePort Index | Language server |
|---|---|---|
| Speed | milliseconds, no server needed | depends on the server / its own index |
| Works offline | yes | needs the server |
| C++ overloads, templates, macros, conditional compilation | no | yes |
| Cost | tree-sitter parse + a tiny SQLite database | full compiler-grade parse |

## Language detection (3 levels)

1. **Fence info string** — ```` ```c ```` is the strongest signal; the adapter is chosen from it (with
   `codeport.languages` overrides).
2. **Document context** — the document's own project: `docs/` inside a CMake tree is still C/C++.
3. **Workspace fallback** — try every project in the workspace. If nothing answers, report
   *no definition found*. CodePort never guesses.

Implemented in `core/LanguageManager.ts`, which also implements `LspTargetProvider`. That injection is why
`resolution/LspResolver.ts` contains no workspace or configuration logic.

## Adding a language

1. `project/detectors/RustProjectDetector.ts` — implement `ProjectDetector` (look for `Cargo.toml`).
2. `adapters/rust/RustAnalyzerAdapter.ts` — extend `LanguageAdapter`: `id`, `languages`, `detector`,
   `serverSpec`, `seedFiles`. Add `rust` to the `GRAMMARS` list in `scripts/build.mjs` and write a
   `RustExtractor` if the local index should cover it.
3. Register it in `adapters/index.ts`.

Nothing else changes: the core, the resolver pipeline, the policies, the providers, the index store and
the commands are language-agnostic. If you skip step 2's extractor, Rust still works through
rust-analyzer alone — `SymbolIndex.create` simply reports fewer supported languages.

## Deviations from the original proposals, and why

| Original proposal | As built | Reason |
|---|---|---|
| Name `CodeNav` (earlier proposal) | `CodePort` (later proposal) | The later proposal superseded the earlier one, and "dual engine" is the more accurate description. |
| SQLite via a driver | Node's built-in `node:sqlite` | VS Code 1.130 bundles Node 24, so real SQLite needs no native module, no `electron-rebuild`. Detected defensively: absent → index disabled, LSP-only. |
| Tree-sitter via native bindings | `@vscode/tree-sitter-wasm` (WASM) | No ABI coupling to VS Code's Node; assets are copied into `dist/wasm/` so the package is self-contained. |
| `references` table | `symbol_references` | `references` is a SQL keyword. |
| Call/inheritance graphs | not built | Explicitly out of scope in the later proposal: they would turn a navigation aid into a code-intelligence engine. |
| Weight numbers | normalised to sum to 1.0 | The proposals' example weights did not reach their own 0.90 accept threshold. |
| `confidence >= 0.90` accept | `0.85`, configurable | At 0.90 the index fast path is nearly unreachable, making the index pointless. |
| Tree-sitter "C" grammar | C++ grammar for `.c` | `@vscode/tree-sitter-wasm` ships no plain C grammar; the C++ grammar is a superset. |

## Testing

| File | Covers |
|---|---|
| `test/markdown.test.ts` | inline/fenced extraction, keyword and path/URL skipping, CommonMark backtick rules, cursor resolution |
| `test/cpp-extractor.test.ts` | symbol kinds, containers, signatures, includes, references, elaborated-type-reference regression |
| `test/index-store.test.ts` | schema, exact/prefix queries, `LIKE` escaping, cascade deletes, pruning, on-disk persistence |
| `test/confidence-policy.test.ts` | weights, thresholds, families, policy ordering, merge ranking, pipeline fast path, escalation, error isolation, cancellation |
| `test/lsp-client.test.ts` | real JSON-RPC framing over a mock server: handshake, multi-byte UTF-8, server→client requests, spawn failure, pool reuse |
| `test/activation.test.ts` | **the real esbuild bundle** on a stubbed VS Code API and a temporary C project: provider/command registration, index build, definition, hover provenance, references through real clangd, clean shutdown |
| `test/architecture.test.ts` | the enforced invariants: nothing below `core/` imports `vscode`, no TypeScript parameter properties, adapter contracts, policy ids match the settings enum, and contributed/registered/read settings stay consistent |
| `test/degradation.test.ts` | **no build system and no language server**: the index is still built from the workspace alone, definition/hover/link work, a weak mention that escalates to a dead server still resolves from the index, and Find All References reports nothing rather than guessing |

`test/activation.test.ts` intentionally uses the built bundle rather than the sources, so a broken build
or a missing WASM asset fails the suite.
