/**
 * S4 编排单测：查询拆分 / 流式入库 / Run 状态 / 来源失效跳过 / 失败继续 / 取消 / 调度与中断恢复。
 * 使用内存 fake repos + fake adapters（绝不访问真实上游/DB）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChangeEventInput } from '../../src/shared/domain.js';
import type {
  Company,
  CompanySource,
  Goal,
  GoalRun,
  Platform,
  RegionRow,
  RunStats,
  SourceHealth,
  SourceHealthState,
  SourceLead,
} from '../../src/shared/domain.js';
import type {
  CompanySourceUpsertInput,
  GoalCreateData,
  GoalRunsPort,
  GoalsPort,
  MaybePromise,
  PipelineEnqueueInput,
  PipelineJobsPort,
  PipelineRepos,
  RegionMappingRow,
  RegionsPort,
  SnapshotWriteInput,
  SnapshotsPort,
  SourceHealthPort,
  SourceQueriesPort,
  SourceQueryCreateInput,
  SourceQueryRecord,
} from '../../src/pipeline/ports.js';
import { buildSourceQueries, RunOrchestrator, provinceCityKey } from '../../src/pipeline/orchestrator.js';
import { Scheduler } from '../../src/pipeline/scheduler.js';
import { RegionRegistry } from '../../src/region/registry.js';
import { LeadError } from '../../src/shared/errors.js';
import { nowIso } from '../../src/shared/time.js';
import type { AliSource, MicSource, PlatformCompanyDetail, RecruitmentSource, SourceStatus } from '../../src/adapters/sources/types.js';

// ---------------------------------------------------------------------------
// Fake repositories
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class FakeRepos implements PipelineRepos {
  goalsMap = new Map<string, Goal>();
  runsMap = new Map<string, GoalRun & { heartbeatAt?: string | null }>();
  queries = new Map<string, SourceQueryRecord>();
  snapshots: SnapshotWriteInput[] = [];
  companiesMap = new Map<string, Company>();
  sources: CompanySource[] = [];
  jobs: PipelineEnqueueInput[] = [];
  health = new Map<string, SourceHealth>();
  changeEventList: ChangeEventInput[] = [];
  archived: string[] = [];
  private seq = 0;

  goals: GoalsPort = {
    create: (input: GoalCreateData): MaybePromise<Goal> => {
      const now = nowIso();
      const goal: Goal = {
        id: `goal_${++this.seq}`,
        name: input.name,
        region: input.region,
        platforms: input.platforms,
        keywords: input.keywords,
        maxLeadsPerRun: input.maxLeadsPerRun ?? null,
        dailyLeadLimit: input.dailyLeadLimit ?? null,
        schedule: { cron: input.schedule.cron, timeZone: input.schedule.timeZone, timeWindow: input.schedule.timeWindow ?? null },
        priority: input.priority,
        tradeFilter: input.tradeFilter ?? null,
        unlockPolicy: input.unlockPolicy,
        enabled: input.enabled ?? true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.goalsMap.set(goal.id, goal);
      return goal;
    },
    getById: (id) => this.goalsMap.get(id) ?? null,
    list: (filter) => [...this.goalsMap.values()].filter((g) => (filter?.enabled === undefined ? true : g.enabled === filter.enabled)),
    update: (id, patch) => {
      const goal = this.goalsMap.get(id);
      if (!goal) throw new LeadError('NOT_FOUND', 'goal not found');
      Object.assign(goal, patch, { version: goal.version + 1 });
      return goal;
    },
    setEnabled: (id, enabled) => {
      const goal = this.goalsMap.get(id);
      if (goal) goal.enabled = enabled;
    },
  };

  runs: GoalRunsPort = {
    create: (input) => {
      const now = nowIso();
      const run: GoalRun = {
        id: input.id ?? `run_${++this.seq}`,
        goalId: input.goalId,
        trigger: input.trigger,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        stats: {},
        errorCode: null,
        errorMessage: null,
        createdAt: now,
      };
      this.runsMap.set(run.id, run);
      return run;
    },
    getById: (id) => this.runsMap.get(id) ?? null,
    list: (filter) => [...this.runsMap.values()].filter((r) => (!filter?.goalId || r.goalId === filter.goalId) && (!filter?.status || r.status === filter.status)),
    listByGoal: (goalId, limit) => [...this.runsMap.values()].filter((r) => r.goalId === goalId).slice(0, limit ?? 20),
    findActiveByGoal: (goalId) => [...this.runsMap.values()].find((r) => r.goalId === goalId && (r.status === 'pending' || r.status === 'running')) ?? null,
    findInterrupted: () => [...this.runsMap.values()].filter((r) => r.status === 'pending' || r.status === 'running'),
    updateStatus: (id, status, opts) => {
      const run = this.runsMap.get(id);
      if (!run) return null;
      run.status = status;
      if (opts?.finishedAt !== undefined) run.finishedAt = opts.finishedAt;
      if (opts?.stats) run.stats = opts.stats;
      if (opts?.errorCode !== undefined) run.errorCode = opts.errorCode;
      if (opts?.errorMessage !== undefined) run.errorMessage = opts.errorMessage;
      if (status === 'running' && !run.startedAt) run.startedAt = nowIso();
      return run;
    },
    updateStats: (id, stats) => {
      const run = this.runsMap.get(id);
      if (run) run.stats = stats;
    },
    heartbeat: (id, at) => {
      const run = this.runsMap.get(id);
      if (run) run.heartbeatAt = at ?? nowIso();
    },
  };

  sourceQueries: SourceQueriesPort = {
    create: (input: SourceQueryCreateInput) => {
      const key = `${input.runId}|${input.platform}|${input.platformRegionValue}|${input.keyword ?? ''}`;
      for (const q of this.queries.values()) if (`${q.runId}|${q.platform}|${q.platformRegionValue}|${q.keyword ?? ''}` === key) return { query: q, created: false };
      const query: SourceQueryRecord = {
        id: `q_${++this.seq}`,
        runId: input.runId,
        platform: input.platform,
        cityCode: input.cityCode,
        platformRegionValue: input.platformRegionValue,
        keyword: input.keyword ?? null,
        upstreamQueryId: null,
        status: 'pending',
        pagesFetched: 0,
        totalPages: null,
        totalCount: null,
        lastError: null,
        startedAt: null,
        finishedAt: null,
      };
      this.queries.set(query.id, query);
      return { query, created: true };
    },
    listByRun: (runId) => [...this.queries.values()].filter((q) => q.runId === runId),
    updateProgress: (id, patch) => {
      const q = this.queries.get(id);
      if (q) Object.assign(q, patch);
    },
  };

  snapshotsPort: SnapshotsPort = {
    writeText: (input: SnapshotWriteInput) => {
      this.snapshots.push(input);
      return { snapshot: { id: this.snapshots.length, kind: input.kind, blobHash: `sha256:${this.snapshots.length}` }, blobCreated: true };
    },
  };

  companies: PipelineRepos['companies'] = {
    create: (input) => {
      const now = nowIso();
      const company: Company = {
        id: input.id ?? `cmp_${++this.seq}`,
        name: input.name,
        normalizedName: input.normalizedName ?? input.name,
        englishName: input.englishName ?? null,
        uscc: input.uscc ?? null,
        tanjiCompanyId: null,
        legalRepresentative: null,
        regCapital: null,
        foundTime: null,
        operStatus: null,
        industry: null,
        scale: null,
        province: input.province ?? null,
        city: input.city ?? null,
        district: null,
        address: null,
        businessScope: null,
        homepage: null,
        phoneCount: null,
        emailCount: null,
        contactCount: null,
        tradeTags: [],
        extra: null,
        sourceCount: input.sourceCount ?? 1,
        enrichmentStatus: input.enrichmentStatus ?? 'discovered',
        unlockStatus: 'none',
        matchMeta: null,
        firstRunId: input.firstRunId ?? null,
        firstSeenAt: input.firstSeenAt ?? now,
        lastSeenAt: input.lastSeenAt ?? now,
        mergedInto: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.companiesMap.set(company.id, company);
      return company;
    },
    getById: (id) => this.companiesMap.get(id) ?? null,
    findByUscc: (uscc) => [...this.companiesMap.values()].find((c) => c.uscc === uscc) ?? null,
    findByNormalizedName: (normalizedName) => [...this.companiesMap.values()].find((c) => c.normalizedName === normalizedName) ?? null,
    update: (id, patch) => {
      const company = this.companiesMap.get(id);
      if (!company) throw new LeadError('NOT_FOUND', 'company not found');
      Object.assign(company, patch);
      return company;
    },
    touchLastSeen: (id, at) => {
      const company = this.companiesMap.get(id);
      if (company) company.lastSeenAt = at ?? nowIso();
    },
  };

  companySources: PipelineRepos['companySources'] = {
    upsert: (input: CompanySourceUpsertInput) => {
      const existing = this.sources.find((s) => s.platform === input.platform && s.platformCompanyId === input.platformCompanyId);
      if (existing) {
        existing.lastSeenAt = input.lastSeenAt ?? nowIso();
        return { source: existing, created: false };
      }
      const source: CompanySource = {
        id: `src_${++this.seq}`,
        companyId: input.companyId,
        platform: input.platform,
        platformCompanyId: input.platformCompanyId,
        sourceName: input.sourceName ?? null,
        sourceUrl: input.sourceUrl ?? null,
        cityName: input.cityName ?? null,
        evidence: input.evidence,
        firstSeenAt: input.firstSeenAt ?? nowIso(),
        lastSeenAt: input.lastSeenAt ?? nowIso(),
      };
      this.sources.push(source);
      return { source, created: true };
    },
    getByPlatformId: (platform, platformCompanyId) => this.sources.find((s) => s.platform === platform && s.platformCompanyId === platformCompanyId) ?? null,
    countByCompany: (companyId) => this.sources.filter((s) => s.companyId === companyId).length,
  };

  jobsPort: PipelineJobsPort = {
    enqueue: (input) => {
      this.jobs.push(input);
      return { job: { id: `job_${this.jobs.length}` }, created: true };
    },
  };

  regions: RegionsPort = {
    upsertRegions: () => undefined,
    listCities: (): RegionRow[] => [],
    getRegion: () => null,
    upsertMapping: (_row: RegionMappingRow) => undefined,
    upsertMappings: () => undefined,
    getMapping: () => null,
    listMappingsForProvince: () => ({}),
  };

  sourceHealthPort: SourceHealthPort = {
    upsert: (input) => {
      const health: SourceHealth = {
        platform: input.platform,
        state: input.state as SourceHealthState,
        loggedIn: input.loggedIn ?? null,
        expiresAt: input.expiresAt ?? null,
        checkedAt: input.checkedAt ?? nowIso(),
        consecutiveFailures: input.consecutiveFailures ?? 0,
        detail: input.detail ?? null,
      };
      this.health.set(input.platform, health);
      return health;
    },
    get: (platform) => this.health.get(platform) ?? null,
    listAll: () => [...this.health.values()],
  };

  changeEventsPort = {
    append: (input: ChangeEventInput) => {
      this.changeEventList.push(input);
      return { seq: this.changeEventList.length };
    },
  };

  get jobsRepo(): PipelineJobsPort {
    return this.jobsPort;
  }
}

/** 组装 PipelineRepos 视图（把上面的字段映射到接口字段名） */
function assemble(repos: FakeRepos): PipelineRepos {
  return {
    goals: repos.goals,
    runs: repos.runs,
    sourceQueries: repos.sourceQueries,
    snapshots: repos.snapshotsPort,
    companies: repos.companies,
    companySources: repos.companySources,
    jobs: repos.jobsPort,
    regions: repos.regions,
    sourceHealth: repos.sourceHealthPort,
    changeEvents: repos.changeEventsPort,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = nowIso();
  return {
    id: 'goal_test',
    name: '河北省-外贸线索',
    region: { province: '河北省', provinceCode: '130000' },
    platforms: ['boss', 'zhilian', 'ali', 'mic'],
    keywords: { boss: ['外贸'], zhilian: ['外贸'], ali: ['machinery'], mic: [] },
    maxLeadsPerRun: null,
    dailyLeadLimit: null,
    schedule: { cron: '0 2 * * *', timeZone: 'Asia/Shanghai', timeWindow: '02:00-08:00' },
    priority: 100,
    tradeFilter: null,
    unlockPolicy: { mode: 'priority', order: ['recruiting', 'paid_member', 'customs', 'rest'] },
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRun(goalId: string, id = 'run_test'): GoalRun {
  return {
    id,
    goalId,
    trigger: 'manual',
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    stats: {},
    errorCode: null,
    errorMessage: null,
    createdAt: nowIso(),
  };
}

function lead(platform: Platform, platformCompanyId: string, companyName: string, cityName: string | null = '石家庄'): SourceLead {
  return {
    platform,
    platformCompanyId,
    companyName,
    cityName,
    sourceUrl: `https://example.com/${platform}/${platformCompanyId}`,
    evidence: { jobCount: 1 },
    raw: { platformCompanyId, companyName },
  };
}

function statusOf(platform: Platform, state: SourceHealthState = 'ok'): SourceStatus {
  return { platform, state, loggedIn: state === 'ok', expiresAt: null, checkedAt: nowIso(), detail: null };
}

function makeRecruitment(platform: 'boss' | 'zhilian', leads: SourceLead[], state: SourceHealthState = 'ok') {
  const adapter: RecruitmentSource = {
    platform,
    getStatus: async () => statusOf(platform, state),
    listRegions: async () => [],
    searchJobs: vi.fn(async ({ keyword, cityCode }: { keyword: string; cityCode: string }) => ({
      platform,
      queryId: `q_${platform}_${cityCode}_${keyword}`,
      keyword,
      cityCode,
      cityName: null,
      pageSize: 15,
      pagesFetched: 1,
      totalCount: 10,
      hasMore: false,
      jobs: [],
      raw: { keyword, cityCode },
    })),
    listCompanies: vi.fn(async () => leads),
    listJobsByPage: vi.fn(async () => []),
    getCompanyDetail: async () => ({ platform, platformCompanyId: 'x', displayName: null, sourceUrl: null, profile: {} as never, jobs: [], business: null, raw: {}, fetchedAt: nowIso() }) as PlatformCompanyDetail,
    listCompanyJobs: async () => [],
  };
  return adapter;
}

function makeAli(leads: SourceLead[], failMatrix = false) {
  const adapter: AliSource = {
    platform: 'ali',
    getStatus: async () => statusOf('ali'),
    listRegions: async () => [],
    searchSuppliers: vi.fn(async (input: { keyword?: string | null; province?: string | null; locationMode?: string }) => {
      if (failMatrix) throw new LeadError('SOURCE_UNAVAILABLE', 'ali upstream failed');
      return {
        platform: 'ali' as const,
        queryId: `q_ali_${input.keyword ?? 'province'}`,
        keyword: input.keyword ?? null,
        locationMode: (input.locationMode ?? 'strict') as 'strict' | 'keyword' | 'off',
        pagesFetched: 1,
        totalCount: leads.length,
        hasMore: false,
        suppliers: input.keyword ? [] : leads,
        raw: { input },
      };
    }),
    listSuppliers: async () => ({ page: 2, suppliers: [], hasMore: false, raw: {} }),
    getSupplierDetail: async () => ({ platform: 'ali', platformCompanyId: 'x', displayName: null, sourceUrl: null, profile: {} as never, jobs: [], business: null, raw: {}, fetchedAt: nowIso() }),
  };
  return adapter;
}

function makeMic(leads: SourceLead[]) {
  const adapter: MicSource = {
    platform: 'mic',
    getStatus: async () => statusOf('mic'),
    listRegions: async () => [],
    searchFactories: vi.fn(async (input: { keyword?: string | null }) => ({
      platform: 'mic' as const,
      keyword: input.keyword ?? null,
      province: 'Hebei',
      city: null,
      page: 1,
      pageSize: 20,
      total: leads.length,
      totalPages: 1,
      hasMore: false,
      items: input.keyword ? [] : leads,
      raw: { input },
    })),
    getCompanyDetail: async () => ({ platform: 'mic', platformCompanyId: 'x', displayName: null, sourceUrl: null, profile: {} as never, jobs: [], business: null, raw: {}, fetchedAt: nowIso() }),
  };
  return adapter;
}

function setup() {
  const fake = new FakeRepos();
  const repos = assemble(fake);
  const registry = new RegionRegistry(repos.regions);
  return { fake, repos, registry };
}

// ---------------------------------------------------------------------------
// 查询拆分
// ---------------------------------------------------------------------------

describe('buildSourceQueries：Run → 平台 × 城市 × 关键词', () => {
  it('Boss/智联 = 城市 × 关键词；Ali = 省级 + 城市种子 + 县级 + 行业矩阵；Mic = 省 + 城市关键词', async () => {
    const { repos, registry } = setup();
    const resolved = await registry.resolveCities({ province: '河北省' });
    const goal = makeGoal();
    const queries = buildSourceQueries(goal, resolved);
    const byPlatform = (p: Platform) => queries.filter((q) => q.platform === p);
    // Boss/智联：11 市 × 1 关键词
    expect(byPlatform('boss')).toHaveLength(11);
    expect(byPlatform('zhilian')).toHaveLength(11);
    expect(byPlatform('boss')[0]).toMatchObject({ cityCode: '130100', platformRegionValue: '101090100', keyword: '外贸', strategy: 'keyword_city' });
    // Ali：1 省种子 + 11 城市英文种子 + 118 县级种子 + (1 省行业 + 11 城市行业)
    expect(byPlatform('ali')).toHaveLength(1 + 11 + 118 + 1 + 11);
    expect(byPlatform('ali').find((q) => q.strategy === 'geography_seed' && q.cityCode === provinceCityKey('130000'))).toMatchObject({
      platformRegionValue: 'CN-13',
      keyword: null,
    });
    expect(byPlatform('ali').find((q) => q.strategy === 'industry_matrix' && q.keyword === 'machinery')).toBeTruthy();
    expect(byPlatform('ali').find((q) => q.strategy === 'industry_matrix' && q.keyword === 'Shijiazhuang machinery')).toBeTruthy();
    // Mic：1 省查询（无关键词）+ 11 市关键词（英文名）
    expect(byPlatform('mic')).toHaveLength(12);
    expect(byPlatform('mic').find((q) => q.keyword === 'Shijiazhuang' && q.strategy === 'mic_city_keyword')).toBeTruthy();
    expect(byPlatform('mic').find((q) => q.keyword === null && q.strategy === 'mic_province')).toBeTruthy();
    expect(repos.sourceHealth).toBeTruthy();
  });

  it('策略开关可关闭 Ali 县级/矩阵（夜间窗口可控）', async () => {
    const { registry } = setup();
    const resolved = await registry.resolveCities({ province: '河北省' });
    const queries = buildSourceQueries(makeGoal(), resolved, { aliCountySeeds: false, aliIndustryMatrix: false });
    expect(queries.filter((q) => q.platform === 'ali')).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// 流式采集主流程
// ---------------------------------------------------------------------------

describe('RunOrchestrator.executeRun', () => {
  it('流式入库：公司/source/任务/快照/查询进度/Run.stats + coverage 指标', async () => {
    const { fake, repos, registry } = setup();
    const goal = makeGoal();
    fake.goalsMap.set(goal.id, goal);
    fake.runsMap.set('run_test', makeRun(goal.id));
    // 健康状态全部 ok
    for (const platform of ['boss', 'zhilian', 'ali', 'mic'] as Platform[]) {
      await fake.sourceHealthPort.upsert({ platform, state: 'ok', loggedIn: true, checkedAt: nowIso() });
    }
    const orchestrator = new RunOrchestrator({
      repos,
      registry,
      adapters: {
        boss: makeRecruitment('boss', [lead('boss', 'b1', '河北测试进出口有限公司'), lead('boss', 'b2', '石家庄第二贸易有限公司')]),
        zhilian: makeRecruitment('zhilian', [lead('zhilian', 'z1', '河北测试进出口有限公司'), lead('zhilian', 'z2', '唐山机械有限公司', '唐山市')]),
        ali: makeAli([lead('ali', 'a1', 'Hebei Jidi Machinery Co., Ltd.', 'Shijiazhuang')]),
        mic: makeMic([lead('mic', 'm1', 'Hebei Huatong Wires & Cables Group Co., Ltd.', 'Tangshan')]),
      },
      maxPagesPerQuery: 1,
      queryOptions: { aliCountySeeds: false },
      runMaxHours: 6,
    });
    const result = await orchestrator.executeRun('run_test');
    expect(result.run.status).toBe('completed');
    expect(result.timedOut).toBe(false);
    // 5 家唯一公司（boss 2 + zhilian 1 新 + ali 1 + mic 1；zhilian 与 boss 同名合并）
    expect(fake.companiesMap.size).toBe(5);
    // 来源记录 6 条（同名公司 1 条 boss + 1 条 zhilian）
    expect(fake.sources).toHaveLength(6);
    // 新公司各投递 1 个流水线任务（boss/智联→source_detail；ali/mic→tanji_match）
    expect(fake.jobs).toHaveLength(5);
    expect(fake.jobs.find((j) => j.stage === 'source_detail')?.platform).toBe('boss');
    expect(fake.jobs.find((j) => j.stage === 'tanji_match')).toBeTruthy();
    // 新公司入库产生 company.created 事件（webhook/SSE 依赖）
    const createdEvents = fake.changeEventList.filter((e) => e.eventType === 'company.created');
    expect(createdEvents).toHaveLength(5);
    expect(createdEvents.every((e) => e.source.startsWith('source:'))).toBe(true);
    expect(createdEvents[0]?.version).toBe(1);
    expect(createdEvents[0]?.newValue).toMatchObject({ name: expect.any(String), runId: 'run_test' });
    // 快照：每个查询至少一条检索页快照
    expect(fake.snapshots.length).toBeGreaterThanOrEqual(fake.queries.size);
    expect(fake.snapshots.every((s) => s.kind === 'source_search_page')).toBe(true);
    // source_queries 全部 done
    expect([...fake.queries.values()].every((q) => q.status === 'done')).toBe(true);
    // Run.stats：平台进度 + coverage
    const coverage = result.stats.coverage;
    expect(coverage?.uniqueCompanies).toBe(5);
    expect(coverage?.crossSourceOverlap).toBe(1);
    expect(coverage?.coverageByCity['石家庄']).toBeGreaterThanOrEqual(2);
    expect(Object.keys(coverage?.coverageByCity ?? {}).length).toBeGreaterThanOrEqual(2);
    expect(result.stats.platforms?.boss?.queries).toBe(11);
    expect(result.stats.platforms?.boss?.leads).toBe(22);
    expect(result.stats.coverage?.keywordYield?.['外贸']).toBeGreaterThan(0);
    expect(fake.runsMap.get('run_test')?.status).toBe('completed');
    expect(fake.runsMap.get('run_test')?.finishedAt).toBeTruthy();
  });

  it('来源失效：采集前 health=session_invalid → 跳过该来源，其余来源继续，Run=partial', async () => {
    const { fake, repos, registry } = setup();
    const goal = makeGoal({ platforms: ['boss', 'zhilian'] });
    fake.goalsMap.set(goal.id, goal);
    fake.runsMap.set('run_test', makeRun(goal.id));
    await fake.sourceHealthPort.upsert({ platform: 'boss', state: 'ok', loggedIn: true });
    await fake.sourceHealthPort.upsert({ platform: 'zhilian', state: 'session_invalid', loggedIn: false });
    const zhilian = makeRecruitment('zhilian', [lead('zhilian', 'z1', '智联公司')], 'session_invalid');
    const orchestrator = new RunOrchestrator({
      repos,
      registry,
      adapters: { boss: makeRecruitment('boss', [lead('boss', 'b1', 'Boss公司')]), zhilian },
      maxPagesPerQuery: 1,
    });
    const result = await orchestrator.executeRun('run_test');
    expect(result.run.status).toBe('partial');
    expect(result.skippedSources).toEqual([expect.objectContaining({ platform: 'zhilian', errorCode: 'SOURCE_SESSION_INVALID' })]);
    expect(zhilian.searchJobs).not.toHaveBeenCalled();
    expect(fake.companiesMap.size).toBe(1);
    // 智联查询已预建并标记 skipped（Run 详情可观测）
    const zhQueries = [...fake.queries.values()].filter((q) => q.platform === 'zhilian');
    expect(zhQueries.length).toBeGreaterThan(0);
    expect(zhQueries.every((q) => q.status === 'skipped')).toBe(true);
  });

  it('查询失败：Ali 失败但不影响其它平台，Run=partial，查询记录 failed', async () => {
    const { fake, repos, registry } = setup();
    const goal = makeGoal({ platforms: ['boss', 'ali'] });
    fake.goalsMap.set(goal.id, goal);
    fake.runsMap.set('run_test', makeRun(goal.id));
    await fake.sourceHealthPort.upsert({ platform: 'boss', state: 'ok', loggedIn: true });
    const orchestrator = new RunOrchestrator({
      repos,
      registry,
      adapters: {
        boss: makeRecruitment('boss', [lead('boss', 'b1', 'Boss公司')]),
        ali: makeAli([], true),
      },
      maxPagesPerQuery: 1,
      queryOptions: { aliCountySeeds: false },
    });
    const result = await orchestrator.executeRun('run_test');
    expect(result.run.status).toBe('partial');
    const aliQueries = [...fake.queries.values()].filter((q) => q.platform === 'ali');
    expect(aliQueries.length).toBeGreaterThan(0);
    expect(aliQueries.every((q) => q.status === 'failed')).toBe(true);
    expect(aliQueries[0]?.lastError).toContain('SOURCE_UNAVAILABLE');
    // Boss 仍然入库
    expect(fake.companiesMap.size).toBe(1);
  });

  it('取消：Run 已 cancelled → 不再采集', async () => {
    const { fake, repos, registry } = setup();
    const goal = makeGoal({ platforms: ['boss'] });
    fake.goalsMap.set(goal.id, goal);
    const run = makeRun(goal.id);
    run.status = 'cancelled';
    fake.runsMap.set(run.id, run);
    const boss = makeRecruitment('boss', [lead('boss', 'b1', 'Boss公司')]);
    const orchestrator = new RunOrchestrator({ repos, registry, adapters: { boss }, maxPagesPerQuery: 1 });
    const result = await orchestrator.executeRun(run.id);
    expect(result.run.status).toBe('cancelled');
    expect(boss.searchJobs).not.toHaveBeenCalled();
    expect(fake.companiesMap.size).toBe(0);
  });

  it('无重叠：同一 Goal 已有 running Run → startRun 抛 RUN_IN_PROGRESS', async () => {
    const { fake, repos, registry } = setup();
    const goal = makeGoal({ platforms: ['boss'] });
    fake.goalsMap.set(goal.id, goal);
    const running = makeRun(goal.id, 'run_running');
    running.status = 'running';
    fake.runsMap.set(running.id, running);
    const orchestrator = new RunOrchestrator({
      repos,
      registry,
      adapters: { boss: makeRecruitment('boss', []) },
      maxPagesPerQuery: 1,
    });
    await expect(orchestrator.startRun(goal.id, 'manual')).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
  });

  it('Run.stats 平台进度随查询刷新（heartbeat 被调用）', async () => {
    const { fake, repos, registry } = setup();
    const goal = makeGoal({ platforms: ['boss'], keywords: { boss: ['外贸'] } });
    fake.goalsMap.set(goal.id, goal);
    fake.runsMap.set('run_test', makeRun(goal.id));
    await fake.sourceHealthPort.upsert({ platform: 'boss', state: 'ok', loggedIn: true });
    const orchestrator = new RunOrchestrator({
      repos,
      registry,
      adapters: { boss: makeRecruitment('boss', [lead('boss', 'b1', 'Boss公司')]) },
      maxPagesPerQuery: 1,
    });
    const result = await orchestrator.executeRun('run_test');
    expect(result.stats.platforms?.boss?.queries).toBe(11);
    expect(result.stats.pagesFetched).toBeGreaterThanOrEqual(11);
    expect(fake.runsMap.get('run_test')?.heartbeatAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe('Scheduler', () => {
  function setupScheduler() {
    const fake = new FakeRepos();
    const repos = assemble(fake);
    const executed: string[] = [];
    let clock = Date.parse('2026-11-16T10:00:00Z'); // 2026-11-16 18:00 Asia/Shanghai
    const executor = {
      startRun: vi.fn(async (goalId: string, trigger: 'cron' | 'manual') => {
        executed.push(goalId);
        const run = makeRun(goalId, `run_${executed.length}`);
        fake.runsMap.set(run.id, run);
        return { run, execution: Promise.resolve({ run, stats: {}, skippedSources: [], timedOut: false }) };
      }),
      executeRun: vi.fn(async (runId: string) => ({ run: makeRun('goal', runId), stats: {}, skippedSources: [], timedOut: false })),
    };
    const scheduler = new Scheduler({ repos, executor, now: () => new Date(clock), tickMs: 30_000, setTimer: () => 0, clearTimer: () => undefined });
    return {
      fake,
      repos,
      executor,
      scheduler,
      executed,
      advance(ms: number) {
        clock += ms;
      },
      setClock(ms: number) {
        clock = ms;
      },
    };
  }

  it('cron 到期触发一次；未到期不触发；时间窗外跳过', async () => {
    const { fake, scheduler, executor, executed, advance } = setupScheduler();
    // 2026-11-16T18:00:00Z = 2026-11-17 02:00 Asia/Shanghai（恰好命中 0 2 * * *）
    const base = Date.parse('2026-11-16T17:59:30Z'); // 01:59:30 Asia/Shanghai
    const goal = makeGoal({ id: 'goal_cron', schedule: { cron: '0 2 * * *', timeZone: 'Asia/Shanghai', timeWindow: null } });
    fake.goalsMap.set(goal.id, goal);
    scheduler.start();
    // 等待启动时的首次 tick 完成（只计算下一次触发时间）
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(executor.startRun).not.toHaveBeenCalled();
    scheduler['now'] = () => new Date(base);
    await scheduler.tick(); // 未到期（下一次 02:00 本地）
    expect(executor.startRun).not.toHaveBeenCalled();
    // 推进到 02:00:30（本地）→ 到期触发一次
    scheduler['now'] = () => new Date(base + 60_000);
    await scheduler.tick();
    expect(executor.startRun).toHaveBeenCalledTimes(1);
    expect(executed[0]).toBe(goal.id);
    scheduler['now'] = () => new Date(base + 120_000);
    await scheduler.tick();
    expect(executor.startRun).toHaveBeenCalledTimes(1);
    await scheduler.stop();
    void advance;
  });

  it('RUN_IN_PROGRESS 不导致调度崩溃；恢复中断 Run → partial', async () => {
    const { fake, scheduler, executor } = setupScheduler();
    const goal = makeGoal({ id: 'goal_busy' });
    fake.goalsMap.set(goal.id, goal);
    executor.startRun.mockRejectedValueOnce(new LeadError('RUN_IN_PROGRESS', '已有运行中 Run'));
    const base = Date.parse('2026-11-16T17:59:30Z');
    scheduler['now'] = () => new Date(base);
    scheduler.start();
    await scheduler.tick();
    scheduler['now'] = () => new Date(base + 60_000);
    await scheduler.tick();
    const interrupted = makeRun(goal.id, 'run_interrupted');
    interrupted.status = 'running';
    fake.runsMap.set(interrupted.id, interrupted);
    const recovered = await scheduler.recoverInterruptedRuns();
    expect(recovered).toBe(1);
    expect(fake.runsMap.get(interrupted.id)?.status).toBe('partial');
    expect(fake.runsMap.get(interrupted.id)?.errorCode).toBe('INTERRUPTED');
    await scheduler.stop();
  });
});
