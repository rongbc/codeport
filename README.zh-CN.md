# CodePort —— 从 Markdown 直达源码

[English](README.md) · **简体中文**

<p align="center">
  <img src="media/codeport_logo.png" alt="CodePort" width="128" />
</p>

![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-blue) ![License](https://img.shields.io/badge/license-MIT-blue) ![Engine](https://img.shields.io/badge/engine-CodeGraph-orange) ![Languages](https://img.shields.io/badge/languages-any%20CodeGraph%20parses-brightgreen)

**把光标放在 Markdown 里写下的符号上，就能直接跳到它的源码。** CodePort 把「跳转定义、Peek 定义、查找所有引用、Hover、可点击的 `path/file.c:42` 链接」带进笔记里的围栏代码块与行内代码 —— 底层是 [CodeGraph](https://github.com/colbymchenry/codegraph) 代码图谱。

- **围栏代码块或行内代码里的标识符，F12 / Ctrl+Click** 即可跳到定义；同名多定义时给出与在源码文件里一致的 Peek 列表。
- **单引擎，不需要 Language Server。** 跳转不再依赖 clangd 或任何 server，而是进程内直读 CodeGraph 索引 —— 没有 daemon、没有 IPC、查询亚毫秒。
- **CodeGraph 能解析的语言都能用**，不再是只有 C/C++；每种语言都无需配置。
- **查找所有引用**、**带来源标注的 Hover**、可点击的 `` `src/main.c:42` `` 路径链接，以及把 `` `nx_start()` `` 变成 `[nx_start()](../sched/init/nx_start.c#L123)` 的 **插入源码链接**。
- 欢迎在 [Issues](https://github.com/rongbc/codeport/issues) 提需求与报 bug。

<br/>

## 功能 ⚡

### 在 Markdown 里跳转定义 ⭐

把光标放在**围栏代码块**或**行内代码**中的标识符上，按 **F12** 或 **Ctrl+Click**：

````markdown
Call `nx_start()` to initialise the scheduler.

```c
nxsched_add_readytorun(tcb);
```
````

同名多定义（例如不同文件里的 `static` 函数）会弹出与源码里一致的 Peek 列表。

**C/C++ 项目若有 `compile_commands.json`**，这个列表会直接收窄成本次构建真正使用的那个定义：构建之外的候选被丢掉，剩下的里面弱默认实现（`weak_function`）让位给芯片的强覆盖版本。数据库对这个名字没有答案时（比如笔记讲的是另一块板，或当前配的是板级而笔记在讲 `sim:nsh`）什么都不丢，仍然是通常的 Peek 列表。

### 查找所有引用

先解析出定义，再向 CodeGraph 查询它的使用点；图谱的边带着**每个调用点的精确行列**，所以结果落在编译器会放的位置。

### 带来源标注的 Hover

悬停会给出签名，以及这个答案建立在哪些信号上：

```
nx_start — nx · function

void nx_start(void)

a.c:7
codegraph · exact name, language c, kind function
```

这份依据列表就是全部解释：这里没有数值置信度，因为已经没有东西留给一个数字去决定了。CodeGraph 没有该符号
的签名时，Hover 改为展示符号自身源码。

### 路径 / 行号链接

```
`/home/user/project/src/main.c:42`  → 绝对路径：打开该文件第 42 行
`src/main.c:42`                     → 相对工作区根解析
```

也可以用 `codeport.codeLink.resolveRelativeToMarkdownFile` 让它同时相对当前 Markdown 文件解析。

路径链接**完全不经过代码图谱** —— 装没装 CodeGraph 都能用。

### 插入源码链接（反方向）

把提及变成指向定义的 Markdown 链接：

````markdown
`nx_start()`   →   [nx_start()](../sched/init/nx_start.c#L123)
````

编辑器右键菜单 → **CodePort: Insert Source Link**。只支持行内代码 —— Markdown 不在围栏代码块里渲染链接。

<br/>
<br/>

## 快速上手 🚀

### 1. 安装扩展

打包 `.vsix` 后安装（推荐），或从源码运行：

```sh
npm install && npm run package
code --install-extension codeport-0.2.1.vsix
```

想改代码就用 VS Code 打开本仓库按 **F5** 起 Extension Development Host —— 见[开发](#开发)。

### 2. 安装 CodeGraph 并给项目建索引

CodePort 只读 CodeGraph 的索引，不负责建。装 CLI 并给要导航的项目建索引：

```sh
npm i -g @colbymchenry/codegraph --registry=https://registry.npmjs.org
cd <你的项目>
codegraph index
```

它会生成 `<项目>/.codegraph/codegraph.db`。CodePort 从被编辑的文件向上查找该目录，所以打开已索引项目的子目录也能用。`codegraph` 装在别处时，用 `codeport.codegraph.path` 指过去。

> **必须用官方 npm 源。** npmmirror 等镜像没有镜像 CodeGraph 的平台包，而 npm 会把「取不到的可选依赖」当成功 —— 结果是安装显示成功、一用就段错误。

### 3. 在 Markdown 里跳转

| 我想…… | 操作 |
| --- | --- |
| 跳到定义 | 光标放标识符上按 **F12** / **Ctrl+Click**（或 `CodePort: Go to Definition`） |
| 不离开笔记预览 | **Alt+F12**（或 `CodePort: Peek Definition`） |
| 知道为什么跳到这里 | 悬停 —— 来源行会写出依据与置信度 |
| 找出所有使用 | **Shift+F12**（或 `CodePort: Find All References`） |
| 打开被提到的文件 | **Ctrl+Click** `` `src/main.c:42` `` |
| 把提及变成指向定义的链接 | 右键行内代码 → **CodePort: Insert Source Link** |

决策与评分都会记录：**CodePort: Show Log** 打开输出通道。

### 4. 查看索引内容

| 命令 | 说明 |
| --- | --- |
| `CodePort: Show Index Statistics` | 每个工作区的文件 / 节点 / 边数量（读自 CodeGraph）。 |
| `CodePort: Show Index Rebuild Command` | 给出应执行的 `codegraph index <目录>` 命令（索引归 CodeGraph 管）。 |
| `CodePort: Show Log` | 管线日志：引擎跑了什么、返回了什么。 |

<br/>

## 一份用了 CodePort 的笔记

项目里的 `docs/scheduler.md`：

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

光标在 `` `nx_start()` `` 或 `nxsched_add_readytorun` 上按 **F12** 打开定义；在 `` `include/nx/sched.h:42` `` 上 **Ctrl+Click** 打开该文件第 42 行。悬停任何一个都会告诉你答案来自哪里。

<br/>

## 设置

### 通用

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `codeport.enabled` | `true` | 总开关。 |
| `codeport.definition.enabled` | `true` | Markdown 代码里的跳转定义。 |
| `codeport.references.enabled` | `true` | 查找所有引用。 |
| `codeport.hover.enabled` | `true` | 带签名与来源的 Hover。 |
| `codeport.codeLink.enabled` | `true` | 可点击的 `path/file.c:42` 链接。 |
| `codeport.codeLink.resolveRelativeToMarkdownFile` | `false` | 同时相对 Markdown 文件解析路径链接。 |

### CodeGraph

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `codeport.codegraph.path` | `""` | CodeGraph 安装位置：包目录、`npm-sdk.js` 入口或 `codegraph` CLI。留空 = 自动探测（项目 `node_modules`，再到常见全局前缀）。 |
| `codeport.trace` | `messages` | 输出通道日志级别（`off` 仍会报告警告与错误）。 |

其余关于索引的事 —— 索引哪些文件、哪些语言、忽略什么 —— 都是 CodeGraph 自己的配置（项目根的 `codegraph.json` 与 `.codegraph/`）。

<br/>

## 支持的语言

取决于安装的 CodeGraph 能解析什么。范围很广（开发所依据的版本支持 36 种：C、C++、Objective-C、TypeScript/JavaScript、Python、Go、Rust、Java、C#、PHP、Ruby、Swift、Kotlin、Dart、Scala、Lua、R 等）。

不需要按语言做任何配置；要加语言是更新 CodeGraph，不是改 CodePort。

注意：**能解析不等于有语义**。重载、模板、条件编译是按名字与 import 匹配的，不是编译器级判断，见[已知限制](#已知限制)。

<br/>

## 环境要求

- VS Code **≥ 1.90**。
- **安装了 [CodeGraph](https://github.com/colbymchenry/codegraph) 且项目已建索引**（`codegraph index`）。没有它扩展照样激活、路径链接照样可用，但符号导航会报「no definition found」并说明原因。
- 必须打开一个文件夹 —— 单个散文件没有可解析的项目。

无原生模块、无需 `npm rebuild`：CodePort 自己不带解析器，CodeGraph 自带它需要的运行时。

<br/>

## 已知限制

- 只扫描**围栏代码块**与**行内代码**，正文永远不会被当作符号，文件提及 / URL 归路径链接所有。
- **预处理宏跳不了。** CodeGraph 没有 macro 节点类型，`#define` 的名字不在图里，`SOME_MACRO` 形式的提及无法解析。（被替换掉的旧设计用自研 tree-sitter 索引能提取宏 —— 这是那次改动唯一的能力回退。）
- **没有语义解析。** 重载、模板实例化、条件编译都不建模，CodeGraph 按名字与 import 匹配；编译器能区分的两个重载，这里可能是歧义。
- **查找所有引用是静态调用图**，不是编译器级结果；同名跨作用域时可能归错目标。
- 用于评分的语言信号**只来自围栏 info string**。没有围栏的裸 `` `nx_start` `` 因此比过去得分低。
- Markdown 不在围栏代码块里渲染链接，所以**插入源码链接**只适用于行内代码。

<br/>

## 工作原理

CodePort 不试图理解所有语言，也不自带解析器。它把**唯一引擎** —— CodeGraph 的代码图谱 —— 当作事实来源，自己只负责真正属于它的部分：判断一段 Markdown 提及指什么、给候选打分、把胜者变成编辑器的导航目标。

```
Markdown  ──►  CodePort  ──►  CodeGraph（进程内：定位 SDK → 打开 .codegraph/codegraph.db）
   `nx_start()`                        │
                                       ▼
                                   源码定义
```

路径链接刻意留在这条管线之外：它就是正则加 `stat`，没有图谱也能工作。

完整设计 —— 分层、置信度权重、两处最容易写错的坐标换算、能力边界，以及「改了什么」—— 见 **[docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)**。

<br/>

## 排错

- **「no definition found」** —— 打开 **CodePort: Show Log**。按可能性排序：该目录没有 CodeGraph 索引（`codegraph index <目录>`）；这个名字是预处理宏，CodeGraph 不建模；名字确实不在图里。
- **「CodeGraph was not found」** —— 没找到已安装的 SDK。安装它（`npm i -g @colbymchenry/codegraph`），或设置 `codeport.codegraph.path`。
- **跳错了位置** —— 悬停看来源行写的依据。名字有歧义时，在笔记里写限定形式（`` `nx::start()` `` 而不是 `` `start()` ``）会提高正确候选的置信度。
- **大改之后结果过期** —— 在该项目里跑 `codegraph sync`（或 `codegraph index`）。CodePort 只读图谱，从不写它。

<br/>

## 链接与资源 🔗

- [仓库](https://github.com/rongbc/codeport)
- [Issues](https://github.com/rongbc/codeport/issues)
- [架构](docs/ARCHITECTURE.md) · [架构（中文）](docs/ARCHITECTURE.zh-CN.md)
- [CodeGraph](https://github.com/colbymchenry/codegraph) —— CodePort 读取的代码图谱引擎

<br/>

## 开发

```
src/markdown/    围栏代码块 + 行内代码 → 符号提及
src/codegraph/   定位/加载 CodeGraph SDK，单图谱门面
src/core/        门面：图谱、管线、Markdown 解析缓存
src/resolution/  CodeGraph resolver、置信度、管线
src/providers/   Definition / Reference / Hover / DocumentLink
src/commands/    Insert Source Link 与命令面板入口
test/            单元 + 集成测试（后两个跑真实 bundle）
docs/            ARCHITECTURE.md / ARCHITECTURE.zh-CN.md
```

脚本：`npm run build`（esbuild → `dist/`）· `npm run watch` · `npm run typecheck` · `npm test` · `npm run check`（typecheck + build + test）· `npm run package`（`@vscode/vsce` → `codeport-0.2.1.vsix`）。

按 **F5** 启动 Extension Development Host。

`npm run package` 会通过 `vscode:prepublish` 先构建 `dist/`，再用 `@vscode/vsce` 打包。`.vsix` 写在仓库根目录并被 git 忽略。

测试套件里有端到端用例跑**真实 bundle**（桩化的 VS Code API + 临时项目），所以整条链路（Markdown → 解析 → resolver → provider）不用起 GUI 就被覆盖。CodeGraph 本身由 fixture SDK 通过 `CODEGRAPH_SDK_PATH` 替代，所以测试既不依赖真实安装、也不受它影响。每个测试文件覆盖什么见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md#测试)。

<br/>

## 许可

MIT —— 见 [LICENSE](LICENSE)。
