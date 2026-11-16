/**
 * 平台档案 / 岗位读服务（docs/03 §4 平台卡片与平台详情；docs/07）。
 *
 * 路由（D1）可直接调用这些函数：
 *  - listCompanyPlatforms(companyId)                     → 各平台最新档案摘要（平台卡片）
 *  - getCompanyPlatform(companyId, platform)             → 单平台完整档案（含 store/最新岗位）
 *  - listCompanyPlatformJobs(companyId, platform, query) → 岗位列表 + 历史（仅 Boss/智联）
 *  - listCompanyPlatformChanges(companyId, platform, q)  → 平台档案变更历史
 *  - createRefreshJob(companyId, input)                  → 手动刷新入队（202 + job）
 *
 * 另 re-export 海关读接口（src/services/customs.ts），便于路由统一从本文件取。
 */
import type { Repositories } from '../repositories/index.js';
import type { Platform, PlatformJob, PlatformProfile, PlatformStatus } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { computePlatformStatus, createPlatformRefreshWorker } from '../pipeline/platformRefresh.js';
import { clampLimit, decodeOffsetCursor, encodeOffsetCursor, getDefaultRepositories } from './repositoryAccess.js';

// ---------------------------------------------------------------------------
// 视图类型
// ---------------------------------------------------------------------------

export interface PlatformCardJob {
  title: string;
  salaryText: string | null;
  cityName: string | null;
  district: string | null;
  degree: string | null;
  experience: string | null;
  publishTime: string | null;
}

export interface PlatformCard {
  platform: Platform;
  platformStatus: PlatformStatus;
  displayName: string | null;
  sourceUrl: string | null;
  cityName: string | null;
  industry: string | null;
  scale: string | null;
  stage: string | null;
  jobCount: number | null;
  bossCount: number | null;
  recruiters: unknown;
  latestJobs: PlatformCardJob[];
  store: Record<string, unknown> | null;
  lastFetchedAt: string | null;
  nextJobsRefreshAt: string | null;
  nextStoreRefreshAt: string | null;
}

export interface FullPlatformProfile extends PlatformCard {
  id: string;
  companyId: string;
  platformCompanyId: string;
  fullName: string | null;
  address: string | null;
  logoUrl: string | null;
  intro: string | null;
  tags: string[] | null;
  benefits: string[] | null;
  version: number;
  rawSnapshotId: number | null;
}

export interface ChangeView {
  seq: number;
  version: number;
  eventType: string;
  entityType: string;
  entityId: string | null;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  valueType: string | null;
  source: string;
  runId: string | null;
  occurredAt: string;
}

export interface JobListQuery {
  status?: 'active' | 'closed' | 'all';
  limit?: number;
  cursor?: string | null;
}

export interface ChangesQuery {
  sinceVersion?: number;
  limit?: number;
  cursor?: string | null;
}

export interface RefreshJobInput {
  platforms?: string[];
  kinds?: Array<'profile' | 'jobs'>;
}

export interface RefreshJobResult {
  jobId: string;
  jobIds: string[];
}

export interface PlatformJobPage {
  items: PlatformJob[];
  nextCursor: string | null;
}

export interface PlatformChangesPage {
  items: ChangeView[];
  nextCursor: string | null;
}

export interface PlatformCardList {
  items: PlatformCard[];
}

type PlatformProfileRecord = PlatformProfile & { id: string; createdAt: string; updatedAt: string };

// 供路由层做参数校验/错误映射
export const RECRUITMENT_JOB_PLATFORMS: ReadonlyArray<Platform> = ['boss', 'zhilian'];
export const PLATFORM_VALUES: ReadonlyArray<Platform> = ['boss', 'zhilian', 'ali', 'mic'];

export function isRecruitmentPlatform(platform: string): platform is 'boss' | 'zhilian' {
  return platform === 'boss' || platform === 'zhilian';
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORM_VALUES as ReadonlyArray<string>).includes(value);
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

async function getRepos(injected?: Repositories): Promise<Repositories> {
  return injected ?? (await getDefaultRepositories());
}

function assertPlatform(platform: string): Platform {
  if (!isPlatform(platform)) {
    throw new LeadError('VALIDATION_ERROR', `未知平台: ${platform}（可选 boss/zhilian/ali/mic）`, { httpStatus: 400 });
  }
  return platform;
}

