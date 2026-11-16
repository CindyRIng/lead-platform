/**
 * 进程级接线（U1 解锁/额度 + U2 事件/Webhook/SSE）——由 main.ts（Lead）调用。
 *
 * 用法（main.ts）：
 * ```ts
 * import { initUnlockEventsRuntime } from './pipeline/unlockEventsRuntime.js';
 * const runtime = initUnlockEventsRuntime(); // 默认读取全局 F2 repositories + config + tanji client
 * runtime.start();
 * // 关闭时：runtime.stop()
 * ```
 *
 * 安全默认：只有显式 `TANJI_ALLOW_UNLOCK=true`（或注入 `allowUnlock: true` 的 client）才启动
 * Unlock Worker，避免开发/测试环境误触发真实解锁（tanji client 默认 allowUnlock=false）。
 *
 * 测试/QA：可注入 `{ repos, tanji, allowUnlock: true, startUnlockWorker: true }` 装配 mock 上游。
 */
import { config } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { getRepositories, type Repositories } from '../repositories/index.js';
import { createTanjiClient } from '../adapters/tanji.js';
import { createUnlockStore } from './f2UnlockStore.js';
import { UnlockWorker, type TanjiUnlockPort, type UnlockLogger, type UnlockStore } from './unlock.js';
import { QuotaPoller } from './quota.js';
import { createEventsStore, setDefaultEventsStore } from '../events/f2Store.js';
import { SubscriptionService, setDefaultSubscriptionService } from '../events/subscriptions.js';
import { WebhookDispatcher, setDefaultWebhookDispatcher } from '../events/dispatcher.js';
import {
  EventStreamService,
  getSseHub,
  setSseHub,
  type EventSseHub,
} from '../events/sse.js';
import type { EventsStore } from '../events/types.js';

export interface UnlockEventsRuntimeOptions {
  repos?: Repositories;
  /** 注入 tanji client / 结构化 fake（只需 getContacts/unlockCompany/getStatus 三方法，e2e 可传纯对象） */
  tanji?: TanjiUnlockPort;
  /** 是否允许真实解锁（真实部署需 true；默认 TANJI_ALLOW_UNLOCK=true 才为 true） */
  allowUnlock?: boolean;
  /** 是否启动 Unlock Worker（默认 = allowUnlock） */
  startUnlockWorker?: boolean;
  /** 是否启动 Quota Poller（默认 true） */
  startQuotaPoller?: boolean;
  /** 是否启动 Webhook Dispatcher（默认 true） */
  startWebhookDispatcher?: boolean;
  /** 是否启动 SSE 增量 tail（默认 true） */
  startEventStreamer?: boolean;
  logger?: Logger | null;
  /** 覆盖 clock（测试） */
  now?: () => Date;
  /** P0..P(max) 自动解锁（默认 2；P3 不自动解锁）；e2e 可传 3 走自动队列 */
  maxAutoPriority?: number;
  /** Goal.unlockPolicy.order 覆盖（默认 recruiting/paid_member/customs/rest） */
  policyOrder?: readonly string[];
  /** Unlock Worker 轮询间隔（ms，默认 5000） */
  unlockIntervalMs?: number;
  /** Webhook Dispatcher 轮询间隔（ms，默认 1000） */
  webhookIntervalMs?: number;
  /** SSE tail 轮询间隔（ms，默认 1000） */
  ssePollMs?: number;
}

export interface UnlockEventsRuntime {
  repos: Repositories;
  unlockStore: UnlockStore;
  eventsStore: EventsStore;
  tanji: TanjiUnlockPort;
  allowUnlock: boolean;
  unlockWorker: UnlockWorker;
  quotaPoller: QuotaPoller;
  dispatcher: WebhookDispatcher;
  streamService: EventStreamService;
  hub: EventSseHub;
  started: boolean;
  start(): void;
  stop(): void;
  /** 手动触发一轮锁定队列执行（CLI/验收用） */
  tickUnlock(): Promise<unknown>;
  /** 手动触发一次 webhook 分发 */
  tickWebhooks(): Promise<unknown>;
}

/** TANJI_ALLOW_UNLOCK 环境开关（默认关闭） */
export function tanjiAllowUnlockFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TANJI_ALLOW_UNLOCK === 'true' || env.TANJI_ALLOW_UNLOCK === '1';
}

function toUnlockLogger(logger: Logger | null): UnlockLogger {
  if (!logger) return { info() {}, warn() {}, error() {} };
  return {
    info: (msg, fields) => logger.info(msg, fields),
    warn: (msg, fields) => logger.warn(msg, fields),
    error: (msg, fields) => logger.error(msg, fields),
  };
}

