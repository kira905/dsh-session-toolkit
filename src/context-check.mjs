#!/usr/bin/env node
/**
 * context-check.mjs — 会话上下文用量自查（只读）
 *
 * 用途：让 agent 自己知道「当前会话的上下文用了多少」，接近阈值时主动移交工作到新会话。
 * 数据源：DSH web api-proxy 的 session.list 投影（token-meter 提供的 contextPressure），
 *         与 GUI 输入框旁上下文圆环同源，是 provider 上报值锚定后的估算。
 *
 * 用法：
 *   node context-check.mjs                     # 查当前会话（读 DSH_SESSION_ID）
 *   node context-check.mjs --threshold 300000  # 自定义阈值（默认 300000）
 *   node context-check.mjs --json              # 机器可读
 *   node context-check.mjs --session <id>      # 查指定会话
 *   node context-check.mjs --all               # 列出所有会话的用量（按用量降序）
 *
 * 退出码：0 = 正常且未超阈值；7 = 已超阈值（该移交了）；2 = 查不到会话/服务不可用
 */
import process from 'node:process';
// 本件依赖**可发布**的 RPC 客户端件：宿主凭据由该件经「可选依赖探测（宿主专有凭据件，
// 不发布）+ 显式 / env 注入」取用；本件不静态 import 任何凭据通道件。
import { hostRpc, hostRpcJson } from './lib/dsh-rpc-client.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const THRESHOLD = Number(val('--threshold', '300000'));
const JSON_OUT = has('--json');
const SID = val('--session', process.env.DSH_SESSION_ID || '');
const URL_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';

async function fetchSessions() {
  // 0.1.5 换线（2026-09-22）：旧 POST /api/session.list 已失效（无 cookie 401）→ 共享适配层。
  // 适配层自带 cookie 自签 + 端点斜杠化 + args 包装，并对旧主包自动回落点号形态。
  const { status, body: j } = await hostRpc(URL_BASE, 'session.list', {}, { timeoutMs: 20_000 });
  if (j?.result === undefined) throw new Error(`HTTP ${status}`);
  const items = j?.result?.value?.items;
  if (!Array.isArray(items)) throw new Error('unexpected response shape');
  return items;
}

const k = (n) => n.toLocaleString('en-US');
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) : '?');

const rows = [];

try {
  const items = await fetchSessions();

  if (has('--all')) {
    for (const it of items) {
      const cp = it.projections?.values?.contextPressure;
      if (!cp) continue;
      rows.push({
        sessionId: it.sessionId,
        preset: it.agentPreset,
        running: !!it.running,
        updatedAt: it.updatedAt,
        pressure: cp.pressureTokens,
        projected: cp.projectedTokens,
        window: cp.contextWindow,
      });
    }
    rows.sort((a, b) => (b.projected || 0) - (a.projected || 0));
    if (JSON_OUT) {
      console.log(JSON.stringify({ threshold: THRESHOLD, sessions: rows }, null, 1));
    } else {
      console.log(`阈值 ${k(THRESHOLD)} tokens｜共 ${rows.length} 个会话（按用量降序）\n`);
      for (const r of rows.slice(0, 25)) {
        const p = r.projected ?? r.pressure ?? 0;
        const mark = p >= THRESHOLD ? '⚠️ ' : '   ';
        console.log(`${mark}${pct(p, r.window)}%  ${k(p).padStart(9)} / ${k(r.window || 0)}  ${r.sessionId}  ${r.running ? '[运行中]' : ''}`);
      }
    }
    process.exitCode = 0;
  } else {
    if (!SID) {
      console.error('找不到会话：DSH_SESSION_ID 未设置且未传 --session');
      process.exitCode = 2;
    } else {
      const me = items.find((i) => i.sessionId === SID);
      if (!me) {
        console.error(`会话不在列表中：${SID}`);
        process.exitCode = 2;
      } else {
        const v = me.projections?.values ?? {};
        const cp = v.contextPressure ?? {};
        const tu = v.tokenUsage ?? {};
        const cb = v.contextBreakdown ?? {};
        const projected = cp.projectedTokens ?? cp.pressureTokens ?? 0;
        const window = cp.contextWindow ?? 0;
        const over = projected >= THRESHOLD;

        if (JSON_OUT) {
          console.log(JSON.stringify({
            sessionId: SID, preset: me.agentPreset, threshold: THRESHOLD, over,
            projectedTokens: projected, pressureTokens: cp.pressureTokens ?? null, contextWindow: window,
            ratio: window ? +(projected / window).toFixed(4) : null,
            tokenUsage: tu, breakdown: cb, stats: v.sessionStats ?? null,
          }, null, 1));
        } else {
          console.log(`会话 ${SID}`);
          console.log(`预设 ${me.agentPreset}｜状态 ${me.running ? '运行中' : '空闲'}`);
          console.log('');
          console.log(`  上下文占用  ${k(projected)} / ${k(window)}  = ${pct(projected, window)}%`);
          console.log(`  （上轮实测 ${k(cp.pressureTokens ?? 0)}，投影含本回合新增）`);
          console.log(`  组成估算    系统 ${k(cb.systemTokens ?? 0)}｜工具 ${k(cb.toolsTokens ?? 0)}｜消息 ${k(cb.messageTokens ?? 0)}`);
          console.log(`  累计用量    未缓存输入 ${k(tu.uncachedInputTokens ?? 0)}｜缓存读取 ${k(tu.cacheReadTokens ?? 0)}｜输出 ${k(tu.outputTokens ?? 0)}`);
          console.log('');
          console.log(`  阈值 ${k(THRESHOLD)} → 剩余 ${k(Math.max(0, THRESHOLD - projected))}`);
          if (over) {
            console.log('');
            console.log('⚠️⚠️ 已超过阈值 —— 现在就该收尾并把工作移交到新会话 ⚠️⚠️');
          } else {
            console.log(`  ✅ 未超阈值（还有 ${pct(Math.max(0, THRESHOLD - projected), Math.max(1, window))}% 窗口的余量）`);
          }
        }
        process.exitCode = over ? 7 : 0;
      }
    }
  }
} catch (e) {
  console.error(`查询失败：${e.message}`);
  console.error(`（需要 DSH web 在 ${URL_BASE} 运行）`);
  process.exitCode = 2;
}
