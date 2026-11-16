/**
 * 平台档案/岗位 Refresh Worker（R1）
 *
 * 设计见 docs/07-平台档案与招聘信息.md 与 docs/02 §11.5：
 *  - 新公司即时：4 平台 platform_profile + Boss/智联 platform_jobs；
 *  - 存量：招聘每周（Boss/智联，platform_profile + platform_jobs 两任务）、店铺每月（Ali/Mic，platform_profile）；
 *  - 后台常驻、按来源限频涓流（限频在 S2/S3 adapter 内部，Worker 只保证单进程串行 + 单轮上限）；
 *  - 平台档案字段 diff → change_events（field=platforms.<platform>.<field>，source=source:<platform>）；
 *  - 岗位生命周期：出现→active、消失→closed、closed 再出现→active（保留 first_seen_at）；
 *    岗位批量变化聚合成一条 platforms.<platform>.jobs 事件（避免事件风暴）；
 *  - platform_status：active ≤ 8 天 / stale 9–45 天 / lost > 45 天或连续 3 次 404。
 *
 * 依赖注入：repos（F2 repositories）、adapters（S2/S3 适配器 narrow port）、config/logger/clock；
 * 单测可完全 mock，不访问网络。
 */
import type { Repositories } from '../repositories/index.js';
import type { ChangeEventInput, Platform, PlatformJob, PlatformProfile, PlatformStatus } from '../shared/domain.js';
import type { NormalizedJob, PlatformCompanyDetail, PlatformProfileFields } from '../adapters/sources/types.js';
import { BossAdapter } from '../adapters/sources/boss.js';
import { ZhilianAdapter } from '../adapters/sources/zhilian.js';
import { AliAdapter } from '../adapters/sources/ali.js';
import { MicAdapter } from '../adapters/sources/mic.js';
import { LeadError, toLeadError } from '../shared/errors.js';
import { isoPlusDays, isoPlusSeconds, nowIso } from '../shared/time.js';
import { asArray, asRecord } from '../shared/json.js';

// ---------------------------------------------------------------------------
// 常量 / 配置
// ---------------------------------------------------------------------------

export const PLATFORM_PROFILE_STAGE = 'platform_profile';
export const PLATFORM_JOBS_STAGE = 'platform_jobs';

export const PLATFORM_DETAIL_SNAPSHOT_KIND = 'platform_company_detail';
export const PLATFORM_JOBS_SNAPSHOT_KIND = 'platform_company_jobs';

export const RECRUITMENT_PLATFORMS: ReadonlyArray<'boss' | 'zhilian'> = ['boss', 'zhilian'];
export const STORE_PLATFORMS: ReadonlyArray<'ali' | 'mic'> = ['ali', 'mic'];

/** platform 字段 diff 的一等字段（docs/07 §4.2：JSON 字段整块哈希比较） */
export const PLATFORM_PROFILE_DIFF_FIELDS: ReadonlyArray<keyof PlatformProfileFields | 'platformStatus'> = [
  'displayName',
  'sourceUrl',
  'fullName',
  'cityName',
  'address',
  'industry',
  'scale',
  'stage',
  'logoUrl',
  'intro',
  'tags',
  'benefits',
  'jobCount',
  'bossCount',
  'recruiters',
  'store',
  'platformStatus',
];

export interface PipelineLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: PipelineLogger = {};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export interface PlatformRefreshConfig {
  workerId: string;
  leaseSec: number;
  jobMaxAttempts: number;
  /** 招聘（Boss/智联）刷新周期（天） */
  jobRefreshDays: number;
  /** 店铺（Ali/Mic）刷新周期（天） */
  storeRefreshDays: number;
  /** 单轮最多执行任务数（限频兜底；adapter 内部还有来源级限频） */
  maxJobsPerTick: number;
  /** 单轮扫描到期档案/公司上限 */
  dueScanLimit: number;
  /** 单公司单平台单次岗位抓取上限（超过截断且不关闭未出现岗位） */
  maxJobsPerCompany: number;
  /** active ≤ N 天 */
  activeDays: number;
  /** lost > N 天 */
  lostDays: number;
}

export function resolvePlatformRefreshConfig(partial?: Partial<PlatformRefreshConfig>): PlatformRefreshConfig {
  return {
    workerId: partial?.workerId ?? `platform-refresh:${process.pid}`,
    leaseSec: Math.max(1, partial?.leaseSec ?? envInt('LEAD_JOB_LEASE_SEC', 60)),
    jobMaxAttempts: Math.max(1, partial?.jobMaxAttempts ?? envInt('LEAD_JOB_MAX_ATTEMPTS', 3)),
    jobRefreshDays: Math.max(1, partial?.jobRefreshDays ?? envInt('LEAD_JOB_REFRESH_DAYS', 7)),
    storeRefreshDays: Math.max(1, partial?.storeRefreshDays ?? envInt('LEAD_STORE_REFRESH_DAYS', 30)),
    maxJobsPerTick: Math.max(1, partial?.maxJobsPerTick ?? envInt('LEAD_REFRESH_JOBS_PER_TICK', 10)),
    dueScanLimit: Math.max(1, partial?.dueScanLimit ?? envInt('LEAD_REFRESH_DUE_SCAN_LIMIT', 50)),
    maxJobsPerCompany: Math.max(1, partial?.maxJobsPerCompany ?? envInt('LEAD_MAX_JOBS_PER_COMPANY', 500)),
    activeDays: Math.max(1, partial?.activeDays ?? envInt('LEAD_PLATFORM_ACTIVE_DAYS', 8)),
    lostDays: Math.max(1, partial?.lostDays ?? envInt('LEAD_PLATFORM_LOST_DAYS', 45)),
  };
}

// ---------------------------------------------------------------------------
// 平台状态 / 刷新时间（纯函数）
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export interface PlatformStatusOptions {
  activeDays?: number;
  lostDays?: number;
}

/** 平台状态判定（docs/07 §3.3）：active ≤8d；stale 9–45d；lost >45d（或 404×3，由 Worker 显式写入） */
export function computePlatformStatus(
  lastFetchedAt: string | null | undefined,
  now: Date = new Date(),
  options: PlatformStatusOptions = {},
): PlatformStatus {
  const activeDays = options.activeDays ?? 8;
  const lostDays = options.lostDays ?? 45;
  if (!lastFetchedAt) return 'stale';
  const fetched = Date.parse(lastFetchedAt);
  if (!Number.isFinite(fetched)) return 'stale';
  const ageDays = (now.getTime() - fetched) / DAY_MS;
  if (ageDays < 0) return 'active';
  if (ageDays <= activeDays) return 'active';
  if (ageDays <= lostDays) return 'stale';
  return 'lost';
}

export function isRefreshDue(nextRefreshAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!nextRefreshAt) return true;
  const at = Date.parse(nextRefreshAt);
  return !Number.isFinite(at) || at <= now.getTime();
}

export function nextJobsRefreshAt(from: Date, days: number): string {
  return isoPlusDays(days, from);
}

