/**
 * 环境变量快照/覆盖 helper。
 *
 * 注意：LeadPlatform 的 `src/config.ts` 在模块加载时读取 process.env 生成 config 单例，
 * 因此**必须在第一次 import src 模块之前**应用测试环境变量。
 * 用法：
 *   const restore = applyEnv(buildLeadTestEnv({...}));
 *   const { buildServer } = await import('../../src/http/server.js');
 *   ...
 *   restore();
 */
import type { MockUpstreams } from '../mock-upstreams/index.js';
import type { TempSandbox } from './tmp.js';

export const TEST_API_TOKEN = 'test-lead-api-token-0123456789abcdef';

export interface LeadTestEnvOptions {
  sandbox: TempSandbox;
  mocks: MockUpstreams;
  token?: string;
  port?: number;
  schedulerEnabled?: boolean;
  refreshWorkerEnabled?: boolean;
  quotaPollSec?: number;
  runMaxHours?: number;
  extra?: Record<string, string>;
}

/** 生成指向 mock 上游、临时目录的最小测试环境变量集合 */
export function buildLeadTestEnv(opts: LeadTestEnvOptions): Record<string, string> {
  const { sandbox, mocks } = opts;
  return {
    NODE_ENV: 'test',
    LEAD_API_TOKEN: opts.token ?? TEST_API_TOKEN,
    LEAD_HOST: '127.0.0.1',
    LEAD_PORT: String(opts.port ?? 8793),
    LEAD_DATA_DIR: sandbox.dir,
    LEAD_DB: sandbox.dbPath,
    LEAD_LOG_LEVEL: 'error',
    LEAD_TZ: 'Asia/Shanghai',
    LEAD_SCHEDULER_ENABLED: String(opts.schedulerEnabled ?? false),
    LEAD_REFRESH_WORKER_ENABLED: String(opts.refreshWorkerEnabled ?? false),
    LEAD_QUOTA_POLL_SEC: String(opts.quotaPollSec ?? 600),
    LEAD_RUN_MAX_HOURS: String(opts.runMaxHours ?? 6),
    LEAD_ARCHIVE_DIR: sandbox.archiveDir,
    LEAD_BACKUP_DIR: sandbox.backupDir,
    LEAD_SNAPSHOT_COMPRESSION: 'brotli',
    ...mocks.env(),
    ...(opts.extra ?? {}),
  };
}

export interface EnvRestore {
  /** 恢复应用前的环境变量 */
  restore(): void;
  /** 本轮覆盖的 key → 原值（undefined 表示原本不存在） */
  applied: Record<string, string | undefined>;
}

/** 临时应用环境变量，返回恢复函数 */
export function applyEnv(env: Record<string, string>): EnvRestore {
  const applied: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    applied[k] = process.env[k];
    process.env[k] = v;
  }
  return {
    applied,
    restore() {
      for (const [k, prev] of Object.entries(applied)) {
        if (prev === undefined) delete process.env[k];
        else process.env[k] = prev;
      }
    },
  };
}

/** 从 mock upstreams 生成上游连接 env（同 mocks.env()，便于单独使用） */
export function upstreamEnv(mocks: MockUpstreams): Record<string, string> {
  return mocks.env();
}
