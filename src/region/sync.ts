/**
 * 区域字典同步（启动时 + 每日 03:00 Asia/Shanghai）。
 *
 * 数据来源（docs/04 §4.1）：
 * - Boss：GET /v1/cities?refresh=true → 374 城（可能无 province，按名称匹配内置基线）
 * - 智联：GET /v1/cities → 492 条（30 省 + 461 市；河北 11 市 code 565–575）
 * - Ali：GET /v1/regions → 373 条（code CN-13 / CN-13-1301，nameZh/nameEn/aliases）
 * - Mic：GET /api/regions（32 省英文 api_value）+ GET /api/regions?province=Hebei（河北 11 市）
 *
 * 失败策略：单个来源失败不影响其它来源；失败回退内置基线并写 source_health（degraded/unavailable）。
 */
import type { Platform, SourceHealth } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { nowIso, shanghaiParts } from '../shared/time.js';
import type { SourceAdapterRegistry } from '../adapters/sources/types.js';
import type { SourceHealthPort } from '../pipeline/ports.js';
import { RegionRegistry, type PlatformRegionInput, type RegionSyncResult } from './registry.js';

export interface RegionSyncDeps {
  registry: RegionRegistry;
  adapters: Partial<Pick<SourceAdapterRegistry, 'boss' | 'zhilian' | 'ali' | 'mic'>>;
  sourceHealth?: SourceHealthPort;
  logger?: { info?: (msg: string, meta?: Record<string, unknown>) => void; warn?: (msg: string, meta?: Record<string, unknown>) => void } | null;
  now?: () => string;
}

export interface RegionSyncFailure {
  platform: Platform;
  errorCode: string;
  message: string;
}

export interface RegionSyncSummary {
  startedAt: string;
  finishedAt: string;
  results: RegionSyncResult[];
  failed: RegionSyncFailure[];
  /** 同步失败后各平台是否已回退内置基线（内置基线始终可用） */
  fallback: Record<string, boolean>;
}

async function recordSyncFailure(deps: RegionSyncDeps, platform: Platform, err: unknown): Promise<void> {
  if (!deps.sourceHealth) return;
  const lead = err instanceof LeadError ? err : new LeadError('SOURCE_UNAVAILABLE', err instanceof Error ? err.message : String(err));
  try {
    const existing = (await deps.sourceHealth.get(platform)) as SourceHealth | null;
    const now = deps.now?.() ?? nowIso();
    const state: SourceHealth['state'] =
      lead.code === 'SOURCE_SESSION_INVALID'
        ? 'session_invalid'
        : lead.code === 'SOURCE_VERIFICATION_PENDING'
          ? 'verification_pending'
          : existing && existing.state !== 'ok'
            ? existing.state
            : 'degraded';
    const previousDetail = (existing?.detail ?? {}) as Record<string, unknown>;
    await deps.sourceHealth.upsert({
      platform,
      state,
      loggedIn: existing?.loggedIn ?? null,
      expiresAt: existing?.expiresAt ?? null,
      checkedAt: now,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      detail: {
        ...previousDetail,
        regionSyncFailedAt: now,
        regionSyncErrorCode: lead.code,
        regionSyncErrorMessage: lead.message,
      },
    });
  } catch {
    // 状态写入失败不阻塞同步流程
  }
}

async function recordSyncSuccess(deps: RegionSyncDeps, platform: Platform, result: RegionSyncResult): Promise<void> {
  if (!deps.sourceHealth) return;
  try {
    const existing = (await deps.sourceHealth.get(platform)) as SourceHealth | null;
    if (!existing) return;
    const now = deps.now?.() ?? nowIso();
    const detail = { ...((existing.detail ?? {}) as Record<string, unknown>), lastRegionSyncAt: now, regionSyncMatched: result.matched, regionSyncUnmatched: result.unmatched };
    await deps.sourceHealth.upsert({
      platform,
      state: existing.state,
      loggedIn: existing.loggedIn,
      expiresAt: existing.expiresAt,
      checkedAt: existing.checkedAt ?? now,
      consecutiveFailures: existing.consecutiveFailures ?? 0,
      detail,
    });
  } catch {
    // ignore
  }
}