export function nextStoreRefreshAt(from: Date, days: number): string {
  return isoPlusDays(days, from);
}

// ---------------------------------------------------------------------------
// 档案字段 diff / 事件（纯函数）
// ---------------------------------------------------------------------------

export interface ProfileFieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  valueType: string;
}

type ProfileDiffable = Partial<PlatformProfileFields> & { platformStatus?: PlatformStatus | string | null };

function normalizeDiffValue(value: unknown): unknown {
  if (value === undefined) return null;
  return value;
}

function stableValue(value: unknown): string {
  return JSON.stringify(normalizeDiffValue(value));
}

function valueTypeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'json';
}

/** 平台档案字段 diff：只对一等字段比较；JSON 字段（tags/benefits/recruiters/store）整块比较 */
export function diffPlatformProfile(previous: ProfileDiffable | null, next: ProfileDiffable): ProfileFieldDiff[] {
  const diffs: ProfileFieldDiff[] = [];
  for (const field of PLATFORM_PROFILE_DIFF_FIELDS) {
    const oldValue = previous ? (previous as Record<string, unknown>)[field] ?? null : null;
    const newValue = (next as Record<string, unknown>)[field] ?? null;
    if (stableValue(oldValue) !== stableValue(newValue)) {
      diffs.push({ field, oldValue: normalizeDiffValue(oldValue), newValue: normalizeDiffValue(newValue), valueType: valueTypeOf(newValue) });
    }
  }
  return diffs;
}

export interface PlatformProfileChangeEventOptions {
  companyId: string;
  platform: Platform;
  entityId: string | null;
  version: number;
  occurredAt: string;
  source?: string;
  runId?: string | null;
  actor?: string;
}

/** 档案字段 diff → change_events（field=platforms.<platform>.<field>，source=source:<platform>） */
export function buildProfileChangeEvents(
  diffs: ProfileFieldDiff[],
  options: PlatformProfileChangeEventOptions,
): ChangeEventInput[] {
  const source = options.source ?? `source:${options.platform}`;
  return diffs.map((diff) => ({
    companyId: options.companyId,
    entityType: 'platform_profile' as const,
    entityId: options.entityId,
    version: options.version,
    eventType: 'platform.profile.updated',
    field: `platforms.${options.platform}.${diff.field}`,
    oldValue: diff.oldValue,
    newValue: diff.newValue,
    valueType: diff.valueType,
    source,
    runId: options.runId ?? null,
    actor: options.actor ?? 'refresh-worker',
    occurredAt: options.occurredAt,
  }));
}

// ---------------------------------------------------------------------------
// 岗位生命周期（纯函数）
// ---------------------------------------------------------------------------

export interface ExistingJobLike {
  jobId: string;
  status?: string | null;
}

export interface JobLifecyclePlan {
  /** 去重并截断后的在招岗位（全部应写为 active） */
  seen: NormalizedJob[];
  addedJobIds: string[];
  reactivatedJobIds: string[];
  closedJobIds: string[];
  previousActive: number;
  previousTotal: number;
  nextActive: number;
  nextTotal: number;
  /** 超过单次上限被截断：此时不关闭「未出现」岗位（列表可能不完整） */
  truncated: boolean;
}

/**
 * 岗位生命周期规划：最新在招列表出现 → active；之前 active 但本次不在列表 → closed；
 * closed 再次出现 → 重新上线（保留 first_seen_at，由 repo 处理）。
 */
export function planJobLifecycle(
  existing: ExistingJobLike[],
  fetched: NormalizedJob[],
  options: { maxJobs?: number } = {},
): JobLifecyclePlan {
  const maxJobs = options.maxJobs ?? 500;
  const truncated = fetched.length > maxJobs;
  const limited = truncated ? fetched.slice(0, maxJobs) : fetched;

  const seenMap = new Map<string, NormalizedJob>();
  for (const job of limited) {
    if (!job?.jobId) continue;
    if (!seenMap.has(job.jobId)) seenMap.set(job.jobId, job);
  }
  const seen = [...seenMap.values()];
  const seenIds = new Set(seenMap.keys());

  const existingByJobId = new Map<string, ExistingJobLike>();
  for (const row of existing) {
    if (row?.jobId) existingByJobId.set(row.jobId, row);
  }

  const addedJobIds: string[] = [];
  const reactivatedJobIds: string[] = [];
  for (const job of seen) {
    const prev = existingByJobId.get(job.jobId);
    if (!prev) addedJobIds.push(job.jobId);
    else if (prev.status === 'closed') reactivatedJobIds.push(job.jobId);
  }

  const closedJobIds: string[] = [];
  if (!truncated) {
    for (const row of existing) {
      if (row.status === 'active' && row.jobId && !seenIds.has(row.jobId)) closedJobIds.push(row.jobId);
    }
  }

  const previousActive = existing.filter((row) => row.status === 'active').length;
  const previousTotal = existing.length;

  return {
    seen,
    addedJobIds,
    reactivatedJobIds,
    closedJobIds,
    previousActive,
    previousTotal,
    nextActive: seen.length,
    nextTotal: previousTotal + addedJobIds.length,
    truncated,
  };
}

export interface PlatformJobsAggregateSummary {
  active: number;
  added: number;
  closed: number;
  total: number;
  reactivated?: number;
  truncated?: boolean;
}

/** 岗位变化聚合事件（field=platforms.<platform>.jobs，old/new={active,added,closed,total}） */
export function buildJobsAggregateEvent(
  previous: PlatformJobsAggregateSummary,
  next: PlatformJobsAggregateSummary,
  options: PlatformProfileChangeEventOptions,
): ChangeEventInput {
  const source = options.source ?? `source:${options.platform}`;
  return {
    companyId: options.companyId,
    entityType: 'platform_profile' as const,
    entityId: options.entityId,
    version: options.version,
    eventType: 'platform.jobs.updated',
    field: `platforms.${options.platform}.jobs`,
    oldValue: previous,
    newValue: next,
    valueType: 'json',
    source,
    runId: options.runId ?? null,
    actor: options.actor ?? 'refresh-worker',
    occurredAt: options.occurredAt,
  };
}

// ---------------------------------------------------------------------------
// 适配器 port（S2/S3 适配器结构子集；测试注入 mock）
// ---------------------------------------------------------------------------

export interface RecruitmentFetchPort {
  getCompanyDetail(platformCompanyId: string): Promise<PlatformCompanyDetail>;
  listCompanyJobs(platformCompanyId: string): Promise<NormalizedJob[]>;
}

export interface StoreFetchPort {
  getCompanyDetail(platformCompanyId: string): Promise<PlatformCompanyDetail>;
}

export interface PlatformRefreshAdapters {
  boss: RecruitmentFetchPort;
  zhilian: RecruitmentFetchPort;
  ali: StoreFetchPort;
  mic: StoreFetchPort;
}

