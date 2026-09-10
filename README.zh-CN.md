# CodePort —— 从 Markdown 直达源码

[English](README.md) · **简体中文**

<p align="center">
  <img src="media/codeport_logo.png" alt="CodePort" width="128" />
</p>

**CodePort 把源码导航带进 Markdown。** 把光标放在文档中写下的符号上，就能直接跳到它的定义、Peek 定义、
查找所有引用，或把该处改写成链接 —— 底层使用你项目真正的 Language Server，并由本地索引加速。

```
Markdown  ──►  CodePort  ──►  ┌ CodePort Index  (tree-sitter + SQLite, local, instant)
   `nx_start()`               └ clangd / rust-analyzer / gopls / … (compiler-grade semantics)
                                          │
                                          ▼
                                  Source definition
```

CodePort 不试图理解所有编程语言：它把这件事交给 Language Server 与本地索引，并把两者当作可互换的证据。

---

## 功能

### 1. 在 Markdown 内跳转定义 ⭐

在**围栏代码块**和**行内代码**里，把光标放到标识符上，按 **F12** 或 **Ctrl+Click**：

````markdown
调用 `nx_start()` 初始化调度器。

```c
nxsched_add_readytorun(tcb);
```
````

同名多定义（例如不同文件里的 `static` 函数）会弹出常见的 Peek 列表 —— 与在 `.c` 文件里完全一致。

### 2. 查找所有引用

找出某个 Markdown 符号的全部引用。CodePort 先把该处解析到真实定义，再**在该定义位置**向 Language
Server 查询引用 —— 因为只有那里才存在真实的源码位置。

### 3. Hover 显示来源与依据

悬停符号不仅显示签名，还显示**是哪个引擎作答、置信度多少、依据是什么**：

```
nx_start — nx · function

void nx_start(void)

a.c:7
index · confidence 0.85 · exact name, language c, kind function, unique result
```

### 4. 路径 / 行号链接

```
`/home/user/project/src/main.c:42`  → 绝对路径：打开文件并定位到第 42 行
`src/main.c:42`                     → 相对工作区根解析
```

也可以通过 `codeport.codeLink.resolveRelativeToMarkdownFile` 选择同时相对 Markdown 文件本身解析。

### 5. 插入源码链接（反向能力）

把符号引用改写成指向其定义的 Markdown 链接：

