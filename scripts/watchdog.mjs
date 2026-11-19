#!/usr/bin/env node
/**
 * 外部监督 watchdog（独立于 LeadPlatform 进程）
 *
 * - 每 15 分钟由 systemd timer 调用一次
 * - 检查上游风控信号、LeadPlatform 队列/数据积累
 * - Boss code36/37、Tanji 登录/健康异常、Ali captcha、Mic challenge 等 → 立即熔断：
 *   写 PAUSE/INCIDENT、停止 lead-platform（阻止后续 Tanji/Boss 调用）、输出告警
 * - 正常时写 monitor-latest.json / monitor-history.jsonl，供定时汇报
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.HOME || '/home/songqian';
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(HOME, '.lead-platform');
const REPORT_DIR = path.join(DATA, 'reports');
const LATEST = path.join(DATA, 'monitor-latest.json');
const PAUSE = path.join(DATA, 'PAUSE');
const INCIDENT = path.join(DATA, 'INCIDENT');
fs.mkdirSync(REPORT_DIR, { recursive: true });

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const TOKEN = env.LEAD_API_TOKEN;
const BASE = env.LEAD_BASE_URL || 'http://127.0.0.1:8793';
const nowIso = () => new Date().toISOString();
const summary = { at: nowIso(), status: 'unknown', severe: false, reasons: [], upstream: {}, platform: {}, data: {}, quota: null };

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
async function api(pathname) {
  const res = await fetch(BASE + pathname, { headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}, signal: AbortSignal.timeout(15_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`${pathname} HTTP ${res.status}`);
  return json.data;
}
async function probe(name, url, token) {
  try {
    const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => null);
    summary.upstream[name] = { http: res.status, ok: json?.ok ?? null, data: json?.data ?? null, error: json?.error ?? null };
  } catch (e) {
    summary.upstream[name] = { error: String(e).slice(0, 160) };
  }
}
function severe(reason) { summary.severe = true; if (!summary.reasons.includes(reason)) summary.reasons.push(reason); }

async function main() {
  const tanjiCfg = readJson(path.join(HOME, '.tanji-client/config.json'));
  const fumaCfg = readJson(path.join(HOME, '.fuma-platform/config.json'));
  await Promise.all([
    probe('boss', 'http://127.0.0.1:8790/v1/status', env.BOSS_API_TOKEN),
    probe('zhilian', 'http://127.0.0.1:8791/v1/status', env.ZHILIAN_API_TOKEN),
    probe('ali', 'http://127.0.0.1:8792/v1/status', env.ALI_API_TOKEN),
    probe('tanji', 'http://127.0.0.1:8787/v1/status', tanjiCfg?.apiToken ?? null),
    probe('mic', 'http://127.0.0.1:8899/health', null),
    probe('fuma', 'http://127.0.0.1:17890/v1/status', fumaCfg?.server?.apiToken ?? null),
  ]);

  const boss = summary.upstream.boss?.data;
  if (!boss) severe('boss status unavailable');
  else if (Number(boss.risk?.code36Count ?? 0) > 0 || Number(boss.risk?.code37Count ?? 0) > 0) severe('boss risk code36/37');
  else if (boss.health !== 'ok') severe(`boss health=${boss.health}`);

  const tanji = summary.upstream.tanji?.data;
  if (!tanji) severe('tanji status unavailable');
  else if (tanji.health !== 'ok' || tanji.loggedIn !== true) severe(`tanji health=${tanji.health} loggedIn=${tanji.loggedIn}`);
  summary.quota = tanji?.quota ?? null;

  const ali = summary.upstream.ali?.data;
  if (!ali) severe('ali status unavailable');
  else if (ali.risk?.state !== 'normal' || ali.risk?.captchaRequired === true) severe(`ali risk=${ali.risk?.state} captcha=${ali.risk?.captchaRequired}`);

  const zhilian = summary.upstream.zhilian?.data;
  if (!zhilian) severe('zhilian status unavailable');
  else if (zhilian.health !== 'ok') severe(`zhilian health=${zhilian.health}`);

  const mic = summary.upstream.mic?.data;
  if (!mic) severe('mic health unavailable');
  else if (mic.status !== 'ok' || mic.session?.challenge_suspected === true) severe(`mic health=${mic.status} challenge=${mic.session?.challenge_suspected}`);

  try {
    summary.platform.status = await api('/v1/status');
    summary.data.summary = await api('/v1/stats?kind=summary');
    const platforms = ['mic', 'zhilian', 'ali', 'boss'];
    const leadTotals = {};
    for (const p of platforms) {
      try { leadTotals[p] = (await api(`/v1/leads?platform=${p}&limit=1`))?.total ?? 0; } catch { leadTotals[p] = null; }
    }
    summary.data.perPlatformLeads = leadTotals;
    try {
      const dead = await api('/v1/jobs?status=dead&limit=20');
      const items = Array.isArray(dead?.items) ? dead.items : [];
      const cutoff = Date.now() - 30 * 60_000;
      const recentDead = items.filter((j) => j.updatedAt && Date.parse(j.updatedAt) >= cutoff);
      summary.jobs = { deadTotal: items.length, recentDead: recentDead.length, recentErrors: recentDead.map((j) => j.lastError).filter(Boolean).slice(0, 5) };
      if (recentDead.length >= 5 && recentDead.some((j) => /UPSTREAM_CHANGED|SOURCE_UNAVAILABLE|AUTH|RISK|VERIFICATION/i.test(String(j.lastError ?? '')))) {
        severe('recent enrichment job failures >=5 (upstream/auth/risk)');
      }
    } catch { /* jobs endpoint optional */ }
  } catch (e) {
    summary.platform.error = String(e).slice(0, 200);
    // LeadPlatform 不可用时只记录；是否恢复由人工判断，不重复 stop
  }

  if (summary.severe) {
    summary.status = 'paused';
    const incident = { at: summary.at, reasons: summary.reasons, upstream: summary.upstream, data: summary.data };
    try { fs.writeFileSync(path.join(REPORT_DIR, `incident-${summary.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(incident, null, 2)); } catch { /* ignore */ }
    try {
      fs.writeFileSync(PAUSE, JSON.stringify({ at: summary.at, reasons: summary.reasons }, null, 2));
      fs.writeFileSync(INCIDENT, JSON.stringify(incident, null, 2));
    } catch { /* ignore */ }
    try { execFileSync('systemctl', ['--user', 'stop', 'lead-platform'], { stdio: 'ignore', timeout: 20_000 }); } catch { /* ignore */ }
    summary.action = 'paused lead-platform due to risk signals';
  } else if (fs.existsSync(PAUSE)) {
    summary.status = 'paused-manual';
    summary.action = 'PAUSE flag present; no new work';
  } else {
    summary.status = 'healthy';
  }

  summary.paused = fs.existsSync(PAUSE);
  fs.writeFileSync(LATEST, JSON.stringify(summary, null, 2));
  try { fs.appendFileSync(path.join(REPORT_DIR, 'monitor-history.jsonl'), JSON.stringify(summary) + '\n'); } catch { /* ignore */ }
  const line = {
    at: summary.at,
    status: summary.status,
    reasons: summary.reasons,
    leads: summary.data?.summary?.leads?.total ?? null,
    companies: summary.data?.summary?.companies?.total ?? null,
    drafts: summary.data?.summary?.drafts?.total ?? null,
    queue: summary.platform?.status?.queue ?? null,
    quota: summary.quota,
    perPlatformLeads: summary.data?.perPlatformLeads ?? null,
  };
  console.log(JSON.stringify(line));
  process.exit(summary.severe ? 2 : 0);
}

main().catch((err) => {
  summary.status = 'watchdog-error';
  summary.error = err instanceof Error ? err.message : String(err);
  try { fs.writeFileSync(LATEST, JSON.stringify(summary, null, 2)); } catch { /* ignore */ }
  console.error(JSON.stringify({ status: summary.status, error: summary.error }));
  process.exit(1);
});
