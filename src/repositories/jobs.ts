/**
 * pipeline_jobs 表（流水线任务队列）
 *
 * 关键语义（docs/02 §7.3、§13）：
 * - 唯一键 (company_id, stage, COALESCE(platform,''))，入队幂等
 * - 原子领取：pending 且 next_retry_at 到期；或 running 且租约过期（进程崩溃恢复）
 * - 领取时 attempts+1；失败按指数退避（1s/5s/30s）回 pending，超过 max_attempts 或不可重试 → dead
 * - waiting_quota 不计失败次数（领取时的 +1 会撤销）
 */
import { LeadError } from '../shared/errors.js';
import { newJobId } from '../shared/ids.js';
import { isoPlusSeconds, nowIso } from '../shared/time.js';
import { all, countRows, one, run, toDate, toIso, type DbConnection } from './sql.js';
import type {
  ClaimByIdOptions,
  ClaimNextOptions,
  EnqueueResult,
  FailJobOptions,
  JobListOptions,
  JobStats,
  NewPipelineJob,
  PipelineJob,
} from './types.js';
import type { JobStatus, Platform, Stage } from '../shared/domain.js';

interface PipelineJobRow {
  id: string;
  company_id: string;
  platform: string | null;
  run_id: string | null;
  stage: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapJob(row: PipelineJobRow): PipelineJob {
  return {
    id: row.id,
    companyId: row.company_id,
    platform: (row.platform as Platform | null) ?? null,
    runId: row.run_id,
    stage: row.stage as Stage,
    status: row.status as JobStatus,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    nextRetryAt: row.next_retry_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TERMINAL_STATUSES: JobStatus[] = ['done', 'failed', 'dead', 'cancelled'];
const RETRY_BACKOFF_SEC = [1, 5, 30];

export interface PipelineJobsRepositoryOptions {
  leaseSec?: number;
  maxAttempts?: number;
}

export interface EnqueueInput extends NewPipelineJob {
  /** 已存在且为终态时是否复位为 pending（刷新任务的重复入队用） */
  resetExisting?: boolean;
}

export class PipelineJobsRepository {
  private readonly defaultLeaseSec: number;
  private readonly defaultMaxAttempts: number;

  constructor(
    private readonly db: DbConnection,
    opts: PipelineJobsRepositoryOptions = {},
  ) {
    this.defaultLeaseSec = opts.leaseSec ?? 60;
    this.defaultMaxAttempts = opts.maxAttempts ?? 3;
  }

  // -------------------------------------------------------------------------
  // 入队
  // -------------------------------------------------------------------------

  findByIdentity(companyId: string, stage: Stage, platform: Platform | null = null): PipelineJob | null {
    const row = one<PipelineJobRow>(
      this.db,
      `SELECT * FROM pipeline_jobs
       WHERE company_id = ? AND stage = ? AND COALESCE(platform,'') = ?`,
      [companyId, stage, platform ?? ''],
    );
    return row ? mapJob(row) : null;
  }

  enqueue(input: EnqueueInput): EnqueueResult {
    return this.db.transaction(() => {
      const existing = this.findByIdentity(input.companyId, input.stage, input.platform ?? null);
      const now = nowIso();
      if (existing) {
        if (input.resetExisting && TERMINAL_STATUSES.includes(existing.status)) {
          run(
            this.db,
            `UPDATE pipeline_jobs SET status = 'pending', attempts = 0, next_retry_at = ?,
               lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
             WHERE id = ?`,
            [input.nextRetryAt ?? null, now, existing.id],
          );
          return { job: this.requireById(existing.id), created: false };
        }
        return { job: existing, created: false };
      }
      const id = input.id ?? newJobId();
      run(
        this.db,
        `INSERT INTO pipeline_jobs(
          id, company_id, platform, run_id, stage, status, attempts, max_attempts,
          next_retry_at, lease_owner, lease_until, last_error, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.companyId,
          input.platform ?? null,
          input.runId ?? null,
          input.stage,
          input.status ?? 'pending',
          input.attempts ?? 0,
          input.maxAttempts ?? this.defaultMaxAttempts,
          input.nextRetryAt ?? null,
          null,
          null,
          null,
          input.createdAt ?? now,
          now,
        ],
      );
      return { job: this.requireById(id), created: true };
    });
  }

  /** 批量入队（单事务，幂等） */
  enqueueMany(inputs: EnqueueInput[]): EnqueueResult[] {
    if (inputs.length === 0) return [];
    return this.db.transaction(() => inputs.map((input) => this.enqueue(input)));
  }

  getById(id: string): PipelineJob | null {
    const row = one<PipelineJobRow>(this.db, 'SELECT * FROM pipeline_jobs WHERE id = ?', [id]);
    return row ? mapJob(row) : null;
  }

  // -------------------------------------------------------------------------
  // 领取 / 租约
  // -------------------------------------------------------------------------

  /**
   * 原子领取下一条任务：
   * - pending 且 (next_retry_at IS NULL OR <= now)
   * - 或 running 且租约过期（reclaimExpired，默认 true）
   * - 领取时 attempts+1，写 lease_owner/lease_until，清 next_retry_at
   */
  claimNext(opts: ClaimNextOptions): PipelineJob | null {
    const now = toDate(opts.now);
    const nowIsoStr = now.toISOString();
    const leaseSec = opts.leaseSec ?? this.defaultLeaseSec;
    const leaseUntil = isoPlusSeconds(leaseSec, now);
    const stages = opts.stages ?? (opts.stage ? [opts.stage] : undefined);
    const reclaim = opts.reclaimExpired !== false;

    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.platform !== undefined) {
      where.push("COALESCE(platform,'') = ?");
      params.push(opts.platform ?? '');
    }
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (stages && stages.length > 0) {
      where.push(`stage IN (${stages.map(() => '?').join(',')})`);
      params.push(...stages);
    }
    const claimable = reclaim
      ? `((status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?))
          OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ?))`
      : `(status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?))`;
    const claimableParams = reclaim ? [nowIsoStr, nowIsoStr] : [nowIsoStr];
    const whereSql = where.length ? ` AND ${where.join(' AND ')}` : '';

    const row = one<PipelineJobRow>(
      this.db,
      `UPDATE pipeline_jobs
       SET status = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1,
           next_retry_at = NULL, updated_at = ?
       WHERE id = (
         SELECT id FROM pipeline_jobs
         WHERE ${claimable}${whereSql}
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )
       RETURNING *`,
      [opts.workerId, leaseUntil, nowIsoStr, ...claimableParams, ...params],
    );
    return row ? mapJob(row) : null;
  }

  /** 按 id 原子领取（优先级队列：应用层排序后指定领取） */
  claimById(id: string, opts: ClaimByIdOptions): PipelineJob | null {
    const now = toDate(opts.now);
    const nowIsoStr = now.toISOString();
    const leaseSec = opts.leaseSec ?? this.defaultLeaseSec;
    const row = one<PipelineJobRow>(
      this.db,
      `UPDATE pipeline_jobs
       SET status = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1,
           next_retry_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
       RETURNING *`,
      [opts.workerId, isoPlusSeconds(leaseSec, now), nowIsoStr, id, nowIsoStr],
    );
    return row ? mapJob(row) : null;
  }

  /** 续租（worker 长任务） */
  renewLease(
    id: string,
    opts: { workerId?: string; leaseSec?: number; now?: Date | string } = {},
  ): PipelineJob | null {
    const now = toDate(opts.now);
    const leaseSec = opts.leaseSec ?? this.defaultLeaseSec;
    const where = opts.workerId ? 'AND lease_owner = ?' : '';
    const params: unknown[] = [isoPlusSeconds(leaseSec, now), now.toISOString(), id];
    if (opts.workerId) params.push(opts.workerId);
    const result = run(
      this.db,
      `UPDATE pipeline_jobs SET lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'running' ${where}`,
      params,
    );
    return result.changes > 0 ? this.getById(id) : null;
  }

  /** 回收过期租约（不领取；供巡检/状态页用） */
  resetExpiredLeases(now: Date | string = new Date()): number {
    return run(
      this.db,
      `UPDATE pipeline_jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
      [toIso(now), toIso(now)],
    ).changes;
  }

  // -------------------------------------------------------------------------
  // 状态迁移
  // -------------------------------------------------------------------------

  complete(id: string): PipelineJob | null {
    const now = nowIso();
    const result = run(
      this.db,
      `UPDATE pipeline_jobs SET status = 'done', lease_owner = NULL, lease_until = NULL,
         next_retry_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('pending','running','waiting_quota')`,
      [now, id],
    );
    return result.changes > 0 ? this.getById(id) : null;
  }

  /**
   * 失败：attempts >= max_attempts 或 retryable===false 或显式 nextRetryAt:null → dead；
   * 否则回 pending + next_retry_at（默认按 1s/5s/30s 退避）
   */
  fail(id: string, opts: FailJobOptions): PipelineJob | null {
    const current = this.getById(id);
    if (!current) return null;
    const now = toDate(opts.now);
    const message = opts.error ?? opts.message ?? 'job failed';
    const hasExplicitNext = Object.prototype.hasOwnProperty.call(opts, 'nextRetryAt');
    const attempts = current.attempts;
    let status: JobStatus;
    if (attempts >= current.maxAttempts || opts.retryable === false || (hasExplicitNext && opts.nextRetryAt === null)) {
      status = 'dead';
    } else {
      status = 'pending';
    }
    let nextRetryAt: string | null = null;
    if (status === 'pending') {
      if (hasExplicitNext && opts.nextRetryAt) {
        nextRetryAt = opts.nextRetryAt;
      } else {
        const idx = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_SEC.length - 1);
        nextRetryAt = isoPlusSeconds(RETRY_BACKOFF_SEC[idx] ?? 30, now);
      }
    }
    const lastError = opts.errorCode ? `${opts.errorCode}: ${message}` : message;
    run(
      this.db,
      `UPDATE pipeline_jobs SET status = ?, next_retry_at = ?, lease_owner = NULL, lease_until = NULL,
         last_error = ?, updated_at = ? WHERE id = ?`,
      [status, nextRetryAt, lastError, now.toISOString(), id],
    );
    return this.getById(id);
  }

  /** 额度耗尽：waiting_quota（撤销领取时的 attempts+1，不计失败次数） */
  waitForQuota(id: string, opts: { reason?: string; now?: Date } = {}): PipelineJob | null {
    const current = this.getById(id);
    if (!current) return null;
    const now = toIso(opts.now);
    const nextAttempts = Math.max(0, current.attempts - 1);
    run(
      this.db,
      `UPDATE pipeline_jobs SET status = 'waiting_quota', attempts = ?, next_retry_at = NULL,
         lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
      [nextAttempts, opts.reason ?? 'QUOTA_EXHAUSTED', now, id],
    );
    return this.getById(id);
  }

  /** 额度恢复后批量唤醒（保持 FIFO 顺序） */
  wakeWaitingQuota(opts: { limit?: number; now?: Date; stage?: Stage } = {}): number {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
    const now = toIso(opts.now);
    const stageSql = opts.stage ? 'AND stage = ?' : '';
    const params: unknown[] = [now];
    if (opts.stage) params.push(opts.stage);
    params.push(limit);
    return run(
      this.db,
      `UPDATE pipeline_jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id IN (
         SELECT id FROM pipeline_jobs WHERE status = 'waiting_quota' ${stageSql}
         ORDER BY created_at ASC LIMIT ?
       )`,
      params,
    ).changes;
  }

  /** 复位为 pending（手动 retry / 刷新任务重复使用） */
  retry(id: string, opts: { resetAttempts?: boolean; nextRetryAt?: string | null } = {}): PipelineJob | null {
    const current = this.getById(id);
    if (!current) return null;
    const resetAttempts = opts.resetAttempts !== false;
    run(
      this.db,
      `UPDATE pipeline_jobs SET status = 'pending', attempts = ?, next_retry_at = ?,
         lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      [resetAttempts ? 0 : current.attempts, opts.nextRetryAt ?? null, nowIso(), id],
    );
    return this.getById(id);
  }

  cancel(id: string): PipelineJob | null {
    const result = run(
      this.db,
      `UPDATE pipeline_jobs SET status = 'cancelled', lease_owner = NULL, lease_until = NULL,
         next_retry_at = NULL, updated_at = ? WHERE id = ?`,
      [nowIso(), id],
    );
    return result.changes > 0 ? this.getById(id) : null;
  }

  cancelByCompany(companyId: string, stages?: Stage[]): number {
    const stageSql = stages && stages.length ? `AND stage IN (${stages.map(() => '?').join(',')})` : '';
    return run(
      this.db,
      `UPDATE pipeline_jobs SET status = 'cancelled', lease_owner = NULL, lease_until = NULL,
         next_retry_at = NULL, updated_at = ?
       WHERE company_id = ? AND status IN ('pending','running','waiting_quota') ${stageSql}`,
      [nowIso(), companyId, ...(stages ?? [])],
    ).changes;
  }

  // -------------------------------------------------------------------------
  // 查询 / 统计
  // -------------------------------------------------------------------------

  list(opts: JobListOptions = {}): PipelineJob[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status !== undefined) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (opts.stage !== undefined) {
      const stages = Array.isArray(opts.stage) ? opts.stage : [opts.stage];
      where.push(`stage IN (${stages.map(() => '?').join(',')})`);
      params.push(...stages);
    }
    if (opts.companyId) {
      where.push('company_id = ?');
      params.push(opts.companyId);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts.platform) {
      where.push('platform = ?');
      params.push(opts.platform);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const offset = Math.max(0, opts.offset ?? 0);
    return all<PipelineJobRow>(
      this.db,
      `SELECT * FROM pipeline_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map(mapJob);
  }

  listByCompany(companyId: string): PipelineJob[] {
    return this.list({ companyId, limit: 1000 });
  }

  /** FIFO：可执行（pending 且到期）的任务 */
  listFifo(opts: { stage?: Stage; stages?: Stage[]; limit?: number; now?: Date } = {}): PipelineJob[] {
    const now = toIso(opts.now);
    const stages = opts.stages ?? (opts.stage ? [opts.stage] : undefined);
    const stageSql = stages && stages.length ? `AND stage IN (${stages.map(() => '?').join(',')})` : '';
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    return all<PipelineJobRow>(
      this.db,
      `SELECT * FROM pipeline_jobs
       WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?) ${stageSql}
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [now, ...(stages ?? []), limit],
    ).map(mapJob);
  }

