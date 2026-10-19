// archive-inactive-sessions.mjs
// Move inactive (>48h, no unclosed turn) sessions OUT of the .dsh/sessions dir
// into an _archive folder so DSH stops scanning/decoding them (load speed fix).
// NEVER deletes anything — it MOVES whole session dirs (restorable).
// 2026-09-09: 默认跳过「空壳」会话（整份日志里没有任何 user/assistant 消息的会话，
// 例如新建后没发消息就关掉留下的只有会话头的文件）——它们归档进来只会让归档列表
// 混着"看着有内容其实没有"的行。需要旧行为时加 --include-empty。
// Usage:
//   node archive-inactive-sessions.mjs --dry-run   (preview only, move nothing)
//   node archive-inactive-sessions.mjs             (actually move, logs a manifest)
//   node archive-inactive-sessions.mjs --min-size-mb 1   (only archive sessions >=1MB)
//   node archive-inactive-sessions.mjs --include-empty   (也归档空壳，旧行为)
//   node archive-inactive-sessions.mjs --sess-root=<dir> (换扫描根，测试用)
import { readFileSync, statSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
// 本件依赖**可发布**的 RPC 客户端件：宿主凭据由该件经「可选依赖探测（宿主专有凭据件，
// 不发布）+ 显式 / env 注入」取用；本件不静态 import 任何凭据通道件。
import { hostRpc, hostRpcJson } from './lib/dsh-rpc-client.mjs';
// 会话日志文件名判据：**唯一真源**。写死 `session.jsonl.zstd`
// 会让本脚本对换代后的活跃树（0.1.5 起全是 `session.v3.jsonl.zstd`）"一个会话都看不见"。
import { collectSessionFilesByDir, listSessionFilesInDir } from './lib/session-file-name.mjs';
// 元数据库（**唯一读写入口** = 共享件；禁另造第二套读写）：搬移成功后把本批会话写进库
// （归档成功后把本批会话写进元数据库）。
import { upsertMany as metaUpsertMany, normalizeSessionId } from './lib/archive-meta-store.mjs';
import { zstdDecompressSync } from 'node:zlib';
// zstd 多帧拆帧：**本仓 CLI 侧唯一源**（`./lib/zstd-frames.mjs`，严格帧结构解析）。
// 原「魔数搜索 + 游标推进」启发式已删除（弱点：压缩数据里恰好出现 magic 字节会把一帧切成两半）。
import { scanZstdFrames } from './lib/zstd-frames.mjs';
import { join, basename, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
// 环境边界：DSH 数据根一律走统一解析（DSH_HOME 优先；旧私有名 BUTLER_DSH_HOME 仅作
// 兼容读；两者都没设 ⇒ ~/.dsh）。
import { resolveDshHome } from './lib/dsh-home.mjs';

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const INCLUDE_EMPTY = ARGS.includes('--include-empty');
const SESS_ROOT_ARG = ARGS.find((a) => a.startsWith('--sess-root='));
const SESS_ROOT = SESS_ROOT_ARG
  ? SESS_ROOT_ARG.slice('--sess-root='.length)
  : join(resolveDshHome(), 'sessions');
const HOURS = 48;
const INACTIVE_MS = HOURS * 3600 * 1000;
// ---- --synced-only「已同步到副本仓才归档」--------------------------------------
// 判据：① 同步副本仓工作副本里有**字节完全相同**的副本（= 另一台机器拿得到）
//       ② 尾部无未闭合 turn ③ 排除 Host API 报 running 的会话（fail-closed）。
// 动机：只归档「已同步过的」；未同步的会话归档后就再也同步不过去（归档区不随同步），
//       必须留在 sessions 等交接。
const SYNCED_ONLY = ARGS.includes('--synced-only');
const SYNCED_REPO_ARG = ARGS.find((a) => a.startsWith('--synced-repo='));
/** 同步副本仓根（--synced-only 必填；本发行版不内置任何机器特定默认路径）。 */
const SYNCED_REPO = SYNCED_REPO_ARG ? SYNCED_REPO_ARG.slice('--synced-repo='.length) : null;
const MAX_COUNT = (() => {
  const m = ARGS.find((a) => a.startsWith('--max-count='));
  if (!m) return 0;
  const v = parseInt(m.split('=')[1], 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();
const HOST_API = process.env.DSH_HOST_API_URL || 'http://localhost:3080';
const MIN_MB = (() => {
  const m = ARGS.find(a => a.startsWith('--min-size-mb'));
  if (!m) return 0;
  const v = parseFloat(m.split('=')[1]);
  return Number.isFinite(v) ? v : 0;
})();
const now = Date.now();

/**
 * 目录内「任一世代尾部未闭合」= 未闭合（保守口径）。
 * 两代并存时新世代可能只是补写壳（尾部 `session/end-seed`），旧世代尾部才是真回合状态
 * ⇒ 任一未闭合即不搬，避免误搬未闭合会话。
 * @returns {{unclosed:boolean, last:string|null, decodable:boolean}}
 */
function unclosedIn(files) {
  let decodable = false; let lastType = null;
  for (const f of files) {
    const types = tailState(f.file);
    if (types === null) continue;
    decodable = true;
    const last = types.at(-1);
    if (hasUnclosedTurn(types)) return { unclosed: true, last, decodable: true };
    lastType = last;
  }
  return { unclosed: false, last: lastType, decodable };
}

function sha256File(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

/** 副本仓索引：相对**会话目录**路径（/ 分隔）→ 该目录「当前那份」文件。 */
function buildRepoIndex(repoRoot) {
  const map = new Map();
  for (const s of collectSessionFilesByDir(repoRoot)) map.set(relative(repoRoot, s.dir).replace(/\\/g, '/'), s.current);
  return map;
}

/** 当前 running 会话 id 集合（Host API）。失败 → 抛错，调用方 fail-closed。 */
async function fetchRunningSessionIds() {
  // 0.1.5 换线（2026-09-22）：旧点号端点已失效 → 共享适配层（新线 + cookie，旧线自动回落）
  const { status, body: j } = await hostRpc(HOST_API, 'session.list', {}, { timeoutMs: 20_000 });
  if (j?.result === undefined) throw new Error(`session.list HTTP ${status}`);
  const items = j?.result?.value?.items ?? [];
  return new Set(items.filter((x) => x && x.running === true).map((x) => x.sessionId));
}

function tailState(file, nFrames = 8) {
  let buf; try { buf = readFileSync(file); } catch { return null; }
  // 严格帧结构解析（**共享件唯一源**）：只取完整帧；尾部撕裂帧（tornStart）丢弃 —— 残字节一律不当帧解。
  const { frames } = scanZstdFrames(buf);
  if (!frames.length) return null;
  const types = [];
  for (const fr of frames.slice(-nFrames)) {
    let dec; try { dec = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8'); } catch { continue; }
    for (const line of dec.split('\n')) { if (!line.trim()) continue; try { const o = JSON.parse(line); if (o && o.type) types.push(o.type); } catch {} }
  }
  return types;
}
function hasUnclosedTurn(types) {
  if (!types || types.length === 0) return false;
  const last = types.at(-1);
  return last === 'turn/start' || last === 'step/start';
}

/** 全帧解码出事件类型序列（空壳判据用，只对小文件调用）。 */
function allTypes(file) {
  let buf; try { buf = readFileSync(file); } catch { return null; }
  // 严格帧结构解析（**共享件唯一源**）：只取完整帧；尾部撕裂帧丢弃（残字节不当帧解）。
  const { frames } = scanZstdFrames(buf);
  if (!frames.length) return null;
  const types = [];
  for (const fr of frames) {
    let dec; try { dec = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8'); } catch { continue; }
    for (const line of dec.split('\n')) { if (!line.trim()) continue; try { const o = JSON.parse(line); if (o && o.type) types.push(o.type); } catch {} }
  }
  return types;
}

/** 空壳上限：超过这个大小的日志必然有对话内容，不做全解（省成本）。 */
const EMPTY_SCAN_MAX_BYTES = 64 * 1024;
/**
 * 是否「空壳」：整份日志里一条 user/message 或 assistant/message 都没有
 * （典型=新建会话后没发消息就关掉，只剩一行会话头 + 权限/沙箱事件）。
 */
function isEmptyShell(zstdPath, sizeBytes) {
  if (sizeBytes > EMPTY_SCAN_MAX_BYTES) return false;
  const types = allTypes(zstdPath);
  if (types === null) return false;
  return !types.some((t) => t === 'user/message' || t === 'assistant/message');
}

// ── 元数据库条目采集（搬移成功后写入）─────────────────────────────────────────
// 口径对齐共享件 `./lib/archive-meta-store.mjs`（字段名与三态语义写死，**禁另造第二套**）：
//   id / title / cwd / createdAt / turns / lastActiveAt / batch / archivedAt / state / source
//   · `turns` **三态**：>0 真实轮数 / `0` 真实零轮 / **`null` = 未知**（取不到，绝不写 0 冒充）
//   · `title` 取不到写 `null`（≠ 空字符串）；`tokens` 取不到整块省略（不写 0 冒充）
//   · `archivedAt` = 本次搬移时刻（与插件 `collectMetaSnapshot()` 同口径，**不用目录 mtime**）
// 采集时机 = **搬移前**（源目录还在；搬完再采就晚了）；入库时机 = **本批搬移全部结束后一次**
//   （共享件的批量语义：每轮 ≤1 次 RMW）。
// ⚠️ **本函数只读、不写盘、不抛**：库是加速缓存，采集失败只是字段缺，绝不阻断搬移。
// ⚠️ home 与 ARCHIVE_BASE 同源（`resolveDshHome()`）⇒ 被 `DSH_HOME`（旧名 `BUTLER_DSH_HOME` 兼容读）指到
//    夹具时，projcache 与库都自动落在夹具里（沙箱实测判据）。
// 【projcache 读写口径】**分片目录 ∪ 旧单文件**（与归档插件同源）。
//   改动前只读 `<home>/storages/session_projcache.json` ⇒ 0.1.5 分片 home 上恒读到空表
//   ⇒ 每条例目的 `source` 都落 'log-header'（元数据少 title/turns；功能不丢但质量掉）。
import { projcacheSessionsTable } from './lib/projcache-read.mjs';
const PROJCACHE_FILE = join(resolveDshHome(), 'storages', 'session_projcache.json');
const DSH_HOME_FOR_PROJCACHE = resolveDshHome();
let _projSessions;
/** projcache 的会话表（惰性读**一次**；**分片 ∪ 单文件**；读不到/坏了 ⇒ 空表，不抛）。 */
function projcacheSessions() {
  if (_projSessions === undefined) {
    try { _projSessions = projcacheSessionsTable(DSH_HOME_FOR_PROJCACHE) ?? {}; }
    catch { _projSessions = {}; }
  }
  return _projSessions;
}

/** 拆帧 → 逐个**完整帧**的字节切片（消费共享件严格解析；返回形状不变 = Buffer 数组）。 */
function framesOf(file) {
  let buf; try { buf = readFileSync(file); } catch { return []; }
  const { frames } = scanZstdFrames(buf);
  return frames.map((fr) => buf.subarray(fr.start, fr.end)); // 尾部撕裂帧不在其中（残字节不当帧）
}

/** 目录内**内容最全**的日志文本（多世代候选链；zstd 逐帧解 / 明文 jsonl 直读）。 */
function logTextInDir(dir) {
  let best = '';
  for (const f of listSessionFilesInDir(dir)) {
    const chunks = [];
    for (const frame of framesOf(f.file)) {
      try { chunks.push(zstdDecompressSync(frame).toString('utf8')); } catch { /* 容忍坏帧 */ }
    }
    const text = chunks.join('');
    if (text.length > best.length) best = text;
  }
  return best;
}

/**
 * 采集一条待归档会话的条目（`id` 传目录名，裸 uuid 也认 —— 共享件内部归一）。
 * 来源优先级：① projcache（搬移前采集，此时记录可能还在）② 日志全帧（title/turns/cwd/createdAt）。
 */
function collectMetaEntry(id, dir, batch, archivedAt) {
  const numOr = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const norm = normalizeSessionId(id);
  const table = projcacheSessions();
  const rec = (norm ? table[norm] : null) ?? table[id] ?? null;
  const title = rec?.rows?.title?.val;
  const entry = {
    id,
    title: (typeof title === 'string' && title.trim()) ? title.trim() : null,
    cwd: rec?.identity?.cwd ?? null,
    createdAt: numOr(rec?.identity?.createdAt),
    turns: numOr(rec?.rows?.sessionStats?.val?.turns),
    lastActiveAt: numOr(rec?.rows?.sessionListMetadata?.val?.lastPromptAt),
    batch,
    archivedAt,
    state: 'archived',
    source: rec ? 'projcache' : 'log-header',
  };
  const totals = rec?.rows?.tokenUsage?.val?.totals;
  if (totals && typeof totals === 'object') {
    const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const four = {
      uncachedInputTokens: n(totals.uncachedInputTokens), outputTokens: n(totals.outputTokens),
      cacheReadTokens: n(totals.cacheReadTokens), cacheWriteTokens: n(totals.cacheWriteTokens),
    };
    entry.tokens = { ...four, total: four.uncachedInputTokens + four.outputTokens + four.cacheReadTokens + four.cacheWriteTokens };
  }
  // 日志兜底：projcache 已被裁剪/清空（生产现状是 126 B 空壳）⇒ 首帧 `session` 头给 cwd/createdAt，
  // 全帧再生给 title（最后一个 `session/title`）与 turns（`turn/start` 计数）。
  if (entry.cwd === null || entry.createdAt === null || entry.title === null || entry.turns === null) {
    try {
      const text = logTextInDir(dir);
      let titleFromLog = null, turns = 0, events = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== 'object' || !ev.type) continue;
        events += 1;
        if (ev.type === 'session') {
          if (entry.cwd === null && ev.cwd) entry.cwd = ev.cwd;
          if (entry.createdAt === null) entry.createdAt = numOr(ev.createdAt);
        } else if (ev.type === 'session/title') {
          const t = ev.data?.title ?? ev.data?.value ?? ev.title;
          if (typeof t === 'string' && t.trim()) titleFromLog = t.trim();
        } else if (ev.type === 'turn/start') { turns += 1; }
      }
      if (entry.title === null && titleFromLog) entry.title = titleFromLog;
      // 日志**可解**（至少解出 1 个事件）才敢断言轮数：解出 0 个 turn/start = 真实零轮（三态里的 `0`），
      // 一句都解不出来 = **未知**（保持 null，绝不写 0 冒充）。
      if (entry.turns === null && events > 0) entry.turns = turns;
      if (!rec && (titleFromLog || events > 0)) entry.source = 'log-full';
    } catch { /* 采集失败只丢字段，不阻断搬移 */ }
  }
  return entry;
}

console.log(`=== 归档扫描 ===`);
console.log(`会话根: ${SESS_ROOT}`);
if (SYNCED_ONLY) {
  console.log(`条件: 副本仓已有字节相同副本（已同步） 且 尾部无未闭合turn 且 非 running${MAX_COUNT ? ` 且 仅取最大的 ${MAX_COUNT} 个` : ''}`);
  console.log(`副本仓对照根: ${SYNCED_REPO ?? '(未提供)'}`);
} else {
  console.log(`条件: >${HOURS}h 未活跃 且 尾部无未闭合turn${MIN_MB ? ` 且 >=${MIN_MB}MB` : ''}`);
}
console.log(`模式: ${DRY ? 'DRY-RUN（预览，不移动）' : '实际移动'}`);

// Collect candidate SESSION DIRS (认全世代；每个会话目录取「当前那份」做判据，移动时带全部世代)
const allZstd = collectSessionFilesByDir(SESS_ROOT);
const candidateDirs = [];
const skippedEmpty = [];
const skippedNotSynced = [];
let repoIndex = null;
let runningIds = null;
let hardStop = false;
if (SYNCED_ONLY) {
  if (!SYNCED_REPO) {
    hardStop = true;
    console.error('!! --synced-only 需要 --synced-repo=<dir>（同步副本仓的 sessions 根）→ fail-closed：本次一个都不归档。');
    console.error('   本发行版不内置任何机器特定默认路径，请显式传入。');
  } else {
    repoIndex = buildRepoIndex(SYNCED_REPO);
    try {
      runningIds = await fetchRunningSessionIds();
      console.log(`Host API running 会话: ${runningIds.size} 个（已从候选里排除）`);
    } catch (e) {
      hardStop = true;
      console.error(`!! 无法从 Host API 取 running 会话（${e.message}）→ fail-closed：本次一个都不归档。`);
      console.error('   确认 DSH 在跑（3080 端口）后重试。');
    }
  }
}
for (const sess of allZstd) {
  if (hardStop) break;
  const dir = sess.dir;
  const currentPath = sess.current;
  const st = statSync(currentPath);
  const mb = st.size / 1048576;
  const ageD = (now - st.mtimeMs) / 86400000;
  if (mb < MIN_MB) continue;
  if (SYNCED_ONLY) {
    // ① 正在跑的会话绝不搬（看板卡执行会话被搬走 → runner 找不到会话）
    if (runningIds.has(basename(dir))) { skippedNotSynced.push({ dir, mb, why: 'running' }); continue; }
    // ② 副本仓必须有字节完全相同的副本（按**会话目录**对齐，跨世代也能认出同一会话）；
    //    否则=未过河 → 留着等交接
    const rel = relative(SESS_ROOT, dir).replace(/\\/g, '/');
    const rp = repoIndex.get(rel);
    if (!rp) { skippedNotSynced.push({ dir, mb, why: '未同步(仓里没有)' }); continue; }
    if (statSync(rp).size !== st.size || sha256File(rp) !== sha256File(currentPath)) {
      skippedNotSynced.push({ dir, mb, why: '未同步(仓里是旧版)' });
      continue;
    }
  } else {
    const inactive = (now - st.mtimeMs) >= INACTIVE_MS;
    if (!inactive) continue;
  }
  const tail = unclosedIn(sess.files);
  if (tail.unclosed) continue; // active/unclosed, skip（任一世代未闭合即不搬）
  // 空壳判据认全世代：全部世代都没有 user/assistant 消息才算空壳（任一世代有对话内容就不是）
  const shell = sess.files.every((f) => isEmptyShell(f.file, f.bytes));
  if (!INCLUDE_EMPTY && shell) { skippedEmpty.push({ dir, mb, ageD }); continue; }
  candidateDirs.push({ dir, currentPath, mb, ageD });
}

candidateDirs.sort((a, b) => b.mb - a.mb);
const matchedCount = candidateDirs.length;
if (MAX_COUNT && candidateDirs.length > MAX_COUNT) candidateDirs.length = MAX_COUNT;
const totalMB = candidateDirs.reduce((s, x) => s + x.mb, 0);
console.log(`\n待归档会话目录: ${candidateDirs.length} 个，共 ${totalMB.toFixed(1)} MB` +
  (MAX_COUNT && matchedCount > candidateDirs.length ? `（符合条件共 ${matchedCount} 个，按 --max-count=${MAX_COUNT} 只取最大的 ${MAX_COUNT} 个）` : ''));
if (SYNCED_ONLY && skippedNotSynced.length > 0) {
  const byWhy = {};
  for (const s of skippedNotSynced) byWhy[s.why] = (byWhy[s.why] || 0) + 1;
  console.log(`保留在 sessions（等交接）: ${skippedNotSynced.length} 个 — ${JSON.stringify(byWhy)}`);
  for (const s of skippedNotSynced.slice(0, 10)) console.log(`  [留] ${s.why} · ${basename(s.dir)} [${s.mb.toFixed(2)}MB]`);
  if (skippedNotSynced.length > 10) console.log(`  ...另有 ${skippedNotSynced.length - 10} 个`);
}

// show top 15
for (const c of candidateDirs.slice(0, 15)) {
  console.log(`  [${c.mb.toFixed(2)}MB ${c.ageD.toFixed(1)}d] ${basename(c.dir)}`);
}

if (skippedEmpty.length > 0) {
  console.log(`\n跳过空壳会话（整份日志无任何对话消息，默认不归档）: ${skippedEmpty.length} 个`);
  for (const c of skippedEmpty.slice(0, 15)) {
    console.log(`  [${(c.mb * 1024).toFixed(0)}KB ${c.ageD.toFixed(1)}d] ${basename(c.dir)}`);
  }
  if (skippedEmpty.length > 15) console.log(`  ...另有 ${skippedEmpty.length - 15} 个`);
  console.log('  说明：这些是「新建后没发消息」留下的空壳，体积极小、留在 sessions 不影响加载；要一起归档请加 --include-empty。');
}

if (DRY || hardStop) {
  console.log(`\n${hardStop ? 'fail-closed：' : 'DRY-RUN '}未移动任何文件。`);
  // 本脚本可能已发过 fetch（Host API）——用 exitCode 自然退出；强退会概率性触发
  // libuv 断言崩溃（nodejs/node#56645），故不调用 process.exit()。
  process.exitCode = hardStop ? 3 : 0;
} else {

// Archive target: <DSH_HOME>/_archived-sessions — LOCAL, OUTSIDE the
// <DSH_HOME>/sessions dir that DSH scans — that is what makes load faster.
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const ARCHIVE_BASE = join(resolveDshHome(), '_archived-sessions');
const ARCHIVE_ROOT = join(ARCHIVE_BASE, STAMP);
mkdirSync(ARCHIVE_ROOT, { recursive: true });

const manifest = [];
let moved = 0, skipped = 0;
// 元数据库：本批**搬移成功**的会话快照 —— 循环内只压内存，轮末一次写库
const archivedAt = Date.now();
const metaSnapshots = [];
for (const c of candidateDirs) {
  const dest = join(ARCHIVE_ROOT, basename(c.dir));
  try {
    // 元数据快照必须在**搬移前**采集（源目录马上要被删）——采集本身绝不阻断搬移
    let metaSnapshot = null;
    try { metaSnapshot = collectMetaEntry(basename(c.dir), c.dir, STAMP, archivedAt); } catch { metaSnapshot = null; }
    // Two-phase move (rename fails across junction/volume on Windows):
    // 1) recursive copy to dest, 2) verify **每个世代逐文件**字节一致, 3) remove source.
    cpSync(c.dir, dest, { recursive: true, force: true });
    const srcFiles = listSessionFilesInDir(c.dir);
    if (!srcFiles.length) throw new Error('source dir has no session file');
    let anyDecodable = false;
    for (const f of srcFiles) {
      const relName = relative(c.dir, f.file);
      const dstFile = join(dest, relName);
      if (!existsSync(dstFile)) throw new Error(`dest missing ${relName}`);
      const srcBytes = statSync(f.file).size;
      const dstBytes = statSync(dstFile).size;
      if (srcBytes !== dstBytes) throw new Error(`size mismatch after copy ${relName} (${srcBytes} vs ${dstBytes})`);
      if (sha256File(f.file) !== sha256File(dstFile)) throw new Error(`sha mismatch after copy ${relName}`);
      // 既有语义保留（不可解的日志不据以删源目录）：源可解的世代，复制产物也必须可解
      if (tailState(f.file) !== null) {
        anyDecodable = true;
        if (tailState(dstFile) === null) throw new Error('dest file not decodable after copy');
      }
    }
    if (!anyDecodable) throw new Error('dest file not decodable after copy');
    rmSync(c.dir, { recursive: true, force: true });
    manifest.push({ from: c.dir, to: dest, mb: c.mb, ageD: c.ageD });
    // **文件已成功落到归档区**（逐世代校验通过 + 源已删）才收快照 ⇒ 跳过/失败的那条不入库
    if (metaSnapshot) metaSnapshots.push(metaSnapshot);
    moved++;
  } catch (e) {
    skipped++;
    console.log(`  SKIP (move fail): ${basename(c.dir)} — ${e.message}`);
  }
}
console.log(`\n已归档: ${moved} 个 → ${ARCHIVE_ROOT}`);
console.log(`跳过(移动失败): ${skipped} 个`);

// Write manifest for restore reference
const manifestFile = join(ARCHIVE_ROOT, 'manifest.json');
writeFileSync(manifestFile, JSON.stringify([...manifest], null, 2), 'utf8');
console.log(`\n清单已写入: ${manifestFile}`);
console.log(`合计移动: ${moved} 个会话目录，${(manifest.reduce((s,x)=>s+x.mb,0)).toFixed(1)} MB`);
if (skippedEmpty.length > 0) console.log(`另有 ${skippedEmpty.length} 个空壳会话按默认策略留在 sessions（未归档）。`);

// ── 元数据库接线（搬移成功后才写）───────────────────────────────────────────
//  判据：**只有真搬移成功**（归档区已落文件、源目录已删）的会话才入库；跳过/失败不写。
//  `--dry-run` 与 fail-closed（hardStop）在上一分支就结束了，**永不进这里** ⇒ dry-run 零写库。
//  fail-soft：写库失败只打一行 warning，**不改搬移结果、不置非零退出码**（旁路失败不拖垮归档）。
//  ⚠️ **不传 `counters`**：写失败计数由宿主归档插件自己持有（本脚本无权代管），
//     透传会把它的 `writeFailedStreak` 抹成 0；不传则共享件按 `before.state` 原样保留。
if (metaSnapshots.length > 0) {
  try {
    const w = metaUpsertMany(ARCHIVE_BASE, metaSnapshots);
    if (w.ok) {
      console.log(`元数据库: 写入 ${w.written} 条（新建 ${w.created} / 更新 ${w.updated}` +
        `${w.skipped ? ` / 跳过非 id 名 ${w.skipped}` : ''}${w.unchanged ? ' · 幂等无变化' : ''}）`);
    } else {
      console.warn(`[warning] 元数据库写入失败（${w.reason}${w.detail ? ': ' + w.detail : ''}）` +
        `—— **不影响本次搬移结果**；面板元数据将回落到 projcache/日志（读侧惰性补写兜底）。`);
    }
  } catch (e) {
    console.warn(`[warning] 元数据库写入异常（${e?.message ?? e}）—— 不影响本次搬移结果。`);
  }
}
}
