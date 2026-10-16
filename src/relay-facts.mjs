#!/usr/bin/env node
// relay-facts.mjs —— 会话接力**阶段 2**的「事实采集器」（**纯只读**）
//
// 口径真源：`docs\自动交接与会话接力-方案-20260920.md`（v19）
//   §12 阶段 2 ①：「事实采集器 + 七段结构校验（按 §4.2 结构契约，含反例单测）」
//   §4.6 动作 ①：「采集事实段（卡 / 执行记录 / 变更流水 / 本会话改过的文件）」
//   §4.2 交接档七段契约（段标题逐字 `## <n>. <名>`；第 5 段必须有序首项；头部 key: value）
//   §6.2 采集开销预算（三类各管一段）：解帧 I/O ≤2 MB / ≤3 s（由 `session-tail-for-llm.mjs` 承担）·
//        送模型 prompt ≤1.5 MB（`RELAY_PROMPT_MAX_BYTES`）· **档目录扫描 = 只读近 7 天 mtime
//        + 份数上限 50（按 mtime 降序）**（本文件 `scanHandoffDocs` 承担）
//
// ── 边界（**不许越界**）────────────────────────────────────────────────────
//   · 本文件**只读**：不写档、不写台账、不写审计、不建锁、不发 HTTP。
//   · 事实档的**结构校验**与"要不要接力"的判定**都不在这里** —— 前者走 `session-relay.mjs`
//     的 `validateHandoffDoc()`（同一份实现，不复制第二套），后者走 `runRelay()` 的闸门。
//   · 主线名候选只**提出**、不裁决：`checkMainline()` / `normalizeMainline()` 的唯一实现在
//     `tools/lib/mainline.mjs`（§4.2 K-5：闸门 2/3 与统计口径只走它一处）。
//   · 一切路径经 `opts.*` 注入 ⇒ 单测可完全隔离、不碰生产路径（卡测试口径：探针隔离）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 环境解析（home / 工作区根）唯一真源 —— 不再自带副本
import { resolveDshHome, resolveDshWorkspace } from './lib/dsh-home.mjs';

export const FACTS_VERSION = '0.1.0';

export const HEADER_SECTION_NAMES = Object.freeze([
  '头部', '一句话现状', '已完成', '在途 / 待验收', '下一步', '待主人拍板', '路径速查 + 红线',
]);

/** 档内容禁止清单第 7 段固定行（§4.2 V9-10：模板第 7 段必须带这一行）。 */
export const FORBIDDEN_NOTE = '本档禁写：凭据值 / 内网地址 / 他人隐私 / 会话原文';

/**
 * 禁止清单**可外置**：`renderFactSheet()` / `renderFactSections()` 接受 `opts.forbiddenNote`
 * 覆盖默认值（默认 = 上面的 `FORBIDDEN_NOTE`）。按自己的环境改写时保持"一段一行"的形态。
 */

/** 档目录扫描预算（§6.2 K-19 / S-6）：近 7 天 mtime + 按 **mtime 降序**取前 50。 */
export const DOC_SCAN_RECENT_MS = 7 * 24 * 3600 * 1000;
export const DOC_SCAN_MAX_FILES = 50;
/** 变更流水尾部读取预算（文件已 1.5 MB 且只增不减 ⇒ 绝不整读）。 */
export const CHANGELOG_TAIL_BYTES = 64 * 1024;
export const CHANGELOG_MAX_LINES = 20;
/** 在途卡清单上限（第 4 段素材；防 prompt 被卡表撑爆）。 */
export const IN_FLIGHT_MAX = 30;

/** 会话数据根（口径唯一真源 = lib/dsh-home.mjs：$DSH_HOME > 旧私有名 > ~/.dsh）。 */
function resolveHome(opts = {}) {
  return resolveDshHome(opts.home);
}

/**
 * 工作区下的 docs 目录（可注入：`opts.docsDir` 优先）。
 * ⚠️ 本发行版不内置任何本机路径：`opts.docsDir` 与 $DSH_WORKSPACE 都没给 => 抛错。
 */
function resolveDocsDir(opts = {}) {
  return opts.docsDir ? String(opts.docsDir) : path.join(resolveDshWorkspace(), 'docs');
}

/**
 * 交接/日报文本里出现的"接力器命令"（**路径不再写死**）。
 * 注入优先级：`opts.relayCmd` > `<工作区>/tools/session-relay.mjs` > 占位符。
 */
