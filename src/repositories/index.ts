/**
 * repositories 聚合导出
 *
 * 用法（main 启动）：
 * ```ts
 * const db = openDatabase(config.dbPath); migrate(db);
 * const repos = createRepositories(db, { snapshotCompression: 'brotli', ... });
 * initRepositories(repos);                       // 或 initRepositories(db) 自动 create
 * ```
 * 路由/服务层无注入时：`getRepositories()`（未初始化抛错，便于测试发现）。
 * 单元测试推荐直接 `createRepositories(openMemoryDatabase())`，不依赖全局单例。
 */
import type { CompressionEncoding } from '../utils/compress.js';
import type { DbConnection } from './sql.js';

import { MetaRepository } from './meta.js';
import { GoalsRepository } from './goals.js';
import { GoalRunsRepository } from './runs.js';
import { SourceQueriesRepository } from './sourceQueries.js';
import { SnapshotsRepository } from './snapshots.js';
import { LeadsRepository } from './leads.js';
import { CompaniesRepository } from './companies.js';
import { CompanySourcesRepository } from './companySources.js';
import { CompanyContactsRepository } from './contacts.js';
import { PipelineJobsRepository } from './jobs.js';
import { UnlockLedgerRepository } from './unlockLedger.js';
import { ChangeEventsRepository } from './changeEvents.js';
import { WebhooksRepository } from './webhooks.js';
import { QuotaRepository } from './quota.js';
import { SourceHealthRepository } from './sourceHealth.js';
import { RegionsRepository } from './regions.js';
import { PlatformProfilesRepository } from './platformProfiles.js';
import { PlatformJobsRepository } from './platformJobs.js';
import { CustomsProfilesRepository } from './customs.js';

export * from './types.js';
export { type DbConnection, type SqlParam } from './sql.js';

export { MetaRepository } from './meta.js';
export { GoalsRepository } from './goals.js';
export { GoalRunsRepository, mergeStats } from './runs.js';
export { SourceQueriesRepository } from './sourceQueries.js';
export { SnapshotsRepository, type SnapshotsRepositoryOptions } from './snapshots.js';
export { CompaniesRepository, escapeLike } from './companies.js';
export { CompanySourcesRepository } from './companySources.js';
export { CompanyContactsRepository } from './contacts.js';
export { PipelineJobsRepository, type PipelineJobsRepositoryOptions, type EnqueueInput } from './jobs.js';
export { UnlockLedgerRepository } from './unlockLedger.js';
export { ChangeEventsRepository } from './changeEvents.js';
export { WebhooksRepository, type WebhooksRepositoryOptions } from './webhooks.js';
export { QuotaRepository } from './quota.js';
export { SourceHealthRepository } from './sourceHealth.js';
export { RegionsRepository } from './regions.js';
export {
  PlatformProfilesRepository,
  type PlatformProfilesRepositoryOptions,
} from './platformProfiles.js';
export { PlatformJobsRepository } from './platformJobs.js';
export { CustomsProfilesRepository, type CustomsProfilesRepositoryOptions } from './customs.js';

export interface RepositoriesOptions {
  /** raw_blobs 默认压缩算法（默认 brotli） */
  snapshotCompression?: CompressionEncoding | 'none';
  /** brotli 质量（默认 5，快照场景够用） */
  brotliQuality?: number;
  /** pipeline_jobs 默认租约秒数（默认 60） */
  jobLeaseSec?: number;
  /** pipeline_jobs 默认最大尝试次数（默认 3） */
  jobMaxAttempts?: number;
  /** webhook 投递最大尝试次数（默认 8） */
  webhookMaxAttempts?: number;
  /** 招聘/店铺刷新周期（天，默认 7/30） */
  jobRefreshDays?: number;
  storeRefreshDays?: number;
  /** 海关画像刷新周期（天，默认 30） */
  customsRefreshDays?: number;
}

