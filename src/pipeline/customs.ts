/**
 * 海关补全（Customs Worker）
 *
 * 设计见 docs/08-海关数据补全.md 与 docs/02 §11.6：
 *  - 仅 Ali/Mic 公司（有英文抬头）启用；英文抬头为主查询名，中文注册名为补充；
 *  - fuma POST /v1/customs/query，companyFlag=1（进口视图）/2（出口视图），pageSize=20，取第 1 页样本；
 *  - 名称 token 过滤（去掉 CO/LTD/GROUP 等通用词）+ 角色分类（asExporter / asImporter）；
 *  - 聚合 totals/dateRange/destinations/origins/hs4/products/buyers/suppliers/sampleRecords/confidence；
 *  - 写 company_customs_profiles + raw_snapshots(kind=fuma_customs_query) + change_events(customs.*, source=fuma:customs)；
 *  - 新公司即时入队、存量每月刷新；permission_denied 暂停队列、no_data 视为正常不重试。
 *
 * 说明：本模块只依赖 F2 repositories 类型（type-only import），Worker 通过依赖注入拿 repos/fuma，
 * 因此单测可完全 mock，不需要真实 DB/网络。
 */
import type { Repositories } from '../repositories/index.js';
import type { ChangeEventInput, CustomsProfile } from '../shared/domain.js';
import type { FumaCustomsClient, FumaCustomsQueryResult, FumaCustomsRecord } from '../adapters/fuma.js';
import { LeadError, toLeadError, type ErrorCode } from '../shared/errors.js';
import { isoPlusDays, isoPlusSeconds, nowIso } from '../shared/time.js';
import { asArray, asRecord } from '../shared/json.js';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

export const CUSTOMS_STAGE = 'customs';
export const CUSTOMS_SOURCE = 'fuma:customs';
export const CUSTOMS_RAW_SNAPSHOT_KIND = 'fuma_customs_query';

/** 低置信度也保留画像，但不进入事件/下游推送（docs/03 §4、docs/08 §8） */
export const CUSTOMS_EVENT_CONFIDENCES: ReadonlyArray<CustomsConfidence> = ['high', 'medium'];

export type CustomsConfidence = 'high' | 'medium' | 'low' | 'none';
export type CustomsAggregateStatus = 'ok' | 'partial' | 'no_data';

/** 英文公司名通用词（docs/08 §4.1：CO/LTD/LIMITED/GROUP/CORP/INC/LLC/COMPANY/AND/THE …） */
export const ENGLISH_NAME_STOPWORDS: ReadonlySet<string> = new Set([
  'CO',
  'LTD',
  'LIMITED',
  'GROUP',
  'CORP',
  ' CORPORATION',
  'CORPORATION',
  'COMPANY',
  'AND',
  'THE',
  'INC',
  'LLC',
  'GMBH',
  'PLC',
  'PTE',
  'BV',
  'NV',
  'AG',
  'KG',
]);

export interface PipelineLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: PipelineLogger = {};

// ---------------------------------------------------------------------------
// 名称归一化 / token 过滤 / 角色分类（纯函数）
// ---------------------------------------------------------------------------

/** 大写、去标点、压缩空格；保留中文（中文名仅作补充查询与兜底匹配） */
export function normalizeCustomsName(name: string | null | undefined): string {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 英文核心 token（≥3 字符、去通用词、去纯数字） */
export function customsNameTokens(name: string | null | undefined): string[] {
  const tokens = normalizeCustomsName(name)
    .split(' ')
    .filter((t) => t.length >= 3 && !ENGLISH_NAME_STOPWORDS.has(t) && !/^\d+$/.test(t));
  return [...new Set(tokens)];
}

/** 中文 token：整段中文公司名（≥2 字符）；用于中文提单名兜底匹配 */
export function customsChineseTokens(name: string | null | undefined): string[] {
  const normalized = normalizeCustomsName(name).replace(/\s+/g, '');
  const matches = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set(matches)];
}

export interface CustomsNameMatcher {
  /** 英文字段匹配用 token（来自英文抬头/英文查询名） */
  tokens: string[];
  /** 中文字段兜底 token（来自中文注册名） */
  chineseTokens: string[];
  /** 参与匹配的原始查询名（去重，用于 query_names） */
  queryNames: string[];
}

export function buildCustomsNameMatcher(names: Array<string | null | undefined>): CustomsNameMatcher {
  const unique = [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))];
  const tokens = [...new Set(unique.flatMap((n) => customsNameTokens(n)))];
  const chineseTokens = [...new Set(unique.flatMap((n) => customsChineseTokens(n)))];
  return { tokens, chineseTokens, queryNames: unique };
}

export interface CustomsMatchOptions {
  /** token 覆盖率阈值（默认 0.6） */
  minCoverage?: number;
  /** 至少命中的 token 数（默认 2；单 token 名称时自动降为 1） */
  minTokens?: number;
}

function haystackOf(values: Array<string | null | undefined>): string {
  return normalizeCustomsName(values.filter(Boolean).join(' '));
}

function countTokenHits(haystack: string, tokens: string[]): number {
  const padded = ` ${haystack} `;
  let hits = 0;
  for (const token of tokens) {
    if (padded.includes(` ${token} `)) hits += 1;
  }
  return hits;
}

/**
 * 名称匹配：英文字段用 token 覆盖率；若英文 token 为空则用中文整名做包含匹配。
 * 例：`Hebei Example Industrial Metal Co., Ltd.` → HEBEI/JINSHI/INDUSTRIAL/METAL
 *     命中 `HEBEI EXAMPLE INDUSTRIAL METAL CO LTD` 的 4/4 token → true。
 */
