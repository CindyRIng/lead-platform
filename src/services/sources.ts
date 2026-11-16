/**
 * 来源健康服务（FR-9 `GET /v1/sources`）：读取/刷新 source_health。
 *
 * - 数据来源：`source_health` 表（各 adapter / region sync / worker 写入）；
 * - `refreshSourceHealth` 主动探测四个采集源的 /v1/status 并落库（tanji/fuma 由各自模块维护）。
 */
import { SOURCE_LABELS } from '../shared/constants.js';
import type { AllPlatform, Platform, SourceHealth } from '../shared/domain.js';
import { nowIso } from '../shared/time.js';
import type { SourceHealthPort } from '../pipeline/ports.js';
import type { RecruitmentSource, AliSource, MicSource } from '../adapters/sources/types.js';
import { getServiceContext, type ServiceContext } from './context.js';

export interface SourceHealthView extends SourceHealth {
  label: string;
}

export interface SourceServiceDeps {
  sourceHealth: SourceHealthPort;
  adapters?: Partial<{ boss: RecruitmentSource; zhilian: RecruitmentSource; ali: AliSource; mic: MicSource }>;
  now?: () => Date;
}

const ADAPTER_PLATFORMS: Platform[] = ['boss', 'zhilian', 'ali', 'mic'];

function fillLabel(health: SourceHealth): SourceHealthView {
  const label = (SOURCE_LABELS as Record<string, string>)[health.platform] ?? health.platform;
  return { ...health, label };
}

function defaultHealth(platform: AllPlatform): SourceHealth {
  return {
    platform,
    state: 'unavailable',
    loggedIn: null,
    expiresAt: null,
    checkedAt: nowIso(),
    consecutiveFailures: 0,
    detail: { checked: false },
  };
}

export function createSourceService(deps: SourceServiceDeps) {
  const now = deps.now ?? (() => new Date());

  async function listSources(): Promise<SourceHealthView[]> {
    let rows: SourceHealth[] = [];
    try {
      rows = (await deps.sourceHealth.listAll()) ?? [];
    } catch {
      rows = [];
    }
    const byPlatform = new Map(rows.map((r) => [r.platform, r]));
    const result: SourceHealthView[] = [];
    for (const platform of ADAPTER_PLATFORMS) {
      const row = byPlatform.get(platform);
      result.push(fillLabel(row ?? { ...defaultHealth(platform), checkedAt: now().toISOString() }));
      byPlatform.delete(platform);
    }
    // tanji / fuma 等由其它模块写入的行原样透出
    for (const row of byPlatform.values()) result.push(fillLabel(row));
    return result;
  }

  async function getSourceHealth(platform: AllPlatform): Promise<SourceHealthView | null> {
    const row = await deps.sourceHealth.get(platform);
    return row ? fillLabel(row) : null;
  }

  async function refreshSourceHealth(platforms?: Platform[]): Promise<SourceHealthView[]> {
    const targets = platforms ?? ADAPTER_PLATFORMS;
    for (const platform of targets) {
      const adapter = deps.adapters?.[platform];
      if (!adapter) continue;
      try {
        const status = await adapter.getStatus();
        await deps.sourceHealth.upsert({
          platform,
          state: status.state,
          loggedIn: status.loggedIn,
          expiresAt: status.expiresAt,
          checkedAt: status.checkedAt,
          consecutiveFailures: status.state === 'ok' ? 0 : 1,
          detail: status.detail,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await deps.sourceHealth.upsert({
            platform,
            state: 'unavailable',
            loggedIn: null,
            expiresAt: null,
            checkedAt: now().toISOString(),
            consecutiveFailures: 1,
            detail: { error: message },
          });
        } catch {
          // 健康状态写入失败不阻塞状态查询
        }
      }
    }
    return listSources();
  }

  return { listSources, getSourceHealth, refreshSourceHealth };
}

export type SourceService = ReturnType<typeof createSourceService>;

let defaultService: SourceService | null = null;

function service(): SourceService {
  if (!defaultService) {
    const ctx: ServiceContext = getServiceContext();
    defaultService = createSourceService({
      sourceHealth: ctx.repos.sourceHealth,
      adapters: ctx.adapters,
      now: ctx.now,
    });
  }
  return defaultService;
}

export function resetSourceService(): void {
  defaultService = null;
}

export const listSources = (): Promise<SourceHealthView[]> => service().listSources();
export const getSourceHealth = (platform: AllPlatform): Promise<SourceHealthView | null> => service().getSourceHealth(platform);
export const refreshSourceHealth = (platforms?: Platform[]): Promise<SourceHealthView[]> => service().refreshSourceHealth(platforms);
