/**
 * 路由服务层接口 + 动态 import 桥接器。
 *
 * 背景：服务层由其他模块/agent 实现（goals/runs/companies/platformProfiles/customs/
 * events/subscriptions/quota），ops/admin 由本模块（api-dev）实现。路由只依赖这里定义的
 * 窄接口，缺实现时给出明确的集成点错误（INTERNAL_ERROR + details.integrationPoints），
 * 不阻塞路由框架与单元测试。
 *
 * 集成方式：
 *  - 生产：src/http/server.ts → registerRoutes(app) → setRouteRuntimeContext(app.context)；
 *  - 测试：setRouteServices(fake) 注入全部服务假实现；测试后 setRouteServices(null) 复原。
 */
import { LeadError } from '../../shared/errors.js';

export interface RouteRuntimeContext {
  db?: unknown;
  repos?: unknown;
  config?: unknown;
  logger?: unknown;
  scheduler?: unknown;
  startedAt?: number;
  [k: string]: unknown;
}

export interface PaginatedData<T = unknown> {
  items: T[];
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
}

/* ------------------------------------------------------------------ */
/* 服务接口                                                             */
/* ------------------------------------------------------------------ */

export interface GoalsService {
  create(input: unknown): Promise<unknown>;
  list(filter: { enabled?: boolean; limit: number; offset: number }): Promise<PaginatedData>;
  get(id: string): Promise<unknown | null>;
  update(id: string, patch: unknown): Promise<unknown>;
  archive(id: string): Promise<void>;
}

export interface RunsService {
  create(goalId: string, trigger: 'cron' | 'manual', actor?: string): Promise<unknown>;
  list(filter: { goalId?: string; status?: string; limit: number; offset: number }): Promise<PaginatedData>;
  get(id: string): Promise<unknown | null>;
  cancel(id: string): Promise<unknown>;
  coverage(filter?: { runId?: string; from?: string; to?: string }): Promise<unknown>;
}

export interface CompaniesService {
  list(query: Record<string, unknown>): Promise<PaginatedData>;
  get(id: string, query?: { include?: string[] }): Promise<unknown | null>;
  sources(id: string): Promise<unknown>;
  snapshots(id: string, query: Record<string, unknown>): Promise<PaginatedData>;
  contacts(id: string, query: Record<string, unknown>): Promise<unknown>;
  changes(id: string, query: Record<string, unknown>): Promise<PaginatedData>;
  rematch(id: string, input: { force?: boolean; note?: string }): Promise<unknown>;
  unlock(id: string, input: { idempotencyKey?: string; note?: string }): Promise<unknown>;
}

export interface PlatformsService {
  list(companyId: string): Promise<unknown>;
  get(companyId: string, platform: string): Promise<unknown | null>;
  jobs(companyId: string, platform: string, query: Record<string, unknown>): Promise<PaginatedData>;
  changes(companyId: string, platform: string, query: Record<string, unknown>): Promise<PaginatedData>;
  refresh(companyId: string, input: { platforms?: string[]; kinds?: string[] }): Promise<unknown>;
}

export interface CustomsService {
  get(companyId: string): Promise<unknown | null>;
  refresh(companyId: string): Promise<unknown>;
}

export interface EventsService {
  listChanges(query: Record<string, unknown>): Promise<unknown>;
  listCompanyChanges(companyId: string, query: Record<string, unknown>): Promise<unknown>;
}

export interface WebhooksService {
  create(input: Record<string, unknown>): Promise<unknown>;
  list(): Promise<unknown>;
  update(id: string, patch: Record<string, unknown>): Promise<unknown>;
  remove(id: string): Promise<void>;
  listDeliveries(subscriptionId: string, query: Record<string, unknown>): Promise<PaginatedData>;
  replayDelivery(subscriptionId: string, deliveryId: string): Promise<unknown>;
}

export interface JobsService {
  list(query: Record<string, unknown>): Promise<PaginatedData>;
  get(id: string): Promise<unknown | null>;
  retry(id: string): Promise<unknown>;
}

export interface OpsService {
  listSources(): Promise<unknown>;
  getStats(query: Record<string, unknown>): Promise<unknown>;
  getQuota(): Promise<unknown>;
}

