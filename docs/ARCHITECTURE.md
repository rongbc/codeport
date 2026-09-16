# CodePort architecture

> **English** · [简体中文](ARCHITECTURE.zh-CN.md)

This document describes the design CodePort converged on, **as actually built**. It replaced an earlier
design that combined a local tree-sitter index with the project's language servers; that design is
preserved in git history and summarised under [What changed](#what-changed).

The guiding principle:

> CodePort does not understand every programming language, and it does not try. It delegates that
> understanding to a code graph — CodeGraph — and owns only the part that is genuinely CodePort's job:
> deciding what a Markdown mention *means*, and turning an answer into an editor navigation target.

## Layers

```
┌────────────────────────────────────────────────────────────┐
│ Markdown                                                   │
│   `nx_start()`   `foo()`   `Bar`                           │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────┐
│ markdown/   MarkdownParser, CodeBlock, CodeSpan            │
│             → SymbolReference { name, range, language }    │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────┐
│ core/       CodePort facade                                │
│             → ResolveContext { symbol, language, project } │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────┐
│ resolution/ ResolverPipeline → CodegraphResolver           │
│             Evidence ranking, merge, provenance            │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────┐
│ codegraph/  sdk.ts         locate + load the SDK           │
│             CodegraphIndex per-root facade over one graph  │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
                  ┌───────────────────┐
                  │ CodeGraph (ext.)  │
                  │ .codegraph/       │
                  │   codegraph.db    │
                  └───────────────────┘
```

A dependency rule holds throughout: **nothing below `core/` imports `vscode`.** The Markdown parser, the
CodeGraph adapter, the resolver and the index facade are all plain Node modules, which is why the suite
covers the whole extension — bundle included — without a GUI.

## Directory layout

```
src/
├── extension.ts                 activate / deactivate, provider + command registration
├── constants.ts                 output channel name, graph directory, config sections
├── config.ts                    settings
├── logger.ts                    output channel (off | messages | verbose)
├── types.ts                     Position, Range, Location, SymbolReference, SymbolKind
├── codegraph/
│   ├── sdk.ts                   find and load an installed CodeGraph (never bundled)
│   └── CodegraphIndex.ts        per-root graph facade, node → hit mapping, kind + coordinate translation
├── core/
│   └── CodePort.ts              facade: owns the graphs, the pipeline, the Markdown parse cache
├── markdown/
│   ├── MarkdownParser.ts        code regions → SymbolReference[], symbolAt(), parse cache
│   ├── CodeBlock.ts             fenced blocks (``` / ~~~), info string → language id
│   └── CodeSpan.ts              inline code spans (CommonMark backtick-run rules)
├── resolution/
│   ├── Resolver.ts              SymbolResolver, ResolveContext, ResolutionResult, candidate
│   ├── Ranking.ts               the evidence signals, and the reasons they produce
│   ├── CompileCommands.ts       `compile_commands.json` discovery, parsing and cache (build signal)
│   ├── WeakLinkage.ts           weak-linkage detection on a definition line (strong beats weak)
│   ├── ResolverPipeline.ts      ordered run, per-resolver error isolation, merge
│   └── CodegraphResolver.ts     the one engine
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
  language?: string;       // from the fence info string — the only language signal left
  called?: boolean;        // followed by `(`
  kindHint?: SymbolKind;   // function | macro
  range: Range;            // the identifier itself
  codeRange: Range;        // the enclosing code region (link insertion target)
  inline: boolean;
}
```

The parser only scans fenced code blocks and inline code spans, never prose, and it explicitly skips file
mentions (`src/main.c:42`) and URLs so those stay owned by the code-link provider.

### Resolvers and results

```ts
interface SymbolResolver {
  readonly id: string;                 // 'codegraph'
  isAvailable(context: ResolveContext): boolean;      // cheap, synchronous pre-flight
  resolve(context: ResolveContext): Promise<ResolutionResult>;
}

