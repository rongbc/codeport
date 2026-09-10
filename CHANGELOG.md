# Changelog

All notable changes to this project will be documented in this file.

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