function relayCmdOf(opts = {}) {
  if (opts.relayCmd) return String(opts.relayCmd);
  try { return path.join(resolveDshWorkspace(), 'tools', 'session-relay.mjs'); }
  catch { return '<workspace>/tools/session-relay.mjs'; }
}

const deviceName = () => process.env.COMPUTERNAME || process.env.HOSTNAME || os.hostname();
const nowOf = (opts) => (typeof opts.now === 'function' ? opts.now() : (opts.now ?? Date.now()));

// ═══════════════════════════════════════════════════════════════════════════
// 一、卡 / 执行记录（看板账本 ledger-v2.json · 只读）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 只读看板账本。
 * ⚠️ 形状判据与 `session-relay.mjs#isCardExecutorSession` 同款：`tasks` 优先、`cards` 兼容；
 *    两者都无 ⇒ `readable:false`（**不许当成"没有卡"**）。
 */
export function readBoardCards(opts = {}) {
  const file = opts.boardFile ?? path.join(resolveHome(opts), 'task-board', 'ledger-v2.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, readable: true, reason: 'no-board-ledger', file, tasks: [] };
    return { ok: false, readable: false, reason: 'board-ledger-unreadable', error: e?.message ?? String(e), file, tasks: [] };
  }
  const list = Array.isArray(raw?.tasks) ? raw.tasks : (Array.isArray(raw?.cards) ? raw.cards : null);
  if (list === null) return { ok: false, readable: false, reason: 'board-ledger-unknown-shape', file, tasks: [] };
  return { ok: true, readable: true, file, tasks: list };
}

/** 找"该会话在跑的卡"（= 任一 `executions[].sessionId === sid`）。 */
export function findCardForSession(tasks, sessionId) {
  const sid = String(sessionId ?? '');
  for (const c of Array.isArray(tasks) ? tasks : []) {
    const exs = Array.isArray(c?.executions) ? c.executions : [];
    for (let i = exs.length - 1; i >= 0; i--) {
      if (String(exs[i]?.sessionId ?? '') === sid) {
        return { found: true, cardId: c?.id ?? null, title: c?.title ?? null, status: c?.status ?? null, line: c?.line ?? null, execution: exs[i] ?? null, executionIndex: i };
      }
    }
  }
  return { found: false, cardId: null, title: null, status: null, line: null, execution: null, executionIndex: null };
}

/**
 * 一次读账本建「卡执行会话」索引。
 * **为什么需要**：阶段 2 每 tick 要判 60+ 个会话，而 `session-relay.mjs#isCardExecutorSession()`
 * 每次调用都整读一遍 5 MB 的 `ledger-v2.json` ⇒ 逐会话调用是 O(N×5MB)（会拖垮 tickd）。
 * **口径不变**：判定权威仍是对 `executions[].sessionId` 的精确比对（与 `isCardExecutorSession` 同源），
 * 本索引只是**同一次读取**上的缓存视图，**不是第二套判据**。
 */
export function buildCardExecutorIndex(opts = {}) {
  const r = readBoardCards(opts);
  const map = new Map();
  if (r.readable) {
    for (const c of r.tasks) {
      for (const ex of (Array.isArray(c?.executions) ? c.executions : [])) {
        const sid = String(ex?.sessionId ?? '');
        if (sid) map.set(sid, c?.id ?? null);
      }
    }
  }
  return {
    ok: r.ok, readable: r.readable, reason: r.reason, file: r.file, size: map.size,
    judge: (sid) => (r.readable
      ? { cardExecutor: map.has(String(sid)), cardId: map.get(String(sid)) ?? null, readable: true }
      : { cardExecutor: false, cardId: null, readable: false, reason: r.reason }),
  };
}

