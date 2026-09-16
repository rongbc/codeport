# Changelog

All notable changes to this project will be documented in this file.

## [0.2.3] - 2026-09-17

### Changed

- **The build signal now narrows, it no longer merely reorders.** 0.2.2 ranked a
  `compile_commands.json` translation unit first but still returned all twenty same-named definitions, so a
  Ctrl+Click in a note opened a Peek list — and whichever entry was taken became the file clangd then
  preferred for that symbol in source files. With a C/C++ build database that has an answer for the name,
  the answer now *replaces* the list: C-family candidates outside the build are dropped (candidates of
  another language are never dropped, because a C/C++ database cannot speak for them), and among the
  survivors a weak definition loses to a strong one. Verified on this repository's own notes:
  `up_allocate_heap` resolves to exactly one location, the chip override
  (`nuttx/arch/src/common/stm32/stm32_allocateheap_m3m4_v1.c:659`), not the generic `weak_function` default
  and not another chip's file. When the database has no answer for the name nothing is dropped, so notes
  about a board or `sim:nsh` the workspace is not configured for still resolve as before.
- Narrowing runs before the `MAX_CANDIDATES` cap, so a definition that a name-ordered graph query would have
  pushed past the twentieth hit is still found.
- `test/resolution.test.ts` grew from 31 to 36 tests (narrowing, the no-answer fallback, strong-over-weak,
  weak-linkage parsing, and the cap interaction).

### Added

- `src/resolution/WeakLinkage.ts`: detects a weak-linkage marker (`weak_function`, `__attribute__((weak))`,
  `WEAK`) on the definition's own source line, reading only the text in front of the symbol's name. This is
  the tie-break the linker applies between NuttX's generic ARCH default and a chip's override, and the only
  place it exists in a graph built without a preprocessor and without a link step.
- `STRONG_DEFINITION`, the reason a narrowed candidate carries when a weak definition was dropped.

## [0.2.2] - 2026-09-17

### Added

- **The build signal: `compile_commands.json` breaks ties between same-named definitions.** A static
  graph returns one `up_allocate_heap` definition per chip, all with identical evidence, so the order
  between them fell back to `(file_path, start_line)` — which is how a jump lands on another chip's file.
  For C/C++ projects that have a compilation database, a candidate whose file is a translation unit of that
  build now carries one more point (`BUILD_SIGNAL`) and is offered first. It is an optimization, not a
  filter: candidates outside the build keep their mention evidence and stay in the Peek list, no database
  means no signal at all, and non-C/C++ candidates are never reordered by a C/C++ database. New module
  `src/resolution/CompileCommands.ts` (discovery walks up from the Markdown file but never leaves the
  workspace; parsing is cached and invalidated by mtime and size, so `bear -- make` after a platform switch
  is picked up without a reload).

## [0.2.1] - 2026-09-17

### Changed

- Deleted the code the engine replacement left behind in modules that are still live. No behaviour
  change, but a fair amount of surface: `util/path.ts` lost the glob matcher and source-file classifier
  it inherited from the retired indexer and shrank from 113 to 19 lines, and `sha1`, `offsetAt`,
  `isIdentifierChar`, `oneLine`, `sameLanguage`, `SYMBOL_KINDS`, `rangeKey`, `isFenceDelimiter`,
  `fromVsRange`, `toVsPosition`, `loadedSdk` and `sdkUnavailable` went with it.
- Removed the unused `text` parameter from `positionAt`/`rangeFromOffsets`, and the now-unreachable
  `vscode` stub members (`RelativePattern`, `ProgressLocation`, `EventEmitter`, `createFileSystemWatcher`,
  `withProgress`).
- `test/fixtures/mock-lsp-server.mjs` is gone: it existed for the deleted LSP client's framing test and
  nothing referenced it.

### Added

- `noUnusedLocals`, so this class of rot is caught by the build instead of by grepping. The vscode stub
  also gained the `env.clipboard` the `Copy Command` branch calls — it was missing, and the branch was
  only unreachable because the stub's prompt returns `undefined`.

## [0.2.0] - 2026-09-17

### Changed

