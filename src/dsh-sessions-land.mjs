#!/usr/bin/env node
// ============================================================================
// DSH / tools/dsh-sessions-land.mjs —— 会话落地器（唯一权威入口，2026-09-12）
//
// 定位：把仓2（dsh-sessions）里「本机缺」的会话落到本机 ~/.dsh/sessions。
//   被两个入口调用：
//     · handoff.mjs 的 A5 段（接机）
//     · dsh-sync-all.ps1 的 -Pull 步（开工同步）
//
// 边界（写死的 Non-goals）：
//   · 不重写 PullMerge —— 判据（本机已有 = sessions ∪ _archived-sessions，按归一 id）的
//     唯一权威实现在 dsh-backup-sessions.ps1，本文件只「调用 + 校验 + 记账」。
//   · 不写 _archived-sessions（只读判据）。
//   · 不删任何会话（只增）。
//
// 为什么需要本文件（2026-09-12 实测教训）：
//   ① dsh-backup-sessions.ps1 对 git pull 失败是 `Write-Warn2 ... ; return`（不 throw），
//      脚本无显式退出码 → **失败也是 rc=0**。故「只看退出码」的判定形同虚设 → 三判据并联。
//   ② 仓2 是 git-crypt 加密仓；工作副本处于锁定态时壳里是密文，PullMerge 会把密文
//      当会话拷进生产目录，且「只补缺不覆盖」→ 损坏副本永不会被修（不可逆）→ 解锁前置。
//   ③ dsh-backup-sessions.ps1 用 `git pull --no-rebase`（分叉时会造 merge commit）→ non-ff 检测。
//
// 用法：
//   node dsh-sessions-land.mjs [--json] [--dry-run] [--verbose] [--no-skip]
//     [--repo <dir>] [--sessions-dir <dir>] [--archive-dir <dir>] [--ps <script>] [--timeout-ms <n>]
//     [--state-file <path>] [--max-age-ms <n>]
//   ⚠️ `--repo` 与 `--ps` **必须指定**（或走 $DSH_SESSIONS_REPO / $DSH_SESSIONS_LAND_PS）：
//     本发行版不内置任何本机路径，缺参数时 rc=2 直接中止（绝不猜一个磁盘路径）。
//
// 退出码：0 ok ／ 4 repo-not-unlocked ／ 5 degraded-pull ／ 6 output-unparsed
//         7 non-ff-pull ／ 8 spawn-failed|timeout ／ 9 repo-busy ／ 2 用法错误
//   ⚠️ 退出码只作诊断；调用方一律以 stdout 的 JSON（--json）或末行结论为准。
//
// 2026-09-17（看板卡 A2 · D4）：新增「上次成功且仓2 HEAD 未变则跳过」判据
//   （2026-09-12 方案 docs\接机会话落地A5-方案-20260912.md §8-D4 拍板采纳、当时未做）。
//   判据本身是**纯函数**（tools/lib/sessions-land-skip.mjs，可单测可核对）；本文件只负责
//   取输入（仓 HEAD / 本机会话数 / 上次状态）与落状态；任何判不出 ⇒ 不跳过（fail-safe）。
//   --no-skip 强制不跳过；--state-file 注入状态文件（测试隔离用）。
//
// 2026-09-24（卡「三机同步步A-V3代际适配」）：会话日志名换代 —— 主包 0.1.5 起
//   `session.jsonl.zstd` → `session.v3.jsonl.zstd`。本文件两处读取侧判据原来是**精确名比较** ⇒
//   countLocalSessions() 恒 0（D4 跳过判据的本机会话数、dry-run 预览数字全错），
//   probeRepoCipher() 也取不到样本（恒 'no-sample'）。
//   现口径 = tools\lib\session-file-name.mjs（**认全世代**：旧名 + v3 名）；写入侧不变。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 2026-09-14 环境边界：默认 sessions/_archived-sessions 根走统一解析
// （$DSH_HOME > 旧私有名 BUTLER_DSH_HOME > ~/.dsh）；显式 env/参数优先。
import { resolveDshHome } from './lib/dsh-home.mjs';
// 2026-09-17（卡 A2 · D4）：跳过判据（纯函数）+ 状态读写
import {
  shouldSkipLanding, readSkipState, writeSkipState, makeSkipState,
  resolveSkipStatePath, DEFAULT_MAX_AGE_MS,
} from './lib/sessions-land-skip.mjs';
// 会话文件名判据真源（2026-09-24 卡「三机同步步A-V3代际适配」）——读取侧认全世代
import { isSessionFileName, pickSessionFileInDir } from './lib/session-file-name.mjs';

