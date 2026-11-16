/** quota_observations（探迹额度观测曲线） */
import { ulid } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { all, countRows, fromJsonUnknown, one, run, toJson, type DbConnection } from './sql.js';
import type { NewQuotaObservation, QuotaObservation } from './types.js';

interface QuotaRow {
  id: string;
  observed_at: string;
  daily_limit: number | null;
  daily_remaining: number | null;
  monthly_limit: number | null;
  monthly_remaining: number | null;
  enterprise_limit: number | null;
  enterprise_remaining: number | null;
  settlement_day: number | null;
  raw: string | null;
}

function mapQuota(row: QuotaRow): QuotaObservation {
  return {
    id: row.id,
    observedAt: row.observed_at,
    dailyLimit: row.daily_limit,
    dailyRemaining: row.daily_remaining,
    monthlyLimit: row.monthly_limit,
    monthlyRemaining: row.monthly_remaining,
    enterpriseLimit: row.enterprise_limit,
    enterpriseRemaining: row.enterprise_remaining,
    settlementDay: row.settlement_day,
    raw: fromJsonUnknown(row.raw, null),
  };
}

export class QuotaRepository {
  constructor(private readonly db: DbConnection) {}

  insertObservation(input: NewQuotaObservation): QuotaObservation {
    const id = input.id ?? ulid('qob');
    const observedAt = input.observedAt ?? nowIso();
    run(
      this.db,
      `INSERT INTO quota_observations(
        id, observed_at, daily_limit, daily_remaining, monthly_limit, monthly_remaining,
        enterprise_limit, enterprise_remaining, settlement_day, raw
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        observedAt,
        input.dailyLimit ?? null,
        input.dailyRemaining ?? null,
        input.monthlyLimit ?? null,
        input.monthlyRemaining ?? null,
        input.enterpriseLimit ?? null,
        input.enterpriseRemaining ?? null,
        input.settlementDay ?? null,
        toJson(input.raw ?? null),
      ],
    );
    const row = this.getById(id);
    if (!row) throw new Error(`quota observation insert failed: ${id}`);
    return row;
  }

  getById(id: string): QuotaObservation | null {
    const row = one<QuotaRow>(this.db, 'SELECT * FROM quota_observations WHERE id = ?', [id]);
    return row ? mapQuota(row) : null;
  }

  /** 最近一次观测（额度恢复判断/customs 状态页） */
  latest(): QuotaObservation | null {
    const row = one<QuotaRow>(
      this.db,
      'SELECT * FROM quota_observations ORDER BY observed_at DESC, id DESC LIMIT 1',
    );
    return row ? mapQuota(row) : null;
  }

  getLatest(): QuotaObservation | null {
    return this.latest();
  }

  listRecent(limit = 100, sinceIso?: string): QuotaObservation[] {
    const capped = Math.max(1, Math.min(limit, 1000));
    const rows = sinceIso
      ? all<QuotaRow>(
          this.db,
          'SELECT * FROM quota_observations WHERE observed_at >= ? ORDER BY observed_at DESC, id DESC LIMIT ?',
          [sinceIso, capped],
        )
      : all<QuotaRow>(
          this.db,
          'SELECT * FROM quota_observations ORDER BY observed_at DESC, id DESC LIMIT ?',
          [capped],
        );
    return rows.map(mapQuota);
  }

  historySince(sinceIso: string, limit = 1000): QuotaObservation[] {
    return all<QuotaRow>(
      this.db,
      'SELECT * FROM quota_observations WHERE observed_at >= ? ORDER BY observed_at ASC LIMIT ?',
      [sinceIso, Math.max(1, Math.min(limit, 5000))],
    ).map(mapQuota);
  }

  /** 最近 N 天的额度曲线（按天取当天最后一条） */
  dailyLatest(days = 7, now: Date = new Date()): QuotaObservation[] {
    const since = new Date(now.getTime() - days * 86400_000).toISOString();
    const rows = all<QuotaRow>(
      this.db,
      `SELECT q.* FROM quota_observations q
       JOIN (
         SELECT substr(observed_at,1,10) AS day, MAX(observed_at) AS max_at
         FROM quota_observations WHERE observed_at >= ? GROUP BY substr(observed_at,1,10)
       ) latest ON latest.max_at = q.observed_at
       ORDER BY q.observed_at ASC`,
      [since],
    );
    return rows.map(mapQuota);
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM quota_observations');
  }
}
