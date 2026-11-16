/**
 * Run 服务（FR-2/FR-9）：创建 / 查询 / 取消 / 进度聚合 / 覆盖度统计。
 *
 * Run 状态机（docs/02 §7.1）：pending → running → completed | partial | failed | cancelled。
 * 单 Goal 不重叠：已有 pending/running 的 Run 时抛 RUN_IN_PROGRESS。
 */
import type { CoverageStats, GoalRun, GoalRunStatus, RunStats } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import type { GoalRunsPort, GoalsPort, SourceQueriesPort, SourceQueryRecord } from '../pipeline/ports.js';
import { getServiceContext, type ServiceContext } from './context.js';

export interface RunQueryProgress {
  id: string;
  platform: string;
  cityCode: string;
  platformRegionValue: string;
  keyword: string | null;
  status: string;
  pagesFetched: number;
  totalPages: number | null;
  totalCount: number | null;
  lastError: string | null;
}

export interface RunProgress {
  byPlatform: Record<string, { queries: number; done: number; failed: number; skipped: number; pages: number; leads: number }>;
  byCity: Record<string, { queries: number; done: number; pages: number }>;
  byKeyword: Record<string, { queries: number; done: number; pages: number }>;
  totalQueries: number;
  doneQueries: number;
  failedQueries: number;
  skippedQueries: number;
}

export interface RunView extends GoalRun {
  progress: RunProgress;
  queries: RunQueryProgress[];
}

export interface RunListResult {
  items: GoalRun[];
  total: number;
}

export interface RunServiceDeps {
  goals: GoalsPort;
  runs: GoalRunsPort;
  sourceQueries: SourceQueriesPort;
  now?: () => Date;
}

const ACTIVE_STATUSES: GoalRunStatus[] = ['pending', 'running'];
const TERMINAL_STATUSES: GoalRunStatus[] = ['completed', 'partial', 'failed', 'cancelled'];

