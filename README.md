# Markdown Code Links

Jump from Markdown notes to C/C++ source code — as easily as inside `.c`/`.h` files. clangd only serves C/C++; this extension bridges the gap for Markdown.

## Features

### 1. Function-name jump (clangd-powered) ⭐

Inside **fenced code blocks** (```` ``` ````) and **inline code** (`` ` ``), put the cursor on an identifier and:

- Press **F12** or **Ctrl+Click** → jumps to the definition via clangd (`workspace/symbol`)
- Multiple definitions (e.g. `static` functions with the same name across files) show a Peek list — identical to the `.c` experience

```c
// e.g. click start_worker below to jump to its definition
start_worker();
create_task("t1", 100, 2048, worker_main, NULL);
```

> Requirement: the project root (workspace root) has a `compile_commands.json` — it must sit at the workspace root, no sub-directory search.
> First use needs clangd's background index (~30–60 s for a typical project), afterwards lookups are instant. A status bar message shows progress/errors.

### 2. Path / line links

```
`/home/user/project/src/main.c:42`  → absolute path, Ctrl+Click opens file and reveals line 42
`src/main.c:42`                     → relative to the project root (workspace root)
```

Resolution: **absolute path → relative to project root (workspace root)**. Paths relative to the `.md` file's directory are not resolved.

## Requirements

- VS Code ≥ 1.75
- A `clangd` binary on the system (auto-detected: `/usr/lib/llvm-*/bin/clangd`, `/usr/local/bin/clangd`, `/usr/bin/clangd`, or `PATH`)
- A `compile_commands.json` **at the project root (workspace root)** for the function-name jump

## Installation

Copy the project directory into the VS Code extensions folder (name must match `package.json` version):

```sh
cp -r ~/git/md-code-links ~/.vscode-server/extensions/md-code-links-0.0.2
```

Then run **Developer: Reload Window** (`Ctrl+Shift+P`) or reconnect the Remote window.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `mdCodeLinks.enableFunctionJump` | `true` | Enable clangd-powered function-name jump |
| `mdCodeLinks.prewarmIndex` | `true` | Start clangd in the background when a workspace with `compile_commands.json` is opened |
| `mdCodeLinks.clangdPath` | `""` | Absolute path to clangd; empty = auto-detect |

## Implementation notes

- **Function-name jump**: a Markdown `DefinitionProvider` plus a minimal LSP-over-stdio client (zero npm dependencies). One persistent `clangd --compile-commands-dir=<ws> --background-index` process is started lazily; the identifier under the cursor is resolved with `workspace/symbol` (exact match first, fuzzy fallback, up to 10 candidates).
- **Index warm-up**: clangd 15's background indexer only starts after the first file is opened (measured: no indexing after 5 min without `didOpen`; ~20 s to full index after `didOpen`). The extension sends `didOpen` for a seed file from `compile_commands.json` to wake the indexer.
- **Path links**: a `DocumentLinkProvider`; line numbers use the `#L502` URI fragment.
- **Scope**: only identifiers inside code blocks / inline code are handled (fence pairing + inline backtick parity); plain prose is never touched.

## License

MIT

---

# Markdown Code Links（中文说明）

在 Markdown 笔记里像 `.c`/`.h` 中一样跳转源码。clangd 只管 C/C++，不处理 Markdown，本扩展补上这一环。

## 功能特性

### 1. 函数名跳转（clangd 驱动）⭐ 核心功能

在**代码块**（```` ``` ````）和**行内代码**（`` ` ``）里，把光标放到函数名/标识符上：

- **F12** 或 **Ctrl+Click** → 直接调用 clangd（`workspace/symbol`）跳到定义
- 同名函数有多个定义（如各文件里的 `static` 函数）时，VSCode 弹出 Peek 列表选择——与 `.c` 里行为一致

```c
// 例: 点 start_worker 即可跳到其定义位置
start_worker();
create_task("t1", 100, 2048, worker_main, NULL);
```

> 前提：项目根（工作区根）有 `compile_commands.json`——**必须在项目根目录**，不搜索子目录。
> 首次使用需等 clangd 后台索引建好（一般项目约 30~60 秒），之后查询秒回；状态栏有提示。

### 2. 路径/行号链接

```
`/home/user/project/src/main.c:42`  → 绝对路径, Ctrl+Click 打开并定位行
`src/main.c:42`                     → 相对项目根（工作区根）
```

解析：**绝对路径 → 相对项目根（工作区根）**；相对 `.md` 所在目录的路径不解析。

## 环境要求

- VSCode ≥ 1.75
- 系统有 `clangd` 二进制（自动探测：`/usr/lib/llvm-*/bin/clangd`、`/usr/local/bin/clangd`、`/usr/bin/clangd`、`PATH`）
- 函数名跳转需要**项目根（工作区根）**有 `compile_commands.json`

## 安装

把项目目录拷贝到 VSCode 扩展目录（目录名须与 `package.json` 版本一致）：

```sh
cp -r ~/git/md-code-links ~/.vscode-server/extensions/md-code-links-0.0.2
```

然后 `Ctrl+Shift+P` → **Developer: Reload Window**（或重连 Remote 窗口）。

## 配置（settings.json）

| 项 | 默认 | 说明 |
|---|---|---|
| `mdCodeLinks.enableFunctionJump` | `true` | 函数名跳转开关 |
| `mdCodeLinks.prewarmIndex` | `true` | 打开带 `compile_commands.json` 的工作区即后台启动 clangd 预热索引 |
| `mdCodeLinks.clangdPath` | `""` | clangd 二进制绝对路径；空 = 自动探测 |

## 实现说明

- **函数名跳转**：markdown `DefinitionProvider` + 最小 LSP over stdio 客户端（零 npm 依赖），懒启动常驻一个 `clangd --compile-commands-dir=<ws> --background-index` 进程；标识符用 `workspace/symbol` 解析（完全匹配优先，模糊匹配兜底，最多 10 个候选）。
- **索引预热**：clangd 15 的后台索引需"第一个文件打开"才被唤醒（实测：无 `didOpen` 时 5 分钟不建索引；`didOpen` 后约 20 秒全量可查）。扩展自动对 `compile_commands.json` 里的种子文件发 `didOpen` 唤醒索引器。
- **路径链接**：`DocumentLinkProvider`，行号用 URI fragment `#L502` 定位。
- **作用范围**：只处理代码块/行内代码内的标识符（围栏配对 + 行内反引号奇偶判断），正文英文不误触。

## 许可

MIT
