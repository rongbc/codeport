# CodePort —— 从 Markdown 直达源码

[English](README.md) · **简体中文**

<p align="center">
  <img src="media/codeport_logo.png" alt="CodePort" width="128" />
</p>

![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-blue) ![License](https://img.shields.io/badge/license-MIT-blue) ![Engines](https://img.shields.io/badge/engines-local%20index%20%2B%20language%20server-orange) ![C%2FC%2B%2B](https://img.shields.io/badge/C%2FC%2B%2B-clangd-brightgreen)

**把光标放在 Markdown 里写下的符号上，就能直接跳到它的源码。** CodePort 把「跳转定义、Peek 定义、查找所有引用、Hover、可点击的 `path/file.c:42` 链接」带进笔记里的围栏代码块与行内代码 —— 底层是你项目真正的 Language Server，并由本地索引加速。

- **在标识符上按 F12 / Ctrl+Click**（围栏代码块或行内代码内），得到与在 `.c` 文件里完全一致的定义跳转；同名多定义同样弹出 Peek 列表。
- **常见情况瞬时完成、且可离线。** 本地 tree-sitter + SQLite 索引以毫秒级回答无歧义的引用；只有当证据不足时才去问 Language Server。是哪个引擎作答、置信度多少、依据是什么，都写在 Hover 和日志里。
- **查找所有引用**、**带来源依据的 Hover**、可点击的 `` `src/main.c:42` `` 路径链接，以及**插入源码链接**——把 `` `nx_start()` `` 变成 `[nx_start()](../sched/init/nx_start.c#L123)`。
- **优先支持 C/C++**（通过 clangd）；Rust、Go、TypeScript、Python 的适配器接口已就绪。
- 功能请求与 bug 欢迎提到 [Issues](https://github.com/rongbc/codeport/issues)。

<br/>

## 特性⚡

### 在 Markdown 内跳转定义 ⭐

在**围栏代码块**或**行内代码**里，把光标放到标识符上，按 **F12** 或 **Ctrl+Click**：

````markdown
调用 `nx_start()` 初始化调度器。

```c
nxsched_add_readytorun(tcb);
```
````

同名多定义（例如不同文件里的 `static` 函数）会弹出常见的 Peek 列表 —— 与在 `.c` 文件里完全一致。

### 查找所有引用

找出某个 Markdown 符号的全部引用。CodePort 先把该处解析到真实定义，再**在该定义位置**向 Language Server 查询引用 —— 因为只有那里才存在真实的源码位置。

### Hover 显示来源与依据

悬停符号不仅显示签名，还显示**是哪个引擎作答、置信度多少、依据是什么**：

```
nx_start — nx · function

void nx_start(void)

a.c:7
index · confidence 0.85 · exact name, language c, kind function, unique result
```

### 路径 / 行号链接

```
`/home/user/project/src/main.c:42`  → 绝对路径：打开文件并定位到第 42 行
`src/main.c:42`                     → 相对工作区根解析
```

也可以通过 `codeport.codeLink.resolveRelativeToMarkdownFile` 选择同时相对 Markdown 文件本身解析。

### 插入源码链接（反向能力）

把符号引用改写成指向其定义的 Markdown 链接：

````markdown
`nx_start()`   →   [nx_start()](../sched/init/nx_start.c#L123)
````

从编辑器右键菜单执行（**CodePort: Insert Source Link**）。**仅支持行内代码** —— Markdown 不会渲染围栏代码块内部的链接。

<br/>
<br/>

## 快速上手 🚀

### 1. 安装

推荐打包成 `.vsix` 后安装；也可以从源码直接跑：

```sh
npm install && npm run package
code --install-extension codeport-0.1.0.vsix
```

想改代码的话，在 VS Code 里打开本仓库按 **F5** 启动 Extension Development Host —— 见[开发](#开发)。

### 2. 打开一个 CodePort 能理解的项目

用 **文件 > 打开文件夹…** 打开同时装着源码与 Markdown 的目录。C/C++ 项目需要有 `compile_commands.json`：CodePort 先查工作区根目录，再从 Markdown 文件向上逐级查找，因此 CMake 工程里的 `docs/` 子目录也能正常工作。`clangd` 会自动探测，索引随后在后台构建。

### 3. 从 Markdown 跳转

| 我想…… | 这样做 |
| --- | --- |
| 跳到定义 | 光标放在标识符上，按 **F12** 或 **Ctrl+Click**（或执行 `CodePort: Go to Definition`） |
| 不离开笔记先看一眼 | **Alt+F12**（或 `CodePort: Peek Definition`） |
| 知道为什么解析到了这里 | 悬停该符号 —— 来源依据行会写明引擎、置信度与依据 |
| 找出所有使用处 | **Shift+F12**（或 `CodePort: Find All References`） |
| 打开提到的文件 | **Ctrl+Click** `` `src/main.c:42` `` 链接 |
| 把引用变成指向定义的链接 | 右键行内代码 → **CodePort: Insert Source Link** |

每一次策略决策都会记录在 **CodePort: Show Log** 打开的输出通道里。

### 4. 查看／维护索引

| 命令 | 说明 |
| --- | --- |
| `CodePort: Show Index Statistics` | 显示各工作区的文件／符号／引用数量。 |
| `CodePort: Rebuild Index` | 删除并重建 `.codeport/index.db`。 |
| `CodePort: Show Log` | 输出通道日志：跑了哪些引擎、各自返回了什么。 |
| `CodePort: Migrate mdCodeLinks Settings` | 把旧的 `mdCodeLinks.*` 配置迁移为 `codeport.*`。 |

<br/>

## 一个使用 CodePort 的笔记示例

C 工程里的 `docs/scheduler.md`：

````markdown
# Scheduler

调用 `nx_start()` 初始化调度器；它声明在 `include/nx/sched.h:42`。

就绪队列由下面这个函数填充：

```c
nxsched_add_readytorun(tcb);
```

启动流程见 `src/sched/init/nx_start.c:123`。
````

光标放在 `` `nx_start()` `` 或 `nxsched_add_readytorun` 上，按 **F12** 即可跳到定义；光标放在 `` `include/nx/sched.h:42` `` 上，**Ctrl+Click** 会打开该文件并定位到第 42 行。悬停其中任意一处，都会告诉你这次是哪个引擎作答。

<br/>

## 设置

### 通用

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `codeport.enabled` | `true` | 总开关。 |
| `codeport.definition.enabled` | `true` | Markdown 代码内的跳转定义。 |
| `codeport.references.enabled` | `true` | 查找所有引用。 |
| `codeport.hover.enabled` | `true` | 显示签名与来源依据的 Hover。 |
| `codeport.codeLink.enabled` | `true` | 可点击的 `path/file.c:42` 链接。 |
| `codeport.codeLink.resolveRelativeToMarkdownFile` | `false` | 同时相对 Markdown 文件本身解析路径链接。 |

### 解析策略（`codeport.policy`）

本地索引与 Language Server 互补：索引瞬时且可离线，服务端是编译器级的。`codeport.policy` 决定如何组合它们。

| 策略 | 行为 |
| --- | --- |
| `index-first`（默认） | 当索引给出的单个候选足够可信（置信度 ≥ `codeport.policy.indexAcceptConfidence`，默认 `0.85`）时直接采用；否则向 Language Server 确认，并优先采用其结果。 |
| `lsp-first` | 先问 Language Server，失败再回退索引。 |
| `index-only` | 完全不启动 Language Server。 |
| `lsp-only` | 完全不用本地索引。 |

例如 ```` ```c ```` 代码块里的 `` `nx_start()` `` 置信度达到 0.85，直接由索引作答；而裸写的 `` `nx_start` `` 只有 0.70，CodePort 就会去问 clangd。具体的权重与阈值见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md#置信度)。

### 索引（`codeport.index.*`）

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `codeport.index.enabled` | `true` | 是否构建／使用本地索引。 |
| `codeport.index.prewarm` | `true` | 打开受支持的项目时，后台构建索引并启动 Language Server。 |
| `codeport.index.references` | `false` | 是否一并索引调用点（索引更大、构建更慢）。 |
| `codeport.index.maxFileSize` | `2097152` | 超过此字节数的文件跳过索引。 |
| `codeport.index.exclude` | `**/.git/**`、`**/node_modules/**`、`**/build/**` 等 | 索引排除的 glob 模式。 |

### C/C++（`codeport.clangd.*`）

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `codeport.clangd.path` | `""` | clangd 二进制路径；留空 = 自动探测。 |
| `codeport.clangd.arguments` | `[]` | 附加给 clangd 的命令行参数。 |
| `codeport.clangd.compileCommandsDir` | `""` | 存放 `compile_commands.json` 的目录；留空 = 自动探测。 |

### 其他

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `codeport.languages` | `{}` | 覆盖「代码块语言 → 适配器」的映射。 |
| `codeport.trace` | `messages` | CodePort 输出通道的日志级别（`off` 仍会输出警告与错误）。 |

<br/>

## 支持的语言

| 语言 | 项目标记文件 | Language Server | 状态 |
| --- | --- | --- | --- |
| C / C++ | `compile_commands.json`、`.clangd` | clangd | ✅ 已实现 |
| Rust | `Cargo.toml` | rust-analyzer | 🚧 适配器接口已就绪 |
| Go | `go.mod`、`go.work` | gopls | 🚧 适配器接口已就绪 |
| TypeScript | `tsconfig.json` | tsserver | 🚧 适配器接口已就绪 |
| Python | `pyproject.toml` | Pyright | 🚧 适配器接口已就绪 |

新增一门语言 = 写一个 `LanguageAdapter` 和一个 `ProjectDetector`，详见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md#新增一门语言)。核心、索引、解析管线与 UI 都不需要改动。

<br/>

## 环境要求

- VS Code **≥ 1.90**（索引依赖 Node 内置的 `node:sqlite`，自 Node 22.5 起提供）。在更老的宿主上 CodePort 仍可用，只是退化为「仅 Language Server」—— 它会自动探测到并在日志中说明。
- C/C++ 需要 `clangd` 二进制（自动探测顺序：`codeport.clangd.path` → `/usr/lib/llvm-*/bin/clangd`（版本从新到旧）→ `/usr/local/bin/clangd` → `/usr/bin/clangd` → `PATH`）。
- C/C++ 项目需要有 `compile_commands.json`。查找顺序是**先工作区根目录，再从 Markdown 文件向上逐级**。
- 必须打开的是一个文件夹 —— 单独打开一个文件时没有可供索引与解析的项目。

**无原生模块、无需 `npm rebuild`**：索引使用 WASM 版 tree-sitter 与内置 SQLite。

<br/>

## 已知限制

- 只扫描**围栏代码块**与**行内代码**；正文永远不会被当作符号，文件路径与 URL 仍归代码链接 Provider 负责。
- 本地索引止步于符号与（可选的）调用点。调用图、继承图、模板实例化图属于 Language Server 的职责。
- 目前只有 C/C++ 同时具备内置的项目探测与索引提取器；其余适配器只是等待实现的接口。
- C/C++ 的效果取决于 `compile_commands.json`：没有它，或者 clangd 仍在构建自身索引（大型项目可能 30–60 秒）时，查询可能失败或定位到错误的位置。
- Markdown 不会渲染围栏代码块内部的链接，因此**插入源码链接**只适用于行内代码。

<br/>

## 工作原理

CodePort 不试图理解所有编程语言，而是把两个引擎当作可互换的证据：**本地索引**（tree-sitter WASM → `.codeport/index.db`，一个增量、可重建的小型 SQLite 缓存）与**你项目的 Language Server**（编译器级语义）。解析管线按策略允许的顺序运行它们、给每个答案打分，并在策略被满足时立即停止。

```
Markdown  ──►  CodePort  ──►  ┌ CodePort Index  (tree-sitter + SQLite, local, instant)
   `nx_start()`               └ clangd / rust-analyzer / gopls / … (compiler-grade semantics)
                                          │
                                          ▼
                                  Source definition
```

完整设计 —— 分层、置信度权重、SQLite schema、项目探测、如何新增一门语言 —— 见 **[docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)**。

<br/>

## 从 `md-code-links` 迁移

CodePort 是更名并重新架构后的继任者。首次激活时它会询问是否复制你的配置：

| 旧键 | 新键 |
| --- | --- |
| `mdCodeLinks.enableFunctionJump` | `codeport.definition.enabled` |
| `mdCodeLinks.prewarmIndex` | `codeport.index.prewarm` |
| `mdCodeLinks.clangdPath` | `codeport.clangd.path` |

迁移**永远不会覆盖**你已经显式设置过的 `codeport.*` 值，旧键也原样保留。之后也可以随时执行 **CodePort: Migrate mdCodeLinks Settings**。

<br/>

## 排障

- **提示 "no definition found"** —— 打开 **CodePort: Show Log**，解析管线会记录跑了哪些引擎、各自返回了什么。常见原因：没有 `compile_commands.json`，或 clangd 仍在构建自身索引（大型项目首次查询可能需要 30–60 秒）。
- **跳转到了错误的位置** —— 悬停该符号，来源依据行会写明引擎与依据。如果是索引答错了，把 `codeport.policy` 改成 `lsp-first`，或把 `codeport.policy.indexAcceptConfidence` 设为 `1`，强制每次都向 Language Server 确认。
- **索引被禁用** —— 日志会说明原因（缺少 `node:sqlite`，或缺少 tree-sitter 资源）。此时导航仍可通过 Language Server 工作。
- **大重构后结果陈旧** —— 执行 **CodePort: Rebuild Index**。

<br/>

## 链接与资源 🔗

- [仓库](https://github.com/rongbc/codeport)
- [Issues](https://github.com/rongbc/codeport/issues)
- [架构文档](docs/ARCHITECTURE.zh-CN.md) · [Architecture (English)](docs/ARCHITECTURE.md)
- [clangd](https://clangd.llvm.org/) —— 首选的 C/C++ Language Server
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/) —— 本地索引背后的解析器
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) —— CodePort 与 Language Server 的通信方式

<br/>

## 开发

```
src/markdown/    围栏代码块 + 行内代码 → 符号引用
src/core/        facade、项目与语言管理器、索引生命周期
src/index/       tree-sitter WASM + node:sqlite 索引（.codeport/index.db）
src/resolution/  索引与 LSP 解析器、置信度、策略管线
src/adapters/    LanguageAdapter + ClangdAdapter（注册表遵循 codeport.languages）
src/project/     ProjectDetector + CppProjectDetector
src/lsp/         通用 stdio JSON-RPC 客户端与客户端池
src/providers/   Definition / Reference / Hover / DocumentLink Provider
src/commands/    Insert Source Link 与命令面板入口
test/            75 个单元 + 集成测试（最后一个跑真实打包产物）
docs/            ARCHITECTURE.md / ARCHITECTURE.zh-CN.md
```

脚本：`npm run build`（esbuild → `dist/`）· `npm run watch` · `npm run typecheck` · `npm test`（75 个测试）· `npm run check`（typecheck + build + test）· `npm run package`（`@vscode/vsce` → `codeport-0.1.0.vsix`）。

按 **F5** 可以启动 Extension Development Host。

`npm run package` 通过 `vscode:prepublish` 先构建 `dist/`，再用 `@vscode/vsce` 打包。`.vsix` 生成在仓库根目录，已被 git 忽略。如希望类型检查与 75 个测试为本次打包把关，先跑 `npm run check`。

测试套件包含一个端到端用例：把**真实打包产物**运行在桩化的 VS Code API 与真实临时 C 项目之上，从而在不启动图形界面的情况下覆盖完整链路（Markdown → 解析 → 项目探测 → 索引 → 解析管线 → Provider）。各测试文件覆盖的内容见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md#测试)。

<br/>

## 许可

MIT —— 见 [LICENSE](LICENSE)。
