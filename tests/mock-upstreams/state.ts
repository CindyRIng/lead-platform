/**
 * Mock 上游共享状态与场景控制。
 *
 * 设计目标：
 *  - 六个 mock 上游（boss/zhilian/ali/mic/tanji/fuma）共享一个 `MockWorld`，
 *    测试可以 **在进程内直接修改状态**（注入失败、切换岗位轮次、耗尽额度…），
 *    也可以通过每个 mock 的 `/__mock/*` 控制端点从外部进程驱动；
 *  - 默认 0 延迟、不校验 token（便于适配器不配置 token 时也能跑）；
 *  - 每次测试/用例前调用 `resetWorld()` 恢复初始场景。
 */
import { tanjiCompanies } from '../fixtures/companies.js';

export type MockPlatform = 'boss' | 'zhilian' | 'ali' | 'mic' | 'tanji' | 'fuma';

export const MOCK_PLATFORMS: MockPlatform[] = ['boss', 'zhilian', 'ali', 'mic', 'tanji', 'fuma'];

/** 各 mock 的默认端口（对应 docs/04 约定；测试一般用 0 = 随机端口避免冲突） */
export const DEFAULT_MOCK_PORTS: Record<MockPlatform, number> = {
  boss: 8790,
  zhilian: 8791,
  ali: 8792,
  mic: 8899,
  tanji: 8787,
  fuma: 17890,
};

export interface InjectedFailure {
  /** HTTP 状态码；与 code 至少给一个 */
  status?: number;
  /** 上游 envelope 的 error.code（如 UNAUTHORIZED / RATE_LIMITED / QUOTA_EXHAUSTED / SOURCE_UNAVAILABLE） */
  code?: string;
  message?: string;
  retryable?: boolean;
  /** 只对路径包含该子串的请求生效；缺省 = 所有业务请求 */
  match?: string;
  /** 生效次数（默认 1）；Infinity = 一直生效 */
  times?: number;
  /** 返回前延迟（毫秒），用于模拟超时 */
  latencyMs?: number;
}

export interface MockRequestLog {
  at: string;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body?: unknown;
}

export interface PlatformControl {
  platform: MockPlatform;
  failures: InjectedFailure[];
  /** 会话失效：/status 返回 loggedIn=false，业务接口返回 401 UNAUTHORIZED */
  sessionInvalid: boolean;
  /** 强制空结果 */
  forceEmpty: boolean;
  /** 基础延迟（毫秒） */
  latencyMs: number;
  /** 请求计数（route key → 次数） */
  counts: Record<string, number>;
  /** 最近请求日志（最多保留 500 条） */
  requests: MockRequestLog[];
  /** 实际监听地址 */
  url: string;
  port: number;
}

export interface QuotaBucket {
  limit: number;
  used: number;
  remaining: number;
  unit: string;
}

export interface TanjiQuota {
  daily: QuotaBucket;
  monthly: QuotaBucket;
  enterpriseMonthly: QuotaBucket;
  settlementDay: number;
  nearlySevenDayUnlockCount: number;
}

export interface BossQueryState {
  keyword: string;
  cityCode: string;
  companyIds: string[];
  createdAt: string;
}

export interface ZhilianQueryState {
  keyword: string;
  cityCode: string;
  companyIds: string[];
  createdAt: string;
}

export interface AliQueryState {
  province: string | null;
  city: string | null;
  keyword: string | null;
  supplierIds: string[];
  createdAt: string;
}

export interface FumaCacheEntry {
  body: unknown;
  cachedAt: string;
  expiresAt: string;
}

export interface TanjiUnlockRequest {
  at: string;
  companyId: string;
  idempotencyKey?: string;
}

export interface ScenarioState {
  /** boss/zhilian 岗位刷新轮次（1-based） */
  jobRounds: { boss: number; zhilian: number };
  tanjiQuota: TanjiQuota;
  /** true → POST unlock 返回 QUOTA_EXHAUSTED */
  tanjiQuotaExhausted: boolean;
  /** 当前已解锁的 tanji 公司 id */
  tanjiUnlocked: Set<string>;
  /** unlock 端点调用次数（含 alreadyUnlocked / 失败） */
  tanjiUnlockCalls: number;
  /** 实际扣额度次数 */
  tanjiQuotaConsumed: number;
  /** unlock 请求日志（断言幂等） */
  tanjiUnlockRequests: TanjiUnlockRequest[];
  /** fuma 无权限（返回 CUSTOMS_PERMISSION_DENIED） */
  fumaPermissionDenied: boolean;
  /** fuma 强制缓存（key = accountId|inputCompany|flag|page|pageSize） */
  fumaCache: Map<string, FumaCacheEntry>;
  /** fuma 真实上游查询次数（缓存命中不增加） */
  fumaUpstreamQueries: number;
  bossQueries: Map<string, BossQueryState>;
  zhilianQueries: Map<string, ZhilianQueryState>;
  aliQueries: Map<string, AliQueryState>;
  /** 测试可放置任意自定义标志 */
  flags: Record<string, unknown>;
}