````markdown
`nx_start()`   →   [nx_start()](../sched/init/nx_start.c#L123)
````

从编辑器右键菜单执行（**CodePort: Insert Source Link**）。**仅支持行内代码** —— Markdown 不会渲染围栏
代码块内部的链接。

---

## 双引擎，一个答案

| | CodePort Index | Language Server |
|---|---|---|
| 速度 | 毫秒级，无需启动服务 | 取决于服务端／其自身索引 |
| 可离线 | 是 | 需要服务端 |
| C++ 重载、模板、宏、条件编译 | 否 | 是 |
| 代价 | tree-sitter 解析 + 极小的 SQLite 库 | 完整的编译器级解析 |

两者互补而非互斥。`codeport.policy` 决定如何组合它们：

| 策略 | 行为 |
|---|---|
| `index-first`（默认） | 当索引给出的单个候选足够可信（置信度 ≥ `codeport.policy.indexAcceptConfidence`，默认 `0.85`）时直接采用；否则向 Language Server 确认，并优先采用其结果。 |
| `lsp-first` | 先问 Language Server，失败再回退索引。 |
| `index-only` | 完全不启动 Language Server。 |
| `lsp-only` | 完全不用本地索引。 |

例如 ```` ```c ```` 代码块里的 `` `nx_start()` `` 置信度达到 0.85，直接由索引作答；而裸写的
`` `nx_start` `` 只有 0.70，CodePort 就会去问 clangd —— 证据不足，就为确定性付出代价。每一次决策都能在
日志和 Hover 中看到。

---

## 支持的语言

| 语言 | 项目标记文件 | Language Server | 状态 |
|---|---|---|---|
| C / C++ | `compile_commands.json`、`.clangd` | clangd | ✅ 已实现 |
| Rust | `Cargo.toml` | rust-analyzer | 🚧 适配器接口已就绪 |
| Go | `go.mod`、`go.work` | gopls | 🚧 适配器接口已就绪 |
| TypeScript | `tsconfig.json` | tsserver | 🚧 适配器接口已就绪 |
| Python | `pyproject.toml` | Pyright | 🚧 适配器接口已就绪 |

新增一门语言 = 写一个 `LanguageAdapter` 和一个 `ProjectDetector`，详见
[docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md#新增一门语言)。核心、索引、解析管线与 UI
都不需要改动。

---

## 环境要求

- VS Code **≥ 1.90**（索引依赖 Node 内置的 `node:sqlite`，自 Node 22.5 起提供）。在更老的宿主上
  CodePort 仍可用，只是退化为「仅 Language Server」—— 它会自动探测到并在日志中说明。
- C/C++ 需要 `clangd` 二进制（自动探测顺序：`codeport.clangd.path` →
  `/usr/lib/llvm-*/bin/clangd`（版本从新到旧）→ `/usr/local/bin/clangd` → `/usr/bin/clangd` → `PATH`）。
- C/C++ 项目需要有 `compile_commands.json`。查找顺序是**先工作区根目录，再从 Markdown 文件向上逐级**，
  因此 CMake 工程里的 `docs/` 子目录也能正常工作。

**无原生模块、无需 `npm rebuild`**：索引使用 WASM 版 tree-sitter 与内置 SQLite。

---

## 安装

把项目目录拷进 VS Code 扩展目录，目录名使用 `<publisher>.<name>-<version>`：

```sh
npm install && npm run build
cp -r . ~/.vscode-server/extensions/RongBaichuan.codeport-0.1.0
```

然后执行 **Developer: Reload Window**（`Ctrl+Shift+P`），或重新连接 Remote 窗口。

---

## 配置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `codeport.enabled` | `true` | 总开关。 |
| `codeport.definition.enabled` | `true` | Markdown 代码内的跳转定义。 |
| `codeport.references.enabled` | `true` | 查找所有引用。 |
| `codeport.hover.enabled` | `true` | 显示签名与来源依据的 Hover。 |
| `codeport.codeLink.enabled` | `true` | 可点击的 `path/file.c:42` 链接。 |
| `codeport.codeLink.resolveRelativeToMarkdownFile` | `false` | 同时相对 Markdown 文件本身解析路径链接。 |
| `codeport.policy` | `index-first` | 两个引擎的组合方式（见上文）。 |
| `codeport.policy.indexAcceptConfidence` | `0.85` | `index-first` 跳过 Language Server 所需的置信度。 |
| `codeport.index.enabled` | `true` | 是否构建／使用本地索引。 |
| `codeport.index.prewarm` | `true` | 打开受支持的项目时，后台构建索引并启动 Language Server。 |
| `codeport.index.references` | `false` | 是否一并索引调用点（索引更大、构建更慢）。 |
| `codeport.index.maxFileSize` | `2097152` | 超过此字节数的文件跳过索引。 |
| `codeport.index.exclude` | `**/.git/**`、`**/node_modules/**`、`**/build/**` 等 | 索引排除的 glob 模式。 |
| `codeport.languages` | `{}` | 覆盖「代码块语言 → 适配器」的映射。 |
| `codeport.clangd.path` | `""` | clangd 二进制路径；留空 = 自动探测。 |
| `codeport.clangd.arguments` | `[]` | 附加给 clangd 的命令行参数。 |
| `codeport.clangd.compileCommandsDir` | `""` | 存放 `compile_commands.json` 的目录；留空 = 自动探测。 |
| `codeport.trace` | `messages` | CodePort 输出通道的日志级别（`off` 仍会输出警告与错误）。 |

## 命令

| 命令 | 说明 |
|---|---|
| `CodePort: Go to Definition` | 跳到定义（等同于 **F12**）。 |
| `CodePort: Peek Definition` | Peek 定义。 |
| `CodePort: Find All References` | 通过 Language Server 查找引用。 |
| `CodePort: Insert Source Link` | 把行内代码改写成指向定义的链接。 |
| `CodePort: Rebuild Index` | 删除并重建 `.codeport/index.db`。 |
| `CodePort: Show Index Statistics` | 显示各工作区的文件／符号／引用数量。 |
| `CodePort: Show Log` | 打开 CodePort 输出通道。 |
| `CodePort: Migrate mdCodeLinks Settings` | 把 `mdCodeLinks.*` 配置迁移为 `codeport.*`。 |

---

## 索引工作原理

- **解析**：tree-sitter（WASM）提取**结构** —— 函数、方法、类、结构体、联合体、枚举、枚举项、typedef、
  别名、变量、字段、命名空间、宏、include。
- **存储**：`.codeport/index.db`（SQLite，WAL 模式），包含 `files`、`symbols`、`symbol_references`、
  `includes` 四张表。同时会自动生成 `.codeport/.gitignore`，避免缓存被提交。
- **增量**：启动时重新扫描工作区，只重新解析内容哈希发生变化的文件；随后由 `FileSystemWatcher` 以
  500 毫秒为一批处理增／删／改事件。
- **不建调用图**：索引刻意止步于符号与（可选的）调用点。调用图、继承图、模板实例化图属于 Language
  Server 的职责。
- **可重建**：索引只是缓存。随时删除 `.codeport/` 即可；schema 变更时也会自动重建。

---

## 从 `md-code-links` 迁移

CodePort 是更名并重新架构后的继任者。首次激活时它会询问是否复制你的配置：

| 旧键 | 新键 |
|---|---|
| `mdCodeLinks.enableFunctionJump` | `codeport.definition.enabled` |
| `mdCodeLinks.prewarmIndex` | `codeport.index.prewarm` |
| `mdCodeLinks.clangdPath` | `codeport.clangd.path` |

迁移**永远不会覆盖**你已经显式设置过的 `codeport.*` 值，旧键也原样保留。之后也可以随时执行
**CodePort: Migrate mdCodeLinks Settings**。

---

## 开发

```sh
npm install
npm run build       # esbuild 打包 -> dist/extension.js + dist/wasm/
npm run watch       # 变更时自动重建
npm run typecheck   # tsc --noEmit
npm test            # 全部 75 个单元 + 集成测试
npm run check       # typecheck + build + test
```

按 **F5** 可以启动 Extension Development Host。

测试套件包含一个端到端用例：把**真实打包产物**运行在桩化的 VS Code API 与真实临时 C 项目之上，从而在
不启动图形界面的情况下覆盖完整链路（Markdown → 解析 → 项目探测 → 索引 → 解析管线 → Provider）。
详见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)。

---

## 排障

- **提示 "no definition found"** —— 打开 **CodePort: Show Log**，解析管线会记录跑了哪些引擎、各自返回
  了什么。常见原因：没有 `compile_commands.json`，或 clangd 仍在构建自身索引（大型项目首次查询可能
  需要 30–60 秒）。
- **跳转到了错误的位置** —— 悬停该符号，来源依据行会写明引擎与依据。如果是索引答错了，把
  `codeport.policy` 改成 `lsp-first`，或把 `codeport.policy.indexAcceptConfidence` 设为 `1`，强制每次
  都向 Language Server 确认。
- **索引被禁用** —— 日志会说明原因（缺少 `node:sqlite`，或缺少 tree-sitter 资源）。此时导航仍可通过
  Language Server 工作。
- **大重构后结果陈旧** —— 执行 **CodePort: Rebuild Index**。

## 许可

MIT
