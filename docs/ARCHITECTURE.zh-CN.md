# CodePort 架构

> [English](ARCHITECTURE.md) · **简体中文**

本文描述 CodePort 最终收敛、**实际落地的架构**。它替换了早期那版「本地 tree-sitter 索引 + 项目
Language Server」的双引擎设计；那版设计保留在 git 历史里，差异见[改了什么](#改了什么)。

贯串全文的原则：

> CodePort 不理解所有编程语言，也不去尝试。它把这件事交给代码图谱 —— CodeGraph —— 自己只保留真正
> 属于它的部分：判断一段 Markdown 提及**指什么**，以及把一个答案变成编辑器里的导航目标。

## 分层

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
│ core/       CodePort 门面                                   │
│             → ResolveContext { symbol, language, project } │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────┐
│ resolution/ ResolverPipeline → CodegraphResolver           │
│             置信度打分、合并、来源标注                        │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
┌────────────────────────────────────────────────────────────┐
│ codegraph/  sdk.ts         定位并加载 SDK                   │
│             CodegraphIndex 单个图谱的门面、坐标与类型换算     │
└─────────────────────────┬──────────────────────────────────┘
                          ▼
                  ┌───────────────────┐
                  │ CodeGraph（外部）  │
                  │ .codegraph/       │
                  │   codegraph.db    │
                  └───────────────────┘
```

一条依赖规则贯穿始终：**`core/` 以下的任何模块都不 import `vscode`。** Markdown 解析、CodeGraph
适配、resolver、索引门面全是纯 Node 模块 —— 这就是整个扩展（连打包产物一起）能在无 GUI 环境下被测试
覆盖的原因。

## 目录结构

```
src/
├── extension.ts                 activate / deactivate，provider 与命令注册
├── constants.ts                 输出通道名、图谱目录、配置段
├── config.ts                    设置读取
├── logger.ts                    输出通道（off | messages | verbose）
├── types.ts                     Position, Range, Location, SymbolReference, SymbolKind
├── codegraph/
│   ├── sdk.ts                   定位并加载已安装的 CodeGraph（永不打包进来）
│   └── CodegraphIndex.ts        单图谱门面、node → hit 映射、类型与坐标换算
├── core/
│   └── CodePort.ts              门面：图谱、管线、Markdown 解析缓存
├── markdown/
│   ├── MarkdownParser.ts        代码区域 → SymbolReference[]、symbolAt()、解析缓存
│   ├── CodeBlock.ts             围栏块（``` / ~~~），info string → 语言 id
│   └── CodeSpan.ts              行内代码（CommonMark 反引号 run 规则）
├── resolution/
│   ├── Resolver.ts              SymbolResolver, ResolveContext, ResolutionResult, candidate
│   ├── Ranking.ts               证据信号，以及它们产生的依据文案
│   ├── CompileCommands.ts       `compile_commands.json` 的定位、解析与缓存（build 信号）
│   ├── WeakLinkage.ts           从定义行判断弱链接（强定义压过弱定义）
│   ├── ResolverPipeline.ts      顺序执行、单 resolver 错误隔离、合并
│   └── CodegraphResolver.ts     唯一的引擎
├── providers/                   Definition / Reference / Hover / DocumentLink
├── commands/                    插入源码链接 + 命令面板入口
├── util/                        text、path/glob、语言 id、uri 换算
└── vscode/convert.ts            纯类型 ↔ vscode 类型
```

## 核心接口

### 一段提及意味着什么

```ts
interface SymbolReference {
  name: string;            // `nx::start` 里的 `start`
  raw: string;             // `nx::start`
  container?: string;      // `nx`
  language?: string;       // 来自围栏 info string —— 现在唯一的语言信号
  called?: boolean;        // 后面紧跟 `(`
  kindHint?: SymbolKind;   // function | macro
  range: Range;            // 标识符本身
  codeRange: Range;        // 所在的代码区域（插入链接的改写目标）
  inline: boolean;
}
```

解析器只扫围栏代码块与行内代码，从不扫正文，并且显式跳过文件提及（`src/main.c:42`）与 URL —— 那些
留给路径链接 provider。

### Resolver 与结果

```ts
interface SymbolResolver {
  readonly id: string;                 // 'codegraph'
  isAvailable(context: ResolveContext): boolean;      // 廉价、同步的预检
  resolve(context: ResolveContext): Promise<ResolutionResult>;
}

interface ResolutionResult {
  resolver: string;
  candidates: ResolutionCandidate[];   // { location, rank, source, reason, symbol? }
  durationMs: number;
  error?: string;                      // resolver 失败绝不导致跳转失败
}
```

`ResolverPipeline.resolve()` 按顺序跑 resolver 然后合并。目前只有一个 resolver，所以循环只跑一次 ——
这个接缝是刻意保留的：以后要加第二个意见，只需写一个 resolver，不用动 provider。抛异常的 resolver 会被
记成 `error`，管线继续。

## 排序

这里**没有数值置信度**，而且是有意删掉的，不是遗漏。旧的 `0..1` 分数存在的唯一目的是拿去和
`codeport.policy.indexAcceptConfidence` 比较，决定是否升级去问 Language Server。单引擎下没有可升级的
对象，于是归一化出来的 `0.85` 成了伪精度：一个不 gate 任何东西、却长得像概率的数字。权重表、归一化和
`clamp01` 一起删掉了。

仍然吃重的是**排序**。当多个符号同名时 —— 重载，或不同文件里的 `static` 函数 —— 由提及自身的证据决定谁
排在前面，因为 Hover 取的是 `candidates[0]`，Peek 列表也是从上往下读的。所以候选带一个整数 `rank`：
一致的信号数减去矛盾的信号数。

| 信号 | 点数 |
|---|---|
| 名字精确匹配（前缀匹配不得分） | `+1` |
| 限定符与 `a::b` 前缀一致 | `+1` |
| 语言族与围栏一致 | `+1` |
| 提及形状与类型一致 | `+1` |
| 限定符矛盾 | `−1` |
| 语言矛盾 | `−1` |
| 候选所在文件出现在项目的 `compile_commands.json` 里 | `+1` |

因此证据齐全的命中 rank 为 `4`；没有围栏的裸 `` `nx_start` `` 为 `1`。

最后一行不是 `rankCandidate` 的信号：*提及*本身不可能与某次构建一致或不一致。它由 `CodegraphResolver`
在组装候选时加上，数据来自 `resolution/CompileCommands.ts`，也是唯一能让候选超过 `MAX_RANK` 的信号。

### 构建收窄（build narrowing）

**对"有 `compile_commands.json` 的 C/C++ 项目"，只要数据库对这个名字有答案，它就直接替换图谱给出的列表，
而不只是重排。** 图谱是整棵源码树的静态视图，所以 NuttX 这类 ARCH 钩子（`up_allocate_heap` 每个芯片一个
定义）会返回二十个证据完全相同的候选，只能靠 `(file_path, start_line)` 排序 —— 那是代码的属性，不是构建的
属性，Peek 列表等于抛硬币。编译数据库是唯一知道"本次构建到底编译了哪个文件"的产物（`bear -- make`、CMake、
`ninja -t compdb`），而"*本次*构建用的是哪个定义"才是跳转该回答的问题。`CodegraphResolver.ts` 里的
`narrowToBuild()` 分三步落实：

1. **构建里的 C 族候选留下，C 族里其余候选丢掉。** 其余那些按定义就不属于本次构建。
2. **绝不丢其它语言的定义。** 编译数据库是 C/C++ 的产物，不能因此隐藏同名的 Python 或 Rust 定义；这些候选
   原样存活。
3. **强定义压过弱定义。** 那两个 `up_allocate_heap` 可能都真的是本次构建的编译单元，此时成员资格无法区分它们
   —— 但链接器可以：NuttX 的通用默认实现声明为 `weak_function`，芯片覆盖版本则不是。`WeakLinkage.ts` 从定义
   自身那一行源码里读出这个标记，因为在没有预处理、也没有链接步骤的图谱里，这是该事实唯一存在的地方。

收窄发生在 `MAX_CANDIDATES` 上限**之前**，所以即使按名字排序会把构建真正编译的那个定义挤出前二十，它依然能
被找到。

四条取舍让收窄保持克制：

- **没有答案就不收窄。** 笔记本就是横向对比平台的地方，里面完全可能提到当前 `.config` 不参与构建的符号
  （另一块板、`sim:nsh`）。当一个构建内候选都没有时，什么都不丢，完整列表带着提及证据原样返回 —— 与之前
  行为完全一致。
- **失败不算错误。** 没有数据库、JSON 读不动、数据库来自另一个平台：不收窄、也没有信号。定位从 Markdown
  文件向上走但绝不越出工作区，所以指向别处的 `note/` 符号链接不会误捡到无关的构建。
- **弱链接的判断刻意保守。** 只读图谱指向的那一行、只取符号名**之前**的那段文本，而且只有在确实存在强候选可
  优先时才生效。漏判的代价是一次 Peek 列表，误判则会静默藏掉正确答案。
- **廉价且自动刷新。** 每次解析只做几次 `existsSync`；解析结果按 mtime 和大小缓存，切换平台后重新跑
  `bear -- make` 无需重载窗口即可生效。

有三点是**选择**而不是巧合：

- **矛盾只减分，绝不淘汰。** `sameLanguageFamily` 对族表之外的语言一律返回 false，所以若把矛盾当淘汰，
  一个 ```` ```text ```` 围栏就会把所有候选静默丢掉。被减分的候选仍然出现在 Peek 列表里 —— 排在末尾。
- **同一次结果集里匹配类型不会混。** `CodegraphIndex.query` 有精确命中就返回精确命中，否则返回前缀命中，
  从不混合。所以"精确/前缀"这一点数今天只体现在 Hover 文案里；它保持为一点而不是单纯 tie-break，是为了
  将来真有第二个引擎把两者合进同一结果集时，精确命中仍能压过证据相同的前缀命中。
- **没有"唯一性"项。** 它过去在只有一个候选时贡献 `+0.10`，那描述的是结果集的属性，而不是"哪个候选对"的
  证据，无法用来排序。

Hover 会原样渲染这些依据，它们就是全部解释：

```
nx_start — nx · function

void nx_start(void)

a.c:7
codegraph · exact name, language c, kind function
```

语言按**族**比较而不是精确 id：构建语言为 `cpp` 的项目里本来就有 `.c` 文件，这不算矛盾。族表在
`util/language.ts`。

语言信号只来自围栏还有一个后果：没有围栏的裸 `` `nx_start` `` rank 为 `1`，而旧设计给它 `0.70`，因为三级
策略可以从文档所属项目推断语言。这只影响排序与 Hover 那一行，不影响跳转能不能用。

## CodeGraph 接入

CodeGraph 是**外部工具**，待遇和以前的 `clangd` 完全一样：CodePort 从不打包它。平台包自带一份 Node
运行时（光 `node` 就约 123 MB，npm 包解包约 292 MB），塞进 `.vsix` 不现实。`src/codegraph/sdk.ts`
负责找到已安装的那份，并**在进程内**加载：

- 候选顺序：`codeport.codegraph.path` 设置、`CODEGRAPH_SDK_PATH`、项目的 `node_modules`、扩展自己的
  `node_modules`，最后是常见的全局前缀；
- 该包是 CommonJS 且 `module.exports` 是动态赋值，所以动态 `import()` 拿到的东西全在 `default` 上，
  加载器会做归一化；
- 某个候选加载失败会继续试下一个，因此某个前缀下的坏安装不会遮蔽另一个前缀下的好安装。

为什么用进程内而不是 CLI 或 MCP server：在 46 个文件的 TypeScript 项目上实测，加载 SDK 一次性约
72 ms、打开图谱约 5 ms、精确名字查询亚毫秒。查询路径上没有 daemon、没有 socket、没有 IPC。CLI 等价
操作每次约 180 ms，因为每次调用都要重新拉起一个运行时。

### CodeGraph 给 CodePort 提供什么

| 需求 | CodeGraph API |
|---|---|
| 一个名字的全部定义（不截断） | `getNodesByName`（文档明确说会枚举全部重载） |
| 弱提及 | `getNodesByNamePrefix` |
| 精确位置 | `Node.startLine` / `endLine` / `startColumn` / `endColumn` |
| Hover 文本 | `Node.signature`，没有则 `getCode`（读文件） |
| 查找所有引用 | `findUsages` —— 边带着**调用点的行与列** |
| 新鲜度 | `isInitialized`、`getStats` |

### 两处只在一个地方处理的换算

`CodegraphIndex.toHit` 是唯一处理它们的地方。这两处都属于「写错不会报错、只会把跳转送到错误位置」的
类型，所以都有测试钉住：

1. CodeGraph 报的是 **1-based 行号**与 **0-based 列号**。CodePort 全程 0-based，所以行号要减一。
2. CodeGraph 报的 `filePath` 是**相对项目根**的，不是绝对路径。它必须相对图谱根拼接，绝不能相对进程
   工作目录。

图谱根本身通过从文件向上查找 `.codegraph/codegraph.db` 得到，并且是本地重新实现的（而不是调 SDK），
这样 `isAvailable()` 在 SDK 加载之前就能保持同步且正确。

### 能力边界

CodeGraph 的图是**结构化的**，与当年 tree-sitter 给出的是同一类答案 —— 更广更快，但不是更有语义。代价：

| | CodeGraph |
|---|---|
| 文件规模 / 速度 | 毫秒级，不需要构建系统 |
| 语言 | 很广（实测版本 36 种） |
| 重载、模板、条件编译 | **不支持** —— 按名字与 import 解析，不是语义解析 |
| 预处理宏 | **完全没有这个节点类型** —— `#define` 的名字无法成为跳转目标 |
| 查找所有引用 | 静态调用/引用图，不是语义结果 |

宏这一条是与被替换设计相比唯一的能力回退：旧设计用自研 tree-sitter 遍历能提取 `#define` 名字。
Definition provider 的「找不到」提示会明确指出这一点。

## 路径 / 行号链接

路径链接是从未碰过符号引擎的那一半，现在依然没有碰。`providers/DocumentLinkProvider.ts` 就是正则加
`fs.statSync`；它对 `CodePort` 只有一次调用，取配置。它扫的是**整篇正文**而不只是代码片段，解析顺序为
绝对路径 → 相对工作区根 →（可选）相对 Markdown 文件。

这份独立性是刻意的，并且现在有测试保证：无论 CodeGraph 缺失、打不开还是健康，路径链接都必须照常工作。

## 设置

配置旧索引与 clangd 两层的设置都已删除 —— 这两件事现在都归 CodeGraph，它的配置在项目根的
`codegraph.json` 与 `.codegraph/` 目录里，不在 VS Code 里。

| 设置 | 用途 |
|---|---|
| `codeport.enabled` | 总开关 |
| `codeport.definition.enabled` | 跳转定义 |
| `codeport.references.enabled` | 查找所有引用 |
| `codeport.hover.enabled` | Hover |
| `codeport.codeLink.enabled` | 路径 / 行号链接 |
| `codeport.codeLink.resolveRelativeToMarkdownFile` | 同时相对笔记所在目录解析路径链接 |
| `codeport.codegraph.path` | CodeGraph 安装位置（留空 = 自动探测） |
| `codeport.trace` | 日志级别 |

## 测试

| 文件 | 覆盖 |
|---|---|
| `test/markdown.test.ts` | 行内/围栏提取、关键字与路径/URL 跳过、CommonMark 反引号规则、光标命中 |
| `test/codegraph.test.ts` | 两处坐标/路径换算、类型映射、container 拆分、图谱发现、SDK 定位与加载、单根缓存 |
| `test/resolution.test.ts` | 每个排序信号与矛盾信号、类型/限定符一致性、合并排序、管线错误隔离与取消、resolver 对 fixture 图谱的端到端、构建收窄（CDB 定位/无答案回退/强压弱/与上限的先后）及其数据库的解析与缓存 |
| `test/activation.test.ts` | **真实 esbuild bundle** 跑在桩化 VS Code API 与临时项目上：provider/命令注册、跳转定义、Hover 来源、Hover 源码回退、带精确调用点的引用、**路径链接** |
| `test/degradation.test.ts` | 没有索引、索引打不开、宏无法索引，以及这三种状态下路径链接照常工作 |
| `test/architecture.test.ts` | 被强制的不变量：`core/` 以下不 import `vscode`、不使用 TypeScript 参数属性、CodeGraph 永不被静态 import、贡献/注册/读取的设置保持一致 |

测试通过 `CODEGRAPH_SDK_PATH` 指向 `test/fixtures/fake-codegraph-sdk.js` 与
`fake-codegraph-sdk-broken.js` 来接触 CodeGraph，所以测试套件既不需要真实安装、也不受它影响。
`test/activation.test.ts` 与 `test/degradation.test.ts` 刻意跑打包产物而不是源码，因此构建坏掉会让
测试失败。

## 改了什么

旧架构跑两个可互换的引擎 —— `.codeport/index.db` 里的本地 tree-sitter 索引，以及项目的
Language Server（优先 clangd）—— 再由一套 policy 决定如何组合。

| 旧 | 新 | 原因 |
|---|---|---|
| tree-sitter WASM + `node:sqlite` 索引（1810 行） | 只读的 CodeGraph 图谱 | 无需为每种语言写 extractor 就有广覆盖；而且这份索引可以和工具链其它部分共用 |
| 手写 LSP 客户端接 clangd（1073 行） | 删除 | 引用与 Hover 由 CodeGraph 回答；在选定的方向下保留编译器级那一层超出范围 |
| 四套 resolution policy | 一次确定性合并 | 单引擎没有可权衡的对象 |
| 三级语言检测 | 围栏 info string | 语言检测由 CodeGraph 按文件自己做 |
| 用项目探测决定是否启动 server | 删除 | 它唯一的消费方就是 clangd |
| `.vsix` 里约 5.4 MB 的 WASM 资产 | 无 | CodeGraph 自己加载解析器 |
| 归一化的 `0..1` 置信度分数 | 整数证据 rank | 单引擎下没有阈值可供分数比较，那个数字不 gate 任何东西 |
| `mdCodeLinks.*` 设置迁移 | 删除 | CodePort 还在 1.0 之前，而唯一有落点的旧键已经不存在 |
