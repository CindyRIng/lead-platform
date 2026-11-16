/**
 * 平台档案/岗位刷新单测（task-10）：全部 mock，不访问真实网络/DB。
 * 覆盖：新公司 4 平台即时抓取（+Boss/智联岗位）、岗位新增/下线/重开生命周期、
 *       档案字段 diff 事件、版本递增、到期周/月调度、platform_status 判定、404×3 → lost、手动刷新入队。
 */
import { describe, expect, it } from 'vitest';
import {
  computePlatformStatus,
  createPlatformRefreshWorker,
  createPlatformRefreshWorkerFromConfig,
  diffPlatformProfile,
  isRefreshDue,
  planJobLifecycle,
  type PlatformRefreshAdapters,
} from '../../src/pipeline/platformRefresh.js';
import { LeadError } from '../../src/shared/errors.js';

const NOW = new Date('2026-11-16T06:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}
function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * DAY).toISOString();
}

// ---------------------------------------------------------------------------
// 合成公司/来源/适配器
// ---------------------------------------------------------------------------

const COMPANY = {
  id: 'cmp_001',
  name: '河北测试机械有限公司',
  englishName: null as string | null,
  province: '河北省',
  city: '石家庄市',
  mergedInto: null,
  version: 3,
};

const SOURCES = [
  { platform: 'boss', platformCompanyId: 'boss_1', sourceUrl: 'https://example.invalid/boss/1' },
  { platform: 'zhilian', platformCompanyId: 'zh_1', sourceUrl: 'https://example.invalid/zh/1' },
  { platform: 'ali', platformCompanyId: 'ali_1', sourceUrl: 'https://example.invalid/ali/1' },
  { platform: 'mic', platformCompanyId: 'mic_1', sourceUrl: 'https://example.invalid/mic/1' },
];

function emptyFields(extra: Record<string, unknown> = {}) {
  return {
    displayName: null,
    sourceUrl: null,
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
    jobCount: null,
    bossCount: null,
    recruiters: null,
    store: null,
    platformStatus: 'active',
    lastSeenAt: null,
    ...extra,
  };
}

function detail(platform: string, platformCompanyId: string, extra: Record<string, unknown> = {}) {
  const profile = emptyFields(extra);
  return {
    platform,
    platformCompanyId,
    displayName: (profile.displayName as string | null) ?? null,
    sourceUrl: (profile.sourceUrl as string | null) ?? null,
    profile,
    jobs: [],
    business: null,
    raw: { platform, platformCompanyId, ...extra },
    fetchedAt: NOW_ISO,
  };
}

function normalizedJob(platform: 'boss' | 'zhilian', platformCompanyId: string, jobId: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    platform,
    platformCompanyId,
    jobId,
    title,
    salaryText: extra.salaryText ?? '8-12K',
    salaryMin: extra.salaryMin ?? null,
    salaryMax: extra.salaryMax ?? null,
    cityName: extra.cityName ?? '石家庄',
    district: extra.district ?? null,
    degree: extra.degree ?? '大专',
    experience: extra.experience ?? '1-3年',
    publishTime: extra.publishTime ?? null,
    recruiterName: extra.recruiterName ?? '王*',
    recruiterTitle: extra.recruiterTitle ?? 'HR',
    jobUrl: extra.jobUrl ?? `https://example.invalid/job/${jobId}`,
    status: 'active' as const,
    firstSeenAt: NOW_ISO,
    lastSeenAt: NOW_ISO,
    closedAt: null,
    raw: { jobId, title },
  };
}

interface AdapterScript {
  details?: Record<string, Record<string, unknown> | Error>;
  jobs?: Record<string, ReturnType<typeof normalizedJob>[] | Error>;
}

function makeFakeAdapters(script: AdapterScript = {}): PlatformRefreshAdapters & { calls: string[] } {
  const calls: string[] = [];
  const makeDetailFetcher = (platform: string) => ({
    getCompanyDetail: async (platformCompanyId: string) => {
      calls.push(`${platform}:detail:${platformCompanyId}`);
      const value = script.details?.[platformCompanyId] ?? detail(platform, platformCompanyId);
      if (value instanceof Error) throw value;
      return value as never;
    },
  });
  const makeRecruitment = (platform: 'boss' | 'zhilian') => ({
    ...makeDetailFetcher(platform),
    listCompanyJobs: async (platformCompanyId: string) => {
      calls.push(`${platform}:jobs:${platformCompanyId}`);
      const value = script.jobs?.[platformCompanyId] ?? [];
      if (value instanceof Error) throw value;
      return value as never;
    },
  });
  return {
    calls,
    boss: makeRecruitment('boss'),
    zhilian: makeRecruitment('zhilian'),
    ali: makeDetailFetcher('ali'),
    mic: makeDetailFetcher('mic'),
  };
}