export function matchesCustomsName(
  matcher: CustomsNameMatcher,
  values: Array<string | null | undefined>,
  options: CustomsMatchOptions = {},
): boolean {
  const haystack = haystackOf(values);
  if (!haystack) return false;
  const minCoverage = options.minCoverage ?? 0.6;

  for (const chinese of matcher.chineseTokens) {
    if (haystack.replace(/\s+/g, '').includes(chinese)) return true;
  }

  const tokens = matcher.tokens;
  if (tokens.length === 0) return false;
  const required = Math.max(tokens.length <= 1 ? 1 : (options.minTokens ?? 2), Math.ceil(tokens.length * minCoverage));
  return countTokenHits(haystack, tokens) >= required;
}

export const EXPORTER_NAME_FIELDS = ['rawexporter', 'exporter', 'usedsuppliername'] as const;
export const IMPORTER_NAME_FIELDS = ['rawimporter', 'importer', 'usedbuyername'] as const;

export type CustomsRecordRole = 'exporter' | 'importer' | 'both' | 'unmatched';

export interface ClassifiedCustomsRecord {
  record: FumaCustomsRecord;
  asExporter: boolean;
  asImporter: boolean;
  matched: boolean;
  role: CustomsRecordRole;
}

/** 对单条提单做角色分类：exporter 字段命中 → 公司是出口商；importer 字段命中 → 公司是进口商 */
export function classifyCustomsRecord(
  record: FumaCustomsRecord,
  matcher: CustomsNameMatcher,
  options: CustomsMatchOptions = {},
): ClassifiedCustomsRecord {
  const exporterValues = EXPORTER_NAME_FIELDS.map((f) => record[f] as string | null | undefined);
  const importerValues = IMPORTER_NAME_FIELDS.map((f) => record[f] as string | null | undefined);
  const asExporter = matchesCustomsName(matcher, exporterValues, options);
  const asImporter = matchesCustomsName(matcher, importerValues, options);
  const role: CustomsRecordRole = asExporter && asImporter ? 'both' : asExporter ? 'exporter' : asImporter ? 'importer' : 'unmatched';
  return { record, asExporter, asImporter, matched: asExporter || asImporter, role };
}

