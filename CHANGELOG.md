# Changelog

本仓遵循语义化版本（组件仓三段式 `vX.Y.Z`）。
"相对私有原版的改动"单列一节——这个仓是从一个私有工作树里抽出来并**通用化**的，
使用者有权知道抽出来时改了什么。

---

## v0.1.1 — 2026-10-19

补发批：把三个**生命周期入口**及其依赖闭包并入本仓（v0.1.0 只发了六件）。

### 新增（本版 +7 件 · 共 13 件）

| 件 | 作用 |
|---|---|
| `src/context-check.mjs` | 上下文用量自查（宿主 RPC `session.list` 投影）；超阈值 `rc=7` |
| `src/session-axis-set.mjs` | 接力轴标注（`【续】` / `【已交接】`，调 `session.rename`）；含 `--self-test` |
| `src/archive-inactive-sessions.mjs` | 非活跃会话归档：整目录搬移 + 逐文件 sha256 校验 + manifest；**从不删除** |
| `src/lib/dsh-rpc-client.mjs` | 宿主 HTTP RPC 客户端（可发布件）：端点表 + 新旧双栈回落 + wire 自适应 |
| `src/lib/archive-meta-store.mjs` | 归档元数据库（加速缓存）：原子写 + 跨进程锁 + 损坏 fail-closed + `.bak` 轮转 |
| `src/lib/projcache-read.mjs` | `session_projcache` 读写口径统一入口（分片优先、旧单文件兜底） |
| `src/lib/zstd-frames.mjs` | zstd 多帧拆帧（严格帧结构解析；撕裂帧返回 `tornStart`，不猜） |

**补发件的来源**：这三个入口原先静态依赖宿主的「凭据通道」件，不能直接公开。那次拆分
（凭据通道拆分）把「RPC 客户端件」与「宿主凭据解析件」分开：**前者可发布、后者永不发布**。
入口改依赖前者后，三个入口的依赖闭包不再含任何凭据路径/家目录耦合 ⇒ 本版得以补发。

### 相对私有原版的改动（本版）

- **零盘符绝对路径**：`archive-inactive-sessions.mjs` 的同步副本仓默认值（原为一个本机绝对路径）
  改为 **`--synced-repo` 必填**；缺参 ⇒ **fail-closed（一个都不归档，rc=3）**，不猜任何目录。
- **去私有术语**：`仓2 / 过河 / TUF` 等私有叫法改为通用的「副本仓 / 已同步」；跳过原因文案同步改。
- **去内部卡号与私有路径**：注释里的内部卡号、里程碑号、私有工具名、私有目录示例、
  内部报告指针一律删除或改为通用描述（含 `dsh-host-rpc.mjs` 薄壳、内部管家组件家族、
  `_tmp` 取证脚本等）。
- **共享件路径改相对**：注释里的内部库路径改为相对路径（`./lib/*.mjs`）。
- **删掉未使用的 `node:os` import**（`archive-meta-store.mjs`；本件不读家目录）。
- **旧私有环境变量名**：`BUTLER_DSH_HOME` 仍是**一次性兼容读**（主名 `DSH_HOME` 优先），
  与 v0.1.0 口径一致。
- **`session-file-name.mjs`**：写入侧当前世代常量推到 **v4**（`session.v4.jsonl.zstd`），
  读取侧判据认任意 `vN`（与私有原版同源；本仓上一版是 v3）。

> **不改的**：协议、数据结构、退出码语义、判据口径、阈值、`LICENSE`（AGPL-3.0 + 商业授权，字节不改）。

### 已知限度（本版）

- 三个补发入口只做了**隔离夹具冒烟**（17/17 通过），**未连宿主实跑**；宿主 RPC 面在公开环境
  无内置凭据 —— 需 `DSH_RPC_COOKIE_SECRET` 或显式 `cookieSecret`，否则**明确报错**（不静默）。
- `archive-inactive-sessions.mjs --synced-only` 必须显式给 `--synced-repo`。

---

## v0.1.0 — 2026-10-16

首个公开发行版。六件会话生命周期工具从私有 DSH 工作树中抽出、通用化后独立成仓。

### 新增（本仓构成）

