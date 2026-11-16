/**
 * 海关画像读服务（docs/03 §4 海关画像卡片；docs/08）。
 *
 * 路由（D1）可直接调用：
 *  - getCompanyCustoms(companyId)        → 海关画像视图（无画像/非 Ali/Mic → null，路由转 404）
 *  - createCustomsRefreshJob(companyId)  → 手动刷新入队（202 + job）
 */
import type { Repositories } from '../repositories/index.js';
import type { CustomsProfile } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { CUSTOMS_STAGE, resolveCustomsCompanyIdentity } from '../pipeline/customs.js';
import { nowIso } from '../shared/time.js';
import { asArray, asRecord } from '../shared/json.js';
import { getDefaultRepositories } from './repositoryAccess.js';

export interface CustomsTopEntryView {
  key: string;
  count: number;
}

export interface CustomsTotalsView {
  totalNum: number | null;
  allCount: number | null;
  source: string | null;
  cached: boolean | null;
}

export interface CustomsSampleRecordView {
  role: string;
  inout: string | null;
  rawimporter: string | null;
  rawexporter: string | null;
  importercountryen: string | null;
  exportercountryen: string | null;
  hscode: string | null;
  detail: string | null;
  regdate: string | null;
  tradeno: string | null;
  blnumber: string | null;
}

export interface CustomsView {
  status: string;
  confidence: string;
  sampled: boolean;
  englishName: string | null;
  chineseName: string | null;
  queryNames: string[];
  totals: {
    importView: CustomsTotalsView | null;
    exportView: CustomsTotalsView | null;
  };
  sample: {
    fetched: number;
    matched: number;
    asExporter: number;
    asImporter: number;
    unmatched: number;
  };
  dateRange: { min: string | null; max: string | null } | null;
  topDestinations: CustomsTopEntryView[];
  topOrigins: CustomsTopEntryView[];
  topHs4: CustomsTopEntryView[];
  topProducts: CustomsTopEntryView[];
  topBuyers: CustomsTopEntryView[];
  topSuppliers: CustomsTopEntryView[];
  sampleRecords: CustomsSampleRecordView[];
  totalWeight: number | null;
  totalCount: number | null;
  amount: number | null;
  cached: boolean | null;
  cachedAt: string | null;
  expiresAt: string | null;
  upstreamVersion: string | null;
  accountId: string | null;
  lastFetchedAt: string;
  nextRefreshAt: string | null;
  version: number;
}

export interface CustomsRefreshJobResult {
  jobId: string;
}

function asTopEntries(value: unknown, limit = 20): CustomsTopEntryView[] {
  return asArray<Record<string, unknown>>(value)
    .map((entry) => ({ key: String(entry.key ?? ''), count: Number(entry.count ?? 0) }))
    .filter((entry) => entry.key.length > 0 && Number.isFinite(entry.count))
    .slice(0, limit);
}

function asTotalsView(query: Record<string, unknown> | null): CustomsTotalsView | null {
  if (!query) return null;
  const totalNum = query.totalNum ?? query.allCount ?? null;
  return {
    totalNum: totalNum === null || totalNum === undefined ? null : Number(totalNum),
    allCount: query.allCount === null || query.allCount === undefined ? null : Number(query.allCount),
    source: typeof query.source === 'string' ? query.source : null,
    cached: typeof query.cached === 'boolean' ? query.cached : null,
  };
}