export const LAND_VERSION = '1.2.0';

const HOME = resolveDshHome();

/**
 * 路径均用绝对路径常量（工作区树里多为链接目录，绝不用 __dirname/import.meta.url 拼相对路径）。
 * ⚠️ `repo` / `ps` **本发行版不内置默认值** —— 必须用 --repo / --ps（或对应的环境变量）指定；
 *    缺参数时 land() 直接以 rc=2 中止（明确报错，绝不猜一个磁盘路径）。
 */
export const DEFAULTS = {
  repo: process.env.DSH_SESSIONS_REPO || '',
  sessionsDir: process.env.DSH_SESSIONS_DIR || path.join(HOME, 'sessions'),
  archiveDir: process.env.DSH_ARCHIVE_DIR || path.join(HOME, '_archived-sessions'),
  ps: process.env.DSH_SESSIONS_LAND_PS || '',
  timeoutMs: 120_000,
  // D4 跳过判据：状态文件（可注入；默认 <DSH_HOME>/sessions-land.json，旧名兼容读）与新鲜度上限
  stateFile: resolveSkipStatePath(),
  maxAgeMs: DEFAULT_MAX_AGE_MS,
};

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GITCRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);

/** 已知「被降级成 warn」的输出串（出现即视为失败，不许只靠正则 miss 兜）。 */
export const DEGRADED_MARKERS = [
  'git pull failed',
  'no upstream set',
  'repo sessions dir not found',
  'sessions dir not found',
];

/** merged/kept/skipped 解析：取**最后一次**匹配（容忍 \r 覆盖式进度行与重复输出）。 */
export function parseCounts(stdout = '') {
  const re = /merged (\d+) new session\(s\); kept (\d+) existing; skipped (\d+) archived-only/g;
  let m = null;
  let last = null;
  while ((m = re.exec(stdout)) !== null) last = m;
  if (!last) return null;
  return { mergedCount: Number(last[1]), keptCount: Number(last[2]), skippedArchivedCount: Number(last[3]) };
}

/** 输出里是否出现降级串。 */
export function findDegradedMarker(stdout = '') {
  const s = String(stdout);
  for (const marker of DEGRADED_MARKERS) if (s.includes(marker)) return marker;
  return null;
}

/** 明文/密文判定（只读文件头，零依赖）。 */
export function probeCipher(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (n >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) return 'plain';
    if (n >= 10 && buf.subarray(0, 10).equals(GITCRYPT_MAGIC)) return 'cipher';
    return 'unknown';
  } catch {
    return 'unreadable';
  }
}

/** 取仓里第一个会话文件的密文态。仓里没有会话文件 → 'no-sample'（不阻断）。 */
export function probeRepoCipher(repoDir) {
  const root = path.join(repoDir, 'sessions');
  let groups;
  try { groups = fs.readdirSync(root, { withFileTypes: true }); } catch { return 'no-sample'; }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const gdir = path.join(root, g.name);
    let sessions;
    try { sessions = fs.readdirSync(gdir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      // 2026-09-24：用 pickSessionFileInDir（认全世代；两代并存取 mtime 最新那份），
      // 原来写死 'session.jsonl.zstd' ⇒ v3 世代恒取不到样本。
      const f = pickSessionFileInDir(path.join(gdir, s.name));
      if (f) return probeCipher(f);
    }
  }
  return 'no-sample';
}