  listRunning(limit = 100): PipelineJob[] {
    return this.list({ status: 'running', limit });
  }

  countDue(stages?: Stage[], now: Date = new Date()): number {
    const stageSql = stages && stages.length ? `AND stage IN (${stages.map(() => '?').join(',')})` : '';
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM pipeline_jobs
       WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?) ${stageSql}`,
      [now.toISOString(), ...(stages ?? [])],
    );
  }

  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all<{ status: string; n: number }>(
      this.db,
      'SELECT status, COUNT(*) AS n FROM pipeline_jobs GROUP BY status',
    )) {
      out[row.status] = Number(row.n);
    }
    return out;
  }

  /** 状态页用：与 /v1/status.queue 对齐的汇总 */
  stats(): JobStats {
    const byStatus = this.countByStatus();
    return {
      pending: byStatus.pending ?? 0,
      running: byStatus.running ?? 0,
      waitingQuota: byStatus.waiting_quota ?? 0,
      done: byStatus.done ?? 0,
      failed: byStatus.failed ?? 0,
      dead: byStatus.dead ?? 0,
      cancelled: byStatus.cancelled ?? 0,
    };
  }

  countByStage(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const row of all<{ stage: string; status: string; n: number }>(
      this.db,
      'SELECT stage, status, COUNT(*) AS n FROM pipeline_jobs GROUP BY stage, status',
    )) {
      const stage = (out[row.stage] ??= {});
      stage[row.status] = Number(row.n);
    }
    return out;
  }

  /** 某阶段 pending/running 数（refresh worker 状态用） */
  countByStageStatus(stage: Stage, statuses: JobStatus[]): number {
    if (statuses.length === 0) return 0;
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM pipeline_jobs WHERE stage = ? AND status IN (${statuses.map(() => '?').join(',')})`,
      [stage, ...statuses],
    );
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM pipeline_jobs');
  }

  private requireById(id: string): PipelineJob {
    const job = this.getById(id);
    if (!job) throw new LeadError('NOT_FOUND', `pipeline job not found: ${id}`);
    return job;
  }
}
