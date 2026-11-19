/** 服务入口（Lead 集成版）：F1 + F2 + S1-S4 + T + R + U + 事件运行时 */
import { config } from './config.js';
import { logger } from './logger.js';
import { closeDb, getDb, initDatabase } from './db/index.js';
import { initRepositories } from './repositories/index.js';
import { buildServer } from './http/server.js';
import { initPipelineRuntime, type PipelineRuntime } from './pipeline/wiring.js';
import { setPipelineRuntime } from './pipeline/runtimeRegistry.js';
import { initUnlockEventsRuntime, type UnlockEventsRuntime } from './pipeline/unlockEventsRuntime.js';
import { companiesDepsFromRepositories, configureCompaniesService } from './services/companies.js';
import { createTanjiClient } from './adapters/tanji.js';
import { FumaClient } from './adapters/fuma.js';
import { createEnrichmentWorker, type EnrichmentWorker } from './pipeline/enrichment.js';
import { createPlatformRefreshWorker, type PlatformRefreshWorker } from './pipeline/platformRefresh.js';
import { createCustomsWorker, type CustomsWorker } from './pipeline/customs.js';

interface Loops {
  stop(): void;
}

function every(ms: number, fn: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { logger.warn('background loop error', { err: String(err) }); } finally { running = false; }
  };
  void run();
  return setInterval(() => void run(), ms);
}

function startWorkers(
  enrichment: EnrichmentWorker,
  refresh: PlatformRefreshWorker,
  customs: CustomsWorker,
  opts: { enrichmentDailyMax?: number; meta?: { get(key: string): string | null; set(key: string, value: string): unknown } } = {},
): Loops {
  const dailyMax = opts.enrichmentDailyMax && opts.enrichmentDailyMax > 0 ? opts.enrichmentDailyMax : 40;
  const timers = [
    every(20_000, async () => {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const key = `enrichment_daily_claimed:${today}`;
      const claimedToday = Number(opts.meta?.get(key) ?? 0) || 0;
      if (claimedToday >= dailyMax) return;
      const stats = await enrichment.runOnce(Math.min(5, dailyMax - claimedToday));
      if (stats.claimed > 0) opts.meta?.set(key, String(claimedToday + stats.claimed));
    }),
    every(60_000, () => refresh.runOnce({ limit: 10, enqueueDue: true }).then(() => undefined)),
    every(180_000, () => customs.runOnce({ limit: 5, enqueueDue: true }).then(() => undefined)),
  ];
  return { stop: () => timers.forEach((t) => clearInterval(t)) };
}

async function main(): Promise<void> {
  initDatabase();
  initRepositories(getDb());

  const runtime: PipelineRuntime = await initPipelineRuntime({
    db: getDb() as unknown as never,
    config,
    logger: logger as unknown as never,
    // 启动时不同步区域字典，避免与首个 Run 抢上游/触发会话重启；每日 03:00 由 regionSync 负责
    regionSyncOnStart: false,
    queryOptions: {
      aliGeoSeeds: config.aliGeoSeeds,
      aliCountySeeds: config.aliCountySeeds,
      aliIndustryMatrix: config.aliIndustryMatrix,
    },
  });
  await runtime.start();
  setPipelineRuntime(runtime);
  configureCompaniesService(companiesDepsFromRepositories(runtime.repos));

  const unlockEvents: UnlockEventsRuntime = initUnlockEventsRuntime({
    repos: runtime.repos,
    logger,
    startQuotaPoller: config.quotaPollerEnabled,
  });
  unlockEvents.start();

  let loops: Loops | null = null;
  if (config.refreshWorkerEnabled) {
    try {
      const tanjiRateRaw = Number(process.env.TANJI_RATE_PER_MIN ?? '');
      const tanjiRate = Number.isFinite(tanjiRateRaw) && tanjiRateRaw > 0 ? tanjiRateRaw : 20;
      const tanji = createTanjiClient({
        baseUrl: config.tanjiUrl,
        token: config.tanjiToken || null,
        allowUnlock: false,
        ratePerMin: tanjiRate,
        burst: 1,
      });
      const enrichment = createEnrichmentWorker({
        ...companiesDepsFromRepositories(runtime.repos),
        leads: runtime.repos.leads as never,
        tanji,
        sources: {
          boss: runtime.adapters.boss as unknown as never,
          zhilian: runtime.adapters.zhilian as unknown as never,
        },
        logger: logger as unknown as never,
      });
      const refresh = createPlatformRefreshWorker({ repos: runtime.repos, logger: logger as unknown as never, clock: () => new Date() });
      const customs = createCustomsWorker({
        repos: runtime.repos,
        fuma: new FumaClient({ baseUrl: config.fumaUrl, token: config.fumaToken || null, accountId: config.fumaAccountId }),
        logger: logger as unknown as never,
        clock: () => new Date(),
      });
      const dailyMaxRaw = Number(process.env.LEAD_ENRICHMENT_DAILY_MAX_JOBS ?? '');
      const enrichmentDailyMax = Number.isFinite(dailyMaxRaw) && dailyMaxRaw > 0 ? dailyMaxRaw : 40;
      loops = startWorkers(enrichment, refresh, customs, { enrichmentDailyMax, meta: runtime.repos.meta as never });
      logger.info('background workers started', { enrichment: true, refresh: true, customs: true });
    } catch (err) {
      logger.error('background workers failed to start', { err: String(err) });
    }
  }

  const app = await buildServer();
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal });
    try { loops?.stop(); } catch { /* ignore */ }
    try { unlockEvents.stop(); } catch { /* ignore */ }
    try { await runtime.stop(); } catch { /* ignore */ }
    try { await app.close(); } catch (err) { logger.error('server close failed', { err: String(err) }); }
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { err: String(reason) }));
  await app.listen({ host: config.host, port: config.port });
  logger.info('lead-platform listening', { url: `http://${config.host}:${config.port}`, docs: `http://${config.host}:${config.port}/docs` });
}

void main().catch((err) => {
  logger.error('startup failed', { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
