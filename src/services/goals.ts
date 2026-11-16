/**
 * Goal 服务（FR-1/FR-2）：创建 / 查询 / 更新 / 启停 / 归档 + 区域展开（ResolvedCities）。
 *
 * 设计：模块级函数走进程级 ServiceContext（api-dev 路由直接 import）；
 * 同时导出 createGoalService(ctx) 便于单测注入 fake repos/registry。
 */
import { z } from 'zod';
import { DEFAULT_KEYWORDS, DEFAULT_UNLOCK_POLICY, PLATFORMS } from '../shared/constants.js';
import type { Goal, GoalRegion, GoalRun, Platform } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { isValidCron } from '../pipeline/cron.js';
import type { GoalCreateData, GoalRunsPort, GoalsPort } from '../pipeline/ports.js';
import type { RegionRegistry, ResolvedCity } from '../region/registry.js';
import { findProvince } from '../region/names.js';
import { getServiceContext, type ServiceContext } from './context.js';

// ---------------------------------------------------------------------------
// 输入校验（zod）
// ---------------------------------------------------------------------------

const platformEnum = z.enum(['boss', 'zhilian', 'ali', 'mic']);
const keywordList = z.array(z.string().trim().min(1, '关键词不能为空')).max(50, '单平台关键词最多 50 个');

const regionSchema = z.object({
  province: z.string().trim().min(1, 'region.province 不能为空'),
  provinceCode: z
    .string()
    .regex(/^\d{6}$/, 'region.provinceCode 必须是 6 位 GB/T 2260 代码')
    .optional(),
  cityCodes: z
    .array(z.string().regex(/^\d{6}$/, 'region.cityCodes 必须是 6 位 GB/T 2260 代码'))
    .max(64, 'cityCodes 最多 64 个')
    .optional(),
});

const keywordsSchema = z
  .object({
    boss: keywordList.optional(),
    zhilian: keywordList.optional(),
    ali: keywordList.optional(),
    mic: keywordList.optional(),
  })
  .partial()
  .optional();

const scheduleSchema = z
  .object({
    cron: z.string().trim().min(1).optional(),
    timeZone: z.string().trim().min(1).optional(),
    timeWindow: z.string().trim().nullable().optional(),
  })
  .optional();

const unlockPolicySchema = z
  .object({
    mode: z.literal('priority'),
    order: z.array(z.string().trim().min(1)).min(1).max(10),
  })
  .optional();

export const goalCreateSchema = z.object({
  name: z.string().trim().min(1, 'name 不能为空').max(128),
  region: regionSchema,
  platforms: z.array(platformEnum).min(1, 'platforms 至少一个').max(4).optional(),
  keywords: keywordsSchema,
  maxLeadsPerRun: z.number().int().min(0).nullable().optional(),
  dailyLeadLimit: z.number().int().min(0).nullable().optional(),
  schedule: scheduleSchema,
  priority: z.number().int().min(0).max(100_000).optional(),
  tradeFilter: z.unknown().nullable().optional(),
  unlockPolicy: unlockPolicySchema,
  enabled: z.boolean().optional(),
});

export const goalUpdateSchema = goalCreateSchema.partial().extend({
  expectedVersion: z.number().int().min(1).optional(),
});

export type GoalCreateInput = z.input<typeof goalCreateSchema>;
export type GoalUpdateInput = z.input<typeof goalUpdateSchema>;

export interface GoalView extends Goal {
  resolvedCities: Array<{ code: string; name: string; platformValues: Partial<Record<Platform, string>> }>;
}

export interface GoalListResult {
  items: GoalView[];
  total: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface GoalServiceDeps {
  goals: GoalsPort;
  registry: RegionRegistry;
  /** 用于 getGoal 附带最近 runs（可省略） */
  runs?: GoalRunsPort;
  now?: () => Date;
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

function assertValidTimezone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new LeadError('VALIDATION_ERROR', `非法时区：${timeZone}`, { details: { field: 'schedule.timeZone', value: timeZone } });
  }
}

function assertValidCron(cron: string): void {
  if (!isValidCron(cron)) {
    throw new LeadError('VALIDATION_ERROR', `非法 cron 表达式：${cron}`, { details: { field: 'schedule.cron', value: cron } });
  }
}

