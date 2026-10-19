// session-file-name.mjs —— 会话日志文件名判据 · **单一真源**（零依赖）
//
// 背景：
//   主包 0.1.5 起把会话日志改名 `session.jsonl.zstd` → `session.v3.jsonl.zstd`；
//   主包 0.2.x 起**再换代** `session.v3.jsonl.zstd` → `session.v4.jsonl.zstd`（**现行世代**）。
//   凡是「按精确文件名比较」的**读取侧**判据都会整条失明（实测一次扫描活跃树覆盖 0 / 212），
//   而归档里仍有大量旧名文件、两代并存目录也不罕见。
//
// 三条铁律：
//   ① 读取侧一律用 isSessionFileName() / sessionFileGeneration()（前缀 + 代际），**禁精确字符串比较**；
//   ② 需要"代际"时从文件名提取（旧名 = 0，`session.vN....` = N），**禁硬编码**；
//   ③ 写入侧（真要写文件名时）用 SESSION_FILE_NAME_CURRENT（当前世代 = v4）。
//
// ⚠️ 非 Node 侧（如 PowerShell 脚本）无法 import 本模块：那边**必须写等价判据并保持同步**
//   （判据 =「前缀 + 代际」+ current 名常量）。**改一处必须同步另一处。**
//
//   消费方须知（本模块是"单一真源"，不要在别处重造第二套判据）：
//   · 读取侧统一调 isSessionFileName() / sessionFileGeneration()，**禁按文件名精确字符串比较**；
//   · 需要"取哪份"时走候选链 rankSessionFilesInDir() / collectSessionFilesByDir()（returns .files）；
//   · 只做扫描 / 移动、不读内容的场景取 SESSION_FILE_NAME_CURRENT 即可；
//   · 若某个消费方在**另一棵树**里留了派生副本（打包 / 部署产物），必须让部署环节
//     **fail-closed 校验副本与真源 sha 一致**，并在改真源时同批重跑那个同步步骤。
//
//   ⚠️ 已知风险登记（先登记、本版不修）：「两代并存」目录里新世代文件可能只是**补写壳**
//      （实测：新世代仅 2 事件 / 244 B，旧名才是完整对话 2621 事件 / 2.7 MB）=> **需要读内容的
//      消费者必须走候选链**（rankSessionFilesInDir / collectSessionFilesByDir 的 files），
//      只做扫描 / 移动的取 current 即可。
import fs from 'node:fs';
import path from 'node:path';

/** 旧世代文件名（≤ 0.1.1；归档树里仍有大量此名）。 */
export const SESSION_FILE_NAME_LEGACY = 'session.jsonl.zstd';

/** v3 世代文件名（0.1.5 起；**已被 0.2.x 换代**，仍须认得）。 */
export const SESSION_FILE_NAME_V3 = 'session.v3.jsonl.zstd';

/** 当前世代文件名（0.2.x 起）。 */
export const SESSION_FILE_NAME_V4 = 'session.v4.jsonl.zstd';

/** 写入侧应使用的当前世代文件名。 */
export const SESSION_FILE_NAME_CURRENT = SESSION_FILE_NAME_V4;

/** 认得的三个世代名（读取侧清单；顺序 = 旧 → 新）。 */
export const SESSION_FILE_NAMES = [SESSION_FILE_NAME_LEGACY, SESSION_FILE_NAME_V3, SESSION_FILE_NAME_V4];

/** 宽匹配模式（shell / robocopy / Get-ChildItem -Filter 用；**读取侧**）。 */
export const SESSION_FILE_GLOB = 'session*.jsonl.zstd';

/**
 * 读取侧判据（前缀 + 代际）。命中的形态：
 *   `session.jsonl.zstd`（旧世代）· `session.v3.jsonl.zstd`（0.1.5 世代）· `session.v4.jsonl.zstd`（当前世代）
 *   · 更高的 `session.vN.jsonl.zstd`（未来世代）—— **本判据认任意 vN，换代时无需改**。
 * 不命中：`session.jsonl`（明文形态，另有判据）· `session.jsonl.zstd.bak` · 其它任意文件。
 */