/**
 * 本机落盘会话数（与 dsh-backup-sessions.ps1 的 Count-Sessions 同口径：数会话文件）。
 * 2026-09-24：判据改 isSessionFileName()（**认全世代**：旧名 + v3 名）——
 *   原来精确比较 'session.jsonl.zstd' ⇒ 0.1.5 起的 v3 世代恒 0。
 */
export function countLocalSessions(dir) {
  let n = 0;
  const walk = (d, depth = 0) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else if (isSessionFileName(e.name)) n++;
    }
  };
  walk(dir);
  return n;
}

/** 三判据 + non-ff 判定（纯函数，供单测）。 */
export function judgeResult(input) {
  const {
    status, timeoutHit = false, stdout = '', stderr = '',
    headBefore = null, headAfter = null, localBefore = null, localAfter = null,
    mergeCommitSeen = false, ancestorOk = null,
  } = input;
  const degraded = findDegradedMarker(stdout);
  const counts = parseCounts(stdout);
  const headMoved = Boolean(headBefore && headAfter && headBefore !== headAfter);
  const localMoved = localBefore !== null && localAfter !== null && localBefore !== localAfter;
  // 'Merge made by' 是 git merge 的固定输出串；纯函数自己识别一份，避免调用方漏传标志
  //（2026-09-12 单测实证：judgeResult 直接调用时 mergeCommitSeen 恒 undefined）。
  const merged = mergeCommitSeen || /Merge made by/i.test(String(stdout));

  if (merged || ancestorOk === false) {
    return { ok: false, reason: 'non-ff-pull', exit: 7, counts, headMoved, localMoved };
  }
  if (timeoutHit || status === null) {
    return { ok: false, reason: 'timeout', exit: 8, counts, headMoved, localMoved };
  }
  if (typeof status !== 'number' || status !== 0) {
    return { ok: false, reason: `script-exit-${status}`, exit: 8, counts, headMoved, localMoved };
  }
  if (degraded) {
    return { ok: false, reason: `degraded-pull:${degraded}`, exit: 5, counts, headMoved, localMoved };
  }
  if (!counts) {
    return { ok: false, reason: 'output-unparsed', exit: 6, counts: null, headMoved, localMoved };
  }
  return { ok: true, reason: null, exit: 0, counts, headMoved, localMoved };
}

// ---------------------------------------------------------------- 执行

function sh(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? '').toString(), err: (r.stderr ?? '').toString(), status: r.status, error: r.error ? String(r.error.message ?? r.error) : null };
}

export function run(argv = process.argv.slice(2)) {
  const o = { json: false, dryRun: false, verbose: false, noSkip: false, repo: DEFAULTS.repo, sessionsDir: DEFAULTS.sessionsDir, archiveDir: DEFAULTS.archiveDir, ps: DEFAULTS.ps, timeoutMs: DEFAULTS.timeoutMs, stateFile: DEFAULTS.stateFile, maxAgeMs: DEFAULTS.maxAgeMs };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--no-skip') o.noSkip = true;
    else if (a === '--repo') o.repo = argv[++i] ?? o.repo;
    else if (a === '--sessions-dir') o.sessionsDir = argv[++i] ?? o.sessionsDir;
    else if (a === '--archive-dir') o.archiveDir = argv[++i] ?? o.archiveDir;
    else if (a === '--ps') o.ps = argv[++i] ?? o.ps;
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i] ?? o.timeoutMs);
    else if (a === '--state-file') o.stateFile = argv[++i] ?? o.stateFile;
    else if (a === '--max-age-ms') o.maxAgeMs = Number(argv[++i] ?? o.maxAgeMs);
    else if (a === '--help' || a === '-h') { usage(); return 0; }
    else { process.stderr.write(`unknown arg: ${a}\n`); usage(); return 2; }
  }
  return land(o);
}

function emit(o, payload, humanLine) {
  if (o.json) process.stdout.write('---JSON---\n' + JSON.stringify(payload, null, 2) + '\n');
  else process.stdout.write(humanLine + '\n');
  return payload.exit;
}

