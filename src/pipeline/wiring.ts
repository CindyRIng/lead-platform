/**
 * 进程级接线（Wiring）：把 F1 config / F2 repositories / S1 region / S2-S3 adapters /
 * S4 orchestrator + scheduler 组装成一个可启动的 PipelineRuntime。
 *
 * main.ts（foundation-dev 维护）只需：
 * ```ts
 * const runtime = await initPipelineRuntime({ db, config });
 * await runtime.start();     // 区域基线 + 中断恢复 + 调度器 + 区域字典每日同步
 * // ... process.on('SIGTERM', () => runtime.stop())
 * ```
 */
import type { AppConfig } from '../config.js';
import type { DbConnection } from '../repositories/sql.js';
import { createRepositories, tryGetRepositories, type Repositories } from '../repositories/index.js';
import type {
  CompanySourcesPort,
  CompaniesPort,
  GoalRunsPort,
  GoalsPort,
  PipelineJobsPort,
  PipelineRepos,
  RegionsPort,
  SnapshotsPort,
  SourceHealthPort,
  SourceQueriesPort,
} from './ports.js';
import { RegionRegistry } from '../region/registry.js';
import { startRegionSyncLoop, syncRegionDictionaries, type RegionSyncLoop, type RegionSyncSummary } from '../region/sync.js';
import type { SourceAdapterRegistry } from '../adapters/sources/types.js';
import { BossAdapter } from '../adapters/sources/boss.js';
import { ZhilianAdapter } from '../adapters/sources/zhilian.js';
import { AliAdapter } from '../adapters/sources/ali.js';
import { MicAdapter } from '../adapters/sources/mic.js';
import { RunOrchestrator, type BuildQueriesOptions } from './orchestrator.js';
import { Scheduler } from './scheduler.js';
import {
  initServiceContext,
  resetServiceContext,
  type ServiceContext,
  type ServiceLogger,
} from '../services/context.js';
import { companiesDepsFromRepositories, recordCompanyCreated as recordCompanyCreatedEvent } from '../services/companies.js';
import { resetGoalService } from '../services/goals.js';
import { resetRunService } from '../services/runs.js';
import { resetSnapshotService } from '../services/snapshots.js';
import { resetSourceService } from '../services/sources.js';

export interface PipelineRuntime {
  config: AppConfig;
  repos: Repositories;
  pipelineRepos: PipelineRepos;
  registry: RegionRegistry;
  adapters: SourceAdapterRegistry;
  orchestrator: RunOrchestrator;
  scheduler: Scheduler;
  regionSync: RegionSyncLoop | null;
  ctx: ServiceContext;
  started: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 手动同步一次区域字典（调试/管理用） */
  syncRegions(): Promise<RegionSyncSummary>;
}

export interface InitPipelineRuntimeOptions {
  db: DbConnection;
  config: AppConfig;
  /** 复用已初始化的 F2 repositories（main.ts 已 initRepositories 时传 runtime.repos 或省略自动探测） */
  repos?: Repositories;
  logger?: ServiceLogger | null;
  /** 注入自定义适配器（测试/替换用）；缺省按 config.upstream 构造真实适配器 */
  adapters?: Partial<SourceAdapterRegistry>;
  /** 是否启动 scheduler（默认 config.schedulerEnabled） */
  startScheduler?: boolean;
  /** 是否启动区域字典每日同步（默认 true） */
  startRegionSync?: boolean;
  /** 启动时是否立即同步一次区域字典（默认 true，失败不阻塞） */
  regionSyncOnStart?: boolean;
  /** Ali 采集策略开关（透传 orchestrator） */
  queryOptions?: BuildQueriesOptions;
  /** 覆盖 maxPagesPerQuery（默认 config.maxPagesPerQuery） */
  maxPagesPerQuery?: number | null;
  /** 覆盖 runMaxHours（默认 config.runMaxHours） */
  runMaxHours?: number;
  /** 测试用时钟/定时器注入 */
  now?: () => Date;
}