export function initUnlockEventsRuntime(opts: UnlockEventsRuntimeOptions = {}): UnlockEventsRuntime {
  const repos = opts.repos ?? getRepositories();
  const logger = opts.logger === undefined ? createLogger({ component: 'unlock-events' }) : opts.logger;
  const unlockLogger = toUnlockLogger(logger);
  const allowUnlock = opts.allowUnlock ?? tanjiAllowUnlockFromEnv();
  const tanji = opts.tanji ?? createTanjiClient({
    baseUrl: config.tanjiUrl,
    token: config.tanjiToken || null,
    allowUnlock,
    // 解锁为浏览器侧异步操作，上游常见 20–60s；过短会超时但上游仍扣点，必须放宽
    timeoutMs: 120_000,
  });

  // --- 解锁/额度 ---
  const unlockStore = createUnlockStore(repos);
  const unlockWorker = new UnlockWorker({
    store: unlockStore,
    tanji,
    dailyCap: config.unlockDailyCap,
    ...(opts.maxAutoPriority !== undefined ? { maxAutoPriority: opts.maxAutoPriority } : {}),
    ...(opts.policyOrder !== undefined ? { policyOrder: opts.policyOrder } : {}),
    logger: unlockLogger,
    now: opts.now,
  });
  const quotaPoller = new QuotaPoller({
    store: unlockStore,
    tanji,
    pollMs: config.quotaPollSec * 1000,
    logger: unlockLogger,
    now: opts.now,
  });

  // --- 事件/Webhook/SSE ---
  const eventsStore = createEventsStore(repos);
  setDefaultEventsStore(eventsStore);
  setDefaultSubscriptionService(new SubscriptionService({ store: eventsStore }));
  const dispatcher = new WebhookDispatcher({
    store: eventsStore,
    maxAttempts: config.webhookMaxAttempts,
    logger: logger ?? undefined,
    now: opts.now,
  });
  setDefaultWebhookDispatcher(dispatcher);
  const hub = getSseHub();
  const streamService = new EventStreamService({ store: eventsStore, hub, pollMs: opts.ssePollMs ?? 1000 });

  const startUnlockWorker = opts.startUnlockWorker ?? allowUnlock;
  const startQuotaPoller = opts.startQuotaPoller ?? true;
  const startWebhookDispatcher = opts.startWebhookDispatcher ?? true;
  const startEventStreamer = opts.startEventStreamer ?? true;

  let started = false;
  const runtime: UnlockEventsRuntime = {
    repos,
    unlockStore,
    eventsStore,
    tanji,
    allowUnlock,
    unlockWorker,
    quotaPoller,
    dispatcher,
    streamService,
    hub,
    get started() {
      return started;
    },
    start(): void {
      if (started) return;
      started = true;
      if (startUnlockWorker) {
        quotaPoller.start();
        unlockWorker.start(opts.unlockIntervalMs ?? 5000);
        logger?.info('unlock worker started', { allowUnlock, dailyCap: config.unlockDailyCap });
      } else {
        logger?.warn('unlock worker disabled: tanji allowUnlock=false (set TANJI_ALLOW_UNLOCK=true to enable)', {
          allowUnlock,
        });
      }
      if (startQuotaPoller && !startUnlockWorker) quotaPoller.start(); // 只读额度观测也有价值
      if (startWebhookDispatcher) dispatcher.start(opts.webhookIntervalMs ?? 1000);
      if (startEventStreamer) streamService.start();
      logger?.info('events runtime started', {
        webhook: startWebhookDispatcher,
        sse: startEventStreamer,
        quotaPoller: startQuotaPoller || startUnlockWorker,
      });
    },
    stop(): void {
      if (!started) return;
      started = false;
      unlockWorker.stop();
      quotaPoller.stop();
      dispatcher.stop();
      streamService.stop();
      hub.closeAll();
      logger?.info('events runtime stopped');
    },
    tickUnlock: () => unlockWorker.runOnce(),
    tickWebhooks: () => dispatcher.tick(),
  };
  return runtime;
}

/** 测试/重启用：清理模块级默认绑定（不关闭全局 repositories） */
export function resetUnlockEventsDefaults(): void {
  setDefaultEventsStore(null);
  setDefaultSubscriptionService(null);
  setDefaultWebhookDispatcher(null);
  setSseHub(null);
}