async function syncPlatform(deps: RegionSyncDeps, platform: Platform): Promise<RegionSyncResult> {
  const entries: PlatformRegionInput[] = [];
  if (platform === 'boss' || platform === 'zhilian') {
    const adapter = deps.adapters[platform];
    if (!adapter) throw new LeadError('UNSUPPORTED', `未配置 ${platform} 适配器`);
    const regions = await adapter.listRegions();
    for (const r of regions) {
      entries.push({
        platform,
        level: r.level,
        platformValue: r.platformValue,
        nameZh: r.nameZh,
        nameEn: r.nameEn,
        parentCode: r.parentCode,
      });
    }
  } else if (platform === 'ali') {
    const adapter = deps.adapters.ali;
    if (!adapter) throw new LeadError('UNSUPPORTED', '未配置 ali 适配器');
    const regions = await adapter.listRegions();
    for (const r of regions) {
      entries.push({
        platform,
        level: r.level,
        platformValue: r.platformValue,
        nameZh: r.nameZh,
        nameEn: r.nameEn,
        parentCode: r.parentCode,
      });
    }
  } else {
    const adapter = deps.adapters.mic;
    if (!adapter) throw new LeadError('UNSUPPORTED', '未配置 mic 适配器');
    const provinces = await adapter.listRegions();
    for (const r of provinces) {
      entries.push({ platform, level: r.level, platformValue: r.platformValue, nameZh: r.nameZh, nameEn: r.nameEn, parentCode: r.parentCode });
    }
    // 河北省城市（其余省 cities_complete=false，一期只跑河北）
    const hebeiCities = await adapter.listRegions('Hebei');
    for (const r of hebeiCities) {
      if (r.level !== 'city') continue;
      entries.push({ platform, level: r.level, platformValue: r.platformValue, nameZh: r.nameZh, nameEn: r.nameEn, parentCode: r.parentCode });
    }
  }
  return deps.registry.ingestPlatformRegions(platform, entries);
}

/** 同步全部来源的区域字典；全部失败也不会抛错（返回汇总，内置基线兜底） */
export async function syncRegionDictionaries(deps: RegionSyncDeps): Promise<RegionSyncSummary> {
  const startedAt = deps.now?.() ?? nowIso();
  const platforms: Platform[] = ['boss', 'zhilian', 'ali', 'mic'];
  const results: RegionSyncResult[] = [];
  const failed: RegionSyncFailure[] = [];
  const fallback: Record<string, boolean> = {};
  await deps.registry.ensureBaseline();
  for (const platform of platforms) {
    try {
      const result = await syncPlatform(deps, platform);
      results.push(result);
      fallback[platform] = false;
      deps.logger?.info?.('region.sync.ok', { platform, matched: result.matched, unmatched: result.unmatched, mappings: result.mappings });
      await recordSyncSuccess(deps, platform, result);
    } catch (err) {
      const lead = err instanceof LeadError ? err : new LeadError('SOURCE_UNAVAILABLE', err instanceof Error ? err.message : String(err));
      failed.push({ platform, errorCode: lead.code, message: lead.message });
      fallback[platform] = true;
      deps.logger?.warn?.('region.sync.failed', { platform, code: lead.code, message: lead.message });
      await recordSyncFailure(deps, platform, lead);
    }
  }
  return { startedAt, finishedAt: deps.now?.() ?? nowIso(), results, failed, fallback };
}

export interface RegionSyncLoopOptions {
  /** 每日触发时刻（Asia/Shanghai），默认 03:00 */
  hour?: number;
  minute?: number;
  /** 启动后是否立即同步一次，默认 true */
  runOnStart?: boolean;
  /** 定时器注入（测试用） */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => Date;
}

export interface RegionSyncLoop {
  stop(): void;
  /** 下次计划触发时间（ISO） */
  nextRunAt(): string | null;
  /** 手动触发一次 */
  trigger(): Promise<RegionSyncSummary>;
}

/** 计算下一个 Asia/Shanghai hh:mm 距现在毫秒数 */
export function msUntilNextLocalTime(hour: number, minute: number, now = new Date()): number {
  const parts = shanghaiParts(now);
  const targetToday = Date.UTC(parts.y, parts.m - 1, parts.day, hour - 8, minute, 0, 0); // Asia/Shanghai = UTC+8
  let delta = targetToday - now.getTime();
  if (delta <= 0) delta += 86_400_000;
  return delta;
}

/** 启动每日区域字典同步循环（启动时先同步一次；失败不阻塞服务启动） */
export function startRegionSyncLoop(deps: RegionSyncDeps, opts?: RegionSyncLoopOptions): RegionSyncLoop {
  const hour = opts?.hour ?? 3;
  const minute = opts?.minute ?? 0;
  const setTimer = opts?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts?.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: unknown = null;
  let nextAt: number | null = null;
  let running: Promise<RegionSyncSummary> | null = null;

  const schedule = (): void => {
    if (stopped) return;
    const delay = msUntilNextLocalTime(hour, minute, opts?.now?.() ?? new Date());
    nextAt = (opts?.now?.() ?? new Date()).getTime() + delay;
    timer = setTimer(() => {
      void trigger().finally(() => schedule());
    }, delay);
  };

  const trigger = async (): Promise<RegionSyncSummary> => {
    if (running) return running;
    running = syncRegionDictionaries(deps).finally(() => {
      running = null;
    });
    return running;
  };

  if (opts?.runOnStart !== false) {
    void trigger().catch(() => undefined);
  }
  schedule();

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    nextRunAt(): string | null {
      return nextAt ? new Date(nextAt).toISOString() : null;
    },
    trigger,
  };
}