interface ResolutionResult {
  resolver: string;
  candidates: ResolutionCandidate[];   // { location, rank, source, reason, symbol? }
  durationMs: number;
  error?: string;                      // a failing resolver never fails the jump
}
```

`ResolverPipeline.resolve()` runs the resolvers in order and merges. There is exactly one resolver today,
so the loop runs once — the seam is kept deliberately: a second opinion later means writing one resolver,
not touching the providers. A resolver that throws is recorded as an `error` and the pipeline continues.

## Ranking

There is **no numeric confidence**, and that is a deliberate deletion rather than an omission. The old
`0..1` score existed to be compared against `codeport.policy.indexAcceptConfidence` in order to decide
whether to escalate to a language server. With a single engine there is nothing to escalate to, so a
normalised `0.85` was fake precision: a number that gated nothing while reading like a probability. The
weights table, the normalisation and `clamp01` went with it.

What is still load-bearing is **ordering**. When several symbols share a name — overloads, or `static`
functions in different files — the mention's own evidence decides which one is offered first, because the
hover shows `candidates[0]` and the Peek list is read top-down. So a candidate carries an integer `rank`:
agreeing signals minus contradicting ones.

| Signal | Points |
|---|---|
| exact name (a prefix match earns none) | `+1` |
| qualifier agrees with the `a::b` prefix | `+1` |
| language family agrees with the fence | `+1` |
| mention shape agrees with the kind | `+1` |
| qualifier contradicts | `−1` |
| language contradicts | `−1` |
| the candidate's file is in the project's `compile_commands.json` | `+1` |

A fully corroborated hit therefore ranks `4`; a bare `` `nx_start` `` with no fence ranks `1`.

The last row is not a `rankCandidate` signal: a *mention* cannot agree or disagree with a build. It is
added by `CodegraphResolver` while it assembles the candidates, from `resolution/CompileCommands.ts`, and
it is the one signal that can take a candidate to `MAX_RANK + 1`.

### Build narrowing

**For C/C++ projects that have a `compile_commands.json`, the build database replaces the graph's list when
it has an answer for the name.** A graph is a static view of a whole tree, so a NuttX-style ARCH hook
(`up_allocate_heap`, one definition per chip) comes back as twenty equally-evidenced candidates ordered by
`(file_path, start_line)` — a property of the code, not of the build — and a Peek list is a coin flip. A
compilation database is the one artifact that knows which of those files the current build compiles
(`bear -- make`, CMake, `ninja -t compdb`), and "which definition does *this* build use" is the only
question a jump should answer. `narrowToBuild()` in `CodegraphResolver.ts` applies it in three steps:

1. **C-family candidates in the build are kept, the rest of the C-family list is dropped.** The
   alternatives are, by construction, not part of this build.
2. **Another language is never dropped.** A build database is a C/C++ artifact and must not hide a Python or
   Rust definition of one name; those candidates survive narrowing untouched.
3. **A strong definition beats a weak one.** Both `up_allocate_heap` files can be translation units of the
   same build, and then membership cannot separate them — but the linker can: NuttX's generic default is
   declared `weak_function` and the chip's override is not. `WeakLinkage.ts` reads that marker from the
   definition's own source line, which is the only place it exists in a graph built without a preprocessor
   and without a link step.

Narrowing runs **before** the `MAX_CANDIDATES` cap, so the definition a build compiles is found even when a
name-ordered query would have pushed it past the cap.

Four properties keep that narrowing honest:

- **No answer means no narrowing.** A note legitimately mentions symbols the current `.config` does not
  build (another board, `sim:nsh`, and the note is where the two are compared). When no candidate is in the
  build, nothing is dropped and the full list comes back with its mention evidence — exactly as before.
- **Failure is not an error.** No database, unreadable JSON, a database from another platform: no
  narrowing, no signal. Discovery walks up from the Markdown file but never leaves the workspace, so a
  `note/` symlink pointing elsewhere cannot pick up an unrelated build.
- **Weak linkage is read conservatively.** Only the exact line the graph points at, only the text in front
  of the symbol's own name, and only when a strong candidate exists to prefer. A miss costs a Peek list; a
  false positive would hide the right answer.
- **It is cheap and self-refreshing.** Discovery is a few `existsSync` calls per resolve; parsing is cached
  and invalidated by mtime and size, so re-running `bear -- make` after a platform switch is picked up
  without a window reload.

Three further properties are choices rather than accidents:

- **Contradictions subtract; they never reject.** `sameLanguageFamily` is false for every language outside
  its table, so a fence written ```` ```text ```` would otherwise look like a contradiction and silently
  drop every candidate. A demoted candidate still appears in the Peek list — at the bottom.
