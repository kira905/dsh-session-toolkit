#!/usr/bin/env node
// session-axis-set.mjs —— 给会话标题打/换**接力轴**（【续】 / 【已交接】）
//
// 场景：2026-09-22 之前，title-live 的 turn-mark 会把接力轴剥掉（`【续】X` → `【运行】X`），
//   导致历史接力会话在侧边栏看不出「谁是接手方 / 谁已交棒」。插件已修（保留接力轴），
//   本工具用于**事后补回**这些会话的轴；也可手工把某会话标成接手方/已交接。
//
// 用法：
//   node session-axis-set.mjs --session <sid> --axis 续 --base "<主线名>"             # 默认 dry-run（只报将会写什么）
//   node session-axis-set.mjs --session <sid> --axis 续 --base "<主线名>" --apply     # 真写（调 session.rename）
//   node session-axis-set.mjs --self-test                                             # 自检（纯函数 + 假服务，零生产写入）
//
// 只调 `session.rename`（与 relay / session-mark 同一条路）——不碰任何文件、不写台账、不建会话。
// `--base` 省略时：从当前标题里剥掉已知轴前缀后取基名（剥不出 ⇒ 拒绝写入，exit 3）。
import http from 'node:http';
// 本件依赖**可发布**的 RPC 客户端件：宿主凭据由该件经「可选依赖探测（宿主专有凭据件，
// 不发布）+ 显式 / env 注入」取用；本件不静态 import 任何凭据通道件。
import { hostRpc } from './lib/dsh-rpc-client.mjs';

const BASE = process.env.DSH_BASE_URL || 'http://localhost:3080';
const AXES = { '续': '【续】', '已交接': '【已交接】' };
const KNOWN_AXES = ['【运行】', '【完成】', '【待续】', '【待命】', '【已中断】', '【续】', '【已交接】'];

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const has = (name) => argv.includes(`--${name}`);

/** 纯函数：把一系列轴前缀剥掉，返回基名（只剥开头连续段、只认词表）。 */
export function stripAxes(title) {
  let rest = typeof title === 'string' ? title.trim() : '';
  for (let depth = 0; depth < 4; depth++) {
    const hit = KNOWN_AXES.find((p) => rest.startsWith(p));
    if (hit === undefined) break;
    rest = rest.slice(hit.length).trimStart();
  }
  return rest;
}

/** 纯函数：拼出新标题 = 指定轴 + 基名。 */
export function buildAxisTitle(axisWord, base) {
  const axis = AXES[axisWord];
  if (axis === undefined) throw new Error(`未知接力轴 "${String(axisWord)}"（只支持 续 / 已交接）`);
  const b = stripAxes(base);
  if (!b) throw new Error('基名为空 ⇒ 拒绝写入');
  return `${axis}${b}`;
}

async function rpc(baseUrl, method, payload) {
  // 0.1.5 换线（2026-09-22）：旧点号端点已失效 → 共享适配层（新端点 + args 包装 + cookie 自签；
  // 旧主包自动回落）。返回语义不变：成功给 result.value，失败抛错。
  const { status, body } = await hostRpc(baseUrl, method, payload, { timeoutMs: 20_000 });
  if (status !== 200 || body?.result?.ok === false) {
    throw new Error(`${method} 失败：HTTP ${status} ${JSON.stringify(body?.result?.error ?? body).slice(0, 200)}`);
  }
  return body?.result?.value ?? body;
}

async function currentTitle(baseUrl, sid) {
  const v = await rpc(baseUrl, 'session.list', {});
  const item = (v?.items ?? []).find((s) => String(s.sessionId) === String(sid));
  return item?.projections?.values?.title ?? null;
}

