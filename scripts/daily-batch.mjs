#!/usr/bin/env node
/**
 * 每日批次控制器（外部监督层）
 *
 * - 默认每天只跑 1 个城市批次（Mic + 智联 + Ali 城市地理种子）
 * - 受 ~/.lead-platform/PAUSE 熔断标记、20h 最小间隔、运行锁保护
 * - 不创建长期 cron Goal；由 systemd timer 每天触发一次
 * - 所有调用都走 LeadPlatform REST，不直接调上游
 *
 * 用法：
 *   node scripts/daily-batch.mjs             # 按计划执行（受 notBefore 限制）
 *   node scripts/daily-batch.mjs --force     # 首次手动执行，忽略 notBefore
 *   node scripts/daily-batch.mjs --index=0   # 指定城市下标（调试）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME || '/home/songqian';
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(HOME, '.lead-platform');
const REPORT_DIR = path.join(DATA, 'reports');
const STATE_FILE = path.join(DATA, 'daily-plan-state.json');
const LOCK_FILE = path.join(DATA, 'daily-batch.lock');
const PAUSE_FILE = path.join(DATA, 'PAUSE');
fs.mkdirSync(REPORT_DIR, { recursive: true });

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const TOKEN = env.LEAD_API_TOKEN;
const BASE = env.LEAD_BASE_URL || 'http://127.0.0.1:8793';
if (!TOKEN) { console.error('LEAD_API_TOKEN missing'); process.exit(1); }
const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const INDEX_ARG = process.argv.slice(2).find((a) => a.startsWith('--index='));
const FORCED_INDEX = INDEX_ARG ? Number(INDEX_ARG.split('=')[1]) : null;

// 河北 11 市；每天一个城市
const CITIES = [
  { code: '130100', name: '石家庄', en: 'Shijiazhuang' },
  { code: '130200', name: '唐山', en: 'Tangshan' },
  { code: '130300', name: '秦皇岛', en: 'Qinhuangdao' },
  { code: '130400', name: '邯郸', en: 'Handan' },
  { code: '130500', name: '邢台', en: 'Xingtai' },
  { code: '130600', name: '保定', en: 'Baoding' },
  { code: '130700', name: '张家口', en: 'Zhangjiakou' },
  { code: '130800', name: '承德', en: 'Chengde' },
  { code: '130900', name: '沧州', en: 'Cangzhou' },
  { code: '131000', name: '廊坊', en: 'Langfang' },
  { code: '131100', name: '衡水', en: 'Hengshui' },
];
const ZHILIAN_KEYWORDS = ['外贸', '外贸业务员', '国际贸易', '跨境电商', '海外销售'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { nextIndex: 0, history: [] }; }
}
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } }
function acquireLock() {
  try {
    const st = fs.statSync(LOCK_FILE);
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (!alive || Date.now() - st.mtimeMs > 6 * 3600_000) fs.unlinkSync(LOCK_FILE);
  } catch { /* absent */ }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' }); process.on('exit', releaseLock); return true; } catch { return false; }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`${method} ${url} -> HTTP ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  return json.data;
}

function report(payload) {
  const file = path.join(REPORT_DIR, `daily-batch-${nowIso().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  try { fs.appendFileSync(path.join(REPORT_DIR, 'daily-history.jsonl'), JSON.stringify(payload) + '\n'); } catch { /* ignore */ }
  return file;
}

async function waitRun(runId, timeoutMs = 45 * 60_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await api('GET', `/v1/runs/${runId}`);
    if (['completed', 'partial', 'failed', 'cancelled'].includes(last.status)) return last;
    await sleep(10_000);
  }
  return last;
}

let lock = false;
try {
  if (fs.existsSync(PAUSE_FILE)) {
    report({ at: nowIso(), outcome: 'skipped', reason: 'PAUSE flag present' });
    process.exit(0);
  }
  lock = acquireLock();
  if (!lock) { console.error('another daily batch is running'); process.exit(0); }

  const state = readState();
  const index = FORCED_INDEX ?? state.nextIndex;
  if (index >= CITIES.length) { report({ at: nowIso(), outcome: 'complete', reason: 'all cities processed', history: state.history?.slice(-3) }); process.exit(0); }
  if (!FORCE && state.notBefore && Date.now() < Date.parse(state.notBefore)) {
    report({ at: nowIso(), outcome: 'skipped', reason: 'notBefore not reached', notBefore: state.notBefore, nextIndex: index });
    process.exit(0);
  }
  const city = CITIES[index];
  const dayLabel = `Day${index + 2}`;

  const health = await api('GET', '/v1/health');
  if (health?.status !== 'ok') throw new Error(`lead-platform unhealthy: ${JSON.stringify(health).slice(0, 200)}`);

  const goalInput = {
    name: `${dayLabel} ${city.name} 低频率批次`,
    region: { province: '河北省', provinceCode: '130000', cityCodes: [city.code] },
    platforms: ['mic', 'zhilian', 'ali'],
    keywords: { zhilian: ZHILIAN_KEYWORDS, ali: [], mic: [] },
    maxLeadsPerRun: 2000,
    dailyLeadLimit: 2000,
    schedule: { cron: '0 2 * * *', timeZone: 'Asia/Shanghai', timeWindow: '02:00-06:00' },
    priority: 10,
    unlockPolicy: { mode: 'priority', order: ['P0', 'P1', 'P2'] },
    enabled: true, // 由外部控制器手动触发；LeadPlatform scheduler 已关闭
  };
  const goal = await api('POST', '/v1/goals', goalInput);
  const goalId = goal?.id ?? goal?.goal?.id;
  if (!goalId) throw new Error('goal id missing');
  const trigger = await api('POST', `/v1/goals/${goalId}/run`);
  const runId = trigger?.id ?? trigger?.run?.id ?? trigger?.runId;
  if (!runId) throw new Error('run id missing');

  const run = await waitRun(runId);
  const payload = {
    at: nowIso(),
    outcome: run?.status === 'completed' ? 'completed' : (run?.status ?? 'unknown'),
    day: dayLabel,
    city: city.name,
    cityCode: city.code,
    goalId,
    runId,
    stats: run?.stats ?? null,
    error: run?.errorCode ? { code: run.errorCode, message: run.errorMessage } : null,
    riskIncident: fs.existsSync(path.join(DATA, 'INCIDENT')),
  };
  const file = report(payload);

  if (['completed', 'partial'].includes(String(run?.status))) {
    state.nextIndex = Math.max(Number(state.nextIndex ?? 0), index + 1);
    state.lastStartedAt = nowIso();
    state.notBefore = new Date(Date.now() + 20 * 3600_000).toISOString();
    state.lastRunId = runId;
    state.history = [...(state.history ?? []), { at: payload.at, day: dayLabel, city: city.name, runId, status: run.status }].slice(-50);
    writeState(state);
  }
  console.log(JSON.stringify({ outcome: payload.outcome, day: dayLabel, city: city.name, runId, report: file, stats: payload.stats }));
  process.exit(0);
} catch (err) {
  const payload = { at: nowIso(), outcome: 'error', error: err instanceof Error ? err.message : String(err) };
  const file = report(payload);
  // 运行错误先记录，不自动创建 PAUSE；由 watchdog 根据风控信号决定
  if (lock) releaseLock();
  console.error(JSON.stringify({ outcome: 'error', error: payload.error, report: file }));
  process.exit(1);
} finally {
  if (lock) releaseLock();
}
