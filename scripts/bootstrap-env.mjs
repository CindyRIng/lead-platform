#!/usr/bin/env node
/**
 * 从本机上游客户端配置生成 LeadPlatform .env（0600）。
 * - 读取 boss/zhilian/ali 的 .env token
 * - 读取 tanji(~/.tanji-client/config.json.apiToken) / fuma(~/.fuma-platform/config.json.server.apiToken)
 * - 生成 LEAD_API_TOKEN（随机）
 * 用法：node scripts/bootstrap-env.mjs [--force]
 * 注意：.env 已被 .gitignore 排除，不会提交到 GitHub。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const HOME = process.env.HOME || '/home/songqian';
const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const force = process.argv.includes('--force');

function envValue(file, key) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(txt);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}
function jsonValue(file, picker) {
  try {
    return picker(JSON.parse(fs.readFileSync(file, 'utf8'))) || '';
  } catch {
    return '';
  }
}

const existing = fs.existsSync(ENV_FILE) && !force ? parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) : {};
function parseEnv(txt) {
  const out = {};
  for (const line of txt.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const bossToken = envValue(path.join(HOME, 'boss-client/.env'), 'BOSS_API_TOKEN');
const zhilianToken = envValue(path.join(HOME, 'zhilian-client/.env'), 'ZHILIAN_API_TOKEN');
const aliToken = envValue(path.join(HOME, 'ali-client/.env'), 'ALI_API_TOKEN');
const tanjiToken = jsonValue(path.join(HOME, '.tanji-client/config.json'), (j) => j.apiToken);
const fumaToken = jsonValue(path.join(HOME, '.fuma-platform/config.json'), (j) => j?.server?.apiToken);

const apiToken = existing.LEAD_API_TOKEN || randomBytes(32).toString('hex');

const lines = [
  '# LeadPlatform 本地环境（由 scripts/bootstrap-env.mjs 生成；勿提交）',
  `LEAD_API_TOKEN=${apiToken}`,
  'LEAD_PORT=8793',
  'LEAD_DB=~/.lead-platform/lead.db',
  'LEAD_LOG_LEVEL=info',
  'LEAD_TZ=Asia/Shanghai',
  'LEAD_SCHEDULER_ENABLED=true',
  'LEAD_RUN_MAX_HOURS=6',
  'LEAD_JOB_LEASE_SEC=60',
  'LEAD_JOB_MAX_ATTEMPTS=3',
  'LEAD_QUOTA_POLL_SEC=600',
  'LEAD_SNAPSHOT_COMPRESSION=brotli',
  'LEAD_ARCHIVE_AFTER_DAYS=90',
  'LEAD_ARCHIVE_DIR=~/.lead-platform/archive',
  'LEAD_REFRESH_WORKER_ENABLED=true',
  'LEAD_JOB_REFRESH_DAYS=7',
  'LEAD_STORE_REFRESH_DAYS=30',
  'LEAD_CUSTOMS_REFRESH_DAYS=30',
  'LEAD_PLATFORM_ACTIVE_DAYS=8',
  'LEAD_PLATFORM_LOST_DAYS=45',
  'LEAD_UNLOCK_DAILY_CAP=',
  'LEAD_WEBHOOK_MAX_ATTEMPTS=8',
  '',
  '# 上游客户端（loopback）',
  'BOSS_CLIENT_URL=http://127.0.0.1:8790',
  `BOSS_API_TOKEN=${existing.BOSS_API_TOKEN || bossToken}`,
  'ZHILIAN_CLIENT_URL=http://127.0.0.1:8791',
  `ZHILIAN_API_TOKEN=${existing.ZHILIAN_API_TOKEN || zhilianToken}`,
  'ALI_CLIENT_URL=http://127.0.0.1:8792',
  `ALI_API_TOKEN=${existing.ALI_API_TOKEN || aliToken}`,
  'MIC_CLIENT_URL=http://127.0.0.1:8899',
  'TANJI_CLIENT_URL=http://127.0.0.1:8787',
  `TANJI_API_TOKEN=${existing.TANJI_API_TOKEN || tanjiToken}`,
  'FUMA_CLIENT_URL=http://127.0.0.1:17890',
  `FUMA_API_TOKEN=${existing.FUMA_API_TOKEN || fumaToken}`,
  'FUMA_ACCOUNT_ID=acct_01',
  '',
  '# 默认关键词（河北）',
  'LEAD_DEFAULT_KEYWORDS_BOSS=外贸,外贸业务员,外贸经理,外贸单证员,国际贸易,跨境电商,外贸跟单,外贸专员,海外销售,国际业务',
  'LEAD_DEFAULT_KEYWORDS_ZHILIAN=外贸,外贸业务员,外贸经理,外贸单证员,国际贸易,跨境电商,外贸跟单,外贸专员,海外销售,国际业务',
  'LEAD_DEFAULT_KEYWORDS_ALI=machinery,hardware,auto parts,pipe fitting,glass,bicycle,furniture',
  'LEAD_MAX_PAGES_PER_QUERY=',
  '',
];

fs.writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
fs.chmodSync(ENV_FILE, 0o600);
const missing = [];
if (!(existing.BOSS_API_TOKEN || bossToken)) missing.push('BOSS_API_TOKEN');
if (!(existing.ZHILIAN_API_TOKEN || zhilianToken)) missing.push('ZHILIAN_API_TOKEN');
if (!(existing.ALI_API_TOKEN || aliToken)) missing.push('ALI_API_TOKEN');
if (!(existing.TANJI_API_TOKEN || tanjiToken)) missing.push('TANJI_API_TOKEN');
if (!(existing.FUMA_API_TOKEN || fumaToken)) missing.push('FUMA_API_TOKEN');
console.log(`[bootstrap-env] wrote ${ENV_FILE} (0600)`);
console.log(`[bootstrap-env] LEAD_API_TOKEN ${existing.LEAD_API_TOKEN ? 'reused' : 'generated'}`);
if (missing.length) console.warn(`[bootstrap-env] missing upstream tokens (服务仍可启动，但对应来源不可用): ${missing.join(', ')}`);
