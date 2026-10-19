#!/usr/bin/env node
// session-tail-for-llm.mjs —— 会话接力**阶段 2** 的「会话取尾」（**给模型看**的视图）
//
// 口径真源：`docs\自动交接与会话接力-方案-20260920.md`（v19）
//   §4.6 动作 ③：「读会话尾：**另写** `tools\session-tail-for-llm.mjs`（只复用
//                  `dsh-session-tail-dump.mjs` 的多帧 zstd 解帧算法，**输出给模型用**：
//                  不截 200 字符、带事件类型与 turn 边界、**可导出的模块**）」
//   §6.2 采集开销预算：**解帧 I/O ≤2 MB / ≤3 秒**（硬上限，超预算 ⇒ 标 `budgetTruncated`
//                  并由调用方降级为"只标候选、不采集草稿"）
//
// ── 与既有件的关系（**不许混用** · 卡面硬点 2）─────────────────────────────
//   · `tools\dsh-session-tail-dump.mjs` = 排障工具（人看，尾部 N 条事件，字段截 200 字符）
//     ⇒ **本文件只复用它的"多帧 zstd 解帧算法"**（ZSTD_MAGIC 切帧 + `zstdDecompressSync`），
//       不 import 它、不改它（它是 CLI 脚本、没有可导出的解帧函数）。
//   · `board-ops/session-tail.mjs` = 人的排障视图（--grep / --raw）
//     ⇒ **不许改它的 200 字符截断行为**，本文件独立实现"给模型看"的渲染。
//
// ── 本文件的硬性质 ────────────────────────────────────────────────────────
//   · **纯只读**：只读 `session.jsonl.zstd`，不写任何文件、不建锁、不动台账。
//   · **可注入依赖**（home / now / fs 行为经 opts）⇒ 单测可完全隔离、不碰生产路径。
//   · **预算是硬闸**：I/O ≤ maxBytes（默认 2 MB，从**帧边界**回退截取）· 解帧累计 ≤ budgetMs
//     （默认 3000 ms）；任一超限 ⇒ `budgetTruncated=true` + `reason` 里写明是哪一类。
//   · 进程退出**一律 `process.exitCode =`**（Windows 上强退会崩）。
//   · 入口守卫**双方 realpath 后再比**（junction 场景下否则静默退出 0、无输出）。
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// 环境解析（home 口径）唯一真源 —— 不再自带副本
import { resolveDshHome } from './lib/dsh-home.mjs';

export const TAIL_FOR_LLM_VERSION = '0.1.0';

/** zstd 帧魔数（多帧拼接文件里每帧都以它开头 · 与 `dsh-session-tail-dump.mjs` 同款算法）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 默认预算（§6.2：单会话尾部解帧 ≤2 MB / ≤3 秒）。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_BUDGET_MS = 3000;
/** 默认取尾部 **4 个 turn**（够模型写出"现状 / 已完成 / 下一步"）。 */
export const DEFAULT_MAX_TURNS = 4;
/** 单条消息的**字符**上限（**远大于排障工具的 200** —— 这是给模型读的，不是给人扫的）。 */
export const DEFAULT_MAX_CHARS_PER_MSG = 4000;

/** 会话数据根（口径唯一真源 = lib/dsh-home.mjs：$DSH_HOME > 旧私有名 > ~/.dsh）。 */
function resolveHome(opts = {}) {
  return resolveDshHome(opts.home);
}

