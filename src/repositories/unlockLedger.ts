/** unlock_ledger 表（探迹解锁额度台账，idempotency_key 唯一） */
import { ulid } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { all, countRows, one, run, type DbConnection } from './sql.js';
import type {
  NewUnlockLedger,
  UnlockLedgerEntry,
  UnlockLedgerFinish,
  UnlockLedgerInsertResult,
  UnlockLedgerResult,
} from './types.js';

interface UnlockLedgerRow {
  id: string;
  company_id: string;
  tanji_company_id: string | null;
  result: string;
  quota_cost: number;
  quota_before: number | null;
  quota_after: number | null;
  account_id: string | null;
  idempotency_key: string;
  error_code: string | null;
  requested_at: string;
  finished_at: string | null;
}

function mapEntry(row: UnlockLedgerRow): UnlockLedgerEntry {
  return {
    id: row.id,
    companyId: row.company_id,
    tanjiCompanyId: row.tanji_company_id,
    result: row.result as UnlockLedgerResult,
    quotaCost: Number(row.quota_cost ?? 0),
    quotaBefore: row.quota_before,
    quotaAfter: row.quota_after,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    errorCode: row.error_code,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
  };
}

export interface UnlockLedgerListOptions {
  companyId?: string;
  result?: UnlockLedgerResult;
  limit?: number;
  offset?: number;
}

export class UnlockLedgerRepository {
  constructor(private readonly db: DbConnection) {}

  /** 写入台账（idempotency_key 冲突时返回已有行，created=false） */
  insertIfAbsent(input: NewUnlockLedger): UnlockLedgerInsertResult {
    return this.db.transaction(() => {
      const existing = this.getByIdempotencyKey(input.idempotencyKey);
      if (existing) return { entry: existing, created: false };
      const id = input.id ?? ulid('ulk');
      run(
        this.db,
        `INSERT INTO unlock_ledger(
          id, company_id, tanji_company_id, result, quota_cost, quota_before, quota_after,
          account_id, idempotency_key, error_code, requested_at, finished_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.companyId,
          input.tanjiCompanyId ?? null,
          input.result,
          input.quotaCost ?? 0,
          input.quotaBefore ?? null,
          input.quotaAfter ?? null,
          input.accountId ?? null,
          input.idempotencyKey,
          input.errorCode ?? null,
          input.requestedAt ?? nowIso(),
          input.finishedAt ?? null,
        ],
      );
      const entry = this.getById(id);
      if (!entry) throw new Error(`unlock ledger insert failed: ${id}`);
      return { entry, created: true };
    });
  }

  /** 兼容命名 */
  insert(input: NewUnlockLedger): UnlockLedgerInsertResult {
    return this.insertIfAbsent(input);
  }

  getById(id: string): UnlockLedgerEntry | null {
    const row = one<UnlockLedgerRow>(this.db, 'SELECT * FROM unlock_ledger WHERE id = ?', [id]);
    return row ? mapEntry(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): UnlockLedgerEntry | null {
    const row = one<UnlockLedgerRow>(
      this.db,
      'SELECT * FROM unlock_ledger WHERE idempotency_key = ?',
      [idempotencyKey],
    );
    return row ? mapEntry(row) : null;
  }

  /** 完成解锁（写 result/quota/finishedAt） */
  finish(id: string, patch: UnlockLedgerFinish): UnlockLedgerEntry | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.result !== undefined) push('result', patch.result);
    if (patch.quotaCost !== undefined) push('quota_cost', patch.quotaCost);
    if (patch.quotaAfter !== undefined) push('quota_after', patch.quotaAfter);
    if (patch.errorCode !== undefined) push('error_code', patch.errorCode);
    push('finished_at', patch.finishedAt ?? nowIso());
    const result = run(this.db, `UPDATE unlock_ledger SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    return result.changes > 0 ? this.getById(id) : null;
  }

  list(opts: UnlockLedgerListOptions = {}): UnlockLedgerEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.companyId) {
      where.push('company_id = ?');
      params.push(opts.companyId);
    }
    if (opts.result) {
      where.push('result = ?');
      params.push(opts.result);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const offset = Math.max(0, opts.offset ?? 0);
    return all<UnlockLedgerRow>(
      this.db,
      `SELECT * FROM unlock_ledger ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY requested_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map(mapEntry);
  }

  listByCompany(companyId: string, limit = 100): UnlockLedgerEntry[] {
    return this.list({ companyId, limit });
  }

  listRecent(limit = 100): UnlockLedgerEntry[] {
    return this.list({ limit });
  }

  /** 某时间点之后消耗的额度点数（/v1/quota 曲线、日上限判断用） */
  sumQuotaCostSince(sinceIso: string): number {
    const row = one<{ total: number | null }>(
      this.db,
      `SELECT COALESCE(SUM(quota_cost),0) AS total FROM unlock_ledger
       WHERE requested_at >= ? AND result IN ('unlocked','already_unlocked')`,
      [sinceIso],
    );
    return Number(row?.total ?? 0);
  }

  countSince(sinceIso: string, result?: UnlockLedgerResult): number {
    return result
      ? countRows(this.db, 'SELECT COUNT(*) FROM unlock_ledger WHERE requested_at >= ? AND result = ?', [
          sinceIso,
          result,
        ])
      : countRows(this.db, 'SELECT COUNT(*) FROM unlock_ledger WHERE requested_at >= ?', [sinceIso]);
  }

  /** 按天聚合消耗（/v1/quota 近 N 天曲线） */
  dailyQuotaCost(days = 7, now: Date = new Date()): Array<{ day: string; unlocks: number; cost: number }> {
    const since = new Date(now.getTime() - days * 86400_000).toISOString();
    const rows = all<{ day: string; unlocks: number; cost: number | null }>(
      this.db,
      `SELECT substr(requested_at, 1, 10) AS day, COUNT(*) AS unlocks, COALESCE(SUM(quota_cost),0) AS cost
       FROM unlock_ledger WHERE requested_at >= ?
       GROUP BY substr(requested_at, 1, 10) ORDER BY day ASC`,
      [since],
    );
    return rows.map((r) => ({ day: r.day, unlocks: Number(r.unlocks), cost: Number(r.cost ?? 0) }));
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM unlock_ledger');
  }
}
