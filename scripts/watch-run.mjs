#!/usr/bin/env node
/**
 * 后台 Run 监视器（运维辅助）：
 *   node scripts/watch-run.mjs <runId> [--enable-workers-after] [--interval 60]
 * 输出进度到 stdout / /tmp/lead-run-watch-<runId>.log；
 * --enable-workers-after：Run 结束后把 .env 的 LEAD_REFRESH_WORKER_ENABLED 改回 true 并重启 systemd 服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = process.env.HOME || '/home/songqian';
const runId = process.argv[2];
if (!runId) { console.error('usage: node scripts/watch-run.mjs <runId> [--enable-workers-after] [--interval 60]'); process.exit(2); }
const enableAfter = process.argv.includes('--enable-workers-after');
const intervalArg = process.argv.indexOf('--interval');
const intervalSec = intervalArg > 0 ? Number(process.argv[intervalArg + 1] || 60) : 60;
const cfgPath = path.join(HOME, '.lead-platform/config.json');
let token = process.env.LEAD_API_TOKEN;
let baseUrl = process.env.LEAD_BASE_URL || 'http://127.0.0.1:8793';
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  token = token || cfg.apiToken || cfg.token;
  baseUrl = process.env.LEAD_BASE_URL || cfg.baseUrl || baseUrl;
} catch { /* ignore */ }
if (!token) { console.error('missing token'); process.exit(2); }
const logFile = `/tmp/lead-run-watch-${runId}.log`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname) {
  const res = await fetch(baseUrl + pathname, { headers: { authorization: `Bearer ${token}` } });
  return res.json();
}

function log(msg, extra) {
  const line = `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}

async function finish() {
  if (!enableAfter) return;
  try {
    const envPath = path.join(ROOT, '.env');
    let s = fs.readFileSync(envPath, 'utf8');
    s = s.replace(/^LEAD_REFRESH_WORKER_ENABLED=.*$/m, 'LEAD_REFRESH_WORKER_ENABLED=true');
    fs.writeFileSync(envPath, s);
    execFileSync('systemctl', ['--user', 'restart', 'lead-platform']);
    log('workers re-enabled after run');
  } catch (e) {
    log('failed to enable workers', { err: String(e) });
  }
}

(async () => {
  log('watch start', { runId, intervalSec, enableAfter });
  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
  for (;;) {
    try {
      const r = await api(`/v1/runs/${runId}`);
      const run = r.data;
      if (!run) { log('run not found'); await sleep(intervalSec * 1000); continue; }
      const s = run.stats || {};
      const totalQueries = run.progress?.totalQueries ?? null;
      const doneQueries = run.progress?.doneQueries ?? null;
      log(`run ${run.status}`, {
        totalQueries,
        doneQueries,
        companies: s.coverage?.uniqueCompanies ?? null,
        pages: s.pagesFetched ?? null,
        leads: Object.values(s.platforms || {}).reduce((a, p) => a + (p.leads || 0), 0),
        etaHint: run.status === 'running' ? 'running' : undefined,
      });
      if (terminal.has(run.status)) { await finish(); process.exit(run.status === 'completed' ? 0 : 1); }
    } catch (e) {
      log('poll error', { err: String(e) });
    }
    await sleep(intervalSec * 1000);
  }
})();