// ---------------------------------------------------------------------------
// Fake repositories
// ---------------------------------------------------------------------------

interface FakePlatformOptions {
  company?: Record<string, unknown>;
  sources?: Array<Record<string, unknown>>;
  profiles?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
}

function makeFakeRepos(options: FakePlatformOptions = {}) {
  let profileSeq = 0;
  let jobSeq = 0;
  let queueSeq = 0;
  let eventSeq = 0;
  let snapshotSeq = 0;

  const company = { ...COMPANY, ...(options.company ?? {}) };
  const state = {
    company,
    sources: (options.sources ?? SOURCES).map((s) => ({ ...s })),
    profiles: (options.profiles ?? []).map((p, index) => ({ id: `pp_seed_${index}`, createdAt: NOW_ISO, updatedAt: NOW_ISO, ...p })),
    jobs: (options.jobs ?? []).map((j, index) => ({ id: `pj_seed_${index}`, createdAt: NOW_ISO, updatedAt: NOW_ISO, ...j })),
    queue: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown> & { seq: number }>,
    snapshots: [] as Array<Record<string, unknown>>,
    sourceHealth: [] as Array<Record<string, unknown>>,
    englishNameUpdates: [] as Array<{ id: string; englishName: string }>,
  };

  const findProfile = (companyId: string, platform: string) =>
    state.profiles.find((p) => p.companyId === companyId && p.platform === platform) ?? null;

  const repos = {
    transaction: <T>(fn: () => T): T => fn(),
    companies: {
      getById: (id: string) => (id === company.id ? company : null),
      listByEnrichmentStatus: () => [],
      updateEnglishName: (id: string, englishName: string) => {
        state.englishNameUpdates.push({ id, englishName });
        if (englishName) company.englishName = englishName;
        return company;
      },
    },
    companySources: {
      listByCompany: (companyId: string) => (companyId === company.id ? state.sources : []),
      getByPlatform: (companyId: string, platform: string) =>
        state.sources.find((s) => s.platform === platform) ?? null,
    },
    platformProfiles: {
      getByCompanyPlatform: (companyId: string, platform: string) => findProfile(companyId, platform),
      listByCompany: (companyId: string) => state.profiles.filter((p) => p.companyId === companyId),
      upsert: (input: Record<string, unknown>) => {
        const previous = findProfile(String(input.companyId), String(input.platform));
        if (previous) {
          const snapshot = { ...previous };
          Object.assign(previous, input, { updatedAt: NOW_ISO });
          return { profile: previous, previous: snapshot, created: false };
        }
        profileSeq += 1;
        const record = {
          id: `pp_${profileSeq}`,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          platformStatus: 'active',
          jobCount: null,
          bossCount: null,
          ...input,
        };
        state.profiles.push(record);
        return { profile: record, previous: null, created: true };
      },
      update: (id: string, patch: Record<string, unknown>, opts: { bumpVersion?: boolean } = {}) => {
        const record = state.profiles.find((p) => p.id === id);
        if (!record) return null;
        Object.assign(record, patch, { updatedAt: NOW_ISO });
        if (opts.bumpVersion !== false) record.version = Number(record.version ?? 1) + 1;
        return record;
      },
      listDueJobs: ({ now, limit }: { now?: string; limit?: number } = {}) => {
        const nowMs = now ? Date.parse(now) : NOW.getTime();
        return state.profiles
          .filter((p) => p.platform === 'boss' || p.platform === 'zhilian')
          .filter((p) => !p.nextJobsRefreshAt || Date.parse(String(p.nextJobsRefreshAt)) <= nowMs)
          .slice(0, limit ?? 50);
      },
      listDueStores: ({ now, limit }: { now?: string; limit?: number } = {}) => {
        const nowMs = now ? Date.parse(now) : NOW.getTime();
        return state.profiles
          .filter((p) => p.platform === 'ali' || p.platform === 'mic')
          .filter((p) => !p.nextStoreRefreshAt || Date.parse(String(p.nextStoreRefreshAt)) <= nowMs)
          .slice(0, limit ?? 50);
      },
    },
    platformJobs: {
      listByCompanyPlatform: (companyId: string, platform: string, opts: { status?: string } = {}) =>
        state.jobs.filter(
          (j) => j.companyId === companyId && j.platform === platform && (opts.status ? j.status === opts.status : true),
        ),
      upsertJob: (input: Record<string, unknown>) => {
        const existing = state.jobs.find(
          (j) => j.platform === input.platform && j.platformCompanyId === input.platformCompanyId && j.jobId === input.jobId,
        );
        if (existing) {
          const previous = { ...existing };
          const firstSeenAt = existing.firstSeenAt;
          const wasClosed = existing.status === 'closed';
          Object.assign(existing, input, {
            firstSeenAt,
            status: 'active',
            closedAt: null,
            updatedAt: NOW_ISO,
          });
          return { job: existing, previous, created: false, reactivated: wasClosed };
        }
        jobSeq += 1;
        const record = {
          id: `pj_${jobSeq}`,
          companyId: input.companyId,
          platform: input.platform,
          platformCompanyId: input.platformCompanyId,
          jobId: input.jobId,
          title: input.title,
          status: 'active',
          firstSeenAt: NOW_ISO,
          lastSeenAt: NOW_ISO,
          closedAt: null,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          ...input,
        };
        state.jobs.push(record);
        return { job: record, previous: null, created: true };
      },
      closeMissing: (companyId: string, platform: string, seenJobIds: string[], at?: string) => {
        const seen = new Set(seenJobIds);
        const closed: Array<Record<string, unknown>> = [];
        for (const job of state.jobs) {
          if (job.companyId === companyId && job.platform === platform && job.status === 'active' && !seen.has(String(job.jobId))) {
            job.status = 'closed';
            job.closedAt = at ?? NOW_ISO;
            closed.push(job);
          }
        }
        return closed;
      },
    },
    jobs: {
      enqueue: (input: Record<string, unknown>) => {
        const key = `${input.companyId}|${input.stage}|${input.platform ?? ''}`;
        const existing = state.queue.find((j) => j.key === key);
        if (existing) {
          if (input.resetExisting && ['done', 'failed', 'dead', 'cancelled'].includes(String(existing.status))) {
            existing.status = 'pending';
            existing.attempts = 0;
            existing.nextRetryAt = null;
            return { job: existing, created: false };
          }
          return { job: existing, created: false };
        }
        queueSeq += 1;
        const job = {
          id: `q_${queueSeq}`,
          key,
          companyId: input.companyId,
          stage: input.stage,
          platform: input.platform ?? null,
          status: 'pending',
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 3,
          nextRetryAt: null,
        };
        state.queue.push(job);
        return { job, created: true };
      },
      claimNext: (input: { stages?: string[] }) => {
        const job = state.queue.find(
          (j) =>
            j.status === 'pending' &&
            (!j.nextRetryAt || Date.parse(String(j.nextRetryAt)) <= NOW.getTime()) &&
            (!input.stages || input.stages.includes(String(j.stage))),
        );
        if (!job) return null;
        job.status = 'running';
        job.attempts = Number(job.attempts ?? 0) + 1;
        return job;
      },
      complete: (id: string) => {
        const job = state.queue.find((j) => j.id === id);
        if (job) job.status = 'done';
        return job ?? null;
      },
      fail: (id: string, opts: { nextRetryAt?: string | null }) => {
        const job = state.queue.find((j) => j.id === id);
        if (job) {
          job.status = opts.nextRetryAt ? 'pending' : 'dead';
          job.nextRetryAt = opts.nextRetryAt ?? null;
        }
        return job ?? null;
      },
      retry: (id: string) => {
        const job = state.queue.find((j) => j.id === id);
        if (job) {
          job.status = 'pending';
          job.attempts = 0;
          job.nextRetryAt = null;
        }
        return job ?? null;
      },
    },
    changeEvents: {
      appendMany: (events: Array<Record<string, unknown>>) =>
        events.map((event) => {
          eventSeq += 1;
          const row = { ...event, seq: eventSeq };
          state.events.push(row);
          return row;
        }),
    },
    snapshots: {
      writeText: (input: Record<string, unknown>) => {
        snapshotSeq += 1;
        state.snapshots.push({ id: snapshotSeq, ...input });
        return { snapshot: { id: snapshotSeq }, blob: { created: true }, blobCreated: true };
      },
    },
    sourceHealth: {
      upsert: (row: Record<string, unknown>) => {
        state.sourceHealth.push(row);
        return row;
      },
    },
  };

  return { repos: repos as unknown as never, state, reposRaw: repos };
}

