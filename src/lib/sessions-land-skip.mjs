// sessions-land-skip.mjs —— 会话落地「跳过判据」（纯函数 + 状态文件原子读写）
//
// 来源：docs\接机会话落地A5-方案-20260912.md §8-D4
//   「上次成功且仓2 HEAD 未变则跳过」（省掉一次 A5 全流程；实测收益 ≈7s，几乎全是 git pull 的网络往返）。
//   2026-09-12 当时未做，理由写的是「要么新增一个状态文件（须按 P3 契约登记 state-files.mjs）、
//   要么在 node 侧重算 id 集合（造第二份真相）」→ 本卡取**状态文件**路线，并把**判据抽成纯函数**，
//   便于人核对与单测（不 spawn 子进程、不读盘、不看时间以外的一切）。
//
// 定位（写死的边界）：
//   · 本模块只做**判定 + 状态读写**，不执行落地、不碰 sessions 目录、不碰 git。
//   · 判据 fail-safe：任何一项判不出来（状态缺失/损坏/时钟倒退/本机数未知）→ **不跳过**（宁可多跑一次）。
//   · 自愈条件：本机会话数 < 上次记录数（本机删过会话）→ 不跳过（否则"删了永远补不回来"）。
//   · 状态文件路径**可注入**：测试必须隔离生产路径（persona 铁律：测试/探针不得写生产输出位置）。
//
// 状态文件：`<DSH_HOME>/sessions-land.json`
//   ⚠️ 旧名 `butler-sessions-land.json` 保留**一次性兼容读**（读旧、写新；
//     见下方 resolveSkipStatePath —— 新名不存在而旧名存在时继续读旧文件，不报错、不迁移、不删除）。

import fs from 'node:fs';
import path from 'node:path';

import { resolveDshHome } from './dsh-home.mjs';

/** 状态文件 schema 版本（值变了 = 老状态一律不认，退回"不跳过"）。 */
export const SKIP_STATE_VERSION = 1;

/** 状态最多"新鲜"多久（默认 6h）：太久没落地 → 不跳过（防"上次 ok 之后本机又删了会话却跳过"）。 */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** 状态文件名（放在 DSH_HOME 下）。 */
export const SKIP_STATE_NAME = 'sessions-land.json';

/** 旧版私有文件名 —— 只作**兼容读**（读旧、写新；旧文件在用时不要删它）。 */
export const SKIP_STATE_NAME_LEGACY = 'butler-sessions-land.json';

/**
 * 默认状态文件绝对路径（可用参数/env 覆盖；env：DSH_SESSIONS_LAND_STATE）。
 * 兼容迁移口径：**新名优先；新名不存在而旧名存在 => 继续读旧文件**（不报错、不迁移、不删除）。
 * 下一次写入就写新名（调用方写的是本函数返回的路径 => 首次写入后即自动切到新名）。
 * ⚠️ resolveDshHome 在**无参**时才回落 env（DSH_HOME > 旧私有名 > ~/.dsh）——
 *     传 env 对象进去会被当成"显式 home 字符串"，故这里不传参。
 */
export function resolveSkipStatePath(env = process.env) {
  const explicit = env?.DSH_SESSIONS_LAND_STATE;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  const home = resolveDshHome();
  const current = path.join(home, SKIP_STATE_NAME);
  const legacy = path.join(home, SKIP_STATE_NAME_LEGACY);
  try {
    if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  } catch { /* 探测失败 => 按新名处理（fail-safe：读不到状态只是"不跳过"） */ }
  return current;
}

/** 该路径是不是旧版状态文件（调用方可据此提示使用者"本次读的是旧名文件"）。 */
export function isLegacySkipStatePath(file) {
  return !!file && path.basename(String(file)) === SKIP_STATE_NAME_LEGACY;
}

/**
 * 读状态文件。**永不抛**：不存在 / 不可读 / JSON 坏 → null（调用方一律按"不跳过"处理）。
 * @param {string} file 绝对路径
 * @returns {object|null}
 */