/** 在途 / 待验收卡（第 4 段素材）：状态 ∈ {todo, running, review}，未归档。 */
export function collectInFlightCards(tasks, opts = {}) {
  const keep = new Set(opts.statuses ?? ['todo', 'running', 'review']);
  const max = Number(opts.max ?? IN_FLIGHT_MAX);
  const out = [];
  for (const c of Array.isArray(tasks) ? tasks : []) {
    if (c?.archivedAt) continue;
    if (!keep.has(String(c?.status ?? ''))) continue;
    const exs = Array.isArray(c?.executions) ? c.executions : [];
    const boundSession = String(opts.srcSessionId ?? '');
    out.push({
      id: c?.id ?? null, title: c?.title ?? null, status: c?.status ?? null, line: c?.line ?? null,
      lastSessionId: exs.length ? (exs[exs.length - 1]?.sessionId ?? null) : null,
      isOwnCard: boundSession ? exs.some((e) => String(e?.sessionId ?? '') === boundSession) : false,
    });
  }
  return { total: out.length, shown: out.slice(0, max), truncated: out.length > max };
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、变更流水（只读尾部 —— 文件已 1.5 MB 量级）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 读 `docs\变更流水\<YYYY-MM>.md` 的**尾部**若干行（绝不整读）。
 * @returns {{ok:boolean, file:string|null, lines:string[], reason?:string}}
 */
export function readChangelogTail(opts = {}) {
  let dir;
  try {
    dir = opts.changelogDir ?? path.join(resolveDshWorkspace(), 'docs', '变更流水');
  } catch (e) {
    return { ok: false, file: null, lines: [], reason: `changelog-dir-not-configured:${e?.message ?? e}` };
  }
  const now = nowOf(opts);
  const file = path.join(dir, `${new Date(now).toISOString().slice(0, 7)}.md`);
  const maxBytes = Number(opts.maxBytes ?? CHANGELOG_TAIL_BYTES);
  let fd = null;
  try {
    const st = fs.statSync(file);
    const from = Math.max(0, st.size - maxBytes);
    const len = st.size - from;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, from);
    let text = buf.toString('utf8');
    if (from > 0) { const i = text.indexOf('\n'); text = i >= 0 ? text.slice(i + 1) : ''; } // 丢弃可能截半的首行
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(-Number(opts.maxLines ?? CHANGELOG_MAX_LINES));
    return { ok: true, file, lines, truncatedHead: from > 0 };
  } catch (e) {
    return { ok: false, file: fs.existsSync(file) ? file : null, lines: [], reason: e?.code === 'ENOENT' ? 'no-changelog' : `changelog-read-error:${e?.message ?? e}` };
  } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、本会话改过的文件（从会话尾的工具调用里提）
// ═══════════════════════════════════════════════════════════════════════════

const FILE_KEYS = Object.freeze(['file_path', 'filePath', 'path', 'file', 'target', 'filename', 'notebook_path']);
const WRITE_TOOLS = /^(write|edit|str_replace|apply_patch|create_file|Write|Edit|NotebookEdit)/i;

/**
 * 从解帧记录里提取"被工具点过的文件"（**只读提取，不改任何东西**）。
 * @param {object[]} records `decodeFrames().records`
 * @returns {{read:number[], written:string[], tools:Record<string,number>}}
 */
export function extractTouchedFiles(records) {
  const written = new Set(); const readSet = new Set(); const tools = {};
  for (const r of Array.isArray(records) ? records : []) {
    if (r?.type !== 'tool/call') continue;
    const name = String(r?.data?.name ?? r?.data?.toolName ?? '?');
    tools[name] = (tools[name] ?? 0) + 1;
    const args = r?.data?.arguments ?? r?.data?.args ?? r?.data?.input ?? null;
    const collect = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const k of FILE_KEYS) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) (WRITE_TOOLS.test(name) ? written : readSet).add(v.trim());
      }
    };
    if (typeof args === 'string') { try { collect(JSON.parse(args)); } catch { /* 非 JSON 参数忽略 */ } }
    else collect(args);
  }
  return { read: [...readSet], written: [...written], tools };
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、档目录扫描（判定① 的**辅助判据** + K-19 预算）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 扫 `docs\交接-*.md`（**只读近 7 天 mtime + 按 mtime 降序前 50** · §6.2）。
 * 用途（§4.6 判定①(2)）：命中**本会话 id** 的档必须 `generatedBy: agent` 才算"已产出"；
 * `llm-deepseek` / `llm-fallback`（阶段 2 自产档）**一律不计入**（防自举悖论）。
 * ⚠️ 老档（行首无 `^sourceSession:`）按**忽略**处理：不计入已产出、也不报错（K-19 升格）。
 * @returns {{ok:boolean, scanned:number, total:number, skippedBudget:boolean, matched:string[], agentDocs:string[], selfDocs:string[], reason?:string}}
 */
