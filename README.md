# CodePort — Navigate Markdown to Source Code

**English** · [简体中文](README.zh-CN.md)

<p align="center">
  <img src="media/codeport_logo.png" alt="CodePort" width="128" />
</p>

**CodePort brings source-code navigation to Markdown.** Put the cursor on a symbol written in your
documentation and jump straight to its definition, peek it, find every reference, or turn the mention
into a link — using your project's real language server, backed by a fast local index.

```
Markdown  ──►  CodePort  ──►  ┌ CodePort Index  (tree-sitter + SQLite, local, instant)
   `nx_start()`               └ clangd / rust-analyzer / gopls / … (compiler-grade semantics)
                                          │
                                          ▼
                                  Source definition
```

CodePort does not try to understand every programming language. It delegates that to language servers
and to a local index, and treats both as interchangeable evidence.

---

## Features

### 1. Go to definition inside Markdown ⭐

Inside **fenced code blocks** and **inline code**, press **F12** or **Ctrl+Click** on an identifier:

````markdown
Call `nx_start()` to initialise the scheduler.

```c
nxsched_add_readytorun(tcb);
```
````

Multiple definitions (for example `static` functions with the same name in different files) open the
usual Peek list — identical to the experience inside a `.c` file.

### 2. Find All References

Finds every reference to a Markdown symbol. CodePort first resolves the mention to a real definition and
then asks the language server for references *at that definition*, where a real source position exists.

### 3. Hover with provenance

Hovering a symbol shows its signature — and which engine answered, how confident it was, and why:

```
nx_start — nx · function

void nx_start(void)

a.c:7
index · confidence 0.85 · exact name, language c, kind function, unique result
```

### 4. Path / line links

```
`/home/user/project/src/main.c:42`  → absolute path: opens the file at line 42
`src/main.c:42`                     → resolved against the workspace root
```

Optionally also resolved relative to the Markdown file itself
(`codeport.codeLink.resolveRelativeToMarkdownFile`).

### 5. Insert source link (the other direction)

Turns a mention into a Markdown link to its definition:

````markdown
`nx_start()`   →   [nx_start()](../sched/init/nx_start.c#L123)
````

Available from the editor context menu (**CodePort: Insert Source Link**). Inline code only — Markdown
does not render links inside a fenced code block.

---

## Two engines, one answer

| | CodePort Index | Language server |
|---|---|---|
| Speed | milliseconds, no server needed | depends on the server / its index |
| Works offline | yes | needs the server |
| C++ overloads, templates, macros, conditional compilation | no | yes |
| Cost | tree-sitter parse + tiny SQLite database | full compiler-grade parse |

They are complementary, not alternatives. `codeport.policy` decides how they are combined:

| Policy | Behaviour |
|---|---|
| `index-first` *(default)* | Use the index when a single candidate is convincing (confidence ≥ `codeport.policy.indexAcceptConfidence`, default `0.85`); otherwise confirm with the language server and prefer its answer. |
| `lsp-first` | Ask the language server first; fall back to the index. |
| `index-only` | Never start a language server. |
| `lsp-only` | Never use the local index. |

A mention like `` `nx_start()` `` inside a ```` ```c ```` block reaches 0.85 and is served straight from
the index. A bare `` `nx_start` `` reaches only 0.70, so CodePort asks clangd — the evidence is weaker,
so it pays for certainty. Every decision is visible in the log and in the hover.

---

## Supported languages

| Language | Project marker | Language server | Status |
|---|---|---|---|
| C / C++ | `compile_commands.json`, `.clangd` | clangd | ✅ implemented |
| Rust | `Cargo.toml` | rust-analyzer | 🚧 adapter interface ready |
| Go | `go.mod`, `go.work` | gopls | 🚧 adapter interface ready |
| TypeScript | `tsconfig.json` | tsserver | 🚧 adapter interface ready |
| Python | `pyproject.toml` | Pyright | 🚧 adapter interface ready |

Adding a language means writing one `LanguageAdapter` and one `ProjectDetector` — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-a-language). The core, the index, the resolver
pipeline and the UI do not change.

---

## Requirements

- VS Code **≥ 1.90** (the index uses Node's built-in `node:sqlite`, available from Node 22.5). On an
  older host CodePort still works, language-server only — it detects this and says so in the log.
- For C/C++: a `clangd` binary
  (auto-detected: `codeport.clangd.path`, `/usr/lib/llvm-*/bin/clangd` newest first,
  `/usr/local/bin/clangd`, `/usr/bin/clangd`, `PATH`).
- A `compile_commands.json` for the C/C++ project. It is looked for in the workspace root first, then
  upwards from the Markdown file — so `docs/` inside a CMake tree works.

No native modules, no `npm rebuild`: the index uses WASM tree-sitter and built-in SQLite.

---

## Installation

Copy the folder into the VS Code extensions directory, naming it
`<publisher>.<name>-<version>`:

```sh
npm install && npm run build
cp -r . ~/.vscode-server/extensions/RongBaichuan.codeport-0.1.0
```

Then run **Developer: Reload Window** (`Ctrl+Shift+P`), or reconnect the Remote window.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `codeport.enabled` | `true` | Master switch. |
| `codeport.definition.enabled` | `true` | Go-to-definition in Markdown code. |
| `codeport.references.enabled` | `true` | Find All References. |
| `codeport.hover.enabled` | `true` | Hover with signature and provenance. |
| `codeport.codeLink.enabled` | `true` | Clickable `path/file.c:42` links. |
| `codeport.codeLink.resolveRelativeToMarkdownFile` | `false` | Also resolve path links relative to the Markdown file. |
| `codeport.policy` | `index-first` | How the two engines are combined (see above). |
| `codeport.policy.indexAcceptConfidence` | `0.85` | Confidence needed for `index-first` to skip the server. |
| `codeport.index.enabled` | `true` | Build/use the local index. |
| `codeport.index.prewarm` | `true` | Build the index and start language servers in the background on open. |
| `codeport.index.references` | `false` | Also index call sites (bigger index, slower build). |
| `codeport.index.maxFileSize` | `2097152` | Skip files larger than this (bytes). |
| `codeport.index.exclude` | `**/.git/**`, `**/node_modules/**`, `**/build/**`, … | Glob patterns excluded from the index. |
| `codeport.languages` | `{}` | Override the fence-language → adapter mapping. |
| `codeport.clangd.path` | `""` | clangd binary; empty = auto-detect. |
| `codeport.clangd.arguments` | `[]` | Extra clangd arguments. |
| `codeport.clangd.compileCommandsDir` | `""` | Directory holding `compile_commands.json`; empty = auto-detect. |
| `codeport.trace` | `messages` | Log level for the CodePort output channel (`off` still reports warnings and errors). |

## Commands

| Command | Description |
|---|---|
| `CodePort: Go to Definition` | Reveal the definition (also **F12**). |
| `CodePort: Peek Definition` | Peek the definition. |
| `CodePort: Find All References` | Reference search through the language server. |
| `CodePort: Insert Source Link` | Rewrite inline code into a link to the definition. |
| `CodePort: Rebuild Index` | Drop and rebuild `.codeport/index.db`. |
| `CodePort: Show Index Statistics` | File/symbol/reference counts per workspace. |
| `CodePort: Show Log` | Open the CodePort output channel. |
| `CodePort: Migrate mdCodeLinks Settings` | Copy `mdCodeLinks.*` settings to `codeport.*`. |

---

## How the index works

- **Parsing**: tree-sitter (WASM) recovers *structure* — functions, methods, classes, structs, unions,
  enums, enumerators, typedefs, aliases, variables, fields, namespaces, macros, includes.
- **Storage**: `.codeport/index.db` (SQLite, WAL) with `files`, `symbols`, `symbol_references` and
  `includes` tables. `.codeport/.gitignore` is created so the cache is never committed.
- **Incremental**: on startup the workspace is re-scanned and only files whose content hash changed are
  re-parsed; a `FileSystemWatcher` then applies create/change/delete events in 500 ms batches.
- **No call graph.** The index deliberately stops at symbols and (optional) call sites. Call graphs,
  inheritance graphs and template-instantiation graphs belong to the language server.
- **Rebuildable**: the index is a cache. Delete `.codeport/` at any time; a schema change rebuilds it.

---

## Migrating from `md-code-links`

CodePort is the renamed, re-architected successor. On first activation it offers to copy your settings:

| Old | New |
|---|---|
| `mdCodeLinks.enableFunctionJump` | `codeport.definition.enabled` |
| `mdCodeLinks.prewarmIndex` | `codeport.index.prewarm` |
| `mdCodeLinks.clangdPath` | `codeport.clangd.path` |

The migration never overwrites a `codeport.*` value you already set, and the old keys are left
untouched. You can also run it later via **CodePort: Migrate mdCodeLinks Settings**.

---

## Development

```sh
npm install
npm run build       # esbuild bundle -> dist/extension.js + dist/wasm/
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # all 75 unit + integration tests
npm run check       # typecheck + build + test
```

Press **F5** to launch an Extension Development Host.

The test suite includes an end-to-end test that runs the **real bundle** against a stubbed VS Code API
and a real temporary C project, so the whole chain (Markdown → parser → project detection → index →
resolver → provider) is covered without launching a GUI. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Troubleshooting

- **"no definition found"** — Open **CodePort: Show Log**. The pipeline logs which engines ran and what
  each returned. Common causes: no `compile_commands.json`, or clangd still building its index (the
  first lookup in a large project can take 30–60 s).
- **A jump went to the wrong place** — Hover the symbol: the provenance line names the engine and the
  evidence. If the index answered wrongly, set `codeport.policy` to `lsp-first`, or
  `codeport.policy.indexAcceptConfidence` to `1` to always confirm with the server.
- **The index is disabled** — The log says why (`node:sqlite` missing, or tree-sitter assets absent).
  Navigation still works through language servers.
- **Stale results after a big refactor** — Run **CodePort: Rebuild Index**.

## License

MIT