const truncate = (s, n) => {
  const t = String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n)}…[+${t.length - n} 字]`;
};

/** 文本化任意值（对象 → 紧凑 JSON），供摘要行使用。 */
function brief(v, n) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return truncate(v, n);
  try { return truncate(JSON.stringify(v), n); } catch { return ''; }
}

/**
 * 定位会话日志（`session.jsonl.zstd`）。
 * 匹配口径：目录/文件名**包含** sessionId（与既有排障工具一致，容忍 `sessions/<外键>/<sid>/…` 多级）。
 * 优先 `sessions/`，找不到再 `_archived-sessions/`。
 * @returns {{ok:boolean, file:string|null, searched:string[], reason?:string}}
 */
export function findSessionFile(sessionId, opts = {}) {
  const home = resolveHome(opts);
  const sid = String(sessionId ?? '').trim();
  if (!sid) return { ok: false, file: null, searched: [], reason: 'no-session-id' };
  const roots = opts.roots ?? [path.join(home, 'sessions'), path.join(home, '_archived-sessions')];
  const found = [];
  const walk = (dir, depth = 0) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      if (e.name === 'session.jsonl.zstd' && p.includes(sid)) found.push(p);
    }
  };
  for (const r of roots) walk(r);
  if (!found.length) return { ok: false, file: null, searched: roots, reason: 'session-file-not-found' };
  // 同一 sid 理论上唯一；多命中时取**最后修改**的那份（最新活动）
  let best = found[0]; let bestMt = -1;
  for (const f of found) { try { const m = fs.statSync(f).mtimeMs; if (m > bestMt) { bestMt = m; best = f; } } catch { /* ignore */ } }
  return { ok: true, file: best, searched: roots, matches: found.length };
}

/**
 * 多帧 zstd 解帧（**唯一复用的算法**：切帧 → 逐帧解压 → 按行 JSON 解析）。
 * @param {Buffer} buf
 * @param {{maxBytes?:number, budgetMs?:number, now?:()=>number, stopOnBudget?:boolean, sliceFrom?:number}} [opts]
 * @returns {{records:object[], frames:number, decodedFrames:number, badFrames:number, badLines:number, scannedBytes:number, elapsedMs:number, budgetTruncated:boolean, firstFrameOffset:number}}
 */
export function decodeFrames(buf, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const budgetMs = Number(opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const maxBytes = Number(opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const stopOnBudget = opts.stopOnBudget !== false;

  // ── 预算 ①：I/O 面。文件大于 maxBytes ⇒ 只取**尾部** maxBytes，并回退到帧边界 ──
  //    （从尾部往前找第一个 ZSTD_MAGIC —— 从帧头开始解才解得出；找不到即从切片起点硬解，多半失败 ⇒ badFrames）
  let slice = buf; let sliceOffset = 0; let ioTruncated = false;
  if (buf.length > maxBytes) {
    const guess = buf.length - maxBytes;
    const idx = buf.indexOf(ZSTD_MAGIC, guess);
    const from = idx === -1 ? guess : idx;
    slice = buf.subarray(from);
    sliceOffset = from;
    ioTruncated = true;
  }

  const starts = [];
  for (let i = 0; ;) {
    const idx = slice.indexOf(ZSTD_MAGIC, i);
    if (idx === -1) break;
    starts.push(idx);
    i = idx + 4;
  }

  const records = [];
  let decodedFrames = 0; let badFrames = 0; let badLines = 0;
  let budgetTruncated = false;
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : slice.length;
    let dec;
    try { dec = zstdDecompressSync(slice.subarray(from, to)).toString('utf8'); decodedFrames++; }
    catch { badFrames++; continue; }
    for (const line of dec.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { records.push(JSON.parse(t)); } catch { badLines++; }
    }
    if (stopOnBudget && now() - t0 > budgetMs) { budgetTruncated = true; break; }
  }
  return {
    records, frames: starts.length, decodedFrames, badFrames, badLines,
    scannedBytes: slice.length, sliceFrom: sliceOffset, ioTruncated,
    elapsedMs: now() - t0,
    budgetTruncated: budgetTruncated || ioTruncated,
    firstFrameOffset: starts.length ? sliceOffset + starts[0] : sliceOffset,
  };
}

/** 事件类型分组（渲染时决定"详写 / 只计数"）。 */
export const DETAIL_TYPES = Object.freeze(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end', 'session/title', 'session/end-seed']);

/**
 * 把事件序列渲染成**给模型读**的文本（带事件类型 + turn 边界 + 时间）。
 * @param {object[]} records
 * @param {{maxTurns?:number, maxCharsPerMsg?:number, sessionId?:string, file?:string}} [opts]
 */
export function renderTailForModel(records, opts = {}) {
  const maxTurns = Number(opts.maxTurns ?? DEFAULT_MAX_TURNS);
  const maxChars = Number(opts.maxCharsPerMsg ?? DEFAULT_MAX_CHARS_PER_MSG);
  const recs = Array.isArray(records) ? records : [];

  // ── turn 边界：以 `turn/start` 为界切段（无 turn/start 时整体算一段） ──
  const turnStarts = [];
  for (let i = 0; i < recs.length; i++) if (recs[i]?.type === 'turn/start') turnStarts.push(i);
  const from = turnStarts.length > maxTurns ? turnStarts[turnStarts.length - maxTurns] : 0;
  const picked = recs.slice(from);

  const L = [];
  L.push(`# 会话尾（给模型读 · 不截 200 字符）`);
  L.push('');
  L.push(`- 会话：\`${opts.sessionId ?? '?'}\``);
  L.push(`- 日志：\`${opts.file ?? '?'}\``);
  L.push(`- 事件总数：${recs.length}（本次渲染取尾部 ${picked.length} 条 / 最近 ${Math.min(maxTurns, Math.max(1, turnStarts.length))} 个 turn）`);
  L.push('');
  let turnNo = turnStarts.length > maxTurns ? turnStarts.length - maxTurns + 1 : 1;
  let inTurn = false;
  for (const r of picked) {
    const type = String(r?.type ?? '?');
    const time = typeof r?.time === 'number' ? new Date(r.time).toISOString() : String(r?.time ?? '');
    if (type === 'turn/start') {
      if (inTurn) L.push('');
      L.push(`## turn ${turnNo} · start ${time}`);
      turnNo += 1; inTurn = true;
      continue;
    }
    if (type === 'turn/end') {
      L.push(`- [turn/end] reason=${brief(r?.data?.reason ?? r?.data, 300)}`);
      L.push('');
      inTurn = false;
      continue;
    }
    if (!inTurn) { L.push(`## （turn 边界之前）`); inTurn = true; }
    const seq = String(r?.seq ?? '-');
    if (type === 'user/message') {
      const c = r?.data?.content;
      const txt = Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : (typeof c === 'string' ? c : '');
      L.push(`- [user/message seq=${seq}] ${truncate(txt, maxChars)}`);
    } else if (type === 'assistant/message') {
      const c = r?.data?.content;
      const txt = Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : (typeof c === 'string' ? c : '');
      L.push(`- [assistant/message seq=${seq}] ${truncate(txt, maxChars)}`);
    } else if (type === 'tool/call') {
      const name = r?.data?.name ?? r?.data?.toolName ?? '?';
      const args = r?.data?.arguments ?? r?.data?.args ?? r?.data?.input ?? null;
      L.push(`- [tool/call seq=${seq}] ${name}(${brief(args, Math.min(maxChars, 1200))})`);
    } else if (type === 'tool/result') {
      const out = r?.data?.result ?? r?.data?.output ?? r?.data?.content ?? r?.data;
      L.push(`- [tool/result seq=${seq}] ${brief(out, Math.min(maxChars, 800))}`);
    } else if (type === 'session/title') {
      L.push(`- [session/title seq=${seq}] ${brief(r?.data?.title, 200)}`);
    } else if (type === 'session/end-seed') {
      L.push(`- [session/end-seed seq=${seq}] ${brief(r?.data, 300)}`);
    }
    // 其余类型（如 assistant/chunk 流式碎片）**不逐条渲染**，只在上面的总数里体现
  }
  return L.join('\n');
}

