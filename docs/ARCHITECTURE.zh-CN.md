# CodePort 架构

> [English](ARCHITECTURE.md) · **简体中文**

本文描述 CodePort 最终收敛、**实际落地的架构**。早期有两份设计提案影响了它：一份主张改名并改为适配器
分层（CodeNav），一份主张用「本地索引 + Language Server」双引擎（CodePort）。以下是两者合并后的实现结果。

贯串全文的原则：

> CodePort 不理解所有编程语言。它把这件工作交给 Language Server 与本地索引，并且绝不让其中任何一方
> 独占答案。

## 分层

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

图注（自下而上阅读）：`markdown/` 把文档里的代码区域转成 `SymbolReference`；`core/` 补上语言与项目
上下文，产出 `ResolveContext`；`resolution/` 按策略调度两个解析器 —— `IndexResolver` 查本地索引，
`LspResolver` 经 `adapters/`（如 `ClangdAdapter`）通过 `lsp/` 与真实 Language Server 通信；最后把两边
的候选按置信度合并。图中保留英文标识符，以便与源码目录一一对应。

全局遵守一条依赖规则：**`core/` 之下的任何模块都不 import `vscode`。** Markdown 解析器、索引、LSP
传输层、适配器与解析管线全部是纯 Node 模块 —— 这正是 80 个测试能够在没有图形界面的情况下覆盖它们
（以及整个扩展）的原因。这条规则由 `test/architecture.test.ts` 强制检查，而不是靠约定。

## 目录结构

```
src/
├── extension.ts                 activate / deactivate，注册 Provider 与命令
├── constants.ts                 版本号、输出通道名、配置 section
├── config.ts                    读取配置 + mdCodeLinks.* 迁移
├── logger.ts                    输出通道（off | messages | verbose）
├── types.ts                     Position, Range, Location, SymbolReference, SymbolKind
├── core/
│   ├── CodePort.ts              门面：持有全部组件，配置变更时重建解析管线
│   ├── ProjectManager.ts        带缓存的项目探测
│   ├── LanguageManager.ts       三级语言判定策略 + LspTargetProvider
│   └── IndexService.ts          索引生命周期、文件监听、防抖增量更新
├── markdown/
│   ├── MarkdownParser.ts        代码区域 → SymbolReference[]、symbolAt()、解析缓存
│   ├── CodeBlock.ts             围栏代码块（``` / ~~~），info string → 语言 id
│   └── CodeSpan.ts              行内代码 span（CommonMark 反引号规则）
├── lsp/
│   ├── protocol.ts              用到的 LSP 子集与类型转换
│   ├── LspClient.ts             通用 stdio 客户端（不含任何语言知识）
│   └── LspClientPool.ts         每个「适配器+项目」一个客户端，启动过程共享
├── adapters/
│   ├── LanguageAdapter.ts       接口 + 默认的 LSP 实现
│   ├── AdapterRegistry.ts       语言 id → 适配器，支持用户覆盖
│   ├── clangd/ClangdAdapter.ts  二进制探测、命令行参数、种子文件
│   └── index.ts                 内置适配器 + 注册表工厂
├── project/
│   ├── Project.ts               { root, adapterId, language, markers, compileCommandsDir }
│   ├── ProjectDetector.ts       接口
│   └── detectors/CppProjectDetector.ts
├── index/
│   ├── schema.ts                SQL DDL + schema 版本
│   ├── IndexStore.ts            node:sqlite 封装（懒加载、可选、防御式）
│   ├── TreeSitterParser.ts       WASM 运行时 + 语法加载
│   ├── SymbolExtractor.ts       提取接口 + 注册表
│   ├── CppExtractor.ts          C/C++ 的 tree-sitter AST 遍历器
│   ├── Indexer.ts               全量扫描 + 增量同步，定期让出事件循环
│   └── SymbolIndex.ts           单工作区门面（store + parser + indexer）
├── resolution/
│   ├── Resolver.ts              SymbolResolver, ResolveContext, ResolutionResult, candidate
│   ├── Confidence.ts            索引／LSP 权重与打分
│   ├── Policy.ts                index-first / lsp-first / index-only / lsp-only + 合并
│   ├── ResolverPipeline.ts      按序执行、单个解析器错误隔离
│   ├── IndexResolver.ts         由索引作答
│   └── LspResolver.ts           经适配器作答；在真实位置做 references / hover
├── providers/                   Definition、Reference、Hover、DocumentLink 四个 Provider
├── commands/                    插入源码链接 + 命令面板入口
├── util/                        文本、路径/glob、语言 id、URI 转换
└── vscode/convert.ts            自有类型 ↔ vscode 类型
```

## 核心接口

### 如何描述一处符号引用

```ts
interface SymbolReference {
  name: string;            // `nx::start` 中的 `start`
  raw: string;             // `nx::start`
  container?: string;      // `nx`
  language?: string;       // 来自围栏 info string
  called?: boolean;        // 后面紧跟 `(`
  kindHint?: SymbolKind;   // function | macro
  range: Range;            // 标识符本身
  codeRange: Range;        // 所在的代码区域（插入链接时的替换目标）
  inline: boolean;
}
```

解析器只扫描围栏代码块与行内代码，**从不扫描正文**；并且会显式跳过文件引用（`src/main.c:42`）与 URL，
让它们继续归代码链接 Provider 所有。

### 语言适配器

```ts
abstract class LanguageAdapter {
  readonly id: string;
  readonly languages: readonly string[];
  readonly detector: ProjectDetector;
  abstract serverSpec(project: Project): LspServerSpec;
  abstract seedFiles(project: Project, limit?: number): readonly SeedFile[];
  languageId(language: string): string;
  workspaceSymbol(client, query, container?): Promise<SymbolMatch[]>;   // 默认：走 LSP
  definition(client, uri, position): Promise<Location[]>;               // 默认：走 LSP
  references(client, uri, position, includeDeclaration): Promise<Location[]>; // 默认：走 LSP
  hover(client, uri, position): Promise<string | undefined>;            // 默认：走 LSP
}
```

基类用标准 LSP 请求实现了全部能力，因此新的适配器通常只需要提供 `serverSpec` 与 `seedFiles`。
`workspaceSymbol` 会把每个命中归一化为 `exact` / `qualified` / `fuzzy`，这正是置信度打分的输入。

### 解析器与结果

```ts
interface SymbolResolver {
  readonly id: string;                 // 'index' | 'lsp'
  readonly kind: 'index' | 'lsp';
  isAvailable(context: ResolveContext): boolean;      // 廉价的前置检查
  resolve(context: ResolveContext): Promise<ResolutionResult>;
}