function requireCompany(repos: Repositories, companyId: string): void {
  const company = repos.companies.getById(companyId, { includeMerged: true });
  if (!company) throw new LeadError('NOT_FOUND', `公司不存在: ${companyId}`, { httpStatus: 404 });
}

function effectivePlatformStatus(profile: Pick<PlatformProfile, 'platformStatus' | 'lastFetchedAt'>, now = new Date()): PlatformStatus {
  if (profile.platformStatus === 'lost') return 'lost';
  return computePlatformStatus(profile.lastFetchedAt, now);
}

function toCardJob(job: PlatformJob): PlatformCardJob {
  return {
    title: job.title,
    salaryText: job.salaryText,
    cityName: job.cityName,
    district: job.district,
    degree: job.degree,
    experience: job.experience,
    publishTime: job.publishTime,
  };
}

function sortJobs(jobs: PlatformJob[]): PlatformJob[] {
  return [...jobs].sort((a, b) => {
    const aActive = a.status === 'active' ? 0 : 1;
    const bActive = b.status === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? ''));
  });
}

function latestJobsFor(repos: Repositories, companyId: string, platform: Platform, limit = 5): PlatformJob[] {
  if (!isRecruitmentPlatform(platform)) return [];
  try {
    const jobs = repos.platformJobs.listByCompanyPlatform(companyId, platform, { status: 'active' });
    return sortJobs(jobs).slice(0, limit);
  } catch {
    return [];
  }
}

function buildCard(repos: Repositories, profile: PlatformProfileRecord, options: { latestJobLimit?: number } = {}): PlatformCard {
  const latest = latestJobsFor(repos, profile.companyId, profile.platform, options.latestJobLimit ?? 5);
  return {
    platform: profile.platform,
    platformStatus: effectivePlatformStatus(profile),
    displayName: profile.displayName,
    sourceUrl: profile.sourceUrl,
    cityName: profile.cityName,
    industry: profile.industry,
    scale: profile.scale,
    stage: profile.stage,
    jobCount: profile.jobCount,
    bossCount: profile.bossCount,
    recruiters: profile.recruiters,
    latestJobs: latest.map(toCardJob),
    store: (profile.store ?? null) as Record<string, unknown> | null,
    lastFetchedAt: profile.lastFetchedAt,
    nextJobsRefreshAt: profile.nextJobsRefreshAt,
    nextStoreRefreshAt: profile.nextStoreRefreshAt,
  };
}

function buildFullProfile(repos: Repositories, profile: PlatformProfileRecord): FullPlatformProfile {
  return {
    ...buildCard(repos, profile, { latestJobLimit: 5 }),
    id: profile.id,
    companyId: profile.companyId,
    platformCompanyId: profile.platformCompanyId,
    fullName: profile.fullName,
    address: profile.address,
    logoUrl: profile.logoUrl,
    intro: profile.intro,
    tags: profile.tags,
    benefits: profile.benefits,
    version: profile.version,
    rawSnapshotId: profile.rawSnapshotId,
  };
}

function toChangeView(event: {
  seq: number;
  version: number;
  eventType: string;
  entityType: string;
  entityId: string | null;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  valueType: string | null;
  source: string;
  runId: string | null;
  occurredAt: string;
}): ChangeView {
  return {
    seq: event.seq,
    version: event.version,
    eventType: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    field: event.field,
    oldValue: event.oldValue,
    newValue: event.newValue,
    valueType: event.valueType,
    source: event.source,
    runId: event.runId,
    occurredAt: event.occurredAt,
  };
}

// ---------------------------------------------------------------------------
// 读接口
// ---------------------------------------------------------------------------

/** 各平台最新档案摘要（平台卡片）。公司不存在 → NOT_FOUND。 */
export async function listCompanyPlatforms(companyId: string, repos?: Repositories): Promise<PlatformCard[]> {
  const r = await getRepos(repos);
  requireCompany(r, companyId);
  const profiles: PlatformProfileRecord[] = r.platformProfiles.listByCompany(companyId);
  const order: Record<string, number> = { boss: 0, zhilian: 1, ali: 2, mic: 3 };
  return profiles
    .filter((p) => !p.platform || order[p.platform] !== undefined)
    .sort((a, b) => (order[a.platform] ?? 9) - (order[b.platform] ?? 9))
    .map((profile) => buildCard(r, profile));
}

