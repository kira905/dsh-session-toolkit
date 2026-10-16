# dsh-session-toolkit

[English](README.en.md) · 中文（默认）

把「**长会话怎么安全地交给下一个会话 / 下一台机器**」这条链上**只读、可复跑**的六件工具抽出来，
通用化后独立成仓。

> **这不是插件**，也不是一个应用：它是一组 **Node.js 脚本**（零第三方依赖）——
> 三个核心件 + 三个共享 lib，全部按 **DSH 的目录约定**读写数据，可单独跑、可被别的脚本 import。

---

## 设计依据

本仓是「**ops-handoff-design**（方法论文档仓）」所述体系的一个实现，设计依据：

- **它为什么存在、边界在哪** → 《长会话的自动交接与接力》**§3.2**（交接档的七段结构与"结构契约"）·
  **§3.3**（档内容禁止清单）· **§5**（接力动作链与顺序铁律）· **§8.4**（三项预算各管一段，不许互相顶替）
- **多机之间怎么过河** → 《多机交接与云中继》**§4.2**（落地层：5 个动作）
- **会话生命周期的自治边界** → 《自治式运维管家》**§2**（会话生命周期覆盖矩阵）·
  《体系全景与家规》**§3.8**（会话生命周期的自治）

文档仓地址：[Gitee](https://gitee.com/kira905/ops-handoff-design) ·
[GitHub](https://github.com/kira905/ops-handoff-design)；组件索引表在文档仓的《发布说明》**§4.5**，本仓对应其中一行。

---

## 一、六件是什么

| 件 | 角色 | 读 / 写 |
|---|---|---|
| `src/relay-facts.mjs` | **交接「事实采集器」**：把"这一棒干了什么、还剩什么"变成机器可核的素材——看板账本里的卡与执行记录、变更流水尾部、本会话写过的文件、近 7 天的交接档目录扫描；另含"降级事实档"渲染（模型不可用时的兜底档） | **纯只读**（除渲染函数返回字符串外不落盘） |
| `src/session-tail-for-llm.mjs` | **「会话取尾」**：多帧 zstd 解帧，把会话尾部若干 turn 渲染成**给模型读**的视图（不截 200 字符、带事件类型与 turn 边界），并带**硬预算闸**（I/O ≤2 MB / 解帧 ≤3 s） | **纯只读**（只读会话日志）；带 CLI |
| `src/dsh-sessions-land.mjs` | **「会话落地器」编排件**：把"另一个实例/另一台机器的会话"落到本机。它自己做**前置校验与判定**（工作副本是不是密文、输出有没有被降级成警告、pull 是不是 non-ff、"上次成功且仓 HEAD 未变则跳过"），真正的拉取/合并交给 `--ps` 指定的脚本 | 只读判定 + **记账**（状态文件，原子写）；带 CLI |
| `src/lib/dsh-home.mjs` | **实例 home / 工作区根 / 报告目录的唯一解析点**（显式参数 + 环境变量可注入） | 只读环境 |
| `src/lib/session-file-name.mjs` | 会话日志**文件名判据的真源**（认全世代：旧名 + `session.vN` 名；读写两侧口径不同，写死） | 无 I/O |
| `src/lib/sessions-land-skip.mjs` | 「跳过落地」判据——**纯函数**（给定输入必然同结果）+ 状态文件原子读写 | 读/写一个状态文件 |

**为什么"落地动作"不在仓里**：那个动作是"把 git 仓里的会话目录合并进本机目录"，
必须贴近你**自己的**同步脚本（加密仓解锁、合并策略、路径习惯都与你有关）。
所以本仓只带上**判定与记账**——也就是最容易被写错、最值得复用的那一半。

---

## 二、运行环境 / 宿主兼容

| 项 | 说明 |
|---|---|
| 运行时 | **Node.js ≥ 20**（`engines.node`） |
| 依赖 | **零第三方依赖**：只用 `node:fs` / `node:path` / `node:os` / `node:zlib` / `node:child_process` / `node:url` |
| 宿主 peer 声明 | **不声明**（见下"为什么不设 peer"） |
| 宿主实测版本 | **`0.2.0-rc.2`** —— 本版发布时在这一个宿主版本上做过实跑冒烟；其它版本**未实测、不作承诺** |

**为什么不设宿主 peer 依赖**：peer 声明表达的是"我的代码要被这个版本的宿主**加载**"，
适用于插件（插件由宿主装配、import 宿主的包）。本仓六件都**不通过宿主装配链加载**、
也**不 import 宿主的任何包**——它们是独立进程，只按**目录约定与文件格式**读写数据。
真正的"兼容区间"因此落在**目录约定**上（见下表），落成 peer 反而会传递一个错误的信号：
"版本对不上就不能用"，而实际判据是"目录约定与文件格式对不对得上"。

### 这六件依赖的接口面（= 实际的兼容边界）

| 用途 | 约定 |
|---|---|
| 实例家目录 | 环境变量 `DSH_HOME`；未设时回落 `~/.dsh`。旧私有名 `BUTLER_DSH_HOME` 作为**一次性兼容读**保留 |
| 活跃会话 | `<DSH_HOME>/sessions/…`，日志文件名 `session.vN.jsonl.zstd`（**认全世代**，不按精确文件名比较） |
| 归档会话 | `<DSH_HOME>/_archived-sessions/…` |
| 看板账本 | `<DSH_HOME>/task-board/ledger-v2.json`（形状：`tasks[]` 优先、`cards[]` 兼容） |
| 工作区树 | 环境变量 `DSH_WORKSPACE`（或由被重定向的 home 推导）；用到 `<工作区>/docs` 与 `<工作区>/docs/变更流水` |

---

## 三、安装

**本仓不发 npm**，克隆即用（零依赖，无需 install）：

```bash
git clone https://gitee.com/kira905/dsh-session-toolkit.git
# 或 https://github.com/kira905/dsh-session-toolkit.git
cd dsh-session-toolkit
node --check src/relay-facts.mjs        # 逐件语法自检；也可以跑 npm run check
```

---

## 四、用法（逐件）

### 4.1 `session-tail-for-llm.mjs` —— 取会话尾给模型看

```bash
node src/session-tail-for-llm.mjs <会话id> [--turns N] [--max-bytes N] [--budget-ms N] [--home <DSH 家目录>] [--json]
```

- `--turns`（默认 4）取尾部几个 turn；`--max-bytes`（默认 2 MB）与 `--budget-ms`（默认 3000）
  是**硬预算**——超限时结果里 `budgetTruncated=true` 并写明是哪一类超限，**不会**静默截断成半份。
- `--home` 指定实例家目录（等价于设 `DSH_HOME`）。
- 退出码：`0` 取到；`1` 没取到（原因写在 `reason`）；`2` 用法错误。

作为库用：`readSessionTail({ sessionId, maxTurns, maxBytes, budgetMs, home })` ·
`findSessionFile(sessionId, { home, roots })` · `isMainEntry(argv1)`。

### 4.2 `dsh-sessions-land.mjs` —— 会话落地（编排）

```bash
node src/dsh-sessions-land.mjs [--json] [--dry-run] [--verbose] [--no-skip]
  --repo <会话仓目录> --ps <你的拉取脚本.ps1>
  [--sessions-dir <dir>] [--archive-dir <dir>] [--timeout-ms <n>]
  [--state-file <path>] [--max-age-ms <n>]
```

- **`--repo` 与 `--ps` 必须给**（也可走环境变量 `DSH_SESSIONS_REPO` / `DSH_SESSIONS_LAND_PS`）。
  本仓**不内置任何本机路径**——缺参数时以 **rc=2** 中止，不会去猜一个目录。
- `--dry-run`：只做判定与预览，不调用拉取脚本。
- `--no-skip`：禁用"上次成功且仓 HEAD 未变则跳过"（想强制跑一次时用）。
- `--state-file`：注入状态文件路径（测试隔离用）。

**退出码**（只作诊断；调用方请以 `--json` 输出的 `reason` 为准）：
`0` 正常 · `4` 仓工作副本未解锁（检测到密文，**拒绝**落地）· `5` 输出被降级 ·
`6` 输出无法解析 · `7` non-ff pull · `8` 脚本缺失 / 启动失败 / 超时 · `9` 仓忙 ·
`2` 用法错误（含未配置 `--repo` / `--ps`）。

作为库用：`run(argv)` · `land(opts)` · `parseCounts(stdout)` · `findDegradedMarker(stdout)` · `DEFAULTS`。

### 4.3 `relay-facts.mjs` —— 交接事实采集（库，无 CLI）

```js
import { collectFacts, renderFactsForPrompt, renderFactSheet, factSheetPath } from './src/relay-facts.mjs'

const facts = collectFacts({
  sourceSessionId: '<会话id>',
  home: '<DSH 家目录>',        // 或设环境变量 DSH_HOME
  docsDir: '<工作区>/docs',    // 不给则取 $DSH_WORKSPACE/docs
  changelogDir: '<工作区>/docs/变更流水',
  now: Date.now(),
})
console.log(renderFactsForPrompt(facts))
```

主要导出：`collectFacts` · `renderFactsForPrompt` · `renderFactSections(facts, opts)` ·
`renderFactSheet(facts, opts)` · `factSheetPath(mainline, opts)` · `readBoardCards` · `readChangelogTail` ·
`scanHandoffDocs` · `extractTouchedFiles` · `buildCardExecutorIndex` · `collectInFlightCards` · `findCardForSession`。

**全部路径经 `opts.*` 注入** ⇒ 单测可完全隔离、不碰生产路径。

### 4.4 `lib/dsh-home.mjs` —— 路径解析的唯一权威

```js
import { resolveDshHome, resolveDshWorkspace, resolveReportDir, resolveChangelogDir } from './src/lib/dsh-home.mjs'

resolveDshHome()                 // 显式参数 > $DSH_HOME > (旧名) > ~/.dsh
resolveDshWorkspace()            // 显式参数 > $DSH_WORKSPACE > 由被重定向的 home 推导
                                 // 都没有 => 抛错（本仓不内置任何机器专有默认值）
```

> ⚠️ 私有原版这里有一个写死的本机工作区常量 `DEFAULT_DSH_WORKSPACE`，本仓**已移除**
> （见 CHANGELOG「相对私有原版的改动」）。取不到时**明确报错**，绝不静默落到磁盘某处。

### 4.5 `lib/session-file-name.mjs` —— 会话日志文件名判据

```js
import { isSessionFileName, sessionFileGeneration, rankSessionFilesInDir, SESSION_FILE_NAME_CURRENT } from './src/lib/session-file-name.mjs'
```

三条口径写死：① 读取侧一律用判据函数，**禁精确字符串比较**；② 需要"代际"时从文件名提取，
**禁硬编码**；③ 写入侧用 `SESSION_FILE_NAME_CURRENT`。
需要读内容的场景**必须走候选链**（`rankSessionFilesInDir` / `collectSessionFilesByDir` 的 `.files`）。

### 4.6 `lib/sessions-land-skip.mjs` —— 跳过落地判据

```js
import { resolveSkipStatePath, readSkipState, writeSkipState, makeSkipState, shouldSkipLanding } from './src/lib/sessions-land-skip.mjs'

const state = readSkipState(resolveSkipStatePath())
shouldSkipLanding({ state, repoHead, localCount, now, maxAgeMs, enabled })
```

判据**fail-safe**：任何一项判不出来（状态缺失/损坏/时钟倒退/本机数未知）⇒ **不跳过**。

---

## 五、环境变量一览

| 变量 | 作用 | 缺省 |
|---|---|---|
| `DSH_HOME` | 实例家目录 | `~/.dsh` |
| `BUTLER_DSH_HOME` | 旧私有名，**兼容读**（仅当 `DSH_HOME` 未设时生效） | — |
| `DSH_WORKSPACE` | 工作区根（放 `docs/` 的那棵树） | 由被重定向的 home 推导；否则**报错** |
| `DSH_SESSIONS_REPO` | 会话仓目录（落地器） | 无，必须给 |
| `DSH_SESSIONS_LAND_PS` | 落地脚本路径（落地器） | 无，必须给 |
| `DSH_SESSIONS_DIR` / `DSH_ARCHIVE_DIR` | 活跃 / 归档会话目录 | `<DSH_HOME>/sessions`、`<DSH_HOME>/_archived-sessions` |
| `DSH_SESSIONS_LAND_STATE` | 跳过判据的状态文件路径 | `<DSH_HOME>/sessions-land.json` |

Windows（cmd）示例：`set DSH_HOME=%USERPROFILE%\.dsh` · `set DSH_WORKSPACE=<工作区根>`；
POSIX（bash）示例：`export DSH_HOME=~/.dsh` · `export DSH_WORKSPACE=~/dsh`。
（PowerShell 把环境变量读作 `env:` 驱动器下的项，赋值语法见官方文档。）

---

## 六、许可

**AGPL-3.0-only + 商业授权（双许可）** —— 全文见 [LICENSE](./LICENSE)。

个人、学习、开源项目可自由使用与修改；若要在**闭源**或**商业**场景中使用，
可另行取得**商业授权**（本仓暂无公开联系邮箱，**请通过本仓 Issue 联系**）。

> ⚠️ **术语澄清**：**AGPL-3.0 本身并不禁止商用**——它只要求衍生作品同样开源。
> "要么按 AGPL 开源、要么取得商业授权"这个组合才是"双许可"的含义。

---

## 七、仓库布局

```
dsh-session-toolkit/
├─ src/
│  ├─ relay-facts.mjs            交接事实采集器（库）
│  ├─ session-tail-for-llm.mjs   会话取尾（库 + CLI）
│  ├─ dsh-sessions-land.mjs      会话落地编排（库 + CLI）
│  └─ lib/
│     ├─ dsh-home.mjs            home / 工作区解析唯一权威
│     ├─ session-file-name.mjs   会话日志文件名判据真源
│     └─ sessions-land-skip.mjs  跳过落地判据 + 状态文件
├─ CHANGELOG.md
├─ LICENSE            AGPL-3.0 全文 + 商业授权段
├─ README.md / README.en.md
└─ package.json
```

---

## 八、已知限度（如实说）

- `dsh-sessions-land.mjs` **不含**拉取/合并脚本本体（见 §一 末段），需要你自己提供 `--ps`。
- 这三件工具面向的是**已有的 DSH 目录结构**；它们不是通用意义上的"会话文件处理库"。
- 解帧只覆盖 DSH 会话日志的**多帧 zstd** 形态；换一种容器格式需要改 `session-tail-for-llm.mjs`。
- 本版在**一个宿主版本**（见 §二）上实跑冒烟；跨版本矩阵未做。
