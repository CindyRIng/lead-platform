/** source_queries 表（Run × 平台 × 城市 × 关键词 查询进度） */
import { LeadError } from '../shared/errors.js';
import { newQueryId } from '../shared/ids.js';
import { all, countRows, one, run, type DbConnection } from './sql.js';
import type {
  NewSourceQuery,
  SourceQueryProgress,
  SourceQueryRecord,
  SourceQueryStats,
  SourceQueryStatus,
} from './types.js';
import type { Platform } from '../shared/domain.js';

interface SourceQueryRow {
  id: string;
  run_id: string;
  platform: string;
  city_code: string;
  platform_region_value: string;
  keyword: string | null;
  upstream_query_id: string | null;
  status: string;
  pages_fetched: number;
  total_pages: number | null;
  total_count: number | null;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

function mapSourceQuery(row: SourceQueryRow): SourceQueryRecord {
  return {
    id: row.id,
    runId: row.run_id,
    platform: row.platform as Platform,
    cityCode: row.city_code,
    platformRegionValue: row.platform_region_value,
    keyword: row.keyword,
    upstreamQueryId: row.upstream_query_id,
    status: row.status as SourceQueryStatus,
    pagesFetched: Number(row.pages_fetched ?? 0),
    totalPages: row.total_pages,
    totalCount: row.total_count,
    lastError: row.last_error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface SourceQueryCreateResult {
  query: SourceQueryRecord;
  created: boolean;
}

export class SourceQueriesRepository {
  constructor(private readonly db: DbConnection) {}

  /**
   * 创建查询（幂等）：唯一键 (run_id, platform, platform_region_value, keyword)。
   * 注意 SQLite 唯一索引对 NULL 不生效，因此 keyword 为空时统一存 '' 以保证幂等。
   */
  create(input: NewSourceQuery): SourceQueryCreateResult {
    const keyword = input.keyword ?? null;
    const existing = this.findByKey(
      input.runId,
      input.platform,
      input.platformRegionValue,
      keyword,
    );
    if (existing) return { query: existing, created: false };
    const id = input.id ?? newQueryId();
    run(
      this.db,
      `INSERT INTO source_queries(
        id, run_id, platform, city_code, platform_region_value, keyword, upstream_query_id,
        status, pages_fetched, total_pages, total_count, last_error, started_at, finished_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.runId,
        input.platform,
        input.cityCode,
        input.platformRegionValue,
        keyword ?? '',
        input.upstreamQueryId ?? null,
        input.status ?? 'pending',
        input.pagesFetched ?? 0,
        input.totalPages ?? null,
        input.totalCount ?? null,
        input.lastError ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
      ],
    );
    const query = this.getById(id);
    if (!query) throw new LeadError('INTERNAL_ERROR', 'source query insert failed');
    return { query, created: true };
  }

  getById(id: string): SourceQueryRecord | null {
    const row = one<SourceQueryRow>(this.db, 'SELECT * FROM source_queries WHERE id = ?', [id]);
    return row ? mapSourceQuery(row) : null;
  }

  findByKey(
    runId: string,
    platform: Platform,
    platformRegionValue: string,
    keyword: string | null = null,
  ): SourceQueryRecord | null {
    const row = one<SourceQueryRow>(
      this.db,
      `SELECT * FROM source_queries
       WHERE run_id = ? AND platform = ? AND platform_region_value = ? AND COALESCE(keyword,'') = ?`,
      [runId, platform, platformRegionValue, keyword ?? ''],
    );
    return row ? mapSourceQuery(row) : null;
  }

  listByRun(runId: string): SourceQueryRecord[] {
    return all<SourceQueryRow>(
      this.db,
      'SELECT * FROM source_queries WHERE run_id = ? ORDER BY platform ASC, city_code ASC, id ASC',
      [runId],
    ).map(mapSourceQuery);
  }

  listByRunAndPlatform(runId: string, platform: Platform): SourceQueryRecord[] {
    return all<SourceQueryRow>(
      this.db,
      'SELECT * FROM source_queries WHERE run_id = ? AND platform = ? ORDER BY city_code ASC, id ASC',
      [runId, platform],
    ).map(mapSourceQuery);
  }

  listPendingByRun(runId: string, limit = 100): SourceQueryRecord[] {
    return all<SourceQueryRow>(
      this.db,
      `SELECT * FROM source_queries WHERE run_id = ? AND status = 'pending'
       ORDER BY platform ASC, city_code ASC, id ASC LIMIT ?`,
      [runId, limit],
    ).map(mapSourceQuery);
  }

  updateProgress(id: string, progress: SourceQueryProgress): SourceQueryRecord {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (progress.status !== undefined) push('status', progress.status);
    if (progress.pagesFetched !== undefined) push('pages_fetched', progress.pagesFetched);
    if (progress.totalPages !== undefined) push('total_pages', progress.totalPages);
    if (progress.totalCount !== undefined) push('total_count', progress.totalCount);
    if (progress.upstreamQueryId !== undefined) push('upstream_query_id', progress.upstreamQueryId);
    if (progress.lastError !== undefined) push('last_error', progress.lastError);
    if (progress.startedAt !== undefined) push('started_at', progress.startedAt);
    if (progress.finishedAt !== undefined) push('finished_at', progress.finishedAt);
    if (sets.length === 0) return this.requireById(id);
    const result = run(this.db, `UPDATE source_queries SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    if (result.changes === 0) throw new LeadError('NOT_FOUND', `source query not found: ${id}`);
    return this.requireById(id);
  }

  markRunning(id: string, startedAt: string): SourceQueryRecord {
    return this.updateProgress(id, { status: 'running', startedAt });
  }

  markFinished(
    id: string,
    status: Extract<SourceQueryStatus, 'done' | 'failed' | 'skipped'>,
    opts: { lastError?: string | null; finishedAt?: string } = {},
  ): SourceQueryRecord {
    return this.updateProgress(id, {
      status,
      lastError: opts.lastError ?? null,
      finishedAt: opts.finishedAt ?? new Date().toISOString(),
    });
  }

  incrementPagesFetched(id: string, delta = 1, progress: Omit<SourceQueryProgress, 'pagesFetched'> = {}): SourceQueryRecord {
    const current = this.requireById(id);
    return this.updateProgress(id, { ...progress, pagesFetched: current.pagesFetched + delta });
  }

  statsByRun(runId: string): SourceQueryStats {
    const rows = all<{ status: string; n: number }>(
      this.db,
      'SELECT status, COUNT(*) AS n FROM source_queries WHERE run_id = ? GROUP BY status',
      [runId],
    );
    const stats: SourceQueryStats = { total: 0, pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const row of rows) {
      const n = Number(row.n);
      stats.total += n;
      if (row.status in stats && row.status !== 'total') {
        stats[row.status as keyof SourceQueryStats] += n;
      }
    }
    return stats;
  }

  countByRun(runId: string): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM source_queries WHERE run_id = ?', [runId]);
  }

  /** 把某 Run 中仍 running 的查询复位（进程重启恢复用） */
  resetRunning(runId: string): number {
    return run(
      this.db,
      `UPDATE source_queries SET status = 'pending', started_at = NULL WHERE run_id = ? AND status = 'running'`,
      [runId],
    ).changes;
  }

  private requireById(id: string): SourceQueryRecord {
    const query = this.getById(id);
    if (!query) throw new LeadError('NOT_FOUND', `source query not found: ${id}`);
    return query;
  }
}