/** 单平台完整档案（含 store / 最新岗位）；不存在 → null，平台参数非法 → VALIDATION_ERROR。 */
export async function getCompanyPlatform(companyId: string, platform: string, repos?: Repositories): Promise<FullPlatformProfile | null> {
  const p = assertPlatform(platform);
  const r = await getRepos(repos);
  requireCompany(r, companyId);
  const profile = r.platformProfiles.getByCompanyPlatform(companyId, p);
  return profile ? buildFullProfile(r, profile) : null;
}

/** 岗位列表 + 历史（仅 Boss/智联；其它平台 400 UNSUPPORTED）。 */
export async function listCompanyPlatformJobs(
  companyId: string,
  platform: string,
  query: JobListQuery = {},
  repos?: Repositories,
): Promise<PlatformJobPage> {
  const p = assertPlatform(platform);
  if (!isRecruitmentPlatform(p)) {
    throw new LeadError('UNSUPPORTED', `${p} 没有岗位列表（仅 boss/zhilian）`, { httpStatus: 400 });
  }
  const r = await getRepos(repos);
  requireCompany(r, companyId);
  const status = query.status ?? 'active';
  const jobs = sortJobs(
    r.platformJobs.listByCompanyPlatform(companyId, p, status === 'all' ? {} : { status }),
  );
  const limit = clampLimit(query.limit, 50, 500);
  const offset = decodeOffsetCursor(query.cursor);
  const items = jobs.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: nextOffset < jobs.length ? encodeOffsetCursor(nextOffset) : null,
  };
}

/** 平台档案变更历史（change_events field=platforms.<platform>.*）。 */
export async function listCompanyPlatformChanges(
  companyId: string,
  platform: string,
  query: ChangesQuery = {},
  repos?: Repositories,
): Promise<PlatformChangesPage> {
  const p = assertPlatform(platform);
  const r = await getRepos(repos);
  requireCompany(r, companyId);
  const prefix = `platforms.${p}.`;
  const sinceVersion = Number.isFinite(Number(query.sinceVersion)) ? Number(query.sinceVersion) : 0;
  const events = r.changeEvents
    .listByCompany(companyId, { limit: 1000 })
    .filter((event) => typeof event.field === 'string' && event.field.startsWith(prefix))
    .filter((event) => event.version > sinceVersion)
    .sort((a, b) => a.seq - b.seq);
  const limit = clampLimit(query.limit, 50, 500);
  const offset = decodeOffsetCursor(query.cursor);
  const items = events.slice(offset, offset + limit).map(toChangeView);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor: nextOffset < events.length ? encodeOffsetCursor(nextOffset) : null,
  };
}

/** 手动刷新入队（返回 202 用 jobId；可指定 platforms / kinds）。 */
export async function createRefreshJob(companyId: string, input: RefreshJobInput = {}, repos?: Repositories): Promise<RefreshJobResult> {
  const r = await getRepos(repos);
  requireCompany(r, companyId);
  const platforms = (input.platforms ?? []).map((p) => assertPlatform(p));
  const kinds = (input.kinds ?? ['profile', 'jobs']).filter((k): k is 'profile' | 'jobs' => k === 'profile' || k === 'jobs');
  const worker = createPlatformRefreshWorker({ repos: r });
  const { jobIds } = await worker.enqueueManual(companyId, {
    platforms: platforms.length > 0 ? platforms : undefined,
    kinds: kinds.length > 0 ? kinds : ['profile'],
  });
  if (jobIds.length === 0) {
    throw new LeadError('UNSUPPORTED', `公司没有可刷新的平台来源: ${companyId}`, { httpStatus: 400 });
  }
  return { jobId: jobIds[0] as string, jobIds };
}

/** 统计：各平台状态分布（/v1/status 或 /v1/stats 用）。 */
export async function getPlatformStatusCounts(repos?: Repositories): Promise<Record<string, number>> {
  const r = await getRepos(repos);
  try {
    return r.platformProfiles.countByPlatformStatus() as unknown as Record<string, number>;
  } catch {
    return {};
  }
}

// re-export 海关读/刷新（路由可从两个路径取）
export { getCompanyCustoms, createCustomsRefreshJob } from './customs.js';
export type { CustomsView, CustomsRefreshJobResult } from './customs.js';
