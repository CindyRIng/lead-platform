/** company_sources 表（来源证据：平台 × 平台公司 ID 唯一） */
import { ulid } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { all, countRows, fromJsonObject, one, run, toJson, type DbConnection } from './sql.js';
import type { CompanySourceUpsertResult, NewCompanySource } from './types.js';
import type { CompanySource, Platform } from '../shared/domain.js';

interface CompanySourceRow {
  id: string;
  company_id: string;
  platform: string;
  platform_company_id: string;
  source_name: string | null;
  source_url: string | null;
  city_name: string | null;
  evidence: string;
  first_seen_at: string;
  last_seen_at: string;
}

function mapSource(row: CompanySourceRow): CompanySource {
  return {
    id: row.id,
    companyId: row.company_id,
    platform: row.platform as Platform,
    platformCompanyId: row.platform_company_id,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    cityName: row.city_name,
    evidence: fromJsonObject(row.evidence) ?? {},
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class CompanySourcesRepository {
  constructor(private readonly db: DbConnection) {}

  /**
   * 来源记录 upsert：唯一 (platform, platform_company_id)。
   * - 已存在：更新 last_seen_at，合并 evidence，非空字段覆盖
   * - 不存在：插入
   */
  upsert(input: NewCompanySource): CompanySourceUpsertResult {
    return this.db.transaction(() => {
      const existing = this.getByPlatformId(input.platform, input.platformCompanyId);
      const now = nowIso();
      const lastSeenAt = input.lastSeenAt ?? now;
      if (existing) {
        const evidence = { ...existing.evidence, ...(input.evidence ?? {}) };
        run(
          this.db,
          `UPDATE company_sources
           SET company_id = ?, source_name = ?, source_url = ?, city_name = ?, evidence = ?, last_seen_at = ?
           WHERE id = ?`,
          [
            input.companyId,
            input.sourceName ?? existing.sourceName,
            input.sourceUrl ?? existing.sourceUrl,
            input.cityName ?? existing.cityName,
            toJson(evidence),
            lastSeenAt,
            existing.id,
          ],
        );
        const updated = this.getById(existing.id);
        if (!updated) throw new Error(`company source disappeared: ${existing.id}`);
        return { source: updated, created: false };
      }
      const id = input.id ?? ulid('csrc');
      run(
        this.db,
        `INSERT INTO company_sources(
          id, company_id, platform, platform_company_id, source_name, source_url, city_name,
          evidence, first_seen_at, last_seen_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.companyId,
          input.platform,
          input.platformCompanyId,
          input.sourceName ?? null,
          input.sourceUrl ?? null,
          input.cityName ?? null,
          toJson(input.evidence ?? {}),
          input.firstSeenAt ?? now,
          lastSeenAt,
        ],
      );
      const source = this.getById(id);
      if (!source) throw new Error(`company source insert failed: ${id}`);
      return { source, created: true };
    });
  }

  getById(id: string): CompanySource | null {
    const row = one<CompanySourceRow>(this.db, 'SELECT * FROM company_sources WHERE id = ?', [id]);
    return row ? mapSource(row) : null;
  }

  getByPlatformId(platform: Platform, platformCompanyId: string): CompanySource | null {
    const row = one<CompanySourceRow>(
      this.db,
      'SELECT * FROM company_sources WHERE platform = ? AND platform_company_id = ?',
      [platform, platformCompanyId],
    );
    return row ? mapSource(row) : null;
  }

  getByPlatform(companyId: string, platform: Platform): CompanySource | null {
    const row = one<CompanySourceRow>(
      this.db,
      'SELECT * FROM company_sources WHERE company_id = ? AND platform = ? ORDER BY first_seen_at ASC LIMIT 1',
      [companyId, platform],
    );
    return row ? mapSource(row) : null;
  }

  listByCompany(companyId: string): CompanySource[] {
    return all<CompanySourceRow>(
      this.db,
      'SELECT * FROM company_sources WHERE company_id = ? ORDER BY first_seen_at ASC, platform ASC',
      [companyId],
    ).map(mapSource);
  }

  listByCompanyIds(ids: string[]): CompanySource[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    return all<CompanySourceRow>(
      this.db,
      `SELECT * FROM company_sources WHERE company_id IN (${unique.map(() => '?').join(',')})
       ORDER BY company_id ASC, first_seen_at ASC`,
      unique,
    ).map(mapSource);
  }

  listByPlatform(platform: Platform, limit = 500, offset = 0): CompanySource[] {
    return all<CompanySourceRow>(
      this.db,
      'SELECT * FROM company_sources WHERE platform = ? ORDER BY first_seen_at ASC LIMIT ? OFFSET ?',
      [platform, limit, offset],
    ).map(mapSource);
  }

  /** 最近 N 条来源（调试/状态用） */
  listRecent(limit = 100): CompanySource[] {
    return all<CompanySourceRow>(
      this.db,
      'SELECT * FROM company_sources ORDER BY last_seen_at DESC LIMIT ?',
      [limit],
    ).map(mapSource);
  }

  countByCompany(companyId: string): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_sources WHERE company_id = ?', [companyId]);
  }

  countByPlatform(platform: Platform): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_sources WHERE platform = ?', [platform]);
  }

  countDistinctCompanies(platform?: Platform): number {
    return platform
      ? countRows(this.db, 'SELECT COUNT(DISTINCT company_id) FROM company_sources WHERE platform = ?', [platform])
      : countRows(this.db, 'SELECT COUNT(DISTINCT company_id) FROM company_sources');
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_sources');
  }

  /** 跨来源重叠：按 company 聚合各平台数量（覆盖度统计用） */
  platformCountsByCompany(companyId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all<{ platform: string; n: number }>(
      this.db,
      'SELECT platform, COUNT(*) AS n FROM company_sources WHERE company_id = ? GROUP BY platform',
      [companyId],
    )) {
      out[row.platform] = Number(row.n);
    }
    return out;
  }

  deleteByCompany(companyId: string): number {
    return run(this.db, 'DELETE FROM company_sources WHERE company_id = ?', [companyId]).changes;
  }
}