/** 提单去重键：tradeno / blnumber 优先（docs/04 §6.6） */
export function customsRecordKey(record: FumaCustomsRecord): string {
  const tradeno = record.tradeno ? String(record.tradeno).trim() : '';
  if (tradeno) return `tradeno:${tradeno}`;
  const bl = record.blnumber ? String(record.blnumber).trim() : '';
  if (bl) return `bl:${bl}`;
  return `composite:${normalizeCustomsName(record.rawimporter)}|${normalizeCustomsName(record.rawexporter)}|${record.regdate ?? ''}|${record.hscode ?? ''}`;
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

export interface CustomsTopEntry {
  key: string;
  count: number;
}

export interface CustomsSampleRecord {
  role: CustomsRecordRole;
  inout: string | null;
  tradeno: string | null;
  blnumber: string | null;
  rawimporter: string | null;
  importer: string | null;
  rawexporter: string | null;
  exporter: string | null;
  importercountryen: string | null;
  exportercountryen: string | null;
  destcountry: string | null;
  origincountry: string | null;
  hscode: string | null;
  detail: string | null;
  regdate: string | null;
  weight: number | null;
  count: number | null;
  money: number | null;
}

export interface CustomsQueryOutcome {
  name: string;
  nameKind: 'english' | 'chinese';
  flag: 1 | 2;
  ok: boolean;
  result: FumaCustomsQueryResult | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface CustomsUpstreamQueryTotal {
  name: string;
  nameKind: 'english' | 'chinese';
  flag: 1 | 2;
  ok: boolean;
  totalNum: number | null;
  allCount: number | null;
  exactCount: number | null;
  cached: boolean | null;
  source: string | null;
  stale: boolean | null;
  cachedAt: string | null;
  expiresAt: string | null;
  upstreamVersion: string | null;
  errorCode: string | null;
}

export interface CustomsUpstreamTotals {
  status: CustomsAggregateStatus;
  queries: CustomsUpstreamQueryTotal[];
  /** 各查询名去重后的上游模糊命中总数（不可当精确提单量） */
  maxTotalNum: number | null;
  snapshotIds?: number[];
}

export interface CustomsAggregateInput {
  englishName: string | null;
  chineseName: string | null;
  outcomes: CustomsQueryOutcome[];
  topLimit?: number;
  sampleLimit?: number;
  matchOptions?: CustomsMatchOptions;
}

export interface CustomsAggregate {
  status: CustomsAggregateStatus;
  confidence: CustomsConfidence;
  englishName: string | null;
  chineseName: string | null;
  queryNames: string[];
  upstreamTotals: CustomsUpstreamTotals;
  fetchedRecords: number;
  matchedRecords: number;
  exporterRecords: number;
  importerRecords: number;
  bothRecords: number;
  unmatchedRecords: number;
  dateMin: string | null;
  dateMax: string | null;
  destinations: CustomsTopEntry[];
  origins: CustomsTopEntry[];
  hs4: CustomsTopEntry[];
  products: CustomsTopEntry[];
  buyers: CustomsTopEntry[];
  suppliers: CustomsTopEntry[];
  totalWeight: number | null;
  totalCount: number | null;
  amount: number | null;
  sampleRecords: CustomsSampleRecord[];
  cached: boolean;
  cachedAt: string | null;
  expiresAt: string | null;
  upstreamVersion: string | null;
  maxTotalNum: number | null;
  errors: Array<{ name: string; flag: 1 | 2; code: string }>;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function pickNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const clean = cleanText(v);
    if (clean) return clean;
  }
  return null;
}

/** 归一日期为 YYYY-MM-DD（上游 regdate 已基本是 ISO 日期；容忍时间后缀） */
export function normalizeCustomsDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function countBy<T>(items: T[], keyFn: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function topEntries(counts: Map<string, number>, limit: number): CustomsTopEntry[] {
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

/**
 * confidence 判定（docs/08 §4.3/§4.4）：
 *  matched ≥5 → high；1–4 → medium；0 → none；
 *  matched <3 且上游模糊命中总数很大（≥100）→ low（名称噪声大，不展示 Top 榜单）。
 */
export function computeCustomsConfidence(matched: number, maxTotalNum: number | null): CustomsConfidence {
  if (matched <= 0) return 'none';
  if (matched >= 5) return 'high';
  if (matched < 3 && (maxTotalNum ?? 0) >= 100) return 'low';
  return 'medium';
}

function dedupeRecords(outcomes: CustomsQueryOutcome[]): FumaCustomsRecord[] {
  const seen = new Map<string, FumaCustomsRecord>();
  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.result) continue;
    for (const record of asArray<FumaCustomsRecord>(outcome.result.records)) {
      const key = customsRecordKey(record);
      if (!seen.has(key)) seen.set(key, record);
    }
  }
  return [...seen.values()];
}

/**
 * 核心聚合：过滤 + 角色分类 + Top 榜单 + 样本统计。
 * 注意这里是「第 1 页样本统计」，sampled 必须为 true（调用方落库时固定 1）。
 */
export function aggregateCustoms(input: CustomsAggregateInput): CustomsAggregate {
  const topLimit = input.topLimit ?? 10;
  const sampleLimit = input.sampleLimit ?? 20;
  const matcher = buildCustomsNameMatcher([input.englishName, input.chineseName]);

  const successes = input.outcomes.filter((o) => o.ok && o.result);
  const errors = input.outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ name: o.name, flag: o.flag, code: o.errorCode ?? 'UNKNOWN' }));

  const allRecords = dedupeRecords(input.outcomes);
  const classified = allRecords.map((r) => classifyCustomsRecord(r, matcher, input.matchOptions));
  const matched = classified.filter((c) => c.matched);
  const exporters = matched.filter((c) => c.asExporter);
  const importers = matched.filter((c) => c.asImporter);

  const maxTotalNum = successes.reduce<number | null>((max, outcome) => {
    const total = outcome.result?.totalNum ?? outcome.result?.allCount ?? null;
    if (total === null) return max;
    return max === null ? total : Math.max(max, total);
  }, null);

  const status: CustomsAggregateStatus =
    successes.length === 0 && errors.length > 0
      ? 'partial'
      : matched.length === 0 && (maxTotalNum ?? 0) === 0
        ? 'no_data'
        : errors.length > 0
          ? 'partial'
          : 'ok';

  const dates = matched
    .map((c) => normalizeCustomsDate(c.record.regdate))
    .filter((d): d is string => !!d)
    .sort();
  const confidence = computeCustomsConfidence(matched.length, maxTotalNum);

  const destinations = topEntries(countBy(exporters, (c) => pickNonEmpty(c.record.importercountryen, c.record.destcountry)), topLimit);
  const origins = topEntries(countBy(importers, (c) => pickNonEmpty(c.record.exportercountryen, c.record.origincountry)), topLimit);
  const hs4 = topEntries(
    countBy(matched, (c) => {
      const hscode = cleanText(c.record.hscode);
      return hscode ? hscode.replace(/\D/g, '').slice(0, 4) || null : null;
    }),
    topLimit,
  );
  const products = topEntries(countBy(matched, (c) => cleanText(c.record.detail)?.slice(0, 40) ?? null), topLimit);
  const buyers = topEntries(
    countBy(exporters, (c) => pickNonEmpty(c.record.rawimporter, c.record.importer, c.record.usedbuyername)),
    topLimit,
  );
  const suppliers = topEntries(
    countBy(importers, (c) => pickNonEmpty(c.record.rawexporter, c.record.exporter, c.record.usedsuppliername)),
    topLimit,
  );

  let totalWeight = 0;
  let totalCount = 0;
  let amount = 0;
  let hasWeight = false;
  let hasCount = false;
  let hasMoney = false;
  for (const c of matched) {
    const weight = numberOrNull(c.record.weight);
    const count = numberOrNull(c.record.count);
    const money = numberOrNull(c.record.money);
    if (weight !== null) {
      totalWeight += weight;
      hasWeight = true;
    }
    if (count !== null) {
      totalCount += count;
      hasCount = true;
    }
    if (money !== null) {
      amount += money;
      hasMoney = true;
    }
  }

  const sampleRecords: CustomsSampleRecord[] = matched.slice(0, sampleLimit).map((c) => ({
    role: c.role,
    inout: cleanText(c.record.inout),
    tradeno: cleanText(c.record.tradeno),
    blnumber: cleanText(c.record.blnumber),
    rawimporter: cleanText(c.record.rawimporter),
    importer: cleanText(c.record.importer),
    rawexporter: cleanText(c.record.rawexporter),
    exporter: cleanText(c.record.exporter),
    importercountryen: cleanText(c.record.importercountryen),
    exportercountryen: cleanText(c.record.exportercountryen),
    destcountry: cleanText(c.record.destcountry),
    origincountry: cleanText(c.record.origincountry),
    hscode: cleanText(c.record.hscode),
    detail: cleanText(c.record.detail)?.slice(0, 120) ?? null,
    regdate: normalizeCustomsDate(c.record.regdate),
    weight: numberOrNull(c.record.weight),
    count: numberOrNull(c.record.count),
    money: numberOrNull(c.record.money),
  }));

  const lastSuccess = [...successes].reverse().find((o) => o.result);
  const cachedInside = successes.find((o) => o.result?.cachedAt)?.result ?? lastSuccess?.result ?? null;
  const cached = successes.some((o) => o.result?.cached === true);
  const upstreamTotals: CustomsUpstreamTotals = {
    status,
    queries: input.outcomes.map((o) => ({
      name: o.name,
      nameKind: o.nameKind,
      flag: o.flag,
      ok: o.ok,
      totalNum: o.result?.totalNum ?? null,
      allCount: o.result?.allCount ?? null,
      exactCount: o.result?.exactCount ?? null,
      cached: o.result ? o.result.cached : null,
      source: o.result?.source ?? null,
      stale: o.result ? o.result.stale : null,
      cachedAt: o.result?.cachedAt ?? null,
      expiresAt: o.result?.expiresAt ?? null,
      upstreamVersion: o.result?.upstreamVersion ?? null,
      errorCode: o.errorCode,
    })),
    maxTotalNum,
  };

  return {
    status,
    confidence,
    englishName: input.englishName,
    chineseName: input.chineseName,
    queryNames: matcher.queryNames,
    upstreamTotals,
    fetchedRecords: allRecords.length,
    matchedRecords: matched.length,
    exporterRecords: exporters.length,
    importerRecords: importers.length,
    bothRecords: matched.filter((c) => c.asExporter && c.asImporter).length,
    unmatchedRecords: allRecords.length - matched.length,
    dateMin: dates[0] ?? null,
    dateMax: dates.length ? dates[dates.length - 1] ?? null : null,
    destinations,
    origins,
    hs4,
    products,
    buyers,
    suppliers,
    totalWeight: hasWeight ? Math.round(totalWeight) : null,
    totalCount: hasCount ? Math.round(totalCount) : null,
    amount: hasMoney ? Math.round(amount) : null,
    sampleRecords,
    cached,
    cachedAt: cachedInside?.cachedAt ?? null,
    expiresAt: cachedInside?.expiresAt ?? null,
    upstreamVersion: (successes.find((o) => o.result?.upstreamVersion)?.result ?? lastSuccess?.result)?.upstreamVersion ?? null,
    maxTotalNum,
    errors,
  };
}