interface ResolutionResult {
  resolver: string;
  candidates: ResolutionCandidate[];   // { location, confidence, source, reason, symbol? }
  confidence: number;                  // 最佳候选的置信度
  durationMs: number;
  error?: string;                      // 单个解析器失败绝不影响这次跳转
}
```

`ResolverPipeline.resolve()` 按策略顺序执行被允许的解析器，一旦策略满足即停止，记录每一次结果，最后
合并。抛异常的解析器会被记录成 `error`，管线继续往下走 —— 即使索引坏了而 clangd 正常，导航依然可用。

## 置信度

提案给出的是相对权重；这里把它们归一化，使「各项证据齐备」的命中恰好达到 `1.0`，阈值才有意义。

| 索引侧证据 | 权重 |
|---|---|
| 名称精确匹配 | `+0.50` |
| 仅前缀匹配 | `+0.20` |
| 限定符与 `a::b` 前缀一致 | `+0.15` |
| 语言族与围栏／项目一致 | `+0.10` |
| 引用形态与符号种类一致 | `+0.15` |
| 全工作区仅此一个候选 | `+0.10` |
| 限定符相互矛盾 | `−0.20` |
| 语言相互矛盾 | `−0.10` |

| Language Server 命中方式 | 置信度 |
|---|---|
| `workspace/symbol`，限定名匹配 | `0.95` |
| `workspace/symbol`，精确名匹配 | `0.92` |
| `workspace/symbol`，部分匹配 | `0.60` |
| `textDocument/definition` | `0.98` |
| `textDocument/references` | `0.92` |

语言一致性按**语言族**而不是精确 id 比较：一个构建语言为 `cpp` 的项目里本来就有 `.c` 文件，这不算
矛盾。语言族定义在 `util/language.ts`。

由此产生的行为（都是刻意设计的）：

- ```` ```c ```` + `` `nx_start()` `` → `0.85`（精确名、语言族、种类、唯一）→ **由索引直接作答，不起
  Language Server**。
