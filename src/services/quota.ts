/**
 * 额度查询服务（/v1/quota、CLI `lead quota`）。
 *
 * 数据来源：quota_observations（Quota Poller 每 10 分钟写入）+ unlock_ledger（近 N 天解锁曲线）。
 * 不直接调用 tanji（实时刷新由 Quota Poller / 手动 refresh 接口负责）。
 */
import { nowIso } from '../shared/time.js';
import { shanghaiDateString } from '../pipeline/unlock.js';
import type { QuotaViewStore, QuotaObservationSnapshot } from '../pipeline/unlock.js';
import { getDefaultQuotaViewStore } from '../pipeline/f2UnlockStore.js';

export interface QuotaBucketView {
  limit: number;
  used: number;
  remaining: number;
  unit: string;
}

export interface QuotaView {
  daily: QuotaBucketView;
  monthly: QuotaBucketView;
  enterpriseMonthly: QuotaBucketView;
  settlementDay: number | null;
  nearlySevenDayUnlockCount: number | null;
  observedAt: string | null;
  /** 近 14 天每日成功解锁数（北京时间） */
  recentUnlockCurve: Array<{ date: string; count: number; quotaCost: number }>;
}

export interface QuotaServiceDeps {
  store: QuotaViewStore;
  now?: () => Date;
  /** 曲线窗口天数 */
  curveDays?: number;
  /** 取多少条台账用于统计曲线 */
  ledgerScanLimit?: number;
}

const UNIT = 'point';

function bucket(limit: number | null, remaining: number | null): QuotaBucketView {
  const lim = limit ?? 0;
  const rem = remaining ?? 0;
  return { limit: lim, used: Math.max(0, lim - rem), remaining: rem, unit: UNIT };
}

function extractNearlySevenDayUnlockCount(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>).nearlySevenDayUnlockCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 台账 → 近 N 天解锁曲线（按 Asia/Shanghai 日期聚合） */
export function buildUnlockCurve(
  entries: Array<{ result: string; quotaCost: number; requestedAt: string }>,
  now: Date,
  days = 14,
): Array<{ date: string; count: number; quotaCost: number }> {
  const buckets = new Map<string, { count: number; quotaCost: number }>();
  const cutoff = now.getTime() - days * 86400_000;
  for (const entry of entries) {
    if (entry.result !== 'unlocked') continue;
    const at = Date.parse(entry.requestedAt);
    if (!Number.isFinite(at) || at < cutoff) continue;
    const date = shanghaiDateString(new Date(at));
    const bucketValue = buckets.get(date) ?? { count: 0, quotaCost: 0 };
    bucketValue.count += 1;
    bucketValue.quotaCost += entry.quotaCost ?? 0;
    buckets.set(date, bucketValue);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, value]) => ({ date, count: value.count, quotaCost: value.quotaCost }));
}

export class QuotaService {
  private readonly store: QuotaViewStore;
  private readonly now: () => Date;
  private readonly curveDays: number;
  private readonly ledgerScanLimit: number;

  constructor(deps: QuotaServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.curveDays = deps.curveDays ?? 14;
    this.ledgerScanLimit = deps.ledgerScanLimit ?? 200;
  }

  async getQuota(): Promise<QuotaView> {
    const observation = await this.store.latestQuotaObservation();
    const ledger = await this.store.listRecentLedger(this.ledgerScanLimit);
    return this.toView(observation, ledger);
  }

  toView(
    observation: QuotaObservationSnapshot | null,
    ledger: Array<{ result: string; quotaCost: number; requestedAt: string }>,
  ): QuotaView {
    return {
      daily: bucket(observation?.dailyLimit ?? null, observation?.dailyRemaining ?? null),
      monthly: bucket(observation?.monthlyLimit ?? null, observation?.monthlyRemaining ?? null),
      enterpriseMonthly: bucket(observation?.enterpriseLimit ?? null, observation?.enterpriseRemaining ?? null),
      settlementDay: observation?.settlementDay ?? null,
      nearlySevenDayUnlockCount: extractNearlySevenDayUnlockCount(observation?.raw),
      observedAt: observation?.observedAt ?? null,
      recentUnlockCurve: buildUnlockCurve(ledger, this.now(), this.curveDays),
    };
  }

  /** 最近一次观测（原始快照；供 /v1/status、调试） */
  async getObservation(): Promise<QuotaObservationSnapshot | null> {
    return this.store.latestQuotaObservation();
  }
}

export interface GetQuotaOptions {
  deps?: QuotaServiceDeps;
}

/** HTTP/CLI/MCP 入口：无参调用时使用全局 F2 repositories */
export async function getQuota(options: GetQuotaOptions = {}): Promise<QuotaView> {
  const deps = options.deps ?? { store: getDefaultQuotaViewStore() };
  const service = new QuotaService(deps);
  return service.getQuota();
}

/** 当前时间（测试/展示辅助） */
export function quotaObservedNow(): string {
  return nowIso();
}
