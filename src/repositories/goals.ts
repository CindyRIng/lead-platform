/** goals 表（Goal CRUD + 乐观锁） */
import { DEFAULT_UNLOCK_POLICY } from '../shared/constants.js';
import { LeadError } from '../shared/errors.js';
import { newGoalId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { all, fromJson, fromJsonArray, fromJsonUnknown, one, run, toJson, type DbConnection } from './sql.js';
import type { GoalListOptions, GoalPatch, NewGoal } from './types.js';
import type { Goal, GoalRegion } from '../shared/domain.js';

interface GoalRow {
  id: string;
  name: string;
  region_province: string;
  region_province_code: string | null;
  city_codes: string;
  platforms: string;
  keywords: string;
  max_leads_per_run: number | null;
  daily_lead_limit: number | null;
  schedule_cron: string;
  schedule_tz: string;
  time_window: string | null;
  priority: number;
  trade_filter: string | null;
  unlock_policy: string;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapGoal(row: GoalRow): Goal {
  const region: GoalRegion = {
    province: row.region_province,
    provinceCode: row.region_province_code ?? undefined,
    cityCodes: fromJsonArray<string>(row.city_codes),
  };
  return {
    id: row.id,
    name: row.name,
    region,
    platforms: fromJsonArray<Goal['platforms'][number]>(row.platforms),
    keywords: fromJson<Goal['keywords']>(row.keywords, {}),
    maxLeadsPerRun: row.max_leads_per_run,
    dailyLeadLimit: row.daily_lead_limit,
    schedule: { cron: row.schedule_cron, timeZone: row.schedule_tz, timeWindow: row.time_window },
    priority: row.priority,
    tradeFilter: fromJsonUnknown(row.trade_filter, null),
    unlockPolicy: fromJson<Goal['unlockPolicy']>(row.unlock_policy, {
      mode: 'priority',
      order: DEFAULT_UNLOCK_POLICY.order,
    }),
    enabled: row.enabled !== 0,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GoalsRepository {
  constructor(private readonly db: DbConnection) {}

  create(input: NewGoal): Goal {
    const id = input.id ?? newGoalId();
    const now = nowIso();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const schedule = input.schedule ?? {};
    run(
      this.db,
      `INSERT INTO goals(
        id, name, region_province, region_province_code, city_codes, platforms, keywords,
        max_leads_per_run, daily_lead_limit, schedule_cron, schedule_tz, time_window,
        priority, trade_filter, unlock_policy, enabled, version, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.name,
        input.region.province,
        input.region.provinceCode ?? null,
        toJson(input.region.cityCodes ?? []),
        toJson(input.platforms),
        toJson(input.keywords),
        input.maxLeadsPerRun ?? null,
        input.dailyLeadLimit ?? null,
        schedule.cron ?? '0 2 * * *',
        schedule.timeZone ?? 'Asia/Shanghai',
        schedule.timeWindow ?? null,
        input.priority ?? 100,
        toJson(input.tradeFilter ?? null),
        toJson(
          input.unlockPolicy ?? { mode: DEFAULT_UNLOCK_POLICY.mode, order: DEFAULT_UNLOCK_POLICY.order },
        ),
        (input.enabled ?? true) ? 1 : 0,
        input.version ?? 1,
        createdAt,
        updatedAt,
      ],
    );
    return this.requireById(id);
  }

  getById(id: string): Goal | null {
    const row = one<GoalRow>(this.db, 'SELECT * FROM goals WHERE id = ?', [id]);
    return row ? mapGoal(row) : null;
  }

  list(opts: GoalListOptions = {}): Goal[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.enabled !== undefined) {
      where.push('enabled = ?');
      params.push(opts.enabled ? 1 : 0);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const sql = `SELECT * FROM goals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY priority ASC, created_at DESC LIMIT ? OFFSET ?`;
    return all<GoalRow>(this.db, sql, [...params, limit, offset]).map(mapGoal);
  }

  listEnabled(): Goal[] {
    return this.list({ enabled: true, limit: 500 });
  }

  /**
   * 局部更新（乐观锁）：
   * - expectedVersion 提供时 CAS 更新；失配 → CONFLICT / 不存在 → NOT_FOUND
   * - 未提供时按 id 更新；不存在 → NOT_FOUND
   * - version 总是 +1
   */
  update(id: string, patch: GoalPatch, opts: { expectedVersion?: number } = {}): Goal {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.region !== undefined) {
      push('region_province', patch.region.province);
      push('region_province_code', patch.region.provinceCode ?? null);
      push('city_codes', toJson(patch.region.cityCodes ?? []));
    }
    if (patch.platforms !== undefined) push('platforms', toJson(patch.platforms));
    if (patch.keywords !== undefined) push('keywords', toJson(patch.keywords));
    if (patch.maxLeadsPerRun !== undefined) push('max_leads_per_run', patch.maxLeadsPerRun);
    if (patch.dailyLeadLimit !== undefined) push('daily_lead_limit', patch.dailyLeadLimit);
    if (patch.schedule !== undefined) {
      push('schedule_cron', patch.schedule?.cron ?? '0 2 * * *');
      push('schedule_tz', patch.schedule?.timeZone ?? 'Asia/Shanghai');
      push('time_window', patch.schedule?.timeWindow ?? null);
    }
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (patch.tradeFilter !== undefined) push('trade_filter', toJson(patch.tradeFilter ?? null));
    if (patch.unlockPolicy !== undefined) push('unlock_policy', toJson(patch.unlockPolicy));
    if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0);

    const now = nowIso();
    sets.push('version = version + 1');
    sets.push('updated_at = ?');
    params.push(now);

    let sql = `UPDATE goals SET ${sets.join(', ')} WHERE id = ?`;
    params.push(id);
    if (opts.expectedVersion !== undefined) {
      sql += ' AND version = ?';
      params.push(opts.expectedVersion);
    }
    const result = run(this.db, sql, params);
    if (result.changes === 0) {
      const existing = this.getById(id);
      if (!existing) throw new LeadError('NOT_FOUND', `goal not found: ${id}`);
      throw new LeadError('CONFLICT', `goal version conflict: ${id}`, {
        details: { expectedVersion: opts.expectedVersion, currentVersion: existing.version },
      });
    }
    return this.requireById(id);
  }

  setEnabled(id: string, enabled: boolean): Goal {
    return this.update(id, { enabled });
  }

  delete(id: string): boolean {
    return run(this.db, 'DELETE FROM goals WHERE id = ?', [id]).changes > 0;
  }

  private requireById(id: string): Goal {
    const goal = this.getById(id);
    if (!goal) throw new LeadError('NOT_FOUND', `goal not found: ${id}`);
    return goal;
  }
}