- **Version 0.2.0 is a breaking change**; no compatibility with 0.1.x is provided.
- **The symbol engine is now CodeGraph, and it is the only one.** The local tree-sitter index
  (`.codeport/index.db`) and the language-server tier (clangd via a hand-written LSP client) are gone —
  roughly 2,900 lines of source and 5.4 MB of WASM assets. CodePort reads a
  [CodeGraph](https://github.com/colbymchenry/codegraph) graph directly, in-process, with no daemon and no
  IPC. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-changed).
- **Any language CodeGraph parses now works**, instead of C/C++ only. There is no per-language adapter,
  extractor or project detector to write.
- **Find All References comes from the code graph.** CodeGraph's edges carry the exact line and column of
  each usage, so shift-F12 keeps resolution without a language server.
- **Path/line links are unaffected** and were already independent of the symbol engine; they now have
  tests asserting they survive CodeGraph being absent or unopenable.

### Added

- **`codeport.codegraph.path`** — where CodeGraph is installed (package directory, `npm-sdk.js` entry, or
  the `codegraph` CLI). Empty auto-detects the project's `node_modules` and the usual global prefixes.
  `CODEGRAPH_SDK_PATH` overrides it for scripts and tests.
- A `codegraph/` layer (`sdk.ts`, `CodegraphIndex.ts`) that owns the two conversions that are easy to get
  silently wrong: CodeGraph's 1-based lines, and its project-root-relative file paths.

### Removed