export interface AdminServiceApi {
  backup(): Promise<unknown>;
  archive(opts: { afterDays?: number; dryRun?: boolean }): Promise<unknown>;
  listManifests(): Promise<unknown>;
  verify(opts: { month?: string }): Promise<unknown>;
  restore(opts: { month?: string; dryRun?: boolean }): Promise<unknown>;
  dbStats(): Promise<unknown>;
}

export interface RouteServices {
  goals: GoalsService;
  runs: RunsService;
  companies: CompaniesService;
  platforms: PlatformsService;
  customs: CustomsService;
  events: EventsService;
  webhooks: WebhooksService;
  jobs: JobsService;
  ops: OpsService;
  admin: AdminServiceApi;
}

/* ------------------------------------------------------------------ */
/* 运行期上下文（来自 server.ts 的 app.context）                         */
/* ------------------------------------------------------------------ */

let runtimeContext: RouteRuntimeContext = {};

export function setRouteRuntimeContext(ctx: RouteRuntimeContext | null | undefined): void {
  runtimeContext = ctx && typeof ctx === 'object' ? ctx : {};
}

export function getRouteRuntimeContext(): RouteRuntimeContext {
  return runtimeContext;
}

/* ------------------------------------------------------------------ */
/* 动态 import 桥接器                                                   */
/* ------------------------------------------------------------------ */

type AnyFn = (...args: unknown[]) => unknown;
type AnyModule = Record<string, unknown>;

const moduleCache = new Map<string, Promise<AnyModule | null>>();

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === 'ERR_MODULE_NOT_FOUND') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg);
}

async function loadModule(spec: string): Promise<AnyModule | null> {
  let pending = moduleCache.get(spec);
  if (!pending) {
    pending = (async () => {
      try {
        const url = new URL(spec, import.meta.url).href;
        return (await import(url)) as AnyModule;
      } catch (err) {
        if (isModuleNotFound(err)) return null;
        throw err;
      }
    })();
    moduleCache.set(spec, pending);
  }
  return pending;
}

async function resolveFunction(module: AnyModule, names: string[]): Promise<AnyFn | null> {
  for (const name of names) {
    const fn = module[name];
    if (typeof fn === 'function') return fn as AnyFn;
  }
  const def = module.default;
  if (def && typeof def === 'object') {
    for (const name of names) {
      const fn = (def as AnyModule)[name];
      if (typeof fn === 'function') return fn as AnyFn;
    }
  }
  return null;
}

function integrationError(specs: readonly string[], names: string[]): LeadError {
  return new LeadError(
    'INTERNAL_ERROR',
    `service layer integration point not available: ${names[0]} (expected in ${specs.join(' | ')})`,
    { details: { integrationPoints: specs, expectedExport: names[0] } },
  );
}

/**
 * 依次尝试若干模块路径与候选导出名，调用第一个命中的函数。
 * 模块不存在 → 抛 integrationError；模块存在但调用抛错 → 原样抛出（由路由转 envelope）。
 */
async function callModule<T>(specs: string | readonly string[], names: string[], args: unknown[]): Promise<T> {
  const list = Array.isArray(specs) ? specs : [specs];
  for (const spec of list) {
    const mod = await loadModule(spec);
    if (!mod) continue;
    const fn = await resolveFunction(mod, names);
    if (!fn) continue;
    return (await fn(...args)) as T;
  }
  throw integrationError(list, names);
}

function normalizePaged(value: unknown): PaginatedData {
  if (Array.isArray(value)) return { items: value, nextCursor: null, hasMore: false };
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (Array.isArray(rec.items)) {
      return {
        items: rec.items,
        nextCursor: (rec.nextCursor as string | null | undefined) ?? null,
        hasMore: typeof rec.hasMore === 'boolean' ? rec.hasMore : !!rec.nextCursor,
        total: typeof rec.total === 'number' ? rec.total : undefined,
      };
    }
  }
  return { items: [], nextCursor: null, hasMore: false };
}

/* ------------------------------------------------------------------ */
/* 默认桥接实现                                                         */
/* ------------------------------------------------------------------ */

