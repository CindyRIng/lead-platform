/**
 * Quota Poller（U1，FR-6）：每 LEAD_QUOTA_POLL_SEC（默认 600s）拉 tanji /v1/status，
 * 写 quota_observations；检测「日额度刷新 / 结算日恢复 / 剩余额度增加 / 由 0 恢复」时，
 * 把 waiting_quota 任务批量恢复为 pending（保持 FIFO），解锁队列自动续跑。
 *
 * 注意：poller 只读 /v1/status，不调用 unlock；错误不影响主流程。
 */
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import type { TanjiStatus } from '../adapters/tanji.js';
import {
  type QuotaObservationSnapshot,
  type TanjiUnlockPort,
  type UnlockLogger,
  type UnlockStore,
  quotaObservationFromStatus,
  shanghaiDateString,
} from './unlock.js';

export const DEFAULT_QUOTA_POLL_MS = 600_000;

export interface QuotaPollerOptions {
  store: UnlockStore;
  tanji: TanjiUnlockPort;
  now?: () => Date;
  pollMs?: number;
  logger?: UnlockLogger;
}

export interface QuotaPollResult {
  observed: boolean;
  observedAt: string | null;
  /** 是否检测到额度恢复（可唤醒 waiting_quota） */
  recovered: boolean;
  recoveryReason: 'daily_increased' | 'monthly_increased' | 'new_day' | 'settlement_day' | 'from_zero' | 'first_observation' | null;
  /** 被恢复为 pending 的任务数 */
  resumed: number;
  dailyRemaining: number | null;
  monthlyRemaining: number | null;
  errorCode: string | null;
}

function hasQuota(snapshot: QuotaObservationSnapshot): boolean {
  const dailyOk = snapshot.dailyRemaining === null || snapshot.dailyRemaining > 0;
  const monthlyOk = snapshot.monthlyRemaining === null || snapshot.monthlyRemaining > 0;
  return dailyOk && monthlyOk && (snapshot.dailyRemaining !== null || snapshot.monthlyRemaining !== null);
}

/** 判断是否应唤醒 waiting_quota 队列 */
export function detectQuotaRecovery(
  previous: QuotaObservationSnapshot | null,
  current: QuotaObservationSnapshot,
): { recovered: boolean; reason: QuotaPollResult['recoveryReason'] } {
  if (!hasQuota(current)) return { recovered: false, reason: null };
  if (!previous) return { recovered: true, reason: 'first_observation' };

  const prevZeroDaily = previous.dailyRemaining !== null && previous.dailyRemaining <= 0;
  const prevZeroMonthly = previous.monthlyRemaining !== null && previous.monthlyRemaining <= 0;
  if (
    (prevZeroDaily && (current.dailyRemaining ?? 0) > 0) ||
    (prevZeroMonthly && (current.monthlyRemaining ?? 0) > 0)
  ) {
    return { recovered: true, reason: 'from_zero' };
  }
  if (previous.dailyRemaining !== null && current.dailyRemaining !== null && current.dailyRemaining > previous.dailyRemaining) {
    return { recovered: true, reason: 'daily_increased' };
  }
  if (previous.monthlyRemaining !== null && current.monthlyRemaining !== null && current.monthlyRemaining > previous.monthlyRemaining) {
    return { recovered: true, reason: 'monthly_increased' };
  }
  if (previous.settlementDay !== null && current.settlementDay !== null && current.settlementDay !== previous.settlementDay) {
    return { recovered: true, reason: 'settlement_day' };
  }
  const prevDate = shanghaiDateString(new Date(previous.observedAt));
  const currentDate = shanghaiDateString(new Date(current.observedAt));
  if (prevDate !== currentDate) return { recovered: true, reason: 'new_day' };
  return { recovered: false, reason: null };
}

export class QuotaPoller {
  private readonly store: UnlockStore;
  private readonly tanji: TanjiUnlockPort;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly logger: UnlockLogger;
  private timer: NodeJS.Timeout | null = null;
  private lastResult: QuotaPollResult | null = null;

  constructor(opts: QuotaPollerOptions) {
    this.store = opts.store;
    this.tanji = opts.tanji;
    this.now = opts.now ?? (() => new Date());
    this.pollMs = Math.max(10_000, opts.pollMs ?? DEFAULT_QUOTA_POLL_MS);
    this.logger = opts.logger ?? { info() {}, warn() {}, error() {} };
  }

  get last(): QuotaPollResult | null {
    return this.lastResult;
  }

  /** 拉一次额度并落库；检测恢复自动唤醒 waiting_quota */
  async pollOnce(): Promise<QuotaPollResult> {
    const now = this.now();
    const result: QuotaPollResult = {
      observed: false,
      observedAt: null,
      recovered: false,
      recoveryReason: null,
      resumed: 0,
      dailyRemaining: null,
      monthlyRemaining: null,
      errorCode: null,
    };
    let status: TanjiStatus;
    try {
      status = await this.tanji.getStatus();
    } catch (err) {
      result.errorCode = err instanceof LeadError ? err.code : 'INTERNAL_ERROR';
      this.logger.warn('quota poll failed', { errorCode: result.errorCode, err: err instanceof Error ? err.message : String(err) });
      this.lastResult = result;
      return result;
    }
    const snapshot = quotaObservationFromStatus(status, now);
    if (!snapshot) {
      result.errorCode = 'NO_QUOTA_IN_STATUS';
      this.logger.warn('quota poll: status has no quota block');
      this.lastResult = result;
      return result;
    }
    const previous = await this.store.latestQuotaObservation();
    await this.store.insertQuotaObservation(snapshot);
    result.observed = true;
    result.observedAt = snapshot.observedAt;
    result.dailyRemaining = snapshot.dailyRemaining;
    result.monthlyRemaining = snapshot.monthlyRemaining;

    const recovery = detectQuotaRecovery(previous, snapshot);
    if (recovery.recovered) {
      result.recovered = true;
      result.recoveryReason = recovery.reason;
      result.resumed = await this.store.wakeWaitingQuota({ now });
      this.logger.info('quota recovered, unlock queue resumed', {
        reason: recovery.reason,
        resumed: result.resumed,
        dailyRemaining: snapshot.dailyRemaining,
        monthlyRemaining: snapshot.monthlyRemaining,
      });
    }
    this.lastResult = result;
    return result;
  }

  /** 后台常驻轮询（进程内 timer，unref 不阻塞退出） */
  start(): void {
    if (this.timer) return;
    const run = (): void => {
      void this.pollOnce().catch((err: unknown) => this.logger.error('quota poller tick failed', { err: String(err) }));
    };
    run(); // 启动立即拉一次
    this.timer = setInterval(run, this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.info('quota poller started', { pollMs: this.pollMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** 便捷函数：单次额度轮询（测试/手动 /v1/quota/refresh 用） */
export async function pollQuotaOnce(
  store: UnlockStore,
  tanji: TanjiUnlockPort,
  opts: { now?: () => Date; logger?: UnlockLogger } = {},
): Promise<QuotaPollResult> {
  const poller = new QuotaPoller({ store, tanji, now: opts.now, logger: opts.logger });
  return poller.pollOnce();
}

/** 观测时间（便于日志） */
export function quotaNowIso(): string {
  return nowIso();
}