- **Settings**: `codeport.policy`, `codeport.policy.indexAcceptConfidence`, `codeport.index.*`,
  `codeport.languages`, `codeport.clangd.*`. A single engine has no policy to pick, and CodeGraph owns
  index configuration (in the project's `codegraph.json`).
- **The whole `md-code-links` migration.** The `CodePort: Migrate mdCodeLinks Settings` command, the
  `mdCodeLinks.*` reader and the `offerLegacyMigration` activation prompt are gone. CodePort is pre-1.0 and
  has no released settings surface worth preserving; the one legacy key that ever had a destination
  (`mdCodeLinks.enableFunctionJump`) pointed at a capability that no longer has a setting of its own.
- **The numeric confidence score.** `CODEGRAPH_WEIGHTS`, the normalisation and `clamp01` are gone, and the
  hover no longer prints a `0.85`. That number existed to be compared against
  `codeport.policy.indexAcceptConfidence`, which no longer exists, so it gated nothing while reading like a
  probability. `Confidence.ts` is now `Ranking.ts` and produces an integer evidence rank, which is what
  actually orders several same-named symbols. The vestigial "uniqueness" term (a property of the result
  set, not evidence about a candidate) went with it, and contradictions now subtract instead of rejecting —
  `sameLanguageFamily` is false for every language outside its table, so rejecting would have let a
  ```` ```text ```` fence silently drop every candidate.

### Known regressions

- **Preprocessor macros can no longer be jumped to.** CodeGraph has no macro node kind, so a `#define`
  name is not in the graph. The Definition provider's "not found" hint says so.
- **A bare mention with no fence language scores lower** (`0.60`, was `0.70`): the three-level language
  strategy is gone and the fence info string is the only remaining signal. This affects ranking and the
  hover's provenance line, not whether a jump works.
- **Overloads, templates and conditional compilation** are matched by name and import rather than
  semantically. This is the same class of answer the old index gave, not a capability the language-server
  tier used to provide.

### Requirements

- **CodeGraph must be installed and the project indexed** (`npm i -g @colbymchenry/codegraph` then
  `codegraph index`). Without it CodePort still activates and path links still work, but symbol navigation
  reports "no definition found" with a hint.

## [0.1.1] - 2026-09-14

### Fixed

- **`CodePort: Rebuild Index` no longer fails with `Maximum call stack size exceeded`.** The C/C++
  extractor walked the syntax tree recursively; generated or macro-heavy sources with deeply nested
  expressions, initialisers or namespaces overflowed the call stack and aborted the whole rebuild. The
  walk (and the call-callee resolver) now use an explicit stack / bounded loop, so tree depth is no
  longer a limit.
- A single file that fails symbol extraction is now skipped and logged instead of aborting the entire
  index run.
- Command titles no longer render with a doubled prefix (`CodePort: CodePort: …`).

## [0.1.0] - 2026-09-10

CodePort: `md-code-links` re-architected as a Markdown ↔ language-server navigation layer with a local
index. Engineering design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Added

- **Dual-engine resolution.** A `ResolverPipeline` combines a local index and language servers, ranks
  candidates by confidence, and merges them. Policies: `index-first` (default), `lsp-first`, `index-only`,
  `lsp-only`.
- **CodePort Index** — `.codeport/index.db` (built-in `node:sqlite`, WAL) populated by WASM tree-sitter:
  functions, methods, classes/structs/unions, enums and enumerators, typedefs, aliases, variables, fields,
  namespaces, macros and includes. Incremental sync by content hash plus a debounced `FileSystemWatcher`.
  No call graph, by design.
- **`LanguageAdapter` + `ProjectDetector` abstractions** with a full clangd adapter (binary discovery,
  argv, seed files) and a C/C++ detector (`compile_commands.json`, `.clangd`). Adding a language does not
  touch the core.
- **Find All References** for Markdown symbols, resolved through the language server at the real
  definition.
- **Hover** showing the signature plus provenance: which engine answered, at what confidence, and why.
- **Insert Source Link** — rewrites inline code into a link at the definition, e.g.
  `` `nx_start()` `` → `[nx_start()](../sched/init/nx_start.c#L123)`.
- **Three-level language detection**: fence info string → document project → workspace projects; never
  guesses.
- **Explicit no-result reporting**: "no definition found" instead of a wrong jump, with the attempt
  visible in the log.
- Commands: Rebuild Index, Show Index Statistics, Show Log, Migrate mdCodeLinks Settings.
- Settings under `codeport.*` for both engines, the policy and thresholds.
- Non-destructive migration of `mdCodeLinks.*` settings, offered once on activation.
- TypeScript sources bundled with esbuild; 68 unit and integration tests, including an end-to-end test
  that runs the real bundle against a stubbed VS Code API and a real C project.

### Changed

- Renamed from `md-code-links` / *Markdown Code Links* to `codeport` / *CodePort*.
- `extension.js` (monolithic, clangd hard-wired) split into `markdown/`, `core/`, `resolution/` (formerly
  resolver logic inline), `lsp/`, `adapters/`, `project/`, `index/`, `providers/`, `commands/`.
- The LSP client is now generic (any server over stdio) with byte-accurate framing and graceful
  `shutdown`/`exit`.
- Language server and code-link features are independently switchable.
- `mdCodeLinks.enableFunctionJump` → `codeport.definition.enabled`, `mdCodeLinks.prewarmIndex` →
  `codeport.index.prewarm`, `mdCodeLinks.clangdPath` → `codeport.clangd.path`.
- Path/line links are unchanged by default; resolving them relative to the Markdown file is now an opt-in
  setting.
- `codeport.trace` defaults to `messages`; `off` still reports warnings and errors.

### Fixed

- The index is no longer gated on project detection. A workspace with neither `compile_commands.json` nor
  `.clangd` previously never received an index, so every lookup failed — even though the index needs no
  build system at all. The index is workspace-scoped; only the language server requires a detected
  project. `IndexService.startInBackground()` is now idempotent per root, so an on-demand index
  (`codeport.index.prewarm = false`) is populated on first use instead of staying empty.
- LSP framing is byte-accurate, so multi-byte UTF-8 in indexed source cannot desynchronise the stream.
- Graceful `shutdown`/`exit` on dispose (previously every shutdown waited out the kill grace period).
- Only named aggregates and enums with a body become symbols; `struct Node *next;` no longer emits a
  phantom `Node::Node`.
- The Markdown parse cache keys on document version *and* text length, so a reused version counter cannot
  serve a stale parse.
- Hover text inside code spans is no longer escaped with stray backslashes.

## [0.0.2] - 2026-08-29

### Added

- Function-name jump: clangd-powered go-to-definition (F12 / Ctrl+Click) for identifiers inside Markdown
  code blocks and inline code.
- Background index warm-up: `didOpen` a seed file from `compile_commands.json` to wake clangd's background
  indexer.
- Settings: `mdCodeLinks.enableFunctionJump`, `mdCodeLinks.prewarmIndex`, `mdCodeLinks.clangdPath`.

### Changed

- Path/line links now resolve only absolute paths and project-root-relative paths.

## [0.0.1] - 2026-08-29

### Added

- Clickable `path/file.c:line` links in Markdown (Ctrl+Click opens file, `#L` fragment reveals line).