/** Lead `src/config.ts` 的扁平字段（bossUrl/bossToken…；兼容旧命名 bossClientUrl/bossApiToken…） */
export interface PlatformRefreshConfigLike {
  bossUrl?: string;
  bossToken?: string | null;
  zhilianUrl?: string;
  zhilianToken?: string | null;
  aliUrl?: string;
  aliToken?: string | null;
  micUrl?: string;
  micToken?: string | null;
  bossClientUrl?: string;
  bossApiToken?: string | null;
  zhilianClientUrl?: string;
  zhilianApiToken?: string | null;
  aliClientUrl?: string;
  aliApiToken?: string | null;
  micClientUrl?: string;
  micApiToken?: string | null;
  refreshWorkerEnabled?: boolean;
}

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

/** 默认适配器（真实 S2/S3 适配器；运行时按 .env 的 loopback 地址构造） */
export function createDefaultPlatformAdapters(config: PlatformRefreshConfigLike = {}): PlatformRefreshAdapters {
  const boss = new BossAdapter({
    baseUrl: config.bossUrl ?? config.bossClientUrl ?? env('BOSS_CLIENT_URL', 'http://127.0.0.1:8790'),
    token: config.bossToken ?? config.bossApiToken ?? env('BOSS_API_TOKEN') ?? null,
  });
  const zhilian = new ZhilianAdapter({
    baseUrl: config.zhilianUrl ?? config.zhilianClientUrl ?? env('ZHILIAN_CLIENT_URL', 'http://127.0.0.1:8791'),
    token: config.zhilianToken ?? config.zhilianApiToken ?? env('ZHILIAN_API_TOKEN') ?? null,
  });
  const ali = new AliAdapter({
    baseUrl: config.aliUrl ?? config.aliClientUrl ?? env('ALI_CLIENT_URL', 'http://127.0.0.1:8792'),
    token: config.aliToken ?? config.aliApiToken ?? env('ALI_API_TOKEN') ?? null,
  });
  const mic = new MicAdapter({
    baseUrl: config.micUrl ?? config.micClientUrl ?? env('MIC_CLIENT_URL', 'http://127.0.0.1:8899'),
    token: config.micToken ?? config.micApiToken ?? env('MIC_API_TOKEN') ?? null,
  });
  return {
    boss,
    zhilian,
    ali: { getCompanyDetail: (platformCompanyId: string) => ali.getSupplierDetail(platformCompanyId) },
    mic: { getCompanyDetail: (platformCompanyId: string) => mic.getCompanyDetail(platformCompanyId, ['audit', 'response', 'reviews']) },
  };
}

// ---------------------------------------------------------------------------
// 数据访问小工具（对 F2 repositories 的唯一封装点；集成时只需改这里）
// ---------------------------------------------------------------------------

type AnyRepos = Repositories & Record<string, unknown>;
type AnyRecord = Record<string, unknown>;

function repoOf(repos: Repositories, ...names: string[]): AnyRecord | null {
  const target = repos as unknown as AnyRecord;
  for (const name of names) {
    const value = target[name];
    if (value && typeof value === 'object') return value as AnyRecord;
  }
  return null;
}

function callRepo<T = unknown>(repo: AnyRecord | null, methods: string[], ...args: unknown[]): T | undefined {
  if (!repo) return undefined;
  for (const method of methods) {
    const fn = repo[method];
    if (typeof fn === 'function') return (fn as (...params: unknown[]) => T).apply(repo, args);
  }
  return undefined;
}

export interface CompanySourceLike {
  platform: Platform;
  platformCompanyId: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
}

/** 读取公司各平台来源（company_sources）；兼容 F2 可能的几种方法命名 */
export async function listCompanySources(repos: Repositories, companyId: string): Promise<CompanySourceLike[]> {
  const repo = repoOf(repos as unknown as Repositories, 'companySources', 'sources');
  const result = callRepo<unknown>(repo, ['listByCompany', 'listByCompanyId', 'list'], companyId);
  const rows = asArray<AnyRecord>(result);
  return rows
    .map((row) => ({
      platform: String(row.platform ?? '') as Platform,
      platformCompanyId: String(row.platformCompanyId ?? row.platform_company_id ?? ''),
      sourceUrl: (row.sourceUrl ?? row.source_url ?? null) as string | null,
      sourceName: (row.sourceName ?? row.source_name ?? null) as string | null,
    }))
    .filter((row) => !!row.platform && !!row.platformCompanyId);
}

interface ClaimedJobLike {
  id: string;
  companyId: string;
  stage?: string | null;
  platform?: string | null;
  status?: string | null;
  attempts?: number | null;
  maxAttempts?: number | null;
}

interface JobRecordLike {
  id: string;
  companyId?: string;
  stage?: string;
  platform?: string | null;
  status?: string;
}

export type PlatformProfileRecord = PlatformProfile & { id: string; createdAt: string; updatedAt: string };
export type PlatformJobRecord = PlatformJob & { id: string; createdAt: string; updatedAt: string };

interface ProfileRepoLike {
  getByCompanyPlatform?(companyId: string, platform: string): PlatformProfileRecord | null;
  listByCompany?(companyId: string): PlatformProfileRecord[];
  upsert?(input: AnyRecord): { profile: PlatformProfileRecord; previous: PlatformProfileRecord | null; created: boolean };
  update?(id: string, patch: AnyRecord, opts?: { expectedVersion?: number; bumpVersion?: boolean }): PlatformProfileRecord | null;
  listDueJobs?(args?: { now?: string; limit?: number }): PlatformProfileRecord[];
  listDueStores?(args?: { now?: string; limit?: number }): PlatformProfileRecord[];
}

interface PlatformJobsRepoLike {
  listByCompanyPlatform?(companyId: string, platform: string, opts?: { status?: string }): PlatformJobRecord[];
  listByCompany?(companyId: string): PlatformJobRecord[];
  upsertJob?(input: AnyRecord): { job: PlatformJobRecord; previous: PlatformJobRecord | null; created: boolean };
  closeMissing?(companyId: string, platform: string, seenJobIds: string[], now?: string): PlatformJobRecord[];
}

interface JobsRepoLike {
  enqueue?(input: AnyRecord): { job: JobRecordLike; created: boolean };
  claimNext?(input: AnyRecord): ClaimedJobLike | { job?: ClaimedJobLike } | null;
  complete?(id: string): unknown;
  fail?(id: string, input: AnyRecord): unknown;
  retry?(id: string): JobRecordLike | null;
}

function asProfileRepo(repos: Repositories): ProfileRepoLike {
  return (repoOf(repos as unknown as Repositories, 'platformProfiles') ?? {}) as ProfileRepoLike;
}

function asJobsRepo(repos: Repositories, kind: 'platformJobs' | 'jobs'): unknown {
  const repo = repoOf(repos as unknown as Repositories, kind, kind === 'platformJobs' ? 'jobs' : 'pipelineJobs');
  return repo ?? null;
}

function asPlatformJobsRepo(repos: Repositories): PlatformJobsRepoLike {
  return (asJobsRepo(repos, 'platformJobs') ?? {}) as PlatformJobsRepoLike;
}

