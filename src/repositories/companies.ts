/** companies 表（公司主档：CRUD / keyset 分页 / 去重查询 / 覆盖度统计） */
import { LeadError } from '../shared/errors.js';
import { newCompanyId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { decodeCursor, encodeCursor } from '../domain/pagination.js';
import { normalizeCompanyName } from '../domain/normalize.js';
import { all, countRows, fromDbBoolRequired, fromDbInt, fromJsonArray, fromJsonObject, fromJsonUnknown, one, run, toJson, toJsonArray, type DbConnection } from './sql.js';
import type {
  CompanyListOptions,
  CompanyPatch,
  CompanyStats,
  CompanyUpdateOptions,
  CursorPage,
  NewCompany,
} from './types.js';
import type { Company, EnrichmentStatus, Platform, UnlockStatus } from '../shared/domain.js';

interface CompanyRow {
  id: string;
  uscc: string | null;
  tanji_company_id: string | null;
  name: string;
  normalized_name: string;
  english_name: string | null;
  legal_representative: string | null;
  reg_capital: string | null;
  found_time: string | null;
  oper_status: string | null;
  industry: string | null;
  scale: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  business_scope: string | null;
  homepage: string | null;
  phone_count: number | null;
  email_count: number | null;
  contact_count: number | null;
  trade_tags: string;
  extra: string | null;
  source_count: number;
  verified: number;
  enrichment_status: string;
  unlock_status: string;
  match_meta: string | null;
  first_run_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  merged_into: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function mapCompanyRow(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    englishName: row.english_name,
    uscc: row.uscc,
    tanjiCompanyId: row.tanji_company_id,
    legalRepresentative: row.legal_representative,
    regCapital: row.reg_capital,
    foundTime: row.found_time,
    operStatus: row.oper_status,
    industry: row.industry,
    scale: row.scale,
    province: row.province,
    city: row.city,
    district: row.district,
    address: row.address,
    businessScope: row.business_scope,
    homepage: row.homepage,
    phoneCount: row.phone_count,
    emailCount: row.email_count,
    contactCount: row.contact_count,
    tradeTags: fromJsonArray<string>(row.trade_tags),
    extra: fromJsonObject(row.extra),
    sourceCount: Number(row.source_count ?? 0),
    verified: Number(row.verified ?? 0) === 1,
    enrichmentStatus: row.enrichment_status as EnrichmentStatus,
    unlockStatus: row.unlock_status as UnlockStatus,
    matchMeta: fromJsonUnknown(row.match_meta, null) as Company['matchMeta'],
    firstRunId: row.first_run_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    mergedInto: row.merged_into,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface KeysetCursor {
  updatedAt: string;
  id: string;
}

function decodeCompanyCursor(cursor: string): KeysetCursor {
  const value = decodeCursor<Partial<KeysetCursor>>(cursor);
  if (typeof value?.updatedAt !== 'string' || typeof value?.id !== 'string') {
    throw new LeadError('VALIDATION_ERROR', 'invalid companies cursor');
  }
  return { updatedAt: value.updatedAt, id: value.id };
}

export class CompaniesRepository {
  constructor(private readonly db: DbConnection) {}

  create(input: NewCompany): Company {
    const id = input.id ?? newCompanyId();
    const now = nowIso();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const normalizedName = input.normalizedName ?? normalizeCompanyName(input.name);
    run(
      this.db,
      `INSERT INTO companies(
        id, uscc, tanji_company_id, name, normalized_name, english_name,
        legal_representative, reg_capital, found_time, oper_status, industry, scale,
        province, city, district, address, business_scope, homepage,
        phone_count, email_count, contact_count, trade_tags, extra, source_count, verified,
        enrichment_status, unlock_status, match_meta, first_run_id,
        first_seen_at, last_seen_at, merged_into, version, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.uscc ?? null,
        input.tanjiCompanyId ?? null,
        input.name,
        normalizedName,
        input.englishName ?? null,
        input.legalRepresentative ?? null,
        input.regCapital ?? null,
        input.foundTime ?? null,
        input.operStatus ?? null,
        input.industry ?? null,
        input.scale ?? null,
        input.province ?? null,
        input.city ?? null,
        input.district ?? null,
        input.address ?? null,
        input.businessScope ?? null,
        input.homepage ?? null,
        input.phoneCount ?? null,
        input.emailCount ?? null,
        input.contactCount ?? null,
        toJsonArray(input.tradeTags ?? []),
        toJson(input.extra ?? null),
        input.sourceCount ?? 0,
        input.verified === false ? 0 : 1,
        input.enrichmentStatus ?? 'discovered',
        input.unlockStatus ?? 'none',
        toJson(input.matchMeta ?? null),
        input.firstRunId ?? null,
        input.firstSeenAt ?? now,
        input.lastSeenAt ?? now,
        null,
        input.version ?? 1,
        createdAt,
        updatedAt,
      ],
    );
    return this.requireById(id);
  }

  getById(id: string, opts: { includeMerged?: boolean } = {}): Company | null {
    const row = one<CompanyRow>(this.db, 'SELECT * FROM companies WHERE id = ?', [id]);
    if (!row) return null;
    if (!opts.includeMerged && row.merged_into) return null;
    return mapCompanyRow(row);
  }

  findById(id: string): Company | null {
    return this.getById(id);
  }

  getManyByIds(ids: string[], opts: { includeMerged?: boolean } = {}): Company[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const rows = all<CompanyRow>(
      this.db,
      `SELECT * FROM companies WHERE id IN (${unique.map(() => '?').join(',')})`,
      unique,
    );
    return rows
      .filter((row) => opts.includeMerged || !row.merged_into)
      .map(mapCompanyRow);
  }

  findByUscc(uscc: string): Company | null {
    const row = one<CompanyRow>(this.db, 'SELECT * FROM companies WHERE uscc = ?', [uscc]);
    return row ? mapCompanyRow(row) : null;
  }

  findByTanjiId(tanjiCompanyId: string): Company | null {
    const row = one<CompanyRow>(
      this.db,
      'SELECT * FROM companies WHERE tanji_company_id = ?',
      [tanjiCompanyId],
    );
    return row ? mapCompanyRow(row) : null;
  }

  /**
   * 按归一化名查公司（去重兜底）：
   * 同省（可选同市）优先；不包含已合并主体。
   */
  findByNormalizedName(
    normalizedName: string,
    opts: { province?: string; city?: string } = {},
  ): Company[] {
    const where: string[] = ['normalized_name = ?', 'merged_into IS NULL'];
    const params: unknown[] = [normalizedName];
    if (opts.province) {
      where.push('(province = ? OR province IS NULL)');
      params.push(opts.province);
    }
    const rows = all<CompanyRow>(
      this.db,
      `SELECT * FROM companies WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
      params,
    );
    const companies = rows.map(mapCompanyRow);
    if (opts.city) {
      const inCity = companies.filter((c) => !c.city || c.city === opts.city);
      if (inCity.length > 0) return inCity;
    }
    return companies;
  }

  findFirstByNormalizedName(
    normalizedName: string,
    opts: { province?: string; city?: string } = {},
  ): Company | null {
    return this.findByNormalizedName(normalizedName, opts)[0] ?? null;
  }

  /** 局部更新：undefined = 不改；null = 置空 */
  update(id: string, patch: CompanyPatch, opts: CompanyUpdateOptions = {}): Company {
    // 写入探迹主体 ID = 自动升级为 verified company（调用方无需额外传 verified）
    if (patch.tanjiCompanyId && patch.verified === undefined) {
      patch = { ...patch, verified: true };
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.name !== undefined) {
      push('name', patch.name);
      if (patch.normalizedName === undefined) push('normalized_name', normalizeCompanyName(patch.name));
    }
    if (patch.normalizedName !== undefined) push('normalized_name', patch.normalizedName);
    if (patch.englishName !== undefined) push('english_name', patch.englishName);
    if (patch.uscc !== undefined) push('uscc', patch.uscc);
    if (patch.tanjiCompanyId !== undefined) push('tanji_company_id', patch.tanjiCompanyId);
    if (patch.legalRepresentative !== undefined) push('legal_representative', patch.legalRepresentative);
    if (patch.regCapital !== undefined) push('reg_capital', patch.regCapital);
    if (patch.foundTime !== undefined) push('found_time', patch.foundTime);
    if (patch.operStatus !== undefined) push('oper_status', patch.operStatus);
    if (patch.industry !== undefined) push('industry', patch.industry);
    if (patch.scale !== undefined) push('scale', patch.scale);
    if (patch.province !== undefined) push('province', patch.province);
    if (patch.city !== undefined) push('city', patch.city);
    if (patch.district !== undefined) push('district', patch.district);
    if (patch.address !== undefined) push('address', patch.address);
    if (patch.businessScope !== undefined) push('business_scope', patch.businessScope);
    if (patch.homepage !== undefined) push('homepage', patch.homepage);
    if (patch.phoneCount !== undefined) push('phone_count', patch.phoneCount);
    if (patch.emailCount !== undefined) push('email_count', patch.emailCount);
    if (patch.contactCount !== undefined) push('contact_count', patch.contactCount);
    if (patch.tradeTags !== undefined) push('trade_tags', toJsonArray(patch.tradeTags));
    if (patch.extra !== undefined) push('extra', toJson(patch.extra));
    if (patch.sourceCount !== undefined) push('source_count', patch.sourceCount);
    if (patch.verified !== undefined) push('verified', patch.verified ? 1 : 0);
    if (patch.enrichmentStatus !== undefined) push('enrichment_status', patch.enrichmentStatus);
    if (patch.unlockStatus !== undefined) push('unlock_status', patch.unlockStatus);
    if (patch.matchMeta !== undefined) push('match_meta', toJson(patch.matchMeta));
    if (patch.firstRunId !== undefined) push('first_run_id', patch.firstRunId);
    if (patch.lastSeenAt !== undefined) push('last_seen_at', patch.lastSeenAt);
    if (patch.mergedInto !== undefined) push('merged_into', patch.mergedInto);

    const bump = opts.bumpVersion !== false;
    if (bump) sets.push('version = version + 1');
    sets.push('updated_at = ?');
    params.push(nowIso());

    let sql = `UPDATE companies SET ${sets.join(', ')} WHERE id = ?`;
    params.push(id);
    if (opts.expectedVersion !== undefined) {
      sql += ' AND version = ?';
      params.push(opts.expectedVersion);
    }
    const result = run(this.db, sql, params);
    if (result.changes === 0) {
      const existing = this.getById(id, { includeMerged: true });
      if (!existing) throw new LeadError('NOT_FOUND', `company not found: ${id}`);
      throw new LeadError('CONFLICT', `company version conflict: ${id}`, {
        details: { expectedVersion: opts.expectedVersion, currentVersion: existing.version },
      });
    }
    return this.requireById(id);
  }

  /** 只刷新 last_seen_at（不动 version，避免产生变更事件） */
  touchLastSeen(id: string, at: string = nowIso()): Company {
    return this.update(id, { lastSeenAt: at }, { bumpVersion: false });
  }

  updateEnrichmentStatus(id: string, status: EnrichmentStatus): Company {
    return this.update(id, { enrichmentStatus: status });
  }

  updateUnlockStatus(id: string, status: UnlockStatus): Company {
    return this.update(id, { unlockStatus: status });
  }

  setMatchMeta(id: string, matchMeta: Company['matchMeta']): Company {
    return this.update(id, { matchMeta });
  }

  setTanjiCompanyId(id: string, tanjiCompanyId: string | null): Company {
    // 探迹确认主体 = 升级为 verified company；清空 tanji id 不影响既有 verified
    if (tanjiCompanyId) {
      const row = one<{ verified: number }>(this.db, 'SELECT verified FROM companies WHERE id = ?', [id]);
      if (row && Number(row.verified) !== 1) {
        this.update(id, { tanjiCompanyId, verified: true });
        return this.requireById(id);
      }
    }
    return this.update(id, { tanjiCompanyId });
  }

  setVerified(id: string, verified: boolean): Company {
    return this.update(id, { verified });
  }

  setUscc(id: string, uscc: string | null): Company {
    return this.update(id, { uscc });
  }

  updateEnglishName(id: string, englishName: string | null): Company {
    return this.update(id, { englishName });
  }

  /** 软合并：source 指向 target（对外只暴露存活主体） */
  mergeInto(sourceId: string, targetId: string): boolean {
    if (sourceId === targetId) return false;
    return (
      run(this.db, 'UPDATE companies SET merged_into = ?, updated_at = ? WHERE id = ? AND merged_into IS NULL', [
        targetId,
        nowIso(),
        sourceId,
      ]).changes > 0
    );
  }

  // -------------------------------------------------------------------------
  // 列表 / 统计
  // -------------------------------------------------------------------------

  /** keyset 分页（updated_at DESC, id DESC；支持基础过滤） */
  listKeyset(opts: CompanyListOptions = {}): CursorPage<Company> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeMerged) where.push('merged_into IS NULL');
    if (opts.verified === true) where.push('verified = 1');
    else if (opts.verified === false) where.push('verified = 0');
    if (opts.province) {
      where.push('province = ?');
      params.push(opts.province);
    }
    if (opts.city) {
      where.push('city = ?');
      params.push(opts.city);
    }
    if (opts.enrichmentStatus !== undefined) {
      const values = Array.isArray(opts.enrichmentStatus) ? opts.enrichmentStatus : [opts.enrichmentStatus];
      where.push(`enrichment_status IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
    if (opts.unlockStatus !== undefined) {
      const values = Array.isArray(opts.unlockStatus) ? opts.unlockStatus : [opts.unlockStatus];
      where.push(`unlock_status IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
    if (opts.sourcePlatform) {
      where.push('EXISTS (SELECT 1 FROM company_sources cs WHERE cs.company_id = companies.id AND cs.platform = ?)');
      params.push(opts.sourcePlatform);
    }
    if (opts.q) {
      const like = `%${escapeLike(opts.q)}%`;
      where.push(
        "(name LIKE ? ESCAPE '\\' OR COALESCE(english_name,'') LIKE ? ESCAPE '\\' OR COALESCE(uscc,'') LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const cursor = opts.cursor ? decodeCompanyCursor(opts.cursor) : null;
    if (cursor) {
      where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const sql = `SELECT * FROM companies ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC, id DESC LIMIT ?`;
    const rows = all<CompanyRow>(this.db, sql, [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapCompanyRow);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null;
    return { items, nextCursor, hasMore };
  }

  list(opts: CompanyListOptions & { offset?: number } = {}): Company[] {
    // 简化版 offset 列表（列表页数据量小；主路径用 listKeyset）
    const page = this.listKeyset({ ...opts, limit: Math.min((opts.limit ?? 50) + (opts.offset ?? 0), 500) });
    return page.items.slice(opts.offset ?? 0);
  }

  listByEnrichmentStatus(status: EnrichmentStatus, limit = 100): Company[] {
    return all<CompanyRow>(
      this.db,
      `SELECT * FROM companies WHERE enrichment_status = ? AND merged_into IS NULL
       ORDER BY created_at ASC LIMIT ?`,
      [status, limit],
    ).map(mapCompanyRow);
  }

  listUnmatched(limit = 100): Company[] {
    return all<CompanyRow>(
      this.db,
      `SELECT * FROM companies WHERE enrichment_status = 'unmatched' AND merged_into IS NULL
       ORDER BY last_seen_at ASC LIMIT ?`,
      [limit],
    ).map(mapCompanyRow);
  }

  listDiscovered(limit = 100): Company[] {
    return this.listByEnrichmentStatus('discovered', limit);
  }

  /**
   * 待海关补全的 Ali/Mic 公司（有 ali/mic 来源、无 customs 画像行）。
   * 用于 Customs Worker 的增量入队。
   */
  listAliMicMissingCustoms(limit = 200): Company[] {
    return all<CompanyRow>(
      this.db,
      `SELECT c.* FROM companies c
       WHERE c.merged_into IS NULL AND c.verified = 1
         AND EXISTS (SELECT 1 FROM company_sources cs WHERE cs.company_id = c.id AND cs.platform IN ('ali','mic'))
         AND NOT EXISTS (SELECT 1 FROM company_customs_profiles p WHERE p.company_id = c.id)
       ORDER BY c.created_at ASC LIMIT ?`,
      [limit],
    ).map(mapCompanyRow);
  }

  listAliMicUncustomed(limit = 200): Company[] {
    return this.listAliMicMissingCustoms(limit);
  }

  listWithPlatformSources(platform: Platform, limit = 200): Company[] {
    return all<CompanyRow>(
      this.db,
      `SELECT c.* FROM companies c
       WHERE c.merged_into IS NULL AND c.verified = 1
         AND EXISTS (SELECT 1 FROM company_sources cs WHERE cs.company_id = c.id AND cs.platform = ?)
       ORDER BY c.created_at ASC LIMIT ?`,
      [platform, limit],
    ).map(mapCompanyRow);
  }

  count(filter: Omit<CompanyListOptions, 'limit' | 'cursor'> = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeMerged) where.push('merged_into IS NULL');
    if (filter.verified === true) where.push('verified = 1');
    else if (filter.verified === false) where.push('verified = 0');
    if (filter.province) {
      where.push('province = ?');
      params.push(filter.province);
    }
    if (filter.city) {
      where.push('city = ?');
      params.push(filter.city);
    }
    if (filter.enrichmentStatus !== undefined) {
      const values = Array.isArray(filter.enrichmentStatus) ? filter.enrichmentStatus : [filter.enrichmentStatus];
      where.push(`enrichment_status IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
    if (filter.unlockStatus !== undefined) {
      const values = Array.isArray(filter.unlockStatus) ? filter.unlockStatus : [filter.unlockStatus];
      where.push(`unlock_status IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
    if (filter.sourcePlatform) {
      where.push('EXISTS (SELECT 1 FROM company_sources cs WHERE cs.company_id = companies.id AND cs.platform = ?)');
      params.push(filter.sourcePlatform);
    }
    if (filter.q) {
      const like = `%${escapeLike(filter.q)}%`;
      where.push(
        "(name LIKE ? ESCAPE '\\' OR COALESCE(english_name,'') LIKE ? ESCAPE '\\' OR COALESCE(uscc,'') LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like);
    }
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM companies ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      params,
    );
  }

  stats(): CompanyStats {
    const byEnrichment: Record<string, number> = {};
    const byUnlock: Record<string, number> = {};
    const bySourcePlatform: Record<string, number> = {};
    for (const row of all<{ k: string; n: number }>(
      this.db,
      "SELECT enrichment_status AS k, COUNT(*) AS n FROM companies WHERE merged_into IS NULL AND verified = 1 GROUP BY enrichment_status",
    )) {
      byEnrichment[row.k] = Number(row.n);
    }
    for (const row of all<{ k: string; n: number }>(
      this.db,
      "SELECT unlock_status AS k, COUNT(*) AS n FROM companies WHERE merged_into IS NULL AND verified = 1 GROUP BY unlock_status",
    )) {
      byUnlock[row.k] = Number(row.n);
    }
    for (const row of all<{ k: string; n: number }>(
      this.db,
      'SELECT platform AS k, COUNT(DISTINCT company_id) AS n FROM company_sources GROUP BY platform',
    )) {
      bySourcePlatform[row.k] = Number(row.n);
    }
    return {
      total: this.count({ verified: true }),
      merged: countRows(this.db, 'SELECT COUNT(*) FROM companies WHERE merged_into IS NOT NULL'),
      byEnrichment,
      byUnlock,
      bySourcePlatform,
    };
  }

  /** 覆盖度：公司按城市计数（仅存活主体） */
  coverageByCity(): Record<string, number> {
    const rows = all<{ city: string | null; n: number }>(
      this.db,
      `SELECT COALESCE(city, '(unknown)') AS city, COUNT(*) AS n FROM companies
       WHERE merged_into IS NULL AND verified = 1 GROUP BY COALESCE(city, '(unknown)')`,
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.city ?? '(unknown)'] = Number(row.n);
    return out;
  }

  /** 覆盖度：跨两个及以上来源的公司数 */
  crossSourceOverlapCount(): number {
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM (
         SELECT cs.company_id FROM company_sources cs JOIN companies c ON c.id = cs.company_id
          WHERE c.verified = 1 AND c.merged_into IS NULL
          GROUP BY cs.company_id HAVING COUNT(DISTINCT cs.platform) > 1
       )`,
    );
  }

  /** 覆盖度：有指定平台来源的公司数 */
  countDistinctBySourcePlatform(platform: Platform): number {
    return countRows(
      this.db,
      'SELECT COUNT(DISTINCT cs.company_id) FROM company_sources cs JOIN companies c ON c.id=cs.company_id WHERE cs.platform = ? AND c.verified=1',
      [platform],
    );
  }

  countBySourcePlatform(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all<{ platform: string; n: number }>(
      this.db,
      'SELECT platform, COUNT(DISTINCT company_id) AS n FROM company_sources GROUP BY platform',
    )) {
      out[row.platform] = Number(row.n);
    }
    return out;
  }

  /** 该 run 首次发现的存活公司数（Run 统计用） */
  countByFirstRun(runId: string): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM companies WHERE first_run_id = ? AND merged_into IS NULL AND verified = 1', [runId]);
  }

  private requireById(id: string): Company {
    const company = this.getById(id, { includeMerged: true });
    if (!company) throw new LeadError('NOT_FOUND', `company not found: ${id}`);
    return company;
  }
}

/** LIKE 通配符转义（配合 ESCAPE '\'） */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