/** F2 Repositories → 编排层窄端口（少量签名/形状适配） */
export function toPipelineRepos(repos: Repositories): PipelineRepos {
  const goals: GoalsPort = {
    create: (input) => repos.goals.create(input),
    getById: (id) => repos.goals.getById(id),
    list: (filter) => repos.goals.list(filter),
    update: (id, patch, opts) => repos.goals.update(id, patch as Parameters<Repositories['goals']['update']>[1], opts),
    setEnabled: (id, enabled) => {
      repos.goals.setEnabled(id, enabled);
    },
  };
  const runs: GoalRunsPort = {
    create: (input) => repos.runs.create({ goalId: input.goalId, trigger: input.trigger, id: input.id }),
    getById: (id) => repos.runs.getById(id),
    list: (filter) => repos.runs.list(filter),
    listByGoal: (goalId, limit) => repos.runs.listByGoal(goalId, limit),
    findActiveByGoal: (goalId) => repos.runs.findActiveByGoal(goalId),
    findInterrupted: () => repos.runs.findInterrupted(),
    updateStatus: (id, status, opts) =>
      repos.runs.updateStatus(id, status, {
        finishedAt: opts?.finishedAt,
        errorCode: opts?.errorCode,
        errorMessage: opts?.errorMessage,
        stats: opts?.stats,
      }),
    updateStats: (id, stats) => {
      repos.runs.updateStats(id, stats);
    },
    heartbeat: (id, at) => {
      repos.runs.heartbeat(id, at);
    },
  };
  const sourceQueries: SourceQueriesPort = {
    create: (input) => repos.sourceQueries.create(input),
    listByRun: (runId) => repos.sourceQueries.listByRun(runId),
    updateProgress: (id, patch) => repos.sourceQueries.updateProgress(id, patch),
  };
  const snapshots: SnapshotsPort = {
    writeText: (input) => repos.snapshots.writeText(input),
  };
  const companies: CompaniesPort = {
    create: (input) => repos.companies.create(input),
    getById: (id) => repos.companies.getById(id),
    findByUscc: (uscc) => repos.companies.findByUscc(uscc),
    findByNormalizedName: (normalizedName, filter) => {
      const hits = repos.companies.findByNormalizedName(normalizedName, {
        province: filter?.province ?? undefined,
        city: filter?.city ?? undefined,
      });
      return hits[0] ?? null;
    },
    update: (id, patch, opts) => repos.companies.update(id, patch as Parameters<Repositories['companies']['update']>[1], opts),
    touchLastSeen: (id, at) => {
      repos.companies.touchLastSeen(id, at);
    },
  };
  const companySources: CompanySourcesPort = {
    upsert: (input) => repos.companySources.upsert(input),
    getByPlatformId: (platform, platformCompanyId) => repos.companySources.getByPlatformId(platform, platformCompanyId),
    countByCompany: (companyId) => repos.companySources.countByCompany(companyId),
  };
  const jobs: PipelineJobsPort = {
    enqueue: (input) =>
      repos.jobs.enqueue({
        companyId: input.companyId,
        stage: input.stage as Parameters<Repositories['jobs']['enqueue']>[0]['stage'],
        platform: (input.platform ?? null) as Parameters<Repositories['jobs']['enqueue']>[0]['platform'],
        runId: input.runId ?? null,
        maxAttempts: input.maxAttempts,
        nextRetryAt: input.nextRetryAt ?? null,
      }),
  };
  const regions: RegionsPort = {
    upsertRegions: (rows) => {
      repos.regions.upsertRegions(rows);
    },
    listCities: (provinceCode) => repos.regions.listCities(provinceCode),
    getRegion: (code) => repos.regions.getRegion(code),
    upsertMapping: (row) => {
      repos.regions.upsertMapping(row);
    },
    upsertMappings: (rows) => {
      repos.regions.upsertMappings(rows);
    },
    getMapping: (regionCode, platform) => repos.regions.getMapping(regionCode, platform),
    listMappingsForProvince: (provinceCode, platform) => repos.regions.listMappingsForProvince(provinceCode, platform),
  };
  const sourceHealth: SourceHealthPort = {
    upsert: (input) => repos.sourceHealth.upsert(input),
    get: (platform) => repos.sourceHealth.get(platform),
    listAll: () => repos.sourceHealth.listAll(),
  };
  const changeEvents = {
    append: (input: Parameters<Repositories['changeEvents']['append']>[0]) => repos.changeEvents.append(input),
  };
  const meta = {
    get: (key: string) => repos.meta.get(key),
    set: (key: string, value: unknown) => {
      repos.meta.set(key, value);
    },
  };
  return { goals, runs, sourceQueries, snapshots, companies, companySources, jobs, regions, sourceHealth, changeEvents, meta };
}

