/**
 * F2 `Repositories` → `PipelineRepos` 端口归一（测试侧）。
 *
 * **为什么需要**：`src/pipeline/ports.ts` 的端口契约与 F2 repositories 实现存在少量形状差异，
 * 生产侧 `src/pipeline/wiring.ts` 负责归一（见 ports.ts 顶部注释）。测试侧在 wiring 尚未落地前
 * 用本 helper 做同样的归一，保证 e2e 能跑；wiring 落地后应改为直接复用生产 wiring。
 *
 * 已发现的差异（发现生产 bug 请报告 Lead，不要改 src）：
 *  1. `companies.findByNormalizedName()`：端口语义为返回 `Company | null`（orchestrator 用 `if (!company)`），
 *     而 F2 返回 `Company[]`（空数组为 truthy）→ 会导致 orchestrator 拿到数组后 `company.id` 为
 *     undefined，写入 company_sources 时 `NOT NULL constraint failed: company_sources.company_id`。
 *     归一：优先使用 F2 的 `findFirstByNormalizedName()`，否则取数组首元素。
 *  2. `goals.setEnabled()` / `runs.updateStatus()` 等返回记录而非 void：运行期无影响，仅类型差异。
 *
 * 其余端口（jobs.enqueue / sourceQueries.create / snapshots.writeText / sourceHealth.get /
 * regions.* / changeEvents.append 等）形状已核对兼容。
 */
import type { Repositories } from '../../src/repositories/index.js';
import type { PipelineRepos } from '../../src/pipeline/ports.js';
import type { Company } from '../../src/shared/domain.js';

type AsyncOrSync<T> = T | Promise<T>;

interface FindByNormalizedNameRepo {
  findByNormalizedName(normalizedName: string, opts?: { province?: string; city?: string }): Company[];
  findFirstByNormalizedName?(normalizedName: string, opts?: { province?: string; city?: string }): Company | null;
}

/** 把 F2 repositories 归一成 pipeline 端口（浅包装，不改动原仓库实例） */
export function normalizeRepositoriesForPorts(repos: Repositories): PipelineRepos {
  const rawCompanies = repos.companies as unknown as FindByNormalizedNameRepo;

  const companiesProxy = new Proxy(repos.companies as unknown as Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      if (prop === 'findByNormalizedName') {
        return (normalizedName: string, opts?: { province?: string; city?: string }): AsyncOrSync<Company | null> => {
          if (typeof rawCompanies.findFirstByNormalizedName === 'function') {
            return rawCompanies.findFirstByNormalizedName(normalizedName, opts);
          }
          const rows = rawCompanies.findByNormalizedName(normalizedName, opts);
          return rows[0] ?? null;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(repos.companies) : value;
    },
  });

  const normalized: Record<string, unknown> = {
    ...(repos as unknown as Record<string, unknown>),
    companies: companiesProxy,
  };
  // 保持别名一致
  normalized.pipelineJobs = repos.jobs;
  normalized.goalRuns = repos.runs;
  normalized.rawSnapshots = repos.snapshots;
  normalized.customsProfiles = repos.customs;
  return normalized as unknown as PipelineRepos;
}
