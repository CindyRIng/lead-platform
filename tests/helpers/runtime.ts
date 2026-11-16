/**
 * 进程内集成运行时：真实 DB + 真实 repositories/服务/流水线 + mock 上游适配器。
 *
 * 用途：在 REST app 尚未接线完成 / 需要直接观察 DB 状态时，做服务层 e2e
 * （AC-1/2/3/4/5/11/12/14/15/16/17 可在此层验证；HTTP 层由 scripts/acceptance.ts 覆盖）。
 *
 * **重要**：必须在调用 `createIntegrationRuntime()` 之前设置好测试环境变量
 * （`LEAD_DATA_DIR` / 上游 URL 等），因为 `src/config.ts` 是 import 期单例。
 * 推荐：`applyEnv(buildLeadTestEnv({ sandbox, mocks }))` → 再 `createIntegrationRuntime()`。
 *
 * 适配器/worker 的限频等待通过**虚拟时钟**（`sleep` 推进虚拟时间、`now` 读取虚拟时间）瞬间完成，
 * 因此测试不依赖真实等待，也不会访问真实上游。
 */
import type { DatabaseHandle } from '../../src/db/index.js';
import type { Repositories } from '../../src/repositories/index.js';
import type { RegionRegistry } from '../../src/region/registry.js';
import type { SourceAdapterRegistry } from '../../src/adapters/sources/types.js';
import type { TanjiClient } from '../../src/adapters/tanji.js';
import type { FumaClient } from '../../src/adapters/fuma.js';
import type { Goal, GoalRun } from '../../src/shared/domain.js';
import type { RunExecutionResult, RunOrchestrator } from '../../src/pipeline/orchestrator.js';
import type { PipelineRepos, RegionsPort } from '../../src/pipeline/ports.js';
import type { GoalService } from '../../src/services/goals.js';
import type { RunService } from '../../src/services/runs.js';
import { MOCK_TOKENS, type MockUpstreams } from '../mock-upstreams/index.js';
import { normalizeRepositoriesForPorts } from './ports.js';
import type { TempSandbox } from './tmp.js';

export interface VirtualClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
  reset(): void;
  /** 虚拟时间相对真实时间的偏移量（毫秒），用于展示 */
  offsetMs(): number;
}

/** 虚拟时钟：sleep 直接推进虚拟时间，用于跳过限频/退避等待 */
export function createVirtualClock(start = Date.now()): VirtualClock {
  const startReal = Date.now();
  let current = start;
  return {
    now: () => current,
    async sleep(ms: number) {
      current += Math.max(0, Math.floor(ms));
    },
    advance(ms: number) {
      current += Math.max(0, Math.floor(ms));
    },
    reset() {
      current = start;
    },
    offsetMs() {
      return current - startReal;
    },
  };
}

export interface IntegrationRuntimeOptions {
  mocks: MockUpstreams;
  sandbox: TempSandbox;
  /** 使用内存 DB（默认 false：使用 sandbox.dbPath，便于重启/跨实例验证） */
  memoryDb?: boolean;
  /** 编排查询计划选项（默认关闭 Ali 地理/县级种子与行业矩阵，保持 e2e 小而快） */
  queryOptions?: {
    aliGeoSeeds?: boolean;
    aliCountySeeds?: boolean;
    aliIndustryMatrix?: boolean;
  };
  /** 单查询最大页数（默认 2） */
  maxPagesPerQuery?: number | null;
  /** 单轮最长运行小时（默认 6） */
  runMaxHours?: number;
  /** 虚拟时钟起点（默认 Date.now） */
  clockStart?: number;
  /** 注入 logger 收集（可选） */
  logger?: { info?: (msg: string, meta?: Record<string, unknown>) => void; warn?: (msg: string, meta?: Record<string, unknown>) => void; error?: (msg: string, meta?: Record<string, unknown>) => void } | null;
}

export interface IntegrationRuntime {
  db: DatabaseHandle;
  repos: Repositories;
  registry: RegionRegistry;
  adapters: SourceAdapterRegistry;
  tanji: TanjiClient;
  fuma: FumaClient;
  goals: GoalService;
  runs: RunService;
  orchestrator: RunOrchestrator;
  clock: VirtualClock;
  /** 创建 Goal（走真实 GoalService 校验/区域展开） */
  createGoal(input: unknown): Promise<Goal>;
  /** 手动触发一次 Run 并等待执行结束（返回最终 run/stats） */
  runGoal(goalId: string): Promise<RunExecutionResult>;
  /** 关闭 DB（mock 上游由调用方关闭） */
  close(): void;
}