export interface Repositories {
  meta: MetaRepository;
  goals: GoalsRepository;
  runs: GoalRunsRepository;
  /** runs 别名 */
  goalRuns: GoalRunsRepository;
  sourceQueries: SourceQueriesRepository;
  snapshots: SnapshotsRepository;
  /** snapshots 别名 */
  rawSnapshots: SnapshotsRepository;
  companies: CompaniesRepository;
  leads: LeadsRepository;
  companySources: CompanySourcesRepository;
  contacts: CompanyContactsRepository;
  jobs: PipelineJobsRepository;
  /** jobs 别名 */
  pipelineJobs: PipelineJobsRepository;
  unlockLedger: UnlockLedgerRepository;
  changeEvents: ChangeEventsRepository;
  webhooks: WebhooksRepository;
  quota: QuotaRepository;
  sourceHealth: SourceHealthRepository;
  regions: RegionsRepository;
  platformProfiles: PlatformProfilesRepository;
  platformJobs: PlatformJobsRepository;
  customs: CustomsProfilesRepository;
  /** customs 别名 */
  customsProfiles: CustomsProfilesRepository;
  /** 事务 helper（与 db.transaction 等价，便于 service 层使用） */
  transaction<T>(fn: () => T): T;
  /** 底层连接（admin/backup 用） */
  readonly db: DbConnection;
}

export function createRepositories(
  db: DbConnection,
  opts: RepositoriesOptions = {},
): Repositories {
  const jobs = new PipelineJobsRepository(db, {
    leaseSec: opts.jobLeaseSec,
    maxAttempts: opts.jobMaxAttempts,
  });
  const snapshots = new SnapshotsRepository(db, {
    encoding: opts.snapshotCompression,
    brotliQuality: opts.brotliQuality,
  });
  const customs = new CustomsProfilesRepository(db, { refreshDays: opts.customsRefreshDays });
  const repos: Repositories = {
    meta: new MetaRepository(db),
    goals: new GoalsRepository(db),
    runs: new GoalRunsRepository(db),
    goalRuns: undefined as unknown as GoalRunsRepository,
    sourceQueries: new SourceQueriesRepository(db),
    snapshots,
    rawSnapshots: snapshots,
    companies: new CompaniesRepository(db),
    leads: new LeadsRepository(db),
    companySources: new CompanySourcesRepository(db),
    contacts: new CompanyContactsRepository(db),
    jobs,
    pipelineJobs: jobs,
    unlockLedger: new UnlockLedgerRepository(db),
    changeEvents: new ChangeEventsRepository(db),
    webhooks: new WebhooksRepository(db, { maxAttempts: opts.webhookMaxAttempts }),
    quota: new QuotaRepository(db),
    sourceHealth: new SourceHealthRepository(db),
    regions: new RegionsRepository(db),
    platformProfiles: new PlatformProfilesRepository(db, {
      jobRefreshDays: opts.jobRefreshDays,
      storeRefreshDays: opts.storeRefreshDays,
    }),
    platformJobs: new PlatformJobsRepository(db),
    customs,
    customsProfiles: customs,
    transaction: <T>(fn: () => T): T => db.transaction(fn),
    db,
  };
  // runs 别名指向同一实例（保持对象引用一致，便于 mock/spy）
  (repos as { goalRuns: GoalRunsRepository }).goalRuns = repos.runs;
  return repos;
}

// ---------------------------------------------------------------------------
// 全局单例（api-dev 路由 / 服务层无注入时使用）
// ---------------------------------------------------------------------------

let singleton: Repositories | null = null;

/** 初始化全局 repositories：传 DbConnection 时自动 create */
export function initRepositories(dbOrRepos?: DbConnection | Repositories, opts?: RepositoriesOptions): Repositories {
  if (!dbOrRepos) {
    if (!singleton) {
      throw new Error(
        'initRepositories requires a db connection or repositories instance (pass db from src/db/index.ts)',
      );
    }
    return singleton;
  }
  singleton = isRepositories(dbOrRepos) ? dbOrRepos : createRepositories(dbOrRepos, opts);
  return singleton;
}

export function setRepositories(repos: Repositories): void {
  singleton = repos;
}

export function getRepositories(): Repositories {
  if (!singleton) {
    throw new Error(
      'repositories not initialized: call initRepositories(db) at startup or setRepositories(repos)',
    );
  }
  return singleton;
}

export function tryGetRepositories(): Repositories | null {
  return singleton;
}

export function resetRepositoriesForTests(): void {
  singleton = null;
}

/** 结构判断：repos 具有 jobs/companies 等仓库字段；DbConnection 具有 raw/transaction */
export function isRepositories(value: unknown): value is Repositories {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Repositories> & { raw?: unknown };
  return (
    typeof (candidate as { jobs?: unknown }).jobs === 'object' &&
    typeof (candidate as { companies?: unknown }).companies === 'object' &&
    typeof (candidate as { meta?: unknown }).meta === 'object'
  );
}