function asQueueRepo(repos: Repositories): JobsRepoLike {
  return (repoOf(repos as unknown as Repositories, 'jobs', 'pipelineJobs') ?? {}) as JobsRepoLike;
}

function unwrapClaimed(value: unknown): ClaimedJobLike | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as AnyRecord;
  if (typeof record.id === 'string') return record as unknown as ClaimedJobLike;
  const job = record.job;
  if (job && typeof job === 'object' && typeof (job as AnyRecord).id === 'string') return job as unknown as ClaimedJobLike;
  return null;
}

// ---------------------------------------------------------------------------
// Worker 依赖 / 结果
// ---------------------------------------------------------------------------

export interface PlatformRefreshWorkerDeps {
  repos: Repositories;
  adapters?: PlatformRefreshAdapters;
  config?: Partial<PlatformRefreshConfig> & PlatformRefreshConfigLike;
  logger?: PipelineLogger;
  clock?: () => Date;
}

export interface PlatformRefreshResult {
  companyId: string;
  platform: Platform;
  kind: 'profile' | 'jobs';
  status: 'ok' | 'failed';
  changed: boolean;
  added: number;
  closed: number;
  reactivated: number;
  active: number;
  total: number;
  version: number;
  eventCount: number;
  rawSnapshotId: number | null;
}

export interface PlatformRefreshRunSummary {
  now: string;
  dueEnqueued: number;
  newCompaniesEnqueued: number;
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  profileChanged: number;
  jobsChanged: number;
  sessionInvalid: boolean;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 3600_000;

export class PlatformRefreshWorker {
  private readonly deps: PlatformRefreshWorkerDeps;
  private readonly config: PlatformRefreshConfig;
  private readonly logger: PipelineLogger;
  private readonly clock: () => Date;
  private readonly adapters: PlatformRefreshAdapters;

  constructor(deps: PlatformRefreshWorkerDeps) {
    this.deps = deps;
    this.config = resolvePlatformRefreshConfig(deps.config);
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.clock = deps.clock ?? (() => new Date());
    this.adapters = deps.adapters ?? createDefaultPlatformAdapters(deps.config ?? {});
  }

