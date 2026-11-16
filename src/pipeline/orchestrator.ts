/**
 * Run Orchestrator（FR-3/FR-4）：Run → 「平台 × 城市 × 关键词」source_queries → 流式采集。
 *
 * 核心约束：
 * 1. 流式：每拿到一页/一家公司立即落原始快照 + 公司主档 + company_sources + pipeline_jobs；
 * 2. 幂等：同一来源记录只关联一次；唯一约束由 F2 repositories 保证；
 * 3. 按来源串行 + 限频（adapter/http 层令牌桶）；采集前检查 source_health，失效来源跳过、Run 继续；
 * 4. 单轮最长 runMaxHours（默认 6h），超时停止派发并置 partial；
 * 5. Run.stats 记录平台进度 + coverage 指标（uniqueCompanies/crossSourceOverlap/coverageByCity/keywordYield）。
 *
 * 采集策略（docs/04 §8）：
 * - Boss/智联：城市 × 关键词，翻页至上限；
 * - Ali：地理种子（省/市/县英文名，locationMode=off，本地按名称判河北）+ 行业词×城市 strict 矩阵；
 * - Mic：省检索 + 11 市关键词并集（城市随结果本地过滤/标注）。
 */
import { DEFAULT_KEYWORDS } from '../shared/constants.js';
import type {
  Company,
  CoverageStats,
  Goal,
  GoalRun,
  Platform,
  RunStats,
  SourceLead,
} from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { normalizeCompanyName } from '../domain/normalize.js';
import { canonicalCityName, canonicalCityShortName, classifyHebeiCompanyName } from '../region/names.js';
import { HEBEI_COUNTIES } from '../data/regions.js';
import type { RegionRegistry, ResolvedCity } from '../region/registry.js';
import type {
  ChangeEventsPort,
  CompanySourcesPort,
  CompaniesPort,
  GoalRunsPort,
  GoalsPort,
  MaybePromise,
  PipelineJobsPort,
  PipelineRepos,
  SourceHealthPort,
  SourceQueriesPort,
  SnapshotsPort,
} from './ports.js';
import type { ServiceLogger } from '../services/context.js';
import type { MicSource, RecruitmentSource, SourceAdapterRegistry } from '../adapters/sources/types.js';
import { createSnapshotService, type SnapshotService, type SnapshotWriteResult } from '../services/snapshots.js';

// ---------------------------------------------------------------------------
// 查询计划
// ---------------------------------------------------------------------------

export type QueryStrategy =
  | 'keyword_city'
  | 'province_keyword'
  | 'geography_seed'
  | 'geography_county'
  | 'industry_matrix'
  | 'mic_city_keyword'
  | 'mic_province';

export interface PlannedQuery {
  platform: Platform;
  /** 规范城市 code；省级检索写 province:<code> */
  cityCode: string;
  /** 实际传给平台的区域取值（Boss cityCode / 智联 code / Ali CN-13-xxx / Mic English） */
  platformRegionValue: string;
  keyword: string | null;
  strategy: QueryStrategy;
  /** 该查询最多翻页数 */
  maxPages: number;
}

const PROVINCE_CITY_PREFIX = 'province:';

export function provinceCityKey(provinceCode: string): string {
  return `${PROVINCE_CITY_PREFIX}${provinceCode}`;
}