export function readSkipState(file) {
  if (!file) return null;
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(txt);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 组装一条状态记录（纯函数，不写盘）。
 * @param {{ok:boolean, repoHead?:string|null, localCount?:number|null, at?:number, mergedCount?:number, host?:string|null, reason?:string|null}} input
 */
export function makeSkipState(input = {}) {
  const { ok, repoHead = null, localCount = null, at = Date.now(), mergedCount = 0, host = null, reason = null } = input;
  return {
    schemaVersion: SKIP_STATE_VERSION,
    ok: ok === true,
    repoHead: repoHead ?? null,
    localCount: Number.isFinite(localCount) ? Number(localCount) : null,
    mergedCount: Number.isFinite(mergedCount) ? Number(mergedCount) : 0,
    at: Number(at),
    host: host ?? null,
    reason: reason ?? null,
  };
}

/**
 * 写状态文件（原子：先写 .tmp 再 rename）。**永不抛**（状态写不进去不该让落地失败）。
 * @returns {{ok:boolean, error:string|null}}
 */
export function writeSkipState(file, state) {
  if (!file) return { ok: false, error: 'no-state-file' };
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败无所谓 */ }
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 跳过判据 —— **纯函数**（给定输入必然同结果；不读盘、不 spawn、不取当前时间）。
 *
 * skip ⇔ enabled
 *         && 状态可读且 schemaVersion 匹配
 *         && 上次落地 ok === true
 *         && 记录过 repoHead，且与本次 repoHead **逐字节相同**
 *         && 距上次成功 ≤ maxAgeMs（且时钟未倒退）
 *         && 本机会话数已知，且 ≥ 上次记录数（自愈：本机删过会话 ⇒ 必须补）
 *
 * @param {{
 *   state?:object|null,      // readSkipState() 的结果
 *   repoHead?:string|null,   // 本次调用前的仓 HEAD（仓2）
 *   localCount?:number|null, // 本机现有会话数（countLocalSessions 口径）
 *   now?:number,             // 当前时间（ms）
 *   maxAgeMs?:number,        // 状态新鲜度上限
 *   enabled?:boolean,        // false = 显式禁用跳过（--no-skip）
 * }} input
 * @returns {{skip:boolean, reason:string}}
 */
export function shouldSkipLanding(input = {}) {
  const {
    state = null,
    repoHead = null,
    localCount = null,
    now = Date.now(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    enabled = true,
  } = input;

  if (!enabled) return { skip: false, reason: 'skip-disabled' };
  if (!state || typeof state !== 'object') return { skip: false, reason: 'no-state' };
  if (state.schemaVersion !== SKIP_STATE_VERSION) return { skip: false, reason: 'state-schema-mismatch' };
  if (state.ok !== true) return { skip: false, reason: 'last-run-not-ok' };
  if (!state.repoHead) return { skip: false, reason: 'no-recorded-head' };
  if (!repoHead) return { skip: false, reason: 'repo-head-unknown' };
  if (String(repoHead) !== String(state.repoHead)) return { skip: false, reason: 'repo-head-moved' };

  const at = Number(state.at);
  if (!Number.isFinite(at) || at <= 0) return { skip: false, reason: 'no-recorded-time' };
  const age = Number(now) - at;
  if (!Number.isFinite(age) || age < 0) return { skip: false, reason: 'clock-skew' };
  if (age > maxAgeMs) return { skip: false, reason: 'stale' };

  // ⚠️ null/undefined 必须显式挡掉：`Number(null) === 0` 是有限数，会被误判成"本机 0 个会话"
  //    → 走 local-shrank 分支（结论虽同，但 reason 会误导排查）。
  if (localCount === null || localCount === undefined || !Number.isFinite(Number(localCount))) {
    return { skip: false, reason: 'local-count-unknown' };
  }
  const recorded = Number(state.localCount);
  if (Number.isFinite(recorded) && Number(localCount) < recorded) {
    return { skip: false, reason: `local-shrank(${Number(localCount)}<${recorded})` };
  }
  return { skip: true, reason: `unchanged(head ${String(repoHead).slice(0, 8)} / age ${Math.round(age / 1000)}s)` };
}