// ---------------------------------------------------------------------------
// 查询计划 / 公司身份
// ---------------------------------------------------------------------------

export interface CustomsQuerySpec {
  name: string;
  nameKind: 'english' | 'chinese';
  flag: 1 | 2;
}

export interface CustomsCompanyIdentity {
  englishName: string | null;
  chineseName: string | null;
}

const LATIN_NAME_RE = /[A-Za-z]{2,}/;
const CJK_NAME_RE = /[\u4e00-\u9fff]{2,}/;

export function isLatinName(name: string | null | undefined): boolean {
  return !!name && LATIN_NAME_RE.test(name);
}

export function isChineseName(name: string | null | undefined): boolean {
  return !!name && CJK_NAME_RE.test(name);
}

/** 从公司主档解析查询身份：englishName 优先；中文名取 name（或 extra.chineseName） */
export function resolveCustomsCompanyIdentity(company: {
  name?: string | null;
  englishName?: string | null;
  extra?: Record<string, unknown> | null;
}): CustomsCompanyIdentity {
  const extra = asRecord(company.extra);
  const englishCandidate =
    (isLatinName(company.englishName) ? company.englishName : null) ??
    (typeof extra.englishName === 'string' && isLatinName(extra.englishName) ? extra.englishName : null) ??
    (isLatinName(company.name) ? company.name : null);
  const chineseCandidate =
    (isChineseName(company.name) ? company.name : null) ??
    (typeof extra.chineseName === 'string' && isChineseName(extra.chineseName) ? extra.chineseName : null);
  return {
    englishName: englishCandidate ? String(englishCandidate).trim() : null,
    chineseName: chineseCandidate ? String(chineseCandidate).trim() : null,
  };
}

/**
 * 查询计划：英文抬头 × flag 1/2，中文名 × flag 1/2（中文名仅补充；实测 flag=2 多为 0）。
 * 顺序保证英文视图先查（英文抬头命中率最高）。
 */