- 裸写 `` `nx_start` `` → `0.70` → 去问 Language Server。
- 前缀匹配永远达不到 `0.75` 以上 → 一定去确认。

## 策略

`index-first`（默认）在「恰好一个候选且置信度 ≥ `codeport.policy.indexAcceptConfidence`（0.85）」时
于索引之后停止。`lsp-first` 一旦 Language Server 作答即停止。`index-only` 与 `lsp-only` 让 `order()`
只返回一个引擎。合并时按 `uri:line:character` 去重、保留更高置信度、降序排列 —— 因此 Language Server
的命中（≥ 0.92）天然排在未经确认的索引命中之前，不需要任何特判。

## 索引

Schema（`index/schema.ts`），行列号均为 0 基：

```sql
files(id, path UNIQUE, language, size, mtime, hash)
symbols(id, file_id→files, name, qualified_name, kind, container,
        line, column, end_line, end_column, signature)
symbol_references(id, file_id→files, symbol_id→symbols, name, kind, line, column)
includes(id, file_id→files, target)
meta(key, value)   -- schema_version
```

表名是 `symbol_references` 而非 `references`，因为后者是 SQL 关键字，会迫使所有语句都加引号。

- **磁盘位置**：`.codeport/index.db`（SQLite，WAL 模式）。同一目录下会自动生成 `.codeport/.gitignore`，
  确保缓存不会被提交。
- `Indexer.fullIndex()` 遍历工作区（跳过符号链接与排除项），先一次性加载所需语法，然后只重新解析
  SHA-1 内容哈希发生变化的文件，并清理已删除文件的行。
- `Indexer.indexPaths()` 是文件监听使用的增量路径：工作区 `FileSystemWatcher` 的增／删／改事件以
  500 毫秒为一批应用。
- **一个文件一个事务**，因此单个文件解析失败不会污染索引。
- tree-sitter 解析与 `node:sqlite` 都是同步的，所以循环每 25 个文件让出一次事件循环 —— 这是大型工作区
  下扩展宿主仍然保持响应的关键。
- `schema_version` 不匹配 → 直接删表重建。索引只是缓存。
- **按工作区划分，而不是按项目划分。** `IndexService` 为工作区目录建立索引，完全不查项目探测，因为索引不需要任何构建系统：`compile_commands.json` 是 *clangd* 的要求，不是 CodePort 的。只有 Language Server 才以探测到的项目（`compile_commands.json` / `.clangd`）为前提。`startInBackground()` 对同一根目录幂等，因此解析器可以按需调用（`index.prewarm = false`）而不会重复排队扫描。把索引挂在项目探测上曾是一个真实缺陷：两个标记文件都不存在时索引永远不会被填充，所有查询都会失败 —— 由 `test/degradation.test.ts` 守住。

### 为什么同时要 tree-sitter 和 clangd

tree-sitter 恢复的是**结构**：函数、方法、聚合类型、枚举成员、typedef、别名、变量、字段、命名空间、宏、
include。它无法判断 `foo(x)` 究竟指向谁 —— 那是重载解析、模板实例化与宏展开，恰恰是 Language Server
的职责。索引提供速度与离线覆盖，Language Server 提供正确性；两者都不被要求去做对方的事。

| | CodePort 索引 | Language Server |
|---|---|---|
| 速度 | 毫秒级，无需启动服务 | 取决于服务端／其自身索引 |
| 可离线 | 是 | 需要服务端 |
| C++ 重载、模板、宏、条件编译 | 否 | 是 |
| 代价 | tree-sitter 解析 + 极小的 SQLite 库 | 完整的编译器级解析 |

## 语言判定（三级）