export interface MockWorld {
  startedAt: string;
  scenario: ScenarioState;
  platforms: Record<MockPlatform, PlatformControl>;
}

function emptyControl(platform: MockPlatform): PlatformControl {
  return {
    platform,
    failures: [],
    sessionInvalid: false,
    forceEmpty: false,
    latencyMs: 0,
    counts: {},
    requests: [],
    url: '',
    port: 0,
  };
}

function defaultQuota(): TanjiQuota {
  return {
    daily: { limit: 500, used: 0, remaining: 500, unit: '额度点' },
    monthly: { limit: 1500, used: 0, remaining: 1500, unit: '额度点' },
    enterpriseMonthly: { limit: 19500, used: 0, remaining: 19500, unit: '额度点' },
    settlementDay: 11,
    nearlySevenDayUnlockCount: 0,
  };
}

function initialUnlockedSet(): Set<string> {
  const s = new Set<string>();
  for (const c of tanjiCompanies()) {
    if (c.tanji?.contactsUnlocked) s.add(c.tanji.id);
  }
  return s;
}

export function createWorld(): MockWorld {
  const platforms = Object.fromEntries(MOCK_PLATFORMS.map((p) => [p, emptyControl(p)])) as Record<MockPlatform, PlatformControl>;
  return {
    startedAt: new Date().toISOString(),
    platforms,
    scenario: {
      jobRounds: { boss: 1, zhilian: 1 },
      tanjiQuota: defaultQuota(),
      tanjiQuotaExhausted: false,
      tanjiUnlocked: initialUnlockedSet(),
      tanjiUnlockCalls: 0,
      tanjiQuotaConsumed: 0,
      tanjiUnlockRequests: [],
      fumaPermissionDenied: false,
      fumaCache: new Map(),
      fumaUpstreamQueries: 0,
      bossQueries: new Map(),
      zhilianQueries: new Map(),
      aliQueries: new Map(),
      flags: {},
    },
  };
}

/** 原地重置 world（保持 mock app 对 world 的引用不变）。 */
export function resetWorld(world: MockWorld): void {
  const fresh = createWorld();
  for (const p of MOCK_PLATFORMS) {
    const ctl = world.platforms[p];
    const freshCtl = fresh.platforms[p];
    ctl.failures = freshCtl.failures;
    ctl.sessionInvalid = freshCtl.sessionInvalid;
    ctl.forceEmpty = freshCtl.forceEmpty;
    ctl.latencyMs = freshCtl.latencyMs;
    ctl.counts = freshCtl.counts;
    ctl.requests = freshCtl.requests;
    // url/port 保留（mock 仍在监听）
  }
  const s = world.scenario;
  const f = fresh.scenario;
  s.jobRounds = f.jobRounds;
  s.tanjiQuota = f.tanjiQuota;
  s.tanjiQuotaExhausted = f.tanjiQuotaExhausted;
  s.tanjiUnlocked = f.tanjiUnlocked;
  s.tanjiUnlockCalls = f.tanjiUnlockCalls;
  s.tanjiQuotaConsumed = f.tanjiQuotaConsumed;
  s.tanjiUnlockRequests = f.tanjiUnlockRequests;
  s.fumaPermissionDenied = f.fumaPermissionDenied;
  s.fumaCache = f.fumaCache;
  s.fumaUpstreamQueries = f.fumaUpstreamQueries;
  s.bossQueries = f.bossQueries;
  s.zhilianQueries = f.zhilianQueries;
  s.aliQueries = f.aliQueries;
  s.flags = f.flags;
  world.startedAt = fresh.startedAt;
}

export function platformControl(world: MockWorld, platform: MockPlatform): PlatformControl {
  return world.platforms[platform];
}

export function getPlatformUrl(world: MockWorld, platform: MockPlatform): string {
  const url = world.platforms[platform].url;
  if (!url) throw new Error(`mock platform ${platform} not started`);
  return url;
}

/** 注入一次失败（按 FIFO 消耗；match 不匹配时保留在队列中） */
export function injectFailure(world: MockWorld, platform: MockPlatform, failure: InjectedFailure): void {
  world.platforms[platform].failures.push({ times: 1, ...failure });
}

