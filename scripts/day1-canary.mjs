#!/usr/bin/env node
/**
 * Day1 金丝雀探活（严格模式）
 * - 不写业务库、不启动 worker/scheduler
 * - Boss 最多 1 次搜索；Tanji 最多 3 次搜索；其余来源只做健康检查
 * - 每次请求后检查风控，出现 code36/37/风险行为立即中止
 * 用法：node scripts/day1-canary.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/home/songqian';
const ROOT = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const tanjiToken = JSON.parse(fs.readFileSync(path.join(HOME, '.tanji-client/config.json'), 'utf8')).apiToken;
const fumaToken = JSON.parse(fs.readFileSync(path.join(HOME, '.fuma-platform/config.json'), 'utf8'))?.server?.apiToken;
const outDir = path.join(HOME, '.lead-platform/reports');
fs.mkdirSync(outDir, { recursive: true });
const started = Date.now();
const report = { startedAt: new Date().toISOString(), steps: [], verdict: 'pending', aborted: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(step, detail) { console.log(JSON.stringify({ step, ...detail })); report.steps.push({ step, at: new Date().toISOString(), ...detail }); }

async function request(name, url, opts = {}, timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* text */ }
    const info = { name, http: res.status, ms: Date.now() - t0, ok: json?.ok ?? null, error: json?.error?.code ?? null, message: json?.error?.message ?? null };
    log('request', info);
    return { res, json, info };
  } catch (e) {
    const info = { name, ms: Date.now() - t0, error: String(e).slice(0, 160) };
    log('request', info);
    return { error: info };
  }
}

const isTanjiRisk = (j) => {
  const msg = `${j?.error?.message ?? ''} ${j?.data?.message ?? ''}`;
  return /风险行为|风控|captcha|验证码/i.test(msg) || j?.error?.code === 'SOURCE_VERIFICATION_PENDING';
};
const isBossRisk = (data) => {
  const risk = data?.risk ?? {};
  return Number(risk.code36Count ?? 0) > 0 || Number(risk.code37Count ?? 0) > 0 || (data?.health && data.health !== 'ok');
};

function abort(reason) {
  report.aborted = true;
  report.verdict = 'aborted: ' + reason;
  log('ABORT', { reason });
  finish(1);
}
function finish(exitCode) {
  report.finishedAt = new Date().toISOString();
  report.elapsedSec = Math.round((Date.now() - started) / 1000);
  if (!report.aborted) report.verdict = 'safe';
  const file = path.join(outDir, `day1-canary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, reportFile: file, elapsedSec: report.elapsedSec }));
  process.exit(exitCode);
}

// 1) 健康探测（只读）
const healthTargets = [
  ['boss', 'http://127.0.0.1:8790/v1/status', env.BOSS_API_TOKEN],
  ['zhilian', 'http://127.0.0.1:8791/v1/status', env.ZHILIAN_API_TOKEN],
  ['ali', 'http://127.0.0.1:8792/v1/status', env.ALI_API_TOKEN],
  ['tanji', 'http://127.0.0.1:8787/v1/status', tanjiToken],
  ['fuma', 'http://127.0.0.1:17890/v1/status', fumaToken],
];
for (const [name, url, token] of healthTargets) {
  const r = await request(`health:${name}`, url, { headers: token ? { authorization: `Bearer ${token}` } : {} }, 12000);
  if (r.error) { if (name === 'tanji' || name === 'boss') abort(`${name} health request failed`); continue; }
  if (name === 'boss') {
    if (isBossRisk(r.json?.data)) abort('boss health/risk not ok');
    const risk = r.json?.data?.risk ?? {};
    log('boss-status', { loggedIn: r.json?.data?.loggedIn, health: r.json?.data?.health, risk });
  }
  if (name === 'tanji') {
    if (r.json?.data?.health !== 'ok' || r.json?.data?.loggedIn !== true) abort('tanji health not ok');
    const q = r.json?.data?.quota ?? {};
    log('tanji-status', { loggedIn: r.json?.data?.loggedIn, health: r.json?.data?.health, dailyRemaining: q.daily?.remaining, monthlyRemaining: q.monthly?.remaining });
  }
}

// 2) Mic 探活（客户端可能未启动；仅尝试一次）
const mic = await request('mic-search', 'http://127.0.0.1:8899/api/search/factories?province=Hebei&keyword=Shijiazhuang&page=1&page_size=5', {}, 10000);
if (!mic.error && mic.json?.ok) {
  log('mic-status', { total: mic.json?.data?.pagination?.total ?? null });
} else {
  log('mic-unavailable', { note: 'mic-client 未启动或端口不可达；Day1 记录，不重试' });
}

// 3) Boss 单次搜索（严格：1 次，page1）
const bossSearch = await request('boss-search-once', 'http://127.0.0.1:8790/v1/search/jobs', {
  method: 'POST',
  headers: { authorization: `Bearer ${env.BOSS_API_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ keyword: '外贸', cityCode: '101090100', page: 1, pageSize: 20, pages: 1 }),
}, 30000);
if (bossSearch.error) abort('boss search request failed');
if (!bossSearch.json?.ok) {
  const code = bossSearch.json?.error?.code;
  const detail = bossSearch.json?.error?.details;
  log('boss-search-error', { code, detail });
  abort(`boss search rejected (${code}${detail?.code ? ':' + detail.code : ''})`);
}
log('boss-search-ok', { jobs: bossSearch.json?.data?.jobs?.length ?? 0, query: bossSearch.json?.data?.query ?? null });
await sleep(15000);
const bossAfter = await request('boss-health-after', 'http://127.0.0.1:8790/v1/status', { headers: { authorization: `Bearer ${env.BOSS_API_TOKEN}` } }, 12000);
if (bossAfter.error) abort('boss status after search failed');
if (isBossRisk(bossAfter.json?.data)) abort('boss risk after search');
log('boss-after-ok', { risk: bossAfter.json?.data?.risk });

// 4) Tanji 3 次搜索（每次间隔 12s，每次后检查健康；出现风险立即停）
const tanjiQueries = [
  { name: '河北华通线缆集团股份有限公司' },
  { name: '河北圣天管件集团有限公司' },
  { name: '河北金实金属制品有限公司' },
];
for (let i = 0; i < tanjiQueries.length; i++) {
  await sleep(12000);
  const q = tanjiQueries[i];
  const r = await request(`tanji-search-${i + 1}`, 'http://127.0.0.1:8787/v1/search/name', {
    method: 'POST',
    headers: { authorization: `Bearer ${tanjiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: q.name, field: 'name', pageSize: 5, maxPages: 1 }),
  }, 45000);
  if (r.error) abort(`tanji search ${i + 1} request failed`);
  if (!r.json?.ok || isTanjiRisk(r.json)) {
    log('tanji-search-error', { code: r.json?.error?.code, message: r.json?.error?.message });
    abort(`tanji risk at search ${i + 1}`);
  }
  log('tanji-search-ok', { query: q.name, total: r.json?.data?.total ?? null, top: r.json?.data?.companies?.[0]?.name ?? null });
  const status = await request(`tanji-health-${i + 1}`, 'http://127.0.0.1:8787/v1/status', { headers: { authorization: `Bearer ${tanjiToken}` } }, 12000);
  if (status.error || status.json?.data?.health !== 'ok') abort(`tanji health bad after search ${i + 1}`);
}

finish(0);