export function scanHandoffDocs(opts = {}) {
  let dir;
  try {
    dir = resolveDocsDir(opts);
  } catch (e) {
    return { ok: false, scanned: 0, total: 0, skippedBudget: false, matched: [], agentDocs: [], selfDocs: [], reason: `docs-dir-not-configured:${e?.message ?? e}` };
  }
  const now = nowOf(opts);
  const recentMs = Number(opts.recentMs ?? DOC_SCAN_RECENT_MS);
  const maxFiles = Number(opts.maxFiles ?? DOC_SCAN_MAX_FILES);
  const sid = String(opts.sourceSessionId ?? '');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { ok: false, scanned: 0, total: 0, skippedBudget: false, matched: [], agentDocs: [], selfDocs: [], reason: `docs-dir-unreadable:${e?.message ?? e}` }; }
  const cands = [];
  for (const n of names) {
    if (!/^交接-.*\.md$/.test(n)) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    // 预算 ①：只读近 7 天 mtime
    if (now - st.mtimeMs > recentMs) continue;
    cands.push({ file: p, name: n, mtimeMs: st.mtimeMs });
  }
  // 预算 ②：按 **mtime 降序**取前 50（排序口径写死 —— 不许留给实现期自选 · S-6）
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const total = cands.length;
  const picked = cands.slice(0, maxFiles);
  const matched = []; const agentDocs = []; const selfDocs = [];
  for (const c of picked) {
    let text = '';
    try { text = fs.readFileSync(c.file, 'utf8'); } catch { continue; }
    const m = text.match(/^sourceSession\s*:\s*(.+)$/m);
    if (!m) continue;                                   // 老档（无行首字段）⇒ 忽略，不报错
    if (m[1].trim() !== sid) continue;                  // 不是本会话的档
    const g = text.match(/^generatedBy\s*:\s*(.+)$/m);
    matched.push(c.name);
    const gen = (g?.[1] ?? '').trim();
    if (gen === 'agent') agentDocs.push(c.name);
    else if (gen === 'llm-deepseek' || gen === 'llm-fallback') selfDocs.push(c.name);
  }
  return {
    ok: true, scanned: picked.length, total,
    // 超预算（候选 > 上限）⇒ 由**调用方**按"未产出"保守处理并记 `skipped-budget`（fail 方向写死）
    skippedBudget: total > maxFiles,
    matched, agentDocs, selfDocs, dir,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、一体化采集
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 采集全部事实（**纯只读**）。
 * @param {object} opts
 *   sourceSessionId（必须）· home · now · board / changelog / handoffScan / tail 各类可注入
 *   · tail（可选：外部已取好的会话尾结果，避免重复解帧）
 * @returns {object} facts
 */
export function collectFacts(opts = {}) {
  const t0 = Date.now();
  const now = nowOf(opts);
  const sid = String(opts.sourceSessionId ?? '').trim();
  const notes = [];
  const facts = {
    version: FACTS_VERSION, asOf: new Date(now).toISOString(), sourceSessionId: sid,
    device: deviceName(), card: null, inFlight: null, changelog: null, touched: null,
    tail: null, handoffScan: null, budget: { elapsedMs: 0, skipped: [] }, notes,
  };

  // 卡 / 执行记录
  const board = opts.board ?? readBoardCards(opts);
  if (!board.readable) notes.push(`看板账本不可读：${board.reason}（**不许当成"没有卡"**）`);
  facts.card = board.readable ? findCardForSession(board.tasks, sid) : { found: false, reason: board.reason };
  facts.inFlight = board.readable ? collectInFlightCards(board.tasks, { srcSessionId: sid }) : { total: 0, shown: [], truncated: false };

  // 变更流水（尾部）
  facts.changelog = opts.changelog ?? readChangelogTail(opts);
  if (facts.changelog && !facts.changelog.ok) notes.push(`变更流水不可读：${facts.changelog.reason}`);

  // 会话尾（可选：未传入则由调用方负责；本采集器**不自己解帧**，避免两处读同一文件）
  facts.tail = opts.tail ?? null;

  // 本会话改过的文件（复用已解出的记录）
  if (facts.tail && Array.isArray(facts.tail._records)) facts.touched = extractTouchedFiles(facts.tail._records);

  // 档目录扫描（判定① 辅助判据）
  facts.handoffScan = opts.handoffScan ?? scanHandoffDocs({ ...opts, sourceSessionId: sid });
  if (facts.handoffScan?.skippedBudget) facts.budget.skipped.push('handoff-doc-scan-budget');
  if (facts.handoffScan && !facts.handoffScan.ok) notes.push(`档目录扫描不可用：${facts.handoffScan.reason}`);

  facts.budget.elapsedMs = Date.now() - t0;
  return facts;
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、渲染：喂给模型的素材 + 降级用的「事实档」
// ═══════════════════════════════════════════════════════════════════════════

/** 给 LLM 的事实段（**第 2/3/5/6 段的素材**；不含会话原文全文，原文另由取尾提供）。 */
export function renderFactsForPrompt(facts) {
  const L = [];
  L.push('### 机器采集的事实段（可信、逐条可核）');
  L.push(`- as-of：${facts.asOf} · 源会话：\`${facts.sourceSessionId}\` · 设备：${facts.device}`);
  const c = facts.card ?? {};
  L.push(`- 触发的卡：${c.found ? `「${c.title}」（id \`${c.cardId}\` · 状态 ${c.status}${c.line ? ` · 主线「${c.line}」` : ''}）` : '（未在看板执行记录里找到该会话 —— 见下方 notes）'}`);
  if (facts.inFlight?.total) {
    L.push(`- 在途 / 待验收卡：共 ${facts.inFlight.total} 张（列前 ${facts.inFlight.shown.length}）：`);
    for (const k of facts.inFlight.shown) L.push(`  - 「${k.title}」· ${k.status}${k.isOwnCard ? ' · **本会话执行中**' : ''}${k.lastSessionId ? ` · 末次会话 \`${k.lastSessionId}\`` : ''}`);
    if (facts.inFlight.truncated) L.push(`  - …（其余 ${facts.inFlight.total - facts.inFlight.shown.length} 张略）`);
  } else L.push('- 在途 / 待验收卡：0 张');
  const cl = facts.changelog;
  L.push(`- 变更流水（${cl?.ok ? `尾部 ${cl.lines.length} 行` : `不可读：${cl?.reason ?? '未知'}`}）：`);
  if (cl?.lines?.length) for (const l of cl.lines) L.push(`  - ${l}`);
  else L.push('  - （无）');
  if (facts.touched) {
    const w = facts.touched.written ?? [];
    L.push(`- 本会话写过的文件（从会话日志的写类工具调用提）：${w.length ? '' : '（无）'}`);
    for (const f of w.slice(0, 20)) L.push(`  - \`${f}\``);
    if (w.length > 20) L.push(`  - …（其余 ${w.length - 20} 个略）`);
  }
  if (facts.notes?.length) for (const n of facts.notes) L.push(`- ⚠️ ${n}`);
  return L.join('\n');
}