  getConfig(): PlatformRefreshConfig {
    return { ...this.config };
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private get repos(): Repositories {
    return this.deps.repos;
  }

  // -- 任务入队 ---------------------------------------------------------------

  private async ensurePendingJob(
    companyId: string,
    stage: string,
    platform: Platform | null,
  ): Promise<{ jobId: string | null; enqueued: boolean }> {
    const queue = asQueueRepo(this.repos);
    if (typeof queue.enqueue !== 'function') return { jobId: null, enqueued: false };
    const result = queue.enqueue({
      companyId,
      stage,
      platform,
      maxAttempts: this.config.jobMaxAttempts,
      // 周/月刷新需要让已 done/dead/failed 的同键任务复位为 pending
      resetExisting: true,
    }) as { job?: JobRecordLike; created?: boolean } | undefined;
    const job = result?.job ?? null;
    if (!job?.id) return { jobId: null, enqueued: false };
    return { jobId: job.id, enqueued: result?.created === true };
  }

  /** 新公司即时抓取：4 平台 platform_profile + Boss/智联 platform_jobs（幂等） */
  async enqueueNewCompany(companyId: string): Promise<string[]> {
    const company = this.repos.companies.getById(companyId);
    if (!company || company.mergedInto) return [];
    const sources = await listCompanySources(this.repos, companyId);
    const sourceByPlatform = new Map<Platform, CompanySourceLike>();
    for (const source of sources) sourceByPlatform.set(source.platform, source);
    const jobIds: string[] = [];
    for (const platform of ['boss', 'zhilian', 'ali', 'mic'] as Platform[]) {
      if (!sourceByPlatform.has(platform)) continue;
      const profileJob = await this.ensurePendingJob(companyId, PLATFORM_PROFILE_STAGE, platform);
      if (profileJob.jobId) jobIds.push(profileJob.jobId);
      if (platform === 'boss' || platform === 'zhilian') {
        const jobsJob = await this.ensurePendingJob(companyId, PLATFORM_JOBS_STAGE, platform);
        if (jobsJob.jobId) jobIds.push(jobsJob.jobId);
      }
    }
    return jobIds;
  }

  /**
   * 到期扫描：
   *  - 招聘（Boss/智联）每周：platform_profile + platform_jobs 两个任务（详情+岗位各一次请求）；
   *  - 店铺（Ali/Mic）每月：platform_profile 一个任务；
   *  - 同时把超过阈值的平台状态刷成 stale/lost（不 bump 版本）。
   */
  async enqueueDue(options?: { limit?: number }): Promise<{ jobs: number; newCompanies: number }> {
    const limit = options?.limit ?? this.config.dueScanLimit;
    const now = this.clock();
    const nowText = now.toISOString();
    const profiles = asProfileRepo(this.repos);
    let enqueued = 0;

    const markStatus = (profile: AnyRecord): void => {
      const platform = String(profile.platform ?? '') as Platform;
      const id = String(profile.id ?? '');
      const effective = computePlatformStatus(profile.lastFetchedAt as string | null, now, {
        activeDays: this.config.activeDays,
        lostDays: this.config.lostDays,
      });
      const stored = String(profile.platformStatus ?? '');
      if (id && effective !== stored && (effective === 'stale' || effective === 'lost')) {
        const update = typeof profiles.update === 'function' ? profiles.update.bind(profiles) : null;
        if (update) update(id, { platformStatus: effective }, { bumpVersion: false });
      }
      void platform;
    };

    const dueJobs = asArray<AnyRecord>(profiles.listDueJobs?.({ now: nowText, limit }) ?? []);
    for (const profile of dueJobs) {
      if (profile.platform !== 'boss' && profile.platform !== 'zhilian') continue;
      if (!profile.companyId) continue;
      const company = this.repos.companies.getById(String(profile.companyId));
      if (!company || company.mergedInto) continue;
      const sources = await listCompanySources(this.repos, String(profile.companyId));
      if (!sources.some((s) => s.platform === profile.platform)) continue;
      markStatus(profile);
      const profileJob = await this.ensurePendingJob(String(profile.companyId), PLATFORM_PROFILE_STAGE, profile.platform as Platform);
      const jobsJob = await this.ensurePendingJob(String(profile.companyId), PLATFORM_JOBS_STAGE, profile.platform as Platform);
      if (profileJob.enqueued) enqueued += 1;
      if (jobsJob.enqueued) enqueued += 1;
    }

    const dueStores = asArray<AnyRecord>(profiles.listDueStores?.({ now: nowText, limit }) ?? []);
    for (const profile of dueStores) {
      if (profile.platform !== 'ali' && profile.platform !== 'mic') continue;
      if (!profile.companyId) continue;
      const company = this.repos.companies.getById(String(profile.companyId));
      if (!company || company.mergedInto) continue;
      const sources = await listCompanySources(this.repos, String(profile.companyId));
      if (!sources.some((s) => s.platform === profile.platform)) continue;
      markStatus(profile);
      const result = await this.ensurePendingJob(String(profile.companyId), PLATFORM_PROFILE_STAGE, profile.platform as Platform);
      if (result.enqueued) enqueued += 1;
    }

    const newCompanies = await this.enqueueNewCompanies(limit);
    return { jobs: enqueued, newCompanies };
  }

  /**
   * 扫描已入库但尚未抓全平台档案的新公司（orchestrator 未显式 enqueue 时的兜底）。
   * 不依赖 enrichment_status（新公司可能很快从 discovered 变为 tanji_matched），
   * 而是按「有来源但档案数不足」判定，兼容任意处理阶段的公司。
   */
  async enqueueNewCompanies(limit: number): Promise<number> {
    const companiesRepo = repoOf(this.repos as unknown as Repositories, 'companies');
    if (!companiesRepo) return 0;
    const candidates = new Map<string, AnyRecord>();
    // 优先按来源平台扫描（覆盖任意 enrichment 状态）
    for (const platform of ['boss', 'zhilian', 'ali', 'mic'] as Platform[]) {
      const rows = asArray<AnyRecord>(callRepo<unknown>(companiesRepo, ['listWithPlatformSources'], platform, limit) ?? []);
      for (const row of rows) {
        const id = String(row.id ?? '');
        if (id) candidates.set(id, row);
      }
    }
    // 兼容回退：无 listWithPlatformSources 时扫描 discovered
    if (candidates.size === 0) {
      const rows = asArray<AnyRecord>(callRepo<unknown>(companiesRepo, ['listByEnrichmentStatus', 'listDiscovered'], 'discovered', limit) ?? []);
      for (const row of rows) {
        const id = String(row.id ?? '');
        if (id) candidates.set(id, row);
      }
    }
    let enqueued = 0;
    for (const [companyId, row] of candidates) {
      if (row.mergedInto) continue;
      const sources = await listCompanySources(this.repos, companyId);
      if (sources.length === 0) continue;
      const profileRepo = asProfileRepo(this.repos);
      const existing = asArray<PlatformProfileRecord>(profileRepo.listByCompany?.(companyId) ?? []);
      if (existing.length >= sources.length) continue; // 已有全部平台档案
      const jobIds = await this.enqueueNewCompany(companyId);
      if (jobIds.length > 0) enqueued += 1;
    }
    return enqueued;
  }

  /** 手动刷新入队（POST /v1/companies/{id}/refresh）：可指定平台与类型；手动任务立即排到 FIFO 前（用 created_at 不变，语义由调用方 202 表达） */
  async enqueueManual(
    companyId: string,
    input: { platforms?: Platform[]; kinds?: Array<'profile' | 'jobs'> } = {},
  ): Promise<{ jobIds: string[] }> {
    const company = this.repos.companies.getById(companyId);
    if (!company || company.mergedInto) {
      throw new LeadError('NOT_FOUND', `公司不存在或已合并: ${companyId}`, { httpStatus: 404 });
    }
    const sources = await listCompanySources(this.repos, companyId);
    const available = new Map<Platform, CompanySourceLike>();
    for (const source of sources) available.set(source.platform, source);
    const platforms = (input.platforms ?? (['boss', 'zhilian', 'ali', 'mic'] as Platform[])).filter((p) => available.has(p));
    if (platforms.length === 0) {
      throw new LeadError('UNSUPPORTED', `公司没有可刷新的平台来源: ${companyId}`, { httpStatus: 400 });
    }
    const kinds = input.kinds ?? ['profile', 'jobs'];
    const jobIds: string[] = [];
    for (const platform of platforms) {
      for (const kind of kinds) {
        if (kind === 'jobs' && platform !== 'boss' && platform !== 'zhilian') continue;
        const stage = kind === 'jobs' ? PLATFORM_JOBS_STAGE : PLATFORM_PROFILE_STAGE;
        const result = await this.ensurePendingJob(companyId, stage, platform);
        if (result.jobId) jobIds.push(result.jobId);
      }
    }
    return { jobIds };
  }

  // -- 抓取与写库 -------------------------------------------------------------

  private adapterFor(platform: Platform): RecruitmentFetchPort | StoreFetchPort {
    const adapter = this.adapters[platform];
    if (!adapter) throw new LeadError('UNSUPPORTED', `未配置平台适配器: ${platform}`);
    return adapter;
  }

  private async fetchDetail(companyId: string, platform: Platform, platformCompanyId: string): Promise<PlatformCompanyDetail> {
    if (platform === 'boss' || platform === 'zhilian') {
      const adapter = this.adapterFor(platform) as RecruitmentFetchPort;
      return adapter.getCompanyDetail(platformCompanyId);
    }
    const adapter = this.adapterFor(platform) as StoreFetchPort;
    return adapter.getCompanyDetail(platformCompanyId);
  }

  private writeSnapshot(kind: string, platform: Platform, companyId: string, payload: unknown, fetchedAt: string): number | null {
    const snapshots = repoOf(this.repos as unknown as Repositories, 'snapshots', 'rawSnapshots');
    const writeText = snapshots ? snapshots.writeText : undefined;
    if (typeof writeText !== 'function') return null;
    try {
      const written = (writeText as (input: AnyRecord) => unknown).call(snapshots, {
        kind,
        payload,
        platform,
        refType: 'company',
        refId: companyId,
        fetchedAt,
      });
      const record = asRecord(written);
      const snapshot = asRecord(record.snapshot);
      const id = snapshot.id ?? record.id;
      return typeof id === 'number' ? id : null;
    } catch (err) {
      this.logger.warn?.('platform snapshot write failed', { companyId, platform, kind, error: String(err) });
      return null;
    }
  }

  private writeCompanyEnglishName(companyId: string, englishName: string | null, platform: Platform, occurredAt: string): void {
    if (!englishName) return;
    const companiesRepo = repoOf(this.repos as unknown as Repositories, 'companies');
    const company = companiesRepo ? (callRepo<AnyRecord>(companiesRepo, ['getById'], companyId) as AnyRecord | undefined) : undefined;
    if (!company) return;
    const current = company.englishName as string | null | undefined;
    if (current && current.trim().toLowerCase() === englishName.trim().toLowerCase()) return;
    try {
      callRepo(companiesRepo, ['updateEnglishName'], companyId, englishName);
      const changeEvents = repoOf(this.repos as unknown as Repositories, 'changeEvents');
      if (changeEvents && typeof changeEvents.appendMany === 'function') {
        const version = Number(company.version ?? 0) + 1;
        (changeEvents.appendMany as (events: unknown[]) => unknown).call(changeEvents, [
          {
            companyId,
            entityType: 'company',
            entityId: companyId,
            version,
            eventType: 'company.updated',
            field: 'englishName',
            oldValue: current ?? null,
            newValue: englishName,
            valueType: 'string',
            source: `source:${platform}`,
            runId: null,
            actor: 'refresh-worker',
            occurredAt,
          } satisfies ChangeEventInput,
        ]);
      }
      this.logger.info?.('company englishName updated', { companyId, platform, englishName });
    } catch (err) {
      this.logger.warn?.('company englishName update failed', { companyId, error: String(err) });
    }
  }

  private async refreshProfile(companyId: string, platform: Platform, source: CompanySourceLike): Promise<PlatformRefreshResult> {
    const profileRepo = asProfileRepo(this.repos);
    const now = this.clock();
    const fetchedAt = now.toISOString();
    const detail = await this.fetchDetail(companyId, platform, source.platformCompanyId);
    const rawSnapshotId = this.writeSnapshot(PLATFORM_DETAIL_SNAPSHOT_KIND, platform, companyId, detail.raw, fetchedAt);

    const current = (profileRepo.getByCompanyPlatform?.(companyId, platform) ?? null) as PlatformProfileRecord | null;
    const nextFields: ProfileDiffable = {
      ...(detail.profile ?? {}),
      platformStatus: 'active',
      lastSeenAt: detail.profile?.lastSeenAt ?? current?.lastSeenAt ?? null,
    };
    const diffs = diffPlatformProfile(current, nextFields);
    const changed = diffs.length > 0 || current === null;
    const version = current ? (changed ? current.version + 1 : current.version) : 1;
    const nextJobs = platform === 'boss' || platform === 'zhilian' ? nextJobsRefreshAt(now, this.config.jobRefreshDays) : current?.nextJobsRefreshAt ?? null;
    const nextStore = platform === 'ali' || platform === 'mic' ? nextStoreRefreshAt(now, this.config.storeRefreshDays) : current?.nextStoreRefreshAt ?? null;

    const input: AnyRecord = {
      companyId,
      platform,
      platformCompanyId: source.platformCompanyId,
      displayName: nextFields.displayName ?? null,
      sourceUrl: nextFields.sourceUrl ?? source.sourceUrl ?? null,
      fullName: nextFields.fullName ?? null,
      cityName: nextFields.cityName ?? null,
      address: nextFields.address ?? null,
      industry: nextFields.industry ?? null,
      scale: nextFields.scale ?? null,
      stage: nextFields.stage ?? null,
      logoUrl: nextFields.logoUrl ?? null,
      intro: nextFields.intro ?? null,
      tags: nextFields.tags ?? null,
      benefits: nextFields.benefits ?? null,
      jobCount: nextFields.jobCount ?? (platform === 'boss' || platform === 'zhilian' ? current?.jobCount ?? null : null),
      bossCount: nextFields.bossCount ?? null,
      recruiters: nextFields.recruiters ?? null,
      store: nextFields.store ?? null,
      platformStatus: 'active',
      lastFetchedAt: fetchedAt,
      lastSeenAt: nextFields.lastSeenAt ?? null,
      nextJobsRefreshAt: nextJobs,
      nextStoreRefreshAt: nextStore,
      rawSnapshotId: rawSnapshotId ?? current?.rawSnapshotId ?? null,
      version,
    };

    if (platform === 'ali' || platform === 'mic') {
      this.writeCompanyEnglishName(companyId, detail.displayName ?? detail.profile?.displayName ?? null, platform, fetchedAt);
    }

    let written: { profile: PlatformProfileRecord; previous: PlatformProfileRecord | null; created: boolean } | null = null;
    let eventCount = 0;
    const upsert = profileRepo.upsert?.bind(profileRepo);
    if (typeof upsert === 'function') {
      this.repos.transaction(() => {
        written = upsert(input) as { profile: PlatformProfileRecord; previous: PlatformProfileRecord | null; created: boolean };
        const previousRow = written?.previous ?? current;
        const events = changed ? buildProfileChangeEvents(diffs, {
          companyId,
          platform,
          entityId: written?.profile?.id ?? null,
          version,
          occurredAt: fetchedAt,
        }) : [];
        if (events.length > 0) {
          const changeEvents = repoOf(this.repos as unknown as Repositories, 'changeEvents');
          if (changeEvents && typeof changeEvents.appendMany === 'function') {
            (changeEvents.appendMany as (list: unknown[]) => unknown).call(changeEvents, events);
          }
        }
        eventCount = events.length;
        void previousRow;
      });
    }

    return {
      companyId,
      platform,
      kind: 'profile',
      status: 'ok',
      changed,
      added: 0,
      closed: 0,
      reactivated: 0,
      active: 0,
      total: 0,
      version,
      eventCount,
      rawSnapshotId,
    };
  }

  private async refreshJobs(companyId: string, platform: 'boss' | 'zhilian', source: CompanySourceLike): Promise<PlatformRefreshResult> {
    const adapter = this.adapters[platform];
    const jobsAdapter = adapter as RecruitmentFetchPort;
    const fetched = await jobsAdapter.listCompanyJobs(source.platformCompanyId);
    const now = this.clock();
    const fetchedAt = now.toISOString();
    const rawSnapshotId = this.writeSnapshot(PLATFORM_JOBS_SNAPSHOT_KIND, platform, companyId, fetched, fetchedAt);

    const jobsRepo = asPlatformJobsRepo(this.repos);
    const existing = asArray<PlatformJobRecord>(jobsRepo.listByCompanyPlatform?.(companyId, platform) ?? []);
    const plan = planJobLifecycle(existing, fetched, { maxJobs: this.config.maxJobsPerCompany });
    const previousSummary: PlatformJobsAggregateSummary = {
      active: plan.previousActive,
      added: 0,
      closed: 0,
      total: plan.previousTotal,
    };
    const nextSummary: PlatformJobsAggregateSummary = {
      active: plan.nextActive,
      added: plan.addedJobIds.length,
      closed: plan.closedJobIds.length,
      total: plan.nextTotal,
      reactivated: plan.reactivatedJobIds.length,
      truncated: plan.truncated,
    };
    const jobsChanged = nextSummary.added > 0 || nextSummary.closed > 0 || (nextSummary.reactivated ?? 0) > 0;
    if (!jobsChanged) {
      delete nextSummary.reactivated;
      delete nextSummary.truncated;
    }

    const profileRepo = asProfileRepo(this.repos);
    const current = (profileRepo.getByCompanyPlatform?.(companyId, platform) ?? null) as PlatformProfileRecord | null;
    const version = current ? (jobsChanged ? current.version + 1 : current.version) : 1;
    const nextJobsAt = nextJobsRefreshAt(now, this.config.jobRefreshDays);

    const profileInput: AnyRecord = current
      ? { ...this.profileRecordToInput(current), version, lastFetchedAt: fetchedAt, nextJobsRefreshAt: nextJobsAt, platformStatus: 'active', rawSnapshotId: rawSnapshotId ?? current.rawSnapshotId }
      : {
          companyId,
          platform,
          platformCompanyId: source.platformCompanyId,
          displayName: null,
          sourceUrl: source.sourceUrl ?? null,
          fullName: null,
          cityName: null,
          address: null,
          industry: null,
          scale: null,
          stage: null,
          logoUrl: null,
          intro: null,
          tags: null,
          benefits: null,
          jobCount: plan.nextActive,
          bossCount: null,
          recruiters: null,
          store: null,
          platformStatus: 'active',
          lastFetchedAt: fetchedAt,
          lastSeenAt: null,
          nextJobsRefreshAt: nextJobsAt,
          nextStoreRefreshAt: null,
          rawSnapshotId,
          version,
        };

    let eventCount = 0;
    const upsertProfile = profileRepo.upsert?.bind(profileRepo);
    const upsertJob = jobsRepo.upsertJob?.bind(jobsRepo);
    const closeMissing = jobsRepo.closeMissing?.bind(jobsRepo);
    this.repos.transaction(() => {
      if (typeof upsertProfile === 'function') upsertProfile(profileInput);
      if (typeof upsertJob === 'function') {
        for (const job of plan.seen) {
          upsertJob({
            companyId,
            platform,
            platformCompanyId: source.platformCompanyId,
            jobId: job.jobId,
            title: job.title,
            salaryText: job.salaryText ?? null,
            salaryMin: job.salaryMin ?? null,
            salaryMax: job.salaryMax ?? null,
            cityName: job.cityName ?? null,
            district: job.district ?? null,
            degree: job.degree ?? null,
            experience: job.experience ?? null,
            publishTime: job.publishTime ?? null,
            recruiterName: job.recruiterName ?? null,
            recruiterTitle: job.recruiterTitle ?? null,
            jobUrl: job.jobUrl ?? null,
            status: 'active',
            firstSeenAt: fetchedAt,
            lastSeenAt: fetchedAt,
            closedAt: null,
            raw: job.raw ?? null,
          });
        }
      }
      if (typeof closeMissing === 'function' && plan.closedJobIds.length > 0) {
        closeMissing(companyId, platform, plan.seen.map((j) => j.jobId), fetchedAt);
      }
      if (jobsChanged) {
        const changeEvents = repoOf(this.repos as unknown as Repositories, 'changeEvents');
        const profileId = (current?.id ?? null) as string | null;
        if (changeEvents && typeof changeEvents.appendMany === 'function') {
          const event = buildJobsAggregateEvent(previousSummary, nextSummary, {
            companyId,
            platform,
            entityId: profileId,
            version,
            occurredAt: fetchedAt,
          });
          (changeEvents.appendMany as (list: unknown[]) => unknown).call(changeEvents, [event]);
          eventCount = 1;
        }
      }
    });

    return {
      companyId,
      platform,
      kind: 'jobs',
      status: 'ok',
      changed: jobsChanged,
      added: nextSummary.added,
      closed: nextSummary.closed,
      reactivated: plan.reactivatedJobIds.length,
      active: plan.nextActive,
      total: plan.nextTotal,
      version,
      eventCount,
      rawSnapshotId,
    };
  }

  private profileRecordToInput(record: PlatformProfileRecord): AnyRecord {
    return {
      companyId: record.companyId,
      platform: record.platform,
      platformCompanyId: record.platformCompanyId,
      displayName: record.displayName ?? null,
      sourceUrl: record.sourceUrl ?? null,
      fullName: record.fullName ?? null,
      cityName: record.cityName ?? null,
      address: record.address ?? null,
      industry: record.industry ?? null,
      scale: record.scale ?? null,
      stage: record.stage ?? null,
      logoUrl: record.logoUrl ?? null,
      intro: record.intro ?? null,
      tags: record.tags ?? null,
      benefits: record.benefits ?? null,
      jobCount: record.jobCount ?? null,
      bossCount: record.bossCount ?? null,
      recruiters: record.recruiters ?? null,
      store: record.store ?? null,
      platformStatus: record.platformStatus ?? 'active',
      lastFetchedAt: record.lastFetchedAt,
      lastSeenAt: record.lastSeenAt ?? null,
      nextJobsRefreshAt: record.nextJobsRefreshAt ?? null,
      nextStoreRefreshAt: record.nextStoreRefreshAt ?? null,
      rawSnapshotId: record.rawSnapshotId ?? null,
      version: record.version,
    };
  }

  private async markProfileLost(companyId: string, platform: Platform): Promise<void> {
    const profileRepo = asProfileRepo(this.repos);
    const current = profileRepo.getByCompanyPlatform?.(companyId, platform) ?? null;
    if (!current || typeof profileRepo.update !== 'function') return;
    try {
      profileRepo.update(current.id, { platformStatus: 'lost' }, { bumpVersion: false });
    } catch (err) {
      this.logger.warn?.('platform profile mark lost failed', { companyId, platform, error: String(err) });
    }
  }

  private retryAtFor(job: ClaimedJobLike, error: LeadError, withOneDay = false): string | null {
    if (withOneDay) return isoPlusDays(1, this.clock());
    if (!error.retryable) return null;
    const attempts = (job.attempts ?? 0) + 1;
    const maxAttempts = job.maxAttempts ?? this.config.jobMaxAttempts;
    if (attempts >= maxAttempts) return null;
    const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
    return isoPlusSeconds(Math.round(delayMs / 1000), this.clock());
  }

  private async markSourceHealth(platform: Platform, state: 'session_invalid' | 'verification_pending' | 'degraded', detail: Record<string, unknown>): Promise<void> {
    const repo = repoOf(this.repos as unknown as Repositories, 'sourceHealth');
    const upsert = repo ? repo.upsert : undefined;
    if (typeof upsert !== 'function') return;
    try {
      (upsert as (input: AnyRecord) => unknown).call(repo, {
        platform,
        state,
        loggedIn: state === 'session_invalid' ? false : null,
        checkedAt: this.nowIso(),
        detail,
      });
    } catch (err) {
      this.logger.warn?.('source health update failed', { platform, error: String(err) });
    }
  }

  /** 执行单个 pipeline job（platform_profile / platform_jobs） */
  async processJob(job: ClaimedJobLike): Promise<PlatformRefreshResult | null> {
    const queue = asQueueRepo(this.repos);
    const companyId = job.companyId;
    const platform = (job.platform ?? '') as Platform;
    const stage = String(job.stage ?? '');
    try {
      if (!platform) throw new LeadError('VALIDATION_ERROR', `刷新任务缺少 platform: ${job.id}`);
      const company = this.repos.companies.getById(companyId);
      if (!company || company.mergedInto) {
        await this.finishJob(job.id, queue);
        return null;
      }
      const sources = await listCompanySources(this.repos, companyId);
      const source = sources.find((s) => s.platform === platform);
      if (!source) {
        throw new LeadError('NOT_FOUND', `公司没有 ${platform} 来源: ${companyId}`, { httpStatus: 404 });
      }
      let result: PlatformRefreshResult;
      if (stage === PLATFORM_JOBS_STAGE) {
        if (platform !== 'boss' && platform !== 'zhilian') {
          throw new LeadError('UNSUPPORTED', `${platform} 不支持岗位刷新`, { httpStatus: 400 });
        }
        result = await this.refreshJobs(companyId, platform, source);
      } else if (stage === PLATFORM_PROFILE_STAGE) {
        result = await this.refreshProfile(companyId, platform, source);
      } else {
        throw new LeadError('UNSUPPORTED', `Refresh Worker 不支持 stage: ${stage}`);
      }
      await this.finishJob(job.id, queue);
      return result;
    } catch (err) {
      const e = toLeadError(err);
      await this.failJob(job, queue, e);
      this.logger.warn?.('platform refresh job failed', { jobId: job.id, companyId, platform, stage, code: e.code, message: e.message });
      return null;
    }
  }

  private async finishJob(jobId: string, queue: JobsRepoLike): Promise<void> {
    if (typeof queue.complete === 'function') await queue.complete(jobId);
  }

  private async failJob(job: ClaimedJobLike, queue: JobsRepoLike, error: LeadError): Promise<void> {
    if (error.code === 'SOURCE_SESSION_INVALID') {
      await this.markSourceHealth((job.platform ?? 'boss') as Platform, 'session_invalid', { reason: error.code });
    } else if (error.code === 'SOURCE_VERIFICATION_PENDING') {
      await this.markSourceHealth((job.platform ?? 'boss') as Platform, 'verification_pending', { reason: error.code });
    }
    if (error.code === 'NOT_FOUND') {
      const attempts = (job.attempts ?? 0) + 1;
      const maxAttempts = job.maxAttempts ?? this.config.jobMaxAttempts;
      if (attempts >= maxAttempts) await this.markProfileLost(job.companyId, (job.platform ?? '') as Platform);
    }
    const nextRetryAt =
      error.code === 'SOURCE_SESSION_INVALID' || error.code === 'SOURCE_VERIFICATION_PENDING'
        ? this.retryAtFor(job, error, true)
        : this.retryAtFor(job, error);
    if (typeof queue.fail === 'function') {
      await queue.fail(job.id, {
        error: error.message,
        errorCode: error.code,
        retryable: error.retryable,
        nextRetryAt,
      });
    }
  }

  private claimNextJob(): ClaimedJobLike | null {
    const queue = asQueueRepo(this.repos);
    if (typeof queue.claimNext !== 'function') return null;
    const claimed = queue.claimNext({
      workerId: this.config.workerId,
      stages: [PLATFORM_PROFILE_STAGE, PLATFORM_JOBS_STAGE],
      leaseSec: this.config.leaseSec,
      now: this.nowIso(),
    });
    return unwrapClaimed(claimed);
  }

  /**
   * 一轮：补到期/新公司任务 → FIFO 领取执行（单轮上限 maxJobsPerTick）。
   * adapter 内部限频（Boss 12/min、智联 15/min、Ali 10s/页、Mic ~30/min）保证全天涓流不超限。
   */
  async runOnce(options?: { limit?: number; enqueueDue?: boolean }): Promise<PlatformRefreshRunSummary> {
    const summary: PlatformRefreshRunSummary = {
      now: this.nowIso(),
      dueEnqueued: 0,
      newCompaniesEnqueued: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      profileChanged: 0,
      jobsChanged: 0,
      sessionInvalid: false,
    };
    if (options?.enqueueDue !== false) {
      const due = await this.enqueueDue();
      summary.dueEnqueued = due.jobs;
      summary.newCompaniesEnqueued = due.newCompanies;
    }
    const limit = options?.limit ?? this.config.maxJobsPerTick;
    for (let i = 0; i < limit; i += 1) {
      const job = this.claimNextJob();
      if (!job) break;
      summary.claimed += 1;
      const result = await this.processJob(job);
      if (!result) {
        summary.failed += 1;
        continue;
      }
      summary.completed += 1;
      if (result.kind === 'profile' && result.changed) summary.profileChanged += 1;
      if (result.kind === 'jobs' && result.changed) summary.jobsChanged += 1;
    }
    return summary;
  }
}

/** Lead `src/config.ts` 扁平字段（含 worker 调度参数）的结构子集 */
export interface PlatformRefreshAppConfigLike extends Partial<PlatformRefreshConfig>, PlatformRefreshConfigLike {
  jobLeaseSec?: number;
  jobMaxAttempts?: number;
  platformActiveDays?: number;
  platformLostDays?: number;
}

export interface FromConfigOptions {
  adapters?: PlatformRefreshAdapters;
  logger?: PipelineLogger;
  clock?: () => Date;
}

/**
 * 由扁平 AppConfig 构造 Refresh Worker（main/wiring 一行接线）：
 * `const worker = createPlatformRefreshWorkerFromConfig(repos, config);`
 * 适配器默认按 config.bossUrl/bossToken/… 构造真实 S2/S3 适配器。
 */
export function createPlatformRefreshWorkerFromConfig(
  repos: Repositories,
  config: PlatformRefreshAppConfigLike = {},
  options: FromConfigOptions = {},
): PlatformRefreshWorker {
  const workerConfig: Partial<PlatformRefreshConfig> = {};
  const jobRefreshDays = config.jobRefreshDays;
  const storeRefreshDays = config.storeRefreshDays;
  const leaseSec = config.jobLeaseSec ?? config.leaseSec;
  const jobMaxAttempts = config.jobMaxAttempts ?? config.jobMaxAttempts;
  const activeDays = config.activeDays ?? config.platformActiveDays;
  const lostDays = config.lostDays ?? config.platformLostDays;
  const maxJobsPerTick = config.maxJobsPerTick;
  const dueScanLimit = config.dueScanLimit;
  const maxJobsPerCompany = config.maxJobsPerCompany;
  const workerId = config.workerId;
  if (jobRefreshDays !== undefined) workerConfig.jobRefreshDays = jobRefreshDays;
  if (storeRefreshDays !== undefined) workerConfig.storeRefreshDays = storeRefreshDays;
  if (leaseSec !== undefined) workerConfig.leaseSec = leaseSec;
  if (jobMaxAttempts !== undefined) workerConfig.jobMaxAttempts = jobMaxAttempts;
  if (activeDays !== undefined) workerConfig.activeDays = activeDays;
  if (lostDays !== undefined) workerConfig.lostDays = lostDays;
  if (maxJobsPerTick !== undefined) workerConfig.maxJobsPerTick = maxJobsPerTick;
  if (dueScanLimit !== undefined) workerConfig.dueScanLimit = dueScanLimit;
  if (maxJobsPerCompany !== undefined) workerConfig.maxJobsPerCompany = maxJobsPerCompany;
  if (workerId !== undefined) workerConfig.workerId = workerId;
  return new PlatformRefreshWorker({
    repos,
    adapters: options.adapters ?? createDefaultPlatformAdapters(config),
    config: workerConfig,
    logger: options.logger,
    clock: options.clock,
  });
}

/** 工厂：main/scheduler 集成入口 */
export function createPlatformRefreshWorker(deps: PlatformRefreshWorkerDeps): PlatformRefreshWorker {
  return new PlatformRefreshWorker(deps);
}