/**
 * 一体化入口：定位 → 解帧 → 渲染。
 * @returns {{ok:boolean, reason:string|null, sessionId:string, file:string|null, text:string,
 *   bytes:{fileBytes:number, scannedBytes:number, textBytes:number},
 *   frames:number, records:number, elapsedMs:number, budgetTruncated:boolean, lastEventAt:string|null, lastEventMs:number|null}}
 */
export function readSessionTail(opts = {}) {
  const t0 = Date.now();
  const sid = String(opts.sessionId ?? '').trim();
  const maxBytes = Number(opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const budgetMs = Number(opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const base = {
    ok: false, reason: null, sessionId: sid, file: null, text: '',
    bytes: { fileBytes: 0, scannedBytes: 0, textBytes: 0 },
    frames: 0, records: 0, elapsedMs: 0, budgetTruncated: false, lastEventAt: null, lastEventMs: null,
  };
  const loc = findSessionFile(sid, opts);
  if (!loc.ok) return { ...base, reason: loc.reason };
  let buf; let fileBytes = 0;
  try { buf = fs.readFileSync(loc.file); fileBytes = buf.length; } catch (e) { return { ...base, file: loc.file, reason: `read-error:${e?.message ?? e}` }; }
  const dec = decodeFrames(buf, { maxBytes, budgetMs, now: opts.now });
  if (!dec.records.length) {
    return { ...base, file: loc.file, bytes: { fileBytes, scannedBytes: dec.scannedBytes, textBytes: 0 }, frames: dec.frames, elapsedMs: Date.now() - t0, budgetTruncated: dec.budgetTruncated, reason: 'no-records' };
  }
  const text = renderTailForModel(dec.records, { maxTurns: opts.maxTurns, maxCharsPerMsg: opts.maxCharsPerMsg, sessionId: sid, file: loc.file });
  // 最后事件时间（epoch ms）—— 阶段 2 的"近 45 分钟无新 turn"**不**用它做判据（判据载体是会话面
  // `items[].updatedAt`，见方案 §4.6 判定③），这里只作**事实档**里给人看的佐证。
  let lastMs = null;
  for (let i = dec.records.length - 1; i >= 0; i--) {
    const t = dec.records[i]?.time;
    if (typeof t === 'number') { lastMs = t; break; }
  }
  const textBytes = Buffer.byteLength(text, 'utf8');
  return {
    ok: true, reason: dec.budgetTruncated ? (dec.ioTruncated ? 'budget-io-truncated' : 'budget-time-truncated') : null,
    sessionId: sid, file: loc.file, text,
    bytes: { fileBytes, scannedBytes: dec.scannedBytes, textBytes },
    frames: dec.frames, records: dec.records.length, elapsedMs: Date.now() - t0,
    budgetTruncated: dec.budgetTruncated,
    lastEventAt: lastMs === null ? null : new Date(lastMs).toISOString(), lastEventMs: lastMs,
    // 可选：把解出来的记录一并交给调用方（默认 false —— 记录可能上万条，用完即弃）
    ...(opts.includeRecords === true ? { _records: dec.records } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI（排障 / 自证用；**纯只读**）
// ═══════════════════════════════════════════════════════════════════════════

/** 入口守卫（**双方 realpath 后再比** —— junction 场景下否则静默退出 0、无输出）。 */
export function isMainEntry(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

const USAGE = [
  'usage:',
  '  node session-tail-for-llm.mjs <会话id> [--turns N] [--max-bytes N] [--budget-ms N] [--home <DSH 根>] [--json]',
  '  # 给模型读的会话尾（只读；I/O ≤2 MB / 解帧 ≤3 s 硬预算；不截 200 字符）',
].join('\n');

export function parseTailArgv(argv) {
  const o = { sid: null, turns: null, maxBytes: null, budgetMs: null, home: null, json: false, help: false };
  const VALUE_FLAGS = { '--turns': 'turns', '--max-bytes': 'maxBytes', '--budget-ms': 'budgetMs', '--home': 'home' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS[a]) { o[VALUE_FLAGS[a]] = argv[++i] ?? null; continue; }
    if (a === '--json') { o.json = true; continue; }
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (a.startsWith('--')) return { error: `unknown arg: ${a}` };
    if (o.sid === null) o.sid = a;
    else return { error: `多余参数: ${a}` };
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseTailArgv(argv);
  if (a.error) { process.stderr.write(a.error + '\n' + USAGE + '\n'); return 2; }
  if (a.help) { console.log(USAGE); return 0; }
  const sid = a.sid;
  if (!sid) { process.stderr.write(USAGE + '\n'); return 2; }
  const r = readSessionTail({
    sessionId: sid,
    maxTurns: a.turns ? Number(a.turns) : undefined,
    maxBytes: a.maxBytes ? Number(a.maxBytes) : undefined,
    budgetMs: a.budgetMs ? Number(a.budgetMs) : undefined,
    home: a.home ?? undefined,
  });
  if (a.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(r.text + '\n');
  return r.ok ? 0 : 1;
}

if (isMainEntry()) {
  try { process.exitCode = main(); } catch (e) { process.stderr.write(`[session-tail-for-llm] 未预期异常：${e?.stack ?? e}\n`); process.exitCode = 1; }
}
