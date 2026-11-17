/**
 * 配置加载（Lead 冻结基线）
 * 优先级：process.env > ./.env > ~/.lead-platform/config.json > 默认值
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const HOME = process.env.HOME || '/home/songqian';
const ROOT = process.cwd();

function parseDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

const BoolStr = z.enum(['true', 'false']).or(z.boolean()).transform((v) => (typeof v === 'boolean' ? v : v === 'true'));
const OptInt = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

const ConfigSchema = z.object({
  nodeEnv: z.string().default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(8793),
  host: z.string().default('127.0.0.1'),
  apiToken: z.string().min(16, 'LEAD_API_TOKEN 必须 >=16 字符'),
  dataDir: z.string().default('~/.lead-platform'),
  dbPath: z.string().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  tz: z.string().default('Asia/Shanghai'),
  publicBaseUrl: z.string().default('http://127.0.0.1:8793'),

  schedulerEnabled: BoolStr.default(true),
  runMaxHours: z.coerce.number().int().positive().default(6),
  jobLeaseSec: z.coerce.number().int().positive().default(60),
  jobMaxAttempts: z.coerce.number().int().positive().default(3),
  quotaPollSec: z.coerce.number().int().positive().default(600),
  quotaPollerEnabled: BoolStr.default(true),
  unlockDailyCap: OptInt,
  webhookMaxAttempts: z.coerce.number().int().positive().default(8),

  snapshotCompression: z.enum(['brotli', 'gzip', 'none']).default('brotli'),
  archiveAfterDays: z.coerce.number().int().nonnegative().default(90),
  archiveDir: z.string().default('~/.lead-platform/archive'),
  backupDir: z.string().default('~/.lead-platform/backups'),

  refreshWorkerEnabled: BoolStr.default(true),
  jobRefreshDays: z.coerce.number().int().positive().default(7),
  storeRefreshDays: z.coerce.number().int().positive().default(30),
  customsRefreshDays: z.coerce.number().int().positive().default(30),
  customsMaxPageSize: z.coerce.number().int().positive().max(100).default(20),
  platformActiveDays: z.coerce.number().int().positive().default(8),
  platformLostDays: z.coerce.number().int().positive().default(45),

  bossUrl: z.string().default('http://127.0.0.1:8790'),
  bossToken: z.string().default(''),
  zhilianUrl: z.string().default('http://127.0.0.1:8791'),
  zhilianToken: z.string().default(''),
  aliUrl: z.string().default('http://127.0.0.1:8792'),
  aliToken: z.string().default(''),
  micUrl: z.string().default('http://127.0.0.1:8899'),
  tanjiUrl: z.string().default('http://127.0.0.1:8787'),
  tanjiToken: z.string().default(''),
  fumaUrl: z.string().default('http://127.0.0.1:17890'),
  fumaToken: z.string().default(''),
  fumaAccountId: z.string().default('acct_01'),

  defaultKeywordsBoss: z.array(z.string()).default([]),
  defaultKeywordsZhilian: z.array(z.string()).default([]),
  defaultKeywordsAli: z.array(z.string()).default([]),
  maxPagesPerQuery: OptInt,
});

export type AppConfig = z.infer<typeof ConfigSchema>;

const FILE_ENV = parseDotenv(path.join(ROOT, '.env'));
const USER_ENV: Record<string, string> = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HOME, '.lead-platform/config.json'), 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
})();

function pick(envKey: string, cfgKey?: string): string | undefined {
  return process.env[envKey] ?? FILE_ENV[envKey] ?? (cfgKey ? USER_ENV[cfgKey] : undefined);
}

function csv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<Record<string, unknown>> = {}): AppConfig {
  const dataDir = expandHome(String(pick('LEAD_DATA_DIR') ?? '~/.lead-platform'));
  const raw = {
    nodeEnv: pick('NODE_ENV') ?? 'development',
    port: pick('LEAD_PORT') ?? '8793',
    host: pick('LEAD_HOST') ?? '127.0.0.1',
    apiToken: pick('LEAD_API_TOKEN') ?? '',
    dataDir,
    dbPath: expandHome(String(pick('LEAD_DB') ?? path.join(dataDir, 'lead.db'))),
    logLevel: pick('LEAD_LOG_LEVEL') ?? 'info',
    tz: pick('LEAD_TZ') ?? 'Asia/Shanghai',
    publicBaseUrl: pick('LEAD_PUBLIC_BASE_URL') ?? `http://127.0.0.1:${pick('LEAD_PORT') ?? '8793'}`,
    schedulerEnabled: pick('LEAD_SCHEDULER_ENABLED') ?? 'true',
    runMaxHours: pick('LEAD_RUN_MAX_HOURS') ?? '6',
    jobLeaseSec: pick('LEAD_JOB_LEASE_SEC') ?? '60',
    jobMaxAttempts: pick('LEAD_JOB_MAX_ATTEMPTS') ?? '3',
    quotaPollSec: pick('LEAD_QUOTA_POLL_SEC') ?? '600',
    quotaPollerEnabled: pick('LEAD_QUOTA_POLLER_ENABLED') ?? 'true',
    unlockDailyCap: pick('LEAD_UNLOCK_DAILY_CAP') ?? '',
    webhookMaxAttempts: pick('LEAD_WEBHOOK_MAX_ATTEMPTS') ?? '8',
    snapshotCompression: pick('LEAD_SNAPSHOT_COMPRESSION') ?? 'brotli',
    archiveAfterDays: pick('LEAD_ARCHIVE_AFTER_DAYS') ?? '90',
    archiveDir: expandHome(String(pick('LEAD_ARCHIVE_DIR') ?? path.join(dataDir, 'archive'))),
    backupDir: expandHome(String(pick('LEAD_BACKUP_DIR') ?? path.join(dataDir, 'backups'))),
    refreshWorkerEnabled: pick('LEAD_REFRESH_WORKER_ENABLED') ?? 'true',
    jobRefreshDays: pick('LEAD_JOB_REFRESH_DAYS') ?? '7',
    storeRefreshDays: pick('LEAD_STORE_REFRESH_DAYS') ?? '30',
    customsRefreshDays: pick('LEAD_CUSTOMS_REFRESH_DAYS') ?? '30',
    customsMaxPageSize: pick('LEAD_CUSTOMS_MAX_PAGE_SIZE') ?? '20',
    platformActiveDays: pick('LEAD_PLATFORM_ACTIVE_DAYS') ?? '8',
    platformLostDays: pick('LEAD_PLATFORM_LOST_DAYS') ?? '45',
    bossUrl: pick('BOSS_CLIENT_URL') ?? 'http://127.0.0.1:8790',
    bossToken: pick('BOSS_API_TOKEN') ?? '',
    zhilianUrl: pick('ZHILIAN_CLIENT_URL') ?? 'http://127.0.0.1:8791',
    zhilianToken: pick('ZHILIAN_API_TOKEN') ?? '',
    aliUrl: pick('ALI_CLIENT_URL') ?? 'http://127.0.0.1:8792',
    aliToken: pick('ALI_API_TOKEN') ?? '',
    micUrl: pick('MIC_CLIENT_URL') ?? 'http://127.0.0.1:8899',
    tanjiUrl: pick('TANJI_CLIENT_URL') ?? 'http://127.0.0.1:8787',
    tanjiToken: pick('TANJI_API_TOKEN') ?? '',
    fumaUrl: pick('FUMA_CLIENT_URL') ?? 'http://127.0.0.1:17890',
    fumaToken: pick('FUMA_API_TOKEN') ?? '',
    fumaAccountId: pick('FUMA_ACCOUNT_ID') ?? 'acct_01',
    defaultKeywordsBoss: csv(pick('LEAD_DEFAULT_KEYWORDS_BOSS')),
    defaultKeywordsZhilian: csv(pick('LEAD_DEFAULT_KEYWORDS_ZHILIAN')),
    defaultKeywordsAli: csv(pick('LEAD_DEFAULT_KEYWORDS_ALI')),
    maxPagesPerQuery: pick('LEAD_MAX_PAGES_PER_QUERY') ?? '',
    ...overrides,
  };
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`配置校验失败: ${msg}`);
  }
  return parsed.data;
}

export function ensureConfigDirs(cfg: AppConfig): void {
  for (const dir of [cfg.dataDir, path.dirname(cfg.dbPath ?? ''), cfg.archiveDir, cfg.backupDir]) {
    if (!dir) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export const config: AppConfig = loadConfig();
export function getConfig(): AppConfig {
  return config;
}
export const projectRoot = ROOT;
