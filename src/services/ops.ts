/**
 * 运行态/队列只读服务（D1 授权新增）。
 *
 * 覆盖没有独立 service owner 的运维类端点：
 *   GET /v1/jobs、/v1/jobs/{id}、POST /v1/jobs/{id}/retry
 *   GET /v1/sources、/v1/quota、/v1/stats（kind=summary|coverage|unlocks）
 *
 * 数据源：SQLite（frozen schema）+ 运行期注入的 DB 句柄；
 * 若存在更完整的领域服务（src/services/sources.ts / quota.ts / jobs.ts），
 * 路由桥接层会优先使用它们，本文件是兜底/聚合实现。
 */
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { safeJsonParse } from '../shared/json.js';

export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
}

export interface OpsRuntime {
  db?: SqliteLike | { raw?: SqliteLike };
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

let runtime: OpsRuntime = {};
let cachedRaw: SqliteLike | null = null;

export function configureOps(ctx: OpsRuntime | null | undefined): void {
  runtime = ctx && typeof ctx === 'object' ? ctx : {};
  cachedRaw = null;
}

async function resolveRaw(): Promise<SqliteLike> {
  if (cachedRaw) return cachedRaw;
  const db = runtime.db as (SqliteLike & { raw?: SqliteLike }) | undefined;
  if (db) {
    if (db.raw && typeof db.raw.prepare === 'function') {
      cachedRaw = db.raw;
      return cachedRaw;
    }
    if (typeof db.prepare === 'function') {
      cachedRaw = db;
      return cachedRaw;
    }
  }
  try {
    const spec = '../db/index.js';
    const mod = (await import(/* @vite-ignore */ new URL(spec, import.meta.url).href)) as Record<string, unknown>;
    const getDb = mod.getDb;
    if (typeof getDb === 'function') {
      const handle = (getDb as () => SqliteLike & { raw?: SqliteLike })();
      cachedRaw = handle.raw && typeof handle.raw.prepare === 'function' ? handle.raw : handle;
      return cachedRaw;
    }
  } catch {
    /* ignore */
  }
  throw new LeadError('INTERNAL_ERROR', 'ops service requires a database handle (integration point: getDb)');
}

function n(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function s(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/* ------------------------------------------------------------------ */
/* cursor 编解码（不透明 base64url JSON）                                */
/* ------------------------------------------------------------------ */

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    throw new LeadError('VALIDATION_ERROR', 'invalid cursor', { details: { field: 'cursor' } });
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                               */
/* ------------------------------------------------------------------ */

interface JobQuery {
  status?: string;
  stage?: string;
  companyId?: string;
  platform?: string;
  limit: number;
  cursor?: string;
}

export interface JobView {
  id: string;
  companyId: string;
  platform: string | null;
  runId: string | null;
  stage: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapJob(row: Record<string, unknown>): JobView {
  return {
    id: String(row.id ?? ''),
    companyId: String(row.company_id ?? ''),
    platform: s(row.platform),
    runId: s(row.run_id),
    stage: String(row.stage ?? ''),
    status: String(row.status ?? ''),
    attempts: n(row.attempts),
    maxAttempts: n(row.max_attempts),
    nextRetryAt: s(row.next_retry_at),
    leaseOwner: s(row.lease_owner),
    leaseUntil: s(row.lease_until),
    lastError: s(row.last_error),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

export async function listJobs(query: JobQuery): Promise<{
  items: JobView[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const raw = await resolveRaw();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.stage) {
    where.push('stage = ?');
    params.push(query.stage);
  }
  if (query.companyId) {
    where.push('company_id = ?');
    params.push(query.companyId);
  }
  if (query.platform) {
    where.push('platform = ?');
    params.push(query.platform);
  }
  const cursor = decodeCursor(query.cursor);
  if (cursor && typeof cursor.createdAt === 'string' && typeof cursor.id === 'string') {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const limit = Math.max(1, Math.min(200, query.limit));
  const sql = `SELECT * FROM pipeline_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  const rows = raw.prepare(sql).all(...params, limit + 1) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(mapJob);
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getJob(id: string): Promise<JobView | null> {
  const raw = await resolveRaw();
  const row = raw.prepare('SELECT * FROM pipeline_jobs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapJob(row) : null;
}

export async function retryJob(id: string): Promise<JobView> {
  const raw = await resolveRaw();
  const row = raw.prepare('SELECT * FROM pipeline_jobs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new LeadError('NOT_FOUND', `job not found: ${id}`);
  const status = String(row.status ?? '');
  if (status !== 'failed' && status !== 'dead') {
    throw new LeadError('CONFLICT', `job is not retryable (status=${status})`, {
      details: { jobId: id, status, retryableStatuses: ['failed', 'dead'] },
    });
  }
  const now = nowIso();
  raw
    .prepare(
      `UPDATE pipeline_jobs
          SET status = 'pending', attempts = 0, lease_owner = NULL, lease_until = NULL,
              next_retry_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(now, id);
  const updated = raw.prepare('SELECT * FROM pipeline_jobs WHERE id = ?').get(id) as Record<string, unknown>;
  return mapJob(updated);
}

/* ------------------------------------------------------------------ */
/* Sources                                                            */
/* ------------------------------------------------------------------ */

const ALL_SOURCES = ['boss', 'zhilian', 'ali', 'mic', 'tanji', 'fuma'] as const;

export async function listSources(): Promise<{ items: unknown[]; updatedAt: string }> {
  const raw = await resolveRaw();
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = raw.prepare('SELECT * FROM source_health').all() as Array<Record<string, unknown>>;
  } catch {
    rows = [];
  }
  const byPlatform = new Map(rows.map((r) => [String(r.platform), r]));
  const items = ALL_SOURCES.map((platform) => {
    const row = byPlatform.get(platform);
    if (!row) {
      return {
        platform,
        state: 'unavailable',
        loggedIn: null,
        expiresAt: null,
        checkedAt: null,
        consecutiveFailures: 0,
        detail: null,
      };
    }
    return {
      platform,
      state: String(row.state ?? 'unavailable'),
      loggedIn: row.logged_in === null || row.logged_in === undefined ? null : Boolean(row.logged_in),
      expiresAt: s(row.expires_at),
      checkedAt: s(row.checked_at),
      consecutiveFailures: n(row.consecutive_failures),
      detail: safeJsonParse<Record<string, unknown> | null>(s(row.detail), null),
    };
  });
  return { items, updatedAt: nowIso() };
}

/* ------------------------------------------------------------------ */
/* Quota                                                              */
/* ------------------------------------------------------------------ */

interface QuotaLayer {
  limit: number;
  used: number;
  remaining: number;
  unit: string;
}

function quotaLayer(limit: unknown, remaining: unknown, unit = '点'): QuotaLayer {
  const lim = n(limit);
  const rem = n(remaining);
  return { limit: lim, used: Math.max(0, lim - rem), remaining: rem, unit };
}

export async function getQuota(): Promise<Record<string, unknown>> {
  const raw = await resolveRaw();
  let row: Record<string, unknown> | undefined;
  try {
    row = raw.prepare('SELECT * FROM quota_observations ORDER BY observed_at DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
  } catch {
    row = undefined;
  }
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString();
  let unlockRows: Array<Record<string, unknown>> = [];
  try {
    unlockRows = raw
      .prepare(
        `SELECT substr(requested_at, 1, 10) AS day, COUNT(*) AS total, COALESCE(SUM(quota_cost), 0) AS cost
           FROM unlock_ledger WHERE requested_at >= ? GROUP BY day ORDER BY day ASC`,
      )
      .all(since) as Array<Record<string, unknown>>;
  } catch {
    unlockRows = [];
  }
  const nearlySevenDayUnlockCount = unlockRows.reduce((sum, r) => sum + n(r.total), 0);
  const recentUnlockCurve = unlockRows.map((r) => ({ date: String(r.day ?? ''), count: n(r.total) }));
  const alerts: string[] = [];
  const monthlyRemaining = row ? n(row.monthly_remaining) : 0;
  if (row && monthlyRemaining < 50) alerts.push('tanji monthly quota low');
  if (row && n(row.daily_remaining) === 0) alerts.push('tanji daily quota exhausted');
  if (!row) alerts.push('quota not observed yet');
  return {
    daily: quotaLayer(row?.daily_limit, row?.daily_remaining),
    monthly: quotaLayer(row?.monthly_limit, row?.monthly_remaining),
    enterpriseMonthly: quotaLayer(row?.enterprise_limit, row?.enterprise_remaining),
    settlementDay: row?.settlement_day === null || row?.settlement_day === undefined ? null : n(row.settlement_day),
    nearlySevenDayUnlockCount,
    recentUnlockCurve,
    observedAt: s(row?.observed_at),
    alerts,
  };
}

/* ------------------------------------------------------------------ */
/* Stats                                                              */
/* ------------------------------------------------------------------ */

interface StatsQuery {
  from?: string;
  to?: string;
  kind?: 'summary' | 'coverage' | 'unlocks';
  runId?: string;
}

function defaultRange(from?: string, to?: string): { from: string; to: string } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 7 * 86400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new LeadError('VALIDATION_ERROR', 'invalid from/to datetime', { details: { field: 'from/to' } });
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

function shortCity(value: string | null): string {
  if (!value) return '未知';
  return value.replace(/市$/, '');
}

export async function getStats(query: StatsQuery = {}): Promise<Record<string, unknown>> {
  const raw = await resolveRaw();
  const range = defaultRange(query.from, query.to);
  const kind = query.kind ?? 'summary';

  const scalar = (sql: string, ...params: unknown[]): number => {
    try {
      const row = raw.prepare(sql).get(...params) as { n?: number | bigint } | undefined;
      return n(row?.n);
    } catch {
      return 0;
    }
  };
  const rows = (sql: string, ...params: unknown[]): Array<Record<string, unknown>> => {
    try {
      return raw.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  };

  if (kind === 'coverage') {
    const runFilter = query.runId ? 'AND first_run_id = ?' : '';
    const runParams = query.runId ? [query.runId] : [];
    const uniqueCompanies = scalar(`SELECT COUNT(*) AS n FROM companies WHERE merged_into IS NULL AND verified = 1 ${runFilter}`, ...runParams);
    const crossSourceOverlap = scalar(
      `SELECT COUNT(*) AS n FROM (
         SELECT company_id FROM company_sources GROUP BY company_id
          HAVING COUNT(DISTINCT platform) >= 2
       )`,
    );
    const cityRows = rows(
      `SELECT city AS city, COUNT(*) AS n FROM companies
        WHERE merged_into IS NULL AND verified = 1 ${runFilter} GROUP BY city ORDER BY n DESC LIMIT 200`,
      ...runParams,
    );
    const coverageByCity: Record<string, number> = {};
    for (const r of cityRows) coverageByCity[shortCity(s(r.city))] = n(r.n);

    const keywordYield: Record<string, number> = {};
    try {
      const sourceRows = raw
        .prepare(
          `SELECT cs.company_id AS company_id, cs.evidence AS evidence
             FROM company_sources cs
             JOIN companies c ON c.id = cs.company_id
            WHERE c.merged_into IS NULL AND c.verified = 1 ${query.runId ? 'AND c.first_run_id = ?' : ''}`,
        )
        .all(...runParams) as Array<Record<string, unknown>>;
      const seen = new Map<string, Set<string>>();
      for (const r of sourceRows) {
        const evidence = safeJsonParse<Record<string, unknown>>(s(r.evidence) ?? '', {});
        const keyword = typeof evidence.keyword === 'string' ? evidence.keyword : null;
        if (!keyword) continue;
        const companyId = String(r.company_id ?? '');
        const set = seen.get(keyword) ?? new Set<string>();
        set.add(companyId);
        seen.set(keyword, set);
      }
      for (const [keyword, set] of seen) keywordYield[keyword] = set.size;
    } catch {
      /* ignore */
    }

    return {
      kind: 'coverage',
      from: range.from,
      to: range.to,
      coverage: { uniqueCompanies, crossSourceOverlap, coverageByCity, keywordYield },
    };
  }

  if (kind === 'unlocks') {
    const byDay = rows(
      `SELECT substr(requested_at, 1, 10) AS day, COUNT(*) AS total, COALESCE(SUM(quota_cost), 0) AS cost
         FROM unlock_ledger WHERE requested_at >= ? AND requested_at <= ? GROUP BY day ORDER BY day ASC`,
      range.from,
      range.to,
    ).map((r) => ({ date: String(r.day ?? ''), count: n(r.total), quotaCost: n(r.cost) }));
    const byResult = rows(
      `SELECT result, COUNT(*) AS n, COALESCE(SUM(quota_cost), 0) AS cost
         FROM unlock_ledger WHERE requested_at >= ? AND requested_at <= ? GROUP BY result`,
      range.from,
      range.to,
    ).map((r) => ({ result: String(r.result ?? ''), count: n(r.n), quotaCost: n(r.cost) }));
    const total = byResult.reduce((sum, r) => sum + r.count, 0);
    const quotaCost = byResult.reduce((sum, r) => sum + r.quotaCost, 0);
    return {
      kind: 'unlocks',
      from: range.from,
      to: range.to,
      unlock: { total, quotaCost, byResult, byDay },
    };
  }

  const companyTotal = scalar('SELECT COUNT(*) AS n FROM companies WHERE merged_into IS NULL AND verified = 1');
  const companyCreated = scalar(
    'SELECT COUNT(*) AS n FROM companies WHERE merged_into IS NULL AND verified = 1 AND created_at >= ? AND created_at <= ?',
    range.from,
    range.to,
  );
  const byEnrichment = Object.fromEntries(
    rows(
      `SELECT enrichment_status AS status, COUNT(*) AS n FROM companies
        WHERE merged_into IS NULL AND verified = 1 GROUP BY enrichment_status`,
    ).map((r) => [String(r.status ?? ''), n(r.n)]),
  );
  const byUnlock = Object.fromEntries(
    rows('SELECT unlock_status AS status, COUNT(*) AS n FROM companies WHERE merged_into IS NULL AND verified = 1 GROUP BY unlock_status').map(
      (r) => [String(r.status ?? ''), n(r.n)],
    ),
  );
  const sourcesByPlatform = Object.fromEntries(
    rows('SELECT platform, COUNT(*) AS n FROM company_sources GROUP BY platform').map((r) => [
      String(r.platform ?? ''),
      n(r.n),
    ]),
  );
  const eventsByType = Object.fromEntries(
    rows(
      `SELECT event_type AS type, COUNT(*) AS n FROM change_events
        WHERE occurred_at >= ? AND occurred_at <= ? GROUP BY event_type`,
      range.from,
      range.to,
    ).map((r) => [String(r.type ?? ''), n(r.n)]),
  );
  const eventsByDay = rows(
    `SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS n FROM change_events
      WHERE occurred_at >= ? AND occurred_at <= ? GROUP BY day ORDER BY day ASC`,
    range.from,
    range.to,
  ).map((r) => ({ date: String(r.day ?? ''), count: n(r.n) }));
  const runsByStatus = Object.fromEntries(
    rows('SELECT status, COUNT(*) AS n FROM goal_runs GROUP BY status').map((r) => [String(r.status ?? ''), n(r.n)]),
  );
  const unlockTotal = scalar(
    'SELECT COUNT(*) AS n FROM unlock_ledger WHERE requested_at >= ? AND requested_at <= ?',
    range.from,
    range.to,
  );
  const unlockCost = scalar(
    'SELECT COALESCE(SUM(quota_cost), 0) AS n FROM unlock_ledger WHERE requested_at >= ? AND requested_at <= ?',
    range.from,
    range.to,
  );
  const leadsTotal = (() => { try { return scalar('SELECT COUNT(*) AS n FROM leads'); } catch { return 0; } })();
  const draftsTotal = (() => { try { return scalar('SELECT COUNT(*) AS n FROM companies WHERE verified = 0 AND merged_into IS NULL'); } catch { return 0; } })();
  const jobsByStatus = Object.fromEntries(
    rows('SELECT status, COUNT(*) AS n FROM pipeline_jobs GROUP BY status').map((r) => [String(r.status ?? ''), n(r.n)]),
  );

  return {
    kind: 'summary',
    from: range.from,
    to: range.to,
    companies: { total: companyTotal, created: companyCreated, byEnrichmentStatus: byEnrichment, byUnlockStatus: byUnlock },
    leads: { total: leadsTotal },
    drafts: { total: draftsTotal },
    sources: { byPlatform: sourcesByPlatform },
    enrichment: { byStatus: byEnrichment },
    unlock: { total: unlockTotal, quotaCost: unlockCost },
    events: { total: Object.values(eventsByType).reduce((a, b) => a + b, 0), byType: eventsByType, byDay: eventsByDay },
    runs: { byStatus: runsByStatus },
    jobs: { byStatus: jobsByStatus },
  };
}