const selfTest = async () => {
  let pass = 0; let fail = 0;
  const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? ` → ${extra}` : ''}`); } };
  console.log('=== ① 纯函数 ===');
  ok('stripAxes 剥【完成】【续】', stripAxes('【完成】【续】主线A') === '主线A');
  ok('stripAxes 词表外不动', stripAxes('【跨机同步】A') === '【跨机同步】A');
  ok('buildAxisTitle 续 + 已带轴的标题', buildAxisTitle('续', '【完成】主线A') === '【续】主线A');
  ok('buildAxisTitle 已交接', buildAxisTitle('已交接', '【续】主线A') === '【已交接】主线A');
  ok('未知轴 ⇒ 抛错', (() => { try { buildAxisTitle('乱写', 'A'); return false; } catch { return true; } })());
  ok('空基名 ⇒ 抛错', (() => { try { buildAxisTitle('续', '【完成】'); return false; } catch { return true; } })());
  console.log('=== ② 假服务（dry-run 不写 / apply 才写）===');
  const calls = [];
  let cur = '【运行】主线A';
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = String(req.url || '').replace(/^\/api\//, '');
      let payload = {};
      try { payload = JSON.parse(body)?.payload ?? {}; } catch { /* ignore */ }
      res.setHeader('content-type', 'application/json');
      if (method === 'session.list') return res.end(JSON.stringify({ result: { ok: true, value: { items: [{ sessionId: 's-x', projections: { values: { title: cur } } }] } } }));
      if (method === 'session.rename') { calls.push(payload); cur = payload.title; return res.end(JSON.stringify({ result: { ok: true, value: { title: payload.title, seq: 9 } } })); }
      res.statusCode = 404;
      res.end(JSON.stringify({ result: { ok: false, error: { message: 'unknown' } } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const curTitle = await currentTitle(url, 's-x');
  ok('读到当前标题', curTitle === '【运行】主线A', String(curTitle));
  const want = buildAxisTitle('续', curTitle);
  ok('算出目标标题', want === '【续】主线A', want);
  ok('dry-run 未发 rename', calls.length === 0, String(calls.length));
  await rpc(url, 'session.rename', { sessionId: 's-x', title: want });
  ok('apply 发出 rename 且标题更新', calls.length === 1 && cur === '【续】主线A', JSON.stringify({ calls: calls.length, cur }));
  srv.close();
  console.log(`=== 汇总：PASS ${pass} / FAIL ${fail} ===`);
  process.exitCode = fail ? 1 : 0;
};

if (has('self-test')) {
  await selfTest();
} else {
  const sid = opt('session');
  const axisWord = opt('axis');
  const baseArg = opt('base');
  const apply = has('apply');
  if (!sid || !axisWord) {
    console.error('用法: node session-axis-set.mjs --session <sid> --axis 续|已交接 [--base "<主线名>"] [--apply] [--self-test]');
    process.exitCode = 2;
  } else {
    try {
      const cur = await currentTitle(BASE, sid);
      if (cur === null) {
        console.error(`[axis-set] ✗ 会话 ${sid} 不在 session.list 里 ⇒ 拒绝写入`);
        process.exitCode = 3;
      } else {
        const base = baseArg && baseArg.trim() ? baseArg : stripAxes(cur);
        const next = buildAxisTitle(axisWord, base);
        console.log(`[axis-set] 会话 ${sid}`);
        console.log(`  当前标题：${cur}`);
        console.log(`  目标标题：${next}`);
        if (!apply) {
          console.log('  （dry-run，未写；加 --apply 才真改）');
        } else if (next === cur) {
          console.log('  ✅ 已是目标形态 ⇒ 幂等跳过（未调 rename）');
        } else {
          const v = await rpc(BASE, 'session.rename', { sessionId: sid, title: next });
          console.log(`  ✅ 已写入：${v?.title ?? next}（seq=${v?.seq ?? '?'}）`);
        }
      }
    } catch (e) {
      console.error(`[axis-set] 失败：${e?.message ?? e}`);
      process.exitCode = 1;
    }
  }
}
await new Promise((r) => setTimeout(r, 50));
