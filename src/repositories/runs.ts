/** goal_runs 表（Run 生命周期 / 统计 / 心跳 / 中断恢复） */
import { LeadError } from '../shared/errors.js';
import { newRunId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { all, countRows, fromJson, one, run, toJson, type DbConnection } from './sql.js';
import type { GoalRunListOptions, GoalRunPatch, GoalRunRecord, NewGoalRun } from './types.js';
import type { GoalRunStatus, RunStats } from '../shared/domain.js';

interface GoalRunRow {
  id: string;
  goal_id: string;
  trigger: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  stats: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

function mapRun(row: GoalRunRow): GoalRunRecord {
  return {
    id: row.id,
    goalId: row.goal_id,
    trigger: row.trigger as GoalRunRecord['trigger'],
    status: row.status as GoalRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stats: fromJson<RunStats>(row.stats, {}),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    heartbeatAt: row.heartbeat_at,
  };
}

/** 深合并 stats（平台/阶段子对象逐层合并，数组/标量整体替换） */
export function mergeStats(base: RunStats, patch: RunStats): RunStats {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = mergeStats(existing as RunStats, value as RunStats);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as RunStats;
}

export class GoalRunsRepository {
  constructor(private readonly db: DbConnection) {}

  create(input: NewGoalRun): GoalRunRecord {
    const id = input.id ?? newRunId();
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO goal_runs(
        id, goal_id, trigger, status, started_at, finished_at, stats, error_code, error_message, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.goalId,
        input.trigger,
        input.status ?? 'pending',
        input.startedAt ?? null,
        input.finishedAt ?? null,
        toJson(input.stats ?? {}),
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.createdAt ?? now,
      ],
    );
    return this.requireById(id);
  }

  getById(id: string): GoalRunRecord | null {
    const row = one<GoalRunRow>(this.db, 'SELECT * FROM goal_runs WHERE id = ?', [id]);
    return row ? mapRun(row) : null;
  }

  list(opts: GoalRunListOptions = {}): GoalRunRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.goalId) {
      where.push('goal_id = ?');
      params.push(opts.goalId);
    }
    if (opts.status !== undefined) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const sql = `SELECT * FROM goal_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return all<GoalRunRow>(this.db, sql, [...params, limit, offset]).map(mapRun);
  }

  listByGoal(goalId: string, limit = 20): GoalRunRecord[] {
    return this.list({ goalId, limit });
  }

  /** 该 Goal 是否已有未结束 Run（RUN_IN_PROGRESS 判定） */
  findActiveByGoal(goalId: string): GoalRunRecord | null {
    const row = one<GoalRunRow>(
      this.db,
      `SELECT * FROM goal_runs WHERE goal_id = ? AND status IN ('pending','running')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [goalId],
    );
    return row ? mapRun(row) : null;
  }

  hasActiveRun(goalId: string): boolean {
    return this.findActiveByGoal(goalId) !== null;
  }

  /** 进程重启后仍处于 pending/running 的 Run（恢复扫描用） */
  findInterrupted(): GoalRunRecord[] {
    return all<GoalRunRow>(
      this.db,
      `SELECT * FROM goal_runs WHERE status IN ('pending','running') ORDER BY created_at ASC`,
    ).map(mapRun);
  }

  listRunning(): GoalRunRecord[] {
    return all<GoalRunRow>(
      this.db,
      `SELECT * FROM goal_runs WHERE status = 'running' ORDER BY started_at ASC`,
    ).map(mapRun);
  }

  listRecent(limit = 20): GoalRunRecord[] {
    return this.list({ limit });
  }

  /** 通用局部更新 */
  update(id: string, patch: GoalRunPatch): GoalRunRecord {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.startedAt !== undefined) push('started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) push('finished_at', patch.finishedAt);
    if (patch.heartbeatAt !== undefined) push('heartbeat_at', patch.heartbeatAt);
    if (patch.stats !== undefined) push('stats', toJson(patch.stats));
    if (patch.errorCode !== undefined) push('error_code', patch.errorCode);
    if (patch.errorMessage !== undefined) push('error_message', patch.errorMessage);
    if (sets.length === 0) return this.requireById(id);
    const result = run(this.db, `UPDATE goal_runs SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    if (result.changes === 0) throw new LeadError('NOT_FOUND', `run not found: ${id}`);
    return this.requireById(id);
  }

  updateStatus(
    id: string,
    status: GoalRunStatus,
    patch: Omit<GoalRunPatch, 'status'> = {},
  ): GoalRunRecord {
    const extra: GoalRunPatch = { ...patch };
    if (extra.finishedAt === undefined && ['completed', 'partial', 'failed', 'cancelled'].includes(status)) {
      extra.finishedAt = nowIso();
    }
    if (extra.startedAt === undefined && status === 'running') {
      const current = this.getById(id);
      if (current && !current.startedAt) extra.startedAt = nowIso();
    }
    return this.update(id, { ...extra, status });
  }

  markRunning(id: string, startedAt: string = nowIso()): GoalRunRecord {
    return this.update(id, { status: 'running', startedAt });
  }

  updateStats(id: string, patch: RunStats): GoalRunRecord {
    return this.db.transaction(() => {
      const current = this.requireById(id);
      return this.update(id, { stats: mergeStats(current.stats, patch) });
    });
  }

  updateHeartbeat(id: string, at: string = nowIso()): GoalRunRecord {
    return this.update(id, { heartbeatAt: at });
  }

  /** 兼容命名 */
  heartbeat(id: string, at: string = nowIso()): GoalRunRecord {
    return this.updateHeartbeat(id, at);
  }

  finish(
    id: string,
    status: Extract<GoalRunStatus, 'completed' | 'partial' | 'failed' | 'cancelled'>,
    patch: Omit<GoalRunPatch, 'status'> = {},
  ): GoalRunRecord {
    return this.updateStatus(id, status, { finishedAt: nowIso(), ...patch });
  }

  countByStatus(): Record<string, number> {
    const rows = all<{ status: string; n: number }>(
      this.db,
      'SELECT status, COUNT(*) AS n FROM goal_runs GROUP BY status',
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = Number(row.n);
    return out;
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM goal_runs');
  }

  private requireById(id: string): GoalRunRecord {
    const runRow = this.getById(id);
    if (!runRow) throw new LeadError('NOT_FOUND', `run not found: ${id}`);
    return runRow;
  }
}