1. **围栏 info string** —— ```` ```c ```` 是最强信号，据此选择适配器（可被 `codeport.languages` 覆盖）。
2. **文档上下文** —— 文档自身所属的项目：CMake 工程里的 `docs/` 依然是 C/C++。
3. **工作区兜底** —— 尝试工作区内的所有项目。若都答不上来，就报告 *no definition found*。
   **CodePort 从不猜。**

实现在 `core/LanguageManager.ts`，它同时实现 `LspTargetProvider`。正是这个注入，使得
`resolution/LspResolver.ts` 里完全没有工作区与配置相关的逻辑。

## 新增一门语言

1. `project/detectors/RustProjectDetector.ts` —— 实现 `ProjectDetector`（查找 `Cargo.toml`）。
2. `adapters/rust/RustAnalyzerAdapter.ts` —— 继承 `LanguageAdapter`，提供 `id`、`languages`、
   `detector`、`serverSpec`、`seedFiles`。如果希望本地索引也覆盖它，把 `rust` 加入
   `scripts/build.mjs` 的 `GRAMMARS` 列表，并实现 `RustExtractor`。
3. 在 `adapters/index.ts` 中注册。

除此之外无需改动任何东西：核心、解析管线、策略、Provider、索引存储与命令都与语言无关。即使跳过第 2 步
的 extractor，Rust 也能仅靠 rust-analyzer 正常工作 —— `SymbolIndex.create` 只是报告更少的受支持语言。

## 与原始提案的差异及原因

| 原始提案 | 实际落地 | 原因 |
|---|---|---|
| 命名 `CodeNav`（较早提案） | `CodePort`（较晚提案） | 较晚的提案取代了较早的，且「双引擎」是更准确的描述。 |
| 通过驱动使用 SQLite | Node 内置 `node:sqlite` | VS Code 1.130 内置 Node 24，因此真 SQLite 无需原生模块、无需 `electron-rebuild`。防御式探测：缺失 → 禁用索引，仅走 LSP。 |
| tree-sitter 原生绑定 | `@vscode/tree-sitter-wasm`（WASM） | 不与 VS Code 的 Node ABI 耦合；资源被复制到 `dist/wasm/`，打包产物自包含。 |
| `references` 表 | `symbol_references` | `references` 是 SQL 关键字。 |
| 调用图／继承图 | 未实现 | 较晚的提案明确排除：它们会把「导航工具」变成「代码智能引擎」。 |
| 提案给出的权重数值 | 归一化到总和 1.0 | 提案中的示例权重根本达不到它自己设定的 0.90 阈值。 |
| `confidence >= 0.90` 才接受 | `0.85`，可配置 | 取 0.90 时索引快路径几乎永远走不到，索引就失去意义。 |
| tree-sitter 的 C 语法 | `.c` 也用 C++ 语法 | `@vscode/tree-sitter-wasm` 不含纯 C 语法；C++ 语法是 C 的超集。 |

## 测试

| 文件 | 覆盖内容 |
|---|---|
| `test/markdown.test.ts` | 行内／围栏提取、关键字与路径/URL 跳过、CommonMark 反引号规则、光标定位 |
| `test/cpp-extractor.test.ts` | 符号种类、container、签名、include、引用、elaborated-type-reference 回归 |
| `test/index-store.test.ts` | schema、精确／前缀查询、`LIKE` 转义、级联删除、清理、落盘与重开 |
| `test/confidence-policy.test.ts` | 权重、阈值、语言族、策略顺序、合并排序、管线快路径、升级到 LSP、错误隔离、取消 |
| `test/lsp-client.test.ts` | 与 mock server 之间的真实 JSON-RPC 分帧：握手、多字节 UTF-8、服务端→客户端请求、spawn 失败、连接池复用 |
| `test/activation.test.ts` | **真实 esbuild 产物** + 桩化 VS Code API + 临时 C 项目：Provider/命令注册、索引构建、跳转定义、Hover 来源依据、经真实 clangd 的引用查找、干净关闭 |
| `test/architecture.test.ts` | 架构不变量：`core/` 之下不 import `vscode`、无 TS 参数属性、适配器契约、策略枚举一致、命令与配置项的贡献／注册／读取三方一致 |
| `test/degradation.test.ts` | **既无构建系统、也无 Language Server**：索引仍仅凭工作区建立；跳转／Hover／插入链接可用；升级到「已死的」服务端的弱证据查询仍能从索引作答；查找所有引用会如实报告「未找到」而不是猜 |

`test/activation.test.ts` 刻意使用打包产物而非源码，因此**构建失败或 WASM 资源缺失都会让测试失败**。
