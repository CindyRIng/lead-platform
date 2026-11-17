/**
 * 全链路进程内运行时（e2e）：mock 六上游 + 真实 SQLite + 真实 wiring/workers/REST。
 *
 * 与 src/main.ts 的装配一致（initPipelineRuntime → initUnlockEventsRuntime → 后台 workers → buildServer），
 * 但全部可控：
 *  - 上游 = tests/mock-upstreams（随机端口，绝不访问真实上游）；
 *  - 虚拟时钟注入适配器/worker → 限频/退避不真实等待；
 *  - scheduler / regionSync 关闭，Run 由测试手动触发；
 *  - worker 由 `tick()` 手动驱动（收集→补全→刷新→海关→解锁→webhook）。
 *
 * **必须在调用前 applyEnv(buildLeadTestEnv(...))**（config 单例在 import 期读取 env）。
 */
import type { FastifyInstance } from 'fastify';
import type { MockUpstreams } from '../mock-upstreams/index.js';
import { MOCK_TOKENS } from '../mock-upstreams/index.js';
import type { TestApiClient } from './http.js';
import type { TempSandbox } from './tmp.js';
import { createVirtualClock, type VirtualClock } from './runtime.js';
import { setDefaultRepositories } from '../../src/services/repositoryAccess.js';

export interface FullRuntimeOptions {
  mocks: MockUpstreams;
  sandbox: TempSandbox;
  memoryDb?: boolean;
  /** 单查询最大页数（默认 1：e2e 快） */
  maxPagesPerQuery?: number | null;
  /** Ali 查询策略（默认仅省级地理种子） */
  queryOptions?: { aliGeoSeeds?: boolean; aliCountySeeds?: boolean; aliIndustryMatrix?: boolean };
  /** 解锁策略：P0..P(maxAuto) 自动解锁（默认 3，含 P3 便于 e2e 验证；生产默认 2） */
  maxAutoPriority?: number;
  /** 是否允许 unlock（默认 true；仅作用于 mock 上游） */
  allowUnlock?: boolean;
  logger?: null;
}

export interface TickSummary {
  enrichment?: unknown;
  enrichmentRounds: number;
  refresh?: unknown;
  customs?: unknown;
  unlock?: unknown;
  webhooks?: unknown;
}

/** HTTP 客户端类型（真实实现见 tests/helpers/http.ts） */
export type ApiClient = TestApiClient;

export interface FullRuntime {
  clock: VirtualClock;
  db: unknown;
  repos: unknown;
  pipeline: unknown;
  adapters: unknown;
  app: FastifyInstance;
  api: ApiClient;
  baseUrl: string;
  token: string;
  enrichment: unknown;
  refresh: unknown;
  customs: unknown;
  unlockEvents: unknown;
  quotaPoller: unknown;
  tanji: unknown;
  fuma: unknown;
  /** 运行一个 Goal（返回收集阶段结果；不含补全/解锁） */
  runGoal(goalId: string): Promise<{
    run: { id: string; status: string; stats?: Record<string, unknown> };
    stats?: Record<string, unknown>;
    skippedSources?: unknown[];
  }>;
  /** 按依赖顺序推进后台 workers 直到稳定（收集后补全/刷新/海关/解锁/webhook） */
  tick(opts?: { rounds?: number; refresh?: boolean; customs?: boolean; unlock?: boolean; webhooks?: boolean }): Promise<TickSummary>;
  /** 重新把本 runtime 的全局单例（repositories/ServiceContext/事件默认绑定）装回进程（多 runtime 交替使用后恢复用） */
  activateGlobals(): void;
  close(): Promise<void>;
}