export function buildCustomsQueryPlan(identity: CustomsCompanyIdentity): CustomsQuerySpec[] {
  const plan: CustomsQuerySpec[] = [];
  const seen = new Set<string>();
  const push = (name: string | null, nameKind: 'english' | 'chinese', flag: 1 | 2) => {
    if (!name) return;
    const key = `${flag}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    plan.push({ name, nameKind, flag });
  };
  if (identity.englishName) {
    push(identity.englishName, 'english', 1);
    push(identity.englishName, 'english', 2);
  }
  if (identity.chineseName) {
    push(identity.chineseName, 'chinese', 1);
    push(identity.chineseName, 'chinese', 2);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// 画像行 / 变更检测 / 事件
// ---------------------------------------------------------------------------

export type CustomsProfileRecord = CustomsProfile & { createdAt: string; updatedAt: string };

export interface BuildCustomsProfileInput {
  companyId: string;
  aggregate: CustomsAggregate;
  accountId: string | null;
  fetchedAt: string;
  nextRefreshAt: string;
  version: number;
  snapshotIds?: number[];
}

/** 由聚合结果构造 company_customs_profiles 行（不含 created_at/updated_at，由 repo 维护） */
export function buildCustomsProfileRow(input: BuildCustomsProfileInput): CustomsProfile {
  const { aggregate } = input;
  const upstreamTotals: CustomsUpstreamTotals = { ...aggregate.upstreamTotals };
  if (input.snapshotIds?.length) upstreamTotals.snapshotIds = input.snapshotIds;
  return {
    companyId: input.companyId,
    englishName: aggregate.englishName,
    chineseName: aggregate.chineseName,
    queryNames: aggregate.queryNames,
    upstreamTotals,
    fetchedRecords: aggregate.fetchedRecords,
    matchedRecords: aggregate.matchedRecords,
    exporterRecords: aggregate.exporterRecords,
    importerRecords: aggregate.importerRecords,
    unmatchedRecords: aggregate.unmatchedRecords,
    dateMin: aggregate.dateMin,
    dateMax: aggregate.dateMax,
    destinations: aggregate.destinations,
    origins: aggregate.origins,
    hs4: aggregate.hs4,
    products: aggregate.products,
    buyers: aggregate.buyers,
    suppliers: aggregate.suppliers,
    totalWeight: aggregate.totalWeight,
    totalCount: aggregate.totalCount,
    amount: aggregate.amount,
    sampleRecords: aggregate.sampleRecords,
    confidence: aggregate.confidence,
    accountId: input.accountId,
    source: 'fuma',
    cached: aggregate.cached,
    cachedAt: aggregate.cachedAt,
    expiresAt: aggregate.expiresAt,
    upstreamVersion: aggregate.upstreamVersion,
    sampled: true,
    fetchedAt: input.fetchedAt,
    nextRefreshAt: input.nextRefreshAt,
    version: input.version,
  };
}

function stableCustomsProjection(profile: {
  englishName?: string | null;
  chineseName?: string | null;
  queryNames?: string[] | null;
  upstreamTotals?: unknown;
  fetchedRecords?: number | null;
  matchedRecords?: number | null;
  exporterRecords?: number | null;
  importerRecords?: number | null;
  unmatchedRecords?: number | null;
  dateMin?: string | null;
  dateMax?: string | null;
  destinations?: unknown;
  origins?: unknown;
  hs4?: unknown;
  products?: unknown;
  buyers?: unknown;
  suppliers?: unknown;
  totalWeight?: number | null;
  totalCount?: number | null;
  amount?: number | null;
  sampleRecords?: unknown;
  confidence?: string | null;
}): string {
  const upstream = asRecord(profile.upstreamTotals);
  const queries = asArray<Record<string, unknown>>(upstream.queries).map((q) => ({
    name: q.name ?? null,
    flag: q.flag ?? null,
    ok: q.ok ?? null,
    totalNum: q.totalNum ?? null,
    allCount: q.allCount ?? null,
    errorCode: q.errorCode ?? null,
  }));
  return JSON.stringify({
    englishName: profile.englishName ?? null,
    chineseName: profile.chineseName ?? null,
    queryNames: profile.queryNames ?? [],
    queries,
    fetchedRecords: profile.fetchedRecords ?? null,
    matchedRecords: profile.matchedRecords ?? null,
    exporterRecords: profile.exporterRecords ?? null,
    importerRecords: profile.importerRecords ?? null,
    unmatchedRecords: profile.unmatchedRecords ?? null,
    dateMin: profile.dateMin ?? null,
    dateMax: profile.dateMax ?? null,
    destinations: profile.destinations ?? null,
    origins: profile.origins ?? null,
    hs4: profile.hs4 ?? null,
    products: profile.products ?? null,
    buyers: profile.buyers ?? null,
    suppliers: profile.suppliers ?? null,
    totalWeight: profile.totalWeight ?? null,
    totalCount: profile.totalCount ?? null,
    amount: profile.amount ?? null,
    sampleRecords: profile.sampleRecords ?? null,
    confidence: profile.confidence ?? null,
  });
}

/** 与上次画像比较（忽略 fetchedAt/nextRefreshAt/cached/cachedAt/expiresAt 等易变字段） */
export function hasCustomsContentChanged(previous: CustomsProfile | null, next: CustomsProfile | null): boolean {
  if (!previous && next) return true;
  if (previous && !next) return true;
  if (!previous || !next) return false;
  return stableCustomsProjection(previous) !== stableCustomsProjection(next);
}

function valueTypeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'json';
}

export interface CustomsChangeEventOptions {
  version: number;
  occurredAt: string;
  runId?: string | null;
  actor?: string;
  source?: string;
}

/**
 * 生成 `customs.updated` 事件（每次刷新最多 1 条，newValue 为画像摘要对象）。
 *
 * 说明：events 层把 `customs.updated` 当作「快照型事件」（src/events/envelope.ts），
 * 会把 newValue 对象展开成 webhook data；因此这里写单条聚合事件，而不是逐字段多条，
 * 避免 webhook 风暴。字段级明细仍在 company_customs_profiles / upstreamTotals 中可查。
 * 仅 confidence ∈ high/medium 时生成（docs/03 §4：low/none 不推送下游）。
 */
export function buildCustomsChangeEvents(
  previous: CustomsProfile | null,
  next: CustomsProfile,
  options: CustomsChangeEventOptions,
): ChangeEventInput[] {
  if (!CUSTOMS_EVENT_CONFIDENCES.includes(next.confidence)) return [];
  const summaryOf = (profile: CustomsProfile | null): Record<string, unknown> | null => {
    if (!profile) return null;
    return {
      confidence: profile.confidence,
      englishName: profile.englishName,
      chineseName: profile.chineseName,
      fetchedRecords: profile.fetchedRecords,
      matchedRecords: profile.matchedRecords,
      exporterRecords: profile.exporterRecords,
      importerRecords: profile.importerRecords,
      dateRange: { min: profile.dateMin, max: profile.dateMax },
      topDestinations: topKeys(profile.destinations),
      topHs4: topKeys(profile.hs4),
      topBuyers: topKeys(profile.buyers),
    };
  };
  const summary = summaryOf(next);
  if (!summary) return [];
  const source = options.source ?? CUSTOMS_SOURCE;
  return [
    {
      companyId: next.companyId,
      entityType: 'company' as const,
      entityId: next.companyId,
      version: options.version,
      eventType: 'customs.updated',
      field: null,
      oldValue: summaryOf(previous),
      newValue: summary,
      valueType: 'json',
      source,
      runId: options.runId ?? null,
      actor: options.actor ?? 'customs-worker',
      occurredAt: options.occurredAt,
    },
  ];
}

function topKeys(value: unknown): string[] {
  return asArray<Record<string, unknown>>(value)
    .map((entry) => (typeof entry.key === 'string' ? entry.key : null))
    .filter((key): key is string => key !== null);
}

// ---------------------------------------------------------------------------
// Worker 配置 / 依赖 / 结果类型
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export interface CustomsWorkerConfig {
  accountId: string;
  pageSize: number;
  refreshDays: number;
  maxJobsPerTick: number;
  workerId: string;
  topLimit: number;
  sampleLimit: number;
  leaseSec: number;
  jobMaxAttempts: number;
  /** 是否对所有查询传 forceRefresh（手动刷新可开启） */
  forceRefresh: boolean;
}

export function resolveCustomsWorkerConfig(partial?: Partial<CustomsWorkerConfig>): CustomsWorkerConfig {
  return {
    accountId: partial?.accountId ?? process.env.FUMA_ACCOUNT_ID ?? 'acct_01',
    pageSize: Math.max(1, partial?.pageSize ?? envInt('LEAD_CUSTOMS_MAX_PAGE_SIZE', 20)),
    refreshDays: Math.max(1, partial?.refreshDays ?? envInt('LEAD_CUSTOMS_REFRESH_DAYS', 30)),
    maxJobsPerTick: Math.max(1, partial?.maxJobsPerTick ?? envInt('LEAD_CUSTOMS_JOBS_PER_TICK', 10)),
    workerId: partial?.workerId ?? `customs:${process.pid}`,
    topLimit: Math.max(1, partial?.topLimit ?? 10),
    sampleLimit: Math.max(1, partial?.sampleLimit ?? 20),
    leaseSec: Math.max(1, partial?.leaseSec ?? envInt('LEAD_JOB_LEASE_SEC', 60)),
    jobMaxAttempts: Math.max(1, partial?.jobMaxAttempts ?? envInt('LEAD_JOB_MAX_ATTEMPTS', 3)),
    forceRefresh: partial?.forceRefresh ?? false,
  };
}

export interface CustomsWorkerDeps {
  repos: Repositories;
  fuma: FumaCustomsClient;
  config?: Partial<CustomsWorkerConfig>;
  logger?: PipelineLogger;
  clock?: () => Date;
}

export interface CustomsRefreshResult {
  companyId: string;
  status: CustomsAggregateStatus;
  confidence: CustomsConfidence;
  fetchedRecords: number;
  matchedRecords: number;
  exporterRecords: number;
  importerRecords: number;
  changed: boolean;
  created: boolean;
  version: number;
  eventCount: number;
  snapshotCount: number;
}

export interface CustomsRunSummary {
  now: string;
  dueEnqueued: number;
  claimed: number;
  completed: number;
  noData: number;
  failed: number;
  permissionDenied: boolean;
  paused: boolean;
}

interface ClaimedJobLike {
  id: string;
  companyId: string;
  attempts?: number | null;
  maxAttempts?: number | null;
  stage?: string | null;
  platform?: string | null;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 3600_000;

export class CustomsWorker {
  private readonly deps: CustomsWorkerDeps;
  private readonly config: CustomsWorkerConfig;
  private readonly logger: PipelineLogger;
  private readonly clock: () => Date;

  constructor(deps: CustomsWorkerDeps) {
    this.deps = deps;
    this.config = resolveCustomsWorkerConfig(deps.config);
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.clock = deps.clock ?? (() => new Date());
  }

  getConfig(): CustomsWorkerConfig {
    return { ...this.config };
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  // -- 入队 -----------------------------------------------------------------

  /** 手动/即时入队：为公司创建 customs 任务（唯一键幂等，已存在返回 created=false） */
  async enqueueForCompany(companyId: string, _options?: { forceRefresh?: boolean; reason?: string }): Promise<{ enqueued: boolean; jobId: string | null }> {
    const company = await this.deps.repos.companies.getById(companyId);
    if (!company || company.mergedInto) {
      throw new LeadError('NOT_FOUND', `公司不存在或已合并: ${companyId}`, { httpStatus: 404 });
    }
    const identity = resolveCustomsCompanyIdentity(company);
    if (!identity.englishName) {
      throw new LeadError('UNSUPPORTED', `公司无英文抬头（仅 Ali/Mic 启用海关补全）: ${companyId}`, { httpStatus: 400 });
    }
    const { job, created } = await this.deps.repos.jobs.enqueue({
      companyId,
      stage: CUSTOMS_STAGE,
      platform: null,
      maxAttempts: this.config.jobMaxAttempts,
      // 月刷新/手动刷新需要让已 done/failed/dead 的同键任务复位为 pending
      resetExisting: true,
    });
    return { enqueued: created, jobId: job?.id ?? null };
  }

  /** 扫描到期画像 + 新 Ali/Mic 公司（无画像）→ 入队 */
  async enqueueDue(options?: { limit?: number }): Promise<number> {
    const limit = options?.limit ?? this.config.maxJobsPerTick * 5;
    const now = this.nowIso();
    let enqueued = 0;

    const due = await this.deps.repos.customs.listDue({ now: this.clock(), limit });
    for (const profile of asArray<{ companyId?: string }>(due)) {
      if (!profile?.companyId) continue;
      try {
        const r = await this.deps.repos.jobs.enqueue({
          companyId: profile.companyId,
          stage: CUSTOMS_STAGE,
          platform: null,
          maxAttempts: this.config.jobMaxAttempts,
          resetExisting: true,
        });
        if (r.created) enqueued += 1;
      } catch (err) {
        this.logger.warn?.('customs enqueue due failed', { companyId: profile.companyId, error: String(err) });
      }
    }

    const missing = await this.deps.repos.companies.listAliMicMissingCustoms(limit);
    for (const company of asArray<{ id?: string; englishName?: string | null }>(missing)) {
      if (!company?.id) continue;
      if (!company.englishName) continue; // 无英文抬头：等平台档案刷新后再入队
      try {
        const r = await this.deps.repos.jobs.enqueue({
          companyId: company.id,
          stage: CUSTOMS_STAGE,
          platform: null,
          maxAttempts: this.config.jobMaxAttempts,
          resetExisting: true,
        });
        if (r.created) enqueued += 1;
      } catch (err) {
        this.logger.warn?.('customs enqueue new failed', { companyId: company.id, error: String(err) });
      }
    }
    return enqueued;
  }

  // -- 执行 -----------------------------------------------------------------

  /** 单公司刷新（可被手动调用）；成功返回聚合结果，失败抛 LeadError */
  async refreshCompany(companyId: string, options?: { forceRefresh?: boolean; queryNames?: CustomsCompanyIdentity; runId?: string | null }): Promise<CustomsRefreshResult> {
    const repos = this.deps.repos;
    const company = await repos.companies.getById(companyId);
    if (!company || company.mergedInto) {
      throw new LeadError('NOT_FOUND', `公司不存在或已合并: ${companyId}`, { httpStatus: 404 });
    }
    const identity = options?.queryNames ?? resolveCustomsCompanyIdentity(company);
    if (!identity.englishName) {
      throw new LeadError('UNSUPPORTED', `公司无英文抬头（仅 Ali/Mic 启用海关补全）: ${companyId}`, { httpStatus: 400 });
    }

    const fetchedAt = this.nowIso();
    const plan = buildCustomsQueryPlan(identity);
    const outcomes: CustomsQueryOutcome[] = [];

    for (const spec of plan) {
      try {
        const result = await this.deps.fuma.queryCustoms({
          inputCompany: spec.name,
          companyFlag: spec.flag,
          page: 1,
          pageSize: this.config.pageSize,
          forceRefresh: options?.forceRefresh ?? this.config.forceRefresh,
          allowStale: true,
        });
        outcomes.push({ name: spec.name, nameKind: spec.nameKind, flag: spec.flag, ok: true, result, errorCode: null, errorMessage: null });
      } catch (err) {
        const e = toLeadError(err);
        outcomes.push({
          name: spec.name,
          nameKind: spec.nameKind,
          flag: spec.flag,
          ok: false,
          result: null,
          errorCode: e.code,
          errorMessage: e.message,
        });
        this.logger.warn?.('customs query failed', { companyId, name: spec.name, flag: spec.flag, code: e.code });
        if (e.code === 'CUSTOMS_PERMISSION_DENIED' || e.code === 'SOURCE_SESSION_INVALID') {
          throw e; // 权限/登录态错误：整批中止，由上层暂停队列
        }
      }
    }

    const successes = outcomes.filter((o) => o.ok && o.result);
    if (successes.length === 0) {
      const first = outcomes.find((o) => !o.ok);
      const code = (first?.errorCode ?? 'SOURCE_UNAVAILABLE') as ErrorCode;
      throw new LeadError(code, first?.errorMessage ?? 'fuma 海关查询全部失败', {
        retryable: code === 'SOURCE_UNAVAILABLE' || code === 'UPSTREAM_RATE_LIMITED' || code === 'RATE_LIMITED',
      });
    }

    const aggregate = aggregateCustoms({
      englishName: identity.englishName,
      chineseName: identity.chineseName,
      outcomes,
      topLimit: this.config.topLimit,
      sampleLimit: this.config.sampleLimit,
    });

    // 原始响应快照（永久保留；brotli + hash 去重由 repositories 负责）
    const snapshotIds: number[] = [];
    for (const outcome of successes) {
      try {
        const written = await repos.snapshots.writeText({
          kind: CUSTOMS_RAW_SNAPSHOT_KIND,
          payload: {
            request: { inputCompany: outcome.name, companyFlag: outcome.flag, page: 1, pageSize: this.config.pageSize, accountId: this.config.accountId },
            response: outcome.result?.raw ?? null,
          },
          platform: 'fuma',
          refType: 'company',
          refId: companyId,
          url: '/v1/customs/query',
          fetchedAt,
        });
        const id = (written as { snapshot?: { id?: number } } | null)?.snapshot?.id;
        if (typeof id === 'number') snapshotIds.push(id);
      } catch (err) {
        this.logger.warn?.('customs snapshot write failed', { companyId, error: String(err) });
      }
    }

    const previous = await repos.customs.getByCompany(companyId);
    const nextRefreshAt = isoPlusDays(this.config.refreshDays, new Date(fetchedAt));
    const probe = buildCustomsProfileRow({
      companyId,
      aggregate,
      accountId: this.config.accountId,
      fetchedAt,
      nextRefreshAt,
      version: previous?.version ?? 1,
      snapshotIds,
    });
    const changed = hasCustomsContentChanged(previous, probe);
    const version = previous ? (changed ? previous.version + 1 : previous.version) : 1;

    const profile = buildCustomsProfileRow({
      companyId,
      aggregate,
      accountId: this.config.accountId,
      fetchedAt,
      nextRefreshAt,
      version,
      snapshotIds,
    });
    const events = changed
      ? buildCustomsChangeEvents(previous, profile, {
          version,
          occurredAt: fetchedAt,
          runId: options?.runId ?? null,
          actor: options?.forceRefresh ? 'customs-manual' : 'customs-worker',
        })
      : [];

    repos.transaction(() => {
      repos.customs.upsert(profile);
      if (events.length > 0) repos.changeEvents.appendMany(events);
    });

    const result: CustomsRefreshResult = {
      companyId,
      status: aggregate.status,
      confidence: aggregate.confidence,
      fetchedRecords: aggregate.fetchedRecords,
      matchedRecords: aggregate.matchedRecords,
      exporterRecords: aggregate.exporterRecords,
      importerRecords: aggregate.importerRecords,
      changed,
      created: previous === null,
      version,
      eventCount: events.length,
      snapshotCount: snapshotIds.length,
    };
    this.logger.info?.('customs refreshed', {
      companyId,
      status: result.status,
      confidence: result.confidence,
      matched: result.matchedRecords,
      changed: result.changed,
    });
    return result;
  }

  private retryAtFor(job: ClaimedJobLike, error: LeadError): string | null {
    if (!error.retryable) return null;
    const attempts = (job.attempts ?? 0) + 1;
    const maxAttempts = job.maxAttempts ?? this.config.jobMaxAttempts;
    if (attempts >= maxAttempts) return null;
    const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
    return isoPlusSeconds(Math.round(delayMs / 1000), this.clock());
  }

  private async markFumaHealth(code: string): Promise<void> {
    try {
      await this.deps.repos.sourceHealth.upsert({
        platform: 'fuma',
        state: code === 'SOURCE_SESSION_INVALID' ? 'session_invalid' : 'degraded',
        loggedIn: code === 'SOURCE_SESSION_INVALID' ? false : null,
        checkedAt: this.nowIso(),
        detail: { reason: code },
      });
    } catch (err) {
      this.logger.warn?.('fuma source health update failed', { error: String(err) });
    }
  }

  private async executeJob(job: ClaimedJobLike, summary: CustomsRunSummary): Promise<void> {
    const repos = this.deps.repos;
    try {
      const result = await this.refreshCompany(job.companyId);
      await repos.jobs.complete(job.id);
      summary.completed += 1;
      if (result.status === 'no_data') summary.noData += 1;
    } catch (err) {
      const e = toLeadError(err);
      summary.failed += 1;
      this.logger.warn?.('customs job failed', { jobId: job.id, companyId: job.companyId, code: e.code, message: e.message });
      if (e.code === 'CUSTOMS_PERMISSION_DENIED' || e.code === 'SOURCE_SESSION_INVALID') {
        summary.permissionDenied = true;
        await this.markFumaHealth(e.code);
      }
      const nextRetryAt = e.code === 'CUSTOMS_PERMISSION_DENIED' ? isoPlusDays(1, this.clock()) : this.retryAtFor(job, e);
      await repos.jobs.fail(job.id, {
        error: e.message,
        errorCode: e.code,
        retryable: e.retryable,
        nextRetryAt,
      });
      if (e.code === 'CUSTOMS_PERMISSION_DENIED' || e.code === 'SOURCE_SESSION_INVALID') {
        summary.paused = true;
      }
    }
  }

  /** 一轮：先补到期/新公司任务，再按 FIFO 领取执行（单轮限频由 fuma 串行 + maxJobsPerTick 控制） */
  async runOnce(options?: { limit?: number; enqueueDue?: boolean }): Promise<CustomsRunSummary> {
    const summary: CustomsRunSummary = {
      now: this.nowIso(),
      dueEnqueued: 0,
      claimed: 0,
      completed: 0,
      noData: 0,
      failed: 0,
      permissionDenied: false,
      paused: false,
    };
    if (options?.enqueueDue !== false) {
      summary.dueEnqueued = await this.enqueueDue({ limit: options?.limit ?? this.config.maxJobsPerTick * 5 });
    }
    const limit = options?.limit ?? this.config.maxJobsPerTick;
    for (let i = 0; i < limit; i += 1) {
      const claimed = (await this.deps.repos.jobs.claimNext({
        workerId: this.config.workerId,
        stages: [CUSTOMS_STAGE],
        leaseSec: this.config.leaseSec,
        now: this.nowIso(),
      })) as unknown as ClaimedJobLike | null;
      if (!claimed) break;
      summary.claimed += 1;
      await this.executeJob(claimed, summary);
      if (summary.paused) break;
    }
    return summary;
  }
}

/** Lead `src/config.ts` 扁平字段（含 worker 调度参数）的结构子集 */
export interface CustomsAppConfigLike extends Partial<CustomsWorkerConfig> {
  fumaAccountId?: string;
  customsRefreshDays?: number;
  customsMaxPageSize?: number;
  jobLeaseSec?: number;
  jobMaxAttempts?: number;
}

export interface CustomsFromConfigOptions {
  logger?: PipelineLogger;
  clock?: () => Date;
}

/**
 * 由扁平 AppConfig 构造 Customs Worker（main/wiring 一行接线）：
 * `const worker = createCustomsWorkerFromConfig(repos, fuma, config);`
 */
export function createCustomsWorkerFromConfig(
  repos: Repositories,
  fuma: FumaCustomsClient,
  config: CustomsAppConfigLike = {},
  options: CustomsFromConfigOptions = {},
): CustomsWorker {
  const workerConfig: Partial<CustomsWorkerConfig> = {};
  const accountId = config.accountId ?? config.fumaAccountId;
  const pageSize = config.pageSize ?? config.customsMaxPageSize;
  const refreshDays = config.refreshDays ?? config.customsRefreshDays;
  const leaseSec = config.leaseSec ?? config.jobLeaseSec;
  const jobMaxAttempts = config.jobMaxAttempts;
  if (accountId !== undefined) workerConfig.accountId = accountId;
  if (pageSize !== undefined) workerConfig.pageSize = pageSize;
  if (refreshDays !== undefined) workerConfig.refreshDays = refreshDays;
  if (leaseSec !== undefined) workerConfig.leaseSec = leaseSec;
  if (jobMaxAttempts !== undefined) workerConfig.jobMaxAttempts = jobMaxAttempts;
  if (config.maxJobsPerTick !== undefined) workerConfig.maxJobsPerTick = config.maxJobsPerTick;
  if (config.topLimit !== undefined) workerConfig.topLimit = config.topLimit;
  if (config.sampleLimit !== undefined) workerConfig.sampleLimit = config.sampleLimit;
  if (config.workerId !== undefined) workerConfig.workerId = config.workerId;
  return new CustomsWorker({ repos, fuma, config: workerConfig, logger: options.logger, clock: options.clock });
}

/** 工厂：main/scheduler 集成入口 */
export function createCustomsWorker(deps: CustomsWorkerDeps): CustomsWorker {
  return new CustomsWorker(deps);
}