- **The match type never varies inside one result set.** `CodegraphIndex.query` returns the exact hits when
  there are any, otherwise the prefix hits, never a mix. The exact/prefix point therefore only shows up in
  the hover text today; it stays a point rather than a tie-break so an exact hit would still outrank an
  equally-evidenced prefix hit if a second engine ever merged both.
- **There is no "uniqueness" term.** It used to contribute `+0.10` when only one candidate existed, which
  describes the result set rather than giving evidence about *which* candidate is right, so it cannot order
  anything.

The hover renders the reasons verbatim, and they are the whole explanation:

```
nx_start — nx · function

void nx_start(void)

a.c:7
codegraph · exact name, language c, kind function
```

Language agreement is compared by **family**, not by exact id: a project whose build language is `cpp`
contains `.c` files, and that is not a contradiction. Families live in `util/language.ts`.

One consequence of the language signal being fence-only: a bare `` `nx_start` `` with no fence ranks `1`
where the old design scored it `0.70`, because a three-level strategy could infer the language from the
document's project. That changes ordering and the hover line, not whether a jump works.

## The CodeGraph integration

CodeGraph is an **external tool**, treated exactly the way `clangd` was: CodePort never bundles it. The
per-platform bundle carries its own Node runtime (`node` alone is ~123 MB; the npm package unpacks to
~292 MB), so vendoring it into a `.vsix` is not an option. `src/codegraph/sdk.ts` finds an installed copy
and loads it **in-process**:

- candidates, in order: the `codeport.codegraph.path` setting, `CODEGRAPH_SDK_PATH`, the project's
  `node_modules`, the extension's own `node_modules`, then the usual global prefixes;
- the package is CommonJS whose `module.exports` is assigned dynamically, so a dynamic `import()` yields
  everything under `default`; the loader normalises that;
- a load attempt that fails falls through to the next candidate, so a broken install in one prefix cannot
  shadow a working one in another.

Why in-process rather than a CLI or the MCP server: measured on a 46-file TypeScript project, loading the
SDK costs ~72 ms once, opening a graph ~5 ms, and an exact name lookup is sub-millisecond. There is no
daemon, no socket and no IPC on the query path. The CLI equivalent is ~180 ms per call because every
invocation re-execs a runtime.

### What CodeGraph gives CodePort

| Need | CodeGraph API |
|---|---|
| all definitions of a name, uncapped | `getNodesByName` (documented as enumerating every overload) |
| weak mentions | `getNodesByNamePrefix` |
| exact location | `Node.startLine` / `endLine` / `startColumn` / `endColumn` |
| hover text | `Node.signature`, else `getCode` (reads the file) |
| Find All References | `findUsages` — edges carry the **line and column of the call site** |
| freshness | `isInitialized`, `getStats` |

### Two conversions that live in one place

`CodegraphIndex.toHit` is the only place these are handled, and both are the kind of mistake that sends a
jump to the wrong place instead of failing loudly — so both are pinned by tests:

1. CodeGraph reports **1-based lines** and **0-based columns**. CodePort is 0-based, so lines shift by one.
2. CodeGraph reports `filePath` **relative to the project root**, not absolute. It is resolved against the
   graph root, never against the process working directory.

The graph root itself is found by walking up from a file looking for `.codegraph/codegraph.db`,
reimplemented locally (rather than through the SDK) so that `isAvailable()` stays synchronous and correct
before the SDK has been loaded.

### Capability boundary

CodeGraph's graph is **structural**, the same class of answer tree-sitter used to give — broader and
faster, not more semantic. What that costs:

| | CodeGraph |
|---|---|
| file count / speed | milliseconds, no build system needed |
| languages | broad (36 in the version tested) |
| overloads, templates, conditional compilation | **no** — resolved by name and import, not semantically |
| preprocessor macros | **no node kind at all** — a `#define` name cannot be a jump target |
| Find All References | a static call/reference graph, not a semantic one |