/**
 * 渲染**事实段**（七段里的 3 / 4 / 7 段）—— 降级事实档与阶段 2 自动档**共用同一实现**。
 * @returns {{s3:string, s4:string, s7:string}}
 */
export function renderFactSections(facts, opts = {}) {
  const L3 = [];
  const c = facts?.card ?? {};
  L3.push(`- ${c.found ? `触发的卡：「${c.title}」（id \`${c.cardId}\` · 状态 ${c.status}${c.line ? ` · 主线「${c.line}」` : ''}）` : '（看板里未找到该会话的执行记录 —— 见下方 notes）'}`);
  if (facts?.touched?.written?.length) {
    L3.push('- 本会话写过的文件（据会话日志的写类工具调用）：');
    for (const f of facts.touched.written.slice(0, 30)) L3.push(`  - \`${f}\``);
    if (facts.touched.written.length > 30) L3.push(`  - …（其余 ${facts.touched.written.length - 30} 个略）`);
  } else L3.push('- 本会话写过的文件：（未能从会话日志提取）');
  const cl = facts?.changelog;
  if (cl?.ok && cl.lines.length) {
    L3.push('- 变更流水（尾部摘录）：');
    for (const l of cl.lines) L3.push(`  - ${l}`);
  } else L3.push(`- 变更流水：不可读（${cl?.reason ?? '未知'}）`);
  if (facts?.notes?.length) for (const n of facts.notes) L3.push(`- ⚠️ ${n}`);

  const L4 = [];
  if (facts?.inFlight?.total) {
    for (const k of facts.inFlight.shown) L4.push(`- 「${k.title}」· ${k.status} · 卡 \`${k.id}\`${k.lastSessionId ? ` · 当前绑定会话 \`${k.lastSessionId}\`` : ''}${k.isOwnCard ? ' · **本会话执行中**' : ''}`);
    if (facts.inFlight.truncated) L4.push(`- …（其余 ${facts.inFlight.total - facts.inFlight.shown.length} 张略）`);
  } else if (facts?.inFlight) L4.push('- （机器采集：无）');
  else L4.push('- （看板账本不可读 ⇒ 本段未能采集）');

  const s7 = [
    `- 方案：<你的方案档> · 台账：\`${opts.relayLedger ?? '<你的接力台账路径>'}\` · 日报段：\`node ${relayCmdOf(opts)} --report\``,
    `- 审计：\`${opts.relayAuditDir ?? '<你的接力审计目录>'}/*.jsonl\`（本档对应接力器那一行的 \`result\` 字段）`,
    `- ${String(opts.forbiddenNote ?? FORBIDDEN_NOTE).trim()}`,
    '- 红线：本档**不构成许可**；改动、归档、放行一律由主人或本鱼手动执行。',
  ].join('\n');

  return { s3: L3.join('\n'), s4: L4.join('\n'), s7 };
}