export async function createFullRuntime(opts: FullRuntimeOptions): Promise<FullRuntime> {
  const clock = createVirtualClock();
  const [
    dbMod,
    reposMod,
    wiringMod,
    unlockEventsMod,
    companiesMod,
    enrichmentMod,
    refreshMod,
    customsMod,
    tanjiMod,
    fumaMod,
    serverMod,
    configMod,
    contextMod,
    runtimeRegistryMod,
    eventsStoreMod,
    eventsSubMod,
    eventsDispatcherMod,
    eventsSseMod,
    { TestApiClient },
  ] = await Promise.all([
    import('../../src/db/index.js'),
    import('../../src/repositories/index.js'),
    import('../../src/pipeline/wiring.js'),
    import('../../src/pipeline/unlockEventsRuntime.js'),
    import('../../src/services/companies.js'),
    import('../../src/pipeline/enrichment.js'),
    import('../../src/pipeline/platformRefresh.js'),
    import('../../src/pipeline/customs.js'),
    import('../../src/adapters/tanji.js'),
    import('../../src/adapters/fuma.js'),
    import('../../src/http/server.js'),
    import('../../src/config.js'),
    import('../../src/services/context.js'),
    import('../../src/pipeline/runtimeRegistry.js'),
    import('../../src/events/f2Store.js'),
    import('../../src/events/subscriptions.js'),
    import('../../src/events/dispatcher.js'),
    import('../../src/events/sse.js'),
    import('./http.js'),
  ]);

  const { BossAdapter } = await import('../../src/adapters/sources/boss.js');
  const { ZhilianAdapter } = await import('../../src/adapters/sources/zhilian.js');
  const { AliAdapter } = await import('../../src/adapters/sources/ali.js');
  const { MicAdapter } = await import('../../src/adapters/sources/mic.js');

  // 1) DB + repositories（DB 对象上挂 repositories，供 initPipelineRuntime 复用同一实例）
  const db = (opts.memoryDb ?? true) ? dbMod.openMemoryDatabase() : dbMod.openDatabase({ file: opts.sandbox.dbPath });
  const repos = reposMod.createRepositories(db, { snapshotCompression: 'brotli' });
  (db as unknown as { repositories?: unknown }).repositories = repos;
  reposMod.initRepositories(repos);

  // 2) 适配器（虚拟时钟，避免限频真实等待）
  const adapterCommon = { sleep: clock.sleep, now: clock.now };
  const adapters = {
    boss: new BossAdapter({ baseUrl: opts.mocks.url('boss'), token: MOCK_TOKENS.boss, ...adapterCommon }),
    zhilian: new ZhilianAdapter({ baseUrl: opts.mocks.url('zhilian'), token: MOCK_TOKENS.zhilian, ...adapterCommon }),
    ali: new AliAdapter({ baseUrl: opts.mocks.url('ali'), token: MOCK_TOKENS.ali, ...adapterCommon }),
    mic: new MicAdapter({ baseUrl: opts.mocks.url('mic'), ...adapterCommon }),
  };

  // 3) pipeline runtime（orchestrator/scheduler/registry/service context）
  const pipeline = await wiringMod.initPipelineRuntime({
    db: db as unknown as never,
    config: configMod.config,
    logger: null,
    adapters,
    startScheduler: false,
    startRegionSync: false,
    queryOptions: {
      aliGeoSeeds: true,
      aliCountySeeds: false,
      aliIndustryMatrix: false,
      ...(opts.queryOptions ?? {}),
    },
    maxPagesPerQuery: opts.maxPagesPerQuery ?? 1,
    now: () => new Date(clock.now()),
  });
  await pipeline.start();
  runtimeRegistryMod.setPipelineRuntime(pipeline as never);

  // 4) tanji / fuma 客户端（真实 adapter → mock 上游）
  const tanji = tanjiMod.createTanjiClient({
    baseUrl: opts.mocks.url('tanji'),
    token: MOCK_TOKENS.tanji,
    allowUnlock: opts.allowUnlock ?? true,
    sleep: clock.sleep,
    now: clock.now,
    ratePerMin: 60_000,
  });
  const fuma = new fumaMod.FumaClient({
    baseUrl: opts.mocks.url('fuma'),
    token: MOCK_TOKENS.fuma,
    accountId: 'acct_01',
    sleep: clock.sleep,
    now: clock.now,
    rate: { minIntervalMs: 0 },
  });

  // 5) 解锁/额度 + 事件/Webhook/SSE 运行时（不启动内部定时器，测试手动 tick）
  const unlockEvents = unlockEventsMod.initUnlockEventsRuntime({
    repos,
    tanji: tanji as unknown as never,
    allowUnlock: opts.allowUnlock ?? true,
    startUnlockWorker: false,
    startQuotaPoller: false,
    startWebhookDispatcher: false,
    startEventStreamer: false,
    logger: null,
    now: () => new Date(clock.now()),
    maxAutoPriority: opts.maxAutoPriority ?? 3,
  });
  unlockEvents.start();

  // 6) 服务层全局依赖 + 后台 workers
  companiesMod.configureCompaniesService(companiesMod.companiesDepsFromRepositories(repos));
  const enrichment = enrichmentMod.createEnrichmentWorker(
    {
      ...companiesMod.companiesDepsFromRepositories(repos),
      tanji: tanji as unknown as never,
      sources: { boss: adapters.boss as unknown as never, zhilian: adapters.zhilian as unknown as never },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    } as never,
    { workerId: 'e2e-enrichment', maxJobs: 500 },
  );
  const refreshAdapters = {
    boss: adapters.boss as unknown as never,
    zhilian: adapters.zhilian as unknown as never,
    ali: { getCompanyDetail: (id: string) => adapters.ali.getSupplierDetail(id) } as unknown as never,
    mic: { getCompanyDetail: (id: string) => adapters.mic.getCompanyDetail(id, ['audit', 'response', 'reviews']) } as unknown as never,
  };
  const refresh = refreshMod.createPlatformRefreshWorker({
    repos,
    adapters: refreshAdapters as never,
    logger: undefined,
    clock: () => new Date(clock.now()),
  });
  const customs = customsMod.createCustomsWorker({
    repos,
    fuma: fuma as unknown as never,
    logger: undefined,
    clock: () => new Date(clock.now()),
  });

  // 7) HTTP app（真实路由 + envelope + 鉴权；监听随机端口便于 fetch/SSE/webhook）
  const app = await serverMod.buildServer({ logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = configMod.config.apiToken;
  const api = new TestApiClient(baseUrl, token);

  const summary = (value: unknown): unknown => value;

  const full: FullRuntime = {
    clock: clock as VirtualClock,
    db,
    repos,
    pipeline,
    adapters,
    app,
    api: api as unknown as ApiClient,
    baseUrl,
    token,
    enrichment,
    refresh,
    customs,
    unlockEvents,
    quotaPoller: (unlockEvents as unknown as { quotaPoller: unknown }).quotaPoller,
    tanji,
    fuma,
    async runGoal(goalId: string) {
      const orchestrator = pipeline.orchestrator as unknown as {
        startRun(goalId: string, trigger: 'manual'): Promise<{
          run: { id: string; status: string; stats?: Record<string, unknown> };
          execution: Promise<{ run: { id: string; status: string; stats?: Record<string, unknown> }; stats?: Record<string, unknown>; skippedSources?: unknown[] }>;
        }>;
      };
      const { execution } = await orchestrator.startRun(goalId, 'manual');
      return execution;
    },
    async tick(tickOpts = {}): Promise<TickSummary> {
      const rounds = tickOpts.rounds ?? 8;
      const result: TickSummary = { enrichmentRounds: 0 };
      const enrichmentWorker = enrichment as unknown as { runUntilIdle(max?: number): Promise<unknown> };
      const refreshWorker = refresh as unknown as { runOnce(o?: { limit?: number; enqueueDue?: boolean }): Promise<unknown> };
      const customsWorker = customs as unknown as { runOnce(o?: { limit?: number; enqueueDue?: boolean }): Promise<unknown> };
      const unlockRuntime = unlockEvents as unknown as { tickUnlock(): Promise<unknown>; tickWebhooks(): Promise<unknown> };

      // 1) 补全（source_detail/tanji_match/tanji_detail），可能产生 unlock 任务
      result.enrichment = await enrichmentWorker.runUntilIdle(500);
      result.enrichmentRounds += 1;

      // 2) 平台档案/岗位（新公司 + 到期）→ 岗位/档案任务
      if (tickOpts.refresh !== false) {
        result.refresh = await refreshWorker.runOnce({ limit: 200, enqueueDue: true });
      }

      // 3) 海关（Ali/Mic）
      if (tickOpts.customs !== false) {
        result.customs = await customsWorker.runOnce({ limit: 100, enqueueDue: true });
      }

      // 4) 解锁（FIFO + 额度）
      const quotaPoller = (unlockEvents as unknown as { quotaPoller: { pollOnce(): Promise<unknown> } }).quotaPoller;
      if (tickOpts.unlock !== false) {
        for (let i = 0; i < rounds; i += 1) {
          result.unlock = await unlockRuntime.tickUnlock();
          const enrichAgain = await enrichmentWorker.runUntilIdle(500);
          result.enrichmentRounds += 1;
          void enrichAgain;
          const done = result.unlock as {
            claimed?: number;
            enqueued?: number;
            waitingQuota?: number;
            paused?: boolean;
          };
          if (done && (done.claimed ?? 0) === 0 && (done.enqueued ?? 0) === 0) break;
        }
        // 解锁后刷新一次额度观测（/v1/quota 展示剩余额度）
        try {
          await quotaPoller.pollOnce();
        } catch {
          /* ignore */
        }
      }

      // 5) Webhook 分发（fanout change_events → deliveries → 投递）
      if (tickOpts.webhooks !== false) {
        result.webhooks = await unlockRuntime.tickWebhooks();
      }
      return result;
    },
    activateGlobals() {
      // 恢复进程级单例到本 runtime（多 runtime 交替创建后，供 REST 路由/服务使用）
      try {
        reposMod.initRepositories(repos);
        setDefaultRepositories(repos as never);
      } catch {
        /* ignore */
      }
      try {
        contextMod.initServiceContext(pipeline.ctx as never);
      } catch {
        /* ignore */
      }
      try {
        runtimeRegistryMod.setPipelineRuntime(pipeline as never);
      } catch {
        /* ignore */
      }
      try {
        companiesMod.configureCompaniesService(companiesMod.companiesDepsFromRepositories(repos));
      } catch {
        /* ignore */
      }
      const events = unlockEvents as unknown as {
        eventsStore: unknown;
        dispatcher: unknown;
        hub: unknown;
      };
      try {
        eventsStoreMod.setDefaultEventsStore(events.eventsStore as never);
        eventsSubMod.setDefaultSubscriptionService(new eventsSubMod.SubscriptionService({ store: events.eventsStore as never }));
        eventsDispatcherMod.setDefaultWebhookDispatcher(events.dispatcher as never);
        eventsSseMod.setSseHub(events.hub as never);
      } catch {
        /* ignore */
      }
    },
    async close() {
      try {
        await app.close();
      } catch {
        /* ignore */
      }
      try {
        (unlockEvents as unknown as { stop(): void }).stop();
      } catch {
        /* ignore */
      }
      try {
        unlockEventsMod.resetUnlockEventsDefaults();
      } catch {
        /* ignore */
      }
      try {
        runtimeRegistryMod.setPipelineRuntime(null);
      } catch {
        /* ignore */
      }
      try {
        await (pipeline as unknown as { stop(): Promise<void> }).stop();
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        reposMod.resetRepositoriesForTests();
      } catch {
        /* ignore */
      }
      void summary;
    },
  };
  return full;
}
