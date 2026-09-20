# CodePort — Navigate Markdown to Source Code

**English** · [简体中文](README.zh-CN.md)

<p align="center">
  <img src="media/codeport_logo.png" alt="CodePort" width="128" />
</p>

![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-blue) ![License](https://img.shields.io/badge/license-MIT-blue) ![Engine](https://img.shields.io/badge/engine-CodeGraph-orange) ![Languages](https://img.shields.io/badge/languages-any%20CodeGraph%20parses-brightgreen)

**Put the cursor on a symbol written in your Markdown and jump straight to its source.** CodePort brings go-to-definition, Peek Definition, Find All References, hover and clickable `path/file.c:42` links to the fenced code blocks and inline code in your notes — backed by a [CodeGraph](https://github.com/colbymchenry/codegraph) code graph.

- **F12 / Ctrl+Click on an identifier** inside a fenced code block or inline code span opens the same definition, and the same Peek list for duplicates, as inside a source file.
- **One engine, no language servers.** CodePort no longer needs clangd (or any other server) to answer a jump. It reads a CodeGraph index directly, in-process — no daemon, no IPC, sub-millisecond lookups.
- **Any language CodeGraph can parse**, not just C/C++. There is nothing to configure per language.
- **Find All References**, **hover with provenance**, clickable `` `src/main.c:42` `` path links, and **Insert Source Link** to turn `` `nx_start()` `` into `[nx_start()](../sched/init/nx_start.c#L123)`.
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

For **C/C++ projects with a `compile_commands.json`**, that list collapses to the one definition your build actually uses: candidates outside the build are dropped, and among the survivors a weak default (`weak_function`) loses to the chip's strong override. When the database has no answer for the name — a note about another board, or `sim:nsh` while a board is configured — nothing is dropped and you get the usual Peek list.

### Find All References

Finds every reference to a Markdown symbol. CodePort resolves the mention to a definition and then asks CodeGraph for its usages; the graph's edges carry the exact line and column of each call site, so the results land where the compiler would put them.

### Hover with provenance

Hovering a symbol shows its signature — and which signals the answer was based on:

```
nx_start — nx · function

void nx_start(void)

a.c:7
codegraph · exact name, language c, kind function
```

The evidence list is the entire explanation: there is no numeric confidence, because there is nothing left
for a number to decide. When CodeGraph has no signature for a symbol, the hover shows the symbol's own
source instead.

### Path / line links

```
`/home/user/project/src/main.c:42`  → absolute path: opens the file at line 42
`src/main.c:42`                     → resolved against the workspace root
`docs/diagram.svg`                  → and against the note's own directory
`pkg/api/schema.json`               → any file type, not just source code
```

Any file type is linkable — there is no extension whitelist — and a mention without an extension works as long as it is written as a path (`src/Makefile`). A link is created only when the target exists; a mention of a missing file stays plain text.

Relative mentions are tried in order: `codeport.codeLink.searchPaths` (each entry an absolute path or a workspace-root-relative one), then the workspace root, then the directory holding the Markdown file. Absolute paths are used as-is. There is no on/off setting for path links — `codeport.codeLink.searchPaths` is the only one they have (`codeport.enabled` turns the whole extension off).

Path links do not touch the code graph at all — they keep working whether or not CodeGraph is installed.

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
code --install-extension codeport-0.2.1.vsix
```

To hack on it instead, open the repository in VS Code and press **F5** to launch an Extension Development Host — see [Development](#development).

### 2. Install CodeGraph and index your project

CodePort reads a CodeGraph index; it does not build one. Install the CLI and index each project you want to navigate:

```sh
npm i -g @colbymchenry/codegraph --registry=https://registry.npmjs.org
cd <your-project>
codegraph index
```

That creates `<your-project>/.codegraph/codegraph.db`. CodePort finds it by walking up from the file being edited, so opening a subdirectory of an indexed project works. The install also puts `codegraph` on `PATH`, which is where CodePort loads the SDK from — there is nothing to configure.

> **Use the official npm registry.** Mirrors such as npmmirror do not carry CodeGraph's per-platform package, and npm treats an unfetchable optional dependency as success — you get an install that reports success and then segfaults on first use.

### 3. Jump from Markdown

| I want to… | Do this |
| --- | --- |
| jump to the definition | put the cursor on the identifier, press **F12** or **Ctrl+Click** (or `CodePort: Go to Definition`) |
| peek without leaving the note | **Alt+F12** (or `CodePort: Peek Definition`) |
| see why a symbol resolved where it did | hover it — the provenance line names the evidence |
| find every use | **Shift+F12** (or `CodePort: Find All References`) |
| open a mentioned file | **Ctrl+Click** the `` `src/main.c:42` `` link |
| link a mention to its definition | right-click the inline code → **CodePort: Insert Source Link** |

Ratings and decisions are logged: **CodePort: Show Log** opens the output channel.

### 4. Review what the index holds

| Command | Description |
| --- | --- |
| `CodePort: Show Index Statistics` | Files / nodes / edges per workspace, read from CodeGraph. |
| `CodePort: Show Index Rebuild Command` | Shows the `codegraph index <folder>` command to run (CodeGraph owns the index). |
| `CodePort: Show Log` | The pipeline log: what the engine ran and what it returned. |

<br/>

## A note that uses CodePort

`docs/scheduler.md` inside a project:

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

With the cursor on `` `nx_start()` `` or on `nxsched_add_readytorun`, **F12** opens the definition. With the cursor on `` `include/nx/sched.h:42` ``, **Ctrl+Click** opens that file at line 42. Hovering any of them tells you where the answer came from.

<br/>

## Settings

### General

| Setting | Default | Description |
| --- | --- | --- |
| `codeport.enabled` | `true` | Master switch. |
| `codeport.definition.enabled` | `true` | Go-to-definition in Markdown code. |
| `codeport.references.enabled` | `true` | Find All References. |
| `codeport.hover.enabled` | `true` | Hover with signature and provenance. |
| `codeport.codeLink.searchPaths` | `[]` | Extra bases for relative path links: absolute, or relative to the workspace root. Tried first, in order. |

### CodeGraph

| Setting | Default | Description |
| --- | --- | --- |
| `codeport.trace` | `messages` | Log level for the CodePort output channel (`off` still reports warnings and errors). |

There is no setting for where CodeGraph lives. CodePort is useless without the tool, so `codegraph` is expected on `PATH` — that is what `npm i -g @colbymchenry/codegraph` provides. A project-local `node_modules` install is preferred when the workspace is trusted.

Everything else about indexing — which files, which languages, what to ignore — is CodeGraph's own configuration (`codegraph.json` in the project root, and `.codegraph/`). See its documentation.

<br/>

## Supported languages

Whatever the installed CodeGraph can parse. That is a broad set (36 languages in the version CodePort was developed against: C, C++, Objective-C, TypeScript/JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, Swift, Kotlin, Dart, Scala, Lua, R, and more).

Nothing is configured per language, and adding a language means updating CodeGraph — not CodePort.

Caveat: a *parse* is not *semantics*. Overloads, templates and conditional compilation are resolved by name and import, not by a compiler. See [Known limitations](#known-limitations).

<br/>

## Requirements

- VS Code **≥ 1.90**.
- **[CodeGraph](https://github.com/colbymchenry/codegraph) installed, and the project indexed** (`codegraph index`). Without it CodePort still activates — path links keep working — but symbol navigation reports "no definition found" and tells you why.
- A folder must be open — in a single loose file there is no project to resolve against.

No native modules, no `npm rebuild`: CodePort ships no parsers of its own, and CodeGraph bundles the runtime it needs.

<br/>

## Known limitations

- Only **fenced code blocks** and **inline code** are scanned; prose is never treated as a symbol, and file mentions / URLs stay owned by the code-link provider.
- **Preprocessor macros cannot be jumped to.** CodeGraph has no macro node kind, so a `#define` name is not in the graph and a `SOME_MACRO` mention will not resolve. (The retired design's own tree-sitter index did extract macros; this is the one outright regression from that change.)
- **No semantic resolution.** Overloads, template instantiations and conditional compilation are not modelled — CodeGraph matches by name and import. Two overloads can be ambiguous where a compiler would not be.
- **Find All References is a static call graph**, not a compiler-grade one. It can attribute a call to the wrong target when names collide across scopes.
- Language detection for scoring comes from the **fence info string** only. A bare `` `nx_start` `` with no fence therefore scores lower than it used to.
- Markdown does not render links inside a fenced code block, so **Insert Source Link** applies to inline code only.

<br/>

## How it works

CodePort does not try to understand every programming language, and it does not ship a parser. It treats a **single engine** — CodeGraph's code graph — as the source of truth, and owns only what is genuinely its job: deciding what a Markdown mention means, scoring the candidates, and turning the winner into an editor navigation target.

```
Markdown  ──►  CodePort  ──►  CodeGraph (in-process: locate SDK → open .codegraph/codegraph.db)
   `nx_start()`                        │
                                       ▼
                               Source definition
```

Path links are deliberately outside this pipeline: they are a regex and a `stat`, and they work with no graph at all.

The full design — layers, the ranking signals, the two coordinate conversions that are easy to get wrong, the capability boundary and what changed — is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

<br/>

## Troubleshooting

- **"no definition found"** — Open **CodePort: Show Log**. Common causes, in order of likelihood: the folder has no CodeGraph index (`codegraph index <folder>`); the name is a preprocessor macro, which CodeGraph does not model; the name is genuinely not in the graph.
- **"CodeGraph was not found"** — No installed SDK was located. Install it (`npm i -g @colbymchenry/codegraph`): CodePort finds a global install through `PATH`, nvm's per-version prefixes included, and there is no setting to point it anywhere else.
- **A jump went to the wrong place** — Hover the symbol: the provenance line names the evidence. If a name is ambiguous, prefer the qualified form in your notes (`` `nx::start()` `` rather than `` `start()` ``), which raises the rank of the right candidate.
- **Stale results after a big refactor** — Run `codegraph sync` (or `codegraph index`) in that project. CodePort reads the graph as-is and never writes to it.

<br/>

## Links & Resources 🔗

- [Repository](https://github.com/rongbc/codeport)
- [Issues](https://github.com/rongbc/codeport/issues)
- [Architecture](docs/ARCHITECTURE.md) · [架构（中文）](docs/ARCHITECTURE.zh-CN.md)
- [CodeGraph](https://github.com/colbymchenry/codegraph) — the code graph engine CodePort reads

<br/>

## Development

```
src/markdown/    fenced code blocks + inline code spans -> symbol mentions
src/codegraph/   locate/load the CodeGraph SDK, per-root graph facade
src/core/        facade: graphs, pipeline, Markdown parse cache
src/resolution/  the CodeGraph resolver, ranking, the pipeline
src/providers/   Definition / Reference / Hover / DocumentLink providers
src/commands/    Insert Source Link + the command palette entries
test/            unit + integration tests (the last two run the built bundle)
docs/            ARCHITECTURE.md / ARCHITECTURE.zh-CN.md
```

Scripts: `npm run build` (esbuild → `dist/`) · `npm run watch` · `npm run typecheck` · `npm test` · `npm run check` (typecheck + build + test) · `npm run package` (`@vscode/vsce` → `codeport-0.2.1.vsix`).

Press **F5** to launch an Extension Development Host.

`npm run package` builds `dist/` through `vscode:prepublish` and then packages it with `@vscode/vsce`. The `.vsix` is written to the repository root and is git-ignored.

The suite includes end-to-end tests that run the **real bundle** against a stubbed VS Code API and a temporary project, so the whole chain (Markdown → parser → resolver → provider) is covered without launching a GUI. CodeGraph itself is replaced by a fixture SDK through `CODEGRAPH_SDK_PATH`, so the tests neither need nor are affected by a real install. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#testing) for what each test file covers.

<br/>

## License

MIT — see [LICENSE](LICENSE).
