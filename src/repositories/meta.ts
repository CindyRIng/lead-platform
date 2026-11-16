/** meta 表（系统键值 / leader 锁 / 调度状态） */
import { nowIso } from '../shared/time.js';
import { all, fromJson, one, run, toJson, type DbConnection } from './sql.js';
import type { MetaEntry } from './types.js';

interface MetaRow {
  key: string;
  value: string;
  updated_at: string;
}

function mapMeta(row: MetaRow): MetaEntry {
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

export interface MetaLease {
  owner: string;
  expiresAt: string;
}

export class MetaRepository {
  constructor(private readonly db: DbConnection) {}

  get(key: string): string | null {
    const row = one<MetaRow>(this.db, 'SELECT * FROM meta WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (raw === null) return fallback;
    return fromJson<T>(raw, fallback);
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** 写键值：string 原样存；其它值 JSON 序列化。 */
  set(key: string, value: unknown, updatedAt: string = nowIso()): MetaEntry {
    const text = typeof value === 'string' ? value : toJson(value) ?? 'null';
    run(
      this.db,
      `INSERT INTO meta(key, value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, text, updatedAt],
    );
    return { key, value: text, updatedAt };
  }

  setJson(key: string, value: unknown, updatedAt: string = nowIso()): MetaEntry {
    return this.set(key, toJson(value) ?? 'null', updatedAt);
  }

  setMany(entries: Record<string, unknown>, updatedAt: string = nowIso()): void {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) this.set(key, value, updatedAt);
    });
  }

  delete(key: string): number {
    return run(this.db, 'DELETE FROM meta WHERE key = ?', [key]).changes;
  }

  list(prefix?: string): MetaEntry[] {
    const rows = prefix
      ? all<MetaRow>(this.db, 'SELECT * FROM meta WHERE key LIKE ? ORDER BY key ASC', [`${prefix}%`])
      : all<MetaRow>(this.db, 'SELECT * FROM meta ORDER BY key ASC');
    return rows.map(mapMeta);
  }

  // -------------------------------------------------------------------------
  // leader 锁（scheduler / worker 单实例保障）
  // -------------------------------------------------------------------------

  getLease(key: string): MetaLease | null {
    const value = this.getJson<MetaLease | null>(key, null);
    if (!value || typeof value.owner !== 'string' || typeof value.expiresAt !== 'string') return null;
    return value;
  }

  /** 原子获取/续期租约；未过期且属于他人时返回 false */
  acquireLease(key: string, owner: string, ttlMs: number, now: Date = new Date()): boolean {
    return this.db.transaction(() => {
      const current = this.getLease(key);
      if (current && current.owner !== owner && Date.parse(current.expiresAt) > now.getTime()) {
        return false;
      }
      this.setJson(key, { owner, expiresAt: new Date(now.getTime() + ttlMs).toISOString() }, now.toISOString());
      return true;
    });
  }

  releaseLease(key: string, owner: string): boolean {
    return this.db.transaction(() => {
      const current = this.getLease(key);
      if (!current || current.owner !== owner) return false;
      this.delete(key);
      return true;
    });
  }
}