The macro gap is the one outright regression against the retired design, which extracted `#define` names
with its own tree-sitter walker. The Definition provider's "not found" hint says so explicitly.

## Path / line links

Path links are the half of the extension that never touched the symbol engine, and they still do not.
`providers/DocumentLinkProvider.ts` is a regex plus `fs.statSync`; it calls `CodePort` exactly once, for
configuration. It scans the **whole document text**, not just code spans, and resolves targets as
absolute → workspace-root-relative → (optionally) relative to the Markdown file.

That independence is deliberate and now enforced by tests: path links are asserted to keep working when
CodeGraph is absent, unopenable, or healthy.

## Settings

The settings that configured the retired index and clangd tiers are gone — CodeGraph owns both jobs, and
its configuration lives in the project's `codegraph.json` and `.codegraph/` directory, not in VS Code.

| Setting | Purpose |
|---|---|
| `codeport.enabled` | master switch |
| `codeport.definition.enabled` | go-to-definition |
| `codeport.references.enabled` | Find All References |
| `codeport.hover.enabled` | hover |
| `codeport.codeLink.enabled` | path/line links |
| `codeport.codeLink.resolveRelativeToMarkdownFile` | also resolve path links next to the note |
| `codeport.codegraph.path` | where CodeGraph is installed (empty = auto-detect) |
| `codeport.trace` | log level |

## Testing

| File | Covers |
|---|---|
| `test/markdown.test.ts` | inline/fenced extraction, keyword and path/URL skipping, CommonMark backtick rules, cursor resolution |
| `test/codegraph.test.ts` | the two coordinate/path conversions, kind mapping, container derivation, graph discovery, SDK lookup and loading, the per-root index cache |
| `test/resolution.test.ts` | every ranking signal and contradiction, kinds/qualifier agreement, merge ordering, pipeline error isolation and cancellation, the resolver end to end over a fixture graph, build narrowing (CDB lookup, no-answer fallback, strong-over-weak, cap interaction) and its database finder/parse/cache |
| `test/activation.test.ts` | **the real esbuild bundle** on a stubbed VS Code API and a temporary project: provider/command registration, definition, hover provenance, hover source fallback, references with exact call sites, **path links** |
| `test/degradation.test.ts` | no index, an unopenable index, a macro that cannot be indexed, and path links in all three states |
| `test/architecture.test.ts` | the enforced invariants: nothing below `core/` imports `vscode`, no TypeScript parameter properties, CodeGraph is never statically imported, contributed/registered/read settings stay consistent |

Tests reach CodeGraph through `test/fixtures/fake-codegraph-sdk.js` and
`fake-codegraph-sdk-broken.js` (`CODEGRAPH_SDK_PATH`), so the suite neither needs nor is affected by a
real CodeGraph install. `test/activation.test.ts` and `test/degradation.test.ts` intentionally run the
built bundle rather than the sources, so a broken build fails the suite.

## What changed

The previous architecture ran two interchangeable engines — a local tree-sitter index in
`.codeport/index.db` and the project's language server (clangd first) — and a policy decided how to
combine them.

| Then | Now | Why |
|---|---|---|
| tree-sitter WASM + `node:sqlite` index (1810 lines) | CodeGraph graph, read-only | broad language coverage without one extractor per language; a shared index the rest of the toolchain can use too |
| clangd via a hand-written LSP client (1073 lines) | removed | CodeGraph answers references and hover; keeping a compiler-grade tier was out of scope for the chosen direction |
| four resolution policies | one deterministic merge | a single engine has nothing to trade off against |
| three-level language detection | the fence info string | CodeGraph detects language per file itself |
| project detection to decide whether to start a server | removed | the only consumer was clangd |
| ~5.4 MB of WASM assets in the `.vsix` | nothing | CodeGraph loads its own parsers |
| a normalised `0..1` confidence score | an integer evidence rank | with one engine there is no threshold left to compare a score against, so the number gated nothing |
| a `mdCodeLinks.*` settings migration | removed | CodePort is pre-1.0 and the one legacy key that had a destination is gone |