export async function createIntegrationRuntime(opts: IntegrationRuntimeOptions): Promise<IntegrationRuntime> {
  const clock = createVirtualClock(opts.clockStart ?? Date.now());

  // 动态 import：确保调用方已先 applyEnv(...)（config 单例在 import 时读取 env）
  const [{ openDatabase, openMemoryDatabase }, { createRepositories, initRepositories, resetRepositoriesForTests }, { RegionRegistry }, adaptersMod, tanjiMod, fumaMod, goalsMod, runsMod, orchestratorMod, contextMod] =
    await Promise.all([
      import('../../src/db/index.js'),
      import('../../src/repositories/index.js'),
      import('../../src/region/registry.js'),
      import('../../src/adapters/sources/types.js'),
      import('../../src/adapters/tanji.js'),
      import('../../src/adapters/fuma.js'),
      import('../../src/services/goals.js'),
      import('../../src/services/runs.js'),
      import('../../src/pipeline/orchestrator.js'),
      import('../../src/services/context.js'),
    ]);

  const { BossAdapter } = await import('../../src/adapters/sources/boss.js');
  const { ZhilianAdapter } = await import('../../src/adapters/sources/zhilian.js');
  const { AliAdapter } = await import('../../src/adapters/sources/ali.js');
  const { MicAdapter } = await import('../../src/adapters/sources/mic.js');
  void adaptersMod;

  const db = opts.memoryDb ? openMemoryDatabase() : openDatabase({ file: opts.sandbox.dbPath });
  const repos = createRepositories(db, {
    snapshotCompression: 'brotli',
    jobLeaseSec: 60,
    jobMaxAttempts: 3,
  });
  initRepositories(repos);

  const registry = new RegionRegistry(repos.regions as unknown as RegionsPort);
  await registry.ensureBaseline();

  const adapterCommon = { sleep: clock.sleep, now: clock.now };
  const adapters: SourceAdapterRegistry = {
    boss: new BossAdapter({ baseUrl: opts.mocks.url('boss'), token: MOCK_TOKENS.boss, ...adapterCommon }),
    zhilian: new ZhilianAdapter({ baseUrl: opts.mocks.url('zhilian'), token: MOCK_TOKENS.zhilian, ...adapterCommon }),
    ali: new AliAdapter({ baseUrl: opts.mocks.url('ali'), token: MOCK_TOKENS.ali, ...adapterCommon }),
    mic: new MicAdapter({ baseUrl: opts.mocks.url('mic'), ...adapterCommon }),
  };

  const tanji = new tanjiMod.TanjiClient({
    baseUrl: opts.mocks.url('tanji'),
    token: MOCK_TOKENS.tanji,
    allowUnlock: true,
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

  // F2 Repositories → PipelineRepos 端口归一（生产侧由 wiring 负责；差异清单见 tests/helpers/ports.ts）
  const ports = normalizeRepositoriesForPorts(repos);
  const goals = goalsMod.createGoalService({ goals: ports.goals, registry, runs: ports.runs });
  const runs = runsMod.createRunService({ goals: ports.goals, runs: ports.runs, sourceQueries: ports.sourceQueries });

  contextMod.initServiceContext({
    repos: ports,
    registry,
    adapters,
    logger: opts.logger ?? null,
    now: () => new Date(clock.now()),
    runMaxHours: opts.runMaxHours ?? 6,
  });

  const orchestrator = orchestratorMod.createOrchestrator({
    repos: ports,
    registry,
    adapters,
    logger: opts.logger ?? null,
    sleep: clock.sleep,
    now: () => new Date(clock.now()),
    runMaxHours: opts.runMaxHours ?? 6,
    maxPagesPerQuery: opts.maxPagesPerQuery ?? 2,
    queryOptions: {
      // 默认：Ali 只跑省级地理种子（1 查询），关闭县级种子与行业矩阵以保持 e2e 小而快
      aliGeoSeeds: true,
      aliCountySeeds: false,
      aliIndustryMatrix: false,
      ...(opts.queryOptions ?? {}),
    },
  });

  const runtime: IntegrationRuntime = {
    db,
    repos,
    registry,
    adapters,
    tanji,
    fuma,
    goals,
    runs,
    orchestrator,
    clock,
    async createGoal(input: unknown) {
      const view = await goals.createGoal(input);
      return view as Goal;
    },
    async runGoal(goalId: string) {
      const { execution } = await orchestrator.startRun(goalId, 'manual');
      return execution;
    },
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      contextMod.resetServiceContext();
      goalsMod.resetGoalService();
      runsMod.resetRunService();
      resetRepositoriesForTests();
    },
  };
  return runtime;
}

/** 便捷：默认 4 城 1 关键词的 Goal 输入（跨源覆盖 chenxing/yunfan/lanjing/huaxi/haichuan/hengyue） */
export function defaultGoalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '河北省-外贸线索（测试）',
    region: { province: '河北省', cityCodes: ['130100', '130200', '130600', '130900'] },
    platforms: ['boss', 'zhilian', 'ali', 'mic'],
    keywords: {
      boss: ['外贸'],
      zhilian: ['外贸'],
      ali: [],
      mic: [],
    },
    maxLeadsPerRun: null,
    dailyLeadLimit: null,
    schedule: { cron: '0 2 * * *', timeZone: 'Asia/Shanghai', timeWindow: '02:00-08:00' },
    priority: 100,
    tradeFilter: null,
    unlockPolicy: { mode: 'priority', order: ['recruiting', 'paid_member', 'customs', 'rest'] },
    enabled: true,
    ...overrides,
  };
}

/** 等待 Run 到达终态（进程内 Run 已 await，此函数用于 worker 异步场景） */
export async function waitRunTerminal(
  runtime: IntegrationRuntime,
  runId: string,
  timeoutMs = 8000,
): Promise<GoalRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await runtime.repos.runs.getById(runId);
    if (run && ['completed', 'partial', 'failed', 'cancelled'].includes(run.status)) return run;
    if (Date.now() >= deadline) throw new Error(`等待 Run ${runId} 终态超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