/** 从 company_customs_profiles 行构造接口视图（纯函数，便于测试） */
export function buildCustomsView(profile: CustomsProfile | null): CustomsView | null {
  if (!profile) return null;
  const upstream = asRecord(profile.upstreamTotals);
  const queries = asArray<Record<string, unknown>>(upstream.queries);
  const importQuery = queries.find((q) => Number(q.flag) === 1) ?? null;
  const exportQuery = queries.find((q) => Number(q.flag) === 2) ?? null;
  const status = typeof upstream.status === 'string' ? upstream.status : profile.confidence === 'none' ? 'no_data' : 'ok';
  const destinations = asTopEntries(profile.destinations);
  const origins = asTopEntries(profile.origins);
  const hs4 = asTopEntries(profile.hs4);
  const products = asTopEntries(profile.products);
  const buyers = asTopEntries(profile.buyers);
  const suppliers = asTopEntries(profile.suppliers);
  return {
    status,
    confidence: profile.confidence,
    sampled: profile.sampled === true,
    englishName: profile.englishName,
    chineseName: profile.chineseName,
    queryNames: asArray<string>(profile.queryNames),
    totals: {
      importView: asTotalsView(importQuery),
      exportView: asTotalsView(exportQuery),
    },
    sample: {
      fetched: profile.fetchedRecords,
      matched: profile.matchedRecords,
      asExporter: profile.exporterRecords,
      asImporter: profile.importerRecords,
      unmatched: profile.unmatchedRecords,
    },
    dateRange: profile.dateMin || profile.dateMax ? { min: profile.dateMin, max: profile.dateMax } : null,
    topDestinations: destinations,
    topOrigins: origins,
    topHs4: hs4,
    topProducts: products,
    topBuyers: buyers,
    topSuppliers: suppliers,
    sampleRecords: asArray<Record<string, unknown>>(profile.sampleRecords).map((r) => ({
      role: String(r.role ?? ''),
      inout: (r.inout ?? null) as string | null,
      rawimporter: (r.rawimporter ?? null) as string | null,
      rawexporter: (r.rawexporter ?? null) as string | null,
      importercountryen: (r.importercountryen ?? null) as string | null,
      exportercountryen: (r.exportercountryen ?? null) as string | null,
      hscode: (r.hscode ?? null) as string | null,
      detail: (r.detail ?? null) as string | null,
      regdate: (r.regdate ?? null) as string | null,
      tradeno: (r.tradeno ?? null) as string | null,
      blnumber: (r.blnumber ?? null) as string | null,
    })),
    totalWeight: profile.totalWeight,
    totalCount: profile.totalCount,
    amount: profile.amount,
    cached: profile.cached,
    cachedAt: profile.cachedAt,
    expiresAt: profile.expiresAt,
    upstreamVersion: profile.upstreamVersion,
    accountId: profile.accountId,
    lastFetchedAt: profile.fetchedAt,
    nextRefreshAt: profile.nextRefreshAt,
    version: profile.version,
  };
}

/** 海关画像详情；无画像/非 Ali/Mic（无英文抬头）→ null（路由转 404）。 */
export async function getCompanyCustoms(companyId: string, repos?: Repositories): Promise<CustomsView | null> {
  const r = repos ?? (await getDefaultRepositories());
  const company = r.companies.getById(companyId, { includeMerged: true });
  if (!company) return null;
  const profile = r.customs.getByCompany(companyId);
  return buildCustomsView(profile);
}

/** 手动刷新海关画像（202 + job）；非 Ali/Mic/无英文抬头 → 400 UNSUPPORTED。 */
export async function createCustomsRefreshJob(companyId: string, repos?: Repositories): Promise<CustomsRefreshJobResult> {
  const r = repos ?? (await getDefaultRepositories());
  const company = r.companies.getById(companyId);
  if (!company || company.mergedInto) {
    throw new LeadError('NOT_FOUND', `公司不存在或已合并: ${companyId}`, { httpStatus: 404 });
  }
  const identity = resolveCustomsCompanyIdentity(company);
  if (!identity.englishName) {
    throw new LeadError('UNSUPPORTED', `公司无英文抬头（仅 Ali/Mic 启用海关补全）: ${companyId}`, { httpStatus: 400 });
  }
  const { job } = r.jobs.enqueue({
    companyId,
    stage: CUSTOMS_STAGE,
    platform: null,
    resetExisting: true,
    maxAttempts: 3,
  });
  // 记录手动刷新请求时间（任务本身无字段；由 occurredAt 语义保证 FIFO 不变）
  void nowIso();
  return { jobId: job.id };
}