export function clearFailures(world: MockWorld, platform: MockPlatform): void {
  world.platforms[platform].failures = [];
}

export function setSessionInvalid(world: MockWorld, platform: MockPlatform, invalid = true): void {
  world.platforms[platform].sessionInvalid = invalid;
}

export function setForceEmpty(world: MockWorld, platform: MockPlatform, empty = true): void {
  world.platforms[platform].forceEmpty = empty;
}

/** 设置岗位刷新轮次（boss/zhilian），1-based */
export function setJobsRound(world: MockWorld, platform: 'boss' | 'zhilian', round: number): void {
  if (!Number.isInteger(round) || round < 1) throw new Error(`invalid job round: ${round}`);
  world.scenario.jobRounds[platform] = round;
}

export function setTanjiQuota(world: MockWorld, patch: {
  dailyRemaining?: number;
  monthlyRemaining?: number;
  enterpriseRemaining?: number;
  settlementDay?: number;
}): void {
  const q = world.scenario.tanjiQuota;
  if (patch.dailyRemaining !== undefined) {
    q.daily.remaining = patch.dailyRemaining;
    q.daily.used = q.daily.limit - patch.dailyRemaining;
  }
  if (patch.monthlyRemaining !== undefined) {
    q.monthly.remaining = patch.monthlyRemaining;
    q.monthly.used = q.monthly.limit - patch.monthlyRemaining;
  }
  if (patch.enterpriseRemaining !== undefined) {
    q.enterpriseMonthly.remaining = patch.enterpriseRemaining;
    q.enterpriseMonthly.used = q.enterpriseMonthly.limit - patch.enterpriseRemaining;
  }
  if (patch.settlementDay !== undefined) q.settlementDay = patch.settlementDay;
}

/** 模拟额度耗尽（unlock → QUOTA_EXHAUSTED 409；status 显示 remaining=0） */
export function exhaustTanjiQuota(world: MockWorld): void {
  world.scenario.tanjiQuotaExhausted = true;
  setTanjiQuota(world, { dailyRemaining: 0, monthlyRemaining: 0, enterpriseRemaining: 0 });
}

/** 模拟额度恢复（日额度刷新 / 结算日恢复） */
export function restoreTanjiQuota(world: MockWorld, remaining = 500): void {
  world.scenario.tanjiQuotaExhausted = false;
  setTanjiQuota(world, { dailyRemaining: remaining, monthlyRemaining: 1500, enterpriseRemaining: 19500 });
}

export function setFumaPermission(world: MockWorld, denied: boolean): void {
  world.scenario.fumaPermissionDenied = denied;
}

/** 统计某平台请求次数（pathIncludes 为空时统计全部） */
export function countRequests(world: MockWorld, platform: MockPlatform, pathIncludes?: string): number {
  const ctl = world.platforms[platform];
  let total = 0;
  for (const [key, count] of Object.entries(ctl.counts)) {
    if (!pathIncludes || key.includes(pathIncludes)) total += count;
  }
  return total;
}

export function recentRequests(world: MockWorld, platform: MockPlatform, pathIncludes?: string): MockRequestLog[] {
  const ctl = world.platforms[platform];
  if (!pathIncludes) return ctl.requests;
  return ctl.requests.filter((r) => r.path.includes(pathIncludes));
}

export function resetRequestLog(world: MockWorld, platform?: MockPlatform): void {
  const list = platform ? [platform] : MOCK_PLATFORMS;
  for (const p of list) {
    world.platforms[p].requests = [];
    world.platforms[p].counts = {};
  }
}

/** 场景摘要（验收报告/调试用） */
export function scenarioSummary(world: MockWorld): Record<string, unknown> {
  const s = world.scenario;
  return {
    startedAt: world.startedAt,
    jobRounds: { ...s.jobRounds },
    tanjiQuota: JSON.parse(JSON.stringify(s.tanjiQuota)),
    tanjiQuotaExhausted: s.tanjiQuotaExhausted,
    tanjiUnlocked: [...s.tanjiUnlocked],
    tanjiUnlockCalls: s.tanjiUnlockCalls,
    tanjiQuotaConsumed: s.tanjiQuotaConsumed,
    fumaPermissionDenied: s.fumaPermissionDenied,
    fumaUpstreamQueries: s.fumaUpstreamQueries,
    fumaCacheEntries: s.fumaCache.size,
    platforms: Object.fromEntries(
      MOCK_PLATFORMS.map((p) => [p, { url: world.platforms[p].url, requests: countRequests(world, p) }]),
    ),
  };
}