export function land(o) {
  const startedMs = Date.now();
  const base = {
    version: LAND_VERSION, ok: false, reason: null, skipped: false, skipDecision: null,
    mergedCount: 0, keptCount: 0, skippedArchivedCount: 0,
    repoHeadBefore: null, repoHeadAfter: null,
    localBefore: null, localAfter: null,
    cipherProbe: null, skipStateWritten: null, exit: 0, durationMs: 0,
  };

  if (!o.repo || !o.ps) {
    base.exit = 2; base.reason = !o.repo ? 'repo-not-configured' : 'ps-not-configured';
    base.durationMs = Date.now() - startedMs;
    return emit(o, base, 'A5 会话落地：中止（未配置会话仓目录 / 落地脚本 —— 用 --repo、--ps 或'
      + '环境变量指定；本发行版不内置任何本机路径）');
  }

  if (!fs.existsSync(o.ps)) {
    base.exit = 8; base.reason = 'ps-script-missing'; base.durationMs = Date.now() - startedMs;
    return emit(o, base, `A5 会话落地：跳过（脚本缺失 ${o.ps}）`);
  }

  // ① 仓忙（异源写者：dsh-sync-all.ps1 -Push 的采集 / 其它 git 进程）
  if (fs.existsSync(path.join(o.repo, '.git', 'index.lock'))) {
    base.exit = 9; base.reason = 'repo-busy'; base.durationMs = Date.now() - startedMs;
    return emit(o, base, 'A5 会话落地：跳过（仓2 正被其它进程写入 index.lock）');
  }

  // ② 解锁前置：密文绝不落地（不可逆）
  const cipher = probeRepoCipher(o.repo);
  base.cipherProbe = cipher;
  if (cipher === 'cipher') {
    base.exit = 4; base.reason = 'repo-not-unlocked'; base.durationMs = Date.now() - startedMs;
    return emit(o, base, 'A5 会话落地：拒绝（仓2 工作副本未解锁 = 密文；请先 git-crypt unlock，绝不拷密文进生产）');
  }

  base.localBefore = countLocalSessions(o.sessionsDir);
  const headBefore = headOf(o.repo);
  base.repoHeadBefore = headBefore;

  if (o.dryRun) {
    base.ok = true; base.reason = 'dry-run'; base.localAfter = base.localBefore; base.repoHeadAfter = headBefore;
    base.durationMs = Date.now() - startedMs;
    return emit(o, base, `A5 会话落地：dry-run（将调用 ${path.basename(o.ps)} -Pull；本机现有 ${base.localBefore} 个会话，仓密文态=${cipher}）`);
  }

  // ③ D4 跳过判据（方案 §8-D4「上次成功且仓2 HEAD 未变则跳过」；省掉一次 git pull 的网络往返）
  //    判据 = lib/sessions-land-skip.mjs 的纯函数（不 spawn、不读盘、只吃这里取到的输入）；
  //    fail-safe：状态读不到/判不出/本机会话数减少 → 一律不跳过。dry-run 绝不写状态（上面已 return）。
  const skipStateBefore = readSkipState(o.stateFile);
  const decision = shouldSkipLanding({
    state: skipStateBefore, repoHead: headBefore, localCount: base.localBefore,
    now: Date.now(), maxAgeMs: o.maxAgeMs, enabled: !o.noSkip,
  });
  base.skipDecision = decision.reason;
  if (decision.skip) {
    base.ok = true; base.skipped = true; base.reason = 'skipped-unchanged';
    base.repoHeadAfter = headBefore; base.localAfter = base.localBefore;
    base.durationMs = Date.now() - startedMs;
    return emit(o, base, `A5 会话落地：跳过（${decision.reason}；上次已成功落地且仓2 未动，省一次 git pull）`);
  }

  const args = ['-NoProfile', '-File', o.ps, '-Pull'];
  if (o.sessionsDir !== DEFAULTS.sessionsDir) args.push('-SessionsDir', o.sessionsDir);
  if (o.archiveDir !== DEFAULTS.archiveDir) args.push('-ArchiveDir', o.archiveDir);
  const r = sh('pwsh', args, o.timeoutMs);
  const stdout = r.out + (r.err ? '\n' + r.err : '');
  const timeoutHit = Boolean(r.error && /timed? ?out|ETIMEDOUT/i.test(r.error));

  const headAfter = headOf(o.repo);
  const localAfter = countLocalSessions(o.sessionsDir);
  base.repoHeadAfter = headAfter;
  base.localAfter = localAfter;

  let ancestorOk = null;
  if (headBefore && headAfter && headBefore !== headAfter) {
    const a = sh('git', ['-C', o.repo, 'merge-base', '--is-ancestor', headBefore, headAfter], 30_000);
    ancestorOk = a.ok;
  }
  const mergeCommitSeen = /Merge made by/i.test(stdout);

  const verdict = judgeResult({
    status: timeoutHit ? null : r.status, timeoutHit, stdout,
    headBefore, headAfter, localBefore: base.localBefore, localAfter, mergeCommitSeen, ancestorOk,
  });

  base.ok = verdict.ok;
  base.reason = verdict.reason;
  base.exit = verdict.exit;
  if (verdict.counts) {
    base.mergedCount = verdict.counts.mergedCount;
    base.keptCount = verdict.counts.keptCount;
    base.skippedArchivedCount = verdict.counts.skippedArchivedCount;
  }
  if (o.verbose && !verdict.ok) {
    base.tail = stdout.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
  }
  base.durationMs = Date.now() - startedMs;

  // ③ 落状态（D4）：成功 ⇒ 记 ok+仓 HEAD+本机会话数；失败 ⇒ 记 ok:false（任何失败都不许让"下次跳过"成立）。
  //    状态写不进去**不影响本次结论**（writeSkipState 永不抛；写失败只记 notWritten）。
  const stateObj = verdict.ok
    ? makeSkipState({ ok: true, repoHead: headAfter ?? headBefore, localCount: base.localAfter, mergedCount: base.mergedCount, host: process.env.COMPUTERNAME ?? null })
    : makeSkipState({ ok: false, repoHead: headAfter ?? headBefore, localCount: base.localAfter, host: process.env.COMPUTERNAME ?? null, reason: verdict.reason });
  const wrote = writeSkipState(o.stateFile, stateObj);
  base.skipStateWritten = wrote.ok;

  const human = verdict.ok
    ? `A5 会话落地：merged ${base.mergedCount} / kept ${base.keptCount} / skipped-archived ${base.skippedArchivedCount}（${base.durationMs}ms）`
    : `A5 会话落地：未完成（${base.reason}；本机 ${base.localBefore}→${base.localAfter}，仓 HEAD ${String(headBefore).slice(0, 8)}→${String(headAfter).slice(0, 8)}）`;
  return emit(o, base, human);
}

function headOf(repo) {
  const r = sh('git', ['-C', repo, 'rev-parse', 'HEAD'], 30_000);
  return r.ok ? r.out.trim() : null;
}

function usage() {
  process.stdout.write([
    'dsh-sessions-land —— 会话落地器（仓2 → 本机 ~/.dsh/sessions，只补缺）',
    '',
    '  node dsh-sessions-land.mjs [--json] [--dry-run] [--verbose] [--no-skip]',
    '    [--repo <dir>] [--sessions-dir <dir>] [--archive-dir <dir>] [--ps <script>] [--timeout-ms <n>]',
    '    [--state-file <path>] [--max-age-ms <n>]',
    '',
    '  D4 跳过判据：上次成功 + 仓2 HEAD 未变 + 本机会话数未减 + 状态未过期 → 跳过（--no-skip 强制不跳）',
    '  退出码：0 ok | 4 未解锁 | 5 降级 | 6 输出不可解析 | 7 non-ff | 8 超时/脚本失败 | 9 仓忙',
  ].join('\n') + '\n');
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  try {
    process.exit(run());
  } catch (e) {
    process.stderr.write(`\n会话落地器异常：${e?.stack ?? e}\n`);
    process.exit(8);
  }
}