/**
 * 渲染**事实档**（七段结构 · §4.2；用于降级路径「只写事实档」）。
 * `generatedBy` 只能取 `llm-fallback`（模型不可用 / 草稿不合格 / 会话日志打不开）——
 * **该字段是判定① 排除自产档的依据，不许写成 `agent`**。
 * 第 5 段**必须**带 `1. ` 有序首项（否则 `validateHandoffDoc()` 判不合格 ⇒ 与既有一致）。
 */
export function renderFactSheet(facts, opts = {}) {
  const mainline = String(opts.mainline ?? '').trim() || '（未定主线）';
  const reason = String(opts.reason ?? 'unknown');
  const hitDetail = opts.redactionHits ? ` · 出机器前粗筛命中 ${opts.redactionHits} 处（**未调用模型**）` : '';
  const parts = renderFactSections(facts, opts);
  const L = [];
  L.push(`# 交接 · ${mainline} · 事实档（阶段 2 降级 · 未接力）`);
  L.push('');
  L.push(`> **为什么是事实档**：阶段 2 无人值守接力在「${reason}」这一环失败 ⇒ 按 §4.6「失败降级」口径**只写事实档 + 桌宠喊话 + 日报段**，**绝不开新会话**（fail-closed）${hitDetail}。`);
  L.push(`> 处置人 = **主人本人**；本档**不自动重试**（避免无人值守下反复降级刷屏）。`);
  L.push('');
  L.push('## 1. 头部');
  L.push('');
  L.push(`mainline: ${mainline}`);
  L.push(`sourceSession: ${facts.sourceSessionId}`);
  L.push(`device: ${facts.device}`);
  L.push('mode: auto-llm');
  L.push('generatedBy: llm-fallback');
  L.push(`chainId: ${opts.chainId ?? '-'}`);
  L.push('relayedAt: -');
  L.push('');
  L.push('## 2. 一句话现状');
  L.push('');
  L.push(`会话 \`${facts.sourceSessionId}\` 处于无人值守（卡执行会话）且上下文越限，阶段 2 自动接力**降级**：档由机器按事实生成，第 2/3/5/6 段**未经模型撰写**，请人工核对后接管。`);
  L.push('');
  L.push('## 3. 已完成');
  L.push('');
  L.push(parts.s3);
  L.push('');
  L.push('## 4. 在途 / 待验收');
  L.push('');
  L.push(parts.s4);
  L.push('');
  L.push('## 5. 下一步');
  L.push('');
  L.push(`1. 人工接管：跑 \`node ${relayCmdOf(opts)} --report\` 看当轮明细与降级原因（本档由降级产生，原因 = ${reason}）。`);
  L.push('2. 人工判断该主线是否继续：需要接力则手写正式交接档（`generatedBy: agent`）后跑主路径。');
  L.push('3. 若属模型/网络临时故障：下一个 tick 会重新评估（**同一源会话当日额度已预占，不再自动重试**）。');
  L.push('');
  L.push('## 6. 待主人拍板');
  L.push('');
  L.push('1. 是否人工接管这条主线（本档只给事实，不给结论）。');
  L.push('');
  L.push('## 7. 路径速查 + 红线');
  L.push('');
  L.push(parts.s7);
  L.push('');
  return L.join('\n');
}

/** 事实档文件名（与 `session-relay.mjs#handoffDocPath` 同口径：`交接-<主线>-<YYYYMMDD>.md`，同名加 `-2`）。 */
export function factSheetPath(mainline, opts = {}) {
  const docsDir = resolveDocsDir(opts);
  const now = nowOf(opts);
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const safe = String(mainline ?? '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '未定主线';
  const base = path.join(docsDir, `交接-${safe}-${stamp}.md`);
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i <= 20; i++) {
    const p = path.join(docsDir, `交接-${safe}-${stamp}-${i}.md`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(docsDir, `交接-${safe}-${stamp}-21.md`);
}
