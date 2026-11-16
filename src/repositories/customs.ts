/** company_customs_profiles 表（Ali/Mic 海关画像，每公司 1 行） */
import { LeadError } from '../shared/errors.js';
import { isoPlusDays, nowIso } from '../shared/time.js';
import {
  all,
  countRows,
  fromDbBool,
  fromDbBoolRequired,
  fromJson,
  fromJsonArray,
  fromJsonUnknown,
  one,
  run,
  toIso,
  toJson,
  toJsonArray,
  type DbConnection,
} from './sql.js';
import type {
  CustomsProfileRecord,
  CustomsProfileUpsertResult,
  NewCustomsProfile,
} from './types.js';
import type { CustomsProfile } from '../shared/domain.js';

interface CustomsRow {
  company_id: string;
  english_name: string | null;
  chinese_name: string | null;
  query_names: string;
  upstream_totals: string | null;
  fetched_records: number;
  matched_records: number;
  exporter_records: number;
  importer_records: number;
  unmatched_records: number;
  date_min: string | null;
  date_max: string | null;
  destinations: string | null;
  origins: string | null;
  hs4: string | null;
  products: string | null;
  buyers: string | null;
  suppliers: string | null;
  total_weight: number | null;
  total_count: number | null;
  amount: number | null;
  sample_records: string | null;
  confidence: string;
  account_id: string | null;
  source: string;
  cached: number | null;
  cached_at: string | null;
  expires_at: string | null;
  upstream_version: string | null;
  sampled: number;
  fetched_at: string;
  next_refresh_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function mapCustomsProfile(row: CustomsRow): CustomsProfileRecord {
  return {
    companyId: row.company_id,
    englishName: row.english_name,
    chineseName: row.chinese_name,
    queryNames: fromJsonArray<string>(row.query_names),
    upstreamTotals: fromJsonUnknown(row.upstream_totals, null),
    fetchedRecords: Number(row.fetched_records ?? 0),
    matchedRecords: Number(row.matched_records ?? 0),
    exporterRecords: Number(row.exporter_records ?? 0),
    importerRecords: Number(row.importer_records ?? 0),
    unmatchedRecords: Number(row.unmatched_records ?? 0),
    dateMin: row.date_min,
    dateMax: row.date_max,
    destinations: fromJsonUnknown(row.destinations, null),
    origins: fromJsonUnknown(row.origins, null),
    hs4: fromJsonUnknown(row.hs4, null),
    products: fromJsonUnknown(row.products, null),
    buyers: fromJsonUnknown(row.buyers, null),
    suppliers: fromJsonUnknown(row.suppliers, null),
    totalWeight: row.total_weight,
    totalCount: row.total_count,
    amount: row.amount,
    sampleRecords: fromJsonUnknown(row.sample_records, null),
    confidence: row.confidence as CustomsProfile['confidence'],
    accountId: row.account_id,
    source: row.source,
    cached: fromDbBool(row.cached),
    cachedAt: row.cached_at,
    expiresAt: row.expires_at,
    upstreamVersion: row.upstream_version,
    sampled: fromDbBoolRequired(row.sampled),
    fetchedAt: row.fetched_at,
    nextRefreshAt: row.next_refresh_at,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CustomsProfilesRepositoryOptions {
  refreshDays?: number;
}

export class CustomsProfilesRepository {
  private readonly refreshDays: number;

  constructor(
    private readonly db: DbConnection,
    opts: CustomsProfilesRepositoryOptions = {},
  ) {
    this.refreshDays = opts.refreshDays ?? 30;
  }

  /**
   * upsert 海关画像：
   * - previous 供调用方判断是否有变化
   * - version：显式传则使用；否则 previous.version+1（新建=1）
   */
  upsert(input: NewCustomsProfile): CustomsProfileUpsertResult {
    return this.db.transaction(() => {
      const previous = this.getByCompany(input.companyId);
      const now = nowIso();
      const fetchedAt = input.fetchedAt ?? now;
      const nextRefreshAt =
        input.nextRefreshAt === undefined ? isoPlusDays(this.refreshDays) : input.nextRefreshAt;
      const merged: Required<Pick<NewCustomsProfile, 'companyId'>> & Record<string, unknown> = {
        companyId: input.companyId,
        englishName: pick(input.englishName, previous?.englishName ?? null),
        chineseName: pick(input.chineseName, previous?.chineseName ?? null),
        queryNames: pick(input.queryNames, previous?.queryNames ?? []),
        upstreamTotals: pick(input.upstreamTotals, previous?.upstreamTotals ?? null),
        fetchedRecords: pick(input.fetchedRecords, previous?.fetchedRecords ?? 0),
        matchedRecords: pick(input.matchedRecords, previous?.matchedRecords ?? 0),
        exporterRecords: pick(input.exporterRecords, previous?.exporterRecords ?? 0),
        importerRecords: pick(input.importerRecords, previous?.importerRecords ?? 0),
        unmatchedRecords: pick(input.unmatchedRecords, previous?.unmatchedRecords ?? 0),
        dateMin: pick(input.dateMin, previous?.dateMin ?? null),
        dateMax: pick(input.dateMax, previous?.dateMax ?? null),
        destinations: pick(input.destinations, previous?.destinations ?? null),
        origins: pick(input.origins, previous?.origins ?? null),
        hs4: pick(input.hs4, previous?.hs4 ?? null),
        products: pick(input.products, previous?.products ?? null),
        buyers: pick(input.buyers, previous?.buyers ?? null),
        suppliers: pick(input.suppliers, previous?.suppliers ?? null),
        totalWeight: pick(input.totalWeight, previous?.totalWeight ?? null),
        totalCount: pick(input.totalCount, previous?.totalCount ?? null),
        amount: pick(input.amount, previous?.amount ?? null),
        sampleRecords: pick(input.sampleRecords, previous?.sampleRecords ?? null),
        confidence: pick(input.confidence, previous?.confidence ?? 'none'),
        accountId: pick(input.accountId, previous?.accountId ?? null),
        source: pick(input.source, previous?.source ?? 'fuma'),
        cached: pick(input.cached, previous?.cached ?? null),
        cachedAt: pick(input.cachedAt, previous?.cachedAt ?? null),
        expiresAt: pick(input.expiresAt, previous?.expiresAt ?? null),
        upstreamVersion: pick(input.upstreamVersion, previous?.upstreamVersion ?? null),
        sampled: pick(input.sampled, previous?.sampled ?? true),
      };
      const version = input.version ?? (previous ? previous.version + 1 : 1);

      if (!previous) {
        run(
          this.db,
          `INSERT INTO company_customs_profiles(
            company_id, english_name, chinese_name, query_names, upstream_totals,
            fetched_records, matched_records, exporter_records, importer_records, unmatched_records,
            date_min, date_max, destinations, origins, hs4, products, buyers, suppliers,
            total_weight, total_count, amount, sample_records, confidence, account_id, source,
            cached, cached_at, expires_at, upstream_version, sampled, fetched_at, next_refresh_at,
            version, created_at, updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            merged.companyId,
            merged.englishName,
            merged.chineseName,
            toJsonArray(merged.queryNames),
            toJson(merged.upstreamTotals),
            merged.fetchedRecords,
            merged.matchedRecords,
            merged.exporterRecords,
            merged.importerRecords,
            merged.unmatchedRecords,
            merged.dateMin,
            merged.dateMax,
            toJson(merged.destinations),
            toJson(merged.origins),
            toJson(merged.hs4),
            toJson(merged.products),
            toJson(merged.buyers),
            toJson(merged.suppliers),
            merged.totalWeight,
            merged.totalCount,
            merged.amount,
            toJson(merged.sampleRecords),
            merged.confidence,
            merged.accountId,
            merged.source,
            merged.cached === null ? null : merged.cached ? 1 : 0,
            merged.cachedAt,
            merged.expiresAt,
            merged.upstreamVersion,
            merged.sampled ? 1 : 0,
            fetchedAt,
            nextRefreshAt,
            version,
            now,
            now,
          ],
        );
        const profile = this.requireByCompany(input.companyId);
        return { profile, previous: null, created: true };
      }

      run(
        this.db,
        `UPDATE company_customs_profiles SET
           english_name = ?, chinese_name = ?, query_names = ?, upstream_totals = ?,
           fetched_records = ?, matched_records = ?, exporter_records = ?, importer_records = ?,
           unmatched_records = ?, date_min = ?, date_max = ?, destinations = ?, origins = ?, hs4 = ?,
           products = ?, buyers = ?, suppliers = ?, total_weight = ?, total_count = ?, amount = ?,
           sample_records = ?, confidence = ?, account_id = ?, source = ?, cached = ?, cached_at = ?,
           expires_at = ?, upstream_version = ?, sampled = ?, fetched_at = ?, next_refresh_at = ?,
           version = ?, updated_at = ?
         WHERE company_id = ?`,
        [
          merged.englishName,
          merged.chineseName,
          toJsonArray(merged.queryNames),
          toJson(merged.upstreamTotals),
          merged.fetchedRecords,
          merged.matchedRecords,
          merged.exporterRecords,
          merged.importerRecords,
          merged.unmatchedRecords,
          merged.dateMin,
          merged.dateMax,
          toJson(merged.destinations),
          toJson(merged.origins),
          toJson(merged.hs4),
          toJson(merged.products),
          toJson(merged.buyers),
          toJson(merged.suppliers),
          merged.totalWeight,
          merged.totalCount,
          merged.amount,
          toJson(merged.sampleRecords),
          merged.confidence,
          merged.accountId,
          merged.source,
          merged.cached === null ? null : merged.cached ? 1 : 0,
          merged.cachedAt,
          merged.expiresAt,
          merged.upstreamVersion,
          merged.sampled ? 1 : 0,
          fetchedAt,
          merged.nextRefreshAt,
          version,
          now,
          merged.companyId,
        ],
      );
      return { profile: this.requireByCompany(input.companyId), previous, created: false };
    });
  }

  getByCompany(companyId: string): CustomsProfileRecord | null {
    const row = one<CustomsRow>(this.db, 'SELECT * FROM company_customs_profiles WHERE company_id = ?', [
      companyId,
    ]);
    return row ? mapCustomsProfile(row) : null;
  }

  getByCompanyId(companyId: string): CustomsProfileRecord | null {
    return this.getByCompany(companyId);
  }

  listByCompanyIds(ids: string[]): CustomsProfileRecord[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    return all<CustomsRow>(
      this.db,
      `SELECT * FROM company_customs_profiles WHERE company_id IN (${unique.map(() => '?').join(',')})`,
      unique,
    ).map(mapCustomsProfile);
  }

  getByCompanyIds(ids: string[]): CustomsProfileRecord[] {
    return this.listByCompanyIds(ids);
  }

  /** 到期刷新（next_refresh_at 为空视为到期） */
  listDue(opts: { now?: Date; limit?: number } = {}): CustomsProfileRecord[] {
    const now = toIso(opts.now);
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    return all<CustomsRow>(
      this.db,
      `SELECT * FROM company_customs_profiles
       WHERE next_refresh_at IS NULL OR next_refresh_at <= ?
       ORDER BY COALESCE(next_refresh_at, '') ASC, updated_at ASC LIMIT ?`,
      [now, limit],
    ).map(mapCustomsProfile);
  }

  listByConfidence(confidence: CustomsProfile['confidence'], limit = 100): CustomsProfileRecord[] {
    return all<CustomsRow>(
      this.db,
      'SELECT * FROM company_customs_profiles WHERE confidence = ? ORDER BY fetched_at DESC LIMIT ?',
      [confidence, limit],
    ).map(mapCustomsProfile);
  }

  countByConfidence(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all<{ confidence: string; n: number }>(
      this.db,
      'SELECT confidence, COUNT(*) AS n FROM company_customs_profiles GROUP BY confidence',
    )) {
      out[row.confidence] = Number(row.n);
    }
    return out;
  }

  countDue(now: Date | string = new Date()): number {
    return countRows(
      this.db,
      'SELECT COUNT(*) FROM company_customs_profiles WHERE next_refresh_at IS NULL OR next_refresh_at <= ?',
      [toIso(now)],
    );
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_customs_profiles');
  }

  deleteByCompany(companyId: string): boolean {
    return (
      run(this.db, 'DELETE FROM company_customs_profiles WHERE company_id = ?', [companyId]).changes > 0
    );
  }

  private requireByCompany(companyId: string): CustomsProfileRecord {
    const profile = this.getByCompany(companyId);
    if (!profile) throw new LeadError('NOT_FOUND', `customs profile not found: ${companyId}`);
    return profile;
  }
}