/** 执行一个可能同步/异步的仓库调用并吞掉异常（采集主流程不因辅助写入失败而中断） */
async function swallow<T>(fn: () => MaybePromise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export interface BuildQueriesOptions {
  /** 单查询最大页数（boss/zhilian/ali/mic 通用上限，默认 5；null=平台硬上限） */
  maxPagesPerQuery?: number | null;
  /** Ali 地理种子（省/市英文名） */
  aliGeoSeeds?: boolean;
  /** Ali 县级种子 */
  aliCountySeeds?: boolean;
  /** Ali 行业×城市 strict 矩阵 */
  aliIndustryMatrix?: boolean;
}

const PLATFORM_DEFAULT_MAX_PAGES: Record<Platform, number> = { boss: 10, zhilian: 10, ali: 20, mic: 20 };

function resolveMaxPages(opts: BuildQueriesOptions | undefined, platform: Platform): number {
  const configured = opts?.maxPagesPerQuery;
  if (configured === undefined || configured === null) return PLATFORM_DEFAULT_MAX_PAGES[platform];
  return Math.max(1, Math.min(configured, PLATFORM_DEFAULT_MAX_PAGES[platform]));
}

/**
 * 把一个 Goal 拆成「平台 × 城市 × 关键词」检索计划（source_queries 的输入）。
 * 导出供单测直接验证查询拆分（覆盖指标/上限/策略）。
 */
export function buildSourceQueries(
  goal: Goal,
  resolved: { provinceCode: string; provinceName: string; cities: ResolvedCity[] },
  opts?: BuildQueriesOptions,
): PlannedQuery[] {
  const queries: PlannedQuery[] = [];
  const platforms = goal.platforms;
  const provinceKey = provinceCityKey(resolved.provinceCode);
  const provinceAli = resolved.cities.find((c) => c.platformValues.ali)?.platformValues.ali?.replace(/-\d{4}$/, '') ?? 'CN-13';
  const provinceMic = 'Hebei';
  const maxPages = (p: Platform): number => resolveMaxPages(opts, p);
  const keywords = (p: Platform): string[] => goal.keywords[p] ?? DEFAULT_KEYWORDS[p] ?? [];

  for (const platform of platforms) {
    if (platform === 'boss' || platform === 'zhilian') {
      const kw = keywords(platform);
      for (const city of resolved.cities) {
        const value = city.platformValues[platform];
        if (!value) continue;
        for (const keyword of kw) {
          queries.push({ platform, cityCode: city.code, platformRegionValue: value, keyword, strategy: 'keyword_city', maxPages: maxPages(platform) });
        }
      }
      continue;
    }

    if (platform === 'ali') {
      // 1) 地理种子：省（strict 基础路径，docs/04 实测 province=河北 → totalCount 739）
      if (opts?.aliGeoSeeds !== false) {
        queries.push({ platform, cityCode: provinceKey, platformRegionValue: provinceAli, keyword: null, strategy: 'geography_seed', maxPages: maxPages('ali') });
        // 2) 城市英文名种子（locationMode=off，本地按名称判河北）
        for (const city of resolved.cities) {
          if (!city.englishName) continue;
          queries.push({
            platform,
            cityCode: city.code,
            platformRegionValue: 'geo:off',
            keyword: city.englishName,
            strategy: 'geography_seed',
            maxPages: maxPages('ali'),
          });
        }
      }
      // 3) 县级英文名种子（locationMode=off）
      if (opts?.aliCountySeeds !== false) {
        for (const county of HEBEI_COUNTIES) {
          queries.push({
            platform,
            cityCode: county.parentCode,
            platformRegionValue: 'geo:off',
            keyword: county.englishName,
            strategy: 'geography_county',
            maxPages: maxPages('ali'),
          });
        }
      }
      // 4) 行业词 × 城市 strict 矩阵（province=Hebei, maxEnrich=60; 1 页/查询）
      if (opts?.aliIndustryMatrix !== false) {
        const industries = keywords('ali');
        for (const industry of industries) {
          queries.push({ platform, cityCode: provinceKey, platformRegionValue: provinceAli, keyword: industry, strategy: 'industry_matrix', maxPages: 1 });
          for (const city of resolved.cities) {
            if (!city.englishName) continue;
            queries.push({
              platform,
              cityCode: city.code,
              platformRegionValue: city.platformValues.ali ?? provinceAli,
              keyword: `${city.englishName} ${industry}`,
              strategy: 'industry_matrix',
              maxPages: 1,
            });
          }
        }
      }
      continue;
    }

    if (platform === 'mic') {
      // 省检索（无关键词）
      queries.push({ platform, cityCode: provinceKey, platformRegionValue: provinceMic, keyword: null, strategy: 'mic_province', maxPages: maxPages('mic') });
      // 11 市关键词并集（城市为客户端过滤；keyword 用英文城市名）
      for (const city of resolved.cities) {
        if (!city.englishName) continue;
        queries.push({
          platform,
          cityCode: city.code,
          platformRegionValue: provinceMic,
          keyword: city.englishName,
          strategy: 'mic_city_keyword',
          maxPages: Math.min(3, maxPages('mic')),
        });
      }
    }
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface CompanyCreatedContext {
  source: string;
  runId: string;
  initial: Record<string, unknown>;
}

/** 新公司入库事件钩子（wiring 注入 services/companies#recordCompanyCreated；不注入时回退 changeEvents 端口） */
export type RecordCompanyCreated = (company: Company, ctx: CompanyCreatedContext) => MaybePromise<void>;

export interface OrchestratorDeps {
  repos: PipelineRepos;
  registry: RegionRegistry;
  adapters: Partial<SourceAdapterRegistry>;
  logger?: ServiceLogger | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  runMaxHours?: number;
  maxPagesPerQuery?: number | null;
  queryOptions?: BuildQueriesOptions;
  snapshots?: SnapshotService;
  recordCompanyCreated?: RecordCompanyCreated;
}

export interface ExecuteRunOptions {
  /** 已取消/超时后仍等待在飞请求结束；当前实现是顺序执行，无在飞请求 */
  signal?: AbortSignal;
}

export interface SkippedSource {
  platform: Platform;
  reason: string;
  errorCode?: string;
}

export interface RunExecutionResult {
  run: GoalRun;
  stats: RunStats;
  skippedSources: SkippedSource[];
  timedOut: boolean;
}

interface PlatformStats {
  queries: number;
  pages: number;
  leads: number;
  companiesNew: number;
}

class CoverageTracker {
  private readonly byCompany = new Map<string, { platforms: Set<Platform>; city: string | null }>();
  keywordYield: Record<string, number> = {};

  add(companyId: string, platform: Platform, city: string | null, keyword: string | null): void {
    const entry = this.byCompany.get(companyId) ?? { platforms: new Set<Platform>(), city };
    entry.platforms.add(platform);
    if (!entry.city && city) entry.city = city;
    this.byCompany.set(companyId, entry);
    const key = keyword ?? '(none)';
    this.keywordYield[key] = (this.keywordYield[key] ?? 0) + 1;
  }

  stats(): CoverageStats {
    const coverageByCity: Record<string, number> = {};
    let crossSourceOverlap = 0;
    for (const entry of this.byCompany.values()) {
      if (entry.platforms.size >= 2) crossSourceOverlap += 1;
      const city = canonicalCityShortName(entry.city) ?? (entry.city ?? '未知').replace(/(市|地区|盟)$/g, '');
      coverageByCity[city] = (coverageByCity[city] ?? 0) + 1;
    }
    return { uniqueCompanies: this.byCompany.size, crossSourceOverlap, coverageByCity, keywordYield: { ...this.keywordYield } };
  }
}

export class RunOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly snapshots: SnapshotService;
  private readonly now: () => Date;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.snapshots = deps.snapshots ?? createSnapshotService({ snapshots: deps.repos.snapshots, now: this.now });
  }

  /** 创建 Run 并异步执行（scheduler/手动触发共用入口） */
  async startRun(goalId: string, trigger: 'cron' | 'manual' = 'manual', actor?: string): Promise<{ run: GoalRun; execution: Promise<RunExecutionResult> }> {
    const goal = await this.deps.repos.goals.getById(goalId);
    if (!goal) throw new LeadError('NOT_FOUND', `Goal 不存在：${goalId}`, { details: { goalId } });
    if (!goal.enabled) throw new LeadError('CONFLICT', `Goal 已停用，无法触发：${goalId}`, { details: { goalId } });
    const active = await this.deps.repos.runs.findActiveByGoal(goalId);
    if (active) {
      throw new LeadError('RUN_IN_PROGRESS', `Goal 已有运行中的 Run：${active.id}`, {
        details: { goalId, runId: active.id, status: active.status },
      });
    }
    const run = await this.deps.repos.runs.create({ goalId, trigger, actor });
    const execution = this.executeRun(run.id).catch((err: unknown) => {
      const lead = err instanceof LeadError ? err : new LeadError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      this.log('error', 'run.execute.failed', { runId: run.id, code: lead.code, message: lead.message });
      return this.finalizeFailed(run, lead);
    });
    return { run, execution };
  }

  /** 执行一个已创建的 Run（幂等：非 pending/running 状态直接返回） */
  async executeRun(runId: string, opts?: ExecuteRunOptions): Promise<RunExecutionResult> {
    const repos = this.deps.repos;
    const run = await repos.runs.getById(runId);
    if (!run) throw new LeadError('NOT_FOUND', `Run 不存在：${runId}`, { details: { runId } });
    if (run.status === 'cancelled') return { run, stats: run.stats ?? {}, skippedSources: [], timedOut: false };
    if (run.status === 'completed' || run.status === 'partial' || run.status === 'failed') {
      return { run, stats: run.stats ?? {}, skippedSources: [], timedOut: false };
    }
    const goal = await repos.goals.getById(run.goalId);
    if (!goal) {
      return this.finalizeFailed(run, new LeadError('NOT_FOUND', `Goal 不存在：${run.goalId}`, { details: { goalId: run.goalId } }));
    }

    const startedMs = Date.parse(run.startedAt ?? nowIso()) || this.now().getTime();
    await repos.runs.updateStatus(runId, 'running', { stats: run.stats ?? {} });
    const runMaxHours = this.deps.runMaxHours ?? 6;
    const deadline = startedMs + runMaxHours * 3600_000;

    const resolved = await this.deps.registry.resolveCities(goal.region);
    const planned = buildSourceQueries(goal, resolved, this.deps.queryOptions);
    const tracker = new CoverageTracker();
    const platformStats: Partial<Record<Platform, PlatformStats>> = {};
    const skippedSources: SkippedSource[] = [];
    const skippedPlatforms = new Set<Platform>();
    let timedOut = false;
    let totalLeads = 0;
    let companiesNew = 0;
    let failedQueries = 0;
    let pagesFetched = 0;
    const leadCap = goal.maxLeadsPerRun ?? null;
    const dailyCap = goal.dailyLeadLimit ?? null;

    // 1) 采集前来源健康检查
    for (const platform of new Set(planned.map((q) => q.platform))) {
      const adapter = this.deps.adapters[platform];
      if (!adapter) {
        skippedPlatforms.add(platform);
        skippedSources.push({ platform, reason: 'ADAPTER_UNAVAILABLE' });
        continue;
      }
      const health = await this.safeHealth(platform);
      if (health && ['session_invalid', 'verification_pending', 'unavailable'].includes(health.state)) {
        skippedPlatforms.add(platform);
        skippedSources.push({ platform, reason: `SOURCE_HEALTH_${health.state.toUpperCase()}`, errorCode: health.state === 'session_invalid' ? 'SOURCE_SESSION_INVALID' : health.state === 'verification_pending' ? 'SOURCE_VERIFICATION_PENDING' : 'SOURCE_UNAVAILABLE' });
      }
    }

    // 2) 预建 source_queries（流式按计划顺序执行）
    const queryRecords = new Map<string, { id: string; platform: Platform; cityCode: string; platformRegionValue: string; keyword: string | null; strategy: QueryStrategy; maxPages: number }>();
    for (const q of planned) {
      const platformStat = (platformStats[q.platform] ??= { queries: 0, pages: 0, leads: 0, companiesNew: 0 });
      platformStat.queries += 1;
      try {
        const created = await repos.sourceQueries.create({
          runId,
          platform: q.platform,
          cityCode: q.cityCode,
          platformRegionValue: q.platformRegionValue,
          keyword: q.keyword,
        });
        const record = 'query' in created && created.query ? created.query : (created as { id: string });
        queryRecords.set(`${q.platform}|${q.cityCode}|${q.platformRegionValue}|${q.keyword ?? ''}`, {
          id: record.id,
          platform: q.platform,
          cityCode: q.cityCode,
          platformRegionValue: q.platformRegionValue,
          keyword: q.keyword,
          strategy: q.strategy,
          maxPages: q.maxPages,
        });
      } catch (err) {
        this.log('warn', 'run.query.create.failed', { runId, platform: q.platform, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 2.1) 采集前已判定失效的来源：其查询置 skipped（保留 Run 详情可观测性）
    for (const record of queryRecords.values()) {
      if (!skippedPlatforms.has(record.platform)) continue;
      const skip = skippedSources.find((s) => s.platform === record.platform);
      await swallow(() =>
        repos.sourceQueries.updateProgress(record.id, {
          status: 'skipped',
          lastError: skip?.errorCode ? `${skip.errorCode}: ${skip.reason}` : (skip?.reason ?? 'SOURCE_SKIPPED'),
          finishedAt: nowIso(),
        }),
      );
    }

    // 3) 执行查询（按计划顺序；来源内部串行）
    for (const q of planned) {
      if (skippedPlatforms.has(q.platform)) continue;
      const state = await repos.runs.getById(runId);
      if (!state || state.status === 'cancelled') {
        this.log('info', 'run.cancelled', { runId });
        break;
      }
      if (this.now().getTime() >= deadline || opts?.signal?.aborted) {
        timedOut = true;
        break;
      }
      if (leadCap != null && totalLeads >= leadCap) break;
      if (dailyCap != null && totalLeads >= dailyCap) break;
      const key = `${q.platform}|${q.cityCode}|${q.platformRegionValue}|${q.keyword ?? ''}`;
      const record = queryRecords.get(key);
      if (!record) continue;
      const platformStat = (platformStats[q.platform] ??= { queries: 0, pages: 0, leads: 0, companiesNew: 0 });
      if (record.maxPages <= 0) continue;
      try {
        const outcome = await this.executeQuery(goal, run, record, tracker);
        pagesFetched += outcome.pages;
        platformStat.pages += outcome.pages;
        totalLeads += outcome.leads;
        platformStat.leads += outcome.leads;
        companiesNew += outcome.companiesNew;
        platformStat.companiesNew += outcome.companiesNew;
        const status: 'done' | 'skipped' = outcome.skipped ? 'skipped' : 'done';
        await repos.sourceQueries.updateProgress(record.id, {
          pagesFetched: outcome.pages,
          totalCount: outcome.totalCount,
          totalPages: outcome.totalPages,
          status,
          startedAt: outcome.startedAt,
          finishedAt: outcome.finishedAt,
          upstreamQueryId: outcome.upstreamQueryId,
          lastError: outcome.skippedReason ?? null,
        });
        if (outcome.skipped && outcome.errorCode) {
          skippedPlatforms.add(q.platform);
          skippedSources.push({ platform: q.platform, reason: outcome.skippedReason ?? 'SOURCE_SKIPPED', errorCode: outcome.errorCode });
        }
      } catch (err) {
        const lead = err instanceof LeadError ? err : new LeadError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
        failedQueries += 1;
        this.log('warn', 'run.query.failed', { runId, platform: q.platform, keyword: q.keyword, code: lead.code, message: lead.message });
        await swallow(() =>
          repos.sourceQueries.updateProgress(record.id, { status: 'failed', lastError: `${lead.code}: ${lead.message}`, finishedAt: nowIso() }),
        );
        if (lead.code === 'SOURCE_SESSION_INVALID' || lead.code === 'SOURCE_VERIFICATION_PENDING') {
          skippedPlatforms.add(q.platform);
          skippedSources.push({ platform: q.platform, reason: `SOURCE_HEALTH_${lead.code === 'SOURCE_SESSION_INVALID' ? 'SESSION_INVALID' : 'VERIFICATION_PENDING'}`, errorCode: lead.code });
        }
      }
      // 每查询刷新一次 Run.stats + heartbeat（进度可见）
      const coverage = tracker.stats();
      const stats = this.buildStats(platformStats, coverage, skippedSources, pagesFetched);
      await swallow(() => repos.runs.updateStats(runId, stats));
      await swallow(() => repos.runs.heartbeat(runId, nowIso()));
    }

    // 4) 收尾
    const finalState = await repos.runs.getById(runId);
    if (finalState?.status === 'cancelled') {
      return { run: finalState, stats: finalState.stats ?? {}, skippedSources, timedOut };
    }
    const coverage = tracker.stats();
    const stats = this.buildStats(platformStats, coverage, skippedSources, pagesFetched);
    stats.enrichment = { done: 0, unmatched: 0, failed: 0 };
    const status: GoalRun['status'] = timedOut || failedQueries > 0 || skippedSources.length > 0 ? 'partial' : 'completed';
    const updated = await repos.runs.updateStatus(runId, status, {
      finishedAt: nowIso(),
      stats,
      ...(timedOut ? { errorCode: 'RUN_TIMEOUT', errorMessage: `超过单轮最长 ${runMaxHours} 小时` } : {}),
    });
    const finalRun = updated ?? { ...run, status, stats, finishedAt: nowIso() };
    this.log('info', 'run.finished', { runId, status, leads: totalLeads, companiesNew, pages: pagesFetched, timedOut });
    return { run: finalRun, stats, skippedSources, timedOut };
  }

  // -------------------------------------------------------------------------
  // 单条查询执行
  // -------------------------------------------------------------------------

  private async executeQuery(
    goal: Goal,
    run: GoalRun,
    query: {
      id: string;
      platform: Platform;
      cityCode: string;
      platformRegionValue: string;
      keyword: string | null;
      strategy: QueryStrategy;
      maxPages: number;
    },
    tracker: CoverageTracker,
  ): Promise<{
    pages: number;
    leads: number;
    companiesNew: number;
    totalCount: number | null;
    totalPages: number | null;
    upstreamQueryId: string | null;
    startedAt: string;
    finishedAt: string;
    skipped: boolean;
    skippedReason?: string;
    errorCode?: string;
  }> {
    const startedAt = nowIso();
    const platform = query.platform;
    const adapter = this.deps.adapters[platform];
    if (!adapter) throw new LeadError('UNSUPPORTED', `未配置 ${platform} 适配器`);
    let pages = 0;
    let leads = 0;
    let companiesNew = 0;
    let totalCount: number | null = null;
    let totalPages: number | null = null;
    let upstreamQueryId: string | null = null;
    const seen = new Set<string>();

    const ingest = async (list: SourceLead[], pageNo: number): Promise<void> => {
      if (list.length === 0) return;
      leadLoop: for (const lead of list) {
        const dedupeKey = `${platform}|${lead.platformCompanyId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const res = await this.ingestLead(lead, { goal, run, query, pageNo });
        leads += 1;
        if (res.created) companiesNew += 1;
        tracker.add(res.companyId, platform, lead.cityName ?? null, query.keyword);
        const cap = goal.maxLeadsPerRun;
        if (cap != null && leads >= cap) break leadLoop;
      }
    };

    if (platform === 'boss' || platform === 'zhilian') {
      const recruitment = adapter as RecruitmentSource;
      const search = await recruitment.searchJobs({ keyword: query.keyword ?? '', cityCode: query.platformRegionValue, pages: Math.min(5, query.maxPages) });
      upstreamQueryId = search.queryId || null;
      totalCount = search.totalCount;
      await this.writePageSnapshot(run, query, 1, search.raw, { totalCount: search.totalCount, queryId: search.queryId });
      pages += Math.max(1, search.pagesFetched);
      const companyLeads = await recruitment.listCompanies(search.queryId);
      await ingest(companyLeads, pages);
      // 仅在 search 明确 hasMore 时继续按 queryId 续翻（避免无谓请求）
      if (search.hasMore) {
        let page = Math.max(1, search.pagesFetched) + 1;
        while (page <= query.maxPages) {
          const more = await recruitment.listJobsByPage(search.queryId, page);
          await this.writePageSnapshot(run, query, page, { leads: more }, { queryId: search.queryId });
          pages += 1;
          await ingest(more, page);
          if (more.length === 0) break;
          page += 1;
        }
      }
    } else if (platform === 'ali') {
      const ali = adapter as SourceAdapterRegistry['ali'];
      if (query.strategy === 'industry_matrix') {
        const res = await ali.searchSuppliers({
          province: 'Hebei',
          keyword: query.keyword ?? undefined,
          locationMode: 'strict',
          pages: 1,
          maxEnrich: 60,
        });
        upstreamQueryId = res.queryId || null;
        totalCount = res.totalCount;
        totalPages = res.totalCount ? Math.ceil(res.totalCount / 20) : null;
        await this.writePageSnapshot(run, query, 1, res.raw, { totalCount: res.totalCount });
        pages += 1;
        await ingest(res.suppliers, pages);
        // strict 结果已由上游确认省份，无需本地过滤
      } else if (query.strategy === 'geography_county') {
        const res = await ali.searchSuppliers({ keyword: query.keyword ?? undefined, locationMode: 'off', pages: query.maxPages });
        upstreamQueryId = res.queryId || null;
        totalCount = res.totalCount;
        await this.writePageSnapshot(run, query, 1, res.raw, { totalCount: res.totalCount, locationMode: 'off' });
        pages += Math.max(1, res.pagesFetched);
        const hebei = res.suppliers.filter((s) => classifyHebeiCompanyName(s.companyName) === 'hebei');
        await ingest(hebei, pages);
      } else if (query.strategy === 'geography_seed' && query.cityCode.startsWith(PROVINCE_CITY_PREFIX)) {
        // 省级基础路径：province=河北 strict（返回即河北，docs/04 实测 totalCount 739）
        const res = await ali.searchSuppliers({ province: 'Hebei', locationMode: 'strict', pages: query.maxPages, includeUnknownCity: true });
        upstreamQueryId = res.queryId || null;
        totalCount = res.totalCount;
        totalPages = res.totalCount ? Math.ceil(res.totalCount / 20) : null;
        await this.writePageSnapshot(run, query, 1, res.raw, { totalCount: res.totalCount });
        pages += Math.max(1, res.pagesFetched);
        await ingest(res.suppliers, pages);
      } else {
        // 城市英文名种子：locationMode=off + 本地名称判河北
        const res = await ali.searchSuppliers({ keyword: query.keyword ?? undefined, locationMode: 'off', pages: query.maxPages });
        upstreamQueryId = res.queryId || null;
        totalCount = res.totalCount;
        await this.writePageSnapshot(run, query, 1, res.raw, { totalCount: res.totalCount, locationMode: 'off' });
        pages += Math.max(1, res.pagesFetched);
        const hebei = res.suppliers.filter((s) => classifyHebeiCompanyName(s.companyName) === 'hebei');
        await ingest(hebei, pages);
      }
    } else {
      // Mic：省检索 / 城市关键词（客户端过滤）
      const mic = adapter as MicSource;
      let page = 1;
      let hasMore = true;
      while (page <= query.maxPages && hasMore) {
        const res = await mic.searchFactories({
          keyword: query.keyword ?? undefined,
          province: 'Hebei',
          page,
          pageSize: 20,
        });
        totalCount = res.total;
        totalPages = res.totalPages;
        await this.writePageSnapshot(run, query, page, res.raw, { totalCount: res.total, totalPages: res.totalPages });
        pages += 1;
        let items = res.items;
        if (query.strategy === 'mic_city_keyword' && query.keyword) {
          const kw = query.keyword.toLowerCase();
          items = items.filter((item) => (item.cityName ?? '').toLowerCase().includes(kw));
        }
        await ingest(items, page);
        hasMore = res.hasMore === true;
        page += 1;
      }
    }

    return {
      pages,
      leads,
      companiesNew,
      totalCount,
      totalPages,
      upstreamQueryId,
      startedAt,
      finishedAt: nowIso(),
      skipped: false,
    };
  }

  // -------------------------------------------------------------------------
  // 单家公司流式入库
  // -------------------------------------------------------------------------

  private async ingestLead(
    lead: SourceLead,
    ctx: { goal: Goal; run: GoalRun; query: { id: string; keyword: string | null; strategy: QueryStrategy }; pageNo: number },
  ): Promise<{ companyId: string; created: boolean }> {
    const repos = this.deps.repos;
    const now = nowIso();
    let created = false;
    let companyId: string;

    const existingSource = await swallow(() =>
      repos.companySources.getByPlatformId(lead.platform, lead.platformCompanyId),
    );
    if (existingSource) {
      companyId = existingSource.companyId;
      await swallow(() => repos.companies.touchLastSeen(companyId, now));
    } else {
      const normalizedName = normalizeCompanyName(lead.companyName);
      const canonicalCity = canonicalCityName(lead.cityName) ?? lead.cityName ?? null;
      let company = await swallow(() =>
        repos.companies.findByNormalizedName(normalizedName, {
          province: ctx.goal.region.province,
          city: canonicalCity,
        }),
      );
      if (!company) {
        company = await repos.companies.create({
          name: lead.companyName,
          normalizedName,
          englishName: lead.platform === 'ali' || lead.platform === 'mic' ? lead.companyName : null,
          province: ctx.goal.region.province,
          city: canonicalCity,
          sourceCount: 1,
          enrichmentStatus: 'discovered',
          unlockStatus: 'none',
          tradeTags: [],
          firstRunId: ctx.run.id,
          firstSeenAt: now,
          lastSeenAt: now,
        } as Parameters<CompaniesPort['create']>[0]);
        created = true;
      }
      companyId = company.id;
      if (created) await this.emitCompanyCreated(company, lead, ctx);
    }

    await repos.companySources.upsert({
      companyId,
      platform: lead.platform,
      platformCompanyId: lead.platformCompanyId,
      sourceName: lead.companyName,
      sourceUrl: lead.sourceUrl ?? null,
      cityName: lead.cityName ?? null,
      evidence: {
        ...lead.evidence,
        runId: ctx.run.id,
        sourceQueryId: ctx.query.id,
        keyword: ctx.query.keyword,
        strategy: ctx.query.strategy,
        page: ctx.pageNo,
      },
      firstSeenAt: now,
      lastSeenAt: now,
    });
    // 刷新来源平台数（docs/02 §5.5：source_count = 来源平台数）
    const sourceCount = await swallow(() => repos.companySources.countByCompany?.(companyId) ?? null);
    if (typeof sourceCount === 'number' && sourceCount > 0) {
      await swallow(() => repos.companies.update(companyId, { sourceCount }, { bumpVersion: false }));
    }

    if (created) {
      const stage = lead.platform === 'boss' || lead.platform === 'zhilian' ? 'source_detail' : 'tanji_match';
      const platformForJob = stage === 'source_detail' ? lead.platform : null;
      await swallow(() => repos.jobs.enqueue({ companyId, stage, platform: platformForJob, runId: ctx.run.id, maxAttempts: 3 }));
    }
    return { companyId, created };
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  /** 新公司入库 → company.created 事件（webhook/SSE 订阅方可见；docs/02 §10.2） */
  private async emitCompanyCreated(
    company: Company,
    lead: SourceLead,
    ctx: { goal: Goal; run: GoalRun; query: { id: string; keyword: string | null; strategy: QueryStrategy }; pageNo: number },
  ): Promise<void> {
    const source = `source:${lead.platform}`;
    const initial = {
      name: company.name,
      normalizedName: company.normalizedName,
      englishName: company.englishName,
      uscc: company.uscc,
      province: company.province,
      city: company.city,
      sourceCount: company.sourceCount,
      enrichmentStatus: company.enrichmentStatus,
      platform: lead.platform,
      platformCompanyId: lead.platformCompanyId,
      sourceQueryId: ctx.query.id,
      runId: ctx.run.id,
    };
    try {
      if (this.deps.recordCompanyCreated) {
        await this.deps.recordCompanyCreated(company, { source, runId: ctx.run.id, initial });
        return;
      }
      const changeEvents = this.deps.repos.changeEvents as ChangeEventsPort | undefined;
      if (changeEvents) {
        await changeEvents.append({
          companyId: company.id,
          entityType: 'company',
          entityId: company.id,
          version: company.version,
          eventType: 'company.created',
          field: null,
          oldValue: null,
          newValue: initial,
          valueType: 'object',
          source,
          runId: ctx.run.id,
          actor: 'system',
        });
      }
    } catch (err) {
      this.log('warn', 'run.companyCreatedEvent.failed', {
        runId: ctx.run.id,
        companyId: company.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async writePageSnapshot(
    run: GoalRun,
    query: { id: string; platform: Platform; keyword: string | null; cityCode: string },
    page: number,
    payload: unknown,
    extra: Record<string, unknown>,
  ): Promise<SnapshotWriteResult | null> {
    try {
      return await this.snapshots.writeSearchPage({
        platform: query.platform,
        runId: run.id,
        sourceQueryId: query.id,
        keyword: query.keyword,
        cityCode: query.cityCode,
        payload: { ...extra, page, payload },
      });
    } catch (err) {
      this.log('warn', 'run.snapshot.failed', { runId: run.id, platform: query.platform, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private buildStats(
    platformStats: Partial<Record<Platform, PlatformStats>>,
    coverage: CoverageStats,
    skippedSources: SkippedSource[],
    pagesFetched: number,
  ): RunStats {
    const stats: RunStats = {
      platforms: { ...platformStats },
      coverage,
      skippedSources,
      pagesFetched,
    };
    return stats;
  }

  private async safeHealth(platform: Platform): Promise<{ state: string } | null> {
    let persisted: { state: string } | null = null;
    try {
      persisted = (await this.deps.repos.sourceHealth.get(platform)) as { state: string } | null;
    } catch {
      persisted = null;
    }
    // 已持久化的健康态可能是历史失败（例如服务刚启动、会话尚未就绪）；仅在明确异常时现场探测一次并回写，
    // 避免 orchestrator 因过期 source_health 永久跳过某来源。
    if (persisted && ['ok', 'degraded'].includes(persisted.state)) return persisted;
    const adapter = this.deps.adapters[platform] as unknown as { getStatus?: () => Promise<{ state: string; loggedIn?: boolean | null; expiresAt?: string | null; checkedAt?: string; detail?: Record<string, unknown> | null }> } | undefined;
    if (adapter?.getStatus) {
      try {
        const status = await adapter.getStatus();
        try {
          await this.deps.repos.sourceHealth.upsert({
            platform,
            state: status.state as never,
            loggedIn: status.loggedIn ?? null,
            expiresAt: status.expiresAt ?? null,
            checkedAt: status.checkedAt ?? new Date().toISOString(),
            consecutiveFailures: 0,
            detail: status.detail ?? null,
          } as never);
        } catch { /* 健康回写失败不影响采集判断 */ }
        return { state: status.state };
      } catch {
        return persisted;
      }
    }
    return persisted;
  }

  private async finalizeFailed(run: GoalRun, err: LeadError): Promise<RunExecutionResult> {
    const stats = run.stats ?? {};
    const updated = await swallow(() =>
      this.deps.repos.runs.updateStatus(run.id, 'failed', { finishedAt: nowIso(), errorCode: err.code, errorMessage: err.message, stats }),
    );
    return { run: updated ?? { ...run, status: 'failed', errorCode: err.code, errorMessage: err.message }, stats, skippedSources: [], timedOut: false };
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
    const fn = this.deps.logger?.[level];
    fn?.(msg, meta);
  }
}

/** 采集后置 enrich/平台档案任务由各自 worker 负责；本模块只保证 source_detail/tanji_match 入队。 */
export function createOrchestrator(deps: OrchestratorDeps): RunOrchestrator {
  return new RunOrchestrator(deps);
}

export type { CompanySourcesPort, CompaniesPort, GoalRunsPort, GoalsPort, PipelineJobsPort, SourceHealthPort, SourceQueriesPort, SnapshotsPort };
