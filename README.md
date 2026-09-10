# CodePort — Navigate Markdown to Source Code

**English** · [简体中文](README.zh-CN.md)

<p align="center">
  <img src="media/codeport_logo.png" alt="CodePort" width="128" />
</p>

![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-blue) ![License](https://img.shields.io/badge/license-MIT-blue) ![Engines](https://img.shields.io/badge/engines-local%20index%20%2B%20language%20server-orange) ![C%2FC%2B%2B](https://img.shields.io/badge/C%2FC%2B%2B-clangd-brightgreen)

**Put the cursor on a symbol written in your Markdown and jump straight to its source.** CodePort brings go-to-definition, Peek Definition, Find All References, hover and clickable `path/file.c:42` links to the fenced code blocks and inline code in your notes — using your project's real language server, backed by a fast local index.

- **F12 / Ctrl+Click on an identifier** inside a fenced code block or inline code span opens the same definition, and the same Peek list for duplicates, as inside a `.c` file.
- **Instant, and offline for the obvious cases.** A local tree-sitter + SQLite index answers unambiguous mentions in milliseconds; the language server is asked only when the evidence is weaker. Which engine answered, how confident it was and why is written in the hover and in the log.
- **Find All References**, **hover with provenance**, clickable `` `src/main.c:42` `` path links, and **Insert Source Link** to turn `` `nx_start()` `` into `[nx_start()](../sched/init/nx_start.c#L123)`.
- **C/C++ first**, through clangd; the adapter interface is ready for Rust, Go, TypeScript and Python.
- Feature requests and bug reports are welcome in [Issues](https://github.com/rongbc/codeport/issues).

<br/>

## Features⚡

### Go to definition inside Markdown ⭐

Put the cursor on an identifier inside a **fenced code block** or an **inline code span** and press **F12** or **Ctrl+Click**:

````markdown
Call `nx_start()` to initialise the scheduler.

```c
nxsched_add_readytorun(tcb);
```
````

Multiple definitions (for example `static` functions with the same name in different files) open the usual Peek list — identical to the experience inside a `.c` file.

### Find All References

Finds every reference to a Markdown symbol. CodePort first resolves the mention to a real definition and then asks the language server for references *at that definition*, where a real source position exists.

### Hover with provenance

Hovering a symbol shows its signature — and which engine answered, how confident it was, and why:

```
nx_start — nx · function

void nx_start(void)

a.c:7
index · confidence 0.85 · exact name, language c, kind function, unique result
```

### Path / line links

```
`/home/user/project/src/main.c:42`  → absolute path: opens the file at line 42
`src/main.c:42`                     → resolved against the workspace root
```

Optionally also resolved relative to the Markdown file itself (`codeport.codeLink.resolveRelativeToMarkdownFile`).

### Insert source link (the other direction)

Turns a mention into a Markdown link to its definition:

````markdown
`nx_start()`   →   [nx_start()](../sched/init/nx_start.c#L123)
````

Available from the editor context menu (**CodePort: Insert Source Link**). Inline code only — Markdown does not render links inside a fenced code block.

<br/>
<br/>

## Usage TL;DR 🚀

### 1. Install

Package a `.vsix` and install it (recommended), or run the extension from source:

```sh
npm install && npm run package
code --install-extension codeport-0.1.0.vsix
```

To hack on it instead, open the repository in VS Code and press **F5** to launch an Extension Development Host — see [Development](#development).

### 2. Open a project CodePort can understand

Open the folder that holds your sources and your Markdown with **File > Open Folder…**. The index starts building in the background straight away — it needs no build configuration. For C/C++ *semantic* features, make sure the project has a `compile_commands.json` (or a `.clangd`) and that `clangd` is installed: CodePort looks in the workspace root first, then upwards from the Markdown file, so `docs/` inside a CMake tree works.

### 3. Jump from Markdown

| I want to… | Do this |
| --- | --- |
| jump to the definition | put the cursor on the identifier, press **F12** or **Ctrl+Click** (or `CodePort: Go to Definition`) |
| peek without leaving the note | **Alt+F12** (or `CodePort: Peek Definition`) |
| see why a symbol resolved where it did | hover it — the provenance line names the engine, the confidence and the evidence |
| find every use | **Shift+F12** (or `CodePort: Find All References`) |
| open a mentioned file | **Ctrl+Click** the `` `src/main.c:42` `` link |
| link a mention to its definition | right-click the inline code → **CodePort: Insert Source Link** |

Ratings and policy decisions are logged: **CodePort: Show Log** opens the output channel.

### 4. Review what the index holds

| Command | Description |
| --- | --- |
| `CodePort: Show Index Statistics` | File / symbol / reference counts per workspace. |
| `CodePort: Rebuild Index` | Drop and rebuild `.codeport/index.db`. |
| `CodePort: Show Log` | The pipeline log: which engines ran and what each returned. |
| `CodePort: Migrate mdCodeLinks Settings` | Copy old `mdCodeLinks.*` settings to `codeport.*`. |

<br/>

## A note that uses CodePort

`docs/scheduler.md` inside a C project:

````markdown
# Scheduler

Call `nx_start()` to initialise the scheduler; it is declared in
`include/nx/sched.h:42`.

The ready-to-run queue is filled in:

```c
nxsched_add_readytorun(tcb);
```

Bring-up is described in `src/sched/init/nx_start.c:123`.
````

With the cursor on `` `nx_start()` `` or on `nxsched_add_readytorun`, **F12** opens the definition. With the cursor on `` `include/nx/sched.h:42` ``, **Ctrl+Click** opens that file at line 42. Hovering any of them tells you which engine answered.

<br/>

## Settings

### General

| Setting | Default | Description |
| --- | --- | --- |
| `codeport.enabled` | `true` | Master switch. |
| `codeport.definition.enabled` | `true` | Go-to-definition in Markdown code. |
| `codeport.references.enabled` | `true` | Find All References. |
| `codeport.hover.enabled` | `true` | Hover with signature and provenance. |
| `codeport.codeLink.enabled` | `true` | Clickable `path/file.c:42` links. |
| `codeport.codeLink.resolveRelativeToMarkdownFile` | `false` | Also resolve path links relative to the Markdown file. |

### Resolution policy (`codeport.policy`)

The local index and the language server are complementary: the index is instant and works offline, the server is compiler-grade. `codeport.policy` decides how they are combined.

| Policy | Behaviour |
| --- | --- |
| `index-first` *(default)* | Use the index when a single candidate is convincing (confidence ≥ `codeport.policy.indexAcceptConfidence`, default `0.85`); otherwise confirm with the language server and prefer its answer. |
| `lsp-first` | Ask the language server first; fall back to the index. |
| `index-only` | Never start a language server. |
| `lsp-only` | Never use the local index. |

A mention like `` `nx_start()` `` inside a ```` ```c ```` block reaches 0.85 and is served straight from the index; a bare `` `nx_start` `` reaches only 0.70, so CodePort asks clangd. The exact weights and thresholds are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#confidence).

### Index (`codeport.index.*`)

| Setting | Default | Description |
| --- | --- | --- |
| `codeport.index.enabled` | `true` | Build/use the local index. |
| `codeport.index.prewarm` | `true` | Build the index and start language servers in the background on open. |
| `codeport.index.references` | `false` | Also index call sites (bigger index, slower build). |
| `codeport.index.maxFileSize` | `2097152` | Skip files larger than this (bytes). |
| `codeport.index.exclude` | `**/.git/**`, `**/node_modules/**`, `**/build/**`, … | Glob patterns excluded from the index. |

### C/C++ (`codeport.clangd.*`)

| Setting | Default | Description |
| --- | --- | --- |
| `codeport.clangd.path` | `""` | clangd binary; empty = auto-detect. |
| `codeport.clangd.arguments` | `[]` | Extra clangd arguments. |
| `codeport.clangd.compileCommandsDir` | `""` | Directory holding `compile_commands.json`; empty = auto-detect. |

### Other

| Setting | Default | Description |
| --- | --- | --- |
| `codeport.languages` | `{}` | Override the fence-language → adapter mapping. |
| `codeport.trace` | `messages` | Log level for the CodePort output channel (`off` still reports warnings and errors). |

<br/>

## Supported languages

| Language | Project marker | Language server | Status |
| --- | --- | --- | --- |
| C / C++ | `compile_commands.json`, `.clangd` | clangd | ✅ implemented |
| Rust | `Cargo.toml` | rust-analyzer | 🚧 adapter interface ready |
| Go | `go.mod`, `go.work` | gopls | 🚧 adapter interface ready |
| TypeScript | `tsconfig.json` | tsserver | 🚧 adapter interface ready |
| Python | `pyproject.toml` | Pyright | 🚧 adapter interface ready |

Adding a language means writing one `LanguageAdapter` and one `ProjectDetector` — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-a-language). The core, the index, the resolver pipeline and the UI do not change.

<br/>

## Requirements

- VS Code **≥ 1.90** (the index uses Node's built-in `node:sqlite`, available from Node 22.5). On an older host CodePort still works, language-server only — it detects this and says so in the log.
- For C/C++ **semantic** features: a `clangd` binary (auto-detected: `codeport.clangd.path`, `/usr/lib/llvm-*/bin/clangd` newest first, `/usr/local/bin/clangd`, `/usr/bin/clangd`, `PATH`), plus a `compile_commands.json` (or a `.clangd` file). It is looked for in the workspace root first, then upwards from the Markdown file.
- A folder must be open — in a single loose file there is no project to index or resolve against.

No native modules, no `npm rebuild`: the index uses WASM tree-sitter and built-in SQLite.

### What works without clangd or a build system

Neither clangd nor `compile_commands.json` is required for **navigation**. The index is built per workspace straight from the sources — it needs no build configuration at all — so on a machine without clangd, or in a project without a compilation database:

| Capability | Without clangd / `compile_commands.json` |
|---|---|
| Go to definition | ✅ answered by the index |
| Hover (signature + provenance) | ✅ signature comes from the index |
| Insert Source Link | ✅ |
| Path / line links | ✅ |
| Find All References | ❌ needs a server at a real definition position |
| Overloads, templates, macros, conditional compilation | ❌ the index is structural, not semantic |

A *weak* mention — a bare `` `nx_start` ``, with no call parentheses and no fence language — is exactly the case that escalates to the language server. When that server is unavailable, CodePort keeps the index candidate instead of failing, and says so in the log.

<br/>

## Known limitations

- Only **fenced code blocks** and **inline code** are scanned; prose is never treated as a symbol, and file mentions / URLs stay owned by the code-link provider.
- The local index stops at symbols and (optional) call sites. Call graphs, inheritance graphs and template-instantiation graphs belong to the language server.
- C/C++ is the only language with a built-in detector and index extractor today; the other adapters are interfaces waiting for an implementation.
- C/C++ **semantic** accuracy is only as good as `compile_commands.json`. The index still navigates without it, but overload resolution, templates, macros and conditional compilation need clangd — and while clangd is building its own index (30–60 s on a large project) a *weak* mention can fall back to the index's structural answer.
- `Find All References` and the compiler-grade hover signature require a language server; without one, CodePort reports no references rather than inventing them.
- Markdown does not render links inside a fenced code block, so **Insert Source Link** applies to inline code only.

<br/>

## How it works

CodePort does not try to understand every programming language. It treats two engines as interchangeable evidence: a **local index** (tree-sitter WASM → `.codeport/index.db`, a small SQLite cache that is incremental and rebuildable) and **your project's language server** (compiler-grade semantics). A resolver pipeline runs them in the order the policy allows, scores each answer, and stops as soon as the policy is satisfied.

```
Markdown  ──►  CodePort  ──►  ┌ CodePort Index  (tree-sitter + SQLite, local, instant)
   `nx_start()`               └ clangd / rust-analyzer / gopls / … (compiler-grade semantics)
                                          │
                                          ▼
                                  Source definition
```

The full design — layers, confidence weights, the SQLite schema, project detection and how to add a language — is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

<br/>

## Migrating from `md-code-links`

CodePort is the renamed, re-architected successor. On first activation it offers to copy your settings:

| Old | New |
| --- | --- |
| `mdCodeLinks.enableFunctionJump` | `codeport.definition.enabled` |
| `mdCodeLinks.prewarmIndex` | `codeport.index.prewarm` |
| `mdCodeLinks.clangdPath` | `codeport.clangd.path` |

The migration never overwrites a `codeport.*` value you already set, and the old keys are left untouched. You can also run it later via **CodePort: Migrate mdCodeLinks Settings**.

<br/>

## Troubleshooting

- **"no definition found"** — Open **CodePort: Show Log**. The pipeline logs which engines ran and what each returned. Common causes: the index is still building (first run, or `codeport.index.prewarm` disabled), the name genuinely is not indexed, or — for a *weak* mention that escalated to clangd — a missing `compile_commands.json` or clangd still building its own index (30–60 s on a large project).
- **A jump went to the wrong place** — Hover the symbol: the provenance line names the engine and the evidence. If the index answered wrongly, set `codeport.policy` to `lsp-first`, or `codeport.policy.indexAcceptConfidence` to `1` to always confirm with the server.
- **The index is disabled** — The log says why (`node:sqlite` missing, or tree-sitter assets absent). Navigation still works through language servers.
- **Stale results after a big refactor** — Run **CodePort: Rebuild Index**.

<br/>

## Links & Resources 🔗

- [Repository](https://github.com/rongbc/codeport)
- [Issues](https://github.com/rongbc/codeport/issues)
- [Architecture](docs/ARCHITECTURE.md) · [架构（中文）](docs/ARCHITECTURE.zh-CN.md)
- [clangd](https://clangd.llvm.org/) — the C/C++ language server used first
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/) — the parser behind the local index
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) — how CodePort talks to servers

<br/>

## Development

```
src/markdown/    fenced code blocks + inline code spans -> symbol mentions
src/core/        facade, project & language managers, index lifecycle
src/index/       tree-sitter WASM + node:sqlite index (.codeport/index.db)
src/resolution/  index and LSP resolvers, confidence, the policy pipeline
src/adapters/    LanguageAdapter + ClangdAdapter (registry honours codeport.languages)
src/project/     ProjectDetector + CppProjectDetector
src/lsp/         generic stdio JSON-RPC client and client pool
src/providers/   Definition / Reference / Hover / DocumentLink providers
src/commands/    Insert Source Link + the command palette entries
test/            80 unit + integration tests (the last one runs the built bundle)
docs/            ARCHITECTURE.md / ARCHITECTURE.zh-CN.md
```

Scripts: `npm run build` (esbuild → `dist/`) · `npm run watch` · `npm run typecheck` · `npm test` (80 tests) · `npm run check` (typecheck + build + test) · `npm run package` (`@vscode/vsce` → `codeport-0.1.0.vsix`).

Press **F5** to launch an Extension Development Host.

`npm run package` builds `dist/` through `vscode:prepublish` and then packages it with `@vscode/vsce`. The `.vsix` is written to the repository root and is git-ignored. Run `npm run check` first if you want the type-check and the 80 tests to gate the build.

The suite includes an end-to-end test that runs the **real bundle** against a stubbed VS Code API and a real temporary C project, so the whole chain (Markdown → parser → project detection → index → resolver → provider) is covered without launching a GUI. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#testing) for what each test file covers.

<br/>

## License

MIT — see [LICENSE](LICENSE).
