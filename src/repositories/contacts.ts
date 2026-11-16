/** company_contacts 表（解锁后的联系人：唯一 company_id + type + value） */
import { LeadError } from '../shared/errors.js';
import { ulid } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { all, countRows, fromDbBoolRequired, fromDbBool, one, run, type DbConnection } from './sql.js';
import type { NewContact } from './types.js';
import type { Contact } from '../shared/domain.js';

interface ContactRow {
  id: string;
  company_id: string;
  tanji_contact_id: string | null;
  name: string | null;
  position: string | null;
  department: string | null;
  region: string | null;
  type: string;
  value: string;
  masked: number;
  source: string | null;
  is_key: number;
  unlocked_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    companyId: row.company_id,
    tanjiContactId: row.tanji_contact_id,
    name: row.name,
    position: row.position,
    department: row.department,
    region: row.region,
    type: row.type as Contact['type'],
    value: row.value,
    masked: fromDbBoolRequired(row.masked),
    source: row.source,
    isKey: fromDbBoolRequired(row.is_key),
    unlockedAt: row.unlocked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CompanyContactsRepository {
  constructor(private readonly db: DbConnection) {}

  /** 按 (company_id, type, value) upsert；已存在则更新展示字段 */
  upsert(input: NewContact): Contact {
    return this.db.transaction(() => {
      const existing = this.findByKey(input.companyId, input.type, input.value);
      const now = nowIso();
      if (existing) {
        run(
          this.db,
          `UPDATE company_contacts SET
             tanji_contact_id = ?, name = ?, position = ?, department = ?, region = ?,
             masked = ?, source = ?, is_key = ?, unlocked_at = ?, updated_at = ?
           WHERE id = ?`,
          [
            input.tanjiContactId ?? existing.tanjiContactId,
            input.name ?? existing.name,
            input.position ?? existing.position,
            input.department ?? existing.department,
            input.region ?? existing.region,
            input.masked === undefined ? (existing.masked ? 1 : 0) : input.masked ? 1 : 0,
            input.source ?? existing.source,
            input.isKey === undefined ? (existing.isKey ? 1 : 0) : input.isKey ? 1 : 0,
            input.unlockedAt ?? existing.unlockedAt,
            now,
            existing.id,
          ],
        );
        const updated = this.getById(existing.id);
        if (!updated) throw new Error(`contact disappeared: ${existing.id}`);
        return updated;
      }
      const id = input.id ?? ulid('ctc');
      run(
        this.db,
        `INSERT INTO company_contacts(
          id, company_id, tanji_contact_id, name, position, department, region, type, value,
          masked, source, is_key, unlocked_at, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.companyId,
          input.tanjiContactId ?? null,
          input.name ?? null,
          input.position ?? null,
          input.department ?? null,
          input.region ?? null,
          input.type,
          input.value,
          input.masked ? 1 : 0,
          input.source ?? null,
          input.isKey ? 1 : 0,
          input.unlockedAt ?? null,
          input.createdAt ?? now,
          input.updatedAt ?? now,
        ],
      );
      const contact = this.getById(id);
      if (!contact) throw new Error(`contact insert failed: ${id}`);
      return contact;
    });
  }

  /** 批量 upsert（单事务；用于解锁后联系人与 contact_sync） */
  upsertMany(inputs: NewContact[]): Contact[] {
    if (inputs.length === 0) return [];
    return this.db.transaction(() => inputs.map((input) => this.upsert(input)));
  }

  getById(id: string): Contact | null {
    const row = one<ContactRow>(this.db, 'SELECT * FROM company_contacts WHERE id = ?', [id]);
    return row ? mapContact(row) : null;
  }

  findByKey(companyId: string, type: Contact['type'], value: string): Contact | null {
    const row = one<ContactRow>(
      this.db,
      'SELECT * FROM company_contacts WHERE company_id = ? AND type = ? AND value = ?',
      [companyId, type, value],
    );
    return row ? mapContact(row) : null;
  }

  listByCompany(companyId: string, opts: { type?: Contact['type']; limit?: number } = {}): Contact[] {
    const where: string[] = ['company_id = ?'];
    const params: unknown[] = [companyId];
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
    return all<ContactRow>(
      this.db,
      `SELECT * FROM company_contacts WHERE ${where.join(' AND ')}
       ORDER BY is_key DESC, created_at ASC LIMIT ?`,
      [...params, limit],
    ).map(mapContact);
  }

  listByCompanyIds(ids: string[]): Contact[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    return all<ContactRow>(
      this.db,
      `SELECT * FROM company_contacts WHERE company_id IN (${unique.map(() => '?').join(',')})
       ORDER BY company_id ASC, is_key DESC, created_at ASC`,
      unique,
    ).map(mapContact);
  }

  countByCompany(companyId: string): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_contacts WHERE company_id = ?', [companyId]);
  }

  /** 联系人类型分布（contact.unlocked 事件摘要用） */
  summarizeByCompany(companyId: string): { total: number; types: Record<string, number>; unlockedAt: string | null } {
    const rows = all<{ type: string; n: number }>(
      this.db,
      'SELECT type, COUNT(*) AS n FROM company_contacts WHERE company_id = ? GROUP BY type',
      [companyId],
    );
    const types: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      types[row.type] = Number(row.n);
      total += Number(row.n);
    }
    const latest = one<{ unlocked_at: string | null }>(
      this.db,
      'SELECT MAX(unlocked_at) AS unlocked_at FROM company_contacts WHERE company_id = ?',
      [companyId],
    );
    return { total, types, unlockedAt: latest?.unlocked_at ?? null };
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_contacts');
  }

  deleteById(id: string): boolean {
    return run(this.db, 'DELETE FROM company_contacts WHERE id = ?', [id]).changes > 0;
  }

  deleteByCompany(companyId: string): number {
    return run(this.db, 'DELETE FROM company_contacts WHERE company_id = ?', [companyId]).changes;
  }

  /** 兼容：是否存在某联系人的布尔字段读取（工具） */
  static maskOf(row: { masked?: number }): boolean {
    return fromDbBool(row.masked) === true;
  }

  private requireById(id: string): Contact {
    const contact = this.getById(id);
    if (!contact) throw new LeadError('NOT_FOUND', `contact not found: ${id}`);
    return contact;
  }
}