export const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/** 是否会话日志文件（读取侧唯一判据）。 */
export function isSessionFileName(name) {
  return SESSION_FILE_RE.test(String(name));
}

/**
 * 从文件名提取代际：旧世代 = 0；`session.vN.jsonl.zstd` = N；非会话文件 = null。
 * @returns {number|null}
 */
export function sessionFileGeneration(name) {
  const m = SESSION_FILE_RE.exec(String(name));
  if (!m) return null;
  return m[1] ? Number(m[1]) : 0;
}

/**
 * 目录形态的会话文件清单（不递归）。
 * @returns {{file:string,name:string,generation:number,bytes:number,mtimeMs:number}[]}
 */
export function listSessionFilesInDir(dir, opts = {}) {
  const fsImpl = opts.fs ?? fs;
  let ents;
  try { ents = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (!isSessionFileName(e.name)) continue;
    const full = path.join(dir, e.name);
    let st;
    try { st = fsImpl.statSync(full); } catch { continue; }
    out.push({
      file: full, name: e.name, generation: sessionFileGeneration(e.name),
      bytes: st.size, mtimeMs: Math.round(st.mtimeMs),
    });
  }
  return out;
}

/**
 * 同一会话目录内的候选文件，按优先级排序（第一个 = 「当前那份」）：
 *   mtime 最新优先 → 平局取代际大者 → 再平局取名字典序小者（确定性）。
 *
 * ⚠️ **「当前那份」≠「内容最全的那份」**（实测）：
 *    换代后新世代文件可能只是"补写壳"——`session.v3.jsonl.zstd`
 *    只有 2 个事件（`session` 头 + `session/end-seed`、有效内容 244 B），而旧名文件才是完整对话
 *    （2621 个事件 / 2.7 MB 解压文本）。**需要读内容的消费者必须走完候选链**（见下），
 *    只做"扫描/移动"的消费者取第一个即可。
 * @returns {{file:string,name:string,generation:number,bytes:number,mtimeMs:number}[]}
 */
export function rankSessionFilesInDir(dir, opts = {}) {
  const hits = listSessionFilesInDir(dir, opts);
  hits.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.generation - a.generation) || (a.name < b.name ? -1 : 1));
  return hits;
}

/**
 * 在一个会话目录里挑出"当前那份"会话文件（两代并存时的取法）：
 *   mtime 最新优先 → 平局取代际大者 → 再平局取名字典序小者（确定性）。
 * @returns {string|null} 绝对路径；目录不存在 / 无会话文件 = null
 */
export function pickSessionFileInDir(dir, opts = {}) {
  const hits = rankSessionFilesInDir(dir, opts);
  return hits.length ? hits[0].file : null;
}

/**
 * 递归收集会话目录（**每个目录聚合一次**，不做逐文件扁平化）。
 * 用途：归档器的扫描面 —— 一个会话目录 = 一个会话，两代并存时 `current` 是"当前那份"、
 * `files` 是该目录全部世代（移动校验/尾部判据/内容回落都要用到全量）。
 * @returns {{dir:string, current:string, files:object[]}[]} 按 dir 字典序（确定性）
 */
export function collectSessionFilesByDir(root, opts = {}) {
  const fsImpl = opts.fs ?? fs;
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fsImpl.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    let hasSessionFile = false;
    for (const e of ents) {
      if (e.isDirectory()) { stack.push(path.join(d, e.name)); continue; }
      if (e.isFile() && isSessionFileName(e.name)) hasSessionFile = true;
    }
    if (!hasSessionFile) continue;
    const files = rankSessionFilesInDir(d, opts);
    if (files.length) out.push({ dir: d, current: files[0].file, files });
  }
  out.sort((a, b) => (a.dir < b.dir ? -1 : 1));
  return out;
}

/** 递归收集「每目录当前那份」的绝对路径（collectSessionFilesByDir 的扁平形态）。 */
export function collectSessionFilesInTree(root, opts = {}) {
  return collectSessionFilesByDir(root, opts).map((x) => x.current);
}