| 件 | 作用 |
|---|---|
| `src/relay-facts.mjs` | 交接「事实采集器」（**纯只读**）：读看板账本 / 变更流水尾部 / 交接档目录，产出七段结构的事实素材；含"降级事实档"渲染 |
| `src/session-tail-for-llm.mjs` | 「会话取尾」（**给模型看**的视图）：多帧 zstd 解帧 + 预算闸（I/O ≤2 MB / 解帧 ≤3 s）+ 条目化渲染；带 CLI |
| `src/dsh-sessions-land.mjs` | 「会话落地器」的**编排件**：解锁前置校验 + 降级输出判定 + non-ff 检测 + 「上次成功且仓 HEAD 未变则跳过」；带 CLI（落地动作本身由你提供的 PowerShell 脚本承担，见 `--ps`） |
| `src/lib/dsh-home.mjs` | 实例 home / 工作区根 / 报告目录的**唯一解析点**（环境变量 + 显式参数可注入） |
| `src/lib/session-file-name.mjs` | 会话日志**文件名判据的真源**（认全世代：旧名 + `session.vN` 名） |
| `src/lib/sessions-land-skip.mjs` | 「跳过落地」判据（**纯函数**，可单测）+ 状态文件读写（原子写） |

### 相对私有原版的改动

- **环境变量去私有化**：主名改为 `DSH_HOME`；旧私有名 `BUTLER_DSH_HOME` 保留为
  **一次性兼容读**（先读主名、再回落旧名，不报错）。
- **状态文件改名**：`butler-sessions-land.json` → `sessions-land.json`。
  **兼容读在位**：新名不存在、旧名存在时继续读旧文件；写入一律写新名 ⇒ 首次写入后自动完成迁移。
- **零盘符绝对路径**：所有写死的本机绝对路径（工作区默认值、会话仓默认值、落地脚本默认值、
  交接档命令文本里的路径）改为 **环境变量 / 显式参数注入**；不再内置任何机器专有默认值，
  取不到时**明确报错**（`resolveDshWorkspace()` 抛错；两个 CLI 以 rc=2 中止），绝不静默落到磁盘某处。
- **移除 `DEFAULT_DSH_WORKSPACE` 常量**：它原本是一个写死的本机工作区路径，与"不内置机器专有默认值"
  直接冲突 ⇒ 由 `DSH_WORKSPACE_ENV` + `resolveDshWorkspace()` 取代。
- **去私有命名的注释**：注释里的私有组件名、私有目录示例、用户名目录示例一律改为通用描述或占位符。
- **可外置项**：交接档第 7 段的禁写清单可由 `opts.forbiddenNote` 覆盖；交接档文本里的"接力器命令"
  路径可由 `opts.relayCmd` 覆盖。
- **共享收口**：原先各自复制一份的 home 解析（`relay-facts.mjs` / `session-tail-for-llm.mjs`）
  统一收口到 `src/lib/dsh-home.mjs`，不再存在两份可能漂移的实现。

> **不改的**：协议、数据结构、退出码语义、判据口径、预算阈值。

### 许可（本版起）

**AGPL-3.0-only + 商业授权（双许可）** —— 见 [`LICENSE`](./LICENSE)。
本仓为此项目的**首个公开发行版**，不存在更早的公开许可。
⚠️ 术语澄清：AGPL-3.0 **不禁止商用**，它只要求衍生作品同样开源；
"要么按 AGPL 开源、要么取得商业授权"这个组合才是"双许可"的含义。

### 已知限度

- `src/dsh-sessions-land.mjs` 是**编排件**：真正的"拉取 + 合并"由你用 `--ps` 指定的
  PowerShell 脚本执行。仓内不含该脚本；缺 `--repo` / `--ps` 时以 rc=2 中止。
- 六件都按 **DSH 的目录约定**工作（`<DSH_HOME>/sessions`、`_archived-sessions`、看板账本、
  `docs/` 树）。抽出的对象是"工具"，不是"能脱离 DSH 目录结构跑的东西"。
- 本版未做**端到端冒烟之外的兼容性矩阵**：宿主实测版本见 README「运行环境」一节，
  未实测的宿主版本不作承诺。