function makeWorker(adapters: PlatformRefreshAdapters, options: FakePlatformOptions = {}) {
  const { repos, state, reposRaw } = makeFakeRepos(options);
  const worker = createPlatformRefreshWorker({
    repos: repos as never,
    adapters,
    config: { workerId: 'test-refresh', jobRefreshDays: 7, storeRefreshDays: 30, maxJobsPerTick: 20, dueScanLimit: 50 },
    clock: () => NOW,
  });
  return { worker, state, reposRaw };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('platform refresh pure helpers', () => {
  it('computes platform status thresholds (active <=8d / stale 9-45d / lost >45d)', () => {
    expect(computePlatformStatus(NOW_ISO, NOW)).toBe('active');
    expect(computePlatformStatus(daysAgo(8), NOW)).toBe('active');
    expect(computePlatformStatus(daysAgo(9), NOW)).toBe('stale');
    expect(computePlatformStatus(daysAgo(45), NOW)).toBe('stale');
    expect(computePlatformStatus(daysAgo(46), NOW)).toBe('lost');
    expect(computePlatformStatus(null, NOW)).toBe('stale');
  });

  it('checks refresh due time', () => {
    expect(isRefreshDue(daysAgo(1), NOW)).toBe(true);
    expect(isRefreshDue(daysFromNow(1), NOW)).toBe(false);
    expect(isRefreshDue(null, NOW)).toBe(true);
  });

  it('plans job lifecycle: added / closed / reactivated', () => {
    const existing = [
      { jobId: 'a', status: 'active' },
      { jobId: 'b', status: 'active' },
      { jobId: 'c', status: 'closed' },
    ];
    const fetched = [
      normalizedJob('boss', 'boss_1', 'a', '外贸业务员'),
      normalizedJob('boss', 'boss_1', 'c', '外贸经理'),
      normalizedJob('boss', 'boss_1', 'd', '单证员'),
    ];
    const plan = planJobLifecycle(existing, fetched, { maxJobs: 500 });
    expect(plan.addedJobIds).toEqual(['d']);
    expect(plan.reactivatedJobIds).toEqual(['c']);
    expect(plan.closedJobIds).toEqual(['b']);
    expect(plan).toMatchObject({ previousActive: 2, previousTotal: 3, nextActive: 3, nextTotal: 4, truncated: false });
  });

  it('does not close missing jobs when the fetched list is truncated', () => {
    const existing = [{ jobId: 'a', status: 'active' }, { jobId: 'b', status: 'active' }];
    const fetched = [normalizedJob('boss', 'boss_1', 'a', 'x'), normalizedJob('boss', 'boss_1', 'c', 'y')];
    const plan = planJobLifecycle(existing, fetched, { maxJobs: 1 });
    expect(plan.truncated).toBe(true);
    expect(plan.closedJobIds).toEqual([]);
  });

  it('diffs profile first-class fields and json blocks', () => {
    const previous = { displayName: 'A', tags: ['x'], jobCount: 1, platformStatus: 'active' } as never;
    const next = { displayName: 'B', tags: ['x'], jobCount: 2, platformStatus: 'active' } as never;
    const diffs = diffPlatformProfile(previous, next);
    expect(diffs.map((d) => d.field)).toEqual(['displayName', 'jobCount']);
  });
});

// ---------------------------------------------------------------------------
// 新公司即时抓取
// ---------------------------------------------------------------------------

describe('PlatformRefreshWorker · new company immediate refresh', () => {
  it('enqueues 4 platform profiles + 2 recruitment job lists and writes normalized data', async () => {
    const adapters = makeFakeAdapters({
      details: {
        boss_1: detail('boss', 'boss_1', {
          displayName: '河北测试机械有限公司',
          fullName: '河北测试机械有限公司',
          industry: '进出口贸易',
          scale: '100-499人',
          cityName: '石家庄',
          jobCount: 12,
          bossCount: 2,
          recruiters: [{ name: '王*', title: 'HR', online: true }],
          tags: ['外贸'],
        }),
        zh_1: detail('zhilian', 'zh_1', { displayName: '河北测试机械有限公司', industry: '贸易', scale: '100-299人', cityName: '石家庄', jobCount: 6 }),
        ali_1: detail('ali', 'ali_1', {
          displayName: 'Hebei Test Machinery Co., Ltd.',
          industry: '机械',
          store: { membership: { label: 'Verified Supplier' }, joinedYears: 8, mainProducts: ['valve'] },
        }),
        mic_1: detail('mic', 'mic_1', {
          displayName: 'Hebei Test Machinery Co., Ltd.',
          store: { membership: { tier: 'diamond', sinceYear: 2015 }, audited: true },
        }),
      },
      jobs: {
        boss_1: [normalizedJob('boss', 'boss_1', 'j1', '外贸业务员'), normalizedJob('boss', 'boss_1', 'j2', '外贸经理')],
        zh_1: [normalizedJob('zhilian', 'zh_1', 'z1', '外贸专员')],
      },
    });
    const { worker, state } = makeWorker(adapters);

    const jobIds = await worker.enqueueNewCompany('cmp_001');
    expect(jobIds).toHaveLength(6); // 4 profile + 2 jobs

    const summary = await worker.runOnce({ enqueueDue: false });
    expect(summary.claimed).toBe(6);
    expect(summary.completed).toBe(6);
    expect(summary.failed).toBe(0);

    // 4 平台档案
    expect(state.profiles).toHaveLength(4);
    const bossProfile = state.profiles.find((p) => p.platform === 'boss') as Record<string, unknown>;
    expect(bossProfile).toMatchObject({ displayName: '河北测试机械有限公司', industry: '进出口贸易', jobCount: 12, bossCount: 2, platformStatus: 'active' });
    expect(bossProfile.nextJobsRefreshAt).toBe(daysFromNow(7));
    expect(bossProfile.lastFetchedAt).toBe(NOW_ISO);

    const aliProfile = state.profiles.find((p) => p.platform === 'ali') as Record<string, unknown>;
    expect((aliProfile.store as Record<string, unknown>).joinedYears).toBe(8);
    expect(aliProfile.nextStoreRefreshAt).toBe(daysFromNow(30));

    // 岗位生命周期入库
    const bossJobs = state.jobs.filter((j) => j.platform === 'boss');
    expect(bossJobs).toHaveLength(2);
    expect(bossJobs.every((j) => j.status === 'active')).toBe(true);
    expect(state.jobs.filter((j) => j.platform === 'zhilian')).toHaveLength(1);

    // Ali/Mic 英文抬头写入公司主档（供 fuma 海关查询 / tanji 英文匹配）
    expect(state.englishNameUpdates).toContainEqual({ id: 'cmp_001', englishName: 'Hebei Test Machinery Co., Ltd.' });
    expect(state.events.some((e) => e.field === 'englishName')).toBe(true);

    // 原始快照：6 次抓取
    expect(state.snapshots.length).toBe(6);
  });

  it('handles manual refresh enqueue with platform/kind filters', async () => {
    const { worker, state } = makeWorker(makeFakeAdapters());
    const result = await worker.enqueueManual('cmp_001', { platforms: ['ali'], kinds: ['profile'] });
    expect(result.jobIds).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({ stage: 'platform_profile', platform: 'ali' });
    // Ali/Mic 无岗位列表：jobs kind 被忽略，不产生 platform_jobs 任务
    const aliOnly = await worker.enqueueManual('cmp_001', { platforms: ['ali'], kinds: ['jobs'] });
    expect(aliOnly.jobIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 岗位生命周期（二次刷新）
// ---------------------------------------------------------------------------

describe('PlatformRefreshWorker · job lifecycle', () => {
  it('adds new jobs, closes missing jobs and reactivates reopened jobs with aggregate event', async () => {
    const existingProfile = {
      companyId: 'cmp_001',
      platform: 'boss',
      platformCompanyId: 'boss_1',
      displayName: '河北测试机械有限公司',
      industry: '进出口贸易',
      jobCount: 3,
      platformStatus: 'active',
      lastFetchedAt: daysAgo(7),
      nextJobsRefreshAt: daysFromNow(1),
      version: 2,
    };
    const existingJobs = [
      { companyId: 'cmp_001', platform: 'boss', platformCompanyId: 'boss_1', jobId: 'j1', title: '外贸业务员', status: 'active', firstSeenAt: daysAgo(30), lastSeenAt: daysAgo(7) },
      { companyId: 'cmp_001', platform: 'boss', platformCompanyId: 'boss_1', jobId: 'j2', title: '外贸经理', status: 'active', firstSeenAt: daysAgo(20), lastSeenAt: daysAgo(7) },
      { companyId: 'cmp_001', platform: 'boss', platformCompanyId: 'boss_1', jobId: 'j3', title: '单证员', status: 'closed', firstSeenAt: daysAgo(60), lastSeenAt: daysAgo(40), closedAt: daysAgo(40) },
    ];
    const adapters = makeFakeAdapters({
      jobs: {
        boss_1: [
          normalizedJob('boss', 'boss_1', 'j1', '外贸业务员'),
          normalizedJob('boss', 'boss_1', 'j3', '单证员'),
          normalizedJob('boss', 'boss_1', 'j4', '海外销售'),
        ],
      },
    });
    const { worker, state, reposRaw } = makeWorker(adapters, { profiles: [existingProfile], jobs: existingJobs });
    reposRaw.jobs.enqueue({ companyId: 'cmp_001', stage: 'platform_jobs', platform: 'boss' });

    const summary = await worker.runOnce({ enqueueDue: false });
    expect(summary.claimed).toBeGreaterThanOrEqual(1);

    const byId = new Map(state.jobs.map((j) => [String(j.jobId), j]));
    expect(byId.get('j1')).toMatchObject({ status: 'active', firstSeenAt: daysAgo(30) }); // 保留 first_seen_at
    expect(byId.get('j2')).toMatchObject({ status: 'closed', closedAt: NOW_ISO });
    expect(byId.get('j3')).toMatchObject({ status: 'active', closedAt: null });
    expect(byId.get('j4')).toMatchObject({ status: 'active', firstSeenAt: NOW_ISO });

    const aggregateEvent = state.events.find((e) => e.field === 'platforms.boss.jobs') as Record<string, unknown>;
    expect(aggregateEvent).toBeTruthy();
    expect(aggregateEvent.eventType).toBe('platform.jobs.updated');
    expect(aggregateEvent.source).toBe('source:boss');
    expect(aggregateEvent.newValue).toMatchObject({ active: 3, added: 1, closed: 1, total: 4, reactivated: 1 });

    const profile = state.profiles.find((p) => p.platform === 'boss') as Record<string, unknown>;
    expect(profile.version).toBe(3); // jobs 变化 → 档案版本 +1
    expect(profile.nextJobsRefreshAt).toBe(daysFromNow(7));
  });
});

// ---------------------------------------------------------------------------
// 档案 diff / 到期调度 / 失联
// ---------------------------------------------------------------------------

describe('PlatformRefreshWorker · profile diff & scheduling', () => {
  it('writes field-level change events when platform profile fields change', async () => {
    const existingProfile = {
      companyId: 'cmp_001',
      platform: 'boss',
      platformCompanyId: 'boss_1',
      displayName: '河北测试机械有限公司',
      industry: '旧行业',
      scale: '20-99人',
      jobCount: 3,
      platformStatus: 'stale',
      lastFetchedAt: daysAgo(20),
      nextJobsRefreshAt: daysAgo(1),
      version: 1,
    };
    const adapters = makeFakeAdapters({
      details: {
        boss_1: detail('boss', 'boss_1', { displayName: '河北测试机械有限公司', industry: '进出口贸易', scale: '100-499人', jobCount: 15 }),
      },
    });
    const { worker, state } = makeWorker(adapters, { profiles: [existingProfile] });
    await worker.runOnce();

    const fields = state.events.map((e) => e.field);
    expect(fields).toContain('platforms.boss.industry');
    expect(fields).toContain('platforms.boss.scale');
    expect(fields).toContain('platforms.boss.jobCount');
    expect(fields).not.toContain('platforms.boss.displayName'); // 未变化不产生事件
    const profile = state.profiles[0] as Record<string, unknown>;
    expect(profile.version).toBe(2);
    expect(profile.platformStatus).toBe('active');
  });

  it('enqueues weekly recruitment + monthly store refresh tasks only when due', async () => {
    const profiles = [
      { companyId: 'cmp_001', platform: 'boss', platformCompanyId: 'boss_1', lastFetchedAt: daysAgo(20), nextJobsRefreshAt: daysAgo(1), platformStatus: 'stale', version: 1 },
      { companyId: 'cmp_001', platform: 'ali', platformCompanyId: 'ali_1', lastFetchedAt: daysAgo(40), nextStoreRefreshAt: daysAgo(1), platformStatus: 'stale', version: 1, store: { membership: {} } },
      { companyId: 'cmp_001', platform: 'zhilian', platformCompanyId: 'zh_1', lastFetchedAt: daysAgo(1), nextJobsRefreshAt: daysFromNow(6), platformStatus: 'active', version: 1 },
      { companyId: 'cmp_001', platform: 'mic', platformCompanyId: 'mic_1', lastFetchedAt: daysAgo(2), nextStoreRefreshAt: daysFromNow(28), platformStatus: 'active', version: 1 },
    ];
    const { worker, state } = makeWorker(makeFakeAdapters(), { profiles });
    const due = await worker.enqueueDue();
    expect(due.jobs).toBe(3); // boss profile + boss jobs + ali store
    expect(state.queue.filter((j) => j.stage === 'platform_profile').length).toBe(2);
    expect(state.queue.filter((j) => j.stage === 'platform_jobs').length).toBe(1);

    // 逾期平台状态在扫描时刷新为 stale/lost（不 bump 版本）
    const aliProfile = state.profiles.find((p) => p.platform === 'ali') as Record<string, unknown>;
    expect(['stale', 'lost']).toContain(aliProfile.platformStatus);
    expect(aliProfile.version).toBe(1);
  });

  it('marks platform lost after 3 consecutive NOT_FOUND failures', async () => {
    const existingProfile = {
      companyId: 'cmp_001',
      platform: 'boss',
      platformCompanyId: 'boss_1',
      displayName: '河北测试机械有限公司',
      platformStatus: 'stale',
      lastFetchedAt: daysAgo(30),
      version: 2,
    };
    const adapters = makeFakeAdapters({ details: { boss_1: new LeadError('NOT_FOUND', 'company not found upstream') } });
    const { worker, state, reposRaw } = makeWorker(adapters, { profiles: [existingProfile] });
    // 模拟第 3 次尝试
    reposRaw.jobs.enqueue({ companyId: 'cmp_001', stage: 'platform_profile', platform: 'boss' });
    const job = state.queue[0] as Record<string, unknown>;
    job.attempts = 2;
    job.status = 'pending';

    await worker.runOnce({ enqueueDue: false });
    const profile = state.profiles[0] as Record<string, unknown>;
    expect(profile.platformStatus).toBe('lost');
    expect(state.queue[0]).toMatchObject({ status: 'dead', nextRetryAt: null });
  });

  it('marks source health on session invalid and schedules retry', async () => {
    const adapters = makeFakeAdapters({
      details: { boss_1: new LeadError('SOURCE_SESSION_INVALID', 'boss login expired') },
    });
    const { worker, state, reposRaw } = makeWorker(adapters);
    reposRaw.jobs.enqueue({ companyId: 'cmp_001', stage: 'platform_profile', platform: 'boss' });
    const summary = await worker.runOnce({ enqueueDue: false });
    expect(summary.failed).toBe(1);
    expect(state.sourceHealth).toContainEqual(expect.objectContaining({ platform: 'boss', state: 'session_invalid' }));
    const job = state.queue[0] as Record<string, unknown>;
    expect(job.status).toBe('pending');
    expect(String(job.nextRetryAt)).toMatch(/^2026-11-17T/);
  });
});


describe('flat AppConfig wiring helper', () => {
  it('createPlatformRefreshWorkerFromConfig maps Lead config flat fields and injects adapters', () => {
    const adapters = makeFakeAdapters();
    const worker = createPlatformRefreshWorkerFromConfig(
      {} as never,
      { jobRefreshDays: 3, storeRefreshDays: 14, jobLeaseSec: 20, jobMaxAttempts: 5, platformActiveDays: 2, platformLostDays: 9, bossUrl: 'http://127.0.0.1:8790', bossToken: 'tok' },
      { adapters, clock: () => NOW },
    );
    expect(worker.getConfig()).toMatchObject({ jobRefreshDays: 3, storeRefreshDays: 14, leaseSec: 20, jobMaxAttempts: 5, activeDays: 2, lostDays: 9 });
  });
});