const SVC = {
  goals: '../../services/goals.js',
  runs: '../../services/runs.js',
  companies: '../../services/companies.js',
  platforms: ['../../services/platformProfiles.js', '../../services/platforms.js'],
  customs: ['../../services/customs.js', '../../services/platformProfiles.js'],
  events: '../../services/events.js',
  webhooks: ['../../events/subscriptions.js', '../../services/webhooks.js'],
  sources: ['../../services/sources.js', '../../services/ops.js'],
  quota: ['../../services/quota.js', '../../services/ops.js'],
  jobs: ['../../services/jobs.js', '../../services/ops.js'],
  ops: '../../services/ops.js',
  admin: '../../services/admin.js',
} as const;

async function withOps<T>(names: string[], args: unknown[]): Promise<T> {
  const mod = await loadModule(SVC.ops);
  if (!mod) throw integrationError([SVC.ops], names);
  const configure = mod.configureOps;
  if (typeof configure === 'function') (configure as AnyFn)(runtimeContext);
  const fn = await resolveFunction(mod, names);
  if (!fn) throw integrationError([SVC.ops], names);
  return (await fn(...args)) as T;
}

class DefaultServices implements RouteServices {
  goals: GoalsService = {
    create: (input) => callModule(SVC.goals, ['createGoal'], [input]),
    list: (filter) => callModule(SVC.goals, ['listGoals'], [filter]).then(normalizePaged),
    get: (id) => callModule(SVC.goals, ['getGoal'], [id]),
    update: (id, patch) => callModule(SVC.goals, ['updateGoal'], [id, patch]),
    archive: (id) => callModule(SVC.goals, ['archiveGoal'], [id]),
  };

  runs: RunsService = {
    create: (goalId, trigger, actor) => callModule(SVC.runs, ['createRun'], [goalId, trigger, actor]),
    list: (filter) => callModule(SVC.runs, ['listRuns'], [filter]).then(normalizePaged),
    get: (id) => callModule(SVC.runs, ['getRun'], [id]),
    cancel: (id) => callModule(SVC.runs, ['cancelRun'], [id]),
    coverage: (filter) => callModule(SVC.runs, ['getCoverageStats'], [filter]),
  };

  companies: CompaniesService = {
    list: (query) => callModule(SVC.companies, ['listCompanies'], [query]).then(normalizePaged),
    get: (id, query) => callModule(SVC.companies, ['getCompanyDetail', 'getCompany'], [id, query ?? {}]),
    sources: (id) => callModule(SVC.companies, ['listCompanySources', 'listSources', 'getCompanySources'], [id]),
    snapshots: (id, query) =>
      callModule(SVC.companies, ['listCompanySnapshots', 'listSnapshots'], [id, query]).then(normalizePaged),
    contacts: (id, query) => callModule(SVC.companies, ['listCompanyContacts', 'listContacts'], [id, query]),
    changes: (id, query) =>
      callModule(SVC.companies, ['listCompanyChanges'], [id, query])
        .catch(async () => callModule(SVC.events, ['listCompanyChanges'], [id, query]))
        .then(normalizePaged),
    rematch: (id, input) =>
      callModule(SVC.companies, ['createRematchJob', 'rematchCompany', 'rematch'], [id, input]),
    unlock: (id, input) =>
      callModule(SVC.companies, ['createUnlockJob', 'unlockCompany', 'requestUnlock'], [id, input]),
  };

  platforms: PlatformsService = {
    list: (companyId) => callModule(SVC.platforms, ['listCompanyPlatforms'], [companyId]),
    get: (companyId, platform) => callModule(SVC.platforms, ['getCompanyPlatform'], [companyId, platform]),
    jobs: (companyId, platform, query) =>
      callModule(SVC.platforms, ['listCompanyPlatformJobs'], [companyId, platform, query]).then(normalizePaged),
    changes: (companyId, platform, query) =>
      callModule(SVC.platforms, ['listCompanyPlatformChanges'], [companyId, platform, query]).then(normalizePaged),
    refresh: (companyId, input) => callModule(SVC.platforms, ['createRefreshJob'], [companyId, input]),
  };