/** 按 config 构造四个真实上游适配器（只读；不在此处发请求） */
export function createDefaultSourceAdapters(config: AppConfig): SourceAdapterRegistry {
  return {
    boss: new BossAdapter({ baseUrl: config.bossUrl, token: config.bossToken || null }),
    zhilian: new ZhilianAdapter({ baseUrl: config.zhilianUrl, token: config.zhilianToken || null }),
    ali: new AliAdapter({ baseUrl: config.aliUrl, token: config.aliToken || null }),
    mic: new MicAdapter({ baseUrl: config.micUrl, token: null }),
  };
}

export async function initPipelineRuntime(opts: InitPipelineRuntimeOptions): Promise<PipelineRuntime> {
  const { db, config } = opts;
  const repos =
    opts.repos ??
    tryGetRepositories() ??
    createRepositories(db, {
      snapshotCompression: config.snapshotCompression === 'none' ? 'plain' : config.snapshotCompression,
      jobLeaseSec: config.jobLeaseSec,
      jobMaxAttempts: config.jobMaxAttempts,
      webhookMaxAttempts: config.webhookMaxAttempts,
      jobRefreshDays: config.jobRefreshDays,
      storeRefreshDays: config.storeRefreshDays,
      customsRefreshDays: config.customsRefreshDays,
    });
  const pipelineRepos = toPipelineRepos(repos);
  const registry = new RegionRegistry(pipelineRepos.regions, { now: () => (opts.now?.() ?? new Date()).toISOString() });
  const adapters: SourceAdapterRegistry = {
    ...createDefaultSourceAdapters(config),
    ...(opts.adapters ?? {}),
  };
  const logger = opts.logger ?? null;

  // 新公司入库事件：复用 services/companies 的 company.created 事件写入（含 valueType/actor 等契约）
  const companyEventDeps = companiesDepsFromRepositories(repos);
  const orchestrator = new RunOrchestrator({
    repos: pipelineRepos,
    recordCompanyCreated: (company, ctx) => {
      recordCompanyCreatedEvent(
        company,
        { source: ctx.source, runId: ctx.runId, actor: 'system', initial: ctx.initial },
        companyEventDeps,
      );
    },
    registry,
    adapters,
    logger,
    now: opts.now,
    runMaxHours: opts.runMaxHours ?? config.runMaxHours,
    maxPagesPerQuery: opts.maxPagesPerQuery !== undefined ? opts.maxPagesPerQuery : config.maxPagesPerQuery,
    queryOptions: opts.queryOptions,
  });

  const scheduler = new Scheduler({
    repos: pipelineRepos,
    executor: orchestrator,
    logger,
    now: opts.now,
    enabled: opts.startScheduler ?? config.schedulerEnabled,
    defaultTimeZone: config.tz,
    acquireLeader: async () => {
      try {
        return repos.meta.acquireLease('scheduler.leader', process.pid.toString(), 120_000);
      } catch {
        return true;
      }
    },
  });

  const ctx: ServiceContext = {
    repos: pipelineRepos,
    registry,
    adapters,
    logger,
    now: opts.now,
    runMaxHours: opts.runMaxHours ?? config.runMaxHours,
  };
  initServiceContext(ctx);
  resetGoalService();
  resetRunService();
  resetSnapshotService();
  resetSourceService();

  const regionSyncDeps = {
    registry,
    adapters,
    sourceHealth: pipelineRepos.sourceHealth,
    logger,
  };
  const regionSync =
    opts.startRegionSync === false
      ? null
      : startRegionSyncLoop(regionSyncDeps, { runOnStart: opts.regionSyncOnStart !== false });

  let started = false;
  const runtime: PipelineRuntime = {
    config,
    repos,
    pipelineRepos,
    registry,
    adapters,
    orchestrator,
    scheduler,
    regionSync,
    ctx,
    started: false,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      await registry.ensureBaseline().catch(() => undefined);
      await scheduler.recoverInterruptedRuns().catch(() => 0);
      if (opts.startScheduler === false || config.schedulerEnabled === false) {
        // 显式禁用时不注册 cron，仅保持手动触发能力
      } else {
        scheduler.start();
      }
      runtime.started = true;
    },
    async stop(): Promise<void> {
      regionSync?.stop();
      await scheduler.stop();
      resetServiceContext();
      started = false;
      runtime.started = false;
    },
    syncRegions(): Promise<RegionSyncSummary> {
      return syncRegionDictionaries(regionSyncDeps);
    },
  };
  return runtime;
}
