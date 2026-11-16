/** status 路由：运行状态/队列/DB/额度/上游健康（免鉴权，只读聚合，细粒度错误内部吞掉） */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ok } from '../../shared/envelope.js';
import { newRequestId } from '../../shared/ids.js';
import { config } from '../../config.js';
import { getDb, dbSizeBytes } from '../../db/index.js';
import { safeJsonParse } from '../../shared/json.js';

function tableCount(table: string): number {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

function queueStats(): Record<string, number> {
  try {
    const rows = getDb()
      .prepare('SELECT status, COUNT(*) AS n FROM pipeline_jobs GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  } catch {
    return {};
  }
}

function latestQuota(): unknown {
  try {
    const row = getDb()
      .prepare('SELECT * FROM quota_observations ORDER BY observed_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      observedAt: row.observed_at,
      daily: { limit: row.daily_limit, remaining: row.daily_remaining },
      monthly: { limit: row.monthly_limit, remaining: row.monthly_remaining },
      enterprise: { limit: row.enterprise_limit, remaining: row.enterprise_remaining },
      settlementDay: row.settlement_day,
    };
  } catch {
    return null;
  }
}

function sourceHealth(): unknown[] {
  try {
    return getDb().prepare('SELECT platform, state, logged_in, checked_at FROM source_health').all();
  } catch {
    return [];
  }
}

export function registerStatusRoutes(app: FastifyInstance): void {
  app.get('/v1/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req as unknown as { leadRequestId?: string }).leadRequestId ?? newRequestId();
    const alerts: string[] = [];
    let schemaVersion = 0;
    try {
      schemaVersion = Number((getDb().prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0);
    } catch {
      alerts.push('database unavailable');
    }
    const quota = latestQuota() as { monthly?: { remaining?: number | null }; daily?: { remaining?: number | null } } | null;
    if (quota?.monthly?.remaining !== undefined && quota.monthly.remaining !== null && quota.monthly.remaining < 50) alerts.push('tanji monthly quota low');
    return reply.send(
      ok(
        {
          service: 'lead-platform',
          version: process.env.npm_package_version ?? '0.1.0',
          nodeEnv: config.nodeEnv,
          time: new Date().toISOString(),
          db: { sizeBytes: dbSizeBytes(), schemaVersion, companies: tableCount('companies'), changes: tableCount('change_events') },
          queue: queueStats(),
          scheduler: { enabled: config.schedulerEnabled },
          upstream: sourceHealth(),
          quota,
          coverage: safeJsonParse<Record<string, unknown> | null>(null as unknown as string, null),
          alerts,
        },
        id,
      ),
    );
  });
}
