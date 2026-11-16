/** change_events 表（字段级变更 + 全局事件序 seq 游标） */
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { all, countRows, fromJsonUnknown, one, run, toJson, type DbConnection } from './sql.js';
import type {
  ChangeEventListOptions,
  ChangeEventRecord,
  CompanyChangeListOptions,
} from './types.js';
import type { ChangeEventInput } from '../shared/domain.js';

interface ChangeEventRow {
  seq: number;
  company_id: string;
  entity_type: string;
  entity_id: string | null;
  version: number;
  event_type: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  value_type: string | null;
  source: string;
  run_id: string | null;
  actor: string | null;
  occurred_at: string;
  created_at: string;
}

function mapEvent(row: ChangeEventRow): ChangeEventRecord {
  return {
    seq: Number(row.seq),
    companyId: row.company_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    version: Number(row.version),
    eventType: row.event_type,
    field: row.field,
    oldValue: fromJsonUnknown(row.old_value, null),
    newValue: fromJsonUnknown(row.new_value, null),
    valueType: row.value_type,
    source: row.source,
    runId: row.run_id,
    actor: row.actor,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export class ChangeEventsRepository {
  constructor(private readonly db: DbConnection) {}

  /** 追加单条事件，返回含 seq 的完整行 */
  append(input: ChangeEventInput): ChangeEventRecord {
    const now = nowIso();
    const result = run(
      this.db,
      `INSERT INTO change_events(
        company_id, entity_type, entity_id, version, event_type, field, old_value, new_value,
        value_type, source, run_id, actor, occurred_at, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.companyId,
        input.entityType ?? 'company',
        input.entityId ?? null,
        input.version,
        input.eventType,
        input.field ?? null,
        toJson(input.oldValue ?? null),
        toJson(input.newValue ?? null),
        input.valueType ?? null,
        input.source,
        input.runId ?? null,
        input.actor ?? null,
        input.occurredAt ?? now,
        now,
      ],
    );
    const seq = Number(result.lastInsertRowid);
    const event = this.getBySeq(seq);
    if (!event) throw new LeadError('INTERNAL_ERROR', 'change event insert failed');
    return event;
  }

  /** 批量追加（同一事务；同批次共享 version/source 由调用方保证） */
  appendMany(inputs: ChangeEventInput[]): ChangeEventRecord[] {
    if (inputs.length === 0) return [];
    return this.db.transaction(() => inputs.map((input) => this.append(input)));
  }

  getBySeq(seq: number): ChangeEventRecord | null {
    const row = one<ChangeEventRow>(this.db, 'SELECT * FROM change_events WHERE seq = ?', [seq]);
    return row ? mapEvent(row) : null;
  }

  /** 全局增量：seq > sinceSeq，按 seq ASC（无重复、不漏） */
  listSince(sinceSeq: number, opts: ChangeEventListOptions = {}): ChangeEventRecord[] {
    const where: string[] = ['seq > ?'];
    const params: unknown[] = [sinceSeq];
    if (opts.types && opts.types.length > 0) {
      where.push(`event_type IN (${opts.types.map(() => '?').join(',')})`);
      params.push(...opts.types);
    }
    if (opts.companyId) {
      where.push('company_id = ?');
      params.push(opts.companyId);
    }
    if (opts.entityType) {
      where.push('entity_type = ?');
      params.push(opts.entityType);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    return all<ChangeEventRow>(
      this.db,
      `SELECT * FROM change_events WHERE ${where.join(' AND ')}
       ORDER BY seq ASC LIMIT ?`,
      [...params, limit],
    ).map(mapEvent);
  }

  /** 单公司变更（seq ASC；可按 afterSeq / maxVersion 过滤） */
  listByCompany(companyId: string, opts: CompanyChangeListOptions = {}): ChangeEventRecord[] {
    const where: string[] = ['company_id = ?'];
    const params: unknown[] = [companyId];
    if (opts.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(opts.afterSeq);
    }
    if (opts.maxVersion !== undefined) {
      where.push('version <= ?');
      params.push(opts.maxVersion);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    return all<ChangeEventRow>(
      this.db,
      `SELECT * FROM change_events WHERE ${where.join(' AND ')}
       ORDER BY seq ASC LIMIT ?`,
      [...params, limit],
    ).map(mapEvent);
  }

  listByCompanyIds(ids: string[], limit = 500): ChangeEventRecord[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    return all<ChangeEventRow>(
      this.db,
      `SELECT * FROM change_events WHERE company_id IN (${unique.map(() => '?').join(',')})
       ORDER BY seq ASC LIMIT ?`,
      [...unique, limit],
    ).map(mapEvent);
  }

  listByEventType(eventType: string, sinceSeq = 0, limit = 100): ChangeEventRecord[] {
    return this.listSince(sinceSeq, { types: [eventType], limit });
  }

  listByRun(runId: string, limit = 500): ChangeEventRecord[] {
    return this.listSince(0, { runId, limit });
  }

  /** 当前最大 seq（无事件返回 0） */
  maxSeq(): number {
    const value = one<{ max_seq: number | null }>(this.db, 'SELECT MAX(seq) AS max_seq FROM change_events');
    return Number(value?.max_seq ?? 0);
  }

  /** 兼容命名 */
  latestSeq(): number {
    return this.maxSeq();
  }

  countSince(sinceSeq: number): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM change_events WHERE seq > ?', [sinceSeq]);
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM change_events');
  }

  countByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all<{ event_type: string; n: number }>(
      this.db,
      'SELECT event_type, COUNT(*) AS n FROM change_events GROUP BY event_type',
    )) {
      out[row.event_type] = Number(row.n);
    }
    return out;
  }
}