export function isActiveRun(status: GoalRunStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminalRun(status: GoalRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function emptyProgress(): RunProgress {
  return { byPlatform: {}, byCity: {}, byKeyword: {}, totalQueries: 0, doneQueries: 0, failedQueries: 0, skippedQueries: 0 };
}

/** 由 source_queries 聚合平台/城市/关键词级进度（用于 GET /v1/runs/{id} 与调度心跳） */
export function aggregateQueryProgress(queries: Array<Partial<SourceQueryRecord>>): RunProgress {
  const progress = emptyProgress();
  for (const q of queries) {
    const platform = q.platform ?? 'unknown';
    const city = q.cityCode ?? 'unknown';
    const keyword = q.keyword ?? '';
    const pages = q.pagesFetched ?? 0;
    const p = (progress.byPlatform[platform] ??= { queries: 0, done: 0, failed: 0, skipped: 0, pages: 0, leads: 0 });
    p.queries += 1;
    p.pages += pages;
    const c = (progress.byCity[city] ??= { queries: 0, done: 0, pages: 0 });
    c.queries += 1;
    c.pages += pages;
    if (keyword) {
      const k = (progress.byKeyword[keyword] ??= { queries: 0, done: 0, pages: 0 });
      k.queries += 1;
      k.pages += pages;
    }
    progress.totalQueries += 1;
    switch (q.status) {
      case 'done':
        progress.doneQueries += 1;
        p.done += 1;
        c.done += 1;
        if (keyword) (progress.byKeyword[keyword] ??= { queries: 0, done: 0, pages: 0 }).done += 1;
        break;
      case 'failed':
        progress.failedQueries += 1;
        p.failed += 1;
        break;
      case 'skipped':
        progress.skippedQueries += 1;
        p.skipped += 1;
        break;
      default:
        break;
    }
  }
  // leads 由 Run.stats.platforms 注入（coverage/lead 计数在 orchestrator 统计）
  return progress;
}

export function createRunService(deps: RunServiceDeps) {
  const now = deps.now ?? (() => new Date());

  async function createRun(goalId: string, trigger: 'cron' | 'manual' = 'manual', actor?: string): Promise<GoalRun> {
    const goal = await deps.goals.getById(goalId);
    if (!goal) throw new LeadError('NOT_FOUND', `Goal 不存在：${goalId}`, { details: { goalId } });
    if (!goal.enabled) {
      throw new LeadError('CONFLICT', `Goal 已停用，无法触发：${goalId}`, { details: { goalId } });
    }
    const active = await deps.runs.findActiveByGoal(goalId);
    if (active) {
      throw new LeadError('RUN_IN_PROGRESS', `Goal 已有运行中的 Run：${active.id}`, {
        details: { goalId, runId: active.id, status: active.status },
      });
    }
    return deps.runs.create({ goalId, trigger, actor });
  }

  async function listRuns(filter: { goalId?: string; status?: GoalRunStatus; limit: number; offset: number }): Promise<RunListResult> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const result = await deps.runs.list({ goalId: filter.goalId, status: filter.status, limit, offset });
    if (Array.isArray(result)) return { items: result, total: result.length };
    return { items: result.items ?? [], total: result.total ?? result.items?.length ?? 0 };
  }

  async function getRun(id: string): Promise<RunView | null> {
    const run = await deps.runs.getById(id);
    if (!run) return null;
    let queries: SourceQueryRecord[] = [];
    try {
      queries = (await deps.sourceQueries.listByRun(id)) ?? [];
    } catch {
      queries = [];
    }
    const progress = aggregateQueryProgress(queries);
    // 把 orchestrator 记录的 leads/companiesNew 合并进 byPlatform（若 stats 有）
    const statsPlatforms = run.stats?.platforms ?? {};
    for (const [platform, info] of Object.entries(statsPlatforms)) {
      const p = (progress.byPlatform[platform] ??= { queries: 0, done: 0, failed: 0, skipped: 0, pages: 0, leads: 0 });
      p.leads = info?.leads ?? 0;
    }
    return {
      ...run,
      progress,
      queries: queries.map((q) => ({
        id: q.id,
        platform: q.platform,
        cityCode: q.cityCode,
        platformRegionValue: q.platformRegionValue,
        keyword: q.keyword,
        status: q.status,
        pagesFetched: q.pagesFetched,
        totalPages: q.totalPages,
        totalCount: q.totalCount,
        lastError: q.lastError,
      })),
    };
  }

  async function cancelRun(id: string): Promise<GoalRun> {
    const run = await deps.runs.getById(id);
    if (!run) throw new LeadError('NOT_FOUND', `Run 不存在：${id}`, { details: { runId: id } });
    if (isTerminalRun(run.status)) {
      throw new LeadError('CONFLICT', `Run 已结束（${run.status}），不可取消`, { details: { runId: id, status: run.status } });
    }
    const updated = await deps.runs.updateStatus(id, 'cancelled', { finishedAt: now().toISOString() });
    return updated ?? { ...run, status: 'cancelled', finishedAt: now().toISOString() };
  }

  async function getCoverageStats(filter?: { runId?: string }): Promise<CoverageStats> {
    if (filter?.runId) {
      const run = await deps.runs.getById(filter.runId);
      const coverage = run?.stats?.coverage;
      if (coverage) return coverage;
    }
    return { uniqueCompanies: 0, crossSourceOverlap: 0, coverageByCity: {}, keywordYield: {} };
  }

  return { createRun, listRuns, getRun, cancelRun, getCoverageStats };
}

export type RunService = ReturnType<typeof createRunService>;

let defaultService: RunService | null = null;

function service(): RunService {
  if (!defaultService) {
    const ctx: ServiceContext = getServiceContext();
    defaultService = createRunService({
      goals: ctx.repos.goals,
      runs: ctx.repos.runs,
      sourceQueries: ctx.repos.sourceQueries,
      now: ctx.now,
    });
  }
  return defaultService;
}

export function resetRunService(): void {
  defaultService = null;
}

export const createRun = (goalId: string, trigger: 'cron' | 'manual' = 'manual', actor?: string): Promise<GoalRun> =>
  service().createRun(goalId, trigger, actor);
export const listRuns = (filter: { goalId?: string; status?: GoalRunStatus; limit: number; offset: number }): Promise<RunListResult> =>
  service().listRuns(filter);
export const getRun = (id: string): Promise<RunView | null> => service().getRun(id);
export const cancelRun = (id: string): Promise<GoalRun> => service().cancelRun(id);
export const getCoverageStats = (filter?: { runId?: string }): Promise<CoverageStats> => service().getCoverageStats(filter);

/** Run.stats 合并（orchestrator 使用；保持 platforms/enrichment/coverage 结构） */
export function mergeRunStats(base: RunStats, patch: Partial<RunStats>): RunStats {
  const merged: RunStats = { ...base, ...patch };
  if (patch.platforms) {
    const platforms: NonNullable<RunStats['platforms']> = { ...(base.platforms ?? {}) };
    for (const [platform, value] of Object.entries(patch.platforms)) {
      if (!value) continue;
      const key = platform as keyof NonNullable<RunStats['platforms']>;
      const prev = platforms[key] ?? { queries: 0, pages: 0, leads: 0, companiesNew: 0 };
      platforms[key] = {
        queries: prev.queries + (value.queries ?? 0),
        pages: prev.pages + (value.pages ?? 0),
        leads: prev.leads + (value.leads ?? 0),
        companiesNew: prev.companiesNew + (value.companiesNew ?? 0),
      };
    }
    merged.platforms = platforms;
  }
  return merged;
}