  customs: CustomsService = {
    get: (companyId) => callModule(SVC.customs, ['getCompanyCustoms'], [companyId]),
    refresh: (companyId) => callModule(SVC.customs, ['createCustomsRefreshJob'], [companyId]),
  };

  events: EventsService = {
    listChanges: (query) => callModule(SVC.events, ['listChanges', 'queryChanges'], [query]),
    listCompanyChanges: (companyId, query) =>
      callModule(SVC.events, ['listCompanyChanges'], [companyId, query]),
  };

  webhooks: WebhooksService = {
    create: (input) => callModule(SVC.webhooks, ['createSubscription'], [input]),
    list: () => callModule(SVC.webhooks, ['listSubscriptions'], []),
    update: (id, patch) => callModule(SVC.webhooks, ['updateSubscription'], [id, patch]),
    remove: (id) => callModule(SVC.webhooks, ['deleteSubscription'], [id]),
    listDeliveries: (subscriptionId, query) =>
      callModule(SVC.webhooks, ['listDeliveries'], [subscriptionId, query]).then(normalizePaged),
    replayDelivery: (subscriptionId, deliveryId) =>
      callModule(SVC.webhooks, ['replayDelivery'], [subscriptionId, deliveryId]),
  };

  jobs: JobsService = {
    list: (query) => callModule(SVC.jobs, ['listJobs'], [query]).then(normalizePaged),
    get: (id) => callModule(SVC.jobs, ['getJob'], [id]),
    retry: (id) => callModule(SVC.jobs, ['retryJob'], [id]),
  };

  ops: OpsService = {
    // 优先使用来源/额度领域服务（更完整的登录态探测/曲线），缺失时退回本仓库 ops.ts
    listSources: () =>
      callModule(SVC.sources, ['listSources', 'getSources'], []).catch(async () => withOps(['listSources', 'getSources'], [])),
    getStats: (query) => withOps(['getStats'], [query]),
    getQuota: () =>
      callModule(SVC.quota, ['getQuota'], []).catch(async () => withOps(['getQuota'], [])),
  };

  admin: AdminServiceApi = {
    backup: () => this.withAdmin((svc) => svc.backup()),
    archive: (opts) => this.withAdmin((svc) => svc.archive(opts)),
    listManifests: () => this.withAdmin((svc) => svc.listManifests()),
    verify: (opts) => this.withAdmin((svc) => svc.verify(opts)),
    restore: (opts) => this.withAdmin((svc) => svc.restore(opts)),
    dbStats: () => this.withAdmin((svc) => svc.dbStats()),
  };

  private adminInstance: AdminLike | null = null;

  private async withAdmin<T>(fn: (svc: AdminLike) => Promise<T>): Promise<T> {
    if (!this.adminInstance) {
      const mod = await loadModule(SVC.admin);
      if (!mod) throw integrationError([SVC.admin], ['createDefaultAdminService']);
      const factory = mod.createDefaultAdminService;
      if (typeof factory !== 'function') throw integrationError([SVC.admin], ['createDefaultAdminService']);
      this.adminInstance = (await (factory as AnyFn)(runtimeContext)) as AdminLike;
    }
    return fn(this.adminInstance);
  }
}

interface AdminLike {
  backup(): Promise<unknown>;
  archive(opts: { afterDays?: number; dryRun?: boolean }): Promise<unknown>;
  listManifests(): Promise<unknown>;
  verify(opts: { month?: string }): Promise<unknown>;
  restore(opts: { month?: string; dryRun?: boolean }): Promise<unknown>;
  dbStats(): Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* 单例 / 测试注入                                                       */
/* ------------------------------------------------------------------ */

const defaultServices = new DefaultServices();
let injectedServices: RouteServices | null = null;

/** 获取路由服务；测试通过 setRouteServices 注入假实现。 */
export function getRouteServices(): RouteServices {
  return injectedServices ?? defaultServices;
}

/** 测试/集成注入：传 null 复原默认动态桥接。 */
export function setRouteServices(services: RouteServices | null): void {
  injectedServices = services;
}

export function resetRouteServicesForTests(): void {
  injectedServices = null;
  runtimeContext = {};
  moduleCache.clear();
}