function normalizeKeywords(
  keywords: z.infer<typeof keywordsSchema>,
  platforms: Platform[],
): Partial<Record<Platform, string[]>> {
  const result: Partial<Record<Platform, string[]>> = {};
  for (const platform of platforms) {
    const provided = keywords?.[platform];
    if (provided && provided.length > 0) {
      result[platform] = Array.from(new Set(provided.map((k) => k.trim()).filter(Boolean)));
      continue;
    }
    const defaults = DEFAULT_KEYWORDS[platform] ?? [];
    result[platform] = [...defaults];
  }
  return result;
}

function normalizeRegion(region: z.infer<typeof regionSchema>): GoalRegion {
  const province = findProvince(region.provinceCode ?? region.province);
  if (!province) {
    throw new LeadError('VALIDATION_ERROR', `未知省份：${region.provinceCode ?? region.province}`, {
      details: { field: 'region.province', value: region.provinceCode ?? region.province },
    });
  }
  return {
    province: province.name,
    provinceCode: province.code,
    ...(region.cityCodes && region.cityCodes.length > 0 ? { cityCodes: Array.from(new Set(region.cityCodes)) } : {}),
  };
}

export function createGoalService(deps: GoalServiceDeps) {
  async function toView(goal: Goal): Promise<GoalView> {
    let resolved: ResolvedCity[] = [];
    try {
      resolved = (await deps.registry.resolveCities(goal.region)).cities;
    } catch {
      resolved = [];
    }
    return {
      ...goal,
      resolvedCities: resolved.map((c) => ({ code: c.code, name: c.name, platformValues: c.platformValues })),
    };
  }

  async function parseCreate(input: unknown): Promise<GoalCreateData> {
    const parsed = goalCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw new LeadError('VALIDATION_ERROR', zodMessage(parsed.error), { details: { issues: parsed.error.issues } });
    }
    const data = parsed.data;
    const region = normalizeRegion(data.region);
    const platforms: Platform[] = data.platforms ?? [...PLATFORMS];
    const schedule = {
      cron: data.schedule?.cron ?? '0 2 * * *',
      timeZone: data.schedule?.timeZone ?? 'Asia/Shanghai',
      timeWindow: data.schedule?.timeWindow ?? '02:00-08:00',
    };
    assertValidCron(schedule.cron);
    assertValidTimezone(schedule.timeZone);
    if (schedule.timeWindow) {
      const m = /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(schedule.timeWindow);
      if (!m) throw new LeadError('VALIDATION_ERROR', `非法时间窗：${schedule.timeWindow}`, { details: { field: 'schedule.timeWindow' } });
    }
    // 区域校验：城市必须属于省
    try {
      await deps.registry.resolveCities(region);
    } catch (err) {
      if (err instanceof LeadError) throw err;
      throw new LeadError('VALIDATION_ERROR', err instanceof Error ? err.message : String(err), { details: { field: 'region' } });
    }
    return {
      name: data.name,
      region,
      platforms,
      keywords: normalizeKeywords(data.keywords ?? undefined, platforms),
      maxLeadsPerRun: data.maxLeadsPerRun ?? null,
      dailyLeadLimit: data.dailyLeadLimit ?? null,
      schedule,
      priority: data.priority ?? 100,
      tradeFilter: data.tradeFilter ?? null,
      unlockPolicy: data.unlockPolicy ?? { ...DEFAULT_UNLOCK_POLICY },
      enabled: data.enabled ?? true,
    };
  }

  async function createGoal(input: unknown): Promise<GoalView> {
    const data = await parseCreate(input);
    const goal = await deps.goals.create(data);
    return toView(goal);
  }

  async function listGoals(filter: { enabled?: boolean; limit?: number; offset?: number } = {}): Promise<GoalListResult> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const result = await deps.goals.list({ enabled: filter.enabled, limit, offset });
    const items = Array.isArray(result) ? result : (result.items ?? []);
    const total = Array.isArray(result) ? items.length : (result.total ?? items.length);
    return { items: await Promise.all(items.map((g) => toView(g))), total };
  }

  async function getGoal(id: string): Promise<(GoalView & { recentRuns: GoalRun[] }) | null> {
    const goal = await deps.goals.getById(id);
    if (!goal) return null;
    const view = await toView(goal);
    let recentRuns: GoalRun[] = [];
    if (deps.runs) {
      try {
        recentRuns = await deps.runs.listByGoal(id, 5);
      } catch {
        recentRuns = [];
      }
    }
    return { ...view, recentRuns };
  }

  async function updateGoal(id: string, patch: unknown): Promise<GoalView> {
    const existing = await deps.goals.getById(id);
    if (!existing) throw new LeadError('NOT_FOUND', `Goal 不存在：${id}`, { details: { goalId: id } });
    const parsed = goalUpdateSchema.safeParse(patch);
    if (!parsed.success) {
      throw new LeadError('VALIDATION_ERROR', zodMessage(parsed.error), { details: { issues: parsed.error.issues } });
    }
    const data = parsed.data;
    const expectedVersion = data.expectedVersion ?? existing.version;
    if (data.expectedVersion != null && data.expectedVersion !== existing.version) {
      throw new LeadError('CONFLICT', `Goal 版本冲突（期望 ${data.expectedVersion}，当前 ${existing.version}）`, {
        details: { goalId: id, expectedVersion: data.expectedVersion, currentVersion: existing.version },
      });
    }
    const update: Record<string, unknown> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.region !== undefined) {
      const region = normalizeRegion(data.region);
      await deps.registry.resolveCities(region);
      update.region = region;
    }
    if (data.platforms !== undefined) update.platforms = data.platforms;
    if (data.keywords !== undefined) update.keywords = normalizeKeywords(data.keywords, (data.platforms ?? existing.platforms) as Platform[]);
    if (data.maxLeadsPerRun !== undefined) update.maxLeadsPerRun = data.maxLeadsPerRun;
    if (data.dailyLeadLimit !== undefined) update.dailyLeadLimit = data.dailyLeadLimit;
    if (data.schedule !== undefined) {
      const schedule = data.schedule ?? {};
      assertValidCron(schedule.cron ?? existing.schedule.cron);
      assertValidTimezone(schedule.timeZone ?? existing.schedule.timeZone);
      update.schedule = {
        cron: schedule.cron ?? existing.schedule.cron,
        timeZone: schedule.timeZone ?? existing.schedule.timeZone,
        timeWindow: schedule.timeWindow !== undefined ? schedule.timeWindow : existing.schedule.timeWindow,
      };
    }
    if (data.priority !== undefined) update.priority = data.priority;
    if (data.tradeFilter !== undefined) update.tradeFilter = data.tradeFilter;
    if (data.unlockPolicy !== undefined) update.unlockPolicy = data.unlockPolicy;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    if (Object.keys(update).length === 0) return toView(existing);
    const updated = await deps.goals.update(id, update, { expectedVersion });
    return toView(updated);
  }

  async function archiveGoal(id: string): Promise<void> {
    const existing = await deps.goals.getById(id);
    if (!existing) throw new LeadError('NOT_FOUND', `Goal 不存在：${id}`, { details: { goalId: id } });
    await deps.goals.setEnabled(id, false);
  }

  return { createGoal, listGoals, getGoal, updateGoal, archiveGoal, parseCreate };
}

export type GoalService = ReturnType<typeof createGoalService>;

// ---------------------------------------------------------------------------
// 模块级便捷函数（api-dev 路由直接使用；依赖进程级 ServiceContext）
// ---------------------------------------------------------------------------

let defaultService: GoalService | null = null;

function service(): GoalService {
  if (!defaultService) {
    const ctx: ServiceContext = getServiceContext();
    defaultService = createGoalService({ goals: ctx.repos.goals, registry: ctx.registry, runs: ctx.repos.runs, now: ctx.now });
  }
  return defaultService;
}

/** 测试/重新接线时重置模块级 service 缓存 */
export function resetGoalService(): void {
  defaultService = null;
}

export const createGoal = (input: unknown): Promise<GoalView> => service().createGoal(input);
export const listGoals = (filter?: { enabled?: boolean; limit?: number; offset?: number }): Promise<GoalListResult> => service().listGoals(filter);
export const getGoal = (id: string): Promise<(GoalView & { recentRuns: GoalRun[] }) | null> => service().getGoal(id);
export const updateGoal = (id: string, patch: unknown): Promise<GoalView> => service().updateGoal(id, patch);
export const archiveGoal = (id: string): Promise<void> => service().archiveGoal(id);
